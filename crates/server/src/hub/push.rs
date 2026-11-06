//! Web Push: what the bell shows also reaches a phone (or any browser) that
//! subscribed, through the browser vendor's push service.
//!
//! - One VAPID key pair identifies this server; it is made the first time it
//!   is needed and its private half never leaves this module (it is sealed in
//!   `push_keys`, see `crypto::Seal`).
//! - A subscription is one browser on one device. Its endpoint is unique, so
//!   subscribing twice updates the row.
//! - Sending never holds up the turn that caused it: `dispatch` spawns a task.
//!   A push service that answers 404 or 410 has forgotten the subscription and
//!   the row goes; five rejections in a row remove it too. `Retry-After` is
//!   respected per push service.
use super::{Hub, HubStore, cs};
use crate::{ApiError, AppState, Result};
use axum::{
    Json, Router,
    extract::{Path, State},
    http::StatusCode,
    routing::{delete, get, post},
};
use chrono::{DateTime, Utc};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::{Path as FsPath, PathBuf},
    sync::{LazyLock, Mutex},
    time::{Duration, Instant},
};
use tendly_domain::SessionId;

pub(crate) mod crypto;
use crypto::{Recipient, Seal, Vapid, b64, unb64};

/// How long a push service keeps a message for a device that is offline.
const TTL_SECONDS: u32 = 24 * 60 * 60;
/// Rejections in a row after which a subscription is dropped.
const MAX_FAILURES: i64 = 5;
const MAX_SUBSCRIPTIONS: i64 = 50;
const MAX_ENDPOINT: usize = 2048;
const MAX_LABEL: usize = 80;
/// The longest a push service can make us wait, whatever it asks for.
const MAX_WAIT: Duration = Duration::from_secs(60 * 60);
/// A 429 that does not say for how long.
const DEFAULT_WAIT: Duration = Duration::from_secs(60);
/// A browser that polled with a conversation on screen this recently is looking at it.
const PRESENCE: Duration = Duration::from_secs(15);
const SEAL_FILE: &str = "push-seal.key";
/// VAPID's contact address. A placeholder until the hub has settings (M4);
/// `TENDLY_PUSH_SUBJECT` (a `mailto:` or `https:` address) replaces it.
const DEFAULT_SUBJECT: &str = "mailto:tendly-push@example.com";

static CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .connect_timeout(Duration::from_secs(8))
        // A push service answers where it was asked; following a redirect
        // would send the request somewhere the browser never named.
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("push client")
});
/// Push services that asked us to wait, and until when.
static WAITING: LazyLock<Mutex<HashMap<String, Instant>>> = LazyLock::new(Default::default);
/// Conversations a browser has on screen right now, and when it last said so.
static LOOKING: LazyLock<Mutex<HashMap<String, Instant>>> = LazyLock::new(Default::default);

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/hub/push/key", get(key))
        .route("/api/hub/push/subscriptions", get(list).post(subscribe))
        .route("/api/hub/push/subscriptions/{id}", delete(remove))
        .route("/api/hub/push/test", post(test))
}

fn now() -> String {
    Utc::now().to_rfc3339()
}

fn subject() -> String {
    subject_from(std::env::var("TENDLY_PUSH_SUBJECT").ok().as_deref())
}

fn subject_from(configured: Option<&str>) -> String {
    configured
        .map(str::trim)
        .filter(|value| (value.starts_with("mailto:") && value.len() > 7) || value.starts_with("https://"))
        .unwrap_or(DEFAULT_SUBJECT)
        .to_owned()
}

// ---------------------------------------------------------------- keys

struct Keys {
    vapid: Vapid,
    seal: Seal,
}

