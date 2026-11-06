//! Who may open a published page: password hashing, the signed cookie a
//! correct password earns, the limit on wrong guesses, and the small pages
//! shown instead of the file.
use argon2::{
    Argon2,
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{LazyLock, Mutex},
    time::{Duration, Instant},
};

/// The cookie a correct password earns, scoped to `/p/{slug}`.
pub(super) const COOKIE: &str = "tendly_page";
/// How long a correct password is remembered.
pub(super) const COOKIE_SECONDS: i64 = 7 * 24 * 60 * 60;
/// Wrong passwords allowed per page per window.
const ATTEMPTS: usize = 10;
const WINDOW: Duration = Duration::from_secs(60);
pub(super) const MIN_PASSWORD: usize = 4;

fn hasher() -> Argon2<'static> {
    // Tests run unoptimised, where the default cost takes seconds.
    #[cfg(test)]
    {
        Argon2::new(
            argon2::Algorithm::Argon2id,
            argon2::Version::V0x13,
            argon2::Params::new(1024, 1, 1, None).expect("argon2 params"),
        )
    }
    #[cfg(not(test))]
    {
        Argon2::default()
    }
}

pub(super) fn hash_password(password: &str) -> Result<String, String> {
    let salt = SaltString::encode_b64(uuid::Uuid::new_v4().as_bytes()).map_err(|e| e.to_string())?;
    hasher()
        .hash_password(password.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|e| e.to_string())
}

/// Whether `password` matches the stored hash (whose own parameters are used).
pub(super) fn check_password(password: &str, stored: &str) -> bool {
    PasswordHash::new(stored)
        .is_ok_and(|hash| Argon2::default().verify_password(password.as_bytes(), &hash).is_ok())
}

fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    const BLOCK: usize = 64;
    let mut block = [0u8; BLOCK];
    if key.len() > BLOCK {
        block[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        block[..key.len()].copy_from_slice(key);
    }
    let pad = |byte: u8| block.map(|b| b ^ byte);
    let inner = Sha256::new().chain_update(pad(0x36)).chain_update(message).finalize();
    Sha256::new().chain_update(pad(0x5c)).chain_update(inner).finalize().into()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn equal(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |n, (x, y)| n | (x ^ y)) == 0
}

/// The cookie value: its expiry and an HMAC over the page, the password's
/// hash and that expiry. A new password is a new hash (new salt), so every
/// cookie issued for the old one stops matching.
pub(super) fn sign(secret: &str, slug: &str, password_hash: &str, expires: i64) -> String {
    let message = format!("{slug}\n{password_hash}\n{expires}");
    format!("{expires}.{}", hex(&hmac_sha256(secret.as_bytes(), message.as_bytes())))
}

pub(super) fn verify(secret: &str, slug: &str, password_hash: &str, value: &str, now: i64) -> bool {
    let Some(expires) = value.split_once('.').and_then(|(e, _)| e.parse::<i64>().ok()) else {
        return false;
    };
    expires > now
        && expires <= now + COOKIE_SECONDS + 60
        && equal(&sign(secret, slug, password_hash, expires), value)
}

/// Every value of the page cookie the browser sent (one per matching path).
pub(super) fn cookie_values(headers: &axum::http::HeaderMap) -> Vec<String> {
    headers
        .get_all(axum::http::header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|part| part.trim().strip_prefix(COOKIE)?.strip_prefix('=').map(str::to_owned))
        .collect()
}

pub(super) fn set_cookie(slug: &str, value: &str, secure: bool) -> String {
    let secure = if secure { "; Secure" } else { "" };
    format!("{COOKIE}={value}; HttpOnly; SameSite=Lax; Path=/p/{slug}; Max-Age={COOKIE_SECONDS}{secure}")
}

/// Wrong passwords per page, in memory: a restart forgets them.
#[derive(Default)]
pub(super) struct Limiter {
    failures: HashMap<String, Vec<Instant>>,
}
impl Limiter {
    pub(super) fn blocked(&mut self, slug: &str, now: Instant) -> bool {
        let Some(list) = self.failures.get_mut(slug) else { return false };
        list.retain(|at| now.duration_since(*at) < WINDOW);
        if list.is_empty() {
            self.failures.remove(slug);
            return false;
        }
        list.len() >= ATTEMPTS
    }
    pub(super) fn fail(&mut self, slug: &str, now: Instant) {
        self.failures.entry(slug.to_owned()).or_default().push(now);
    }
    pub(super) fn clear(&mut self, slug: &str) {
        self.failures.remove(slug);
    }
}
pub(super) static LIMITER: LazyLock<Mutex<Limiter>> = LazyLock::new(Default::default);

pub(super) fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            c => out.push(c),
        }
    }
    out
}

