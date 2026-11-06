//! Tendly's own data, for apps: read-only, and only what the person allowed
//! that app (`grants.rs`). An app never calls these itself (its frame cannot
//! reach the API): the page that frames it does, when the app asks through
//! `postMessage`, and the check is made here whatever that page believes.
//!
//! - `sessions:read`: the conversations, as a list (title, state, workspace,
//!   client, age, one line of what the agent last said). Never a transcript.
//! - `files:read`: the files of the app's own workspace, listed and read as
//!   text up to 1 MB, under the rules of the file routes, and no dot-files.
//! - `automations:read`: the routines and their latest runs, without the
//!   command, the prompt or a run's output.
//! - `notify`: one entry in the bell (and a push), a few per app at a time.
use super::{find, grants};
use crate::{ApiError, AppState, Result, app::db, hub::cs, workspace_io};
use axum::{
    Json, Router,
    extract::{Path as UrlPath, Query, State},
    http::StatusCode,
    routing::{get, post},
};
use chrono::Utc;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{LazyLock, Mutex},
    time::{Duration, Instant},
};

/// The largest text file an app is handed.
const MAX_FILE_BYTES: usize = 1024 * 1024;
const DEFAULT_SESSIONS: usize = 100;
const MAX_SESSIONS: usize = 300;
const DEFAULT_RUNS: i64 = 5;
const MAX_RUNS: i64 = 20;
/// Notices one app may send per window.
const NOTICES: usize = 10;
const NOTICE_WINDOW: Duration = Duration::from_secs(10 * 60);
const TITLE_CHARS: usize = 80;
const BODY_CHARS: usize = 300;

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/hub/apps/{workspace_id}/{slug}/tendly/sessions", get(sessions_route))
        .route("/api/hub/apps/{workspace_id}/{slug}/tendly/files", get(files_route))
        .route("/api/hub/apps/{workspace_id}/{slug}/tendly/file", get(file_route))
        .route("/api/hub/apps/{workspace_id}/{slug}/tendly/automations", get(automations_route))
        .route("/api/hub/apps/{workspace_id}/{slug}/notify", post(notify_route))
}

// ---------------------------------------------------------------------------
// Conversations

#[derive(Deserialize)]
struct SessionsQuery {
    limit: Option<usize>,
    /// `1` also lists archived conversations.
    archived: Option<String>,
}

async fn sessions_route(
    State(state): State<AppState>,
    UrlPath((workspace, slug)): UrlPath<(String, String)>,
    Query(query): Query<SessionsQuery>,
) -> Result<Json<Value>> {
    let found = find(&state, &workspace, &slug).await?;
    grants::require(&state, &found, "sessions:read").await?;
    let limit = query.limit.unwrap_or(DEFAULT_SESSIONS).clamp(1, MAX_SESSIONS);
    let archived = matches!(query.archived.as_deref(), Some("1" | "true"));
    let (rows, total) = db(&state, move |store| {
        let names: HashMap<_, _> = store.list_workspaces()?.into_iter().map(|w| (w.id, w.name)).collect();
        let mut sessions = store.list_sessions(None)?;
        sessions.retain(|session| archived || session.archived_at.is_none());
        sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        let total = sessions.len();
        sessions.truncate(limit);
        let rows: Vec<_> = sessions
            .into_iter()
            .map(|session| {
                // One line of the last thing the agent said; a terminal has no conversation to read.
                let summary = (session.provider != tendly_domain::ProviderKind::Terminal)
                    .then(|| crate::hub::history::stored_message(store, session.id))
                    .flatten();
                let name = names.get(&session.workspace_id).cloned().unwrap_or_default();
                (session, name, summary)
            })
            .collect();
        Ok((rows, total))
    })
    .await?;
    let activity: HashMap<String, (Option<String>, Option<String>, bool)> = cs(&state, crate::hub::home::activity_rows)
        .await?
        .into_iter()
        .map(|(id, last, status, unread)| (id, (last, status, unread)))
        .collect();
    let now = Utc::now();
    let sessions: Vec<Value> = rows
        .into_iter()
        .map(|(session, workspace_name, summary)| {
            let seen = activity.get(&session.id.to_string());
            json!({
                "id": session.id,
                "title": session.title,
                "state": session.status,
                "workspace_id": session.workspace_id,
                "workspace_name": workspace_name,
                "provider": session.provider,
                "created_at": session.created_at.to_rfc3339(),
                "updated_at": session.updated_at.to_rfc3339(),
                "age_seconds": (now - session.updated_at).num_seconds().max(0),
                "archived": session.archived_at.is_some(),
                "unread": seen.is_some_and(|(_, _, unread)| *unread),
                "last_turn_at": seen.and_then(|(last, _, _)| last.clone()),
                "last_turn_status": seen.and_then(|(_, status, _)| status.clone()),
                "summary": summary,
            })
        })
        .collect();
    Ok(Json(json!({ "sessions": sessions, "total": total })))
}

