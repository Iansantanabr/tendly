//! Apps that reload on their own, and the undo of what made them reload.
//!
//! The watcher that feeds the file history (`history.rs`) tells this module
//! about every path that changes under `apps/<slug>/` (never `data/`, which is
//! the app's own state). Changes to one app that come close together are one
//! burst: once the app has been quiet for `QUIET`, the burst is closed, what
//! each file held before and holds now is written down, and every open window
//! is told over the agent-activity socket, so the panes showing that app
//! reload.
//!
//! "Before" comes from an index of the app's files, taken when the server
//! starts, when an app is scaffolded and when a window first shows the app,
//! and kept current at the end of every burst. Text contents are versions in
//! the file history, so undoing a burst is restoring those versions: a file
//! that changed gets its earlier content back, a file the burst deleted comes
//! back, and a file the burst created is removed (its content stays in the
//! history). Files the history does not keep (binary, over 1 MB) are left as
//! they are and named in the answer.
//!
//! Only the latest change of an app can be undone. The undo is itself a burst,
//! marked `undo_of`, so undoing it is the redo.
use super::valid_slug;
use crate::{ApiError, AppState, Result, app::db, hub::history, workspace_io};
use axum::{
    Json,
    extract::{Path as UrlPath, State},
};
use chrono::{SecondsFormat, Utc};
use serde_json::{Value, json};
use std::{
    collections::{BTreeSet, HashMap, VecDeque},
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant},
};
use tendly_domain::WorkspaceId;

/// An app reloads once its files have been quiet this long.
pub(crate) const QUIET: Duration = Duration::from_millis(600);
/// More paths than this in one burst is a checkout or a generator: the app
/// still reloads, but the burst cannot be undone.
const MAX_PATHS: usize = 200;
/// Paths named in what the browser is told.
const PATHS_SHOWN: usize = 20;
const CHANGES_KEPT: usize = 10;
/// A change older than this can no longer be undone.
const UNDO_FOR: Duration = Duration::from_secs(60 * 60);
/// A burst that closes this soon after an undo is that undo's own writes.
const UNDO_ECHO: Duration = Duration::from_secs(10);
/// An app with more files than this is indexed in part, and what is not in
/// the index is never taken for a file that did not exist.
const MAX_INDEXED: usize = 2000;
const MAX_DEPTH: usize = 8;

type AppId = (WorkspaceId, String);

/// What a path holds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Held {
    /// No file there.
    Absent,
    /// Text the history keeps, by content hash.
    Text(String),
    /// A file the history does not keep: binary, too large, a link.
    Other,
    /// Not known (the app was not indexed when it changed).
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FileChange {
    /// Relative to the workspace: `apps/<slug>/index.html`.
    pub path: String,
    pub before: Held,
    pub after: Held,
}

impl FileChange {
    /// Whether undo can put this file back as it was.
    fn restorable(&self) -> bool {
        match (&self.before, &self.after) {
            (Held::Text(_), _) => true,
            (Held::Absent, Held::Text(_)) => !is_manifest(&self.path),
            _ => false,
        }
    }
}

#[derive(Debug, Clone)]
struct Change {
    id: String,
    at: String,
    made: Instant,
    files: Vec<FileChange>,
    /// Too many paths to track: reload only.
    overflow: bool,
    undo_of: Option<String>,
    /// This undo took back an undo: the files are as the first change left them.
    redo: bool,
}

impl Change {
    fn undoable(&self) -> bool {
        !self.overflow && self.made.elapsed() < UNDO_FOR && self.files.iter().any(FileChange::restorable)
    }

    fn view(&self) -> Value {
        json!({
            "id": self.id,
            "at": self.at,
            "paths": self.files.iter().take(PATHS_SHOWN).map(|file| file.path.as_str()).collect::<Vec<_>>(),
            "count": self.files.len(),
            "undoable": self.undoable(),
            "undo_of": self.undo_of,
            "redo": self.redo,
        })
    }
}

struct Burst {
    root: PathBuf,
    paths: BTreeSet<String>,
    last: Instant,
}

/// An app's files as of its last burst.
#[derive(Debug, Clone, Default)]
struct Index {
    files: HashMap<String, Held>,
    /// False when the app has more files than are indexed.
    complete: bool,
}

impl Index {
    fn before(&self, path: &str) -> Held {
        match self.files.get(path) {
            Some(held) => held.clone(),
            None if self.complete => Held::Absent,
            None => Held::Unknown,
        }
    }
}

#[derive(Default)]
struct Inner {
    bursts: HashMap<AppId, Burst>,
    index: HashMap<AppId, Index>,
    changes: HashMap<AppId, VecDeque<Change>>,
    /// The change being undone, when, and whether it was an undo itself.
    undoing: HashMap<AppId, (String, Instant, bool)>,
}

