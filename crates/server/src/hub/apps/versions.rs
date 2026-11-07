//! Versions of a whole app, made from the file history.
//!
//! The history (`hub/history.rs`) keeps one version per file. For an app what
//! matters is the state of its folder after each turn of the agent: here the
//! file versions under `apps/<slug>/` (never `data/`, `files/` or dot-files)
//! are grouped into bursts, one per author and conversation, split where a
//! gap opens (`AGENT_GAP` for an agent's versions, `OTHER_GAP` for yours and
//! those made outside Tendly). The history does not say where a turn ends,
//! so the gap is the boundary; two turns in quick succession become one
//! version, which is harmless.
//!
//! Restoring puts every file back as it was at that point: new file versions
//! (written as yours), files created later removed (their content stays in
//! the history), `app.json` never removed, and nothing of the history
//! deleted. Deleted files are the one thing the history does not record, so
//! `app_file_removals` (migration 12) notes each removal the reload watcher
//! sees, with the history's id at that moment, and a restore trusts it.
use super::{find, live};
use crate::{ApiError, AppState, Result, hub::cs, hub::history};
use axum::{
    Json, Router,
    extract::{Path as UrlPath, State},
    routing::{get, post},
};
use chrono::{DateTime, Utc};
use rusqlite::{Connection, params};
use serde::Serialize;
use serde_json::{Value, json};
use std::{collections::HashMap, path::Path};
use tendly_domain::WorkspaceId;

/// Agent versions of one conversation this far apart are different versions.
const AGENT_GAP_SECONDS: i64 = 5 * 60;
/// Your saves (and changes from outside Tendly) group within this.
const OTHER_GAP_SECONDS: i64 = 60;
/// How many file versions are read, newest first, and how many app versions are shown.
const MAX_ROWS: usize = 2000;
const MAX_VERSIONS: usize = 50;
const MAX_FILES_SHOWN: usize = 40;

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/hub/apps/{workspace_id}/{slug}/versions", get(list_route))
        .route("/api/hub/apps/{workspace_id}/{slug}/versions/{id}/restore", post(restore_route))
}