/// A small standalone page in neutral colours, light or dark with the system.
pub(super) fn page(title: &str, body: &str, wide: bool) -> String {
    let width = if wide { "46rem" } else { "24rem" };
    format!(
        r#"<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>{title}</title>
<style>
:root {{ color-scheme: light dark; --bg: #fafaf9; --ink: #1c1c1a; --muted: #6b6b66; --line: #e2e2de; --card: #ffffff; --accent: #2f5bd3; }}
@media (prefers-color-scheme: dark) {{ :root {{ --bg: #161615; --ink: #ecece8; --muted: #9a9a94; --line: #2e2e2b; --card: #1e1e1c; --accent: #8aa8ff; }} }}
* {{ box-sizing: border-box; }}
body {{ margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }}
main {{ max-width: {width}; margin: 12vh auto 4rem; padding: 0 1rem; }}
main.doc {{ margin-top: 2rem; }}
h1 {{ font-size: 1.15rem; margin: 0 0 .5rem; font-weight: 600; }}
p {{ color: var(--muted); margin: 0 0 1rem; }}
form {{ display: flex; flex-direction: column; gap: .6rem; }}
input {{ font: inherit; padding: .6rem .75rem; border: 1px solid var(--line); border-radius: .5rem; background: var(--card); color: var(--ink); }}
button {{ font: inherit; padding: .6rem .75rem; border: 0; border-radius: .5rem; background: var(--accent); color: var(--bg); cursor: pointer; font-weight: 600; }}
.error {{ color: #c0392b; }}
pre {{ white-space: pre-wrap; word-wrap: break-word; font: 15px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--card); border: 1px solid var(--line); border-radius: .5rem; padding: 1.25rem; margin: 0; }}
.name {{ color: var(--muted); font-size: .85rem; margin-bottom: .5rem; }}
</style></head>
<body><main{class}>{body}</main></body></html>"#,
        title = escape(title),
        class = if wide { r#" class="doc""# } else { "" },
    )
}

pub(super) fn not_found() -> String {
    page("Not found", "<h1>Not found</h1><p>There is nothing at this address.</p>", false)
}

pub(super) fn team_only() -> String {
    page(
        "Team only",
        "<h1>This page is only for the team.</h1><p>Sign in to Tendly on this browser, then open the link again.</p>",
        false,
    )
}

pub(super) fn password_form(slug: &str, error: Option<&str>) -> String {
    let error = error
        .map(|e| format!(r#"<p class="error" role="alert">{}</p>"#, escape(e)))
        .unwrap_or_default();
    page(
        "Password required",
        &format!(
            r#"<h1>This page is protected.</h1><p>Enter the password to open it.</p>{error}
<form method="post" action="/p/{slug}/"><input type="password" name="password" autocomplete="current-password" aria-label="Password" autofocus required>
<button type="submit">Open</button></form>"#,
            slug = escape(slug)
        ),
        false,
    )
}

/// A Markdown file shown as its text, wrapped so it reads on any screen. No
/// Markdown renderer is a dependency; the text is escaped, never interpreted.
pub(super) fn markdown_page(name: &str, text: &str) -> String {
    page(
        name,
        &format!(r#"<div class="name">{}</div><pre>{}</pre>"#, escape(name), escape(text)),
        true,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hub_publish_passwords_hash_and_verify() {
        let hash = hash_password("correct horse").unwrap();
        assert!(hash.starts_with("$argon2id$"));
        assert!(check_password("correct horse", &hash));
        assert!(!check_password("wrong", &hash));
        assert!(!check_password("correct horse", "not a hash"));
        // Salted: the same password never hashes the same way twice.
        assert_ne!(hash, hash_password("correct horse").unwrap());
    }

    #[test]
    fn hub_publish_cookies_verify_expire_and_die_with_the_password() {
        let now = 1_800_000_000;
        let hash = hash_password("one").unwrap();
        let value = sign("secret", "page-ab12", &hash, now + COOKIE_SECONDS);
        assert!(verify("secret", "page-ab12", &hash, &value, now));
        // Another page, another server secret, or after expiry: refused.
        assert!(!verify("secret", "other-ab12", &hash, &value, now));
        assert!(!verify("other secret", "page-ab12", &hash, &value, now));
        assert!(!verify("secret", "page-ab12", &hash, &value, now + COOKIE_SECONDS + 1));
        // Changing the password (a new salted hash) invalidates the cookie.
        let changed = hash_password("one").unwrap();
        assert!(!verify("secret", "page-ab12", &changed, &value, now));
        // Tampering with the expiry or the signature is refused.
        let (_, mac) = value.split_once('.').unwrap();
        assert!(!verify("secret", "page-ab12", &hash, &format!("{}.{mac}", now + 999_999_999), now));
        assert!(!verify("secret", "page-ab12", &hash, &format!("{}.{}", now + 10, "0".repeat(64)), now));
        assert!(!verify("secret", "page-ab12", &hash, "garbage", now));

        let mut headers = axum::http::HeaderMap::new();
        headers.insert(axum::http::header::COOKIE, format!("a=b; {COOKIE}={value}; tendly_session=x").parse().unwrap());
        assert_eq!(cookie_values(&headers), [value.clone()]);
        let set = set_cookie("page-ab12", &value, false);
        assert!(set.contains("HttpOnly") && set.contains("SameSite=Lax") && set.contains("Path=/p/page-ab12;"));
        assert!(!set.contains("Secure"));
        assert!(set_cookie("page-ab12", &value, true).ends_with("; Secure"));
    }

    #[test]
    fn hub_publish_wrong_passwords_are_limited_per_page() {
        let mut limiter = Limiter::default();
        let start = Instant::now();
        for _ in 0..ATTEMPTS {
            assert!(!limiter.blocked("a", start));
            limiter.fail("a", start);
        }
        assert!(limiter.blocked("a", start));
        assert!(!limiter.blocked("b", start), "per page");
        assert!(!limiter.blocked("a", start + WINDOW), "a minute later");
    }

    #[test]
    fn hub_publish_pages_escape_what_they_show() {
        let shown = markdown_page("<b>.md", "# Title\n<script>alert(1)</script>");
        assert!(!shown.contains("<script>alert"));
        assert!(shown.contains("&lt;script&gt;"));
        assert!(!password_form("x", Some("<i>")).contains("<i>"));
    }
}
