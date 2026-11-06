//! The skill routes through the real router and its guard.
use crate::{AppState, accounts, activity, agent, conversations, file_watch, security, worktree_setup};
use axum::{
    body::to_bytes,
    http::{Request, StatusCode},
};
use serde_json::Value;
use std::{fs, path::PathBuf, sync::Arc};
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
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn fixture() -> Fixture {
    let dir = std::env::temp_dir().join(format!("hub-catalog-api-{}", uuid::Uuid::new_v4()));
    let repo = dir.join("repo");
    fs::create_dir_all(&repo).unwrap();
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
    fn write(&self, path: &str, content: &str) {
        let target = self.dir.join("repo").join(path);
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(target, content).unwrap();
    }
    async fn get(&self, path: &str) -> (StatusCode, Value) {
        let request = Request::builder()
            .uri(path)
            .header("host", HOST)
            .header("x-tendly-client", "web")
            .header("authorization", format!("Bearer {TOKEN}"))
            .body(axum::body::Body::empty())
            .unwrap();
        let response = crate::router(self.state.clone()).oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), 64 << 20).await.unwrap();
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }
}

#[tokio::test]
async fn hub_catalog_skill_content_is_read_by_id_only() {
    let f = fixture();
    f.write(".claude/skills/local/SKILL.md", "---\nname: local-one\ndescription: A test.\n---\n# Local\nBody text.\n");
    f.write("secret.txt", "do not read");
    let (status, list) = f.get("/api/hub/catalog/skills").await;
    assert_eq!(status, StatusCode::OK, "{list}");
    let skill = list["skills"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["workspace_id"] == f.workspace.as_str())
        .cloned()
        .expect("the workspace skill");
    let id = skill["id"].as_str().unwrap();
    assert_eq!(id.len(), 24);

    let (status, body) = f.get(&format!("/api/hub/catalog/skills/{id}/content")).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["name"], "local-one");
    assert_eq!(body["path"], skill["path"]);
    assert!(body["content"].as_str().unwrap().contains("Body text."));
    assert_eq!(body["truncated"], false);

    // An unknown id, a malformed one or a path never reads anything.
    for bad in ["000000000000000000000000", "..%2F..%2Fsecret.txt", "ABCDEF", "secret.txt"] {
        let (status, _) = f.get(&format!("/api/hub/catalog/skills/{bad}/content")).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{bad}");
    }
    // A removed skill is gone from the next scan.
    fs::remove_dir_all(f.dir.join("repo/.claude/skills/local")).unwrap();
    let (status, _) = f.get(&format!("/api/hub/catalog/skills/{id}/content")).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn hub_catalog_env_keys_lists_names_by_workspace_and_never_a_value() {
    let f = fixture();
    f.write(".env", "STRIPE_SECRET_KEY=sk_live_do-not-show\nPORT=8080\n");
    f.write("api/.env.local", "DATABASE_URL=postgres://user:pw-hidden@host/db\n");
    f.write(".env.example", "STRIPE_SECRET_KEY=\n");
    f.write("node_modules/pkg/.env", "FROM_A_DEPENDENCY=1\n");
    let (status, body) = f.get("/api/hub/catalog/env-keys").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body,
        serde_json::json!({ "workspaces": [{
            "workspace_id": f.workspace,
            "workspace_name": "Fixture",
            "truncated": false,
            "files": [
                { "path": ".env", "names": [
                    { "name": "STRIPE_SECRET_KEY", "secret": true },
                    { "name": "PORT", "secret": false },
                ] },
                { "path": "api/.env.local", "names": [{ "name": "DATABASE_URL", "secret": false }] },
            ],
        }] })
    );
    let text = body.to_string();
    assert!(!text.contains("do-not-show") && !text.contains("pw-hidden") && !text.contains("8080"));

    // Like the rest of the API, it answers only to the person.
    let request = Request::builder()
        .uri("/api/hub/catalog/env-keys")
        .header("host", HOST)
        .body(axum::body::Body::empty())
        .unwrap();
    let response = crate::router(f.state.clone()).oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

    // A workspace with no such file is not listed at all.
    fs::remove_file(f.dir.join("repo/.env")).unwrap();
    fs::remove_dir_all(f.dir.join("repo/api")).unwrap();
    let (_, body) = f.get("/api/hub/catalog/env-keys").await;
    assert_eq!(body, serde_json::json!({ "workspaces": [] }));
}
