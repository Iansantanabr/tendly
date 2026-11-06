//! Publishing a workspace file at `/p/{slug}`: for the team, behind a
//! password, or public; frozen at publish time or live from disk. Management
//! routes live under `/api/hub/publications`.
//!
//! A frozen publication is a copy in `<state dir>/published/<slug>/`: the file,
//! and for an HTML page the files it references (`assets.rs`). A live one reads
//! the workspace on every request. Either way a page is served at
//! `/p/{slug}/` so its relative links resolve below it; `/p/{slug}` redirects.
//!
//! `/p/` is outside `/api/`, so the guard checks only Host, Origin and
//! cross-site requests there; who may see a page is decided here.
//!
//! A published HTML page runs on this server's own origin, beside an API that
//! the viewer's browser is signed in to (and that needs no sign-in at all on
//! this machine). So it is served with a CSP `sandbox` that keeps scripts but
//! drops popups, forms and plugins, and with `connect-src` limited to the
//! page's own `/p/{slug}/` folder and `frame-src`/`worker-src` 'none': its
//! scripts cannot `fetch` the API, open the app in a window or frame and reach
//! into it, or post a form to it. Loads that are only GETs (images, scripts,
//! styles) may come from the page's folder or any HTTPS host, so a report that
//! uses a CDN still works. `allow-same-origin` stays on: without it the page
//! would be an opaque origin, every asset request would be cross-site, and the
//! guard would refuse them all. Every other file type gets the same locked
//! `sandbox; default-src 'none'` as the app's own preview (PDF excepted, which
//! a sandboxed document cannot display).
//!
//! On a VPS the pages have an address of their own (`hub_settings`'
//! `public_base_url`, a domain whose proxy forwards only `/p/*`). Every
//! publication the API returns then carries `public_url`, the absolute link to
//! share. A team-only page is the exception: only a browser signed in to the
//! app may see it, and that sign-in lives on the app's own address, so its
//! link stays there (`public_url` is null and the client uses its own origin).
use crate::{ApiError, AppState, Result, security::ViaTailnet, workspace_io};
use axum::{
    Extension, Form, Json, Router,
    extract::{Path as UrlPath, Query, Request, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Redirect, Response},
    routing::{get, post},
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tendly_domain::WorkspaceId;

mod access;
pub(super) use access::hmac_sha256;
mod assets;
mod markdown;

#[cfg(test)]
mod tests;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/hub/publications", get(list_route).post(upsert_route))
        .route("/api/hub/publications/for", get(for_route))
        .route(
            "/api/hub/publications/{slug}",
            axum::routing::patch(patch_route).delete(delete_route),
        )
        .route("/api/hub/publications/{slug}/refresh", post(refresh_route))
        .route("/p/{slug}", get(redirect_route).post(password_route))
        .route("/p/{slug}/", get(page_route).post(password_route))
        .route("/p/{slug}/{*rest}", get(asset_route))
}

// ---------------------------------------------------------------------------
// Model

#[derive(Debug, Clone, Serialize, PartialEq)]
pub(crate) struct Publication {
    pub slug: String,
    pub workspace_id: String,
    pub path: String,
    /// `team`, `password` or `public`.
    pub visibility: String,
    /// `frozen` or `live`.
    pub mode: String,
    pub created_at: String,
    pub updated_at: String,
    pub frozen_at: Option<String>,
    pub has_password: bool,
    /// Where it is served, relative to this server: `/p/<slug>`.
    pub url: String,
    /// The absolute link to share, when a public address is set in the hub
    /// settings and this page can be seen there; see the module comment.
    pub public_url: Option<String>,
    #[serde(skip)]
    password_hash: Option<String>,
}

const COLUMNS: &str =
    "slug, workspace_id, path, visibility, password_hash, mode, created_at, updated_at, frozen_at";

fn from_row(row: &rusqlite::Row) -> rusqlite::Result<Publication> {
    let slug: String = row.get(0)?;
    let password_hash: Option<String> = row.get(4)?;
    Ok(Publication {
        url: format!("/p/{slug}"),
        public_url: None,
        slug,
        workspace_id: row.get(1)?,
        path: row.get(2)?,
        visibility: row.get(3)?,
        has_password: password_hash.is_some(),
        password_hash,
        mode: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
        frozen_at: row.get(8)?,
    })
}