/// Kept in the hub store's handle, so the watcher, the routes and the task
/// below reach the same state.
#[derive(Default)]
pub(crate) struct Live {
    inner: Mutex<Inner>,
    wake: tokio::sync::Notify,
}

/// `apps/<slug>/<rest>` for a path whose change reloads the app: not the
/// folder itself, not `data/`, not a dot-file.
pub(crate) fn app_path(path: &str) -> Option<(&str, &str)> {
    let (slug, rest) = path.strip_prefix("apps/")?.split_once('/')?;
    if !valid_slug(slug) || rest.is_empty() || rest == "data" || rest.starts_with("data/") {
        return None;
    }
    if rest.split('/').any(|part| part.is_empty() || part.starts_with('.')) {
        return None;
    }
    Some((slug, rest))
}

fn is_manifest(path: &str) -> bool {
    app_path(path).is_some_and(|(_, rest)| rest == "app.json")
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

impl Live {
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().expect("app live")
    }

    /// A path changed in a workspace (already relative to it and normalized).
    pub(crate) fn touched(&self, workspace: WorkspaceId, root: &Path, path: &str) {
        let Some((slug, _)) = app_path(path) else { return };
        {
            let mut inner = self.lock();
            let burst = inner.bursts.entry((workspace, slug.to_owned())).or_insert_with(|| Burst {
                root: root.to_path_buf(),
                paths: BTreeSet::new(),
                last: Instant::now(),
            });
            // One past the limit is enough to know the burst overflowed.
            if burst.paths.len() <= MAX_PATHS {
                burst.paths.insert(path.to_owned());
            }
            burst.last = Instant::now();
        }
        self.wake.notify_one();
    }

    /// The bursts that have been quiet long enough, taken out.
    fn take_due(&self, now: Instant) -> Vec<(AppId, Burst)> {
        let mut inner = self.lock();
        let due: Vec<AppId> = inner
            .bursts
            .iter()
            .filter(|(_, burst)| burst.last + QUIET <= now)
            .map(|(app, _)| app.clone())
            .collect();
        due.into_iter().filter_map(|app| inner.bursts.remove(&app).map(|burst| (app, burst))).collect()
    }

    fn next_deadline(&self) -> Option<Instant> {
        self.lock().bursts.values().map(|burst| burst.last + QUIET).min()
    }

    fn index_of(&self, app: &AppId) -> Option<Index> {
        self.lock().index.get(app).cloned()
    }

    /// Whether the app still needs its first index (and is not mid-burst, when
    /// the end of the burst takes it).
    fn wants_index(&self, app: &AppId) -> bool {
        let inner = self.lock();
        !inner.index.contains_key(app) && !inner.bursts.contains_key(app)
    }

    fn set_index(&self, app: AppId, index: Index) {
        self.lock().index.insert(app, index);
    }

    /// Writes a closed burst down. Returns what to tell the browsers, or
    /// nothing when no file really changed.
    fn close(&self, app: &AppId, files: Vec<FileChange>, overflow: bool, fresh: Option<Index>) -> Option<Value> {
        let mut inner = self.lock();
        match fresh {
            Some(index) => {
                inner.index.insert(app.clone(), index);
            }
            None => {
                if let Some(index) = inner.index.get_mut(app) {
                    for file in &files {
                        match &file.after {
                            Held::Absent => index.files.remove(&file.path),
                            held => index.files.insert(file.path.clone(), held.clone()),
                        };
                    }
                }
            }
        }
        if files.is_empty() && !overflow {
            return None;
        }
        let undone = inner.undoing.remove(app).filter(|(_, at, _)| at.elapsed() < UNDO_ECHO);
        let redo = undone.as_ref().is_some_and(|(_, _, was_undo)| *was_undo);
        let change = Change {
            id: uuid::Uuid::new_v4().to_string(),
            at: now(),
            made: Instant::now(),
            files,
            overflow,
            undo_of: undone.map(|(id, _, _)| id),
            redo,
        };
        let view = change.view();
        let kept = inner.changes.entry(app.clone()).or_default();
        kept.push_back(change);
        while kept.len() > CHANGES_KEPT {
            kept.pop_front();
        }
        Some(view)
    }

    fn latest(&self, app: &AppId) -> Option<Value> {
        self.lock().changes.get(app).and_then(|kept| kept.back()).map(Change::view)
    }

    /// The files of change `id`, when it is the app's latest and can still be undone.
    fn undoable(&self, app: &AppId, id: &str) -> Result<Vec<FileChange>> {
        let inner = self.lock();
        let kept = inner.changes.get(app);
        let Some(change) = kept.and_then(|kept| kept.iter().find(|change| change.id == id)) else {
            return Err(ApiError::missing("Change"));
        };
        if kept.and_then(|kept| kept.back()).is_some_and(|latest| latest.id != id) {
            return Err(ApiError::conflict("The app changed again after that. Only its latest change can be undone."));
        }
        if !change.undoable() {
            return Err(ApiError::conflict("That change can no longer be undone."));
        }
        Ok(change.files.clone())
    }

    fn undoing(&self, app: &AppId, id: &str) {
        let mut inner = self.lock();
        let was_undo = inner
            .changes
            .get(app)
            .and_then(|kept| kept.iter().find(|change| change.id == id))
            .is_some_and(|change| change.undo_of.is_some() && !change.redo);
        inner.undoing.insert(app.clone(), (id.to_owned(), Instant::now(), was_undo));
    }
}

