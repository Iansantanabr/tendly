//! Files a person adds to an app: a photo, a scanned page, a PDF.
//!
//! They are kept in `apps/<slug>/files/`, one flat folder, beside the app's
//! code. Being inside the app's folder they are served to its frame like any
//! other of its files (`frame.rs`), so `tendly.files.url(path)` is an address
//! an `<img>` can show, and they travel with the folder (a copy, a backup).
//! They are not the app's code: a change in `files/` never reloads the app
//! (`live.rs`).
//!
//! An upload arrives from the Tendly page that frames the app, as raw bytes.
//! What it is gets decided here from the bytes themselves, never from the name
//! or the type the sender claims: images (PNG, JPEG, GIF, WebP, AVIF) and PDF,
//! up to 20 MB. The name it is stored under is made here too: plain ASCII
//! letters, digits, `-` and `_`, the extension of what the file really is, and
//! a number at the end when the name is taken. Nothing is ever overwritten.
use super::{find, rfc3339};
use crate::{ApiError, AppState, Result};
use axum::{
    Json, Router,
    body::Bytes,
    extract::{DefaultBodyLimit, Path as UrlPath, Query, State},
    http::StatusCode,
    routing::{delete, get},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    fs, io,
    path::{Path, PathBuf},
    time::SystemTime,
};

/// The folder inside an app that holds what was uploaded.
pub(crate) const FOLDER: &str = "files";
pub(crate) const MAX_UPLOAD_BYTES: usize = 20 * 1024 * 1024;
/// How many files an app keeps.
pub(crate) const MAX_FILES: usize = 2000;
const MAX_STEM_CHARS: usize = 80;

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/hub/apps/{workspace_id}/{slug}/uploads",
            get(list_route).post(upload_route).layer(DefaultBodyLimit::max(MAX_UPLOAD_BYTES + 4096)),
        )
        .route("/api/hub/apps/{workspace_id}/{slug}/uploads/{name}", delete(remove_route))
}

// ---------------------------------------------------------------------------
// What a file is, and what it is called

/// What the bytes are: `(media type, extension)`, for the kinds an app may keep.
pub(crate) fn kind_of(bytes: &[u8]) -> Option<(&'static str, &'static str)> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some(("image/png", "png"))
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some(("image/jpeg", "jpg"))
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some(("image/gif", "gif"))
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some(("image/webp", "webp"))
    } else if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" && matches!(&bytes[8..12], b"avif" | b"avis") {
        Some(("image/avif", "avif"))
    } else if bytes.starts_with(b"%PDF-") {
        Some(("application/pdf", "pdf"))
    } else {
        None
    }
}

/// The media type a stored file is listed with, from its extension (which `kind_of` chose when it was uploaded).
fn listed_type(name: &str) -> &'static str {
    match name.rsplit_once('.').map(|(_, extension)| extension.to_ascii_lowercase()).as_deref() {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("avif") => "image/avif",
        Some("pdf") => "application/pdf",
        _ => "application/octet-stream",
    }
}

/// A Latin letter without its accent, for the letters Portuguese and its neighbours use.
fn plain(c: char) -> Option<&'static str> {
    Some(match c {
        'á' | 'à' | 'â' | 'ã' | 'ä' | 'å' => "a",
        'Á' | 'À' | 'Â' | 'Ã' | 'Ä' | 'Å' => "A",
        'é' | 'è' | 'ê' | 'ë' => "e",
        'É' | 'È' | 'Ê' | 'Ë' => "E",
        'í' | 'ì' | 'î' | 'ï' => "i",
        'Í' | 'Ì' | 'Î' | 'Ï' => "I",
        'ó' | 'ò' | 'ô' | 'õ' | 'ö' => "o",
        'Ó' | 'Ò' | 'Ô' | 'Õ' | 'Ö' => "O",
        'ú' | 'ù' | 'û' | 'ü' => "u",
        'Ú' | 'Ù' | 'Û' | 'Ü' => "U",
        'ç' => "c",
        'Ç' => "C",
        'ñ' => "n",
        'Ñ' => "N",
        _ => return None,
    })
}