fn by_slug(c: &Connection, slug: &str) -> rusqlite::Result<Option<Publication>> {
    c.query_row(&format!("SELECT {COLUMNS} FROM publications WHERE slug = ?1"), [slug], from_row)
        .optional()
}

fn by_file(c: &Connection, workspace: &str, path: &str) -> rusqlite::Result<Option<Publication>> {
    c.query_row(
        &format!("SELECT {COLUMNS} FROM publications WHERE workspace_id = ?1 AND path = ?2"),
        [workspace, path],
        from_row,
    )
    .optional()
}

fn all(c: &Connection) -> rusqlite::Result<Vec<Publication>> {
    let mut statement =
        c.prepare(&format!("SELECT {COLUMNS} FROM publications ORDER BY updated_at DESC, slug"))?;
    statement.query_map([], from_row)?.collect()
}

fn save(c: &Connection, old_slug: Option<&str>, p: &Publication) -> rusqlite::Result<()> {
    match old_slug {
        None => c.execute(
            &format!("INSERT INTO publications({COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)"),
            params![p.slug, p.workspace_id, p.path, p.visibility, p.password_hash, p.mode, p.created_at, p.updated_at, p.frozen_at],
        )?,
        Some(old) => c.execute(
            "UPDATE publications SET slug = ?1, visibility = ?2, password_hash = ?3, mode = ?4,
             updated_at = ?5, frozen_at = ?6 WHERE slug = ?7",
            params![p.slug, p.visibility, p.password_hash, p.mode, p.updated_at, p.frozen_at, old],
        )?,
    };
    Ok(())
}