// ---------------------------------------------------------------------------
// Rows and grouping

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Row {
    pub id: i64,
    /// Relative to the workspace: `apps/<slug>/index.html`.
    pub path: String,
    pub blob: String,
    pub author_kind: String,
    pub session_id: Option<String>,
    pub created_at: String,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub(crate) struct AppVersion {
    /// The history id of the newest file in the burst: the state of the app as of that version.
    pub id: i64,
    pub author_kind: String,
    pub session_id: Option<String>,
    /// What the agent said while writing: the first line kept with the burst.
    pub message: Option<String>,
    pub started_at: String,
    pub at: String,
    /// Paths relative to the app folder, in the order they were written (first occurrence).
    pub files: Vec<String>,
    pub count: usize,
}

fn seconds(text: &str) -> i64 {
    DateTime::parse_from_rfc3339(text).map(|t| t.timestamp()).unwrap_or(0)
}

/// Groups the file versions of an app (any order) into app versions, newest first.
pub(crate) fn group(slug: &str, mut rows: Vec<Row>) -> Vec<AppVersion> {
    rows.sort_by_key(|row| row.id);
    let mut versions: Vec<AppVersion> = Vec::new();
    for row in rows {
        let Some((owner, relative)) = live::app_path(&row.path) else { continue };
        if owner != slug {
            continue;
        }
        let joins = versions.last().is_some_and(|last| {
            let gap = if row.author_kind == "agent" { AGENT_GAP_SECONDS } else { OTHER_GAP_SECONDS };
            last.author_kind == row.author_kind && last.session_id == row.session_id && seconds(&row.created_at) - seconds(&last.at) <= gap
        });
        if joins {
            let last = versions.last_mut().expect("joins a version");
            last.id = row.id;
            last.at = row.created_at.clone();
            if last.message.is_none() {
                last.message = row.message.clone();
            }
            if !last.files.iter().any(|f| f == relative) {
                last.files.push(relative.to_owned());
            }
            last.count = last.files.len();
        } else {
            versions.push(AppVersion {
                id: row.id,
                author_kind: row.author_kind.clone(),
                session_id: row.session_id.clone(),
                message: row.message.clone(),
                started_at: row.created_at.clone(),
                at: row.created_at.clone(),
                files: vec![relative.to_owned()],
                count: 1,
            });
        }
    }
    versions.reverse();
    versions
}

const ROW_COLUMNS: &str = "id, path, blob, author_kind, session_id, created_at, message";

fn row_of(r: &rusqlite::Row<'_>) -> rusqlite::Result<Row> {
    Ok(Row {
        id: r.get(0)?,
        path: r.get(1)?,
        blob: r.get(2)?,
        author_kind: r.get(3)?,
        session_id: r.get(4)?,
        created_at: r.get(5)?,
        message: r.get(6)?,
    })
}

/// The newest `MAX_ROWS` file versions under the app folder (data/ and files/ included; `group` filters).
fn rows(c: &Connection, workspace: &str, slug: &str) -> rusqlite::Result<Vec<Row>> {
    let mut stmt = c.prepare(&format!(
        "SELECT {ROW_COLUMNS} FROM file_versions WHERE workspace_id = ?1 AND path LIKE ?2 ORDER BY id DESC LIMIT ?3"
    ))?;
    stmt.query_map(params![workspace, format!("apps/{slug}/%"), MAX_ROWS as i64], row_of)?.collect()
}

/// A removal noted this long after the version's last write still belongs to it.
const REMOVAL_SLACK_SECONDS: i64 = 2;

/// For each file of the app: its latest version at or before `at`, when that
/// version is still the file's state then: no removal noted since it and
/// before `until` (a removal in a later burst of its own shares the id of
/// the version before it, so the time tells them apart).
fn state_at(c: &Connection, workspace: &str, slug: &str, at: i64, until: i64) -> rusqlite::Result<HashMap<String, Row>> {
    let mut stmt = c.prepare(&format!(
        "SELECT {ROW_COLUMNS} FROM file_versions WHERE workspace_id = ?1 AND path LIKE ?2 AND id <= ?3 ORDER BY id DESC"
    ))?;
    let mut latest: HashMap<String, Row> = HashMap::new();
    for row in stmt.query_map(params![workspace, format!("apps/{slug}/%"), at], row_of)? {
        let row = row?;
        if live::app_path(&row.path).is_none() {
            continue;
        }
        latest.entry(row.path.clone()).or_insert(row);
    }
    let mut removed = c.prepare(
        "SELECT after_version_id, removed_at FROM app_file_removals WHERE workspace_id = ?1 AND path = ?2 AND after_version_id <= ?3",
    )?;
    let mut present = HashMap::new();
    for (path, row) in latest {
        let gone = removed
            .query_map(params![workspace, path, at], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?
            .into_iter()
            .any(|(after, when)| after >= row.id && seconds(&when) <= until);
        if gone {
            continue;
        }
        present.insert(path, row);
    }
    Ok(present)
}

/// Every file the history knows under the app, present at `at` or not.
fn known_paths(c: &Connection, workspace: &str, slug: &str) -> rusqlite::Result<Vec<String>> {
    let mut stmt = c.prepare("SELECT DISTINCT path FROM file_versions WHERE workspace_id = ?1 AND path LIKE ?2")?;
    let paths = stmt.query_map(params![workspace, format!("apps/{slug}/%")], |r| r.get::<_, String>(0))?;
    Ok(paths.collect::<rusqlite::Result<Vec<_>>>()?.into_iter().filter(|p| live::app_path(p).is_some()).collect())
}

/// Whether the last word on `path` is a removal: it was noted gone at or after
/// its newest version, and no version since. A file that is back then needs a
/// version of its own (`live.rs` asks on every read).
pub(crate) fn removal_open(c: &Connection, workspace: &str, path: &str) -> rusqlite::Result<bool> {
    let removed: Option<i64> = c.query_row(
        "SELECT MAX(after_version_id) FROM app_file_removals WHERE workspace_id = ?1 AND path = ?2",
        params![workspace, path],
        |r| r.get(0),
    )?;
    let Some(removed) = removed else { return Ok(false) };
    let newest: Option<i64> = c.query_row(
        "SELECT MAX(id) FROM file_versions WHERE workspace_id = ?1 AND path = ?2",
        params![workspace, path],
        |r| r.get(0),
    )?;
    Ok(newest.is_none_or(|id| id <= removed))
}

/// The reload watcher saw these files of a workspace disappear: noted with
/// the history's id at this moment, so a restore knows they were gone.
pub(crate) fn record_removals(c: &Connection, workspace: &str, paths: &[String]) -> rusqlite::Result<()> {
    if paths.is_empty() {
        return Ok(());
    }
    let after: i64 = c.query_row("SELECT COALESCE(MAX(id), 0) FROM file_versions", [], |r| r.get(0))?;
    let at = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    for path in paths {
        c.execute(
            "INSERT INTO app_file_removals(workspace_id, path, after_version_id, removed_at) VALUES (?1, ?2, ?3, ?4)",
            params![workspace, path, after, at],
        )?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Routes

async fn session_titles(state: &AppState, versions: &[AppVersion]) -> HashMap<String, String> {
    let ids: std::collections::HashSet<String> = versions.iter().filter_map(|v| v.session_id.clone()).collect();
    let mut titles = HashMap::new();
    for id in ids {
        let Ok(session) = uuid::Uuid::parse_str(&id) else { continue };
        if let Ok(Some(found)) = crate::app::db(state, move |s| s.get_session(session)).await {
            titles.insert(id, found.title);
        }
    }
    titles
}

async fn list_route(State(state): State<AppState>, UrlPath((workspace, slug)): UrlPath<(String, String)>) -> Result<Json<Value>> {
    let found = find(&state, &workspace, &slug).await?;
    let (ws, name) = (found.workspace.id.to_string(), found.slug.clone());
    let all = cs(&state, move |c| rows(c, &ws, &name)).await?;
    let truncated_rows = all.len() >= MAX_ROWS;
    let mut versions = group(&found.slug, all);
    let truncated = truncated_rows || versions.len() > MAX_VERSIONS;
    versions.truncate(MAX_VERSIONS);
    let titles = session_titles(&state, &versions).await;
    let list: Vec<Value> = versions
        .iter()
        .enumerate()
        .map(|(index, v)| {
            json!({
                "id": v.id,
                "author_kind": v.author_kind,
                "session_id": v.session_id,
                "session_title": v.session_id.as_ref().and_then(|id| titles.get(id)),
                "message": v.message,
                "started_at": v.started_at,
                "at": v.at,
                "files": v.files.iter().take(MAX_FILES_SHOWN).collect::<Vec<_>>(),
                "count": v.count,
                "current": index == 0,
            })
        })
        .collect();
    Ok(Json(json!({ "versions": list, "truncated": truncated })))
}

#[derive(Debug, Default, Serialize)]
pub(crate) struct Restored {
    pub restored: Vec<String>,
    pub removed: Vec<String>,
    pub unchanged: Vec<String>,
    pub skipped: Vec<(String, String)>,
}

/// Puts the app's files as they were as of history id `at`, the newest row of
/// an app version that ended at `ended` (RFC 3339).
pub(crate) async fn restore(state: &AppState, workspace: WorkspaceId, slug: &str, root: &Path, at: i64, ended: &str) -> Result<Restored> {
    let (ws, name) = (workspace.to_string(), slug.to_owned());
    let until = seconds(ended).checked_add(REMOVAL_SLACK_SECONDS).unwrap_or(i64::MAX);
    let (wanted, known) = cs(state, move |c| Ok((state_at(c, &ws, &name, at, until)?, known_paths(c, &ws, &name)?))).await?;
    let blobs = history::blob_dir(state);
    let mut outcome = Restored::default();
    for path in known {
        // Only ever inside the app folder, whatever the record says.
        let Some((owner, relative)) = live::app_path(&path) else { continue };
        if owner != slug {
            continue;
        }
        let target = root.join(&path);
        let exists = std::fs::symlink_metadata(&target).is_ok();
        match wanted.get(&path) {
            Some(row) => {
                let (dir, hash) = (blobs.clone(), row.blob.clone());
                let content = tokio::task::spawn_blocking(move || history::read_blob(&dir, &hash)).await.ok().flatten();
                let Some(content) = content else {
                    outcome.skipped.push((relative.to_owned(), "its content from then is no longer kept".into()));
                    continue;
                };
                if exists && std::fs::read(&target).is_ok_and(|bytes| bytes == content.as_bytes()) {
                    outcome.unchanged.push(relative.to_owned());
                    continue;
                }
                match history::restore_into(state.hub.clone(), blobs.clone(), root, workspace, &path, &content).await {
                    Ok(_) => outcome.restored.push(relative.to_owned()),
                    Err(error) => outcome.skipped.push((relative.to_owned(), error.message)),
                }
            }
            None if !exists => {}
            None if relative == "app.json" => outcome.skipped.push((relative.to_owned(), "app.json is never removed".into())),
            None => {
                // Made after that version. What it holds now is kept first, so nothing is lost.
                let (store, dir, base, kept) = (state.hub.clone(), blobs.clone(), root.to_path_buf(), path.clone());
                let held = tokio::task::spawn_blocking(move || {
                    let bytes = std::fs::read(base.join(&kept)).ok()?;
                    history::text_of(&bytes)?;
                    history::keep(&store, &dir, workspace, &kept, &bytes).ok()
                })
                .await
                .ok()
                .flatten();
                if held.is_none() {
                    outcome.skipped.push((relative.to_owned(), "it is not a text file the history keeps".into()));
                    continue;
                }
                match crate::workspace_io::delete_entry(root, &path).await {
                    Ok(()) => outcome.removed.push(relative.to_owned()),
                    Err(error) if error.status == 404 => {}
                    Err(error) => outcome.skipped.push((relative.to_owned(), error.message)),
                }
            }
        }
    }
    Ok(outcome)
}

async fn restore_route(
    State(state): State<AppState>,
    UrlPath((workspace, slug, id)): UrlPath<(String, String, i64)>,
) -> Result<Json<Value>> {
    let found = find(&state, &workspace, &slug).await?;
    let (ws, name) = (found.workspace.id.to_string(), found.slug.clone());
    // The id names a file version of this app (as listed, the newest of a burst); the state is as of that write.
    let all = cs(&state, move |c| rows(c, &ws, &name)).await?;
    let ended = all.iter().find(|row| row.id == id && live::app_path(&row.path).is_some()).map(|row| row.created_at.clone()).ok_or_else(|| ApiError::missing("Version"))?;
    let root = crate::app::root(&state, found.workspace.id).await?;
    let outcome = {
        let _guard = state.operations.lock().await;
        restore(&state, found.workspace.id, &found.slug, &root, id, &ended).await?
    };
    Ok(Json(json!({
        "restored": outcome.restored,
        "removed": outcome.removed,
        "unchanged": outcome.unchanged,
        "skipped": outcome.skipped.iter().map(|(path, reason)| json!({ "path": path, "reason": reason })).collect::<Vec<_>>(),
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(id: i64, path: &str, author: &str, session: Option<&str>, at: &str, message: Option<&str>) -> Row {
        Row { id, path: path.into(), blob: format!("b{id}"), author_kind: author.into(), session_id: session.map(Into::into), created_at: at.into(), message: message.map(Into::into) }
    }

    #[test]
    fn hub_apps_versions_group_bursts_by_author_conversation_and_gap() {
        let rows = vec![
            row(1, "apps/crm/index.html", "unknown", None, "2026-11-06T10:00:00Z", None),
            row(2, "apps/crm/app.json", "unknown", None, "2026-11-06T10:00:20Z", None),
            row(3, "apps/crm/index.html", "agent", Some("s1"), "2026-11-06T11:00:00Z", Some("Adding the board")),
            row(4, "apps/crm/style.css", "agent", Some("s1"), "2026-11-06T11:03:00Z", Some("Styling it")),
            row(5, "apps/crm/index.html", "agent", Some("s1"), "2026-11-06T11:04:00Z", None),
            row(6, "apps/crm/data/leads.json", "agent", Some("s1"), "2026-11-06T11:04:10Z", None),
            row(7, "apps/crm/index.html", "agent", Some("s1"), "2026-11-06T11:20:00Z", Some("A filter")),
            row(8, "apps/crm/index.html", "agent", Some("s2"), "2026-11-06T11:21:00Z", Some("Other chat")),
            row(9, "apps/crm/index.html", "you", None, "2026-11-06T11:22:00Z", None),
            row(10, "apps/crm/files/x.png", "you", None, "2026-11-06T11:22:01Z", None),
            row(11, "apps/other/index.html", "you", None, "2026-11-06T11:22:02Z", None),
        ];
        let versions = group("crm", rows.into_iter().rev().collect());
        let summary: Vec<(i64, &str, usize, Option<&str>)> = versions.iter().map(|v| (v.id, v.author_kind.as_str(), v.count, v.message.as_deref())).collect();
        assert_eq!(summary, vec![
            (9, "you", 1, None),
            (8, "agent", 1, Some("Other chat")),
            (7, "agent", 1, Some("A filter")),
            (5, "agent", 2, Some("Adding the board")),
            (2, "unknown", 2, None),
        ]);
        assert_eq!(versions[3].files, vec!["index.html", "style.css"], "each file once, in order");
        assert_eq!(versions[3].started_at, "2026-11-06T11:00:00Z");
        assert_eq!(versions[3].at, "2026-11-06T11:04:00Z");
        // data/ and files/ are what the app keeps, not what it is; another app is not this one.
        assert!(versions.iter().all(|v| v.files.iter().all(|f| !f.starts_with("data/") && !f.starts_with("files/"))));
    }
}