/// The name a file is stored under, without its extension: what the sender
/// called it, reduced to ASCII letters, digits, `-` and `_`. Never empty,
/// never starting with a dot, never a path.
pub(crate) fn safe_stem(given: &str) -> String {
    // Only the last part of whatever path came, and not its extension.
    let last = given.rsplit(['/', '\\']).next().unwrap_or_default();
    let stem = match last.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() && extension.len() <= 5 => stem,
        _ => last,
    };
    let mut out = String::new();
    for c in stem.chars() {
        if c.is_ascii_alphanumeric() || c == '_' {
            out.push(c);
        } else if let Some(letter) = plain(c) {
            out.push_str(letter);
        } else if !out.ends_with('-') {
            out.push('-');
        }
        if out.len() >= MAX_STEM_CHARS {
            break;
        }
    }
    let out = out.trim_matches('-');
    if out.is_empty() { "file".to_owned() } else { out.to_owned() }
}

/// A name `uploads/<name>` may point at: one plain file name, as `safe_stem` and an extension make them.
pub(crate) fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= MAX_STEM_CHARS + 16
        && !name.starts_with(['.', '-'])
        && name.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
        && !name.contains("..")
}

// ---------------------------------------------------------------------------
// The folder

#[derive(Debug, Clone, PartialEq, Serialize)]
pub(crate) struct Stored {
    /// Inside the app's folder: `files/photo.png`. What `tendly.files.url` takes.
    pub path: String,
    pub name: String,
    pub size: u64,
    #[serde(rename = "type")]
    pub kind: String,
    pub updated_at: String,
}

fn stored(name: &str, metadata: &fs::Metadata) -> Stored {
    Stored {
        path: format!("{FOLDER}/{name}"),
        name: name.to_owned(),
        size: metadata.len(),
        kind: listed_type(name).to_owned(),
        updated_at: rfc3339(metadata.modified().unwrap_or_else(|_| SystemTime::now())),
    }
}

fn unusable(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.to_owned())
}

/// `files/` of an app (already canonical), when it exists: a real folder that stays inside the app.
fn folder(app_dir: &Path) -> io::Result<Option<PathBuf>> {
    let dir = app_dir.join(FOLDER);
    match fs::symlink_metadata(&dir) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
        Ok(metadata) if !metadata.is_dir() => return Err(unusable("files is not a folder")),
        Ok(_) => {}
    }
    let canonical = dunce::canonicalize(&dir)?;
    if !canonical.starts_with(app_dir) {
        return Err(unusable("files leads outside the app folder"));
    }
    Ok(Some(canonical))
}

pub(crate) fn list(app_dir: &Path) -> io::Result<Vec<Stored>> {
    let Some(dir) = folder(app_dir)? else { return Ok(Vec::new()) };
    let mut files = Vec::new();
    for entry in fs::read_dir(dir)?.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !valid_name(&name) {
            continue;
        }
        let Ok(metadata) = fs::symlink_metadata(entry.path()) else { continue };
        if metadata.file_type().is_file() {
            files.push(stored(&name, &metadata));
        }
    }
    files.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()).then_with(|| a.name.cmp(&b.name)));
    Ok(files)
}

/// Why an upload was refused.
#[derive(Debug)]
pub(crate) enum Refusal {
    Empty,
    TooLarge,
    /// Not an image or a PDF.
    Kind,
    Full,
    Io(io::Error),
}

impl From<io::Error> for Refusal {
    fn from(error: io::Error) -> Self {
        Refusal::Io(error)
    }
}

impl From<Refusal> for ApiError {
    fn from(refusal: Refusal) -> Self {
        let (status, message) = match refusal {
            Refusal::Empty => (StatusCode::BAD_REQUEST, "The file is empty".to_owned()),
            Refusal::TooLarge => (StatusCode::PAYLOAD_TOO_LARGE, "A file can be at most 20 MB".to_owned()),
            Refusal::Kind => (
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                "Only images (PNG, JPEG, GIF, WebP, AVIF) and PDF files can be uploaded".to_owned(),
            ),
            Refusal::Full => (StatusCode::PAYLOAD_TOO_LARGE, format!("An app keeps at most {MAX_FILES} files; remove some first")),
            Refusal::Io(error) if error.kind() == io::ErrorKind::InvalidData => {
                (StatusCode::CONFLICT, format!("The app's files folder is not usable: {error}"))
            }
            Refusal::Io(error) => return ApiError::internal(error),
        };
        ApiError { status, message }
    }
}

