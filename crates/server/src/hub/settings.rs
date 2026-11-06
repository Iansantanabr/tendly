//! The fork's own settings, a small key/value table in `hub.db`:
//!
//! - `timezone`: the IANA zone automations run in when they name none. A VPS
//!   clock is in UTC, so "every day at 9" must not follow the machine. The
//!   first start records the zone of the machine it runs on (the Mac's), unless
//!   that is UTC or cannot be read, in which case it is `America/Sao_Paulo`.
//!   From then on only the person changes it, so it travels with `hub.db`.
//! - `public_base_url`: `https://pub.example.com`, the address published links
//!   are shown with instead of whatever address the browser happens to use.
//!   Empty means "this server's own address".
//! - `dictation`: `browser` (the Web Speech API) or `off` (no microphone button).
//!
//! `GET /api/hub/settings` returns all three; `PUT` takes any of them and
//! changes nothing unless every value sent is valid.
use super::{HubStore, cs};
use crate::{ApiError, AppState, Result};
use axum::{Json, Router, extract::State, routing::get};
use chrono_tz::Tz;
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use serde_json::{Map, Value, json};
use std::path::Path;

pub(crate) const DEFAULT_TIMEZONE: &str = "America/Sao_Paulo";
const DEFAULT_DICTATION: &str = "browser";
const MAX_URL: usize = 200;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/hub/settings", get(get_route).put(put_route))
        .route("/api/hub/settings/timezones", get(zones_route))
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub(crate) struct Settings {
    pub timezone: String,
    pub public_base_url: String,
    pub dictation: String,
}

// ---------------------------------------------------------------------------
// Storage

fn stored(c: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    c.query_row("SELECT value FROM hub_settings WHERE key = ?1", [key], |row| row.get(0))
        .optional()
}

fn store(c: &Connection, key: &str, value: &str) -> rusqlite::Result<usize> {
    c.execute(
        "INSERT INTO hub_settings(key, value, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        params![key, value, chrono::Utc::now().to_rfc3339()],
    )
}

/// Every setting, with the default where nothing (or nothing usable) is stored.
pub(crate) fn load(c: &Connection) -> rusqlite::Result<Settings> {
    Ok(Settings {
        timezone: timezone(c)?.name().to_owned(),
        public_base_url: stored(c, "public_base_url")?
            .and_then(|value| check_base_url(&value).ok())
            .unwrap_or_default(),
        dictation: stored(c, "dictation")?
            .filter(|value| check_dictation(value).is_ok())
            .unwrap_or_else(|| DEFAULT_DICTATION.to_owned()),
    })
}

/// The zone automations without one of their own run in. Never the machine's.
pub(crate) fn timezone(c: &Connection) -> rusqlite::Result<Tz> {
    Ok(stored(c, "timezone")?
        .and_then(|name| name.parse::<Tz>().ok())
        .unwrap_or_else(default_zone))
}

fn default_zone() -> Tz {
    DEFAULT_TIMEZONE.parse().expect("the default time zone exists")
}

/// The base published links are shown with, when one is set.
pub(crate) fn public_base_url(c: &Connection) -> rusqlite::Result<Option<String>> {
    Ok(Some(load(c)?.public_base_url).filter(|base| !base.is_empty()))
}

/// `base` + a path on this server (`/p/<slug>`): the address to share.
pub(crate) fn absolute(base: &str, path: &str) -> String {
    format!("{}/{}", base.trim_end_matches('/'), path.trim_start_matches('/'))
}

// ---------------------------------------------------------------------------
// Validation

fn check_timezone(text: &str) -> std::result::Result<String, String> {
    let name = text.trim();
    name.parse::<Tz>().map(|zone| zone.name().to_owned()).map_err(|_| {
        format!("Unknown time zone \"{name}\"; use an IANA name such as {DEFAULT_TIMEZONE}")
    })
}

fn check_base_url(text: &str) -> std::result::Result<String, String> {
    let text = text.trim();
    if text.is_empty() {
        return Ok(String::new());
    }
    let refuse = |why: &str| {
        Err(format!(
            "{why}. Use an https address with only the domain, such as https://pub.example.com, or leave it empty"
        ))
    };
    if text.len() > MAX_URL {
        return refuse("That address is too long");
    }
    let Ok(url) = url::Url::parse(text) else {
        return refuse("That is not an address");
    };
    if url.scheme() != "https" {
        return refuse("The address has to start with https://");
    }
    if url.host_str().is_none_or(str::is_empty) {
        return refuse("The address has no domain");
    }
    if !url.username().is_empty() || url.password().is_some() {
        return refuse("The address cannot carry a user name or password");
    }
    if !matches!(url.path(), "" | "/") || url.query().is_some() || url.fragment().is_some() {
        return refuse("The address cannot have a path, a query or a fragment: links are always <address>/p/<name>");
    }
    Ok(url.origin().ascii_serialization())
}