/// The server's keys, made the first time. Blocking: a file and the database.
///
/// A private key that cannot be opened (the seal file was lost or replaced)
/// is useless, and so is every subscription made with it: both start over,
/// and each device subscribes again the next time it opens its settings.
fn load_keys(hub: &HubStore, state_dir: &FsPath) -> std::result::Result<Keys, String> {
    let seal = Seal::open(&state_dir.join(SEAL_FILE)).map_err(|error| format!("push seal key: {error}"))?;
    let vapid = hub
        .with(|c| {
            let stored: Option<String> =
                c.query_row("SELECT vapid_private FROM push_keys WHERE id = 1", [], |r| r.get(0)).optional()?;
            let opened = stored.as_deref().and_then(|sealed| seal.open_sealed(sealed));
            if let Some(vapid) = opened.as_deref().and_then(Vapid::from_private) {
                return Ok(vapid);
            }
            if stored.is_some() {
                tracing::warn!("the stored push key cannot be opened; a new one was made and devices must subscribe again");
                c.execute("DELETE FROM push_subscriptions", [])?;
            }
            let vapid = Vapid::generate();
            c.execute(
                "INSERT INTO push_keys(id, vapid_public, vapid_private) VALUES (1, ?1, ?2)
                 ON CONFLICT(id) DO UPDATE SET vapid_public = ?1, vapid_private = ?2",
                params![vapid.public_key(), seal.seal(&vapid.private_bytes())],
            )?;
            Ok(vapid)
        })
        .map_err(|error| error.to_string())?;
    Ok(Keys { vapid, seal })
}

async fn keys(state: &AppState) -> Result<Keys> {
    let (hub, dir) = (state.hub.clone(), state.state_dir.clone());
    tokio::task::spawn_blocking(move || load_keys(&hub, &dir))
        .await
        .map_err(ApiError::internal)?
        .map_err(ApiError::internal)
}

// ---------------------------------------------------------------- what is sent

/// One notification as the service worker receives it. `body` is the English
/// text; the worker shows its own translation of `kind` when it has one, with
/// `detail` under it.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub(crate) struct Message {
    pub title: String,
    pub body: String,
    pub url: String,
    pub kind: String,
    pub detail: String,
    pub tag: String,
}

/// The inbox texts, as `features/hub/inbox.ts` words them.
fn kind_text(kind: &str) -> &'static str {
    match kind {
        "turn_completed" => "Finished replying",
        "turn_failed" => "Stopped with an error",
        "waiting" => "Is waiting for you",
        "automation_done" => "Routine finished",
        "automation_failed" => "Routine failed",
        "test" => "Notifications are working on this device.",
        _ => "Update",
    }
}

/// Text a notification can show: no control characters, a bounded length.
fn clean(text: &str, max: usize) -> String {
    let flat: String = text.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    let flat = flat.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= max {
        return flat;
    }
    let mut cut: String = flat.chars().take(max.saturating_sub(1)).collect();
    cut.push('…');
    cut
}

impl Message {
    /// What `home::notify` records, as a push: it opens the conversation when
    /// there is one, the bell otherwise.
    pub(crate) fn for_notification(kind: &str, session: Option<SessionId>, title: &str, detail: &str) -> Self {
        let text = kind_text(kind);
        let detail = clean(detail, 300);
        let title = clean(title, 120);
        Self {
            title: if title.is_empty() { "Tendly".into() } else { title.clone() },
            body: if detail.is_empty() { text.into() } else { format!("{text}: {detail}") },
            url: session.map_or_else(|| "/notificacoes".into(), |id| format!("/session/{id}")),
            kind: kind.into(),
            tag: match session {
                Some(id) => format!("tendly-{id}"),
                None => format!("tendly-{kind}-{title}"),
            },
            detail,
        }
    }

    fn test() -> Self {
        Self {
            title: "Tendly".into(),
            body: kind_text("test").into(),
            url: "/settings/notifications".into(),
            kind: "test".into(),
            detail: String::new(),
            tag: "tendly-test".into(),
        }
    }

