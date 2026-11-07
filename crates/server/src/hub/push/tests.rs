//! Web Push against a stand-in push service on the loopback: what is sent
//! (headers, VAPID token, a body the device can decrypt) and what each answer
//! does to the subscription.
use super::*;
use crate::{accounts, activity, agent, conversations, file_watch, security, worktree_setup};
use axum::{
    body::{Body, to_bytes},
    http::{HeaderMap, Request},
    response::{IntoResponse, Response},
};
use p256::{
    SecretKey,
    ecdsa::{Signature, VerifyingKey, signature::Verifier},
    elliptic_curve::sec1::ToEncodedPoint,
};
use rand_core::{OsRng, RngCore};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use tower::ServiceExt;

const HOST: &str = "127.0.0.1:8787";
const TOKEN: &str = "team-token";

struct Fixture {
    state: AppState,
    dir: PathBuf,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn fixture() -> Fixture {
    let dir = std::env::temp_dir().join(format!("hub-push-{}", uuid::Uuid::new_v4()));
    let repo = dir.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    let repo = dunce::canonicalize(repo).unwrap();
    let state = AppState {
        store: Arc::new(tendly_persistence::Store::open(":memory:").unwrap()),
        runtime: tendly_runtime::RuntimeManager::new(),
        state_dir: dir.join("state"),
        roots: crate::host_roots::HostRoots::fixed(vec![repo.clone()], vec![dunce::canonicalize(&dir).unwrap()]),
        host_grants: crate::host_grants::HostGrants::default(),
        native_sources: Vec::new(),
        native_bridge: PathBuf::from("packages/native-bridge/history.mjs"),
        chat_fixture: None,
        chats: conversations::ChatManager::default(),
        watches: file_watch::FileWatches::default(),
        accounts: accounts::AccountManager::default(),
        security: security::Security::for_test(HOST.parse().unwrap(), Some(TOKEN)),
        tailnet: crate::tailscale::Tailnet::disabled(),
        peers: crate::peers::Peers::new(&dir.join("state")),
        claude_manual_mode: true,
        operations: Arc::new(tokio::sync::Mutex::new(())),
        agents: agent::AgentRegistry::default(),
        activity: activity::Activity::default(),
        setups: worktree_setup::Setups::default(),
        metrics: None,
        hub: Arc::new(crate::hub::HubStore::memory()),
    };
    Fixture { state, dir }
}

impl Fixture {
    async fn send(&self, method: &str, path: &str, body: Option<Value>) -> (StatusCode, Value) {
        let request = Request::builder()
            .method(method)
            .uri(path)
            .header("host", HOST)
            .header("authorization", format!("Bearer {TOKEN}"))
            .header("content-type", "application/json")
            .header("x-tendly-client", "web")
            .body(body.map(|b| Body::from(b.to_string())).unwrap_or_default())
            .unwrap();
        let response = crate::router(self.state.clone()).oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), 4 << 20).await.unwrap();
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    async fn subscribe(&self, endpoint: &str, device: &Device, label: &str) -> String {
        let (status, body) = self.send("POST", "/api/hub/push/subscriptions", Some(device.subscription(endpoint, label))).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        body["id"].as_str().unwrap().to_owned()
    }

    async fn devices(&self) -> Vec<Value> {
        let (status, body) = self.send("GET", "/api/hub/push/subscriptions", None).await;
        assert_eq!(status, StatusCode::OK);
        body["subscriptions"].as_array().unwrap().clone()
    }

    async fn device(&self, id: &str) -> Option<Value> {
        self.devices().await.into_iter().find(|row| row["id"] == id)
    }

    async fn push(&self, message: Message) -> Report {
        send_all(self.state.hub.clone(), self.state.state_dir.clone(), message).await
    }
}

/// A browser's half of a subscription, with the private key to read messages back.
struct Device {
    private: Vec<u8>,
    p256dh: String,
    auth: [u8; 16],
}

impl Device {
    fn new() -> Self {
        let secret = SecretKey::random(&mut OsRng);
        let mut auth = [0u8; 16];
        OsRng.fill_bytes(&mut auth);
        Self {
            private: secret.to_bytes().to_vec(),
            p256dh: b64(secret.public_key().to_encoded_point(false).as_bytes()),
            auth,
        }
    }

