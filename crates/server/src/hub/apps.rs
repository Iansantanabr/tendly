//! Custom apps: small static web apps (HTML, JS, CSS) that the person's agent
//! writes inside a workspace, listed in the Apps page and opened on the Mesa.
//! Routes live under `/api/hub/apps`.
//!
//! Convention: `<workspace root>/apps/<slug>/app.json` describes an app
//! (`name`, and optionally `letter`, `color`, `description`, `entry`,
//! `permissions`), the folder holds its files, and
//! `apps/<slug>/data/<key>.json` its state, read and written only through the
//! data API below (the files are never served from `data/`).
//!
//! Trust: an app is code an agent wrote, and it may pull scripts from a CDN.
//! It does not run as Tendly. Its files are served from an address of their
//! own with a CSP sandbox that gives the page an opaque origin (`frame.rs`),
//! so the app cannot call the API or touch Tendly's page; it asks the page
//! that frames it, through `postMessage` (`sdk.js`), and that page makes the
//! request with its own credentials: the app's data, and (only with what the
//! person allowed, `grants.rs`) Tendly's own data (`tendly.rs`). The routes
//! under `/api/` here are therefore for Tendly's page, not for the app.
//! What is served is confined to the app's folder: no `..`, absolute paths,
//! backslashes, NUL, dot-files or the `data/` folder, and no symlink that
//! leads out of the folder. Any refusal is a bare 404.
//!
//! `live.rs` makes an open app reload when its files change, and undoes the
//! change; `sdk.js` reports the app's errors to the page that frames it.
use crate::{ApiError, AppState, Result, app::db};
use axum::{
    Json, Router,
    body::Bytes,
    extract::{Path as UrlPath, Request, State},
    http::{HeaderValue, StatusCode, header},
    response::{IntoResponse, Redirect, Response},
    routing::{get, post},
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    fs, io,
    path::{Component, Path, PathBuf},
    time::SystemTime,
};
use tendly_domain::{Workspace, WorkspaceId};

pub(crate) mod frame;
pub(crate) mod grants;
pub(crate) mod live;
mod tendly;
#[cfg(test)]
mod tests;

const SDK: &str = include_str!("apps/sdk.js");
const TEMPLATE: &str = include_str!("apps/template.html");
/// The page of the "issues" template: a short list of reported problems kept with `tendly.data`.
const ISSUES_TEMPLATE: &str = include_str!("apps/issues.html");

/// The colors an app may ask for, with the accent the blank app uses for each.
pub(crate) const COLORS: &[(&str, &str)] = &[
    ("amber", "#d97706"),
    ("green", "#16a34a"),
    ("blue", "#2563eb"),
    ("violet", "#7c3aed"),
    ("rose", "#e11d48"),
    ("slate", "#475569"),
    ("teal", "#0d9488"),
    ("orange", "#ea580c"),
];
const DEFAULT_ENTRY: &str = "index.html";
/// The largest value the data API stores.
const MAX_VALUE_BYTES: usize = 1024 * 1024;
const MAX_MANIFEST_BYTES: u64 = 64 * 1024;
const MAX_NAME_CHARS: usize = 80;
const MAX_DESCRIPTION_CHARS: usize = 500;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/hub/apps", get(list_route))
        .route("/api/hub/apps/sdk.js", get(sdk_route))
        .route("/api/hub/apps/{workspace_id}/scaffold", post(scaffold_route))
        .route("/api/hub/apps/{workspace_id}/{slug}/files", get(entry_route))
        .route("/api/hub/apps/{workspace_id}/{slug}/files/", get(entry_route))
        .route("/api/hub/apps/{workspace_id}/{slug}/files/{*path}", get(file_route))
        .route("/api/hub/apps/{workspace_id}/{slug}/changes", get(live::changes_route))
        .route("/api/hub/apps/{workspace_id}/{slug}/changes/{id}/undo", post(live::undo_route))
        .route("/api/hub/apps/{workspace_id}/{slug}/data", get(keys_route))
        .route(
            "/api/hub/apps/{workspace_id}/{slug}/data/{key}",
            get(get_value_route).put(put_value_route).delete(delete_value_route),
        )
        .merge(frame::routes())
        .merge(grants::routes())
        .merge(tendly::routes())
}