fn check_dictation(text: &str) -> std::result::Result<String, String> {
    match text.trim() {
        value @ ("browser" | "off") => Ok(value.to_owned()),
        other => Err(format!("Dictation is \"browser\" or \"off\", not \"{other}\"")),
    }
}

/// The valid form of every setting in `patch`, or the first problem. Nothing
/// is written here, so a request with one bad value changes nothing.
fn checked(patch: &Map<String, Value>) -> std::result::Result<Vec<(&'static str, String)>, String> {
    if patch.is_empty() {
        return Err("Send at least one of: timezone, public_base_url, dictation".into());
    }
    patch
        .iter()
        .map(|(key, value)| {
            let (key, check): (&'static str, fn(&str) -> std::result::Result<String, String>) = match key.as_str() {
                "timezone" => ("timezone", check_timezone),
                "public_base_url" => ("public_base_url", check_base_url),
                "dictation" => ("dictation", check_dictation),
                other => return Err(format!("Unknown setting \"{other}\"; there are timezone, public_base_url and dictation")),
            };
            let text = value.as_str().ok_or_else(|| format!("{key} must be a string"))?;
            Ok((key, check(text)?))
        })
        .collect()
}

// ---------------------------------------------------------------------------
// The machine's own zone, asked once

/// Zones that say "nobody chose this": a server's clock, not a person's.
fn is_utc_like(zone: Tz) -> bool {
    let name = zone.name();
    name.starts_with("Etc/")
        || matches!(name, "UTC" | "UCT" | "GMT" | "GMT0" | "GMT+0" | "GMT-0" | "Greenwich" | "Universal" | "Zulu")
}

/// The IANA zone a machine is set to, from what Unix systems offer: `TZ`,
/// where `/etc/localtime` points, or Debian's `/etc/timezone`.
fn zone_from(tz_variable: Option<&str>, localtime_link: Option<&Path>, timezone_file: Option<&str>) -> Option<Tz> {
    let from_variable = tz_variable.and_then(|value| value.trim().trim_start_matches(':').parse::<Tz>().ok());
    let from_link = || {
        let target = localtime_link?.to_string_lossy().into_owned();
        let (_, name) = target.rsplit_once("zoneinfo/")?;
        name.parse::<Tz>().ok()
    };
    let from_file = || timezone_file?.trim().parse::<Tz>().ok();
    from_variable.or_else(from_link).or_else(from_file)
}

fn machine_zone() -> Option<Tz> {
    zone_from(
        std::env::var("TZ").ok().as_deref(),
        std::fs::read_link("/etc/localtime").ok().as_deref(),
        std::fs::read_to_string("/etc/timezone").ok().as_deref(),
    )
}

/// What a first start records: the machine's zone when a person chose it.
fn initial_timezone(machine: Option<Tz>) -> &'static str {
    machine.filter(|zone| !is_utc_like(*zone)).map_or(DEFAULT_TIMEZONE, |zone| zone.name())
}

fn remember_timezone(hub: &HubStore, machine: Option<Tz>) -> rusqlite::Result<()> {
    hub.with(|c| {
        c.execute(
            "INSERT OR IGNORE INTO hub_settings(key, value, updated_at) VALUES ('timezone', ?1, ?2)",
            params![initial_timezone(machine), chrono::Utc::now().to_rfc3339()],
        )
    })
    .map(|_| ())
}

/// Called once at startup: writes the time zone down the first time, so it
/// stays the person's when `hub.db` moves to a machine whose clock is in UTC.
pub(crate) fn ensure_defaults(hub: &HubStore) {
    if let Err(error) = remember_timezone(hub, machine_zone()) {
        tracing::warn!(%error, "could not record the default time zone");
    }
}

// ---------------------------------------------------------------------------
// Routes

async fn get_route(State(state): State<AppState>) -> Result<Json<Settings>> {
    Ok(Json(cs(&state, load).await?))
}

async fn put_route(State(state): State<AppState>, Json(body): Json<Value>) -> Result<Json<Settings>> {
    let Value::Object(patch) = body else {
        return Err(ApiError::bad("Send a JSON object such as {\"timezone\": \"America/Sao_Paulo\"}"));
    };
    let changes = checked(&patch).map_err(ApiError::bad)?;
    Ok(Json(
        cs(&state, move |c| {
            let tx = c.unchecked_transaction()?;
            for (key, value) in &changes {
                store(&tx, key, value)?;
            }
            let settings = load(&tx)?;
            tx.commit()?;
            Ok(settings)
        })
        .await?,
    ))
}

