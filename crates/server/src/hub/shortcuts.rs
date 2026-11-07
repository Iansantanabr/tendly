//! Shortcuts: a site that opens from the rail, the catalog and Home like an
//! app, with a tile of its own. Kept in `hub.db` (`app_shortcuts`), not in a
//! folder: there is no code, only a name, an address, a letter and a colour.
//!
//! Whether the site lets itself be framed is checked here, on the server, by
//! reading the headers it answers with (`X-Frame-Options` and the
//! `frame-ancestors` of its `Content-Security-Policy`); only the headers are
//! read, never the body, and nothing of the answer is kept but the verdict.
//! The browser opens the site in a pane of the Mesa when it may, and in a tab
//! of its own otherwise, saying why.
use super::cs;
use crate::{ApiError, AppState, Result};
use axum::{
    Json, Router,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
};
use chrono::{SecondsFormat, Utc};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{sync::LazyLock, time::Duration};

const MAX_NAME: usize = 80;
const MAX_URL: usize = 2000;
const MAX_SHORTCUTS: i64 = 200;
/// A verdict older than this is checked again before the site is opened.
pub(crate) const CHECK_FRESH_SECONDS: i64 = 24 * 60 * 60;
const COLUMNS: &str = "id, name, url, letter, color, position, embed, embed_reason, checked_at, created_at, updated_at";

static CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .connect_timeout(Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::limited(5))
        .user_agent("Tendly (shortcut check)")
        .build()
        .expect("http client")
});

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/hub/shortcuts", get(list_route).post(create_route))
        .route("/api/hub/shortcuts/{id}", axum::routing::patch(update_route).delete(delete_route))
        .route("/api/hub/shortcuts/{id}/check", post(check_route))
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

// ---------------------------------------------------------------------------
// What a shortcut is

#[derive(Debug, Clone)]
pub(crate) struct Shortcut {
    pub id: String,
    pub name: String,
    pub url: String,
    pub letter: String,
    pub color: String,
    pub position: i64,
    /// `Some(true)`: the site lets Tendly frame it; `Some(false)`: it refuses; `None`: not known (never checked, or unreachable).
    pub embed: Option<bool>,
    pub embed_reason: Option<String>,
    pub checked_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl Shortcut {
    fn from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: r.get(0)?,
            name: r.get(1)?,
            url: r.get(2)?,
            letter: r.get(3)?,
            color: r.get(4)?,
            position: r.get(5)?,
            embed: r.get::<_, Option<i64>>(6)?.map(|v| v == 1),
            embed_reason: r.get(7)?,
            checked_at: r.get(8)?,
            created_at: r.get(9)?,
            updated_at: r.get(10)?,
        })
    }

    pub(crate) fn view(&self) -> Value {
        json!({
            "id": self.id,
            "name": self.name,
            "url": self.url,
            "letter": self.letter,
            "color": self.color,
            "position": self.position,
            "embed": { "allowed": self.embed, "reason": self.embed_reason, "checked_at": self.checked_at },
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        })
    }
}

/// An address a shortcut may point at: `http` or `https`, with a host and
/// without a user or password in it. Returns it as written, trimmed.
pub(crate) fn valid_url(text: &str) -> std::result::Result<String, String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("The address is required".into());
    }
    if text.chars().count() > MAX_URL {
        return Err(format!("The address must be at most {MAX_URL} characters"));
    }
    let parsed = reqwest::Url::parse(text).map_err(|_| "The address must start with http:// or https://".to_owned())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("The address must start with http:// or https://".into());
    }
    if parsed.host_str().is_none_or(str::is_empty) {
        return Err("The address needs a host, like https://example.com".into());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("The address must not carry a user name or password".into());
    }
    Ok(text.to_owned())
}

fn valid_name(text: &str) -> std::result::Result<String, String> {
    let name = text.trim();
    if name.is_empty() {
        return Err("The name is required".into());
    }
    if name.chars().count() > MAX_NAME {
        return Err(format!("The name must be at most {MAX_NAME} characters"));
    }
    Ok(name.to_owned())
}