// ---------------------------------------------------------------------------
// Names and paths

/// An app's folder name: `[a-z0-9][a-z0-9-]{0,63}`.
pub(crate) fn valid_slug(slug: &str) -> bool {
    let bytes = slug.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes.iter().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
}

/// A data key: `[A-Za-z0-9_-]{1,64}`.
pub(crate) fn valid_key(key: &str) -> bool {
    (1..=64).contains(&key.len()) && key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// A path inside an app folder that may be served: relative, plain names
/// only (no `..`, dot-files, backslash, NUL or drive), and not in `data/`.
pub(crate) fn clean_path(path: &str) -> Option<PathBuf> {
    if path.is_empty() || path.starts_with('/') || path.contains(['\\', '\0', ':']) || Path::new(path).is_absolute() {
        return None;
    }
    let mut out = PathBuf::new();
    for (index, part) in path.split('/').enumerate() {
        if part.is_empty() || part.starts_with('.') || (index == 0 && part == "data") {
            return None;
        }
        out.push(part);
    }
    if out.components().any(|c| !matches!(c, Component::Normal(_))) || crate::workspace_io::is_protected_path(&out) {
        return None;
    }
    Some(out)
}

/// A regular file below `dir` (already canonical), reached without a symlink
/// at its last step and still inside `dir` once every link is resolved.
fn checked_file(dir: &Path, relative: &Path) -> Option<PathBuf> {
    let joined = dir.join(relative);
    if !fs::symlink_metadata(&joined).ok()?.file_type().is_file() {
        return None;
    }
    let canonical = dunce::canonicalize(&joined).ok()?;
    canonical.starts_with(dir).then_some(canonical)
}

fn rfc3339(time: SystemTime) -> String {
    DateTime::<Utc>::from(time).to_rfc3339()
}

/// Percent-encodes one path segment for a URL.
fn encode_segment(segment: &str) -> String {
    let mut out = String::with_capacity(segment.len());
    for byte in segment.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

// ---------------------------------------------------------------------------
// app.json

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Manifest {
    pub name: String,
    pub letter: String,
    pub color: String,
    pub description: String,
    pub entry: String,
    /// What the app asks to be allowed (`grants.rs`), known names only.
    pub permissions: Vec<String>,
}

/// The color an app without one gets, stable for its slug.
fn default_color(slug: &str) -> &'static str {
    let sum: usize = slug.bytes().map(usize::from).sum();
    COLORS[sum % COLORS.len()].0
}

fn accent(color: &str) -> &'static str {
    COLORS.iter().find(|(name, _)| *name == color).map_or(COLORS[0].1, |(_, hex)| hex)
}

/// Reads `app.json`, filling in the defaults. The error says what to fix.
pub(crate) fn parse_manifest(slug: &str, text: &str) -> std::result::Result<Manifest, String> {
    let value: Value = serde_json::from_str(text).map_err(|e| format!("app.json is not valid JSON: {e}"))?;
    let Value::Object(map) = value else {
        return Err("app.json must be a JSON object".into());
    };
    let field = |key: &str| -> std::result::Result<Option<String>, String> {
        match map.get(key) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(text)) => Ok(Some(text.trim().to_owned()).filter(|t| !t.is_empty())),
            Some(_) => Err(format!("\"{key}\" in app.json must be a string")),
        }
    };
    let name = field("name")?.ok_or("app.json needs a \"name\"")?;
    if name.chars().count() > MAX_NAME_CHARS {
        return Err(format!("\"name\" must be at most {MAX_NAME_CHARS} characters"));
    }
    let letter = match field("letter")? {
        Some(letter) if letter.chars().count() > 2 => {
            return Err("\"letter\" must be one or two characters".into());
        }
        Some(letter) => letter,
        None => name.chars().next().map(|c| c.to_uppercase().collect()).unwrap_or_default(),
    };
    let color = match field("color")? {
        Some(color) => {
            let color = color.to_ascii_lowercase();
            if !COLORS.iter().any(|(name, _)| *name == color) {
                let names: Vec<&str> = COLORS.iter().map(|(name, _)| *name).collect();
                return Err(format!("\"color\" must be one of: {}", names.join(", ")));
            }
            color
        }
        None => default_color(slug).to_owned(),
    };
    let description = field("description")?.unwrap_or_default();
    if description.chars().count() > MAX_DESCRIPTION_CHARS {
        return Err(format!("\"description\" must be at most {MAX_DESCRIPTION_CHARS} characters"));
    }
    let entry = field("entry")?.unwrap_or_else(|| DEFAULT_ENTRY.to_owned());
    if clean_path(&entry).is_none() {
        return Err("\"entry\" must be a relative path inside the app folder (no dot-files, not in data/)".into());
    }
    let permissions = grants::parse_permissions(map.get("permissions"))?;
    Ok(Manifest { name, letter, color, description, entry, permissions })
}