/// Every zone the server accepts, for the picker, and the machine's own.
async fn zones_route() -> Json<Value> {
    let zones: Vec<&str> = chrono_tz::TZ_VARIANTS.iter().map(|zone| zone.name()).collect();
    Json(json!({ "zones": zones, "server": machine_zone().map(|zone| zone.name()) }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{accounts, activity, agent, conversations, file_watch, security, worktree_setup};
    use axum::{
        body::to_bytes,
        http::{Request as HttpRequest, StatusCode},
    };
    use std::{path::PathBuf, sync::Arc};
    use tower::ServiceExt;

    const HOST: &str = "127.0.0.1:8787";
    const TOKEN: &str = "team-token";

    fn object(value: Value) -> Map<String, Value> {
        value.as_object().unwrap().clone()
    }

    #[test]
    fn hub_settings_have_defaults_and_survive_a_bad_row() {
        let hub = HubStore::memory();
        hub.with(|c| {
            assert_eq!(
                load(c)?,
                Settings { timezone: DEFAULT_TIMEZONE.into(), public_base_url: String::new(), dictation: "browser".into() }
            );
            assert_eq!(public_base_url(c)?, None);
            store(c, "timezone", "Asia/Tokyo")?;
            store(c, "public_base_url", "https://pub.example.com")?;
            store(c, "dictation", "off")?;
            assert_eq!(timezone(c)?, chrono_tz::Asia::Tokyo);
            assert_eq!(public_base_url(c)?.as_deref(), Some("https://pub.example.com"));
            assert_eq!(load(c)?.dictation, "off");
            // Rows a hand edit (or an older build) left unusable fall back.
            store(c, "timezone", "Mars/Olympus")?;
            store(c, "public_base_url", "http://plain.example.com")?;
            store(c, "dictation", "whisper")?;
            assert_eq!(
                load(c)?,
                Settings { timezone: DEFAULT_TIMEZONE.into(), public_base_url: String::new(), dictation: "browser".into() }
            );
            let rows: i64 = c.query_row("SELECT count(*) FROM hub_settings", [], |r| r.get(0))?;
            assert_eq!(rows, 3, "one row per key, replaced in place");
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn hub_settings_validate_each_value() {
        assert_eq!(check_timezone(" America/Sao_Paulo ").unwrap(), "America/Sao_Paulo");
        assert_eq!(check_timezone("UTC").unwrap(), "UTC");
        for bad in ["", "Mars/Olympus", "america/sao_paulo x", "-03:00", "BRT"] {
            let error = check_timezone(bad).expect_err(bad);
            assert!(error.contains("IANA"), "{bad}: {error}");
        }

        assert_eq!(check_base_url("").unwrap(), "");
        assert_eq!(check_base_url("   ").unwrap(), "");
        assert_eq!(check_base_url("https://pub.example.com").unwrap(), "https://pub.example.com");
        assert_eq!(check_base_url(" https://Pub.Example.com/ ").unwrap(), "https://pub.example.com");
        assert_eq!(check_base_url("https://pub.example.com:443").unwrap(), "https://pub.example.com");
        assert_eq!(check_base_url("https://pub.example.com:8443").unwrap(), "https://pub.example.com:8443");
        for bad in [
            "pub.example.com",
            "http://pub.example.com",
            "ftp://pub.example.com",
            "https://",
            "https://user:secret@pub.example.com",
            "https://user@pub.example.com",
            "https://pub.example.com/p",
            "https://pub.example.com/?a=1",
            "https://pub.example.com/#top",
            "javascript:alert(1)",
        ] {
            let error = check_base_url(bad).expect_err(bad);
            assert!(error.contains("https://pub.example.com"), "{bad}: {error}");
        }
        assert!(check_base_url(&format!("https://{}.example.com", "a".repeat(MAX_URL))).is_err());

        assert_eq!(check_dictation("browser").unwrap(), "browser");
        assert_eq!(check_dictation("off").unwrap(), "off");
        assert!(check_dictation("on").is_err());
        assert!(check_dictation("").is_err());
    }

    #[test]
    fn hub_settings_patches_are_all_or_nothing() {
        let ok = checked(&object(json!({ "timezone": "Europe/Lisbon", "dictation": "off" }))).unwrap();
        assert!(ok.contains(&("timezone", "Europe/Lisbon".into())) && ok.contains(&("dictation", "off".into())));
        assert!(checked(&object(json!({}))).is_err());
        assert!(checked(&object(json!({ "timezone": "Europe/Lisbon", "dictation": "loud" }))).is_err());
        assert!(checked(&object(json!({ "theme": "dark" }))).unwrap_err().contains("Unknown setting"));
        assert!(checked(&object(json!({ "dictation": true }))).unwrap_err().contains("must be a string"));
        assert!(checked(&object(json!({ "timezone": null }))).is_err());
    }

    #[test]
    fn hub_settings_links_join_the_base_and_the_path() {
        assert_eq!(absolute("https://pub.example.com", "/p/report-ab12"), "https://pub.example.com/p/report-ab12");
        assert_eq!(absolute("https://pub.example.com/", "p/report-ab12"), "https://pub.example.com/p/report-ab12");
    }

    #[test]
    fn hub_settings_read_the_machine_zone_from_what_unix_offers() {
        let mac = Path::new("/var/db/timezone/zoneinfo/America/Sao_Paulo");
        let linux = Path::new("/usr/share/zoneinfo/Etc/UTC");
        assert_eq!(zone_from(None, Some(mac), None), Some(chrono_tz::America::Sao_Paulo));
        assert_eq!(zone_from(None, Some(linux), None), Some(chrono_tz::Etc::UTC));
        // TZ wins, in either spelling; one that is not a zone name is skipped.
        assert_eq!(zone_from(Some("Europe/Lisbon"), Some(mac), None), Some(chrono_tz::Europe::Lisbon));
        assert_eq!(zone_from(Some(":Asia/Tokyo"), None, None), Some(chrono_tz::Asia::Tokyo));
        assert_eq!(zone_from(Some("BRT3"), Some(mac), None), Some(chrono_tz::America::Sao_Paulo));
        assert_eq!(zone_from(None, Some(Path::new("/somewhere/else")), Some("America/Bahia\n")), Some(chrono_tz::America::Bahia));
        assert_eq!(zone_from(None, None, None), None);
    }

    #[test]
    fn hub_settings_first_start_keeps_a_persons_zone_and_never_a_servers() {
        assert_eq!(initial_timezone(Some(chrono_tz::America::Bahia)), "America/Bahia");
        assert_eq!(initial_timezone(Some(chrono_tz::Europe::London)), "Europe/London");
        // A VPS: its clock is in UTC because nobody set it, not because the person lives there.
        for server in [chrono_tz::UTC, chrono_tz::Etc::UTC, chrono_tz::GMT, chrono_tz::Etc::GMTPlus3, chrono_tz::Zulu] {
            assert_eq!(initial_timezone(Some(server)), DEFAULT_TIMEZONE, "{server}");
        }
        assert_eq!(initial_timezone(None), DEFAULT_TIMEZONE);

        // Written once: a later start on another machine does not replace it.
        let hub = HubStore::memory();
        remember_timezone(&hub, Some(chrono_tz::America::Bahia)).unwrap();
        remember_timezone(&hub, Some(chrono_tz::Etc::UTC)).unwrap();
        remember_timezone(&hub, Some(chrono_tz::Asia::Tokyo)).unwrap();
        assert_eq!(hub.with(timezone).unwrap(), chrono_tz::America::Bahia);
        // Nor what the person chose.
        hub.with(|c| store(c, "timezone", "Europe/Lisbon")).unwrap();
        remember_timezone(&hub, Some(chrono_tz::America::Bahia)).unwrap();
        assert_eq!(hub.with(timezone).unwrap(), chrono_tz::Europe::Lisbon);
        // A fresh database on a VPS.
        let vps = HubStore::memory();
        remember_timezone(&vps, Some(chrono_tz::Etc::UTC)).unwrap();
        assert_eq!(vps.with(|c| stored(c, "timezone")).unwrap().as_deref(), Some(DEFAULT_TIMEZONE));
    }

    struct Fixture {
        state: AppState,
        dir: PathBuf,
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    /// A server that needs `TOKEN`, as the VPS does.
    fn fixture() -> Fixture {
        let dir = std::env::temp_dir().join(format!("hub-settings-api-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let root = dunce::canonicalize(&dir).unwrap();
        let state = AppState {
            store: Arc::new(tendly_persistence::Store::open(":memory:").unwrap()),
            runtime: tendly_runtime::RuntimeManager::new(),
            state_dir: dir.join("state"),
            roots: crate::host_roots::HostRoots::fixed(vec![root.clone()], vec![root]),
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
            hub: Arc::new(HubStore::memory()),
        };
        Fixture { state, dir }
    }

    impl Fixture {
        async fn send(&self, method: &str, path: &str, headers: &[(&str, &str)], body: &str) -> (StatusCode, Value) {
            let mut request = HttpRequest::builder().method(method).uri(path).header("host", HOST);
            for (name, value) in headers {
                request = request.header(*name, *value);
            }
            let response = crate::router(self.state.clone())
                .oneshot(request.body(axum::body::Body::from(body.to_owned())).unwrap())
                .await
                .unwrap();
            let status = response.status();
            let bytes = to_bytes(response.into_body(), 1 << 20).await.unwrap();
            (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
        }
        async fn api(&self, method: &str, path: &str, body: Value) -> (StatusCode, Value) {
            let bearer = format!("Bearer {TOKEN}");
            let headers = [("authorization", bearer.as_str()), ("x-tendly-client", "web"), ("content-type", "application/json")];
            self.send(method, path, &headers, &body.to_string()).await
        }
    }

    #[tokio::test]
    async fn hub_settings_api_reads_changes_and_refuses_bad_values() {
        let f = fixture();
        let (status, body) = f.api("GET", "/api/hub/settings", Value::Null).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, json!({ "timezone": DEFAULT_TIMEZONE, "public_base_url": "", "dictation": "browser" }));

        let (status, body) = f.api("PUT", "/api/hub/settings", json!({ "timezone": "Europe/Lisbon" })).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, json!({ "timezone": "Europe/Lisbon", "public_base_url": "", "dictation": "browser" }));

        let (status, body) = f
            .api("PUT", "/api/hub/settings", json!({ "public_base_url": "https://Pub.Example.com/", "dictation": "off" }))
            .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, json!({ "timezone": "Europe/Lisbon", "public_base_url": "https://pub.example.com", "dictation": "off" }));

        // One bad value: nothing in the request is applied.
        let (status, body) = f
            .api("PUT", "/api/hub/settings", json!({ "dictation": "browser", "timezone": "Mars/Olympus" }))
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(body["error"].as_str().unwrap().contains("Mars/Olympus"), "{body}");
        for bad in [
            json!({ "public_base_url": "http://pub.example.com" }),
            json!({ "theme": "dark" }),
            json!({ "dictation": false }),
            json!({}),
            json!(["timezone"]),
        ] {
            let (status, _) = f.api("PUT", "/api/hub/settings", bad.clone()).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{bad}");
        }
        let (_, body) = f.api("GET", "/api/hub/settings", Value::Null).await;
        assert_eq!(body, json!({ "timezone": "Europe/Lisbon", "public_base_url": "https://pub.example.com", "dictation": "off" }));

        // Emptying the address goes back to this server's own.
        let (status, body) = f.api("PUT", "/api/hub/settings", json!({ "public_base_url": "" })).await;
        assert_eq!((status, body["public_base_url"].as_str()), (StatusCode::OK, Some("")));
    }

    #[tokio::test]
    async fn hub_settings_api_needs_the_token_and_the_web_header() {
        let f = fixture();
        let (status, _) = f.send("GET", "/api/hub/settings", &[], "").await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        let (status, _) = f
            .send("PUT", "/api/hub/settings", &[("content-type", "application/json")], r#"{"dictation":"off"}"#)
            .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        let bearer = format!("Bearer {TOKEN}");
        let (status, _) = f
            .send(
                "PUT",
                "/api/hub/settings",
                &[("authorization", bearer.as_str()), ("content-type", "application/json")],
                r#"{"dictation":"off"}"#,
            )
            .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "a mutation without X-Tendly-Client: web");
        let (_, body) = f.api("GET", "/api/hub/settings", Value::Null).await;
        assert_eq!(body["dictation"], "browser");
    }

    #[tokio::test]
    async fn hub_settings_api_lists_the_zones_it_accepts() {
        let f = fixture();
        let (status, body) = f.api("GET", "/api/hub/settings/timezones", Value::Null).await;
        assert_eq!(status, StatusCode::OK);
        let zones: Vec<&str> = body["zones"].as_array().unwrap().iter().map(|zone| zone.as_str().unwrap()).collect();
        assert!(zones.len() > 400, "{}", zones.len());
        for expected in ["America/Sao_Paulo", "America/Bahia", "Europe/Lisbon", "UTC"] {
            assert!(zones.contains(&expected), "{expected}");
        }
        // Whatever the list offers, the server takes.
        for zone in &zones {
            assert!(check_timezone(zone).is_ok(), "{zone}");
        }
        assert!(body["server"].is_string() || body["server"].is_null());
    }
}