    /// JSON that fits one encrypted record. The texts are bounded when the
    /// message is made, so the loop only matters for text that escapes badly.
    fn payload(&self) -> Vec<u8> {
        let mut message = self.clone();
        loop {
            let bytes = serde_json::to_vec(&message).unwrap_or_default();
            if bytes.len() <= crypto::MAX_PLAINTEXT {
                return bytes;
            }
            let shorter = |text: &str| clean(text, text.chars().count() / 2);
            message.detail = shorter(&message.detail);
            message.body = shorter(&message.body);
            message.title = shorter(&message.title);
            message.tag = "tendly".into();
        }
    }

    /// `Topic`: a push service keeps only the newest undelivered message of a
    /// topic, so a phone that was off gets one notification per conversation.
    fn topic(&self) -> String {
        b64(&Sha256::digest(self.tag.as_bytes()))[..32].to_owned()
    }
}

// ---------------------------------------------------------------- endpoints

/// Where a browser said to send its pushes. Always HTTPS, as every push
/// service is; plain HTTP only on the loopback, for a stand-in during a test.
fn check_endpoint(endpoint: &str) -> std::result::Result<url::Url, &'static str> {
    if endpoint.len() > MAX_ENDPOINT {
        return Err("endpoint is too long");
    }
    let url = url::Url::parse(endpoint).map_err(|_| "endpoint must be a URL")?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err("endpoint must not carry credentials");
    }
    let loopback = match url.host() {
        Some(url::Host::Domain(name)) => name == "localhost",
        Some(url::Host::Ipv4(address)) => address.is_loopback(),
        Some(url::Host::Ipv6(address)) => address.is_loopback(),
        None => return Err("endpoint must name a host"),
    };
    match url.scheme() {
        "https" => Ok(url),
        "http" if loopback => Ok(url),
        _ => Err("endpoint must be an https URL"),
    }
}

/// The push service, without the path that identifies the device.
fn service_of(endpoint: &str) -> String {
    url::Url::parse(endpoint).ok().and_then(|url| url.host_str().map(str::to_owned)).unwrap_or_default()
}

fn endpoint_hash(endpoint: &str) -> String {
    Sha256::digest(endpoint.as_bytes()).iter().map(|byte| format!("{byte:02x}")).collect()
}

// ---------------------------------------------------------------- routes

/// The public key a browser subscribes with (`applicationServerKey`).
async fn key(State(state): State<AppState>) -> Result<Json<Value>> {
    Ok(Json(json!({ "key": keys(&state).await?.vapid.public_key() })))
}

#[derive(Deserialize)]
struct SubscribeRequest {
    endpoint: String,
    keys: SubscriptionKeys,
    #[serde(default)]
    label: String,
}
#[derive(Deserialize)]
struct SubscriptionKeys {
    p256dh: String,
    auth: String,
}

/// Subscribes this device, or updates it if its endpoint is known already.
async fn subscribe(State(state): State<AppState>, Json(request): Json<SubscribeRequest>) -> Result<Json<Value>> {
    let endpoint = request.endpoint.trim().to_owned();
    check_endpoint(&endpoint).map_err(ApiError::bad)?;
    let p256dh = unb64(&request.keys.p256dh).ok_or_else(|| ApiError::bad("keys.p256dh must be base64url"))?;
    let auth = unb64(&request.keys.auth).ok_or_else(|| ApiError::bad("keys.auth must be base64url"))?;
    Recipient::new(&p256dh, &auth).map_err(ApiError::bad)?;
    let label = clean(&request.label, MAX_LABEL);
    let keys = keys(&state).await?;
    let sealed_auth = keys.seal.seal(&auth);
    let id = cs(&state, move |c| {
        let known: Option<String> = c
            .query_row("SELECT id FROM push_subscriptions WHERE endpoint = ?1", [&endpoint], |r| r.get(0))
            .optional()?;
        if let Some(id) = known {
            // The same browser again: new keys or a new name, and a clean slate.
            c.execute(
                "UPDATE push_subscriptions SET p256dh = ?2, auth = ?3, label = ?4, failures = 0 WHERE id = ?1",
                params![id, b64(&p256dh), sealed_auth, label],
            )?;
            return Ok(Some(id));
        }
        let count: i64 = c.query_row("SELECT COUNT(*) FROM push_subscriptions", [], |r| r.get(0))?;
        if count >= MAX_SUBSCRIPTIONS {
            return Ok(None);
        }
        let id = uuid::Uuid::new_v4().to_string();
        c.execute(
            "INSERT INTO push_subscriptions(id, endpoint, p256dh, auth, label, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, endpoint, b64(&p256dh), sealed_auth, label, now()],
        )?;
        Ok(Some(id))
    })
    .await?
    .ok_or_else(|| ApiError::conflict("Too many devices are subscribed; remove one first"))?;
    Ok(Json(json!({ "id": id })))
}