/// An app found on disk.
#[derive(Debug, Clone)]
struct Located {
    /// The canonical app folder.
    dir: PathBuf,
    manifest: Manifest,
}

/// The app `slug` below the canonical workspace `root`: `Ok(None)` when there
/// is no such folder or it has no `app.json`, `Err` when it is not a valid app.
fn locate(root: &Path, slug: &str) -> std::result::Result<Option<Located>, String> {
    let dir = root.join("apps").join(slug);
    if !fs::metadata(&dir).is_ok_and(|m| m.is_dir()) {
        return Ok(None);
    }
    let dir = dunce::canonicalize(&dir).map_err(|e| e.to_string())?;
    if !dir.starts_with(root) {
        return Err("the app folder leads outside the workspace".into());
    }
    let manifest = dir.join("app.json");
    let metadata = match fs::symlink_metadata(&manifest) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("cannot read app.json: {error}")),
    };
    if !metadata.file_type().is_file() {
        return Err("app.json must be a regular file".into());
    }
    if metadata.len() > MAX_MANIFEST_BYTES {
        return Err("app.json is too large".into());
    }
    let text = fs::read_to_string(&manifest).map_err(|e| format!("cannot read app.json: {e}"))?;
    let manifest = parse_manifest(slug, &text)?;
    Ok(Some(Located { dir, manifest }))
}

// ---------------------------------------------------------------------------
// Listing

#[derive(Debug, Clone, Serialize)]
pub(crate) struct AppEntry {
    pub workspace_id: String,
    pub workspace_name: String,
    pub slug: String,
    pub name: String,
    pub letter: String,
    pub color: String,
    pub description: String,
    pub entry: String,
    /// What the app asks to be allowed; what it was allowed is `GET .../grants`.
    pub permissions: Vec<String>,
    /// A stable address of the entry page. It answers with a redirect to where
    /// the app is served for now (`frame.rs`); the page that frames an app asks
    /// `GET .../frame` for that address instead.
    pub url: String,
    pub code_path: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct AppProblem {
    pub workspace_id: String,
    pub slug: String,
    pub message: String,
}

/// The list entry for a located app; `Err` when its entry file is missing.
fn entry_for(workspace: &Workspace, slug: &str, app: &Located) -> std::result::Result<AppEntry, String> {
    let m = &app.manifest;
    let entry = clean_path(&m.entry)
        .and_then(|relative| checked_file(&app.dir, &relative))
        .ok_or_else(|| format!("the entry file {} is missing", m.entry))?;
    let modified = |path: &Path| fs::metadata(path).and_then(|m| m.modified()).ok();
    let updated = [modified(&app.dir.join("app.json")), modified(&entry)]
        .into_iter()
        .flatten()
        .max()
        .unwrap_or_else(SystemTime::now);
    let encoded_entry: Vec<String> = m.entry.split('/').map(encode_segment).collect();
    Ok(AppEntry {
        workspace_id: workspace.id.to_string(),
        workspace_name: workspace.name.clone(),
        slug: slug.to_owned(),
        name: m.name.clone(),
        letter: m.letter.clone(),
        color: m.color.clone(),
        description: m.description.clone(),
        entry: m.entry.clone(),
        permissions: m.permissions.clone(),
        url: format!("/api/hub/apps/{}/{slug}/files/{}", workspace.id, encoded_entry.join("/")),
        code_path: format!("apps/{slug}/"),
        updated_at: rfc3339(updated),
    })
}

fn scan(workspaces: &[Workspace]) -> (Vec<AppEntry>, Vec<AppProblem>) {
    let (mut apps, mut problems) = (Vec::new(), Vec::new());
    for workspace in workspaces {
        let Ok(root) = dunce::canonicalize(&workspace.root_path) else { continue };
        if !root.is_dir() {
            continue;
        }
        let Ok(entries) = fs::read_dir(root.join("apps")) else { continue };
        let mut problem = |slug: &str, message: String| {
            problems.push(AppProblem { workspace_id: workspace.id.to_string(), slug: slug.to_owned(), message });
        };
        for entry in entries.flatten() {
            let slug = entry.file_name().to_string_lossy().into_owned();
            if slug.starts_with('.') {
                continue;
            }
            if !valid_slug(&slug) {
                if entry.path().join("app.json").exists() {
                    problem(&slug, "the folder name must be lowercase letters, digits and dashes (up to 64)".into());
                }
                continue;
            }
            match locate(&root, &slug) {
                Ok(None) => {}
                Ok(Some(app)) => match entry_for(workspace, &slug, &app) {
                    Ok(found) => apps.push(found),
                    Err(message) => problem(&slug, message),
                },
                Err(message) => problem(&slug, message),
            }
        }
    }
    apps.sort_by(|a, b| {
        (a.name.to_lowercase(), &a.workspace_name, &a.slug).cmp(&(b.name.to_lowercase(), &b.workspace_name, &b.slug))
    });
    problems.sort_by(|a, b| (&a.workspace_id, &a.slug).cmp(&(&b.workspace_id, &b.slug)));
    (apps, problems)
}

async fn list_route(State(state): State<AppState>) -> Result<Json<Value>> {
    let workspaces = db(&state, |s| s.list_workspaces()).await?;
    let (apps, errors) = tokio::task::spawn_blocking(move || scan(&workspaces))
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(json!({ "apps": apps, "errors": errors })))
}

