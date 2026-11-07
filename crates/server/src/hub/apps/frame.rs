//! Where an app runs: a frame that is not Tendly.
//!
//! An app is code an agent wrote, and it may load scripts from a CDN. Served
//! from Tendly's own origin it could call the whole API as the person. So an
//! app's files are served from an address of their own,
//!
//! ```text
//! /apps-run/<workspace id>/<slug>/<token>/<path inside the app folder>
//! ```
//!
//! with a CSP `sandbox` that has no `allow-same-origin`: whatever loads that
//! page (the frame Tendly draws, a tab, a link someone followed) gets a
//! document with an opaque origin. From there a request to `/api/...` is
//! cross-site, carries no cookie and is refused by the guard, and nothing of
//! Tendly's page can be read or scripted. The app talks to Tendly only through
//! `postMessage` (`sdk.js`), and the page that frames it decides what to do.
//!
//! The token is the whole credential for that address, which is why the guard
//! lets these requests in without an origin or a session (`is_frame_request`):
//! `<expiry>.<HMAC-SHA256>` over the workspace, the slug and the expiry, signed
//! with a secret kept in `hub.db`. It opens the files of that one app (never
//! `data/`, dot-files or anything outside the folder, the same rules as
//! always), for a few hours. The page that frames the app asks for a new token
//! each time it loads the frame and renews the one in use while the frame
//! stays open; renewals live in memory, so after a restart an old frame is
//! loaded again. Every refusal is the same bare 404.
use super::{Found, clean_path, encode_segment, find, not_found, serve_app_file, valid_slug};
use crate::{ApiError, AppState, Result, hub::cs};
use axum::{
    Json, Router,
    extract::{Path as UrlPath, Request, State},
    http::{HeaderValue, Method, StatusCode, header},
    response::{IntoResponse, Redirect, Response},
    routing::{get, post},
};
use chrono::{TimeZone, Utc};
use rusqlite::{Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
};
use tendly_domain::WorkspaceId;

/// How long a token opens an app's files, and how much longer each renewal gives.
pub(crate) const TTL_SECONDS: i64 = 8 * 60 * 60;
/// The page that frames an app renews its token this often.
const RENEW_SECONDS: i64 = 30 * 60;
pub(crate) const PREFIX: &str = "/apps-run/";
/// The static files every app page may load without a token: the SDK and the kit.
const SHARED_PATHS: &[&str] = &["/api/hub/apps/sdk.js", "/api/hub/apps/kit.js", "/api/hub/apps/kit.css", "/api/hub/apps/kit-demo.html"];
/// No `allow-same-origin`: the document has an origin of its own, shared with nothing.
pub(crate) const POLICY: &str =
    "sandbox allow-scripts allow-forms allow-modals allow-downloads allow-popups; frame-ancestors 'self'";

/// Asked by the guard (`security.rs`): a request an app frame makes for its own
/// files or for the SDK. Such a frame has no origin and no session, so these
/// reads are let in on the token in their path (the SDK and the kit are the
/// same static files for everyone). Only reads, and only these places.
pub(crate) fn is_frame_request(method: &Method, path: &str) -> bool {
    matches!(*method, Method::GET | Method::HEAD) && (SHARED_PATHS.contains(&path) || path.starts_with(PREFIX))
}

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/hub/apps/{workspace_id}/{slug}/frame", get(frame_route))
        .route("/api/hub/apps/{workspace_id}/{slug}/frame/renew", post(renew_route))
        .route("/apps-run/{*rest}", get(run_route))
}

// ---------------------------------------------------------------------------
// Tokens

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn equal(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |n, (x, y)| n | (x ^ y)) == 0
}

fn mac(secret: &str, workspace: &str, slug: &str, expires: i64) -> String {
    let message = format!("tendly app frame v1\n{workspace}\n{slug}\n{expires}");
    hex(&crate::hub::publish::hmac_sha256(secret.as_bytes(), message.as_bytes()))
}

/// The token that opens `apps/<slug>/` of `workspace` until `expires` (Unix seconds).
pub(crate) fn sign(secret: &str, workspace: &str, slug: &str, expires: i64) -> String {
    format!("{expires}.{}", mac(secret, workspace, slug, expires))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Token {
    Valid,
    /// Signed by this server for this app, but past its time.
    Lapsed,
    /// Anything else: another app's, another server's, made up.
    Forged,
}

/// `extended`: until when a renewal keeps this token (see `Frames`).
pub(crate) fn check(secret: &str, workspace: &str, slug: &str, token: &str, now: i64, extended: Option<i64>) -> Token {
    let Some((written, given)) = token.split_once('.') else { return Token::Forged };
    let Ok(expires) = written.parse::<i64>() else { return Token::Forged };
    // One spelling per token: "+12" or "012" is not what was signed.
    if expires.to_string() != written || !equal(&mac(secret, workspace, slug, expires), given) {
        return Token::Forged;
    }
    if expires > now || extended.is_some_and(|until| until > now) { Token::Valid } else { Token::Lapsed }
}

/// What this server remembers of app frames, in memory: the signing secret
/// (read once from `hub.db`) and the tokens a page asked to keep alive.
#[derive(Default)]
pub(crate) struct Frames {
    secret: OnceLock<String>,
    /// Token → until when (Unix seconds).
    extended: Mutex<HashMap<String, i64>>,
}

impl Frames {
    fn until(&self, token: &str) -> Option<i64> {
        self.extended.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).get(token).copied()
    }

    fn extend(&self, token: &str, until: i64, now: i64) {
        let mut extended = self.extended.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        extended.retain(|_, kept| *kept > now);
        extended.insert(token.to_owned(), until);
    }
}