// ---------------------------------------------------------------------------
// Reading the app's files

/// What `path` holds now. Text is kept as a version on the way, so it can be
/// put back later.
fn hold(store: &crate::hub::HubStore, blobs: &Path, root: &Path, workspace: WorkspaceId, path: &str) -> Held {
    let target = root.join(path);
    let Ok(meta) = fs::symlink_metadata(&target) else { return Held::Absent };
    if meta.is_dir() {
        return Held::Absent;
    }
    if !meta.is_file() || meta.len() as usize > history::MAX_BYTES {
        return Held::Other;
    }
    let Ok(bytes) = fs::read(&target) else { return Held::Other };
    if history::text_of(&bytes).is_none() {
        return Held::Other;
    }
    match history::keep(store, blobs, workspace, path, &bytes) {
        Ok(()) => Held::Text(history::hash(&bytes)),
        Err(error) => {
            tracing::warn!(%error, %path, "app reload: could not keep a version");
            Held::Other
        }
    }
}

/// Every file of an app (not `data/`, dot-files or build output), as it is now.
fn index_app(store: &crate::hub::HubStore, blobs: &Path, root: &Path, workspace: WorkspaceId, slug: &str) -> Index {
    let mut index = Index { files: HashMap::new(), complete: true };
    let mut stack = vec![(root.join("apps").join(slug), format!("apps/{slug}"), 0usize)];
    while let Some((dir, prefix, depth)) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || (depth == 0 && name == "data") {
                continue;
            }
            let path = format!("{prefix}/{name}");
            let Ok(kind) = entry.file_type() else { continue };
            if kind.is_dir() {
                if history::BUILD_DIRS.contains(&name.as_str()) {
                    continue;
                }
                if depth >= MAX_DEPTH {
                    index.complete = false;
                    continue;
                }
                stack.push((entry.path(), path, depth + 1));
            } else {
                if index.files.len() >= MAX_INDEXED {
                    index.complete = false;
                    return index;
                }
                let held = hold(store, blobs, root, workspace, &path);
                index.files.insert(path, held);
            }
        }
    }
    index
}

/// Indexes one app if it has no index yet. Cheap to call again.
pub(crate) async fn ensure_indexed(state: &AppState, workspace: WorkspaceId, slug: &str, root: PathBuf) {
    let app = (workspace, slug.to_owned());
    if !state.hub.app_live.wants_index(&app) {
        return;
    }
    let (store, blobs, name) = (state.hub.clone(), history::blob_dir(state), slug.to_owned());
    let indexed = tokio::task::spawn_blocking(move || index_app(&store, &blobs, &root, workspace, &name)).await;
    // A burst may have opened meanwhile: its end takes the index instead.
    if let Ok(index) = indexed
        && state.hub.app_live.wants_index(&app)
    {
        state.hub.app_live.set_index(app, index);
    }
}

/// Indexes every app of every workspace: once, when the server starts.
async fn index_all(state: &AppState) {
    let Ok(workspaces) = db(state, |s| s.list_workspaces()).await else { return };
    for workspace in workspaces {
        let found = tokio::task::spawn_blocking(move || {
            let root = dunce::canonicalize(&workspace.root_path).ok()?;
            let entries = fs::read_dir(root.join("apps")).ok()?;
            let slugs: Vec<String> = entries
                .flatten()
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .filter(|slug| valid_slug(slug) && root.join("apps").join(slug).join("app.json").is_file())
                .collect();
            Some((workspace.id, root, slugs))
        })
        .await
        .ok()
        .flatten();
        let Some((id, root, slugs)) = found else { continue };
        for slug in slugs {
            ensure_indexed(state, id, &slug, root.clone()).await;
        }
    }
}

