//! The cryptography of Web Push, kept apart from storage and HTTP so each
//! piece can be checked against its RFC:
//!
//! - RFC 8291: the message is encrypted for one browser with `aes128gcm`
//!   (ECDH on P-256, HKDF-SHA-256, AES-128-GCM, one record);
//! - RFC 8292 (VAPID): the request carries a short-lived ES256 JWT that says
//!   which application server is sending;
//! - sealing: the keys this server keeps are encrypted at rest with a key that
//!   lives in a 0600 file beside the database, so `hub.db` alone reveals none.
use aes_gcm::{
    Aes128Gcm, Aes256Gcm, Nonce,
    aead::{Aead, KeyInit},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use hkdf::Hkdf;
use p256::{
    PublicKey, SecretKey,
    ecdsa::{Signature, SigningKey, signature::Signer},
    elliptic_curve::sec1::ToEncodedPoint,
};
use rand_core::{OsRng, RngCore};
use serde_json::json;
use sha2::Sha256;
use std::path::Path;

/// One record holds the whole message; push services accept up to 4096 bytes.
const RECORD_SIZE: u32 = 4096;
/// What fits in that record beside the header (86), the padding delimiter (1)
/// and the authentication tag (16).
pub const MAX_PLAINTEXT: usize = RECORD_SIZE as usize - 86 - 1 - 16;
/// How long a VAPID token is good for. RFC 8292 allows at most 24 hours.
pub const TOKEN_LIFETIME_SECONDS: i64 = 12 * 60 * 60;

pub fn b64(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

/// Browsers write these values with or without padding.
pub fn unb64(text: &str) -> Option<Vec<u8>> {
    URL_SAFE_NO_PAD.decode(text.trim().trim_end_matches('=')).ok()
}

fn random<const N: usize>() -> [u8; N] {
    let mut bytes = [0u8; N];
    OsRng.fill_bytes(&mut bytes);
    bytes
}

/// The browser's half of a subscription, checked once when it is stored.
#[derive(Clone)]
pub struct Recipient {
    public: PublicKey,
    auth: [u8; 16],
}

impl Recipient {
    /// `p256dh` is an uncompressed P-256 point (65 bytes) and `auth` 16 bytes.
    pub fn new(p256dh: &[u8], auth: &[u8]) -> Result<Self, &'static str> {
        if p256dh.len() != 65 || p256dh[0] != 4 {
            return Err("keys.p256dh must be an uncompressed P-256 point");
        }
        let public = PublicKey::from_sec1_bytes(p256dh).map_err(|_| "keys.p256dh is not a point on P-256")?;
        let auth: [u8; 16] = auth.try_into().map_err(|_| "keys.auth must be 16 bytes")?;
        Ok(Self { public, auth })
    }
}

/// RFC 8291 with a fresh sender key and salt.
pub fn encrypt(recipient: &Recipient, plaintext: &[u8]) -> Result<Vec<u8>, &'static str> {
    encrypt_with(recipient, &SecretKey::random(&mut OsRng), &random::<16>(), plaintext)
}

/// RFC 8291 with the sender key and salt given, so the RFC's own example can
/// be reproduced byte for byte.
pub fn encrypt_with(
    recipient: &Recipient,
    sender: &SecretKey,
    salt: &[u8; 16],
    plaintext: &[u8],
) -> Result<Vec<u8>, &'static str> {
    if plaintext.len() > MAX_PLAINTEXT {
        return Err("push message is too long");
    }
    let ua_public = recipient.public.to_encoded_point(false);
    let as_public = sender.public_key().to_encoded_point(false);
    let shared = p256::ecdh::diffie_hellman(sender.to_nonzero_scalar(), recipient.public.as_affine());

    // The key both sides derive from the ECDH secret and the auth secret.
    let mut key_info = b"WebPush: info\0".to_vec();
    key_info.extend_from_slice(ua_public.as_bytes());
    key_info.extend_from_slice(as_public.as_bytes());
    let mut ikm = [0u8; 32];
    Hkdf::<Sha256>::new(Some(&recipient.auth), shared.raw_secret_bytes().as_slice())
        .expand(&key_info, &mut ikm)
        .map_err(|_| "key derivation failed")?;

    // RFC 8188: the content key and nonce, from the salt in the header.
    let prk = Hkdf::<Sha256>::new(Some(salt), &ikm);
    let (mut cek, mut nonce) = ([0u8; 16], [0u8; 12]);
    prk.expand(b"Content-Encoding: aes128gcm\0", &mut cek).map_err(|_| "key derivation failed")?;
    prk.expand(b"Content-Encoding: nonce\0", &mut nonce).map_err(|_| "key derivation failed")?;

    // A single, last record: the text, then the delimiter 0x02.
    let mut record = plaintext.to_vec();
    record.push(2);
    let sealed = Aes128Gcm::new_from_slice(&cek)
        .map_err(|_| "key derivation failed")?
        .encrypt(Nonce::from_slice(&nonce), record.as_slice())
        .map_err(|_| "encryption failed")?;

    let mut body = Vec::with_capacity(86 + sealed.len());
    body.extend_from_slice(salt);
    body.extend_from_slice(&RECORD_SIZE.to_be_bytes());
    body.push(as_public.as_bytes().len() as u8);
    body.extend_from_slice(as_public.as_bytes());
    body.extend_from_slice(&sealed);
    Ok(body)
}