    fn subscription(&self, endpoint: &str, label: &str) -> Value {
        json!({ "endpoint": endpoint, "keys": { "p256dh": self.p256dh, "auth": b64(&self.auth) }, "label": label })
    }

    fn read(&self, body: &[u8]) -> Value {
        let plain = crypto::tests::decrypt(&self.private, &self.auth, body).expect("the device can decrypt it");
        serde_json::from_slice(&plain).unwrap()
    }
}

struct Captured {
    path: String,
    headers: HeaderMap,
    body: Vec<u8>,
}

/// The stand-in push service: it records every request and answers by the
/// first segment of the path.
#[derive(Clone, Default)]
struct Service {
    requests: Arc<Mutex<Vec<Captured>>>,
    healthy: Arc<AtomicBool>,
}

impl Service {
    async fn start() -> (String, Self) {
        let service = Self::default();
        let app = Router::new().fallback(answer).with_state(service.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (base, service)
    }

    fn count(&self) -> usize {
        self.requests.lock().unwrap().len()
    }

    fn count_for(&self, prefix: &str) -> usize {
        self.requests.lock().unwrap().iter().filter(|request| request.path.starts_with(prefix)).count()
    }

    fn take_last(&self) -> Captured {
        self.requests.lock().unwrap().pop().expect("a request arrived")
    }

    async fn wait_for(&self, count: usize) {
        for _ in 0..200 {
            if self.count() >= count {
                return;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        panic!("expected {count} push requests, saw {}", self.count());
    }
}

async fn answer(State(service): State<Service>, request: Request<Body>) -> Response {
    let (parts, body) = request.into_parts();
    let body = to_bytes(body, 1 << 20).await.unwrap().to_vec();
    let path = parts.uri.path().to_owned();
    service.requests.lock().unwrap().push(Captured { path: path.clone(), headers: parts.headers, body });
    match path.trim_start_matches('/').split('/').next().unwrap_or_default() {
        "ok" => StatusCode::CREATED.into_response(),
        "gone" => StatusCode::GONE.into_response(),
        "missing" => StatusCode::NOT_FOUND.into_response(),
        "bad" => StatusCode::BAD_REQUEST.into_response(),
        "down" => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        "busy" => (StatusCode::TOO_MANY_REQUESTS, [("retry-after", "120")]).into_response(),
        "flaky" if service.healthy.load(Ordering::SeqCst) => StatusCode::CREATED.into_response(),
        "flaky" => StatusCode::FORBIDDEN.into_response(),
        _ => StatusCode::IM_A_TEAPOT.into_response(),
    }
}

fn header<'a>(captured: &'a Captured, name: &str) -> &'a str {
    captured.headers.get(name).and_then(|value| value.to_str().ok()).unwrap_or_default()
}

#[tokio::test]
async fn hub_push_key_is_made_once_and_its_private_half_stays_sealed() {
    let fixture = fixture();
    let (status, first) = fixture.send("GET", "/api/hub/push/key", None).await;
    assert_eq!(status, StatusCode::OK);
    let public = unb64(first["key"].as_str().unwrap()).unwrap();
    assert_eq!((public.len(), public[0]), (65, 4), "an uncompressed P-256 point");
    let (_, second) = fixture.send("GET", "/api/hub/push/key", None).await;
    assert_eq!(first, second, "the same key every time");

    let device = Device::new();
    let id = fixture.subscribe("https://push.example/send/abc", &device, "iPhone").await;
    let keys = load_keys(&fixture.state.hub, &fixture.state.state_dir).unwrap();
    let private = b64(&keys.vapid.private_bytes());
    let (stored_private, stored_auth): (String, String) = fixture
        .state
        .hub
        .with(|c| {
            Ok((
                c.query_row("SELECT vapid_private FROM push_keys", [], |r| r.get(0))?,
                c.query_row("SELECT auth FROM push_subscriptions", [], |r| r.get(0))?,
            ))
        })
        .unwrap();
    assert!(!stored_private.contains(&private), "the database holds it sealed");
    assert_ne!(stored_auth, b64(&device.auth), "and each device's auth secret too");

    // Nothing a route answers carries the private key, the endpoint or the device's keys.
    let (_, test) = fixture.send("POST", "/api/hub/push/test", None).await;
    let (_, listed) = fixture.send("GET", "/api/hub/push/subscriptions", None).await;
    let (_, again) = fixture.send("POST", "/api/hub/push/subscriptions", Some(device.subscription("https://push.example/send/abc", "iPhone"))).await;
    assert_eq!(again["id"], id.as_str());
    for answer in [&first, &test, &listed, &again] {
        let text = answer.to_string();
        for secret in [private.as_str(), "send/abc", device.p256dh.as_str(), b64(&device.auth).as_str()] {
            assert!(!text.contains(secret), "{text}");
        }
    }
}

#[tokio::test]
async fn hub_push_subscriptions_are_one_per_endpoint_and_checked() {
    let fixture = fixture();
    let device = Device::new();
    let endpoint = "https://fcm.googleapis.com/fcm/send/device-one";
    let id = fixture.subscribe(endpoint, &device, "  Pixel\n8  ").await;
    let rows = fixture.devices().await;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["label"], "Pixel 8");
    assert_eq!(rows[0]["service"], "fcm.googleapis.com");
    assert_eq!(rows[0]["endpoint_sha256"], endpoint_hash(endpoint));
    assert_eq!(rows[0]["endpoint_sha256"].as_str().unwrap().len(), 64);
    assert_eq!(rows[0]["failures"], 0);
    assert!(rows[0]["last_ok_at"].is_null());
    assert!(rows[0].get("endpoint").is_none() && rows[0].get("auth").is_none() && rows[0].get("p256dh").is_none());