fn valid_letter(text: Option<&str>, name: &str) -> std::result::Result<String, String> {
    match text.map(str::trim).filter(|t| !t.is_empty()) {
        Some(letter) if letter.chars().count() > 2 => Err("The letter must be one or two characters".into()),
        Some(letter) => Ok(letter.to_owned()),
        None => Ok(name.chars().next().map(|c| c.to_uppercase().collect()).unwrap_or_default()),
    }
}

fn valid_color(text: Option<&str>, fallback: &str) -> std::result::Result<String, String> {
    match text.map(str::trim).filter(|t| !t.is_empty()) {
        Some(color) => {
            let color = color.to_ascii_lowercase();
            if super::apps::COLORS.iter().any(|(name, _)| *name == color) {
                Ok(color)
            } else {
                let names: Vec<&str> = super::apps::COLORS.iter().map(|(name, _)| *name).collect();
                Err(format!("The colour must be one of: {}", names.join(", ")))
            }
        }
        None => Ok(super::apps::default_color(fallback).to_owned()),
    }
}

// ---------------------------------------------------------------------------
// Whether a site lets Tendly frame it

/// The verdict on a site's headers: `(allowed, reason)`. `None` means it
/// could not be told (the site did not answer).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Verdict {
    Allowed,
    Refused(&'static str),
    Unknown(String),
}

/// Judges the headers a site answered with, for a Tendly page at `origin`
/// (scheme and host, like `https://tendly.example`).
pub(crate) fn judge(xfo: Option<&str>, csp: &[String], origin: &str) -> Verdict {
    if let Some(value) = xfo {
        let value = value.trim().to_ascii_uppercase();
        if value.starts_with("DENY") {
            return Verdict::Refused("x-frame-options-deny");
        }
        if value.starts_with("SAMEORIGIN") {
            // The site is not Tendly's origin, so this says no.
            return Verdict::Refused("x-frame-options-sameorigin");
        }
        if value.starts_with("ALLOW-FROM") {
            // Obsolete and ignored by browsers today, which then let the frame through.
        }
    }
    for policy in csp {
        for directive in policy.split(';') {
            let mut parts = directive.split_whitespace();
            if parts.next().is_none_or(|name| !name.eq_ignore_ascii_case("frame-ancestors")) {
                continue;
            }
            let sources: Vec<String> = parts.map(|s| s.trim_matches('\'').to_ascii_lowercase()).collect();
            if sources.is_empty() || sources.iter().any(|s| s == "none") {
                return Verdict::Refused("frame-ancestors-none");
            }
            let ours = origin.to_ascii_lowercase();
            let (scheme, host) = ours.split_once("://").unwrap_or(("https", ours.as_str()));
            let allowed = sources.iter().any(|source| {
                source == "*"
                    || source == &format!("{scheme}:")
                    || source == &ours
                    || source == host
                    || source.strip_prefix("*.").is_some_and(|tail| host.ends_with(&format!(".{tail}")))
                    || source.strip_prefix(&format!("{scheme}://*.")).is_some_and(|tail| host.ends_with(&format!(".{tail}")))
            });
            return if allowed { Verdict::Allowed } else { Verdict::Refused("frame-ancestors") };
        }
    }
    Verdict::Allowed
}

/// What a refusal means, in words for the person.
pub(crate) fn reason_text(reason: &str) -> &'static str {
    match reason {
        "x-frame-options-deny" | "x-frame-options-sameorigin" => "the site says it must not be shown inside another page (X-Frame-Options)",
        "frame-ancestors-none" | "frame-ancestors" => "the site only lets some pages show it inside theirs (frame-ancestors), and Tendly is not one",
        _ => "the site did not answer, so it opens on its own",
    }
}

