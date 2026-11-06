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
        .route("/api/hub/conversations", get(conversations))
}

/// Conversations that belong to no project still need a folder to run in:
/// one shared directory in Tendly's state, registered as a workspace the
/// sidebar hides. Registering the same path twice returns the same workspace.
async fn conversations(State(state): State<AppState>) -> Result<Json<Value>> {
    let workspace = ensure_conversations(&state).await?;
    Ok(Json(json!({ "workspace_id": workspace.id, "root_path": workspace.root_path })))
}

pub(super) async fn ensure_conversations(state: &AppState) -> Result<tendly_domain::Workspace> {
    let dir = state.state_dir.join("conversations");
    tokio::fs::create_dir_all(&dir).await.map_err(ApiError::internal)?;
    let dir = dunce::canonicalize(&dir).map_err(ApiError::internal)?;
    let root = dir.to_string_lossy().into_owned();
    db(state, move |s| s.create_workspace("Conversations", &root)).await
}

#[derive(Deserialize)]
struct StartRequest {
    workspace_id: tendly_domain::WorkspaceId,
    provider: String,
    prompt: String,
    endpoint_id: Option<String>,
    model: Option<String>,
    /// A reasoning effort (`low` … `max`), or `auto` for the client's own
    /// default; absent takes the preference, as "New session" does.
    effort: Option<String>,
    /// How tools are approved (`ask`, `plan`, `accept_edits`, `danger`, as the
    /// client offers them); absent takes the preference.
    permission: Option<String>,
}

/// `None` leaves the effort to the preference, `Some(None)` asks for the
/// client's own default and `Some(Some(level))` for that level.
fn effort_choice(value: Option<&str>) -> Result<Option<Option<String>>> {
    let Some(value) = value.map(str::trim).filter(|v| !v.is_empty()) else { return Ok(None) };
    if value == "auto" {
        return Ok(Some(None));
    }
    if !crate::providers::EFFORT_LEVELS.contains(&value) {
        return Err(ApiError::bad(format!(
            "effort must be auto or one of {}",
            crate::providers::EFFORT_LEVELS.join(", ")
        )));
    }
    Ok(Some(Some(value.to_owned())))
}

/// A permission mode the client offers; Codex has no plan or accept-edits.
fn permission_choice(provider: tendly_domain::ProviderKind, value: Option<&str>) -> Result<Option<String>> {
    let Some(value) = value.map(str::trim).filter(|v| !v.is_empty()) else { return Ok(None) };
    let modes = crate::adapters::adapter(provider).map_or(&[][..], |client| client.permission_modes());
    if !modes.contains(&value) {
        return Err(ApiError::bad(if modes.is_empty() {
            format!("{} has no permission modes to choose from", provider.label())
        } else {
            format!("permission for {} must be one of {}", provider.label(), modes.join(", "))
        }));
    }
    Ok(Some(value.to_owned()))
}

/// "O que a gente faz agora?": a new structured conversation that starts with
/// the prompt typed on the home page. It is kept, not temporary. Like
/// `agent_sessions::start_in`, but with the effort and permission the person
/// chose next to the prompt.
async fn start(State(state): State<AppState>, Json(request): Json<StartRequest>) -> Result<Json<Value>> {
    let prompt = request.prompt.trim().to_owned();
    if prompt.is_empty() {
        return Err(ApiError::bad("Type what the agent should do"));
    }
    let title: String = prompt.lines().next().unwrap_or("").chars().take(60).collect();
    let arguments = json!({ "provider": request.provider, "prompt": prompt, "title": title, "keep": true });
    // Checks the provider and the prompt the same way an agent's start is checked.
    let start = crate::agent_sessions::start_of(&arguments, true)?;
    let effort = effort_choice(request.effort.as_deref())?;
    let permission = permission_choice(start.provider, request.permission.as_deref())?;
    let mut input = json!({
        "interaction_mode": "structured",
        "provider": start.provider,
        "title": start.title,
        "endpoint_profile_id": request.endpoint_id.filter(|v| !v.trim().is_empty()),
        "model": request.model.filter(|v| !v.trim().is_empty()),
        "ephemeral": false,
    });
    if let Some(effort) = effort {
        input["effort"] = json!(effort);
    }
    let input: crate::CreateSession =
        serde_json::from_value(input).map_err(|error| ApiError::bad(error.to_string()))?;
    let (_, Json(created)) =
        crate::create_session(State(state.clone()), Path(request.workspace_id), Json(input)).await?;
    let id = created.id;
    // Recorded before the first start, which applies it (as the permission route does for a stopped session).
    if let Some(mode) = permission {
        state.chats.choose_permission(id, &mode);
    }
    crate::conversations::open(&state, id).await?;
    crate::conversations::say(&state, id, start.prompt).await?;
    state.activity.notify_with(
        json!({ "kind": "you" }),
        "Started session “{title}”",
        json!({ "title": created.title }),
        None,
        Some(json!({ "session_id": id })),
    );
    Ok(Json(json!({
        "started": {
            "id": id, "title": created.title, "provider": created.provider, "temporary": false,
            "worktree": null, "branch": null, "base": null, "preparing": false,
        },
    })))
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
    let (push_title, push_detail) = (title.clone(), body.clone());
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
    // The same news, on the devices that asked for it. Sent from a task of
    // its own, so the turn that ended is never kept waiting on a push service.
    super::push::dispatch(state, kind, session, &push_title, &push_detail);
}