// ---------------------------------------------------------------------------
// One app

struct Found {
    workspace: Workspace,
    slug: String,
    app: Located,
}

/// The app at `/api/hub/apps/{workspace}/{slug}`, which must have a valid
/// `app.json`. Every failure is "App not found".
async fn find(state: &AppState, workspace: &str, slug: &str) -> Result<Found> {
    let missing = || ApiError::missing("App");
    let id: WorkspaceId = workspace.parse().map_err(|_| missing())?;
    if !valid_slug(slug) {
        return Err(missing());
    }
    let workspace = db(state, move |s| s.get_workspace(id)).await?.ok_or_else(missing)?;
    let (root_path, name) = (workspace.root_path.clone(), slug.to_owned());
    let app = tokio::task::spawn_blocking(move || {
        let root = dunce::canonicalize(root_path).ok()?;
        locate(&root, &name).ok().flatten()
    })
    .await
    .map_err(ApiError::internal)?
    .ok_or_else(missing)?;
    Ok(Found { workspace, slug: slug.to_owned(), app })
}

fn not_found() -> Response {
    (StatusCode::NOT_FOUND, [(header::CACHE_CONTROL, "no-cache")], "Not found").into_response()
}

async fn sdk_route() -> Response {
    (
        [
            (header::CONTENT_TYPE, "text/javascript; charset=utf-8"),
            (header::CACHE_CONTROL, "no-cache"),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            // An app page has an opaque origin and asks for its scripts with CORS (`with_cors_scripts`).
            (header::ACCESS_CONTROL_ALLOW_ORIGIN, "*"),
        ],
        SDK,
    )
        .into_response()
}