/// Asks the site for its headers and judges them. Only the headers are read.
async fn probe(url: &str, origin: &str) -> Verdict {
    let response = match CLIENT.get(url).send().await {
        Ok(response) => response,
        Err(error) => return Verdict::Unknown(error.without_url().to_string()),
    };
    let headers = response.headers();
    let xfo = headers.get("x-frame-options").and_then(|v| v.to_str().ok()).map(str::to_owned);
    let csp: Vec<String> = headers
        .get_all("content-security-policy")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .map(str::to_owned)
        .collect();
    drop(response);
    judge(xfo.as_deref(), &csp, origin)
}

/// The scheme and host the browser reached Tendly at, from its request.
fn origin_of(headers: &HeaderMap) -> String {
    let host = headers.get("host").and_then(|v| v.to_str().ok()).unwrap_or("127.0.0.1").to_owned();
    let https = headers.get("x-forwarded-proto").and_then(|v| v.to_str().ok()).is_some_and(|p| p.eq_ignore_ascii_case("https"));
    format!("{}://{host}", if https { "https" } else { "http" })
}

// ---------------------------------------------------------------------------
// Rows

fn list(c: &Connection) -> rusqlite::Result<Vec<Shortcut>> {
    let mut stmt = c.prepare(&format!("SELECT {COLUMNS} FROM app_shortcuts ORDER BY position, created_at"))?;
    stmt.query_map([], Shortcut::from_row)?.collect()
}

fn load(c: &Connection, id: &str) -> rusqlite::Result<Option<Shortcut>> {
    c.query_row(&format!("SELECT {COLUMNS} FROM app_shortcuts WHERE id = ?1"), [id], Shortcut::from_row).optional()
}

fn store_verdict(c: &Connection, id: &str, verdict: &Verdict) -> rusqlite::Result<()> {
    let (embed, reason): (Option<i64>, Option<String>) = match verdict {
        Verdict::Allowed => (Some(1), None),
        Verdict::Refused(reason) => (Some(0), Some((*reason).to_owned())),
        Verdict::Unknown(detail) => (None, Some(format!("unreachable: {detail}"))),
    };
    c.execute(
        "UPDATE app_shortcuts SET embed = ?2, embed_reason = ?3, checked_at = ?4 WHERE id = ?1",
        params![id, embed, reason, now()],
    )?;
    Ok(())
}

async fn found(state: &AppState, id: String) -> Result<Shortcut> {
    cs(state, move |c| load(c, &id)).await?.ok_or_else(|| ApiError::missing("Shortcut"))
}

// ---------------------------------------------------------------------------
// Routes

async fn list_route(State(state): State<AppState>) -> Result<Json<Value>> {
    let rows = cs(&state, list).await?;
    Ok(Json(json!({ "shortcuts": rows.iter().map(Shortcut::view).collect::<Vec<_>>(), "check_fresh_seconds": CHECK_FRESH_SECONDS })))
}

#[derive(Deserialize)]
struct ShortcutBody {
    name: Option<String>,
    url: Option<String>,
    letter: Option<String>,
    color: Option<String>,
}