// ---------------------------------------------------------------------------
// The task

/// Starts closing bursts and telling the browsers. Called once from `hub::warm`.
pub(crate) fn start(state: AppState) {
    tokio::spawn(run(state));
}

async fn run(state: AppState) {
    index_all(&state).await;
    let hub = state.hub.clone();
    loop {
        for (app, burst) in hub.app_live.take_due(Instant::now()) {
            if let Some(change) = finish(&state, &app, burst).await {
                announce(&state, &app, change);
            }
        }
        match hub.app_live.next_deadline() {
            Some(at) => {
                tokio::select! {
                    _ = tokio::time::sleep_until(at.into()) => {}
                    _ = hub.app_live.wake.notified() => {}
                }
            }
            None => hub.app_live.wake.notified().await,
        }
    }
}

fn announce(state: &AppState, app: &AppId, change: Value) {
    state.activity.hub_event(json!({
        "type": "hub",
        "event": "app-changed",
        "workspace_id": app.0.to_string(),
        "slug": app.1,
        "change": change,
    }));
}

/// Closes a burst: records what changed, and returns what the browsers hear.
async fn finish(state: &AppState, app: &AppId, burst: Burst) -> Option<Value> {
    let (workspace, slug) = app.clone();
    let overflow = burst.paths.len() > MAX_PATHS;
    let paths: Vec<String> = if overflow { Vec::new() } else { burst.paths.into_iter().collect() };
    let live = &state.hub.app_live;
    let known = if overflow { None } else { live.index_of(app) };
    // An app with no index yet: the most that is known of "before" is each
    // file's latest version, read now, before this burst adds its own.
    let mut earlier: HashMap<String, Held> = HashMap::new();
    if known.is_none() && !paths.is_empty() {
        let (store, wanted) = (state.hub.clone(), paths.clone());
        earlier = tokio::task::spawn_blocking(move || {
            wanted
                .into_iter()
                .map(|path| {
                    let held = history::latest_blob(&store, workspace, &path).map_or(Held::Unknown, Held::Text);
                    (path, held)
                })
                .collect()
        })
        .await
        .unwrap_or_default();
    }
    // The history next, so each version is credited as it would be anyway
    // (you, the agent at work, or outside Tendly).
    if !paths.is_empty() {
        history::settle(state, workspace, burst.root.clone(), paths.clone()).await;
    }
    let (store, blobs, root) = (state.hub.clone(), history::blob_dir(state), burst.root);
    let read = tokio::task::spawn_blocking(move || {
        let mut files = Vec::new();
        for path in &paths {
            let before = match &known {
                Some(index) => index.before(path),
                None => earlier.get(path).cloned().unwrap_or(Held::Unknown),
            };
            let after = hold(&store, &blobs, &root, workspace, path);
            // Touched but the same (a save without edits): not a change. A
            // file the history does not keep cannot be compared, so it counts.
            if before == after && !matches!(after, Held::Other) {
                continue;
            }
            files.push(FileChange { path: path.clone(), before, after });
        }
        // An app seen for the first time, or one that overflowed, is indexed whole.
        let fresh = known.is_none().then(|| index_app(&store, &blobs, &root, workspace, &slug));
        (files, fresh)
    })
    .await;
    match read {
        Ok((files, fresh)) => live.close(app, files, overflow, fresh),
        Err(error) => {
            tracing::warn!(%error, "app reload: reading a burst failed");
            None
        }
    }
}

// ---------------------------------------------------------------------------
// Routes

fn parse(workspace: &str, slug: &str) -> Result<AppId> {
    let id: WorkspaceId = workspace.parse().map_err(|_| ApiError::missing("App"))?;
    if !valid_slug(slug) {
        return Err(ApiError::missing("App"));
    }
    Ok((id, slug.to_owned()))
}

/// `GET /api/hub/apps/{workspace}/{slug}/changes`: the app's latest change, so
/// a window that was not listening (just opened, or reconnected) can tell
/// whether it shows the current files. Asking also indexes the app.
pub(super) async fn changes_route(
    State(state): State<AppState>,
    UrlPath((workspace, slug)): UrlPath<(String, String)>,
) -> Result<Json<Value>> {
    let found = super::find(&state, &workspace, &slug).await?;
    let app = (found.workspace.id, found.slug.clone());
    if let Ok(root) = crate::app::root(&state, app.0).await {
        ensure_indexed(&state, app.0, &app.1, root).await;
    }
    Ok(Json(json!({ "latest": state.hub.app_live.latest(&app), "quiet_ms": QUIET.as_millis() as u64 })))
}