/// An inbox entry that leads to a page of Tendly instead of a conversation:
/// what an app tells the person (`apps/tendly.rs`). `link` is a path of the
/// web app, such as `/apps/<workspace>/<slug>`.
pub(crate) async fn notify_link(state: &AppState, kind: &'static str, title: String, body: String, link: String) {
    let (push_title, push_detail, push_link) = (title.clone(), body.clone(), link.clone());
    let result = cs(state, move |c| {
        c.execute(
            "INSERT INTO notifications(kind, title, body, created_at, link) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![kind, title, body, now(), link],
        )?;
        c.execute(
            "DELETE FROM notifications WHERE id NOT IN (SELECT id FROM notifications ORDER BY id DESC LIMIT 500)",
            [],
        )
    })
    .await;
    if let Err(error) = result {
        tracing::warn!(?error, "could not record notification");
    }
    super::push::dispatch_link(state, kind, &push_title, &push_detail, &push_link);
}

/// Which conversations have a reply the person has not opened, and how their last turn ended.
pub(crate) fn activity_rows(c: &rusqlite::Connection) -> rusqlite::Result<Vec<(String, Option<String>, Option<String>, bool)>> {
    let mut stmt = c.prepare("SELECT session_id, last_turn_at, last_turn_status, seen_at FROM session_activity")?;
    stmt.query_map([], |r| {
        let last: Option<String> = r.get(1)?;
        let seen: Option<String> = r.get(3)?;
        let unread = match (&last, &seen) {
            (Some(last), Some(seen)) => parse(last) > parse(seen),
            (Some(_), None) => true,
            _ => false,
        };
        Ok((r.get::<_, String>(0)?, last, r.get::<_, Option<String>>(2)?, unread))
    })?
    .collect()
}

async fn session_title(state: &AppState, id: SessionId) -> String {
    db(state, move |s| s.get_session(id))
        .await
        .ok()
        .flatten()
        .map(|s| s.title)
        .unwrap_or_default()
}

#[derive(Deserialize)]
struct InboxQuery {
    /// The conversation this browser has on screen, in a focused window, with
    /// the person there: no push is sent for it while that stays true.
    focused: Option<String>,
}

async fn inbox(State(state): State<AppState>, Query(query): Query<InboxQuery>) -> Result<Json<Value>> {
    if let Some(session) = query.focused.as_deref() {
        super::push::looking_at(session);
    }
    let (items, unread) = cs(&state, |c| {
        let mut stmt = c.prepare(
            "SELECT id, kind, session_id, title, body, created_at, read_at, link
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
                    "link": r.get::<_, Option<String>>(7)?,
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

#[cfg(test)]
mod tests {
    use super::*;
    use tendly_domain::ProviderKind;

    #[test]
    fn hub_start_maps_effort_and_rejects_unknown_levels() {
        assert_eq!(effort_choice(None).unwrap(), None);
        assert_eq!(effort_choice(Some(" ")).unwrap(), None);
        assert_eq!(effort_choice(Some("auto")).unwrap(), Some(None));
        assert_eq!(effort_choice(Some("high")).unwrap(), Some(Some("high".into())));
        let error = effort_choice(Some("huge")).unwrap_err();
        assert!(error.message.contains("effort must be"), "{}", error.message);
    }

    #[test]
    fn hub_start_permission_follows_the_client() {
        assert_eq!(permission_choice(ProviderKind::ClaudeCode, None).unwrap(), None);
        assert_eq!(permission_choice(ProviderKind::ClaudeCode, Some("plan")).unwrap(), Some("plan".into()));
        assert_eq!(permission_choice(ProviderKind::Codex, Some("danger")).unwrap(), Some("danger".into()));
        assert!(permission_choice(ProviderKind::Codex, Some("plan")).is_err());
        assert!(permission_choice(ProviderKind::ClaudeCode, Some("yolo")).is_err());
    }
}
