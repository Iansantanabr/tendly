//! Custom apps: validation, app.json, and the routes through the real router
//! and its guard.
use super::*;
use crate::{accounts, activity, agent, conversations, file_watch, security, worktree_setup};
use axum::{body::to_bytes, http::Request as HttpRequest};
use std::{fs, sync::Arc};
use tower::ServiceExt;

const HOST: &str = "127.0.0.1:8787";
const TOKEN: &str = "team-token";

#[test]
fn hub_apps_slugs_and_keys_are_validated() {
    for good in ["a", "pipeline", "crm-2", "0x", &"a".repeat(64)] {
        assert!(valid_slug(good), "{good}");
    }
    for bad in ["", "-a", "A", "has space", "a_b", "a.b", "..", "é", &"a".repeat(65)] {
        assert!(!valid_slug(bad), "{bad}");
    }
    for good in ["a", "A_b-9", "counter", &"k".repeat(64)] {
        assert!(valid_key(good), "{good}");
    }
    for bad in ["", "a.b", "a/b", "..", "a b", "ç", &"k".repeat(65)] {
        assert!(!valid_key(bad), "{bad}");
    }
}

#[test]
fn hub_apps_manifest_defaults_and_errors() {
    let m = parse_manifest("pipeline", r#"{"name":" pipeline "}"#).unwrap();
    assert_eq!(m.name, "pipeline");
    assert_eq!(m.letter, "P");
    assert_eq!(m.entry, "index.html");
    assert_eq!(m.description, "");
    assert!(COLORS.iter().any(|(c, _)| *c == m.color));
    assert_eq!(m.color, parse_manifest("pipeline", r#"{"name":"x"}"#).unwrap().color, "stable per slug");

    let m = parse_manifest(
        "crm",
        r#"{"name":"CRM","letter":"Cr","color":"Teal","description":"Leads","entry":"web/main.html","extra":1}"#,
    )
    .unwrap();
    assert_eq!((m.letter.as_str(), m.color.as_str(), m.entry.as_str()), ("Cr", "teal", "web/main.html"));
    assert_eq!(m.description, "Leads");

    for (bad, needle) in [
        ("not json", "not valid JSON"),
        ("[1]", "JSON object"),
        ("{}", "needs a \"name\""),
        (r#"{"name":"  "}"#, "needs a \"name\""),
        (r#"{"name":3}"#, "must be a string"),
        (r#"{"name":"A","color":"pink"}"#, "must be one of"),
        (r#"{"name":"A","letter":"abc"}"#, "one or two"),
        (r#"{"name":"A","entry":"../x.html"}"#, "entry"),
        (r#"{"name":"A","entry":"data/x.html"}"#, "entry"),
        (r#"{"name":"A","entry":"/etc/passwd"}"#, "entry"),
    ] {
        let error = parse_manifest("a", bad).unwrap_err();
        assert!(error.contains(needle), "{bad}: {error}");
    }
}

#[test]
fn hub_apps_clean_path_refuses_escapes_and_data() {
    assert_eq!(clean_path("index.html"), Some(PathBuf::from("index.html")));
    assert_eq!(clean_path("js/app.js"), Some(PathBuf::from("js/app.js")));
    assert_eq!(clean_path("assets/data/x.json"), Some(PathBuf::from("assets/data/x.json")));
    for bad in [
        "", "/etc/passwd", "../x", "a/../b", "./a", ".env", "a/.git/config", "a\\b", "a\0b", "a//b", "a/",
        "data", "data/counter.json", "C:/x", ".git/HEAD",
    ] {
        assert_eq!(clean_path(bad), None, "{bad:?}");
    }
}

#[test]
fn hub_apps_sdk_is_small_and_complete() {
    assert!(SDK.lines().count() < 80, "{} lines", SDK.lines().count());
    for needle in ["window.tendly", "credentials: 'same-origin'", "X-Tendly-Client", "remove", "list"] {
        assert!(SDK.contains(needle), "{needle}");
    }
}

#[test]
fn hub_apps_blank_page_escapes_the_name() {
    let m = parse_manifest("x", r#"{"name":"<b>Tom & Jerry</b>"}"#).unwrap();
    let page = blank_page(&m);
    assert!(page.contains("&lt;b&gt;Tom &amp; Jerry&lt;/b&gt;"));
    assert!(!page.contains("<b>Tom"));
    assert!(page.contains("/api/hub/apps/sdk.js"));
    assert!(!page.contains("{{"));
}

// ---------------------------------------------------------------------------
// Through the router

struct Fixture {
    state: AppState,
    dir: PathBuf,
    repo: PathBuf,
    workspace: String,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn fixture() -> Fixture {
    let dir = std::env::temp_dir().join(format!("hub-apps-api-{}", uuid::Uuid::new_v4()));
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
    Fixture { state, dir, repo, workspace }
}

struct Reply {
    status: StatusCode,
    headers: axum::http::HeaderMap,
    body: Vec<u8>,
}
impl Reply {
    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or(Value::Null)
    }
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
    fn header(&self, name: &str) -> &str {
        self.headers.get(name).and_then(|v| v.to_str().ok()).unwrap_or_default()
    }
}

impl Fixture {
    fn write(&self, path: &str, content: &str) {
        let target = self.repo.join(path);
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(target, content).unwrap();
    }
    fn base(&self, slug: &str) -> String {
        format!("/api/hub/apps/{}/{slug}", self.workspace)
    }
    async fn send(&self, method: &str, path: &str, body: impl Into<axum::body::Body>, web: bool) -> Reply {
        let mut request = HttpRequest::builder()
            .method(method)
            .uri(path)
            .header("host", HOST)
            .header("authorization", format!("Bearer {TOKEN}"))
            .header("content-type", "application/json");
        if web {
            request = request.header("x-tendly-client", "web");
        }
        let response = crate::router(self.state.clone()).oneshot(request.body(body.into()).unwrap()).await.unwrap();
        let (status, headers) = (response.status(), response.headers().clone());
        let body = to_bytes(response.into_body(), 4 << 20).await.unwrap().to_vec();
        Reply { status, headers, body }
    }
    async fn get(&self, path: &str) -> Reply {
        self.send("GET", path, axum::body::Body::empty(), false).await
    }
}

#[tokio::test]
async fn hub_apps_list_reports_apps_and_errors() {
    let f = fixture();
    f.write("apps/zeta/app.json", r#"{"name":"Zeta","color":"blue"}"#);
    f.write("apps/zeta/index.html", "<h1>z</h1>");
    f.write("apps/alpha/app.json", r#"{"name":"alpha","entry":"web/main.html","description":"First"}"#);
    f.write("apps/alpha/web/main.html", "<h1>a</h1>");
    f.write("apps/broken/app.json", "{nope");
    f.write("apps/noentry/app.json", r#"{"name":"No entry"}"#);
    f.write("apps/Bad_Name/app.json", r#"{"name":"Bad"}"#);
    f.write("apps/notes/readme.md", "not an app: no app.json");
    // A workspace whose folder is gone is skipped.
    f.state.store.create_workspace("Gone", &f.dir.join("missing").to_string_lossy()).unwrap();

    let reply = f.get("/api/hub/apps").await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text());
    let body = reply.json();
    let apps = body["apps"].as_array().unwrap();
    let names: Vec<&str> = apps.iter().map(|a| a["name"].as_str().unwrap()).collect();
    assert_eq!(names, ["alpha", "Zeta"]);
    let alpha = &apps[0];
    assert_eq!(alpha["workspace_id"], f.workspace.as_str());
    assert_eq!(alpha["workspace_name"], "Fixture");
    assert_eq!(alpha["slug"], "alpha");
    assert_eq!(alpha["letter"], "A");
    assert_eq!(alpha["description"], "First");
    assert_eq!(alpha["entry"], "web/main.html");
    assert_eq!(alpha["url"], format!("/api/hub/apps/{}/alpha/files/web/main.html", f.workspace));
    assert_eq!(alpha["code_path"], "apps/alpha/");
    assert!(chrono::DateTime::parse_from_rfc3339(alpha["updated_at"].as_str().unwrap()).is_ok());
    assert_eq!(apps[1]["color"], "blue");

    let errors = body["errors"].as_array().unwrap();
    let slugs: Vec<&str> = errors.iter().map(|e| e["slug"].as_str().unwrap()).collect();
    assert_eq!(slugs, ["Bad_Name", "broken", "noentry"]);
    assert!(errors.iter().all(|e| e["workspace_id"] == f.workspace.as_str() && e["message"].is_string()));
}

#[tokio::test]
async fn hub_apps_files_are_served_inside_the_app_only() {
    let f = fixture();
    f.write("apps/crm/app.json", r#"{"name":"CRM"}"#);
    f.write("apps/crm/index.html", "<h1>crm</h1>");
    f.write("apps/crm/js/app.js", "console.log(1)");
    f.write("apps/crm/.env", "SECRET=1");
    f.write("apps/crm/data/leads.json", "[1]");
    f.write("apps/other/app.json", r#"{"name":"Other"}"#);
    f.write("apps/other/index.html", "other");
    f.write("secret.txt", "workspace secret");
    let base = f.base("crm");

    let page = f.get(&format!("{base}/files/index.html")).await;
    assert_eq!(page.status, StatusCode::OK);
    assert_eq!(page.text(), "<h1>crm</h1>");
    assert!(page.header("content-type").starts_with("text/html"), "{}", page.header("content-type"));
    assert_eq!(page.header("content-security-policy"), "frame-ancestors 'self'");
    assert_eq!(page.header("cache-control"), "no-cache");
    let script = f.get(&format!("{base}/files/js/app.js")).await;
    assert_eq!(script.status, StatusCode::OK);
    assert!(script.header("content-type").contains("javascript"));

    for bad in [
        "files/../app.json",
        "files/%2e%2e/other/index.html",
        "files/js/%2e%2e/%2e%2e/other/index.html",
        "files/..%2fother%2findex.html",
        "files/.env",
        "files/data/leads.json",
        "files/data",
        "files/%2Fetc%2Fpasswd",
        "files/a%5Cb",
        "files/a%00b",
        "files/missing.html",
        "files/js",
    ] {
        let reply = f.get(&format!("{base}/{bad}")).await;
        assert_eq!(reply.status, StatusCode::NOT_FOUND, "{bad}");
        assert_eq!(reply.text(), "Not found", "{bad}");
    }
    // Unknown apps and workspaces are 404s too.
    assert_eq!(f.get(&format!("{}/files/index.html", f.base("nope"))).await.status, StatusCode::NOT_FOUND);
    let unknown = format!("/api/hub/apps/{}/crm/files/index.html", uuid::Uuid::new_v4());
    assert_eq!(f.get(&unknown).await.status, StatusCode::NOT_FOUND);
    assert_eq!(f.get("/api/hub/apps/not-a-uuid/crm/files/index.html").await.status, StatusCode::NOT_FOUND);

    // The bare files folder goes to the entry.
    for path in [format!("{base}/files/"), format!("{base}/files")] {
        let reply = f.get(&path).await;
        assert!(reply.status.is_redirection(), "{path}: {}", reply.status);
        assert_eq!(reply.header("location"), format!("{base}/files/index.html"));
    }

    // Without credentials the guard refuses.
    let request = HttpRequest::builder()
        .uri(format!("{base}/files/index.html"))
        .header("host", HOST)
        .body(axum::body::Body::empty())
        .unwrap();
    let response = crate::router(f.state.clone()).oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[cfg(unix)]
#[tokio::test]
async fn hub_apps_symlinks_out_of_the_app_are_not_served() {
    let f = fixture();
    f.write("apps/crm/app.json", r#"{"name":"CRM"}"#);
    f.write("apps/crm/index.html", "ok");
    f.write("outside.txt", "outside");
    std::os::unix::fs::symlink(f.repo.join("outside.txt"), f.repo.join("apps/crm/link.txt")).unwrap();
    std::os::unix::fs::symlink(f.repo.clone(), f.repo.join("apps/crm/up")).unwrap();
    let base = f.base("crm");
    assert_eq!(f.get(&format!("{base}/files/link.txt")).await.status, StatusCode::NOT_FOUND);
    assert_eq!(f.get(&format!("{base}/files/up/outside.txt")).await.status, StatusCode::NOT_FOUND);

    // An app folder that is itself a link out of the workspace is not an app.
    let elsewhere = f.dir.join("elsewhere");
    fs::create_dir_all(&elsewhere).unwrap();
    fs::write(elsewhere.join("app.json"), r#"{"name":"Elsewhere"}"#).unwrap();
    fs::write(elsewhere.join("index.html"), "x").unwrap();
    std::os::unix::fs::symlink(&elsewhere, f.repo.join("apps/elsewhere")).unwrap();
    assert_eq!(f.get(&format!("{}/files/index.html", f.base("elsewhere"))).await.status, StatusCode::NOT_FOUND);
    let list = f.get("/api/hub/apps").await.json();
    assert_eq!(list["apps"].as_array().unwrap().len(), 1);
    assert_eq!(list["errors"][0]["slug"], "elsewhere");
}

#[tokio::test]
async fn hub_apps_data_round_trip() {
    let f = fixture();
    f.write("apps/crm/app.json", r#"{"name":"CRM"}"#);
    f.write("apps/crm/index.html", "ok");
    let data = format!("{}/data", f.base("crm"));

    let empty = f.get(&data).await;
    assert_eq!(empty.status, StatusCode::OK);
    assert_eq!(empty.json(), json!({ "keys": [] }));
    assert_eq!(f.get(&format!("{data}/leads")).await.status, StatusCode::NOT_FOUND);

    let value = json!({ "leads": [{ "name": "Ana", "stage": "won" }], "n": 1.5 });
    let put = f.send("PUT", &format!("{data}/leads"), value.to_string(), true).await;
    assert_eq!(put.status, StatusCode::OK, "{}", put.text());
    let info = put.json();
    assert_eq!(info["key"], "leads");
    assert_eq!(info["size"], value.to_string().len() as u64);
    assert!(info["updated_at"].is_string());
    assert!(f.repo.join("apps/crm/data/leads.json").is_file());

    let got = f.get(&format!("{data}/leads")).await;
    assert_eq!(got.status, StatusCode::OK);
    assert!(got.header("content-type").starts_with("application/json"));
    assert_eq!(got.json(), value);

    assert_eq!(f.send("PUT", &format!("{data}/counter"), "3", true).await.status, StatusCode::OK);
    assert_eq!(f.send("PUT", &format!("{data}/counter"), "4", true).await.status, StatusCode::OK);
    assert_eq!(f.get(&format!("{data}/counter")).await.json(), json!(4));
    let keys = f.get(&data).await.json();
    let names: Vec<&str> = keys["keys"].as_array().unwrap().iter().map(|k| k["key"].as_str().unwrap()).collect();
    assert_eq!(names, ["counter", "leads"]);
    // No temporary files are left behind.
    assert_eq!(fs::read_dir(f.repo.join("apps/crm/data")).unwrap().count(), 2);

    let deleted = f.send("DELETE", &format!("{data}/leads"), axum::body::Body::empty(), true).await;
    assert_eq!(deleted.status, StatusCode::NO_CONTENT);
    assert_eq!(f.get(&format!("{data}/leads")).await.status, StatusCode::NOT_FOUND);
    assert_eq!(f.get(&data).await.json()["keys"].as_array().unwrap().len(), 1);

    // Writes need the client header; bad keys and bodies are refused.
    assert_eq!(f.send("PUT", &format!("{data}/x"), "1", false).await.status, StatusCode::FORBIDDEN);
    assert_eq!(f.send("PUT", &format!("{data}/a.b"), "1", true).await.status, StatusCode::BAD_REQUEST);
    assert_eq!(f.send("PUT", &format!("{data}/x"), "{nope", true).await.status, StatusCode::BAD_REQUEST);
    assert_eq!(f.send("PUT", &format!("{data}/x"), "", true).await.status, StatusCode::BAD_REQUEST);

    // The app must exist.
    let missing = format!("{}/data/x", f.base("nope"));
    assert_eq!(f.send("PUT", &missing, "1", true).await.status, StatusCode::NOT_FOUND);
    assert_eq!(f.get(&format!("{}/data", f.base("nope"))).await.status, StatusCode::NOT_FOUND);
    f.write("apps/broken/app.json", "{nope");
    assert_eq!(f.send("PUT", &format!("{}/data/x", f.base("broken")), "1", true).await.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn hub_apps_data_values_are_limited_to_one_megabyte() {
    let f = fixture();
    f.write("apps/crm/app.json", r#"{"name":"CRM"}"#);
    let url = format!("{}/data/big", f.base("crm"));
    let fits = format!("\"{}\"", "a".repeat(MAX_VALUE_BYTES - 2));
    assert_eq!(f.send("PUT", &url, fits, true).await.status, StatusCode::OK);
    let too_big = format!("\"{}\"", "a".repeat(MAX_VALUE_BYTES - 1));
    let reply = f.send("PUT", &url, too_big, true).await;
    assert_eq!(reply.status, StatusCode::PAYLOAD_TOO_LARGE);
    assert!(reply.json()["error"].as_str().unwrap().contains("1 MB"));
    assert_eq!(f.get(&url).await.body.len(), MAX_VALUE_BYTES);
}

#[tokio::test]
async fn hub_apps_scaffold_creates_a_blank_app_once() {
    let f = fixture();
    let url = format!("/api/hub/apps/{}/scaffold", f.workspace);
    let body = json!({ "slug": "pipeline", "name": "Pipeline", "description": "Deals", "color": "amber" });
    let created = f.send("POST", &url, body.to_string(), true).await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.text());
    let entry = created.json();
    assert_eq!(entry["slug"], "pipeline");
    assert_eq!(entry["name"], "Pipeline");
    assert_eq!(entry["letter"], "P");
    assert_eq!(entry["color"], "amber");
    assert_eq!(entry["description"], "Deals");
    assert_eq!(entry["entry"], "index.html");
    assert_eq!(entry["code_path"], "apps/pipeline/");
    assert_eq!(entry["workspace_name"], "Fixture");

    let manifest: Value = serde_json::from_str(&fs::read_to_string(f.repo.join("apps/pipeline/app.json")).unwrap()).unwrap();
    assert_eq!(manifest["name"], "Pipeline");
    let page = f.get(entry["url"].as_str().unwrap()).await;
    assert_eq!(page.status, StatusCode::OK);
    assert!(page.text().contains("<h1>Pipeline</h1>"));
    assert!(page.text().contains("prefers-color-scheme"));
    let list = f.get("/api/hub/apps").await.json();
    assert_eq!(list["apps"][0]["url"], entry["url"]);

    let again = f.send("POST", &url, body.to_string(), true).await;
    assert_eq!(again.status, StatusCode::CONFLICT);

    for bad in [
        json!({ "slug": "Bad Slug", "name": "X" }),
        json!({ "slug": "ok", "name": " " }),
        json!({ "slug": "ok", "name": "X", "color": "pink" }),
    ] {
        assert_eq!(f.send("POST", &url, bad.to_string(), true).await.status, StatusCode::BAD_REQUEST, "{bad}");
    }
    assert!(!f.repo.join("apps/ok").exists());
    let unknown = format!("/api/hub/apps/{}/scaffold", uuid::Uuid::new_v4());
    let reply = f.send("POST", &unknown, json!({ "slug": "x", "name": "X" }).to_string(), true).await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn hub_apps_scaffold_issues_template_is_a_list_kept_with_the_data_api() {
    let f = fixture();
    let url = format!("/api/hub/apps/{}/scaffold", f.workspace);
    let body = json!({ "slug": "reportes", "name": "Problemas <reportados>", "color": "rose", "template": "issues" });
    let created = f.send("POST", &url, body.to_string(), true).await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.text());
    let entry = created.json();
    assert_eq!(entry["code_path"], "apps/reportes/");
    assert_eq!(entry["color"], "rose");
    let page = f.get(entry["url"].as_str().unwrap()).await;
    assert_eq!(page.status, StatusCode::OK);
    let html = page.text();
    // The name is escaped, nothing of the template is left unfilled, and the list lives in tendly.data.
    assert!(html.contains("<h1>Problemas &lt;reportados&gt;</h1>"), "{html}");
    assert!(!html.contains("{{"));
    assert!(html.contains("/api/hub/apps/sdk.js"));
    assert!(html.contains("const KEY = 'issues';"));
    assert!(html.contains("tendly.data.get(KEY, [])") && html.contains("tendly.data.set(KEY, issues)"));
    // What a person types is shown as text, never as markup; removal is confirmed in the page.
    assert!(!html.contains("innerHTML") && !html.contains("confirm("));
    assert!(html.contains("prefers-color-scheme") && html.contains("pointer: coarse"));
    // It is not the blank app.
    assert!(!html.contains("id=\"plus\""));
    assert!(f.repo.join("apps/reportes/app.json").is_file());

    // The list the page writes is an ordinary value of the app.
    let data = format!("/api/hub/apps/{}/reportes/data/issues", f.workspace);
    let issues = json!([{ "id": "1", "title": "Bell does not clear", "details": "", "created_at": "2026-11-06T12:00:00Z", "done_at": null }]);
    assert_eq!(f.send("PUT", &data, issues.to_string(), true).await.status, StatusCode::OK);
    assert_eq!(f.get(&data).await.json(), issues);
    assert!(f.repo.join("apps/reportes/data/issues.json").is_file());

    // Only once: a second request does not touch what is there.
    assert_eq!(f.send("POST", &url, body.to_string(), true).await.status, StatusCode::CONFLICT);
    assert_eq!(f.get(&data).await.json(), issues);

    // The default is still the blank app, and an unknown template creates nothing.
    let blank = f.send("POST", &url, json!({ "slug": "plain", "name": "Plain", "template": "blank" }).to_string(), true).await;
    assert_eq!(blank.status, StatusCode::CREATED);
    assert!(f.get(blank.json()["url"].as_str().unwrap()).await.text().contains("id=\"plus\""));
    let unknown = f.send("POST", &url, json!({ "slug": "odd", "name": "Odd", "template": "crm" }).to_string(), true).await;
    assert_eq!(unknown.status, StatusCode::BAD_REQUEST);
    assert!(!f.repo.join("apps/odd").exists());
}

#[tokio::test]
async fn hub_apps_sdk_is_served_as_javascript() {
    let f = fixture();
    let reply = f.get("/api/hub/apps/sdk.js").await;
    assert_eq!(reply.status, StatusCode::OK);
    assert!(reply.header("content-type").starts_with("text/javascript"));
    assert!(reply.text().contains("window.tendly"));
}