/// The secret tokens are signed with, made on first use and kept in hub.db.
fn stored_secret(c: &Connection) -> rusqlite::Result<String> {
    if let Some(found) = c
        .query_row("SELECT secret FROM app_frame_secret WHERE id = 1", [], |r| r.get(0))
        .optional()?
    {
        return Ok(found);
    }
    let fresh = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
    c.execute("INSERT OR IGNORE INTO app_frame_secret(id, secret) VALUES (1, ?1)", [&fresh])?;
    c.query_row("SELECT secret FROM app_frame_secret WHERE id = 1", [], |r| r.get(0))
}

async fn secret(state: &AppState) -> Result<String> {
    if let Some(known) = state.hub.app_frames.secret.get() {
        return Ok(known.clone());
    }
    let read = cs(state, stored_secret).await?;
    Ok(state.hub.app_frames.secret.get_or_init(|| read).clone())
}

fn now() -> i64 {
    Utc::now().timestamp()
}

fn rfc3339(seconds: i64) -> String {
    Utc.timestamp_opt(seconds, 0).single().map(|at| at.to_rfc3339()).unwrap_or_default()
}

/// The folder an app's files are served from with `token`, ending in `/`.
pub(crate) fn base(workspace: &str, slug: &str, token: &str) -> String {
    format!("{PREFIX}{workspace}/{slug}/{token}/")
}

fn encoded(path: &str) -> String {
    path.split('/').map(encode_segment).collect::<Vec<_>>().join("/")
}

/// A fresh address for the app's files: `(base, expiry)`.
pub(super) async fn issue(state: &AppState, found: &Found) -> Result<(String, i64)> {
    let workspace = found.workspace.id.to_string();
    let expires = now() + TTL_SECONDS;
    let token = sign(&secret(state).await?, &workspace, &found.slug, expires);
    Ok((base(&workspace, &found.slug, &token), expires))
}

// ---------------------------------------------------------------------------
// Routes

/// For the page that frames the app: where to load it from, for now.
async fn frame_route(
    State(state): State<AppState>,
    UrlPath((workspace, slug)): UrlPath<(String, String)>,
) -> Result<Json<Value>> {
    let found = find(&state, &workspace, &slug).await?;
    let (base, expires) = issue(&state, &found).await?;
    let token = base.trim_end_matches('/').rsplit('/').next().unwrap_or_default().to_owned();
    Ok(Json(json!({
        "base": base,
        "url": format!("{base}{}", encoded(&found.app.manifest.entry)),
        "token": token,
        "expires_at": rfc3339(expires),
        "renew_after_seconds": RENEW_SECONDS,
    })))
}

#[derive(Deserialize)]
struct RenewBody {
    token: String,
}

/// Keeps the token of a frame that is still open. A token that already lapsed
/// (the machine slept, the server restarted) is gone: the page loads the app again.
async fn renew_route(
    State(state): State<AppState>,
    UrlPath((workspace, slug)): UrlPath<(String, String)>,
    Json(body): Json<RenewBody>,
) -> Result<Json<Value>> {
    let found = find(&state, &workspace, &slug).await?;
    let (secret, at) = (secret(&state).await?, now());
    let frames = &state.hub.app_frames;
    let token = body.token.trim();
    match check(&secret, &found.workspace.id.to_string(), &found.slug, token, at, frames.until(token)) {
        Token::Valid => {
            let until = at + TTL_SECONDS;
            frames.extend(token, until, at);
            Ok(Json(json!({ "expires_at": rfc3339(until), "renew_after_seconds": RENEW_SECONDS })))
        }
        Token::Lapsed => Err(ApiError { status: StatusCode::GONE, message: "This app frame expired; load the app again".into() }),
        Token::Forged => Err(ApiError::missing("App frame")),
    }
}

/// `/apps-run/<workspace>/<slug>/<token>/<path>`: a file of that app, to whoever holds the token.
async fn run_route(State(state): State<AppState>, UrlPath(rest): UrlPath<String>, request: Request) -> Response {
    let mut parts = rest.splitn(4, '/');
    let (Some(workspace), Some(slug), Some(token)) = (parts.next(), parts.next(), parts.next()) else {
        return not_found();
    };
    let path = parts.next().unwrap_or_default();
    // The token is judged before anything is looked up, so a wrong one learns nothing about what exists.
    let Ok(id) = workspace.parse::<WorkspaceId>() else { return not_found() };
    if !valid_slug(slug) {
        return not_found();
    }
    let Ok(secret) = secret(&state).await else { return not_found() };
    let workspace = id.to_string();
    if check(&secret, &workspace, slug, token, now(), state.hub.app_frames.until(token)) != Token::Valid {
        return not_found();
    }
    let Ok(found) = find(&state, &workspace, slug).await else { return not_found() };
    if path.is_empty() {
        let entry = format!("{}{}", base(&workspace, slug, token), encoded(&found.app.manifest.entry));
        let mut response = Redirect::temporary(&entry).into_response();
        response.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
        return response;
    }
    let Some(relative) = clean_path(path) else { return not_found() };
    let mut response = serve_app_file(found, relative, request).await;
    // An opaque origin is cross-origin to everything, its own files included:
    // modules, fonts and `fetch` of them need this. The token is what guards the files.
    response.headers_mut().insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
    response
}