// ---------------------------------------------------------------------------
// Files of the app's workspace

#[derive(Deserialize)]
struct PathQuery {
    path: Option<String>,
}

/// On top of the file routes' own rules, an app sees no dot-file or dot-folder
/// (`.env`, `.git`, a client's settings): those are where secrets live.
fn visible(path: &str) -> Result<()> {
    if path.split(['/', '\\']).any(|part| part.starts_with('.') && part != ".") {
        return Err(ApiError { status: StatusCode::FORBIDDEN, message: "Apps cannot read dot-files or dot-folders".into() });
    }
    Ok(())
}

async fn files_route(
    State(state): State<AppState>,
    UrlPath((workspace, slug)): UrlPath<(String, String)>,
    Query(query): Query<PathQuery>,
) -> Result<Json<Value>> {
    let found = find(&state, &workspace, &slug).await?;
    grants::require(&state, &found, "files:read").await?;
    let path = query.path.unwrap_or_default();
    visible(&path)?;
    let root = crate::app::root(&state, found.workspace.id).await?;
    let entries: Vec<_> = workspace_io::list_files(&root, &path)
        .await?
        .into_iter()
        .filter(|entry| !entry.name.starts_with('.'))
        .collect();
    Ok(Json(json!({ "path": path.trim_matches('/'), "entries": entries })))
}

async fn file_route(
    State(state): State<AppState>,
    UrlPath((workspace, slug)): UrlPath<(String, String)>,
    Query(query): Query<PathQuery>,
) -> Result<Json<Value>> {
    let found = find(&state, &workspace, &slug).await?;
    grants::require(&state, &found, "files:read").await?;
    let path = query.path.filter(|path| !path.trim().is_empty()).ok_or_else(|| ApiError::bad("Path required"))?;
    visible(&path)?;
    let root = crate::app::root(&state, found.workspace.id).await?;
    let file = workspace_io::read_file(&root, &path).await?;
    if file.content.len() > MAX_FILE_BYTES {
        return Err(ApiError { status: StatusCode::PAYLOAD_TOO_LARGE, message: "Apps can read text files up to 1 MB".into() });
    }
    Ok(Json(json!({ "path": file.path, "content": file.content, "size": file.content.len() })))
}

// ---------------------------------------------------------------------------
// Automations

#[derive(Deserialize)]
struct RunsQuery {
    /// How many of each automation's latest runs to include.
    runs: Option<i64>,
}

async fn automations_route(
    State(state): State<AppState>,
    UrlPath((workspace, slug)): UrlPath<(String, String)>,
    Query(query): Query<RunsQuery>,
) -> Result<Json<Value>> {
    let found = find(&state, &workspace, &slug).await?;
    grants::require(&state, &found, "automations:read").await?;
    let runs = query.runs.unwrap_or(DEFAULT_RUNS).clamp(1, MAX_RUNS);
    let automations = crate::hub::automations::list_for_apps(&state, runs).await?;
    Ok(Json(json!({ "automations": automations })))
}

// ---------------------------------------------------------------------------
// Notices

#[derive(Deserialize)]
struct NotifyBody {
    title: String,
    #[serde(default)]
    body: String,
}

/// When each app last sent notices, in memory: a restart forgets it.
static SENT: LazyLock<Mutex<HashMap<String, Vec<Instant>>>> = LazyLock::new(Default::default);

/// Whether the app may send one more notice now; counts it when it may.
fn may_notify(app: &str, now: Instant) -> bool {
    let mut sent = SENT.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    sent.retain(|_, times| {
        times.retain(|at| now.duration_since(*at) < NOTICE_WINDOW);
        !times.is_empty()
    });
    let times = sent.entry(app.to_owned()).or_default();
    if times.len() >= NOTICES {
        return false;
    }
    times.push(now);
    true
}

async fn notify_route(
    State(state): State<AppState>,
    UrlPath((workspace, slug)): UrlPath<(String, String)>,
    Json(body): Json<NotifyBody>,
) -> Result<Json<Value>> {
    let found = find(&state, &workspace, &slug).await?;
    grants::require(&state, &found, "notify").await?;
    let title = crate::hub::push::clean(&body.title, TITLE_CHARS);
    if title.is_empty() {
        return Err(ApiError::bad("A notification needs a title"));
    }
    let detail = crate::hub::push::clean(&body.body, BODY_CHARS);
    let app = format!("{}/{}", found.workspace.id, found.slug);
    if !may_notify(&app, Instant::now()) {
        return Err(ApiError {
            status: StatusCode::TOO_MANY_REQUESTS,
            message: "This app sent too many notifications; try again in a few minutes".into(),
        });
    }
    // Said to come from the app, and it opens the app.
    let shown = format!("{}: {title}", found.app.manifest.name);
    crate::hub::home::notify_link(&state, "app", shown, detail, format!("/apps/{app}")).await;
    Ok(Json(json!({ "ok": true })))
}