async fn create_route(State(state): State<AppState>, headers: HeaderMap, Json(body): Json<ShortcutBody>) -> Result<(StatusCode, Json<Value>)> {
    let name = valid_name(body.name.as_deref().unwrap_or_default()).map_err(ApiError::bad)?;
    let url = valid_url(body.url.as_deref().unwrap_or_default()).map_err(ApiError::bad)?;
    let letter = valid_letter(body.letter.as_deref(), &name).map_err(ApiError::bad)?;
    let color = valid_color(body.color.as_deref(), &name).map_err(ApiError::bad)?;
    let id = uuid::Uuid::new_v4().to_string();
    let (stored_id, at) = (id.clone(), now());
    cs(&state, move |c| {
        let count: i64 = c.query_row("SELECT COUNT(*) FROM app_shortcuts", [], |r| r.get(0))?;
        if count >= MAX_SHORTCUTS {
            return Ok(Err(ApiError::bad(format!("At most {MAX_SHORTCUTS} shortcuts"))));
        }
        let position: i64 = c.query_row("SELECT COALESCE(MAX(position), 0) + 1 FROM app_shortcuts", [], |r| r.get(0))?;
        c.execute(
            "INSERT INTO app_shortcuts(id, name, url, letter, color, position, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
            params![stored_id, name, url, letter, color, position, at],
        )?;
        Ok(Ok(()))
    })
    .await??;
    // The verdict comes with the shortcut when the site answers in time; else it is asked for on opening.
    let origin = origin_of(&headers);
    let shortcut = found(&state, id.clone()).await?;
    let verdict = probe(&shortcut.url, &origin).await;
    let checked = id.clone();
    cs(&state, move |c| store_verdict(c, &checked, &verdict)).await?;
    Ok((StatusCode::CREATED, Json(found(&state, id).await?.view())))
}

async fn update_route(State(state): State<AppState>, Path(id): Path<String>, Json(body): Json<ShortcutBody>) -> Result<Json<Value>> {
    let current = found(&state, id.clone()).await?;
    let name = match body.name.as_deref() {
        Some(text) => valid_name(text).map_err(ApiError::bad)?,
        None => current.name.clone(),
    };
    let url = match body.url.as_deref() {
        Some(text) => valid_url(text).map_err(ApiError::bad)?,
        None => current.url.clone(),
    };
    let letter = match body.letter.as_deref() {
        Some(text) => valid_letter(Some(text), &name).map_err(ApiError::bad)?,
        None => current.letter.clone(),
    };
    let color = match body.color.as_deref() {
        Some(text) => valid_color(Some(text), &name).map_err(ApiError::bad)?,
        None => current.color.clone(),
    };
    let moved = url != current.url;
    let stored = id.clone();
    cs(&state, move |c| {
        c.execute(
            "UPDATE app_shortcuts SET name = ?2, url = ?3, letter = ?4, color = ?5, updated_at = ?6 WHERE id = ?1",
            params![stored, name, url, letter, color, now()],
        )?;
        if moved {
            // Another address: what was known of the old one no longer holds.
            c.execute("UPDATE app_shortcuts SET embed = NULL, embed_reason = NULL, checked_at = NULL WHERE id = ?1", [&stored])?;
        }
        Ok(())
    })
    .await?;
    Ok(Json(found(&state, id).await?.view()))
}

async fn delete_route(State(state): State<AppState>, Path(id): Path<String>) -> Result<StatusCode> {
    let removed = cs(&state, move |c| c.execute("DELETE FROM app_shortcuts WHERE id = ?1", [&id])).await?;
    if removed == 0 {
        return Err(ApiError::missing("Shortcut"));
    }
    Ok(StatusCode::NO_CONTENT)
}