/// The secret cookies are signed with, made on first use and kept in hub.db.
fn secret(c: &Connection) -> rusqlite::Result<String> {
    if let Some(found) = c
        .query_row("SELECT secret FROM publication_secret WHERE id = 1", [], |r| r.get(0))
        .optional()?
    {
        return Ok(found);
    }
    let fresh = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
    c.execute("INSERT OR IGNORE INTO publication_secret(id, secret) VALUES (1, ?1)", [&fresh])?;
    c.query_row("SELECT secret FROM publication_secret WHERE id = 1", [], |r| r.get(0))
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

// ---------------------------------------------------------------------------
// Slugs

pub(crate) fn valid_slug(slug: &str) -> bool {
    (3..=64).contains(&slug.len()) && slug.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn fold(c: char) -> char {
    match c {
        'á' | 'à' | 'â' | 'ã' | 'ä' | 'å' => 'a',
        'é' | 'è' | 'ê' | 'ë' => 'e',
        'í' | 'ì' | 'î' | 'ï' => 'i',
        'ó' | 'ò' | 'ô' | 'õ' | 'ö' => 'o',
        'ú' | 'ù' | 'û' | 'ü' => 'u',
        'ç' => 'c',
        'ñ' => 'n',
        'ý' | 'ÿ' => 'y',
        c => c,
    }
}

/// A readable start for a slug, from the file's name: `Relatório Q3.html`
/// becomes `relatorio-q3`.
pub(crate) fn slug_base(path: &str) -> String {
    let name = Path::new(path).file_stem().and_then(|s| s.to_str()).unwrap_or_default();
    let mut out = String::new();
    for c in name.chars().flat_map(char::to_lowercase).map(fold) {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
        if out.len() >= 40 {
            break;
        }
    }
    let out = out.trim_matches('-');
    if out.is_empty() { "file".into() } else { out.into() }
}

/// `base` plus a short random suffix, as `relatorio-q3-k3f9`.
pub(crate) fn generate_slug(base: &str) -> String {
    const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
    let suffix: String = uuid::Uuid::new_v4().as_bytes()[..4]
        .iter()
        .map(|b| ALPHABET[*b as usize % ALPHABET.len()] as char)
        .collect();
    format!("{base}-{suffix}")
}

// ---------------------------------------------------------------------------
// Management API

fn snapshot_dir(state: &AppState, slug: &str) -> PathBuf {
    state.state_dir.join("published").join(slug)
}

/// A workspace path as stored: relative, `/`-separated, no `.` or `..`.
fn normal_path(path: &str) -> Result<String> {
    let relative = workspace_io::safe_relative(path)?;
    let parts: Vec<String> = relative.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect();
    if parts.is_empty() {
        return Err(ApiError::bad("Path required"));
    }
    Ok(parts.join("/"))
}

/// The file a publication shows, in its workspace as it is now.
async fn workspace_file(state: &AppState, workspace: &str, path: &str) -> Result<PathBuf> {
    let id: WorkspaceId = workspace.parse().map_err(|_| ApiError::bad("Invalid workspace id"))?;
    let root = crate::app::root(state, id).await?;
    let path = path.to_owned();
    tokio::task::spawn_blocking(move || workspace_io::asset_path(&root, &path))
        .await
        .map_err(ApiError::internal)?
        .map_err(Into::into)
}

/// Freeze the file (and its assets) as it is now.
async fn freeze(state: &AppState, p: &Publication) -> Result<()> {
    let file = workspace_file(state, &p.workspace_id, &p.path).await?;
    let destination = snapshot_dir(state, &p.slug);
    tokio::task::spawn_blocking(move || {
        let root = file.parent().ok_or_else(|| ApiError::bad("Invalid path"))?;
        let entry = Path::new(file.file_name().ok_or_else(|| ApiError::bad("Invalid path"))?);
        assets::snapshot(root, entry, &destination).map_err(|error| match error.kind() {
            std::io::ErrorKind::NotFound => ApiError::missing("File"),
            std::io::ErrorKind::FileTooLarge => ApiError {
                status: StatusCode::PAYLOAD_TOO_LARGE,
                message: "This file is too large to freeze; publish it live instead".into(),
            },
            _ => ApiError::internal(error),
        })
    })
    .await
    .map_err(ApiError::internal)??;
    Ok(())
}

async fn remove_snapshot(state: &AppState, slug: &str) {
    let dir = snapshot_dir(state, slug);
    let _ = tokio::task::spawn_blocking(move || assets::remove(&dir)).await;
}

/// One change at a time: slugs are checked and snapshots replaced in order.
static WRITES: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct Changes {
    visibility: Option<String>,
    password: Option<String>,
    mode: Option<String>,
    slug: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Upsert {
    workspace_id: WorkspaceId,
    path: String,
    visibility: String,
    #[serde(default)]
    password: Option<String>,
    mode: String,
    #[serde(default)]
    slug: Option<String>,
}

async fn hash(password: String) -> Result<String> {
    if password.chars().count() < access::MIN_PASSWORD {
        return Err(ApiError::bad(format!(
            "The password needs at least {} characters",
            access::MIN_PASSWORD
        )));
    }
    tokio::task::spawn_blocking(move || access::hash_password(&password))
        .await
        .map_err(ApiError::internal)?
        .map_err(ApiError::internal)
}

fn wanted_slug(slug: Option<String>) -> Result<Option<String>> {
    match slug.map(|s| s.trim().to_owned()).filter(|s| !s.is_empty()) {
        Some(slug) if !valid_slug(&slug) => Err(ApiError::bad(
            "A link name has 3 to 64 lowercase letters, digits or hyphens",
        )),
        other => Ok(other),
    }
}

fn check_choice(value: &str, allowed: &[&str], what: &str) -> Result<()> {
    if allowed.contains(&value) {
        Ok(())
    } else {
        Err(ApiError::bad(format!("Invalid {what}: {value}")))
    }
}

async fn create(state: &AppState, workspace: String, path: String, input: Changes) -> Result<Publication> {
    let visibility = input.visibility.unwrap_or_else(|| "team".into());
    let mode = input.mode.unwrap_or_else(|| "frozen".into());
    let password_hash = match (visibility.as_str(), input.password) {
        ("password", Some(password)) => Some(hash(password).await?),
        ("password", None) => return Err(ApiError::bad("A password is required")),
        _ => None,
    };
    let slug = match wanted_slug(input.slug)? {
        Some(slug) => {
            let taken = slug.clone();
            if super::cs(state, move |c| by_slug(c, &taken)).await?.is_some() {
                return Err(ApiError::conflict("This link name is taken"));
            }
            slug
        }
        None => {
            let base = slug_base(&path);
            let mut chosen = None;
            for _ in 0..20 {
                let candidate = generate_slug(&base);
                let check = candidate.clone();
                if super::cs(state, move |c| by_slug(c, &check)).await?.is_none() {
                    chosen = Some(candidate);
                    break;
                }
            }
            chosen.ok_or_else(|| ApiError::internal("no free slug"))?
        }
    };
    let stamp = now();
    let mut publication = Publication {
        url: format!("/p/{slug}"),
        public_url: None,
        slug,
        workspace_id: workspace,
        path,
        has_password: password_hash.is_some(),
        password_hash,
        visibility,
        mode,
        created_at: stamp.clone(),
        updated_at: stamp.clone(),
        frozen_at: None,
    };
    if publication.mode == "frozen" {
        freeze(state, &publication).await?;
        publication.frozen_at = Some(stamp);
    }
    let row = publication.clone();
    if let Err(error) = super::cs(state, move |c| save(c, None, &row)).await {
        if publication.mode == "frozen" {
            remove_snapshot(state, &publication.slug).await;
        }
        return Err(error);
    }
    Ok(publication)
}

async fn update(state: &AppState, mut p: Publication, input: Changes) -> Result<Publication> {
    let old = p.clone();
    if let Some(visibility) = input.visibility {
        p.visibility = visibility;
    }
    if p.visibility == "password" {
        match input.password {
            Some(password) => p.password_hash = Some(hash(password).await?),
            None if p.password_hash.is_none() => return Err(ApiError::bad("A password is required")),
            None => {}
        }
    } else {
        p.password_hash = None;
    }
    p.has_password = p.password_hash.is_some();
    if let Some(slug) = wanted_slug(input.slug)?
        && slug != p.slug
    {
        let taken = slug.clone();
        if super::cs(state, move |c| by_slug(c, &taken)).await?.is_some() {
            return Err(ApiError::conflict("This link name is taken"));
        }
        p.slug = slug;
        p.url = format!("/p/{}", p.slug);
    }
    if let Some(mode) = input.mode {
        p.mode = mode;
    }
    p.updated_at = now();
    // The snapshot follows the slug and the mode.
    if p.mode == "frozen" {
        if old.mode != "frozen" {
            freeze(state, &p).await?;
            p.frozen_at = Some(p.updated_at.clone());
        } else if p.slug != old.slug {
            let (from, to) = (snapshot_dir(state, &old.slug), snapshot_dir(state, &p.slug));
            let moved = tokio::task::spawn_blocking(move || from.is_dir() && std::fs::rename(from, to).is_ok())
                .await
                .map_err(ApiError::internal)?;
            if !moved {
                freeze(state, &p).await?;
                p.frozen_at = Some(p.updated_at.clone());
            }
        }
    } else {
        p.frozen_at = None;
    }
    let row = p.clone();
    let old_slug = old.slug.clone();
    super::cs(state, move |c| save(c, Some(&old_slug), &row)).await?;
    if p.mode != "frozen" && old.mode == "frozen" {
        remove_snapshot(state, &old.slug).await;
    }
    Ok(p)
}

fn validate_changes(input: &Changes) -> Result<()> {
    if let Some(v) = &input.visibility {
        check_choice(v, &["team", "password", "public"], "visibility")?;
    }
    if let Some(m) = &input.mode {
        check_choice(m, &["frozen", "live"], "mode")?;
    }
    Ok(())
}

impl Publication {
    /// Fills `public_url` from the public address in the hub settings, if any.
    fn linked(mut self, base: Option<&str>) -> Self {
        self.public_url = base
            .filter(|_| self.visibility != "team")
            .map(|base| super::settings::absolute(base, &self.url));
        self
    }
}

/// A publication as the API returns it, with its link to share.
async fn linked(state: &AppState, publication: Publication) -> Result<Json<Publication>> {
    let base = super::cs(state, super::settings::public_base_url).await?;
    Ok(Json(publication.linked(base.as_deref())))
}

async fn list_route(State(state): State<AppState>) -> Result<Json<Vec<Publication>>> {
    let (publications, base) =
        super::cs(&state, |c| Ok((all(c)?, super::settings::public_base_url(c)?))).await?;
    Ok(Json(publications.into_iter().map(|p| p.linked(base.as_deref())).collect()))
}

#[derive(Deserialize)]
struct ForQuery {
    workspace_id: String,
    path: String,
}

async fn for_route(State(state): State<AppState>, Query(q): Query<ForQuery>) -> Result<Json<Option<Publication>>> {
    let path = normal_path(&q.path)?;
    let (found, base) = super::cs(&state, move |c| {
        Ok((by_file(c, &q.workspace_id, &path)?, super::settings::public_base_url(c)?))
    })
    .await?;
    Ok(Json(found.map(|p| p.linked(base.as_deref()))))
}

async fn upsert_route(State(state): State<AppState>, Json(input): Json<Upsert>) -> Result<Json<Publication>> {
    let changes = Changes {
        visibility: Some(input.visibility),
        password: input.password.filter(|p| !p.is_empty()),
        mode: Some(input.mode),
        slug: input.slug,
    };
    validate_changes(&changes)?;
    let path = normal_path(&input.path)?;
    let workspace = input.workspace_id.to_string();
    let _guard = WRITES.lock().await;
    // The file has to exist and be one Tendly may serve.
    workspace_file(&state, &workspace, &path).await?;
    let (w, p) = (workspace.clone(), path.clone());
    let existing = super::cs(&state, move |c| by_file(c, &w, &p)).await?;
    let saved = match existing {
        Some(found) => update(&state, found, changes).await?,
        None => create(&state, workspace, path, changes).await?,
    };
    linked(&state, saved).await
}

async fn find(state: &AppState, slug: String) -> Result<Publication> {
    super::cs(state, move |c| by_slug(c, &slug))
        .await?
        .ok_or_else(|| ApiError::missing("Publication"))
}

async fn patch_route(
    State(state): State<AppState>,
    UrlPath(slug): UrlPath<String>,
    Json(mut changes): Json<Changes>,
) -> Result<Json<Publication>> {
    validate_changes(&changes)?;
    changes.password = changes.password.filter(|p| !p.is_empty());
    let _guard = WRITES.lock().await;
    let found = find(&state, slug).await?;
    let saved = update(&state, found, changes).await?;
    linked(&state, saved).await
}

async fn refresh_route(State(state): State<AppState>, UrlPath(slug): UrlPath<String>) -> Result<Json<Publication>> {
    let _guard = WRITES.lock().await;
    let mut p = find(&state, slug).await?;
    if p.mode != "frozen" {
        return Err(ApiError::bad("A live publication always shows the current file"));
    }
    freeze(&state, &p).await?;
    p.updated_at = now();
    p.frozen_at = Some(p.updated_at.clone());
    let row = p.clone();
    super::cs(&state, move |c| save(c, Some(&row.slug), &row)).await?;
    linked(&state, p).await
}

async fn delete_route(State(state): State<AppState>, UrlPath(slug): UrlPath<String>) -> Result<StatusCode> {
    let _guard = WRITES.lock().await;
    let p = find(&state, slug).await?;
    let gone = p.slug.clone();
    super::cs(&state, move |c| c.execute("DELETE FROM publications WHERE slug = ?1", [&gone])).await?;
    remove_snapshot(&state, &p.slug).await;
    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------------------
// Serving

const PAGE_POLICY: &str = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

/// One of the small pages shown instead of the file.
fn notice(status: StatusCode, html: String) -> Response {
    (
        status,
        [
            (header::CONTENT_TYPE, HeaderValue::from_static("text/html; charset=utf-8")),
            (header::CONTENT_SECURITY_POLICY, HeaderValue::from_static(PAGE_POLICY)),
            (header::CACHE_CONTROL, HeaderValue::from_static("no-store")),
            (header::HeaderName::from_static("x-robots-tag"), HeaderValue::from_static("noindex")),
        ],
        html,
    )
        .into_response()
}

fn not_found() -> Response {
    notice(StatusCode::NOT_FOUND, access::not_found())
}

/// The policy for a published HTML page; see the module comment.
pub(crate) fn html_policy(host: Option<&str>, slug: &str) -> String {
    let host = host.filter(|h| {
        !h.is_empty() && h.bytes().all(|b| b.is_ascii_alphanumeric() || b".-:[]".contains(&b))
    });
    let (own, connect) = match host {
        Some(h) => {
            let own = format!("http://{h}/p/{slug}/ https://{h}/p/{slug}/");
            (own.clone(), own)
        }
        None => ("'self'".to_owned(), "'none'".to_owned()),
    };
    format!(
        "sandbox allow-scripts allow-same-origin allow-modals allow-downloads; \
         default-src 'none'; script-src {own} 'unsafe-inline' 'unsafe-eval' https:; \
         style-src {own} 'unsafe-inline' https:; img-src {own} data: blob: https:; \
         font-src {own} data: https:; media-src {own} data: blob: https:; \
         connect-src {connect}; frame-src 'none'; child-src 'none'; worker-src 'none'; \
         object-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'"
    )
}

/// Who may see this request, given the publication.
enum Access {
    Allowed,
    TeamOnly,
    NeedsPassword,
}

async fn access(state: &AppState, p: &Publication, headers: &HeaderMap, via_tailnet: bool) -> Result<Access> {
    Ok(match p.visibility.as_str() {
        "public" => Access::Allowed,
        "password" => {
            let Some(hash) = p.password_hash.clone() else { return Ok(Access::NeedsPassword) };
            let secret = super::cs(state, secret).await?;
            let now = chrono::Utc::now().timestamp();
            if access::cookie_values(headers)
                .iter()
                .any(|v| access::verify(&secret, &p.slug, &hash, v, now))
            {
                Access::Allowed
            } else {
                Access::NeedsPassword
            }
        }
        _ if state.security.authenticated(headers, via_tailnet) => Access::Allowed,
        _ => Access::TeamOnly,
    })
}

async fn redirect_route(UrlPath(slug): UrlPath<String>) -> Response {
    if !valid_slug(&slug) {
        return not_found();
    }
    Redirect::permanent(&format!("/p/{slug}/")).into_response()
}

async fn page_route(
    State(state): State<AppState>,
    UrlPath(slug): UrlPath<String>,
    via: Option<Extension<ViaTailnet>>,
    request: Request,
) -> Response {
    serve(&state, slug, None, via.is_some(), request).await
}

async fn asset_route(
    State(state): State<AppState>,
    UrlPath((slug, rest)): UrlPath<(String, String)>,
    via: Option<Extension<ViaTailnet>>,
    request: Request,
) -> Response {
    serve(&state, slug, Some(rest), via.is_some(), request).await
}

async fn serve(state: &AppState, slug: String, rest: Option<String>, via_tailnet: bool, request: Request) -> Response {
    match try_serve(state, slug, rest, via_tailnet, request).await {
        Ok(response) => response,
        Err(error) if error.status == StatusCode::INTERNAL_SERVER_ERROR => notice(
            StatusCode::INTERNAL_SERVER_ERROR,
            access::page("Unavailable", "<h1>This page is unavailable right now.</h1>", false),
        ),
        Err(_) => not_found(),
    }
}

/// The file below the publication's folder that this request names.
fn resolve(p: &Publication, root: &Path, rest: Option<&str>, live: bool) -> Option<PathBuf> {
    let entry = PathBuf::from(Path::new(&p.path).file_name()?);
    let relative = match rest {
        None => entry.clone(),
        // Only a page has anything below it.
        Some(_) if !assets::is_html(&entry) => return None,
        Some(rest) => assets::clean_rest(rest)?,
    };
    // Live, the folder is the workspace's: only what the page references now.
    if live && relative != entry && !assets::collect(root, &entry).ok()?.files.contains(&relative) {
        return None;
    }
    assets::checked_file(root, &relative)
}

async fn try_serve(
    state: &AppState,
    slug: String,
    rest: Option<String>,
    via_tailnet: bool,
    request: Request,
) -> Result<Response> {
    if !valid_slug(&slug) {
        return Ok(not_found());
    }
    let Some(p) = super::cs(state, {
        let slug = slug.clone();
        move |c| by_slug(c, &slug)
    })
    .await?
    else {
        return Ok(not_found());
    };
    let headers = request.headers().clone();
    match access(state, &p, &headers, via_tailnet).await? {
        Access::Allowed => {}
        Access::TeamOnly => return Ok(notice(StatusCode::FORBIDDEN, access::team_only())),
        Access::NeedsPassword => {
            return Ok(notice(StatusCode::UNAUTHORIZED, access::password_form(&p.slug, None)));
        }
    }
    let live = p.mode == "live";
    let root = if live {
        let Ok(file) = workspace_file(state, &p.workspace_id, &p.path).await else {
            return Ok(not_found());
        };
        file.parent().map(Path::to_path_buf).ok_or_else(|| ApiError::missing("File"))?
    } else {
        snapshot_dir(state, &p.slug)
    };
    let (publication, is_main) = (p.clone(), rest.is_none());
    let target = tokio::task::spawn_blocking(move || resolve(&publication, &root, rest.as_deref(), live))
        .await
        .map_err(ApiError::internal)?;
    let Some(target) = target else {
        return Ok(not_found());
    };
    let protected = p.visibility != "public";
    if is_main && assets::is_markdown(&target) {
        let name = Path::new(&p.path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let bytes = tokio::fs::read(&target).await.map_err(|_| ApiError::missing("File"))?;
        let mut response = notice(StatusCode::OK, access::markdown_page(&name, &String::from_utf8_lossy(&bytes)));
        response.headers_mut().insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static("default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; frame-ancestors 'self'"));
        cache(&mut response, protected);
        return Ok(response);
    }
    let html = assets::is_html(&target);
    let pdf = target.extension().is_some_and(|e| e.eq_ignore_ascii_case("pdf"));
    let host = headers.get(header::HOST).and_then(|v| v.to_str().ok()).map(str::to_owned);
    let mut response = crate::media::serve(target, false, request).await?;
    let policy = if html {
        HeaderValue::from_str(&html_policy(host.as_deref(), &p.slug)).map_err(ApiError::internal)?
    } else if pdf {
        HeaderValue::from_static("frame-ancestors 'self'")
    } else {
        HeaderValue::from_static("sandbox; default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'")
    };
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_SECURITY_POLICY, policy);
    headers.insert("x-robots-tag", HeaderValue::from_static("noindex"));
    // Text without a charset is read as Latin-1 by some browsers.
    if let Some(kind) = headers.get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok())
        && (kind.starts_with("text/") || kind.starts_with("application/javascript") || kind.starts_with("application/json"))
        && !kind.contains("charset")
        && let Ok(value) = HeaderValue::from_str(&format!("{kind}; charset=utf-8"))
    {
        headers.insert(header::CONTENT_TYPE, value);
    }
    cache(&mut response, protected);
    Ok(response)
}

fn cache(response: &mut Response, protected: bool) {
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(if protected { "private, no-cache" } else { "no-cache" }),
    );
}

#[derive(Deserialize)]
struct PasswordForm {
    #[serde(default)]
    password: String,
}

/// Whether the visitor reached this over HTTPS: the tailnet always is, and a
/// reverse proxy in front (Caddy on the VPS) says so in `X-Forwarded-Proto`.
/// It only decides whether the visitor's own cookie is marked `Secure`, so a
/// client that lies about it changes nothing but its own cookie.
pub(crate) fn over_https(headers: &HeaderMap, via_tailnet: bool) -> bool {
    via_tailnet
        || headers
            .get("x-forwarded-proto")
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.split(',').next().is_some_and(|first| first.trim().eq_ignore_ascii_case("https")))
}