/// Sends the browser on to where the app is served for now: a fresh address
/// of its own (`frame.rs`), never this origin's.
fn moved(to: String) -> Response {
    let mut response = Redirect::temporary(&to).into_response();
    response.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

/// The old address of an app's entry page: kept, as a redirect.
async fn entry_route(State(state): State<AppState>, UrlPath((workspace, slug)): UrlPath<(String, String)>) -> Response {
    let Ok(found) = find(&state, &workspace, &slug).await else { return not_found() };
    let Ok((base, _)) = frame::issue(&state, &found).await else { return not_found() };
    let encoded: Vec<String> = found.app.manifest.entry.split('/').map(encode_segment).collect();
    moved(format!("{base}{}", encoded.join("/")))
}

/// The old address of an app's files (`/api/hub/apps/<ws>/<slug>/files/...`),
/// where they used to be served as part of Tendly itself. A link kept from
/// then still opens the app, in its sandbox: this answers with a redirect.
async fn file_route(
    State(state): State<AppState>,
    UrlPath((workspace, slug, path)): UrlPath<(String, String, String)>,
    request: Request,
) -> Response {
    let Ok(found) = find(&state, &workspace, &slug).await else { return not_found() };
    let Some(relative) = clean_path(&path) else { return not_found() };
    let dir = found.app.dir.clone();
    let exists = tokio::task::spawn_blocking(move || checked_file(&dir, &relative).is_some()).await.unwrap_or(false);
    if !exists {
        return not_found();
    }
    let Ok((base, _)) = frame::issue(&state, &found).await else { return not_found() };
    let encoded: Vec<String> = path.split('/').map(encode_segment).collect();
    let query = request.uri().query().map(|query| format!("?{query}")).unwrap_or_default();
    moved(format!("{base}{}{query}", encoded.join("/")))
}

/// The attributes of a start tag whose text (after the tag name, up to but
/// not including `>`) is `tag`: lowercase names with their values.
fn attributes(tag: &str) -> Vec<(String, String)> {
    let chars: Vec<char> = tag.chars().collect();
    let (mut at, mut found) = (0, Vec::new());
    while at < chars.len() {
        while at < chars.len() && (chars[at].is_whitespace() || chars[at] == '/') {
            at += 1;
        }
        let start = at;
        while at < chars.len() && !chars[at].is_whitespace() && !matches!(chars[at], '=' | '/') {
            at += 1;
        }
        if at == start {
            at += 1;
            continue;
        }
        let name: String = chars[start..at].iter().collect::<String>().to_ascii_lowercase();
        while at < chars.len() && chars[at].is_whitespace() {
            at += 1;
        }
        let mut value = String::new();
        if at < chars.len() && chars[at] == '=' {
            at += 1;
            while at < chars.len() && chars[at].is_whitespace() {
                at += 1;
            }
            if at < chars.len() && matches!(chars[at], '"' | '\'') {
                let quote = chars[at];
                at += 1;
                let start = at;
                while at < chars.len() && chars[at] != quote {
                    at += 1;
                }
                value = chars[start..at].iter().collect();
                at += 1;
            } else {
                let start = at;
                while at < chars.len() && !chars[at].is_whitespace() {
                    at += 1;
                }
                value = chars[start..at].iter().collect();
            }
        }
        found.push((name, value));
    }
    found
}

/// An app page with `crossorigin` on the `<script src>` tags that load the
/// app's own files (and the SDK).
///
/// The page has an opaque origin (`frame.rs`), so even its own script files
/// are another origin to it, and a browser hides the errors of a script from
/// another origin ("Script error.", no file, no line) unless it was fetched
/// with CORS. The files are served with `Access-Control-Allow-Origin: *`; this
/// makes the page ask that way, so "N errors" keeps saying where. Scripts from
/// other sites are left as written: a CDN may not answer CORS at all.
pub(crate) fn with_cors_scripts(html: &str) -> std::borrow::Cow<'_, str> {
    const OPEN: &str = "<script";
    let lower = html.to_ascii_lowercase();
    let (mut out, mut copied, mut search) = (String::new(), 0, 0);
    while let Some(found) = lower[search..].find(OPEN) {
        let after = search + found + OPEN.len();
        search = after;
        // `<scripts>` or `<script-x>` is some other element.
        if !html[after..].starts_with(|c: char| c.is_whitespace() || c == '/') {
            continue;
        }
        // The end of the tag: the first `>` outside a quoted value.
        let (mut quote, mut end) = (None, None);
        for (offset, c) in html[after..].char_indices() {
            match (quote, c) {
                (Some(open), c) if c == open => quote = None,
                (None, '"' | '\'') => quote = Some(c),
                (None, '>') => {
                    end = Some(after + offset);
                    break;
                }
                _ => {}
            }
        }
        let Some(end) = end else { break };
        let attributes = attributes(&html[after..end]);
        let source = attributes.iter().find(|(name, _)| name == "src").map(|(_, value)| value.trim().to_ascii_lowercase());
        let elsewhere = |source: &str| ["http:", "https:", "//", "data:", "blob:"].iter().any(|start| source.starts_with(start));
        if let Some(source) = source
            && !source.is_empty()
            && !elsewhere(&source)
            && !attributes.iter().any(|(name, _)| name == "crossorigin")
        {
            out.push_str(&html[copied..after]);
            out.push_str(" crossorigin");
            copied = after;
        }
        search = end;
    }
    if copied == 0 {
        return std::borrow::Cow::Borrowed(html);
    }
    out.push_str(&html[copied..]);
    std::borrow::Cow::Owned(out)
}