    // The same browser subscribing again (new keys, new name) stays one row with a clean slate.
    fixture.state.hub.with(|c| c.execute("UPDATE push_subscriptions SET failures = 3", [])).unwrap();
    let renewed = Device::new();
    assert_eq!(fixture.subscribe(endpoint, &renewed, "Pixel").await, id);
    let rows = fixture.devices().await;
    assert_eq!(rows.len(), 1);
    assert_eq!((rows[0]["label"].as_str().unwrap(), rows[0]["failures"].as_i64().unwrap()), ("Pixel", 0));
    let other = fixture.subscribe("https://web.push.apple.com/abc", &Device::new(), "").await;
    assert_ne!(other, id);
    assert_eq!(fixture.devices().await.len(), 2);

    let bad = |endpoint: &str, p256dh: &str, auth: &str| json!({ "endpoint": endpoint, "keys": { "p256dh": p256dh, "auth": auth } });
    let auth = b64(&device.auth);
    for (request, why) in [
        (bad("http://push.example/x", &device.p256dh, &auth), "plain http off the loopback"),
        (bad("ftp://push.example/x", &device.p256dh, &auth), "not http at all"),
        (bad("not a url", &device.p256dh, &auth), "not a URL"),
        (bad("https://user:secret@push.example/x", &device.p256dh, &auth), "credentials in the URL"),
        (bad(&format!("https://push.example/{}", "x".repeat(2100)), &device.p256dh, &auth), "too long"),
        (bad(endpoint, "AAAA", &auth), "not a P-256 point"),
        (bad(endpoint, "***", &auth), "not base64url"),
        (bad(endpoint, &device.p256dh, "c2hvcnQ"), "auth is not 16 bytes"),
    ] {
        let (status, body) = fixture.send("POST", "/api/hub/push/subscriptions", Some(request)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{why}: {body}");
    }
    assert_eq!(fixture.devices().await.len(), 2, "nothing was stored by a refused request");

    let (status, _) = fixture.send("DELETE", &format!("/api/hub/push/subscriptions/{id}"), None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, _) = fixture.send("DELETE", &format!("/api/hub/push/subscriptions/{id}"), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(fixture.devices().await.len(), 1);
}

#[tokio::test]
async fn hub_push_has_a_limit_on_devices() {
    let fixture = fixture();
    let device = Device::new();
    fixture
        .state
        .hub
        .with(|c| {
            for index in 0..MAX_SUBSCRIPTIONS {
                c.execute(
                    "INSERT INTO push_subscriptions(id, endpoint, p256dh, auth, created_at) VALUES (?1, ?2, 'p', 'a', 'now')",
                    params![format!("id-{index}"), format!("https://push.example/{index}")],
                )?;
            }
            Ok(())
        })
        .unwrap();
    let (status, _) = fixture.send("POST", "/api/hub/push/subscriptions", Some(device.subscription("https://push.example/new", ""))).await;
    assert_eq!(status, StatusCode::CONFLICT);
    // A device that is already in can still renew itself.
    let (status, _) = fixture.send("POST", "/api/hub/push/subscriptions", Some(device.subscription("https://push.example/7", ""))).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn hub_push_test_sends_an_encrypted_message_signed_with_vapid() {
    let fixture = fixture();
    let (base, service) = Service::start().await;
    let device = Device::new();
    let id = fixture.subscribe(&format!("{base}/ok/device-1"), &device, "Test phone").await;
    let (_, key) = fixture.send("GET", "/api/hub/push/key", None).await;
    let key = key["key"].as_str().unwrap().to_owned();

    let before = Utc::now().timestamp();
    let (status, report) = fixture.send("POST", "/api/hub/push/test", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(report, json!({ "sent": 1, "failed": 0, "removed": 0, "waiting": 0 }));
    let request = service.take_last();
    assert_eq!(request.path, "/ok/device-1");
    assert_eq!(header(&request, "ttl"), "86400", "kept about a day for a phone that is off");
    assert_eq!(header(&request, "urgency"), "normal");
    assert_eq!(header(&request, "content-encoding"), "aes128gcm");
    assert_eq!(header(&request, "content-type"), "application/octet-stream");
    let topic = header(&request, "topic");
    assert!(topic.len() == 32 && topic.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'), "{topic}");

    // RFC 8292: `vapid t=<jwt>, k=<the key the browser subscribed with>`.
    let authorization = header(&request, "authorization");
    let (token, public) = authorization.strip_prefix("vapid t=").unwrap().split_once(", k=").unwrap();
    assert_eq!(public, key);
    let parts: Vec<&str> = token.split('.').collect();
    let claims: Value = serde_json::from_slice(&unb64(parts[1]).unwrap()).unwrap();
    assert_eq!(claims["aud"], base.as_str(), "the push service's origin, without the path");
    assert!(claims["sub"].as_str().unwrap().starts_with("mailto:"));
    let exp = claims["exp"].as_i64().unwrap();
    assert!(exp > before && exp <= Utc::now().timestamp() + 24 * 60 * 60);
    let verifying = VerifyingKey::from_sec1_bytes(&unb64(public).unwrap()).unwrap();
    let signature = Signature::from_slice(&unb64(parts[2]).unwrap()).unwrap();
    verifying.verify(format!("{}.{}", parts[0], parts[1]).as_bytes(), &signature).unwrap();

    // RFC 8291: only the device can read it.
    let message = device.read(&request.body);
    assert_eq!(message["title"], "GCore");
    assert_eq!(message["kind"], "test");
    assert_eq!(message["url"], "/settings/notifications");
    assert!(message["body"].as_str().unwrap().contains("working"));
    assert!(!String::from_utf8_lossy(&request.body).contains("GCore"), "nothing readable on the wire");
    assert!(crypto::tests::decrypt(&Device::new().private, &device.auth, &request.body).is_none(), "nor by another key");

    let row = fixture.device(&id).await.unwrap();
    assert!(row["last_ok_at"].is_string());
    assert_eq!(row["failures"], 0);
}

#[tokio::test]
async fn hub_push_forgets_devices_the_service_no_longer_knows() {
    let fixture = fixture();
    let (base, service) = Service::start().await;
    let gone = fixture.subscribe(&format!("{base}/gone/1"), &Device::new(), "old phone").await;
    let missing = fixture.subscribe(&format!("{base}/missing/2"), &Device::new(), "older phone").await;
    let ok = fixture.subscribe(&format!("{base}/ok/3"), &Device::new(), "phone").await;

    let report = fixture.push(Message::test()).await;
    assert_eq!(report, Report { sent: 1, failed: 2, removed: 2, waiting: 0 });
    assert_eq!(service.count(), 3);
    assert!(fixture.device(&gone).await.is_none(), "410 Gone removes it");
    assert!(fixture.device(&missing).await.is_none(), "so does 404");
    assert!(fixture.device(&ok).await.is_some());
    // They are not tried again.
    assert_eq!(fixture.push(Message::test()).await, Report { sent: 1, failed: 0, removed: 0, waiting: 0 });
    assert_eq!(service.count(), 4);
}

#[tokio::test]
async fn hub_push_drops_a_device_after_five_rejections_in_a_row() {
    let fixture = fixture();
    let (base, service) = Service::start().await;
    let flaky = fixture.subscribe(&format!("{base}/flaky/1"), &Device::new(), "flaky").await;
    let down = fixture.subscribe(&format!("{base}/down/2"), &Device::new(), "down").await;
    let failures = |row: Option<Value>| row.map(|row| row["failures"].as_i64().unwrap());

    for round in 1..=4 {
        let report = fixture.push(Message::test()).await;
        assert_eq!(report, Report { sent: 0, failed: 2, removed: 0, waiting: 0 });
        assert_eq!(failures(fixture.device(&flaky).await), Some(round));
        assert_eq!(failures(fixture.device(&down).await), Some(round));
    }
    // One success in between and the count starts over: it is five in a row.
    service.healthy.store(true, Ordering::SeqCst);
    let report = fixture.push(Message::test()).await;
    assert_eq!(report, Report { sent: 1, failed: 1, removed: 1, waiting: 0 });
    assert_eq!(failures(fixture.device(&flaky).await), Some(0));
    assert!(fixture.device(&down).await.is_none(), "the fifth rejection in a row removed it");

    service.healthy.store(false, Ordering::SeqCst);
    for round in 1..=4 {
        fixture.push(Message::test()).await;
        assert_eq!(failures(fixture.device(&flaky).await), Some(round));
    }
    assert_eq!(fixture.push(Message::test()).await, Report { sent: 0, failed: 1, removed: 1, waiting: 0 });
    assert!(fixture.devices().await.is_empty());
    // With nobody left there is nothing to send, and nothing is sent.
    let seen = service.count();
    assert_eq!(fixture.push(Message::test()).await, Report::default());
    assert_eq!(service.count(), seen);
}

#[tokio::test]
async fn hub_push_respects_retry_after() {
    let fixture = fixture();
    let (base, service) = Service::start().await;
    let busy = fixture.subscribe(&format!("{base}/busy/1"), &Device::new(), "busy").await;

    let report = fixture.push(Message::test()).await;
    assert_eq!(report, Report { sent: 0, failed: 1, removed: 0, waiting: 1 });
    assert_eq!(service.count(), 1);
    let row = fixture.device(&busy).await.unwrap();
    assert_eq!(row["failures"], 0, "being asked to wait is not held against the device");

    // Until the pause is over, that service is not contacted at all: not for
    // this device, and not for another one of the same service.
    let other = fixture.subscribe(&format!("{base}/ok/2"), &Device::new(), "same service").await;
    let report = fixture.push(Message::test()).await;
    assert_eq!(report, Report { sent: 0, failed: 2, removed: 0, waiting: 2 });
    assert_eq!(service.count(), 1);
    assert_eq!(fixture.device(&other).await.unwrap()["failures"], 0);

    // Another push service is not affected by it.
    let (elsewhere, second) = Service::start().await;
    fixture.subscribe(&format!("{elsewhere}/ok/3"), &Device::new(), "another service").await;
    let report = fixture.push(Message::test()).await;
    assert_eq!(report, Report { sent: 1, failed: 2, removed: 0, waiting: 2 });
    assert_eq!((service.count(), second.count()), (1, 1));

    // When the pause ends, sending resumes.
    WAITING.lock().unwrap().remove(&base);
    let report = fixture.push(Message::test()).await;
    assert_eq!((report.sent, report.waiting), (2, 1));
    assert_eq!(service.count_for("/ok/"), 1);
}

#[test]
fn hub_push_answers_are_read_as_the_rules_say() {
    for status in [200, 201, 202, 204] {
        assert_eq!(classify(status, None), Outcome::Delivered);
    }
    assert_eq!(classify(404, None), Outcome::Gone);
    assert_eq!(classify(410, Some(Duration::from_secs(5))), Outcome::Gone);
    for status in [400, 401, 403, 413, 500, 502] {
        assert_eq!(classify(status, None), Outcome::Rejected(status));
    }
    assert_eq!(classify(429, Some(Duration::from_secs(30))), Outcome::Wait(Duration::from_secs(30)));
    assert_eq!(classify(429, None), Outcome::Wait(DEFAULT_WAIT));
    assert_eq!(classify(503, Some(Duration::from_secs(90))), Outcome::Wait(Duration::from_secs(90)));
    assert_eq!(classify(429, Some(Duration::from_secs(86_400))), Outcome::Wait(MAX_WAIT), "never longer than an hour");

    let now = DateTime::parse_from_rfc3339("2026-11-05T12:00:00Z").unwrap().with_timezone(&Utc);
    assert_eq!(retry_after("120", now), Some(Duration::from_secs(120)));
    assert_eq!(retry_after(" 0 ", now), Some(Duration::ZERO));
    assert_eq!(retry_after("Thu, 05 Nov 2026 12:02:00 GMT", now), Some(Duration::from_secs(120)));
    assert_eq!(retry_after("Thu, 05 Nov 2026 11:00:00 GMT", now), Some(Duration::ZERO), "a date in the past");
    assert_eq!(retry_after("soon", now), None);
}

#[tokio::test]
async fn hub_push_does_not_blame_a_device_for_an_unreachable_service() {
    let fixture = fixture();
    // A port nothing listens on: the Mac is offline, as far as this send can tell.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    drop(listener);
    let id = fixture.subscribe(&format!("{base}/ok/1"), &Device::new(), "phone").await;
    for _ in 0..6 {
        assert_eq!(fixture.push(Message::test()).await, Report { sent: 0, failed: 1, removed: 0, waiting: 0 });
    }
    assert_eq!(fixture.device(&id).await.unwrap()["failures"], 0);
}

#[tokio::test]
async fn hub_push_follows_the_bell() {
    let fixture = fixture();
    let (base, service) = Service::start().await;
    let device = Device::new();
    fixture.subscribe(&format!("{base}/ok/1"), &device, "phone").await;

    // A turn that ended: the push opens that conversation.
    let session = uuid::Uuid::new_v4();
    super::super::home::notify(&fixture.state, "turn_completed", Some(session), "Fix the\nlogin bug".into(), String::new()).await;
    service.wait_for(1).await;
    let message = device.read(&service.take_last().body);
    assert_eq!(message["title"], "Fix the login bug");
    assert_eq!(message["body"], "Finished replying");
    assert_eq!(message["kind"], "turn_completed");
    assert_eq!(message["url"], format!("/session/{session}"));
    assert_eq!(message["tag"], format!("tendly-{session}"));
    let recorded: i64 = fixture.state.hub.with(|c| c.query_row("SELECT COUNT(*) FROM notifications", [], |r| r.get(0))).unwrap();
    assert_eq!(recorded, 1, "and the bell has it too");

    // A routine without a conversation: the push opens the bell.
    super::super::home::notify(&fixture.state, "automation_failed", None, "Nightly report".into(), "exit code 2".into()).await;
    service.wait_for(1).await;
    let message = device.read(&service.take_last().body);
    assert_eq!(message["title"], "Nightly report");
    assert_eq!(message["body"], "Routine failed: exit code 2");
    assert_eq!(message["detail"], "exit code 2");
    assert_eq!(message["url"], "/notificacoes");
}

#[tokio::test]
async fn hub_push_is_not_sent_for_the_conversation_on_screen() {
    let fixture = fixture();
    let (base, service) = Service::start().await;
    fixture.subscribe(&format!("{base}/ok/1"), &Device::new(), "phone").await;
    let (watched, other) = (uuid::Uuid::new_v4(), uuid::Uuid::new_v4());

    // The browser's poll says which conversation is in front of the person.
    let (status, _) = fixture.send("GET", &format!("/api/hub/inbox?focused={watched}"), None).await;
    assert_eq!(status, StatusCode::OK);
    assert!(dispatch(&fixture.state, "turn_completed", Some(watched), "Watched", "").is_none());
    let sent = dispatch(&fixture.state, "turn_completed", Some(other), "Elsewhere", "").expect("another conversation is pushed");
    assert_eq!(sent.await.unwrap().sent, 1);
    let sent = dispatch(&fixture.state, "automation_done", None, "Routine", "").expect("so is what has no conversation");
    assert_eq!(sent.await.unwrap().sent, 1);
    assert_eq!(service.count(), 2);

    // Once the browser stops saying so (closed, hidden, the person left), pushes resume.
    LOOKING.lock().unwrap().insert(watched.to_string(), Instant::now() - PRESENCE - Duration::from_secs(1));
    assert!(dispatch(&fixture.state, "turn_completed", Some(watched), "Watched", "").is_some());
    // Something that is not a conversation id is ignored.
    let (status, _) = fixture.send("GET", "/api/hub/inbox?focused=not-an-id", None).await;
    assert_eq!(status, StatusCode::OK);
    assert!(!LOOKING.lock().unwrap().contains_key("not-an-id"));
}

#[tokio::test]
async fn hub_push_starts_over_when_its_seal_is_lost() {
    let fixture = fixture();
    let (_, first) = fixture.send("GET", "/api/hub/push/key", None).await;
    fixture.subscribe("https://push.example/a", &Device::new(), "phone").await;
    // Without the seal file the stored private key cannot be opened again.
    std::fs::remove_file(fixture.state.state_dir.join(SEAL_FILE)).unwrap();
    let (status, second) = fixture.send("GET", "/api/hub/push/key", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_ne!(first["key"], second["key"], "a new key pair");
    assert!(fixture.devices().await.is_empty(), "subscriptions made with the old key are useless");
    let (_, third) = fixture.send("GET", "/api/hub/push/key", None).await;
    assert_eq!(second, third);
}

#[test]
fn hub_push_no_key_is_made_while_nobody_subscribed() {
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    let fixture = fixture();
    let report = runtime.block_on(fixture.push(Message::test()));
    assert_eq!(report, Report::default());
    assert!(!fixture.state.state_dir.join(SEAL_FILE).exists());
    let keys: i64 = fixture.state.hub.with(|c| c.query_row("SELECT COUNT(*) FROM push_keys", [], |r| r.get(0))).unwrap();
    assert_eq!(keys, 0);
}

#[test]
fn hub_push_messages_fit_a_record_whatever_the_text() {
    let session = uuid::Uuid::new_v4();
    let message = Message::for_notification("waiting", Some(session), "", "");
    assert_eq!(message.title, "GCore", "a conversation without a title still says who is calling");
    assert_eq!(message.body, "Is waiting for you");
    assert_eq!(message.url, format!("/session/{session}"));

    let long = Message::for_notification("automation_failed", None, &"título ".repeat(200), &"saída\u{0007}\n".repeat(500));
    assert!(long.title.chars().count() <= 120 && long.title.ends_with('…'));
    assert!(long.detail.chars().count() <= 300);
    assert!(!long.detail.contains('\u{0007}') && !long.detail.contains('\n'));
    assert!(long.payload().len() <= crypto::MAX_PLAINTEXT);
    let parsed: Value = serde_json::from_slice(&long.payload()).unwrap();
    assert_eq!(parsed["url"], "/notificacoes");

    // Text that grows when escaped is cut until it fits.
    let escaped = Message { detail: "\"".repeat(300), body: "\\".repeat(3000), ..Message::test() };
    let payload = escaped.payload();
    assert!(payload.len() <= crypto::MAX_PLAINTEXT);
    assert!(serde_json::from_slice::<Value>(&payload).is_ok());

    // One topic per conversation, so a phone that was off gets the newest only.
    assert_eq!(message.topic(), Message::for_notification("turn_completed", Some(session), "x", "").topic());
    assert_ne!(message.topic(), Message::test().topic());
    assert_eq!(message.topic().len(), 32);
}

#[test]
fn hub_push_endpoints_are_https_or_the_loopback() {
    for good in [
        "https://fcm.googleapis.com/fcm/send/abc",
        "https://web.push.apple.com/QGk",
        "https://updates.push.services.mozilla.com/wpush/v2/gAAAA",
        "http://127.0.0.1:9999/ok/1",
        "http://localhost:9999/ok/1",
        "http://[::1]:9999/ok/1",
    ] {
        assert!(check_endpoint(good).is_ok(), "{good}");
    }
    for bad in [
        "http://fcm.googleapis.com/fcm/send/abc",
        "http://192.168.0.10/x",
        "http://localhost.example.com/x",
        "file:///etc/passwd",
        "https://",
        "",
    ] {
        assert!(check_endpoint(bad).is_err(), "{bad}");
    }
    assert_eq!(service_of("https://fcm.googleapis.com/fcm/send/abc"), "fcm.googleapis.com");
    assert_eq!(service_of("nonsense"), "");
}

#[test]
fn hub_push_subject_is_a_contact_address() {
    assert_eq!(subject_from(None), DEFAULT_SUBJECT);
    assert!(DEFAULT_SUBJECT.starts_with("mailto:"));
    assert_eq!(subject_from(Some(" mailto:me@example.org ")), "mailto:me@example.org");
    assert_eq!(subject_from(Some("https://example.org/contact")), "https://example.org/contact");
    for bad in ["", "me@example.org", "mailto:", "http://example.org"] {
        assert_eq!(subject_from(Some(bad)), DEFAULT_SUBJECT, "{bad:?}");
    }
}