/// The application server's identity: one P-256 key pair, made once.
pub struct Vapid {
    secret: SecretKey,
}

impl Vapid {
    pub fn generate() -> Self {
        Self { secret: SecretKey::random(&mut OsRng) }
    }

    pub fn from_private(bytes: &[u8]) -> Option<Self> {
        SecretKey::from_slice(bytes).ok().map(|secret| Self { secret })
    }

    pub fn private_bytes(&self) -> Vec<u8> {
        self.secret.to_bytes().to_vec()
    }

    /// What a browser passes as `applicationServerKey`: the uncompressed point, base64url.
    pub fn public_key(&self) -> String {
        b64(self.secret.public_key().to_encoded_point(false).as_bytes())
    }

    /// The `Authorization` header for one push service (`audience` is its origin).
    pub fn authorization(&self, audience: &str, subject: &str, now: i64) -> String {
        format!("vapid t={}, k={}", self.token(audience, subject, now), self.public_key())
    }

    /// An ES256 JWT: `aud` the push service's origin, `exp` within 24 hours,
    /// `sub` a contact address.
    pub fn token(&self, audience: &str, subject: &str, now: i64) -> String {
        let header = b64(br#"{"typ":"JWT","alg":"ES256"}"#);
        let claims = json!({ "aud": audience, "exp": now + TOKEN_LIFETIME_SECONDS, "sub": subject });
        let unsigned = format!("{header}.{}", b64(claims.to_string().as_bytes()));
        let signature: Signature = SigningKey::from(&self.secret).sign(unsigned.as_bytes());
        format!("{unsigned}.{}", b64(&signature.to_bytes()))
    }
}

/// Encrypts what the database keeps (the VAPID private key, each browser's
/// auth secret) with a key that is not in the database.
pub struct Seal {
    key: [u8; 32],
}

impl Seal {
    /// The sealing key in `file`, created (0600) the first time. A file that
    /// is not a key (cut short by a crash, say) is replaced: nothing sealed
    /// with it could be opened anyway, and the caller starts over.
    pub fn open(file: &Path) -> std::io::Result<Self> {
        static CREATING: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let _one_at_a_time = CREATING.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        match std::fs::read(file) {
            Ok(bytes) => match <[u8; 32]>::try_from(bytes.as_slice()) {
                Ok(key) => Ok(Self { key }),
                Err(_) => Self::create(file),
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Self::create(file),
            Err(error) => Err(error),
        }
    }

    /// Written whole to a temporary file and renamed, so a reader never sees half a key.
    fn create(file: &Path) -> std::io::Result<Self> {
        use std::io::Write;
        let directory = file.parent().unwrap_or(Path::new("."));
        std::fs::create_dir_all(directory)?;
        let key = random::<32>();
        let temporary = directory.join(format!(".push-seal.{}", uuid::Uuid::new_v4()));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let written = options.open(&temporary).and_then(|mut handle| {
            handle.write_all(&key)?;
            handle.sync_all()
        });
        if let Err(error) = written.and_then(|_| std::fs::rename(&temporary, file)) {
            let _ = std::fs::remove_file(&temporary);
            return Err(error);
        }
        Ok(Self { key })
    }

    /// `nonce || ciphertext`, base64url.
    pub fn seal(&self, plain: &[u8]) -> String {
        let nonce = random::<12>();
        let sealed = Aes256Gcm::new_from_slice(&self.key)
            .expect("32-byte key")
            .encrypt(Nonce::from_slice(&nonce), plain)
            .expect("AES-GCM encryption");
        b64(&[nonce.as_slice(), sealed.as_slice()].concat())
    }

    /// `None` when the text was sealed with another key or was tampered with.
    pub fn open_sealed(&self, text: &str) -> Option<Vec<u8>> {
        let bytes = unb64(text)?;
        if bytes.len() < 12 + 16 {
            return None;
        }
        let (nonce, sealed) = bytes.split_at(12);
        Aes256Gcm::new_from_slice(&self.key).ok()?.decrypt(Nonce::from_slice(nonce), sealed).ok()
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use p256::ecdsa::{VerifyingKey, signature::Verifier};

    // RFC 8291, Appendix A.
    const PLAINTEXT: &str = "When I grow up, I want to be a watermelon";
    const AS_PRIVATE: &str = "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw";
    const AS_PUBLIC: &str = "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";
    const UA_PRIVATE: &str = "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94";
    const UA_PUBLIC: &str = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
    const SALT: &str = "DGv6ra1nlYgDCS1FRnbzlw";
    const AUTH: &str = "BTBZMqHH6r4Tts7J_aSIgg";
    const BODY: &str = "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN";

    /// What a browser does with a message, to read back what was sent.
    pub(crate) fn decrypt(ua_private: &[u8], auth: &[u8], body: &[u8]) -> Option<Vec<u8>> {
        let ua = SecretKey::from_slice(ua_private).ok()?;
        let salt = &body[..16];
        let key_length = body[20] as usize;
        let as_public_bytes = &body[21..21 + key_length];
        let as_public = PublicKey::from_sec1_bytes(as_public_bytes).ok()?;
        let shared = p256::ecdh::diffie_hellman(ua.to_nonzero_scalar(), as_public.as_affine());
        let mut key_info = b"WebPush: info\0".to_vec();
        key_info.extend_from_slice(ua.public_key().to_encoded_point(false).as_bytes());
        key_info.extend_from_slice(as_public_bytes);
        let mut ikm = [0u8; 32];
        Hkdf::<Sha256>::new(Some(auth), shared.raw_secret_bytes().as_slice()).expand(&key_info, &mut ikm).ok()?;
        let prk = Hkdf::<Sha256>::new(Some(salt), &ikm);
        let (mut cek, mut nonce) = ([0u8; 16], [0u8; 12]);
        prk.expand(b"Content-Encoding: aes128gcm\0", &mut cek).ok()?;
        prk.expand(b"Content-Encoding: nonce\0", &mut nonce).ok()?;
        let mut plain = Aes128Gcm::new_from_slice(&cek)
            .ok()?
            .decrypt(Nonce::from_slice(&nonce), &body[21 + key_length..])
            .ok()?;
        while plain.last() == Some(&0) {
            plain.pop();
        }
        (plain.pop() == Some(2)).then_some(plain)
    }

    #[test]
    fn hub_push_encryption_matches_the_rfc_8291_example() {
        let recipient = Recipient::new(&unb64(UA_PUBLIC).unwrap(), &unb64(AUTH).unwrap()).unwrap();
        let sender = SecretKey::from_slice(&unb64(AS_PRIVATE).unwrap()).unwrap();
        assert_eq!(b64(sender.public_key().to_encoded_point(false).as_bytes()), AS_PUBLIC);
        let salt: [u8; 16] = unb64(SALT).unwrap().try_into().unwrap();
        let body = encrypt_with(&recipient, &sender, &salt, PLAINTEXT.as_bytes()).unwrap();
        assert_eq!(b64(&body), BODY);
        // And the browser's side reads it back.
        let read = decrypt(&unb64(UA_PRIVATE).unwrap(), &unb64(AUTH).unwrap(), &body).unwrap();
        assert_eq!(read, PLAINTEXT.as_bytes());
    }

    #[test]
    fn hub_push_encryption_is_fresh_each_time_and_bounded() {
        let recipient = Recipient::new(&unb64(UA_PUBLIC).unwrap(), &unb64(AUTH).unwrap()).unwrap();
        let first = encrypt(&recipient, b"hello").unwrap();
        let second = encrypt(&recipient, b"hello").unwrap();
        assert_ne!(first, second, "a new salt and sender key per message");
        assert_eq!(first.len(), 86 + 5 + 1 + 16);
        let read = decrypt(&unb64(UA_PRIVATE).unwrap(), &unb64(AUTH).unwrap(), &first).unwrap();
        assert_eq!(read, b"hello");
        let longest = vec![b'x'; MAX_PLAINTEXT];
        assert_eq!(encrypt(&recipient, &longest).unwrap().len(), RECORD_SIZE as usize);
        assert!(encrypt(&recipient, &vec![b'x'; MAX_PLAINTEXT + 1]).is_err());
    }

    #[test]
    fn hub_push_recipient_keys_are_checked() {
        let (public, auth) = (unb64(UA_PUBLIC).unwrap(), unb64(AUTH).unwrap());
        assert!(Recipient::new(&public, &auth).is_ok());
        assert!(Recipient::new(&public[..64], &auth).is_err(), "short key");
        assert!(Recipient::new(&public, &auth[..15]).is_err(), "short auth");
        let mut compressed = public.clone();
        compressed[0] = 2;
        assert!(Recipient::new(&compressed, &auth).is_err(), "not uncompressed");
        let mut off_curve = public.clone();
        off_curve[64] ^= 1;
        assert!(Recipient::new(&off_curve, &auth).is_err(), "not on the curve");
        assert_eq!(unb64("BTBZMqHH6r4Tts7J_aSIgg==").unwrap(), auth, "padding is accepted");
    }

    #[test]
    fn hub_push_vapid_token_has_the_claims_and_a_valid_signature() {
        let vapid = Vapid::generate();
        let now = 1_800_000_000;
        let token = vapid.token("https://fcm.googleapis.com", "mailto:someone@example.com", now);
        let parts: Vec<&str> = token.split('.').collect();
        assert_eq!(parts.len(), 3);
        let header: serde_json::Value = serde_json::from_slice(&unb64(parts[0]).unwrap()).unwrap();
        assert_eq!(header, json!({ "typ": "JWT", "alg": "ES256" }));
        let claims: serde_json::Value = serde_json::from_slice(&unb64(parts[1]).unwrap()).unwrap();
        assert_eq!(claims["aud"], "https://fcm.googleapis.com");
        assert_eq!(claims["sub"], "mailto:someone@example.com");
        let exp = claims["exp"].as_i64().unwrap();
        assert!(exp > now && exp - now <= 24 * 60 * 60, "expires within 24 hours");
        // Signed by the key the browser subscribed with: raw r || s, 64 bytes.
        let signature = unb64(parts[2]).unwrap();
        assert_eq!(signature.len(), 64);
        let key = VerifyingKey::from_sec1_bytes(&unb64(&vapid.public_key()).unwrap()).unwrap();
        let signed = format!("{}.{}", parts[0], parts[1]);
        key.verify(signed.as_bytes(), &Signature::from_slice(&signature).unwrap()).unwrap();
        assert!(key.verify(b"something else", &Signature::from_slice(&signature).unwrap()).is_err());

        let header = vapid.authorization("https://fcm.googleapis.com", "mailto:someone@example.com", now);
        assert!(header.starts_with("vapid t="));
        assert!(header.ends_with(&format!(", k={}", vapid.public_key())));
    }

    #[test]
    fn hub_push_vapid_key_survives_a_round_trip() {
        let vapid = Vapid::generate();
        let public = unb64(&vapid.public_key()).unwrap();
        assert_eq!((public.len(), public[0]), (65, 4));
        let again = Vapid::from_private(&vapid.private_bytes()).unwrap();
        assert_eq!(again.public_key(), vapid.public_key());
        assert!(Vapid::from_private(&[0u8; 32]).is_none(), "zero is not a key");
        assert!(Vapid::from_private(b"short").is_none());
    }

    #[test]
    fn hub_push_seal_keeps_its_key_in_a_private_file() {
        let dir = std::env::temp_dir().join(format!("hub-push-seal-{}", uuid::Uuid::new_v4()));
        let file = dir.join("push-seal.key");
        let seal = Seal::open(&file).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
        }
        let sealed = seal.seal(b"private key bytes");
        assert!(!sealed.contains(&b64(b"private key bytes")));
        assert_ne!(sealed, seal.seal(b"private key bytes"), "a nonce per value");
        // The same file opens what it sealed; another key does not.
        assert_eq!(Seal::open(&file).unwrap().open_sealed(&sealed).unwrap(), b"private key bytes");
        let other = Seal::open(&dir.join("other.key")).unwrap();
        assert!(other.open_sealed(&sealed).is_none());
        assert!(seal.open_sealed("not sealed").is_none());
        // A file that is not a key is replaced; what the old key sealed is gone.
        std::fs::write(&file, b"too short").unwrap();
        let replaced = Seal::open(&file).unwrap();
        assert_eq!(std::fs::read(&file).unwrap().len(), 32);
        assert!(replaced.open_sealed(&sealed).is_none());
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 2, "no temporary file is left behind");
        std::fs::remove_dir_all(dir).ok();
    }
}