/// The largest page `with_cors_scripts` is applied to; a larger one is served as it is.
const MAX_PAGE_BYTES: u64 = 2 * 1024 * 1024;

/// An HTML file of the app, read whole and adjusted for its sandbox (`with_cors_scripts`).
fn read_page(target: &Path) -> Option<String> {
    let extension = target.extension()?.to_str()?.to_ascii_lowercase();
    if !matches!(extension.as_str(), "html" | "htm") || fs::metadata(target).ok()?.len() > MAX_PAGE_BYTES {
        return None;
    }
    Some(with_cors_scripts(&fs::read_to_string(target).ok()?).into_owned())
}

/// A file of the app, as its frame gets it: sandboxed into an origin of its own.
async fn serve_app_file(found: Found, relative: PathBuf, request: Request) -> Response {
    let dir = found.app.dir;
    let target = tokio::task::spawn_blocking(move || checked_file(&dir, &relative)).await.ok().flatten();
    let Some(target) = target else { return not_found() };
    let page = {
        let target = target.clone();
        tokio::task::spawn_blocking(move || read_page(&target)).await.ok().flatten()
    };
    let mut response = match page {
        Some(page) => ([(header::CONTENT_TYPE, "text/html; charset=utf-8")], page).into_response(),
        None => match crate::media::serve(target, false, request).await {
            Ok(response) => response,
            Err(_) => return not_found(),
        },
    };
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static(frame::POLICY));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    headers.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    // Text without a charset is read as Latin-1 by some browsers.
    if let Some(kind) = headers.get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok())
        && (kind.starts_with("text/") || kind.starts_with("application/javascript") || kind.starts_with("application/json"))
        && !kind.contains("charset")
        && let Ok(value) = HeaderValue::from_str(&format!("{kind}; charset=utf-8"))
    {
        headers.insert(header::CONTENT_TYPE, value);
    }
    response
}

// ---------------------------------------------------------------------------
// Data

#[derive(Debug, Clone, Serialize)]
pub(crate) struct KeyInfo {
    pub key: String,
    pub size: u64,
    pub updated_at: String,
}

fn key_info(key: &str, metadata: &fs::Metadata) -> KeyInfo {
    KeyInfo {
        key: key.to_owned(),
        size: metadata.len(),
        updated_at: rfc3339(metadata.modified().unwrap_or_else(|_| SystemTime::now())),
    }
}

/// `data/` of an app, when it exists and stays inside the app folder.
fn data_dir(app_dir: &Path) -> io::Result<Option<PathBuf>> {
    let dir = app_dir.join("data");
    match fs::metadata(&dir) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
        Ok(metadata) if !metadata.is_dir() => {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "data is not a folder"));
        }
        Ok(_) => {}
    }
    let canonical = dunce::canonicalize(&dir)?;
    if !canonical.starts_with(app_dir) {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "data leads outside the app folder"));
    }
    Ok(Some(canonical))
}

/// A stored value's file: a regular file, not a symlink.
fn value_file(app_dir: &Path, key: &str) -> io::Result<Option<(PathBuf, fs::Metadata)>> {
    let Some(dir) = data_dir(app_dir)? else { return Ok(None) };
    let path = dir.join(format!("{key}.json"));
    match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.file_type().is_file() => Ok(Some((path, metadata))),
        Ok(_) => Ok(None),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn list_keys(app_dir: &Path) -> io::Result<Vec<KeyInfo>> {
    let Some(dir) = data_dir(app_dir)? else { return Ok(Vec::new()) };
    let mut keys = Vec::new();
    for entry in fs::read_dir(dir)?.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(key) = name.strip_suffix(".json").filter(|key| valid_key(key)) else { continue };
        let Ok(metadata) = fs::symlink_metadata(entry.path()) else { continue };
        if metadata.file_type().is_file() {
            keys.push(key_info(key, &metadata));
        }
    }
    keys.sort_by(|a, b| a.key.cmp(&b.key));
    Ok(keys)
}