/// Stores `bytes` in the app's `files/` under a name made from `given`, and says where.
pub(crate) fn store(app_dir: &Path, given: &str, bytes: &[u8]) -> std::result::Result<Stored, Refusal> {
    if bytes.is_empty() {
        return Err(Refusal::Empty);
    }
    if bytes.len() > MAX_UPLOAD_BYTES {
        return Err(Refusal::TooLarge);
    }
    let (_, extension) = kind_of(bytes).ok_or(Refusal::Kind)?;
    if fs::symlink_metadata(app_dir.join(FOLDER)).is_err() {
        fs::create_dir(app_dir.join(FOLDER))?;
    }
    let dir = folder(app_dir)?.ok_or_else(|| io::Error::from(io::ErrorKind::NotFound))?;
    if fs::read_dir(&dir)?.count() >= MAX_FILES {
        return Err(Refusal::Full);
    }
    let stem = safe_stem(given);
    // Written whole under a hidden name first, then given its name without replacing anything.
    let temporary = dir.join(format!(".{}.upload", uuid::Uuid::new_v4()));
    let written = (|| {
        use std::io::Write;
        let mut file = fs::File::create(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()
    })();
    if let Err(error) = written {
        let _ = fs::remove_file(&temporary);
        return Err(error.into());
    }
    for attempt in 1..=MAX_FILES + 1 {
        let name = if attempt == 1 { format!("{stem}.{extension}") } else { format!("{stem}-{attempt}.{extension}") };
        let target = dir.join(&name);
        // A hard link fails when the name exists, so two uploads of one name never clash.
        match fs::hard_link(&temporary, &target) {
            Ok(()) => {
                let _ = fs::remove_file(&temporary);
                return Ok(stored(&name, &fs::metadata(&target)?));
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                let _ = fs::remove_file(&temporary);
                return Err(error.into());
            }
        }
    }
    let _ = fs::remove_file(&temporary);
    Err(Refusal::Full)
}

/// Removes an uploaded file; whether there was one.
pub(crate) fn remove(app_dir: &Path, name: &str) -> io::Result<bool> {
    let Some(dir) = folder(app_dir)? else { return Ok(false) };
    let target = dir.join(name);
    match fs::symlink_metadata(&target) {
        Ok(metadata) if metadata.file_type().is_file() => fs::remove_file(target).map(|()| true),
        Ok(_) => Ok(false),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

// ---------------------------------------------------------------------------
// Routes

async fn blocking<T: Send + 'static>(
    operation: impl FnOnce() -> std::result::Result<T, Refusal> + Send + 'static,
) -> Result<T> {
    Ok(tokio::task::spawn_blocking(operation).await.map_err(ApiError::internal)??)
}

async fn list_route(State(state): State<AppState>, UrlPath((workspace, slug)): UrlPath<(String, String)>) -> Result<Json<Value>> {
    let dir = find(&state, &workspace, &slug).await?.app.dir;
    let files = blocking(move || Ok(list(&dir)?)).await?;
    Ok(Json(json!({ "files": files })))
}

#[derive(Deserialize)]
struct UploadQuery {
    /// What the person's file was called; only a hint for the stored name.
    name: Option<String>,
}

async fn upload_route(
    State(state): State<AppState>,
    UrlPath((workspace, slug)): UrlPath<(String, String)>,
    Query(query): Query<UploadQuery>,
    body: Bytes,
) -> Result<(StatusCode, Json<Stored>)> {
    let dir = find(&state, &workspace, &slug).await?.app.dir;
    let given = query.name.unwrap_or_default();
    let file = blocking(move || store(&dir, &given, &body)).await?;
    Ok((StatusCode::CREATED, Json(file)))
}

async fn remove_route(
    State(state): State<AppState>,
    UrlPath((workspace, slug, name)): UrlPath<(String, String, String)>,
) -> Result<Json<Value>> {
    let dir = find(&state, &workspace, &slug).await?.app.dir;
    if !valid_name(&name) {
        return Err(ApiError::bad("That is not the name of an uploaded file"));
    }
    let removed = blocking(move || Ok(remove(&dir, &name)?)).await?;
    Ok(Json(json!({ "removed": removed })))
}
