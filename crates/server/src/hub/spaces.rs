//! Named spaces: saved Mesa layouts that can be reopened by name. Routes live
//! under `/api/hub/spaces`.
//!
//! A space keeps a copy of a layout. Opening one writes that copy as the
//! shared canvas through the same checks and revision compare-and-swap the
//! canvas save route uses (`canvas::save_checked`), so a window holding a
//! stale revision gets a 409 and nothing is overwritten, and every other
//! window hears the usual canvas change signal.
use super::cs;
use crate::{ApiError, AppState, Result};
use axum::{
    Json, Router,
    extract::{Path, State},
    http::StatusCode,
    routing::{get, post},
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

const MAX_NAME_CHARS: usize = 80;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/hub/spaces", get(list_route).post(create_route))
        .route(
            "/api/hub/spaces/{id}",
            get(get_route).patch(update_route).delete(delete_route),
        )
        .route("/api/hub/spaces/{id}/open", post(open_route))
}

#[derive(Debug, Clone, Serialize)]
struct Summary {
    id: String,
    name: String,
    position: i64,
    created_at: String,
    updated_at: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateSpace {
    name: String,
    layout: Value,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UpdateSpace {
    name: Option<String>,
    layout: Option<Value>,
    position: Option<i64>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OpenSpace {
    expected_revision: u64,
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// A trimmed name of 1–80 characters (characters, as SQLite's `length` counts them).
fn clean_name(name: &str) -> Result<String> {
    let name = name.trim();
    let chars = name.chars().count();
    if chars == 0 {
        return Err(ApiError::bad("A space needs a name"));
    }
    if chars > MAX_NAME_CHARS {
        return Err(ApiError::bad(format!("Space names are at most {MAX_NAME_CHARS} characters")));
    }
    if name.chars().any(char::is_control) {
        return Err(ApiError::bad("Space names cannot contain control characters"));
    }
    Ok(name.to_owned())
}

/// Another space already has this name, ignoring case.
fn name_taken(c: &Connection, name: &str, except: &str) -> rusqlite::Result<bool> {
    let wanted = name.to_lowercase();
    let mut statement = c.prepare("SELECT name FROM spaces WHERE id <> ?1")?;
    let names = statement.query_map([except], |r| r.get::<_, String>(0))?;
    for existing in names {
        if existing?.to_lowercase() == wanted {
            return Ok(true);
        }
    }
    Ok(false)
}

fn summary(r: &rusqlite::Row<'_>) -> rusqlite::Result<Summary> {
    Ok(Summary {
        id: r.get(0)?,
        name: r.get(1)?,
        position: r.get(2)?,
        created_at: r.get(3)?,
        updated_at: r.get(4)?,
    })
}

fn list(c: &Connection) -> rusqlite::Result<Vec<Summary>> {
    let mut statement = c.prepare(
        "SELECT id, name, position, created_at, updated_at FROM spaces ORDER BY position, name COLLATE NOCASE, name",
    )?;
    statement.query_map([], summary)?.collect()
}

/// One space with its layout.
fn load(c: &Connection, id: &str) -> rusqlite::Result<Option<(Summary, String)>> {
    c.query_row(
        "SELECT id, name, position, created_at, updated_at, layout FROM spaces WHERE id = ?1",
        [id],
        |r| Ok((summary(r)?, r.get::<_, String>(5)?)),
    )
    .optional()
}

fn view(space: &Summary, layout: &str) -> Result<Value> {
    let layout: Value = serde_json::from_str(layout).map_err(ApiError::internal)?;
    let mut value = serde_json::to_value(space).map_err(ApiError::internal)?;
    value["layout"] = layout;
    Ok(value)
}

/// The layout must be one the shared canvas would accept right now.
async fn check_layout(state: &AppState, layout: Value) -> Result<String> {
    let store = state.store.clone();
    tokio::task::spawn_blocking(move || {
        crate::canvas::validate(&store, &layout)?;
        Ok(layout.to_string())
    })
    .await
    .map_err(ApiError::internal)?
}

/// Outcome of a write closure: either rows changed or a client error to report.
enum Write<T> {
    Done(T),
    Missing,
    Taken,
}

fn finish<T>(outcome: Write<T>) -> Result<T> {
    match outcome {
        Write::Done(value) => Ok(value),
        Write::Missing => Err(ApiError::missing("Space")),
        Write::Taken => Err(ApiError::conflict("A space with this name already exists")),
    }
}

async fn list_route(State(state): State<AppState>) -> Result<Json<Value>> {
    let spaces = cs(&state, list).await?;
    Ok(Json(json!({ "spaces": spaces })))
}

async fn get_route(State(state): State<AppState>, Path(id): Path<String>) -> Result<Json<Value>> {
    let (space, layout) = cs(&state, move |c| load(c, &id))
        .await?
        .ok_or_else(|| ApiError::missing("Space"))?;
    Ok(Json(view(&space, &layout)?))
}

async fn create_route(
    State(state): State<AppState>,
    Json(input): Json<CreateSpace>,
) -> Result<(StatusCode, Json<Value>)> {
    let name = clean_name(&input.name)?;
    let layout = check_layout(&state, input.layout).await?;
    let id = uuid::Uuid::new_v4().to_string();
    let outcome = cs(&state, move |c| {
        if name_taken(c, &name, "")? {
            return Ok(Write::Taken);
        }
        let at = now();
        c.execute(
            "INSERT INTO spaces(id, name, layout, position, created_at, updated_at)
             VALUES (?1, ?2, ?3, (SELECT COALESCE(MAX(position) + 1, 0) FROM spaces), ?4, ?4)",
            params![id, name, layout, at],
        )?;
        Ok(Write::Done(load(c, &id)?.expect("just inserted")))
    })
    .await?;
    let (space, layout) = finish(outcome)?;
    Ok((StatusCode::CREATED, Json(view(&space, &layout)?)))
}

async fn update_route(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(input): Json<UpdateSpace>,
) -> Result<Json<Value>> {
    let name = input.name.as_deref().map(clean_name).transpose()?;
    let layout = match input.layout {
        Some(layout) => Some(check_layout(&state, layout).await?),
        None => None,
    };
    let position = input.position;
    let outcome = cs(&state, move |c| {
        if load(c, &id)?.is_none() {
            return Ok(Write::Missing);
        }
        if let Some(name) = &name
            && name_taken(c, name, &id)?
        {
            return Ok(Write::Taken);
        }
        c.execute(
            "UPDATE spaces SET name = COALESCE(?2, name), layout = COALESCE(?3, layout),
                 position = COALESCE(?4, position), updated_at = ?5
             WHERE id = ?1",
            params![id, name, layout, position, now()],
        )?;
        Ok(Write::Done(load(c, &id)?.expect("still there")))
    })
    .await?;
    let (space, layout) = finish(outcome)?;
    Ok(Json(view(&space, &layout)?))
}

async fn delete_route(State(state): State<AppState>, Path(id): Path<String>) -> Result<StatusCode> {
    let removed = cs(&state, move |c| c.execute("DELETE FROM spaces WHERE id = ?1", [id])).await?;
    if removed == 0 {
        return Err(ApiError::missing("Space"));
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn open_route(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(input): Json<OpenSpace>,
) -> Result<Json<Value>> {
    let (_, raw) = cs(&state, move |c| load(c, &id))
        .await?
        .ok_or_else(|| ApiError::missing("Space"))?;
    let layout: Value = serde_json::from_str(&raw).map_err(ApiError::internal)?;
    let store = state.store.clone();
    let saved = layout.clone();
    let revision = tokio::task::spawn_blocking(move || {
        crate::canvas::save_checked(&store, &saved, input.expected_revision)
    })
    .await
    .map_err(ApiError::internal)??
    .ok_or_else(|| {
        ApiError::conflict("Shared canvas changed in another client; reload the latest layout before opening a space")
    })?;
    state.activity.canvas_changed(revision);
    Ok(Json(json!({ "revision": revision, "layout": layout })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{accounts, activity, agent, conversations, file_watch, security, worktree_setup};
    use axum::{body::to_bytes, http::Request};
    use std::{path::PathBuf, sync::Arc};
    use tower::ServiceExt;

    const HOST: &str = "127.0.0.1:8787";
    const TOKEN: &str = "team-token";

    struct Fixture {
        state: AppState,
        dir: PathBuf,
        workspace: String,
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn fixture() -> Fixture {
        let dir = std::env::temp_dir().join(format!("hub-spaces-{}", uuid::Uuid::new_v4()));
        let repo = dir.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo = dunce::canonicalize(repo).unwrap();
        let state = AppState {
            store: Arc::new(tendly_persistence::Store::open(":memory:").unwrap()),
            runtime: tendly_runtime::RuntimeManager::new(),
            state_dir: dir.join("state"),
            roots: crate::host_roots::HostRoots::fixed(vec![repo.clone()], vec![dunce::canonicalize(&dir).unwrap()]),
            host_grants: crate::host_grants::HostGrants::default(),
            native_sources: Vec::new(),
            native_bridge: PathBuf::from("packages/native-bridge/history.mjs"),
            chat_fixture: None,
            chats: conversations::ChatManager::default(),
            watches: file_watch::FileWatches::default(),
            accounts: accounts::AccountManager::default(),
            security: security::Security::for_test(HOST.parse().unwrap(), Some(TOKEN)),
            tailnet: crate::tailscale::Tailnet::disabled(),
            peers: crate::peers::Peers::new(&dir.join("state")),
            claude_manual_mode: true,
            operations: Arc::new(tokio::sync::Mutex::new(())),
            agents: agent::AgentRegistry::default(),
            activity: activity::Activity::default(),
            setups: worktree_setup::Setups::default(),
            metrics: None,
            hub: Arc::new(crate::hub::HubStore::memory()),
        };
        let workspace = state.store.create_workspace("Fixture", &repo.to_string_lossy()).unwrap().id.to_string();
        Fixture { state, dir, workspace }
    }

    impl Fixture {
        async fn send(&self, method: &str, path: &str, body: Option<Value>) -> (StatusCode, Value) {
            let request = Request::builder()
                .method(method)
                .uri(path)
                .header("host", HOST)
                .header("authorization", format!("Bearer {TOKEN}"))
                .header("content-type", "application/json")
                .header("x-tendly-client", "web")
                .body(body.map(|b| axum::body::Body::from(b.to_string())).unwrap_or_default())
                .unwrap();
            let response = crate::router(self.state.clone()).oneshot(request).await.unwrap();
            let status = response.status();
            let bytes = to_bytes(response.into_body(), 4 << 20).await.unwrap();
            (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
        }
        fn layout(&self, pane: &str) -> Value {
            json!({ "version": 1, "root": { "type": "pane", "id": pane, "kind": "editor",
                "metadata": { "workspace_id": self.workspace } } })
        }
        async fn create(&self, name: &str) -> (StatusCode, Value) {
            self.send("POST", "/api/hub/spaces", Some(json!({ "name": name, "layout": self.layout("p1") }))).await
        }
    }

    #[test]
    fn hub_spaces_names_are_trimmed_and_limited() {
        assert_eq!(clean_name("  Ads report ").unwrap(), "Ads report");
        assert_eq!(clean_name(&"é".repeat(80)).unwrap().chars().count(), 80);
        for bad in ["", "   ", "a\nb"] {
            assert!(clean_name(bad).is_err(), "{bad:?}");
        }
        assert!(clean_name(&"a".repeat(81)).is_err());
    }

    #[tokio::test]
    async fn hub_spaces_create_validates_name_and_layout() {
        let f = fixture();
        let (status, created) = f.create(" Ads report ").await;
        assert_eq!(status, StatusCode::CREATED, "{created}");
        assert_eq!(created["name"], "Ads report");
        assert_eq!(created["layout"], f.layout("p1"));
        assert_eq!(created["position"], 0);

        for name in ["", "  ", &"x".repeat(81)] {
            let (status, _) = f.create(name).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{name:?}");
        }
        let bad_layouts = [
            json!({ "version": 2, "root": { "type": "pane", "id": "p", "kind": "editor" } }),
            json!({ "version": 1, "root": { "type": "pane", "id": "p", "kind": "spreadsheet" } }),
            json!({ "version": 1, "root": { "type": "pane", "id": "p", "kind": "editor",
                "metadata": { "workspace_id": f.workspace, "path": "../secret" } } }),
            json!({ "version": 1, "root": { "type": "pane", "id": "p", "kind": "git_diff" } }),
        ];
        for layout in bad_layouts {
            let (status, body) = f.send("POST", "/api/hub/spaces", Some(json!({ "name": "Other", "layout": layout }))).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        }
        let unknown = json!({ "version": 1, "root": { "type": "pane", "id": "p", "kind": "editor",
            "metadata": { "workspace_id": uuid::Uuid::new_v4().to_string() } } });
        let (status, _) = f.send("POST", "/api/hub/spaces", Some(json!({ "name": "Other", "layout": unknown }))).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "unknown workspace, as the canvas save reports it");
        let (_, listed) = f.send("GET", "/api/hub/spaces", None).await;
        assert_eq!(listed["spaces"].as_array().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn hub_spaces_duplicate_names_conflict_ignoring_case() {
        let f = fixture();
        assert_eq!(f.create("Ads report").await.0, StatusCode::CREATED);
        assert_eq!(f.create("ads REPORT").await.0, StatusCode::CONFLICT);
        assert_eq!(f.create("Ação").await.0, StatusCode::CREATED);
        assert_eq!(f.create("AÇÃO").await.0, StatusCode::CONFLICT, "non-ASCII case too");
        let (_, other) = f.create("Other").await;
        let path = format!("/api/hub/spaces/{}", other["id"].as_str().unwrap());
        let (status, _) = f.send("PATCH", &path, Some(json!({ "name": "ADS report" }))).await;
        assert_eq!(status, StatusCode::CONFLICT);
        let (status, renamed) = f.send("PATCH", &path, Some(json!({ "name": "OTHER" }))).await;
        assert_eq!(status, StatusCode::OK, "renaming to its own name in another case is fine");
        assert_eq!(renamed["name"], "OTHER");
    }

    #[tokio::test]
    async fn hub_spaces_list_orders_by_position_then_name_and_hides_layouts() {
        let f = fixture();
        let (_, c) = f.create("Charlie").await;
        let (_, a) = f.create("alpha").await;
        let (_, b) = f.create("Bravo").await;
        let names = |listed: &Value| -> Vec<String> {
            listed["spaces"].as_array().unwrap().iter().map(|s| s["name"].as_str().unwrap().to_owned()).collect()
        };
        let (_, listed) = f.send("GET", "/api/hub/spaces", None).await;
        assert_eq!(names(&listed), ["Charlie", "alpha", "Bravo"], "creation order by default");
        assert!(listed["spaces"][0].get("layout").is_none());
        for space in [&a, &b, &c] {
            let path = format!("/api/hub/spaces/{}", space["id"].as_str().unwrap());
            assert_eq!(f.send("PATCH", &path, Some(json!({ "position": 0 }))).await.0, StatusCode::OK);
        }
        let (_, listed) = f.send("GET", "/api/hub/spaces", None).await;
        assert_eq!(names(&listed), ["alpha", "Bravo", "Charlie"], "same position: by name, ignoring case");
        let path = format!("/api/hub/spaces/{}", a["id"].as_str().unwrap());
        f.send("PATCH", &path, Some(json!({ "position": 5 }))).await;
        let (_, listed) = f.send("GET", "/api/hub/spaces", None).await;
        assert_eq!(names(&listed), ["Bravo", "Charlie", "alpha"]);

        let (status, _) = f.send("PATCH", &path, Some(json!({ "layout": { "version": 1 } }))).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let (status, updated) = f.send("PATCH", &path, Some(json!({ "layout": f.layout("p9") }))).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(updated["layout"]["root"]["id"], "p9");
        let (_, fetched) = f.send("GET", &path, None).await;
        assert_eq!(fetched["layout"]["root"]["id"], "p9");

        let (status, _) = f.send("DELETE", &path, None).await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        assert_eq!(f.send("DELETE", &path, None).await.0, StatusCode::NOT_FOUND);
        assert_eq!(f.send("GET", &path, None).await.0, StatusCode::NOT_FOUND);
        assert_eq!(f.send("PATCH", &path, Some(json!({ "name": "x" }))).await.0, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn hub_spaces_open_saves_the_shared_canvas_with_its_revision() {
        let f = fixture();
        let (_, space) = f.create("Ads report").await;
        let open = format!("/api/hub/spaces/{}/open", space["id"].as_str().unwrap());
        let (_, canvas) = f.send("GET", "/api/canvas/layout", None).await;
        let revision = canvas["revision"].as_u64().unwrap();
        let mut events = f.state.activity.subscribe();

        let (status, opened) = f.send("POST", &open, Some(json!({ "expected_revision": revision }))).await;
        assert_eq!(status, StatusCode::OK, "{opened}");
        assert_eq!(opened["revision"].as_u64(), Some(revision + 1));
        assert_eq!(opened["layout"], f.layout("p1"));
        let (_, canvas) = f.send("GET", "/api/canvas/layout", None).await;
        assert_eq!(canvas["revision"].as_u64(), Some(revision + 1));
        assert_eq!(canvas["layout"], f.layout("p1"));
        let event = events.try_recv().expect("canvas change announced");
        assert_eq!(event, json!({ "type": "canvas", "revision": revision + 1 }));

        // A stale revision is refused and the canvas is left as it is.
        let (_, other) = f
            .send("POST", "/api/hub/spaces", Some(json!({ "name": "Other", "layout": f.layout("p2") })))
            .await;
        let open_other = format!("/api/hub/spaces/{}/open", other["id"].as_str().unwrap());
        let (status, _) = f.send("POST", &open_other, Some(json!({ "expected_revision": revision }))).await;
        assert_eq!(status, StatusCode::CONFLICT);
        let (_, canvas) = f.send("GET", "/api/canvas/layout", None).await;
        assert_eq!(canvas["revision"].as_u64(), Some(revision + 1));
        assert_eq!(canvas["layout"]["root"]["id"], "p1");

        let missing = format!("/api/hub/spaces/{}/open", uuid::Uuid::new_v4());
        assert_eq!(f.send("POST", &missing, Some(json!({ "expected_revision": revision + 1 }))).await.0, StatusCode::NOT_FOUND);
    }
}