/// Checks the site now and keeps the verdict: `{allowed, reason, checked_at, reason_text}`.
async fn check_route(State(state): State<AppState>, headers: HeaderMap, Path(id): Path<String>) -> Result<Json<Value>> {
    let shortcut = found(&state, id.clone()).await?;
    let verdict = probe(&shortcut.url, &origin_of(&headers)).await;
    let stored = id.clone();
    cs(&state, move |c| store_verdict(c, &stored, &verdict)).await?;
    let fresh = found(&state, id).await?;
    let mut view = fresh.view();
    view["embed"]["reason_text"] = match fresh.embed_reason.as_deref() {
        Some(reason) if fresh.embed == Some(false) => json!(reason_text(reason)),
        Some(_) => json!(reason_text("unreachable")),
        None => Value::Null,
    };
    Ok(Json(view))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hub_shortcuts_urls_are_http_or_https_without_credentials() {
        assert_eq!(valid_url(" https://example.com/a?b=1 ").unwrap(), "https://example.com/a?b=1");
        assert_eq!(valid_url("http://localhost:3000").unwrap(), "http://localhost:3000");
        for bad in ["", "example.com", "ftp://x.y", "javascript:alert(1)", "https://user:pw@example.com", "https://", "file:///etc/passwd"] {
            assert!(valid_url(bad).is_err(), "{bad}");
        }
        assert!(valid_url(&format!("https://x.y/{}", "a".repeat(MAX_URL))).is_err());
    }

    #[test]
    fn hub_shortcuts_name_letter_and_colour_follow_the_apps_rules() {
        assert_eq!(valid_name("  Notion ").unwrap(), "Notion");
        assert!(valid_name(" ").is_err());
        assert_eq!(valid_letter(None, "notion").unwrap(), "N");
        assert_eq!(valid_letter(Some("No"), "x").unwrap(), "No");
        assert!(valid_letter(Some("Not"), "x").is_err());
        assert_eq!(valid_color(Some("Teal"), "x").unwrap(), "teal");
        assert!(valid_color(Some("pink"), "x").is_err());
        assert_eq!(valid_color(None, "notion").unwrap(), valid_color(None, "notion").unwrap(), "stable per name");
    }

    #[test]
    fn hub_shortcuts_judge_headers_for_framing() {
        let origin = "https://tendly.example";
        let csp = |text: &str| vec![text.to_owned()];
        assert_eq!(judge(None, &[], origin), Verdict::Allowed);
        assert_eq!(judge(Some("DENY"), &[], origin), Verdict::Refused("x-frame-options-deny"));
        assert_eq!(judge(Some(" sameorigin "), &[], origin), Verdict::Refused("x-frame-options-sameorigin"));
        assert_eq!(judge(Some("ALLOW-FROM https://a.b"), &[], origin), Verdict::Allowed, "obsolete, ignored by browsers");
        assert_eq!(judge(None, &csp("default-src 'self'; frame-ancestors 'none'"), origin), Verdict::Refused("frame-ancestors-none"));
        assert_eq!(judge(None, &csp("frame-ancestors 'self'"), origin), Verdict::Refused("frame-ancestors"));
        assert_eq!(judge(None, &csp("frame-ancestors *"), origin), Verdict::Allowed);
        assert_eq!(judge(None, &csp("frame-ancestors https:"), origin), Verdict::Allowed);
        assert_eq!(judge(None, &csp("frame-ancestors https:"), "http://127.0.0.1:28789"), Verdict::Refused("frame-ancestors"));
        assert_eq!(judge(None, &csp("frame-ancestors https://other.example https://tendly.example"), origin), Verdict::Allowed);
        assert_eq!(judge(None, &csp("frame-ancestors *.example"), origin), Verdict::Allowed);
        assert_eq!(judge(None, &csp("frame-ancestors https://*.example"), origin), Verdict::Allowed);
        assert_eq!(judge(None, &csp("frame-ancestors"), origin), Verdict::Refused("frame-ancestors-none"), "an empty list allows nothing");
        assert_eq!(judge(None, &csp("default-src 'self'"), origin), Verdict::Allowed, "no frame-ancestors: no limit");
        // The first policy that speaks decides; X-Frame-Options first.
        assert_eq!(judge(Some("DENY"), &csp("frame-ancestors *"), origin), Verdict::Refused("x-frame-options-deny"));
        assert_eq!(judge(None, &["img-src *".to_owned(), "frame-ancestors 'none'".to_owned()], origin), Verdict::Refused("frame-ancestors-none"));
    }

    #[test]
    fn hub_shortcuts_origin_follows_the_proxy() {
        let mut headers = HeaderMap::new();
        headers.insert("host", "tendly.example".parse().unwrap());
        assert_eq!(origin_of(&headers), "http://tendly.example");
        headers.insert("x-forwarded-proto", "https".parse().unwrap());
        assert_eq!(origin_of(&headers), "https://tendly.example");
    }
}