/// Writes a value through a temporary file and a rename, so a reader never
/// sees half of it.
fn write_value(app_dir: &Path, key: &str, bytes: &[u8]) -> io::Result<KeyInfo> {
    let created = app_dir.join("data");
    if fs::symlink_metadata(&created).is_err() {
        fs::create_dir(&created)?;
    }
    let dir = data_dir(app_dir)?.ok_or_else(|| io::Error::from(io::ErrorKind::NotFound))?;
    let target = dir.join(format!("{key}.json"));
    if fs::symlink_metadata(&target).is_ok_and(|m| !m.file_type().is_file()) {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "the value's file is not a regular file"));
    }
    let temporary = dir.join(format!(".{key}.{}.tmp", uuid::Uuid::new_v4()));
    let written = (|| {
        use std::io::Write;
        let mut file = fs::File::create(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&temporary, &target)
    })();
    if let Err(error) = written {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    Ok(key_info(key, &fs::metadata(&target)?))
}

fn data_error(error: io::Error) -> ApiError {
    if error.kind() == io::ErrorKind::InvalidData {
        ApiError::conflict(format!("The app's data folder is not usable: {error}"))
    } else {
        ApiError::internal(error)
    }
}

async fn blocking<T: Send + 'static>(operation: impl FnOnce() -> io::Result<T> + Send + 'static) -> Result<T> {
    tokio::task::spawn_blocking(operation)
        .await
        .map_err(ApiError::internal)?
        .map_err(data_error)
}

fn checked_key(key: &str) -> Result<()> {
    if valid_key(key) {
        Ok(())
    } else {
        Err(ApiError::bad("Keys are letters, digits, _ and -, up to 64 characters"))
    }
}

async fn keys_route(
    State(state): State<AppState>,
    UrlPath((workspace, slug)): UrlPath<(String, String)>,
) -> Result<Json<Value>> {
    let dir = find(&state, &workspace, &slug).await?.app.dir;
    let keys = blocking(move || list_keys(&dir)).await?;
    Ok(Json(json!({ "keys": keys })))
}

async fn get_value_route(
    State(state): State<AppState>,
    UrlPath((workspace, slug, key)): UrlPath<(String, String, String)>,
) -> Result<Response> {
    let dir = find(&state, &workspace, &slug).await?.app.dir;
    checked_key(&key)?;
    let bytes = blocking(move || match value_file(&dir, &key)? {
        Some((path, _)) => fs::read(path).map(Some),
        None => Ok(None),
    })
    .await?
    .ok_or_else(|| ApiError::missing("Key"))?;
    if serde_json::from_slice::<serde::de::IgnoredAny>(&bytes).is_err() {
        return Err(ApiError::conflict("The stored value is not valid JSON; it was probably edited by hand"));
    }
    Ok((
        [(header::CONTENT_TYPE, "application/json"), (header::CACHE_CONTROL, "no-store")],
        bytes,
    )
        .into_response())
}

async fn put_value_route(
    State(state): State<AppState>,
    UrlPath((workspace, slug, key)): UrlPath<(String, String, String)>,
    body: Bytes,
) -> Result<Json<KeyInfo>> {
    let dir = find(&state, &workspace, &slug).await?.app.dir;
    checked_key(&key)?;
    if body.len() > MAX_VALUE_BYTES {
        return Err(ApiError {
            status: StatusCode::PAYLOAD_TOO_LARGE,
            message: "A value can be at most 1 MB".into(),
        });
    }
    if serde_json::from_slice::<serde::de::IgnoredAny>(&body).is_err() {
        return Err(ApiError::bad("The body must be a JSON value"));
    }
    Ok(Json(blocking(move || write_value(&dir, &key, &body)).await?))
}

