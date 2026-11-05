//! The home page and conversation bar: the inbox (bell), which conversations
//! have a reply the person has not opened yet, and recently changed files.
use super::cs;
use crate::{ApiError, AppState, Result, app::db};
use axum::{
    Json, Router,
    extract::{Path, Query, State},
    routing::{get, post},
};
use chrono::{DateTime, Utc};
use rusqlite::params;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    path::{Path as FsPath, PathBuf},
    time::SystemTime,
};
use tendly_domain::SessionId;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/hub/inbox", get(inbox))
        .route("/api/hub/inbox/read", post(read_inbox))
        .route("/api/hub/activity", get(activity))
        .route("/api/hub/activity/seen-all", post(seen_all))
        .route("/api/hub/sessions/{id}/seen", post(seen))
        .route("/api/hub/recent-files", get(recent_files))
        .route("/api/hub/start", post(start))
}

#[derive(Deserialize)]
struct StartRequest {
    workspace_id: tendly_domain::WorkspaceId,
    provider: String,
    prompt: String,
    endpoint_id: Option<String>,
    model: Option<String>,
}

/// "O que a gente faz agora?": a new structured conversation that starts with
/// the prompt typed on the home page. It is kept, not temporary.
async fn start(State(state): State<AppState>, Json(request): Json<StartRequest>) -> Result<Json<Value>> {
    let prompt = request.prompt.trim().to_owned();
    if prompt.is_empty() {
        return Err(ApiError::bad("Type what the agent should do"));
    }
    let title: String = prompt.lines().next().unwrap_or("").chars().take(60).collect();
    let arguments = json!({
        "provider": request.provider,
        "prompt": prompt,
        "title": title,
        "keep": true,
        "endpoint_id": request.endpoint_id,
        "model": request.model,
    });
    let start = crate::agent_sessions::start_of(&arguments, true)?;
    let started = crate::agent_sessions::start_in(
        &state,
        request.workspace_id,
        start,
        None,
        json!({ "kind": "you" }),
        |_| async { Ok(()) },
    )
    .await?;
    Ok(Json(started))
}

fn now() -> String {
    Utc::now().to_rfc3339()
}

pub(super) async fn record_turn(state: &AppState, id: SessionId, status: &str) {
    let title = session_title(state, id).await;
    let status = status.to_owned();
    let kind = match status.as_str() {
        "failed" => "turn_failed",
        "interrupted" => return mark_turn(state, id, status).await,
        _ => "turn_completed",
    };
    mark_turn(state, id, status).await;
    notify(state, kind, Some(id), title, String::new()).await;
}

pub(super) async fn record_waiting(state: &AppState, id: SessionId) {
    let title = session_title(state, id).await;
    notify(state, "waiting", Some(id), title, String::new()).await;
}

async fn mark_turn(state: &AppState, id: SessionId, status: String) {
    let result = cs(state, move |c| {
        c.execute(
            "INSERT INTO session_activity(session_id, last_turn_at, last_turn_status)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(session_id) DO UPDATE SET last_turn_at = ?2, last_turn_status = ?3",
            params![id.to_string(), now(), status],
        )
    })
    .await;
    if let Err(error) = result {
        tracing::warn!(?error, "could not record turn");
    }
}

/// Adds one entry to the inbox. Texts are rendered by the browser from `kind`,
/// so they follow the person's language; `title` is the conversation's own title.
pub(crate) async fn notify(
    state: &AppState,
    kind: &'static str,
    session: Option<SessionId>,
    title: String,
    body: String,
) {
    let result = cs(state, move |c| {
        // A conversation keeps one unread entry of each kind; the newest wins.
        if let Some(id) = session {
            c.execute(
                "DELETE FROM notifications WHERE session_id = ?1 AND kind = ?2 AND read_at IS NULL",
                params![id.to_string(), kind],
            )?;
        }
        c.execute(
            "INSERT INTO notifications(kind, session_id, title, body, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![kind, session.map(|s| s.to_string()), title, body, now()],
        )?;
        // Keep the inbox bounded.
        c.execute(
            "DELETE FROM notifications WHERE id NOT IN (SELECT id FROM notifications ORDER BY id DESC LIMIT 500)",
            [],
        )
    })
    .await;
    if let Err(error) = result {
        tracing::warn!(?error, "could not record notification");
    }
}

async fn session_title(state: &AppState, id: SessionId) -> String {
    db(state, move |s| s.get_session(id))
        .await
        .ok()
        .flatten()
        .map(|s| s.title)
        .unwrap_or_default()
}