async fn password_route(
    State(state): State<AppState>,
    UrlPath(slug): UrlPath<String>,
    via: Option<Extension<ViaTailnet>>,
    headers: HeaderMap,
    Form(form): Form<PasswordForm>,
) -> Response {
    match check_password(&state, slug, form.password, over_https(&headers, via.is_some())).await {
        Ok(response) => response,
        Err(_) => not_found(),
    }
}

async fn check_password(state: &AppState, slug: String, password: String, secure: bool) -> Result<Response> {
    if !valid_slug(&slug) {
        return Ok(not_found());
    }
    let Some(p) = super::cs(state, {
        let slug = slug.clone();
        move |c| by_slug(c, &slug)
    })
    .await?
    else {
        return Ok(not_found());
    };
    let Some(hash) = p.password_hash.clone().filter(|_| p.visibility == "password") else {
        // Nothing to unlock: just go to the page, which says what it needs.
        return Ok(Redirect::to(&format!("/p/{slug}/")).into_response());
    };
    let instant = std::time::Instant::now();
    if access::LIMITER.lock().expect("limiter").blocked(&slug, instant) {
        return Ok(notice(
            StatusCode::TOO_MANY_REQUESTS,
            access::password_form(&slug, Some("Too many attempts. Try again in a minute.")),
        ));
    }
    let checked = hash.clone();
    let right = tokio::task::spawn_blocking(move || access::check_password(&password, &checked))
        .await
        .map_err(ApiError::internal)?;
    if !right {
        access::LIMITER.lock().expect("limiter").fail(&slug, instant);
        return Ok(notice(StatusCode::UNAUTHORIZED, access::password_form(&slug, Some("That password is not right."))));
    }
    access::LIMITER.lock().expect("limiter").clear(&slug);
    let secret = super::cs(state, secret).await?;
    let expires = chrono::Utc::now().timestamp() + access::COOKIE_SECONDS;
    let value = access::sign(&secret, &slug, &hash, expires);
    let mut response = Redirect::to(&format!("/p/{slug}/")).into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&access::set_cookie(&slug, &value, secure)).map_err(ApiError::internal)?,
    );
    response.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(response)
}