async fn delete_value_route(
    State(state): State<AppState>,
    UrlPath((workspace, slug, key)): UrlPath<(String, String, String)>,
) -> Result<StatusCode> {
    let dir = find(&state, &workspace, &slug).await?.app.dir;
    checked_key(&key)?;
    blocking(move || match value_file(&dir, &key)? {
        Some((path, _)) => fs::remove_file(path),
        None => Ok(()),
    })
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------------------
// Scaffold

#[derive(Debug, Deserialize)]
struct ScaffoldBody {
    slug: String,
    name: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    color: Option<String>,
    /// Which page the new app starts with: `blank` (the default) or `issues`.
    #[serde(default)]
    template: Option<String>,
}

fn escape_html(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

/// The blank app's page.
pub(crate) fn blank_page(manifest: &Manifest) -> String {
    let description = if manifest.description.is_empty() {
        "A blank Tendly app. Ask your agent to turn it into what you need."
    } else {
        &manifest.description
    };
    filled(TEMPLATE, manifest, description)
}

/// The page of an app that keeps a list of reported problems.
pub(crate) fn issues_page(manifest: &Manifest) -> String {
    let description = if manifest.description.is_empty() {
        "Problems and ideas noted while using Tendly."
    } else {
        &manifest.description
    };
    filled(ISSUES_TEMPLATE, manifest, description)
}

fn filled(template: &str, manifest: &Manifest, description: &str) -> String {
    template
        .replace("{{NAME}}", &escape_html(&manifest.name))
        .replace("{{LETTER}}", &escape_html(&manifest.letter))
        .replace("{{DESCRIPTION}}", &escape_html(description))
        .replace("{{ACCENT}}", accent(&manifest.color))
}

async fn scaffold_route(
    State(state): State<AppState>,
    UrlPath(workspace): UrlPath<String>,
    Json(body): Json<ScaffoldBody>,
) -> Result<(StatusCode, Json<AppEntry>)> {
    let id: WorkspaceId = workspace.parse().map_err(|_| ApiError::missing("Workspace"))?;
    let slug = body.slug.trim().to_owned();
    if !valid_slug(&slug) {
        return Err(ApiError::bad("The slug must be lowercase letters, digits and dashes, starting with a letter or digit (up to 64)"));
    }
    let mut manifest = json!({ "name": body.name.trim() });
    if let Some(description) = body.description.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
        manifest["description"] = json!(description);
    }
    if let Some(color) = body.color.as_deref().map(str::trim).filter(|c| !c.is_empty()) {
        manifest["color"] = json!(color);
    }
    let parsed = parse_manifest(&slug, &manifest.to_string()).map_err(ApiError::bad)?;
    // Written out in full so the agent sees every field it may change.
    let manifest = serde_json::to_string_pretty(&json!({
        "name": parsed.name,
        "letter": parsed.letter,
        "color": parsed.color,
        "description": parsed.description,
        "entry": parsed.entry,
        "permissions": parsed.permissions,
    }))
    .map_err(ApiError::internal)?;
    let workspace = crate::app::workspace(&state, id).await?;
    let root = crate::app::root(&state, id).await?;
    let page = match body.template.as_deref().map(str::trim) {
        None | Some("" | "blank") => blank_page(&parsed),
        Some("issues") => issues_page(&parsed),
        Some(_) => return Err(ApiError::bad("Unknown template: use blank or issues")),
    };
    let name = slug.clone();
    let app = tokio::task::spawn_blocking(move || -> Result<Located> {
        let apps = root.join("apps");
        fs::create_dir_all(&apps).map_err(ApiError::internal)?;
        let apps = dunce::canonicalize(&apps).map_err(ApiError::internal)?;
        if !apps.starts_with(&root) {
            return Err(ApiError::conflict("The apps folder leads outside the workspace"));
        }
        let dir = apps.join(&name);
        match fs::create_dir(&dir) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                return Err(ApiError::conflict(format!("apps/{name} already exists")));
            }
            Err(error) => return Err(ApiError::internal(error)),
        }
        fs::write(dir.join("app.json"), format!("{manifest}\n")).map_err(ApiError::internal)?;
        fs::write(dir.join(DEFAULT_ENTRY), page).map_err(ApiError::internal)?;
        locate(&root, &name).map_err(ApiError::internal)?.ok_or_else(|| ApiError::internal("app vanished"))
    })
    .await
    .map_err(ApiError::internal)??;
    let entry = entry_for(&workspace, &slug, &app).map_err(ApiError::internal)?;
    // Indexed at birth, so its first change can be undone.
    if let Ok(root) = crate::app::root(&state, id).await {
        live::ensure_indexed(&state, id, &slug, root).await;
    }
    Ok((StatusCode::CREATED, Json(entry)))
}