/// The devices, without anything that could send to them: the push service's
/// host instead of the endpoint, and a hash a browser can match its own to.
async fn list(State(state): State<AppState>) -> Result<Json<Value>> {
    let rows = cs(&state, |c| {
        let mut stmt = c.prepare(
            "SELECT id, endpoint, label, created_at, last_ok_at, failures FROM push_subscriptions ORDER BY created_at, id",
        )?;
        stmt.query_map([], |r| {
            let endpoint: String = r.get(1)?;
            Ok(json!({
                "id": r.get::<_, String>(0)?,
                "service": service_of(&endpoint),
                "endpoint_sha256": endpoint_hash(&endpoint),
                "label": r.get::<_, String>(2)?,
                "created_at": r.get::<_, String>(3)?,
                "last_ok_at": r.get::<_, Option<String>>(4)?,
                "failures": r.get::<_, i64>(5)?,
            }))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()
    })
    .await?;
    Ok(Json(json!({ "subscriptions": rows })))
}

async fn remove(State(state): State<AppState>, Path(id): Path<String>) -> Result<StatusCode> {
    let removed = cs(&state, move |c| c.execute("DELETE FROM push_subscriptions WHERE id = ?1", [id])).await?;
    if removed == 0 {
        return Err(ApiError::missing("Device"));
    }
    Ok(StatusCode::NO_CONTENT)
}

/// "Send a test": one notification to every device, right now.
async fn test(State(state): State<AppState>) -> Result<Json<Value>> {
    let report = send_all(state.hub.clone(), state.state_dir.clone(), Message::test()).await;
    Ok(Json(json!({
        "sent": report.sent,
        "failed": report.failed,
        "removed": report.removed,
        "waiting": report.waiting,
    })))
}

// ---------------------------------------------------------------- presence

/// A browser's poll says which conversation it has on screen, in a focused
/// window, with the person there (see `features/hub/presence.ts`).
pub(super) fn looking_at(session: &str) {
    let Ok(id) = uuid::Uuid::parse_str(session.trim()) else { return };
    let mut looking = LOOKING.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let now = Instant::now();
    looking.retain(|_, seen| now.duration_since(*seen) < PRESENCE * 4);
    looking.insert(id.to_string(), now);
}

fn is_looked_at(session: SessionId) -> bool {
    LOOKING
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(&session.to_string())
        .is_some_and(|seen| seen.elapsed() < PRESENCE)
}

// ---------------------------------------------------------------- sending

/// A notification was just recorded: push it too, unless the person is
/// looking at that very conversation. Returns at once; the handle is for tests.
pub(super) fn dispatch(
    state: &AppState,
    kind: &str,
    session: Option<SessionId>,
    title: &str,
    detail: &str,
) -> Option<tokio::task::JoinHandle<Report>> {
    if session.is_some_and(is_looked_at) {
        return None;
    }
    let message = Message::for_notification(kind, session, title, detail);
    Some(tokio::spawn(send_all(state.hub.clone(), state.state_dir.clone(), message)))
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct Report {
    pub sent: usize,
    /// Everything that did not arrive, whatever the reason.
    pub failed: usize,
    /// Subscriptions dropped by this send.
    pub removed: usize,
    /// Held back because the push service asked for a pause.
    pub waiting: usize,
}

struct Target {
    id: String,
    endpoint: String,
    p256dh: String,
    auth: String,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Outcome {
    Delivered,
    /// 404 or 410: the push service no longer knows this subscription.
    Gone,
    /// Any other answer that is not a success; counts toward removal.
    Rejected(u16),
    /// The service asked for a pause; nothing is held against the subscription.
    Wait(Duration),
    /// Not sent: its service is still in a pause it asked for.
    Paused,
    /// No answer at all (offline, timeout): says nothing about the subscription.
    Unreachable,
    /// The stored row can never be sent to (keys that do not open).
    Unusable,
}

/// What a push service's answer means for the subscription.
fn classify(status: u16, retry_after: Option<Duration>) -> Outcome {
    match status {
        200..=299 => Outcome::Delivered,
        404 | 410 => Outcome::Gone,
        429 => Outcome::Wait(retry_after.unwrap_or(DEFAULT_WAIT).min(MAX_WAIT)),
        500..=599 if retry_after.is_some() => Outcome::Wait(retry_after.unwrap_or(DEFAULT_WAIT).min(MAX_WAIT)),
        other => Outcome::Rejected(other),
    }
}

/// `Retry-After`: seconds, or an HTTP date.
fn retry_after(value: &str, now: DateTime<Utc>) -> Option<Duration> {
    let value = value.trim();
    if let Ok(seconds) = value.parse::<u64>() {
        return Some(Duration::from_secs(seconds));
    }
    let at = DateTime::parse_from_rfc2822(value).ok()?.with_timezone(&Utc);
    Some((at - now).to_std().unwrap_or(Duration::ZERO))
}

fn paused(origin: &str) -> bool {
    let mut waiting = WAITING.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let now = Instant::now();
    waiting.retain(|_, until| *until > now);
    waiting.contains_key(origin)
}

fn pause(origin: &str, duration: Duration) {
    WAITING
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(origin.to_owned(), Instant::now() + duration);
}

fn targets(c: &Connection) -> rusqlite::Result<Vec<Target>> {
    let mut stmt = c.prepare("SELECT id, endpoint, p256dh, auth FROM push_subscriptions ORDER BY created_at, id")?;
    stmt.query_map([], |r| Ok(Target { id: r.get(0)?, endpoint: r.get(1)?, p256dh: r.get(2)?, auth: r.get(3)? }))?
        .collect()
}

/// Records what one send meant; true when the subscription was removed.
fn apply(c: &Connection, id: &str, outcome: Outcome) -> rusqlite::Result<bool> {
    match outcome {
        Outcome::Delivered => {
            c.execute("UPDATE push_subscriptions SET failures = 0, last_ok_at = ?2 WHERE id = ?1", params![id, now()])?;
            Ok(false)
        }
        Outcome::Gone | Outcome::Unusable => Ok(c.execute("DELETE FROM push_subscriptions WHERE id = ?1", [id])? > 0),
        Outcome::Rejected(_) => {
            c.execute("UPDATE push_subscriptions SET failures = failures + 1 WHERE id = ?1", [id])?;
            Ok(c.execute("DELETE FROM push_subscriptions WHERE id = ?1 AND failures >= ?2", params![id, MAX_FAILURES])? > 0)
        }
        Outcome::Wait(_) | Outcome::Paused | Outcome::Unreachable => Ok(false),
    }
}

/// Sends one message to every subscription and settles each row by the answer.
pub(crate) async fn send_all(hub: Hub, state_dir: PathBuf, message: Message) -> Report {
    let loading = {
        let hub = hub.clone();
        tokio::task::spawn_blocking(move || -> std::result::Result<Option<(Keys, Vec<Target>)>, String> {
            // Nobody subscribed: no key is made and no file is written for it.
            let count: i64 = hub
                .with(|c| c.query_row("SELECT COUNT(*) FROM push_subscriptions", [], |r| r.get(0)))
                .map_err(|error| error.to_string())?;
            if count == 0 {
                return Ok(None);
            }
            let keys = load_keys(&hub, &state_dir)?;
            let targets = hub.with(targets).map_err(|error| error.to_string())?;
            Ok(Some((keys, targets)))
        })
    };
    let (keys, targets) = match loading.await {
        Ok(Ok(Some(loaded))) => loaded,
        Ok(Ok(None)) => return Report::default(),
        Ok(Err(error)) => {
            tracing::warn!(%error, "push notifications unavailable");
            return Report::default();
        }
        Err(error) => {
            tracing::warn!(%error, "push notifications unavailable");
            return Report::default();
        }
    };
    let payload = message.payload();
    let topic = message.topic();
    let subject = subject();
    let outcomes = futures_util::future::join_all(
        targets.iter().map(|target| deliver(&keys, target, &payload, &topic, &subject)),
    )
    .await;

    let mut report = Report::default();
    for outcome in &outcomes {
        match outcome {
            Outcome::Delivered => report.sent += 1,
            Outcome::Wait(_) | Outcome::Paused => {
                report.failed += 1;
                report.waiting += 1;
            }
            _ => report.failed += 1,
        }
    }
    let settled: Vec<(String, Outcome)> = targets.into_iter().map(|target| target.id).zip(outcomes).collect();
    let removed = tokio::task::spawn_blocking(move || {
        hub.with(|c| {
            let mut removed = 0;
            for (id, outcome) in &settled {
                if apply(c, id, *outcome)? {
                    removed += 1;
                }
            }
            Ok(removed)
        })
    })
    .await;
    match removed {
        Ok(Ok(removed)) => report.removed = removed,
        Ok(Err(error)) => tracing::warn!(%error, "could not record push results"),
        Err(error) => tracing::warn!(%error, "could not record push results"),
    }
    report
}

async fn deliver(keys: &Keys, target: &Target, payload: &[u8], topic: &str, subject: &str) -> Outcome {
    let Ok(url) = check_endpoint(&target.endpoint) else { return Outcome::Unusable };
    let origin = url.origin().ascii_serialization();
    // Only the host is ever logged: the rest of the endpoint identifies the device.
    let service = url.host_str().unwrap_or_default().to_owned();
    if paused(&origin) {
        return Outcome::Paused;
    }
    let recipient = keys
        .seal
        .open_sealed(&target.auth)
        .zip(unb64(&target.p256dh))
        .and_then(|(auth, p256dh)| Recipient::new(&p256dh, &auth).ok());
    let Some(recipient) = recipient else { return Outcome::Unusable };
    let Ok(body) = crypto::encrypt(&recipient, payload) else { return Outcome::Unusable };
    let sent = CLIENT
        .post(url)
        .header("Authorization", keys.vapid.authorization(&origin, subject, Utc::now().timestamp()))
        .header("Content-Encoding", "aes128gcm")
        .header("Content-Type", "application/octet-stream")
        .header("TTL", TTL_SECONDS)
        .header("Urgency", "normal")
        .header("Topic", topic)
        .body(body)
        .send()
        .await;
    let response = match sent {
        Ok(response) => response,
        Err(error) => {
            tracing::debug!(error = %error.without_url(), %service, "push service unreachable");
            return Outcome::Unreachable;
        }
    };
    let status = response.status().as_u16();
    let wait = response
        .headers()
        .get("retry-after")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| retry_after(value, Utc::now()));
    let outcome = classify(status, wait);
    match outcome {
        Outcome::Wait(duration) => {
            tracing::info!(%service, seconds = duration.as_secs(), "push service asked for a pause");
            pause(&origin, duration);
        }
        Outcome::Rejected(status) => tracing::warn!(%service, status, "push rejected"),
        _ => {}
    }
    outcome
}

#[cfg(test)]
mod tests;