/// `POST /api/hub/apps/{workspace}/{slug}/changes/{id}/undo`.
pub(super) async fn undo_route(
    State(state): State<AppState>,
    UrlPath((workspace, slug, id)): UrlPath<(String, String, String)>,
) -> Result<Json<Value>> {
    let app = parse(&workspace, &slug)?;
    let root = crate::app::root(&state, app.0).await?;
    let files = state.hub.app_live.undoable(&app, &id)?;
    let outcome = {
        let _guard = state.operations.lock().await;
        state.hub.app_live.undoing(&app, &id);
        undo(&state, app.0, &root, files).await
    };
    if outcome.restored.is_empty() && outcome.removed.is_empty() {
        return Err(ApiError::conflict("Nothing in that change could be put back."));
    }
    Ok(Json(json!({
        "undone": true,
        "restored": outcome.restored,
        "removed": outcome.removed,
        "skipped": outcome.skipped.iter().map(|(path, reason)| json!({ "path": path, "reason": reason })).collect::<Vec<_>>(),
    })))
}

#[derive(Debug, Default)]
pub(crate) struct Undone {
    pub restored: Vec<String>,
    pub removed: Vec<String>,
    pub skipped: Vec<(String, String)>,
}

/// Puts each file back as it was before the change.
pub(crate) async fn undo(state: &AppState, workspace: WorkspaceId, root: &Path, files: Vec<FileChange>) -> Undone {
    let blobs = history::blob_dir(state);
    let mut outcome = Undone::default();
    for file in files {
        // Only ever inside an app folder, whatever the record says.
        if app_path(&file.path).is_none() {
            continue;
        }
        match (&file.before, &file.after) {
            (Held::Text(hash), _) => {
                let (dir, wanted) = (blobs.clone(), hash.clone());
                let content = tokio::task::spawn_blocking(move || history::read_blob(&dir, &wanted)).await.ok().flatten();
                let Some(content) = content else {
                    outcome.skipped.push((file.path, "its earlier content is no longer kept".into()));
                    continue;
                };
                match history::restore_into(state.hub.clone(), blobs.clone(), root, workspace, &file.path, &content).await {
                    Ok(_) => outcome.restored.push(file.path),
                    Err(error) => outcome.skipped.push((file.path, error.message)),
                }
            }
            (Held::Absent, Held::Text(_)) if !is_manifest(&file.path) => {
                // What it holds this instant is kept first, so removing it loses nothing.
                let (store, dir, base, path) = (state.hub.clone(), blobs.clone(), root.to_path_buf(), file.path.clone());
                let current = tokio::task::spawn_blocking(move || hold(&store, &dir, &base, workspace, &path))
                    .await
                    .unwrap_or(Held::Other);
                match current {
                    Held::Absent => {}
                    Held::Text(_) => match workspace_io::delete_entry(root, &file.path).await {
                        Ok(()) => outcome.removed.push(file.path),
                        Err(error) if error.status == 404 => {}
                        Err(error) => outcome.skipped.push((file.path, error.message)),
                    },
                    _ => outcome.skipped.push((file.path, "it is not a text file anymore".into())),
                }
            }
            (Held::Absent, Held::Absent) => {}
            (Held::Absent, _) if is_manifest(&file.path) => {
                outcome.skipped.push((file.path, "app.json is never removed".into()));
            }
            _ => outcome.skipped.push((file.path, "the history does not keep this kind of file".into())),
        }
    }
    outcome
}

#[cfg(test)]
pub(crate) mod testing {
    //! What the tests need to play the watcher and the task by hand.
    use super::*;

    /// Closes the app's open burst now, whatever its age, as the task would.
    pub(crate) async fn settle(state: &AppState, workspace: WorkspaceId, slug: &str) -> Option<Value> {
        let app = (workspace, slug.to_owned());
        let burst = state.hub.app_live.lock().bursts.remove(&app)?;
        finish(state, &app, burst).await
    }

    pub(crate) fn open_bursts(state: &AppState) -> usize {
        state.hub.app_live.lock().bursts.len()
    }

    pub(crate) fn due(state: &AppState, after: Duration) -> usize {
        let live = &state.hub.app_live;
        let due = live.take_due(Instant::now() + after);
        let count = due.len();
        let mut inner = live.lock();
        for (app, burst) in due {
            inner.bursts.insert(app, burst);
        }
        count
    }

    pub(crate) fn forget_index(state: &AppState, workspace: WorkspaceId, slug: &str) {
        state.hub.app_live.lock().index.remove(&(workspace, slug.to_owned()));
    }

    pub(crate) fn max_paths() -> usize {
        MAX_PATHS
    }
}