async fn inbox(State(state): State<AppState>) -> Result<Json<Value>> {
    let (items, unread) = cs(&state, |c| {
        let mut stmt = c.prepare(
            "SELECT id, kind, session_id, title, body, created_at, read_at
             FROM notifications ORDER BY id DESC LIMIT 100",
        )?;
        let items = stmt
            .query_map([], |r| {
                Ok(json!({
                    "id": r.get::<_, i64>(0)?,
                    "kind": r.get::<_, String>(1)?,
                    "session_id": r.get::<_, Option<String>>(2)?,
                    "title": r.get::<_, String>(3)?,
                    "body": r.get::<_, String>(4)?,
                    "created_at": r.get::<_, String>(5)?,
                    "read_at": r.get::<_, Option<String>>(6)?,
                }))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let unread: i64 =
            c.query_row("SELECT COUNT(*) FROM notifications WHERE read_at IS NULL", [], |r| r.get(0))?;
        Ok((items, unread))
    })
    .await?;
    Ok(Json(json!({ "items": items, "unread": unread })))
}

#[derive(Deserialize)]
struct ReadRequest {
    #[serde(default)]
    ids: Vec<i64>,
    #[serde(default)]
    all: bool,
}

async fn read_inbox(State(state): State<AppState>, Json(request): Json<ReadRequest>) -> Result<Json<Value>> {
    if !request.all && request.ids.is_empty() {
        return Err(ApiError::bad("Nothing to mark as read"));
    }
    cs(&state, move |c| {
        if request.all {
            c.execute("UPDATE notifications SET read_at = ?1 WHERE read_at IS NULL", params![now()])?;
        } else {
            for id in request.ids.iter().take(500) {
                c.execute(
                    "UPDATE notifications SET read_at = ?1 WHERE id = ?2 AND read_at IS NULL",
                    params![now(), id],
                )?;
            }
        }
        Ok(())
    })
    .await?;
    Ok(Json(json!({ "ok": true })))
}

async fn activity(State(state): State<AppState>) -> Result<Json<Value>> {
    let rows = cs(&state, |c| {
        let mut stmt =
            c.prepare("SELECT session_id, last_turn_at, last_turn_status, seen_at FROM session_activity")?;
        stmt.query_map([], |r| {
            let last: Option<String> = r.get(1)?;
            let seen: Option<String> = r.get(3)?;
            let unread = match (&last, &seen) {
                (Some(last), Some(seen)) => parse(last) > parse(seen),
                (Some(_), None) => true,
                _ => false,
            };
            Ok(json!({
                "session_id": r.get::<_, String>(0)?,
                "last_turn_at": last,
                "last_turn_status": r.get::<_, Option<String>>(2)?,
                "seen_at": seen,
                "unread": unread,
            }))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()
    })
    .await?;
    Ok(Json(json!({ "sessions": rows })))
}

fn parse(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value).ok().map(|d| d.with_timezone(&Utc))
}

async fn seen(State(state): State<AppState>, Path(id): Path<SessionId>) -> Result<Json<Value>> {
    cs(&state, move |c| {
        let id = id.to_string();
        let at = now();
        c.execute(
            "INSERT INTO session_activity(session_id, seen_at) VALUES (?1, ?2)
             ON CONFLICT(session_id) DO UPDATE SET seen_at = ?2",
            params![id, at],
        )?;
        c.execute(
            "UPDATE notifications SET read_at = ?1 WHERE session_id = ?2 AND read_at IS NULL",
            params![at, id],
        )
    })
    .await?;
    Ok(Json(json!({ "ok": true })))
}

async fn seen_all(State(state): State<AppState>) -> Result<Json<Value>> {
    cs(&state, |c| {
        let at = now();
        c.execute("UPDATE session_activity SET seen_at = ?1", params![at])?;
        c.execute(
            "UPDATE notifications SET read_at = ?1 WHERE read_at IS NULL AND session_id IS NOT NULL",
            params![at],
        )
    })
    .await?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
struct RecentQuery {
    limit: Option<usize>,
}

/// Directories nobody browses; their churn would bury real work.
const SKIP: &[&str] = &[
    "node_modules", "target", "dist", "build", ".venv", "venv", "__pycache__", ".next", ".turbo", ".cache",
    "vendor", "coverage",
];
const MAX_ENTRIES: usize = 20_000;
const MAX_DEPTH: usize = 8;

async fn recent_files(State(state): State<AppState>, Query(query): Query<RecentQuery>) -> Result<Json<Value>> {
    let limit = query.limit.unwrap_or(8).clamp(1, 50);
    let workspaces = db(&state, |s| s.list_workspaces()).await?;
    let files = tokio::task::spawn_blocking(move || {
        let mut all = Vec::new();
        for workspace in &workspaces {
            let mut found = Vec::new();
            walk(FsPath::new(&workspace.root_path), PathBuf::new(), 0, &mut found, &mut 0);
            for (modified, path) in found {
                all.push((modified, workspace.id, workspace.name.clone(), path));
            }
        }
        all.sort_by(|a, b| b.0.cmp(&a.0));
        all.truncate(limit);
        all
    })
    .await
    .map_err(ApiError::internal)?;
    let items: Vec<Value> = files
        .into_iter()
        .map(|(modified, workspace, name, path)| {
            json!({
                "workspace_id": workspace,
                "workspace_name": name,
                "path": path.to_string_lossy().replace('\\', "/"),
                "modified_at": DateTime::<Utc>::from(modified).to_rfc3339(),
            })
        })
        .collect();
    Ok(Json(json!({ "files": items })))
}

fn walk(root: &FsPath, relative: PathBuf, depth: usize, found: &mut Vec<(SystemTime, PathBuf)>, seen: &mut usize) {
    if depth > MAX_DEPTH || *seen > MAX_ENTRIES {
        return;
    }
    let Ok(entries) = std::fs::read_dir(root.join(&relative)) else { return };
    for entry in entries.flatten() {
        *seen += 1;
        if *seen > MAX_ENTRIES {
            return;
        }
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if name_str.starts_with('.') {
            continue;
        }
        let Ok(kind) = entry.file_type() else { continue };
        let child = relative.join(&name);
        if kind.is_dir() {
            if !SKIP.contains(&name_str.as_ref()) {
                walk(root, child, depth + 1, found, seen);
            }
        } else if kind.is_file() {
            if let Ok(modified) = entry.metadata().and_then(|m| m.modified()) {
                found.push((modified, child));
            }
        }
    }
}
