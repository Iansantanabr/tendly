//! Custom apps: small static web apps (HTML, JS, CSS) that the person's agent
//! writes inside a workspace, listed in the Apps page and opened on the Mesa.
//! Routes live under `/api/hub/apps`.
//!
//! Convention: `<workspace root>/apps/<slug>/app.json` describes an app
//! (`name`, and optionally `letter`, `color`, `description`, `entry`), the
//! folder holds its files, and `apps/<slug>/data/<key>.json` its state, read
//! and written only through the data API below (the files route never serves
//! `data/`).
//!
//! Trust: unlike a published page (`publish.rs`, sandboxed), an app is code
//! the person's own agent wrote at the person's request, on the person's own
//! machine, the same as any script it could run in a terminal. So app files
//! are served same-origin, without a CSP sandbox, so that the page can call
//! the data API with the browser's credentials (`sdk.js`). The only CSP is
//! `frame-ancestors 'self'`: the app may be framed by Tendly itself and
//! nothing else. Everything is below `/api/`, so the guard still demands
//! authentication for every file and the `X-Tendly-Client` header for writes.
//! What is served is confined to the app's folder: no `..`, absolute paths,
//! backslashes, NUL, dot-files or the `data/` folder, and no symlink that
//! leads out of the folder. Any refusal is a bare 404.
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
        .route("/api/hub/apps/{workspace_id}/{slug}/data", get(keys_route))
        .route(
            "/api/hub/apps/{workspace_id}/{slug}/data/{key}",
            get(get_value_route).put(put_value_route).delete(delete_value_route),
        )
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
    Ok(Manifest { name, letter, color, description, entry })
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
        ],
        SDK,
    )
        .into_response()
}

async fn entry_route(State(state): State<AppState>, UrlPath((workspace, slug)): UrlPath<(String, String)>) -> Response {
    let Ok(found) = find(&state, &workspace, &slug).await else { return not_found() };
    let encoded: Vec<String> = found.app.manifest.entry.split('/').map(encode_segment).collect();
    Redirect::temporary(&format!("/api/hub/apps/{}/{}/files/{}", found.workspace.id, found.slug, encoded.join("/")))
        .into_response()
}

async fn file_route(
    State(state): State<AppState>,
    UrlPath((workspace, slug, path)): UrlPath<(String, String, String)>,
    request: Request,
) -> Response {
    let Ok(found) = find(&state, &workspace, &slug).await else { return not_found() };
    let Some(relative) = clean_path(&path) else { return not_found() };
    let dir = found.app.dir;
    let target = tokio::task::spawn_blocking(move || checked_file(&dir, &relative)).await.ok().flatten();
    let Some(target) = target else { return not_found() };
    let Ok(mut response) = crate::media::serve(target, false, request).await else { return not_found() };
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static("frame-ancestors 'self'"));
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
    Ok((StatusCode::CREATED, Json(entry)))
}
