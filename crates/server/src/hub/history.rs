//! File version history: every text file a workspace changes, by the person
//! or by an agent, kept as content-addressed versions that can be compared
//! and restored. Routes live under `/api/hub/history`.
//!
//! Capture does not lean on the upstream watcher (`file_watch.rs`), which only
//! runs while a browser is looking: one task here owns a recursive watcher per
//! workspace, re-reads the workspace list every minute, waits for a path to
//! settle and then stores what it holds. A save from the browser is recorded at
//! once, as the person's, and remembered so the watcher's echo of it is not
//! counted twice or blamed on an agent.
//!
//! Contents live in `<state>/history/blobs/<sha256>`, rows in `file_versions`.
use super::cs;
use crate::{ApiError, AppState, Result, app::db, workspace_io};
use axum::{
    Json, Router,
    extract::{Path, Query, State},
    routing::{get, post},
};
use chrono::{SecondsFormat, Utc};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    path::{Component, Path as FsPath, PathBuf},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant, SystemTime},
};
use tendly_domain::{InteractionMode, SessionId, SessionStatus, WorkspaceId};
use tokio::sync::mpsc;

/// A path is read once it has been quiet this long.
const DEBOUNCE: Duration = Duration::from_millis(1500);
const FLUSH_EVERY: Duration = Duration::from_millis(500);
/// A watcher event this soon after the person saved the same content is the
/// echo of that save.
const SAVED_WINDOW: Duration = Duration::from_secs(10);
const RESYNC_EVERY: Duration = Duration::from_secs(60);
const COLLECT_EVERY: Duration = Duration::from_secs(60 * 60);
/// A blob younger than this is never collected: its row may not be written yet.
const BLOB_GRACE: Duration = Duration::from_secs(10 * 60);
pub(crate) const MAX_BYTES: usize = 1024 * 1024;
const VERSIONS_KEPT: i64 = 100;
const DAYS_KEPT: i64 = 60;
/// More files than this settling at once in one workspace is a checkout,
/// an install or a generator, not editing: none of them is recorded.
const MAX_BURST: usize = 200;
/// Dependency and build output: never versioned.
pub(super) const BUILD_DIRS: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    "coverage",
    "vendor",
    "__pycache__",
    "venv",
    "bower_components",
    "Pods",
    "DerivedData",
];

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/hub/history", get(list_route))
        .route("/api/hub/history/versions/{id}", get(version_route))
        .route("/api/hub/history/versions/{id}/restore", post(restore_route))
}

// ---------------------------------------------------------------------------
// Model

#[derive(Debug, Clone, Serialize, PartialEq)]
pub(crate) struct Version {
    pub id: i64,
    pub workspace_id: String,
    pub path: String,
    pub blob: String,
    pub size: i64,
    /// `you`, `agent` or `unknown`.
    pub author_kind: String,
    pub session_id: Option<String>,
    pub created_at: String,
    /// One line of what the agent said it was doing, on an agent's version.
    pub message: Option<String>,
}

const COLUMNS: &str = "id, workspace_id, path, blob, size, author_kind, session_id, created_at, message";

impl Version {
    fn from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: r.get(0)?,
            workspace_id: r.get(1)?,
            path: r.get(2)?,
            blob: r.get(3)?,
            size: r.get(4)?,
            author_kind: r.get(5)?,
            session_id: r.get(6)?,
            created_at: r.get(7)?,
            message: r.get(8)?,
        })
    }
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Author {
    kind: &'static str,
    session: Option<SessionId>,
}

impl Author {
    const YOU: Self = Self { kind: "you", session: None };
    const UNKNOWN: Self = Self { kind: "unknown", session: None };
    fn agent(session: SessionId) -> Self {
        Self { kind: "agent", session: Some(session) }
    }
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub(crate) fn hash(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// The text a file holds, when it is a file history keeps: valid UTF-8, no
/// NUL byte, at most 1 MB.
pub(crate) fn text_of(bytes: &[u8]) -> Option<&str> {
    if bytes.len() > MAX_BYTES || bytes.contains(&0) {
        return None;
    }
    std::str::from_utf8(bytes).ok()
}

/// A workspace-relative path as history stores it: `a/b.txt`, no `./`.
fn normalize(path: &str) -> Option<String> {
    let rel = workspace_io::safe_relative(path).ok()?;
    let parts: Vec<_> = rel
        .components()
        .filter_map(|c| match c {
            Component::Normal(part) => Some(part.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect();
    (!parts.is_empty()).then(|| parts.join("/"))
}

/// Paths never versioned whatever `.gitignore` says: anything inside a
/// dot-directory (`.git`, `.next`, `.venv`…), dependency and build output,
/// editor swap files and what Tendly protects.
pub(crate) fn ignored(relative: &FsPath) -> bool {
    let parts: Vec<String> = relative
        .components()
        .filter_map(|c| match c {
            Component::Normal(part) => Some(part.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect();
    let Some((name, dirs)) = parts.split_last() else { return true };
    dirs.iter().any(|dir| dir.starts_with('.') || BUILD_DIRS.contains(&dir.as_str()))
        || name.ends_with(".swp")
        || name.ends_with(".swx")
        || name.ends_with('~')
        || name == ".DS_Store"
        || workspace_io::is_protected_path(relative)
}

/// Which of these paths the repository ignores (`.gitignore`, the global
/// excludes, `info/exclude`). Outside a repository, or when Git is missing,
/// nothing is.
pub(super) async fn git_ignored(root: &FsPath, paths: &[String]) -> HashSet<String> {
    if paths.is_empty() || !root.join(".git").exists() {
        return HashSet::new();
    }
    let child = tokio::process::Command::new("git")
        .args(["check-ignore", "--stdin", "-z"])
        .current_dir(root)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn();
    let Ok(mut child) = child else { return HashSet::new() };
    let mut input = Vec::new();
    for path in paths {
        input.extend_from_slice(path.as_bytes());
        input.push(0);
    }
    if let Some(mut stdin) = child.stdin.take() {
        use tokio::io::AsyncWriteExt;
        let _ = stdin.write_all(&input).await;
    }
    match tokio::time::timeout(Duration::from_secs(10), child.wait_with_output()).await {
        Ok(Ok(output)) => output
            .stdout
            .split(|b| *b == 0)
            .filter(|p| !p.is_empty())
            .map(|p| String::from_utf8_lossy(p).into_owned())
            .collect(),
        _ => HashSet::new(),
    }
}

// ---------------------------------------------------------------------------
// Storage

pub(super) fn blob_dir(state: &AppState) -> PathBuf {
    state.state_dir.join("history").join("blobs")
}

fn write_blob(blobs: &FsPath, hash: &str, bytes: &[u8]) -> std::io::Result<()> {
    let target = blobs.join(hash);
    if target.is_file() {
        return Ok(());
    }
    std::fs::create_dir_all(blobs)?;
    let temporary = blobs.join(format!(".{hash}.{}", uuid::Uuid::new_v4()));
    std::fs::write(&temporary, bytes)?;
    std::fs::rename(&temporary, &target)
}

pub(super) fn read_blob(blobs: &FsPath, hash: &str) -> Option<String> {
    if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let bytes = std::fs::read(blobs.join(hash)).ok()?;
    String::from_utf8(bytes).ok()
}

fn latest(c: &Connection, workspace: &str, path: &str) -> rusqlite::Result<Option<Version>> {
    c.query_row(
        &format!("SELECT {COLUMNS} FROM file_versions WHERE workspace_id = ?1 AND path = ?2 ORDER BY id DESC LIMIT 1"),
        params![workspace, path],
        Version::from_row,
    )
    .optional()
}

fn load(c: &Connection, id: i64) -> rusqlite::Result<Option<Version>> {
    c.query_row(&format!("SELECT {COLUMNS} FROM file_versions WHERE id = ?1"), [id], Version::from_row)
        .optional()
}

fn list(c: &Connection, workspace: &str, path: &str) -> rusqlite::Result<Vec<Version>> {
    let mut stmt = c.prepare(&format!(
        "SELECT {COLUMNS} FROM file_versions WHERE workspace_id = ?1 AND path = ?2 ORDER BY id DESC"
    ))?;
    stmt.query_map(params![workspace, path], Version::from_row)?.collect()
}

/// A new version, unless the file already holds what its latest version
/// holds; either way the file's oldest versions past the limits are dropped.
fn insert(
    c: &Connection,
    workspace: &str,
    path: &str,
    blob: &str,
    size: usize,
    author: &Author,
    message: Option<&str>,
    at: &str,
) -> rusqlite::Result<Option<Version>> {
    if latest(c, workspace, path)?.is_some_and(|v| v.blob == blob) {
        return Ok(None);
    }
    c.execute(
        "INSERT INTO file_versions(workspace_id, path, blob, size, author_kind, session_id, created_at, message)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![workspace, path, blob, size as i64, author.kind, author.session.map(|s| s.to_string()), at, message],
    )?;
    let id = c.last_insert_rowid();
    prune(c, workspace, path, &cutoff())?;
    load(c, id)
}

fn cutoff() -> String {
    (Utc::now() - chrono::Duration::days(DAYS_KEPT)).to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// At most `VERSIONS_KEPT` versions of a file, none older than `older_than`,
/// but always its newest.
fn prune(c: &Connection, workspace: &str, path: &str, older_than: &str) -> rusqlite::Result<usize> {
    c.execute(
        "DELETE FROM file_versions WHERE workspace_id = ?1 AND path = ?2 AND id NOT IN (
            SELECT id FROM file_versions WHERE workspace_id = ?1 AND path = ?2 ORDER BY id DESC LIMIT 1
         ) AND (
            created_at < ?3 OR id NOT IN (
                SELECT id FROM file_versions WHERE workspace_id = ?1 AND path = ?2 ORDER BY id DESC LIMIT ?4
            )
         )",
        params![workspace, path, older_than, VERSIONS_KEPT],
    )
}

/// Age limits for files that stopped changing, then blobs nothing names.
fn collect(c: &Connection, blobs: &FsPath, older_than: &str) -> rusqlite::Result<usize> {
    c.execute(
        "DELETE FROM file_versions WHERE created_at < ?1 AND id NOT IN (
            SELECT MAX(id) FROM file_versions GROUP BY workspace_id, path
         )",
        [older_than],
    )?;
    let referenced: HashSet<String> = c
        .prepare("SELECT DISTINCT blob FROM file_versions")?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let Ok(entries) = std::fs::read_dir(blobs) else { return Ok(0) };
    let mut removed = 0;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if referenced.contains(&name) {
            continue;
        }
        let young = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|m| SystemTime::now().duration_since(m).ok())
            .is_none_or(|age| age < BLOB_GRACE);
        if !young && std::fs::remove_file(entry.path()).is_ok() {
            removed += 1;
        }
    }
    Ok(removed)
}

/// Stores `bytes` as a version of `path`: the blob first, then the row.
fn record_blocking(
    store: &super::HubStore,
    blobs: &FsPath,
    workspace: WorkspaceId,
    path: &str,
    bytes: &[u8],
    author: &Author,
    message: Option<&str>,
) -> std::result::Result<Option<Version>, String> {
    let blob = hash(bytes);
    write_blob(blobs, &blob, bytes).map_err(|e| e.to_string())?;
    store
        .with(|c| insert(c, &workspace.to_string(), path, &blob, bytes.len(), author, message, &now()))
        .map_err(|e| e.to_string())
}

/// Keeps what a file holds as a version of it, unless its latest version
/// already holds that: the apps' reload (`apps/live.rs`) calls it so that what
/// an app's file held before a change can always be put back.
pub(super) fn keep(
    store: &super::HubStore,
    blobs: &FsPath,
    workspace: WorkspaceId,
    path: &str,
    bytes: &[u8],
) -> std::result::Result<(), String> {
    record_blocking(store, blobs, workspace, path, bytes, &Author::UNKNOWN, None).map(|_| ())
}

/// The content hash of a file's latest version, if it has one.
pub(super) fn latest_blob(store: &super::HubStore, workspace: WorkspaceId, path: &str) -> Option<String> {
    store.with(|c| latest(c, &workspace.to_string(), path)).ok().flatten().map(|version| version.blob)
}

// ---------------------------------------------------------------------------
// Attribution

/// What the person saved lately: workspace and path to content hash and when.
#[derive(Default)]
pub(crate) struct Saved {
    entries: Mutex<HashMap<(WorkspaceId, String), (String, Instant)>>,
}

impl Saved {
    fn remember(&self, workspace: WorkspaceId, path: &str, hash: &str) {
        let mut entries = self.entries.lock().expect("saved");
        entries.retain(|_, (_, at)| at.elapsed() < SAVED_WINDOW);
        entries.insert((workspace, path.to_owned()), (hash.to_owned(), Instant::now()));
    }

    fn was_saved(&self, workspace: WorkspaceId, path: &str, hash: &str) -> bool {
        let entries = self.entries.lock().expect("saved");
        entries
            .get(&(workspace, path.to_owned()))
            .is_some_and(|(saved, at)| saved == hash && at.elapsed() < SAVED_WINDOW)
    }
}

fn saved() -> &'static Saved {
    static SAVED: OnceLock<Saved> = OnceLock::new();
    SAVED.get_or_init(Saved::default)
}

/// Who most likely wrote content that showed up on disk.
fn attribute(saved: &Saved, workspace: WorkspaceId, path: &str, hash: &str, agent: Option<SessionId>) -> Author {
    if saved.was_saved(workspace, path, hash) {
        Author::YOU
    } else if let Some(session) = agent {
        Author::agent(session)
    } else {
        Author::UNKNOWN
    }
}

/// The structured conversation running in the workspace directory itself
/// (not a worktree) that was active last, if any.
async fn running_agent(state: &AppState, workspace: WorkspaceId) -> Option<SessionId> {
    let sessions = db(state, move |s| s.list_sessions(Some(workspace))).await.ok()?;
    sessions
        .into_iter()
        .filter(|s| {
            matches!(s.interaction_mode, InteractionMode::Structured)
                && matches!(s.status, SessionStatus::Running | SessionStatus::Starting)
                && s.checkout_path.is_none()
                && s.provider.is_agent()
        })
        .max_by_key(|s| s.updated_at)
        .map(|s| s.id)
}

/// How long a version's message may be.
const MESSAGE_CHARS: usize = 80;
/// The latest events read to find what the agent said last.
const MESSAGE_EVENTS: usize = 400;
/// A sentence shorter than this ("Done.", "Sure!") carries on into the next.
const SHORT_SENTENCE: usize = 16;

/// What the agent of `session` said last in the turn it is running, as one
/// line: the message kept with the versions it writes. Read from the stored
/// conversation; no model is asked anything.
async fn agent_message(state: &AppState, session: SessionId) -> Option<String> {
    db(state, move |s| Ok(stored_message(s, session))).await.ok().flatten()
}

fn stored_message(store: &tendly_persistence::Store, session: SessionId) -> Option<String> {
    let page = store.conversation_page(session, None, MESSAGE_EVENTS).ok()?;
    summary_line(&super::transcript::last_agent_text(&page.events)?)
}

/// `[text](address)` becomes `text`.
fn without_links(text: &str) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some(open) = rest.find('[') {
        let after = &rest[open + 1..];
        let link = after
            .find("](")
            .and_then(|close| after[close + 2..].find(')').map(|end| (close, close + 2 + end + 1)));
        match link {
            Some((close, next)) if !after[..close].contains('[') => {
                out.push_str(&rest[..open]);
                out.push_str(&after[..close]);
                rest = &after[next..];
            }
            _ => {
                out.push_str(&rest[..=open]);
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// One line summing up what an agent said: the first sentence of its first
/// line of prose, without Markdown marks, at most 80 characters.
pub(crate) fn summary_line(said: &str) -> Option<String> {
    let mut fenced = false;
    let line = said.lines().map(str::trim).find(|line| {
        if line.starts_with("```") || line.starts_with("~~~") {
            fenced = !fenced;
            return false;
        }
        !fenced && line.chars().any(char::is_alphanumeric)
    })?;
    // Heading, quote and list marks, then a list number ("1. ", "2) ").
    let line = line.trim_start_matches(|c: char| matches!(c, '#' | '>' | '-' | '*' | '+' | ' '));
    let digits = line.chars().take_while(char::is_ascii_digit).count();
    let line = match line[digits..].strip_prefix(['.', ')']) {
        Some(rest) if digits > 0 && rest.starts_with(' ') => rest,
        _ => line,
    };
    let plain = without_links(line).replace("**", "").replace("__", "").replace('`', "");
    let chars: Vec<char> = plain.split_whitespace().collect::<Vec<_>>().join(" ").chars().collect();
    let end = (0..chars.len())
        .find(|&i| {
            matches!(chars[i], '.' | '!' | '?')
                && i + 1 >= SHORT_SENTENCE
                && chars.get(i + 1).is_none_or(|next| next.is_whitespace())
        })
        .map_or(chars.len(), |i| i + 1);
    let sentence: String = chars[..end].iter().collect();
    let sentence = sentence.trim_end_matches([':', ' ']);
    let line = super::transcript::one_line(sentence, MESSAGE_CHARS);
    (!line.is_empty()).then_some(line)
}

/// The person saved this file from the browser.
pub async fn record_saved(state: &AppState, workspace: WorkspaceId, path: &str, content: &str) {
    let Some(path) = normalize(path) else { return };
    if text_of(content.as_bytes()).is_none() {
        return;
    }
    saved().remember(workspace, &path, &hash(content.as_bytes()));
    let store = state.hub.clone();
    let blobs = blob_dir(state);
    let bytes = content.as_bytes().to_vec();
    let done = tokio::task::spawn_blocking(move || record_blocking(&store, &blobs, workspace, &path, &bytes, &Author::YOU, None)).await;
    if let Ok(Err(error)) = done {
        tracing::warn!(%error, "file history: could not record a save");
    }
}

// ---------------------------------------------------------------------------
// Capture

/// Reads a file that settled and records it, when history keeps it.
fn capture(
    store: &super::HubStore,
    blobs: &FsPath,
    saved: &Saved,
    root: &FsPath,
    workspace: WorkspaceId,
    path: &str,
    agent: Option<SessionId>,
    said: Option<&str>,
) -> std::result::Result<Option<Version>, String> {
    let target = root.join(path);
    // Deleted, a folder or a link: no version.
    let Ok(meta) = std::fs::symlink_metadata(&target) else { return Ok(None) };
    if !meta.is_file() || meta.len() as usize > MAX_BYTES {
        return Ok(None);
    }
    let Ok(bytes) = std::fs::read(&target) else { return Ok(None) };
    if text_of(&bytes).is_none() {
        return Ok(None);
    }
    let author = attribute(saved, workspace, path, &hash(&bytes), agent);
    // What the agent said belongs to the agent's versions only.
    let message = said.filter(|_| author.kind == "agent");
    record_blocking(store, blobs, workspace, path, &bytes, &author, message)
}

struct Watched {
    root: PathBuf,
    _watcher: RecommendedWatcher,
}

/// Starts watching the workspaces for changes. Called once from `hub::warm`.
pub fn start(state: AppState) {
    tokio::spawn(run(state));
}

async fn run(state: AppState) {
    let (sender, mut events) = mpsc::unbounded_channel::<(WorkspaceId, PathBuf)>();
    let mut watched: HashMap<WorkspaceId, Watched> = HashMap::new();
    let mut pending: HashMap<(WorkspaceId, String), Instant> = HashMap::new();
    let mut resync = tokio::time::interval(RESYNC_EVERY);
    let mut collect_timer = tokio::time::interval(COLLECT_EVERY);
    let mut flush = tokio::time::interval(FLUSH_EVERY);
    for timer in [&mut resync, &mut collect_timer, &mut flush] {
        timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    }
    loop {
        tokio::select! {
            Some((workspace, absolute)) = events.recv() => {
                let Some(root) = watched.get(&workspace).map(|w| &w.root) else { continue };
                let Ok(relative) = absolute.strip_prefix(root) else { continue };
                if ignored(relative) { continue }
                let Some(path) = relative.to_str().and_then(normalize) else { continue };
                // An app's files: its open panes reload once the change settles (`apps/live.rs`).
                state.hub.app_live.touched(workspace, root, &path);
                pending.insert((workspace, path), Instant::now() + DEBOUNCE);
            }
            _ = resync.tick() => sync(&state, &mut watched, &sender).await,
            _ = collect_timer.tick() => {
                let blobs = blob_dir(&state);
                let older = cutoff();
                if let Err(error) = cs(&state, move |c| collect(c, &blobs, &older)).await {
                    tracing::warn!(error = %error.message, "file history: collection failed");
                }
            }
            _ = flush.tick() => {
                let now = Instant::now();
                let due: Vec<_> = pending.iter().filter(|(_, at)| **at <= now).map(|(key, _)| key.clone()).collect();
                if due.is_empty() { continue }
                let mut by_workspace: HashMap<WorkspaceId, Vec<String>> = HashMap::new();
                for key in due {
                    pending.remove(&key);
                    by_workspace.entry(key.0).or_default().push(key.1);
                }
                for (workspace, paths) in by_workspace {
                    let Some(root) = watched.get(&workspace).map(|w| w.root.clone()) else { continue };
                    settle(&state, workspace, root, paths).await;
                }
            }
        }
    }
}

/// Watches every workspace the store lists, and only those.
async fn sync(
    state: &AppState,
    watched: &mut HashMap<WorkspaceId, Watched>,
    sender: &mpsc::UnboundedSender<(WorkspaceId, PathBuf)>,
) {
    let Ok(workspaces) = db(state, |s| s.list_workspaces()).await else { return };
    let listed: HashSet<WorkspaceId> = workspaces.iter().map(|w| w.id).collect();
    watched.retain(|id, _| listed.contains(id));
    for workspace in workspaces {
        if watched.contains_key(&workspace.id) {
            continue;
        }
        let id = workspace.id;
        let sender = sender.clone();
        let made = tokio::task::spawn_blocking(move || -> std::result::Result<Watched, String> {
            let root = dunce::canonicalize(&workspace.root_path).map_err(|e| e.to_string())?;
            if !root.is_dir() {
                return Err("not a directory".into());
            }
            let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
                let Ok(event) = event else { return };
                if matches!(event.kind, notify::EventKind::Access(_)) {
                    return;
                }
                for path in event.paths {
                    let _ = sender.send((id, path));
                }
            })
            .map_err(|e| e.to_string())?;
            watcher.watch(&root, RecursiveMode::Recursive).map_err(|e| e.to_string())?;
            Ok(Watched { root, _watcher: watcher })
        })
        .await;
        match made {
            Ok(Ok(watch)) => {
                watched.insert(id, watch);
            }
            Ok(Err(error)) => tracing::debug!(workspace = %id, %error, "file history: not watching"),
            Err(error) => tracing::warn!(workspace = %id, %error, "file history: watch task failed"),
        }
    }
}

/// Records the files of one workspace that settled.
pub(super) async fn settle(state: &AppState, workspace: WorkspaceId, root: PathBuf, mut paths: Vec<String>) {
    if paths.len() > MAX_BURST {
        tracing::info!(workspace = %workspace, count = paths.len(), "file history: skipped a burst of changes");
        return;
    }
    let ignored = git_ignored(&root, &paths).await;
    paths.retain(|p| !ignored.contains(p));
    if paths.is_empty() {
        return;
    }
    let agent = running_agent(state, workspace).await;
    let said = match agent {
        Some(session) => agent_message(state, session).await,
        None => None,
    };
    let store = state.hub.clone();
    let blobs = blob_dir(state);
    let done = tokio::task::spawn_blocking(move || {
        for path in paths {
            if let Err(error) = capture(&store, &blobs, saved(), &root, workspace, &path, agent, said.as_deref()) {
                tracing::warn!(%error, %path, "file history: could not record a change");
            }
        }
    })
    .await;
    if let Err(error) = done {
        tracing::warn!(%error, "file history: capture task failed");
    }
}

// ---------------------------------------------------------------------------
// Routes

#[derive(Deserialize)]
struct ListQuery {
    workspace_id: WorkspaceId,
    path: String,
}

async fn session_titles(state: &AppState, versions: &[Version]) -> HashMap<String, String> {
    let ids: HashSet<String> = versions.iter().filter_map(|v| v.session_id.clone()).collect();
    let mut titles = HashMap::new();
    for id in ids {
        let Ok(session) = uuid::Uuid::parse_str(&id) else { continue };
        if let Ok(Some(found)) = db(state, move |s| s.get_session(session)).await {
            titles.insert(id, found.title);
        }
    }
    titles
}

fn view(version: &Version, titles: &HashMap<String, String>) -> Value {
    json!({
        "id": version.id,
        "workspace_id": version.workspace_id,
        "path": version.path,
        "size": version.size,
        "author_kind": version.author_kind,
        "session_id": version.session_id,
        "session_title": version.session_id.as_ref().and_then(|id| titles.get(id)),
        "created_at": version.created_at,
        "message": version.message,
    })
}

async fn list_route(State(state): State<AppState>, Query(query): Query<ListQuery>) -> Result<Json<Value>> {
    let path = normalize(&query.path).ok_or_else(|| ApiError::bad("Path required"))?;
    let workspace = query.workspace_id.to_string();
    let versions = cs(&state, move |c| list(c, &workspace, &path)).await?;
    let titles = session_titles(&state, &versions).await;
    Ok(Json(json!({ "versions": versions.iter().map(|v| view(v, &titles)).collect::<Vec<_>>() })))
}

async fn found(state: &AppState, id: i64) -> Result<Version> {
    cs(state, move |c| load(c, id)).await?.ok_or_else(|| ApiError::missing("Version"))
}

async fn content_of(state: &AppState, version: &Version) -> Result<String> {
    let blobs = blob_dir(state);
    let blob = version.blob.clone();
    tokio::task::spawn_blocking(move || read_blob(&blobs, &blob))
        .await
        .map_err(ApiError::internal)?
        .ok_or_else(|| ApiError::missing("Version content"))
}

async fn version_route(State(state): State<AppState>, Path(id): Path<i64>) -> Result<Json<Value>> {
    let version = found(&state, id).await?;
    let content = content_of(&state, &version).await?;
    let titles = session_titles(&state, std::slice::from_ref(&version)).await;
    let mut body = view(&version, &titles);
    body["content"] = Value::String(content);
    Ok(Json(body))
}

/// Writes `content` back to `path` and records it as the person's version.
/// Returns the version the file is now at.
pub(super) async fn restore_into(
    store: super::Hub,
    blobs: PathBuf,
    root: &FsPath,
    workspace: WorkspaceId,
    path: &str,
    content: &str,
) -> Result<Version> {
    // Whatever the file holds now is replaced: the caller holds the
    // operations lock, and what it held is a version already.
    let current = match workspace_io::read_file(root, path).await {
        Ok(file) => Some(file.version),
        Err(error) if error.status == 404 => None,
        Err(error) => return Err(error.into()),
    };
    workspace_io::write_file(root, path, content, current.as_deref()).await?;
    saved().remember(workspace, path, &hash(content.as_bytes()));
    let path = path.to_owned();
    let bytes = content.as_bytes().to_vec();
    tokio::task::spawn_blocking(move || -> std::result::Result<Version, String> {
        if let Some(new) = record_blocking(&store, &blobs, workspace, &path, &bytes, &Author::YOU, None)? {
            return Ok(new);
        }
        store
            .with(|c| latest(c, &workspace.to_string(), &path))
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "no version".to_owned())
    })
    .await
    .map_err(ApiError::internal)?
    .map_err(ApiError::internal)
}

async fn restore_route(State(state): State<AppState>, Path(id): Path<i64>) -> Result<Json<Value>> {
    let version = found(&state, id).await?;
    let content = content_of(&state, &version).await?;
    let workspace = uuid::Uuid::parse_str(&version.workspace_id).map_err(ApiError::internal)?;
    let root = crate::app::root(&state, workspace).await?;
    let restored = {
        let _guard = state.operations.lock().await;
        restore_into(state.hub.clone(), blob_dir(&state), &root, workspace, &version.path, &content).await?
    };
    let titles = session_titles(&state, std::slice::from_ref(&restored)).await;
    Ok(Json(view(&restored, &titles)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hub::HubStore;
    use std::sync::Arc;

    fn temp() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hub-history-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dunce::canonicalize(dir).unwrap()
    }

    fn count(store: &HubStore) -> i64 {
        store.with(|c| c.query_row("SELECT COUNT(*) FROM file_versions", [], |r| r.get(0))).unwrap()
    }

    #[test]
    fn hub_history_identical_content_is_one_version() {
        let dir = temp();
        let store = HubStore::memory();
        let blobs = dir.join("blobs");
        let ws = uuid::Uuid::new_v4();
        let first = record_blocking(&store, &blobs, ws, "a.txt", b"one", &Author::UNKNOWN, None).unwrap();
        assert!(first.is_some());
        assert!(record_blocking(&store, &blobs, ws, "a.txt", b"one", &Author::UNKNOWN, None).unwrap().is_none());
        assert_eq!(count(&store), 1);
        // Same content elsewhere shares the blob but is its own version.
        record_blocking(&store, &blobs, ws, "b.txt", b"one", &Author::UNKNOWN, None).unwrap().unwrap();
        record_blocking(&store, &blobs, ws, "a.txt", b"two", &Author::UNKNOWN, None).unwrap().unwrap();
        // Back to earlier content is a change too.
        record_blocking(&store, &blobs, ws, "a.txt", b"one", &Author::UNKNOWN, None).unwrap().unwrap();
        assert_eq!(count(&store), 4);
        assert_eq!(std::fs::read_dir(&blobs).unwrap().count(), 2);
        assert_eq!(read_blob(&blobs, &hash(b"two")).as_deref(), Some("two"));
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn hub_history_saved_then_watched_change_is_yours() {
        let dir = temp();
        let root = dir.join("ws");
        std::fs::create_dir_all(&root).unwrap();
        let blobs = dir.join("blobs");
        let store = HubStore::memory();
        let saved = Saved::default();
        let ws = uuid::Uuid::new_v4();
        let agent = uuid::Uuid::new_v4();
        // The browser save: recorded at once and remembered.
        saved.remember(ws, "notes.md", &hash(b"mine"));
        record_blocking(&store, &blobs, ws, "notes.md", b"mine", &Author::YOU, None).unwrap().unwrap();
        // Its echo from the watcher, while an agent runs: still one version, yours.
        std::fs::write(root.join("notes.md"), "mine").unwrap();
        assert!(capture(&store, &blobs, &saved, &root, ws, "notes.md", Some(agent), None).unwrap().is_none());
        // Without the save on record the same content would be the agent's.
        assert_eq!(attribute(&Saved::default(), ws, "notes.md", &hash(b"mine"), Some(agent)), Author::agent(agent));
        // A later different change while the agent runs is the agent's.
        std::fs::write(root.join("notes.md"), "agent edit").unwrap();
        let v = capture(&store, &blobs, &saved, &root, ws, "notes.md", Some(agent), None).unwrap().unwrap();
        assert_eq!((v.author_kind.as_str(), v.session_id), ("agent", Some(agent.to_string())));
        // With nothing running it is from outside Tendly.
        std::fs::write(root.join("notes.md"), "elsewhere").unwrap();
        let v = capture(&store, &blobs, &saved, &root, ws, "notes.md", None, None).unwrap().unwrap();
        assert_eq!(v.author_kind, "unknown");
        let kinds: Vec<String> = store
            .with(|c| list(c, &ws.to_string(), "notes.md"))
            .unwrap()
            .into_iter()
            .map(|v| v.author_kind)
            .collect();
        assert_eq!(kinds, ["unknown", "agent", "you"]);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn hub_history_retention_keeps_100_and_drops_old_but_never_the_newest() {
        let store = HubStore::memory();
        let ws = "w";
        store
            .with(|c| {
                for i in 0..(VERSIONS_KEPT + 5) {
                    insert(c, ws, "f", &format!("{i:064}"), 1, &Author::UNKNOWN, None, &now())?;
                }
                let kept = list(c, ws, "f")?;
                assert_eq!(kept.len() as i64, VERSIONS_KEPT);
                assert_eq!(kept[0].blob, format!("{:064}", VERSIONS_KEPT + 4));
                // Old versions of a file: all go but the newest.
                for i in 0..3 {
                    insert(c, ws, "old", &format!("{i:064}"), 1, &Author::UNKNOWN, None, "2020-01-01T00:00:00.000Z")?;
                }
                prune(c, ws, "old", &cutoff())?;
                let left = list(c, ws, "old")?;
                assert_eq!(left.len(), 1);
                assert_eq!(left[0].blob, format!("{:064}", 2));
                Ok(())
            })
            .unwrap();
        // Collection: unreferenced blobs past the grace period go, the rest stay.
        let dir = temp();
        store
            .with(|c| {
                insert(c, ws, "g", &"a".repeat(64), 1, &Author::UNKNOWN, None, "2020-01-01T00:00:00.000Z")?;
                insert(c, ws, "g", &"b".repeat(64), 1, &Author::UNKNOWN, None, "2020-01-02T00:00:00.000Z")?;
                Ok(())
            })
            .unwrap();
        for name in ["a", "b", "c"] {
            let path = dir.join(name.repeat(64));
            std::fs::write(&path, name).unwrap();
            let old = SystemTime::now() - Duration::from_secs(3600);
            std::fs::File::options().write(true).open(&path).unwrap().set_modified(old).unwrap();
        }
        std::fs::write(dir.join("d".repeat(64)), "fresh").unwrap();
        store.with(|c| collect(c, &dir, &cutoff())).unwrap();
        let mut left: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().chars().next().unwrap().to_string())
            .collect();
        left.sort();
        assert_eq!(left, ["b", "d"], "a lost its row, c never had one, d is too young");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn hub_history_rejects_binary_and_large_files() {
        assert!(text_of(b"plain text\n").is_some());
        assert!(text_of(b"nul\0inside").is_none());
        assert!(text_of(&[0xff, 0xfe, 0x41]).is_none());
        assert!(text_of(&vec![b'a'; MAX_BYTES]).is_some());
        assert!(text_of(&vec![b'a'; MAX_BYTES + 1]).is_none());
        let dir = temp();
        let store = HubStore::memory();
        let ws = uuid::Uuid::new_v4();
        std::fs::write(dir.join("image.png"), [0x89, b'P', b'N', b'G', 0, 0]).unwrap();
        std::fs::write(dir.join("big.log"), vec![b'x'; MAX_BYTES + 1]).unwrap();
        for path in ["image.png", "big.log", "missing.txt"] {
            assert!(capture(&store, &dir.join("blobs"), &Saved::default(), &dir, ws, path, None, None).unwrap().is_none(), "{path}");
        }
        assert_eq!(count(&store), 0);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn hub_history_message_is_one_short_line_of_what_the_agent_said() {
        let line = |said: &str| summary_line(said).unwrap_or_default();
        assert_eq!(line("I'll tighten the title. Then I'll fix the footer."), "I'll tighten the title.");
        // A short opener carries on into the next sentence.
        assert_eq!(line("Pronto! Ajustei o título e o rodapé. Quer ver?"), "Pronto! Ajustei o título e o rodapé.");
        // Markdown marks, list numbers, links and code fences are not prose.
        assert_eq!(line("## **Updating** `index.html` now:\n\nmore"), "Updating index.html now");
        assert_eq!(line("```js\nconst a = 1;\n```\n1. Rename [the page](https://example.com/a) title"), "Rename the page title");
        assert_eq!(line("- [ ] keep this [bracket"), "[ ] keep this [bracket");
        // A dot inside a name or a number ends nothing.
        assert_eq!(line("Bumped version 1.2.3 in package.json and the lockfile"), "Bumped version 1.2.3 in package.json and the lockfile");
        // Long sentences are cut on characters, not bytes.
        let long = line(&"é".repeat(200));
        assert_eq!(long.chars().count(), MESSAGE_CHARS);
        assert!(long.ends_with('…'));
        assert_eq!(line("  folded   over\ttabs  "), "folded over tabs");
        for nothing in ["", "   \n\n", "```\ncode only\n```", "---", "***"] {
            assert_eq!(summary_line(nothing), None, "{nothing:?}");
        }
    }

    #[test]
    fn hub_history_agent_versions_keep_the_message_and_others_do_not() {
        let dir = temp();
        let root = dir.join("ws");
        std::fs::create_dir_all(&root).unwrap();
        let blobs = dir.join("blobs");
        let store = HubStore::memory();
        let saved = Saved::default();
        let ws = uuid::Uuid::new_v4();
        let agent = uuid::Uuid::new_v4();
        std::fs::write(root.join("a.md"), "one").unwrap();
        let v = capture(&store, &blobs, &saved, &root, ws, "a.md", Some(agent), Some("Tightened the title.")).unwrap().unwrap();
        assert_eq!((v.author_kind.as_str(), v.message.as_deref()), ("agent", Some("Tightened the title.")));
        // The person's own save while the agent runs is not given the agent's words.
        saved.remember(ws, "a.md", &hash(b"mine"));
        std::fs::write(root.join("a.md"), "mine").unwrap();
        let v = capture(&store, &blobs, &saved, &root, ws, "a.md", Some(agent), Some("Tightened the title.")).unwrap().unwrap();
        assert_eq!((v.author_kind.as_str(), v.message), ("you", None));
        // An agent that has said nothing yet leaves the message empty.
        std::fs::write(root.join("a.md"), "three").unwrap();
        let v = capture(&store, &blobs, &saved, &root, ws, "a.md", Some(agent), None).unwrap().unwrap();
        assert_eq!((v.author_kind.as_str(), v.message), ("agent", None));
        // The API shows the message beside the version.
        let listed = store.with(|c| list(c, &ws.to_string(), "a.md")).unwrap();
        let shown: Vec<Value> = listed.iter().map(|v| view(v, &HashMap::new())["message"].clone()).collect();
        assert_eq!(shown, [Value::Null, Value::Null, json!("Tightened the title.")]);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn hub_history_message_comes_from_the_stored_conversation() {
        let store = tendly_persistence::Store::open(":memory:").unwrap();
        let dir = temp();
        let workspace = store.create_workspace("talk", dir.to_str().unwrap()).unwrap();
        let session = store
            .create_session(workspace.id, tendly_domain::ProviderKind::ClaudeCode, "Landing page")
            .unwrap()
            .id;
        // Nothing said yet: no message.
        assert_eq!(stored_message(&store, session), None);
        let say = |event: Value| {
            store.append_conversation_event(session, event).unwrap();
        };
        say(json!({"type":"message","id":"u1","role":"user","text":"Fix the hero title","delta":false}));
        assert_eq!(stored_message(&store, session), None);
        say(json!({"type":"message","id":"a1","role":"assistant","text":"I'll shorten the **hero title** ","delta":true}));
        say(json!({"type":"message","id":"a1","role":"assistant","text":"in `index.html`. Then the footer.","delta":true}));
        say(json!({"type":"tool","id":"t1","name":"Edit","status":"running","text":"{\"file_path\":\"index.html\"}"}));
        assert_eq!(stored_message(&store, session).as_deref(), Some("I'll shorten the hero title in index.html."));
        // The next turn starts clean.
        say(json!({"type":"message","id":"u2","role":"user","text":"Thanks","delta":false}));
        assert_eq!(stored_message(&store, session), None);
        // A conversation that does not exist has nothing to say.
        assert_eq!(stored_message(&store, uuid::Uuid::new_v4()), None);
        std::fs::remove_dir_all(dir).ok();
    }

    #[tokio::test]
    async fn hub_history_ignore_rules() {
        for skipped in [
            ".git/config",
            ".next/cache/a.js",
            "src/.cache/x.txt",
            "node_modules/pkg/index.js",
            "crates/server/target/debug/build.rs",
            "web/dist/index.html",
            "notes.md.swp",
            "notes.md~",
            ".ssh/id_ed25519",
        ] {
            assert!(ignored(FsPath::new(skipped)), "{skipped}");
        }
        for kept in ["README.md", "src/app.ts", ".gitignore", "docs/build-notes.md"] {
            assert!(!ignored(FsPath::new(kept)), "{kept}");
        }
        assert_eq!(normalize("./src//a.ts").as_deref(), Some("src/a.ts"));
        assert_eq!(normalize("../x"), None);
        let dir = temp();
        let git = |args: &[&str]| {
            std::process::Command::new("git").args(args).current_dir(&dir).output().unwrap();
        };
        // Outside a repository nothing is ignored.
        assert!(git_ignored(&dir, &["secret.env".into()]).await.is_empty());
        git(&["init", "-q"]);
        std::fs::write(dir.join(".gitignore"), "*.env\nlogs/\n").unwrap();
        let found = git_ignored(&dir, &["secret.env".into(), "logs/a.txt".into(), "src/main.rs".into()]).await;
        assert_eq!(found, HashSet::from(["secret.env".to_owned(), "logs/a.txt".to_owned()]));
        std::fs::remove_dir_all(dir).ok();
    }

    #[tokio::test]
    async fn hub_history_restore_writes_the_file_and_records_it_as_yours() {
        let dir = temp();
        let root = dir.join("ws");
        std::fs::create_dir_all(&root).unwrap();
        let blobs = dir.join("blobs");
        let store: crate::hub::Hub = Arc::new(HubStore::memory());
        let ws = uuid::Uuid::new_v4();
        std::fs::write(root.join("a.txt"), "first").unwrap();
        let first = capture(&store, &blobs, &Saved::default(), &root, ws, "a.txt", None, None).unwrap().unwrap();
        std::fs::write(root.join("a.txt"), "second").unwrap();
        capture(&store, &blobs, &Saved::default(), &root, ws, "a.txt", None, None).unwrap().unwrap();
        let content = read_blob(&blobs, &first.blob).unwrap();
        let restored = restore_into(store.clone(), blobs.clone(), &root, ws, "a.txt", &content).await.unwrap();
        assert_eq!(std::fs::read_to_string(root.join("a.txt")).unwrap(), "first");
        assert_eq!((restored.author_kind.as_str(), restored.blob.as_str()), ("you", first.blob.as_str()));
        assert!(restored.id > first.id);
        // The watcher's echo of the restore adds nothing.
        assert!(capture(&store, &blobs, saved(), &root, ws, "a.txt", None, None).unwrap().is_none());
        // Restoring what the file already holds returns the latest version.
        let again = restore_into(store.clone(), blobs.clone(), &root, ws, "a.txt", &content).await.unwrap();
        assert_eq!(again.id, restored.id);
        // Nothing leaves the workspace.
        assert!(restore_into(store.clone(), blobs, &root, ws, "../outside.txt", "x").await.is_err());
        assert!(!dir.join("outside.txt").exists());
        std::fs::remove_dir_all(dir).ok();
    }
}
