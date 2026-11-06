//! Custom apps: validation, app.json, and the routes through the real router
//! and its guard.
use super::*;
use crate::{accounts, activity, agent, conversations, file_watch, security, worktree_setup};
use axum::{body::to_bytes, http::Request as HttpRequest};
use std::{fs, sync::Arc};
use tower::ServiceExt;

mod data;

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
    assert!(m.permissions.is_empty(), "an app asks for nothing unless it says so");
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
        (r#"{"name":"A","permissions":"notify"}"#, "list of strings"),
        (r#"{"name":"A","permissions":[1]}"#, "list of strings"),
        (r#"{"name":"A","permissions":["sessions:write"]}"#, "unknown permission \"sessions:write\""),
        (r#"{"name":"A","permissions":["*"]}"#, "the permissions are: sessions:read, files:read"),
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
    assert!(SDK.lines().count() < 480, "{} lines", SDK.lines().count());
    for needle in [
        "window.tendly", "data.get", "data.set", "data.list", "data.remove", "setContext", "openConversation",
        "openFile", "openApp", "openUrl", "draftChat", "notify", "toast", "onTheme", "onResize", "holdReload",
        "sessions.list", "workspace.files", "workspace.read", "automations.list", "permissions.get",
        "db.list", "db.count", "db.get", "db.insert", "db.update", "db.remove", "db.subscribe", "db.unsubscribe", "db.collections",
        "files.upload", "files.list", "files.remove", "error.current",
    ] {
        assert!(SDK.contains(needle), "{needle}");
    }
}

#[test]
fn hub_apps_sdk_never_calls_the_api_itself() {
    // The app's frame has no origin and no session: everything is asked of the page that frames it.
    for gone in ["fetch(", "XMLHttpRequest", "credentials:", "X-Tendly-Client", "document.cookie", "/api/hub/apps/' +"] {
        assert!(!SDK.contains(gone), "{gone}");
    }
    // It finds itself by the address app files are served from.
    assert!(SDK.contains(r"/^\/apps-run\/([^/]+)\/([^/]+)\/[^/]+(?:\/|$)/"));
    // Answers are taken from the parent window only, at the origin this file came from.
    assert!(SDK.contains("event.source !== window.parent || event.origin !== HOST_ORIGIN"));
    // Outside Tendly a call says so instead of hanging.
    assert!(SDK.contains("'outside'") && SDK.contains("CALL_TIMEOUT = 30000"));
}

#[test]
fn hub_apps_sdk_reports_errors_to_the_tendly_page_only() {
    // What it listens to, and what it offers.
    for needle in ["'error'", "'unhandledrejection'", "console.error = function", "holdReload", "'hold-reload'", "'location'"] {
        assert!(SDK.contains(needle), "{needle}");
    }
    // Every message goes through one function, to the parent, addressed to this page's own origin.
    assert_eq!(SDK.matches("postMessage(").count(), 1, "one place posts");
    assert!(SDK.contains("window.parent.postMessage(message, HOST_ORIGIN)"));
    // The app's own origin is opaque ("null"): Tendly is named by the address the SDK was served from.
    assert!(SDK.contains("var HOST_ORIGIN = location.protocol + '//' + location.host;"));
    assert!(!SDK.contains("location.origin;"));
    assert!(!SDK.contains("'*'"), "never to any origin");
    // Nothing is reported from a tab of its own, and the original console.error still runs.
    assert!(SDK.contains("window.parent !== window"));
    assert!(SDK.contains("consoleError.apply(console, arguments)"));
    // Bounded: a looping error cannot flood the page.
    assert!(SDK.contains("MAX_REPORTS = 50"));
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
    /// Where the app's files are served for now: `/apps-run/<ws>/<slug>/<token>/`.
    async fn frame(&self, slug: &str) -> String {
        let reply = self.get(&format!("{}/frame", self.base(slug))).await;
        assert_eq!(reply.status, StatusCode::OK, "{}", reply.text());
        reply.json()["base"].as_str().unwrap().to_owned()
    }
    /// A request as an app's frame makes it: a sandboxed page has no origin
    /// ("null"), is cross-site to everything, and carries no session.
    async fn from_frame(&self, method: &str, path: &str) -> Reply {
        self.raw(method, path, &[("origin", "null"), ("sec-fetch-site", "cross-site")]).await
    }
    async fn raw(&self, method: &str, path: &str, headers: &[(&str, &str)]) -> Reply {
        let mut request = HttpRequest::builder().method(method).uri(path).header("host", HOST);
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        let response = crate::router(self.state.clone()).oneshot(request.body(axum::body::Body::empty()).unwrap()).await.unwrap();
        let (status, headers) = (response.status(), response.headers().clone());
        let body = to_bytes(response.into_body(), 4 << 20).await.unwrap().to_vec();
        Reply { status, headers, body }
    }
    /// An app's stable address, followed to where it is served, as a browser would.
    async fn open(&self, url: &str) -> Reply {
        let reply = self.get(url).await;
        assert_eq!(reply.status, StatusCode::TEMPORARY_REDIRECT, "{url}: {}", reply.text());
        self.from_frame("GET", reply.header("location")).await
    }
    fn allow(&self, slug: &str, permissions: &[&str]) {
        let requested: Vec<String> = permissions.iter().map(|p| (*p).to_owned()).collect();
        self.state.hub.with(|c| grants::decide(c, &self.workspace, slug, &requested, &requested, "now")).unwrap();
    }
    fn frame_secret(&self) -> String {
        self.state.hub.with(|c| c.query_row("SELECT secret FROM app_frame_secret WHERE id = 1", [], |r| r.get(0))).unwrap()
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
    assert_eq!(alpha["permissions"], json!([]));
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
    let run = f.frame("crm").await;

    let page = f.from_frame("GET", &format!("{run}index.html")).await;
    assert_eq!(page.status, StatusCode::OK);
    assert_eq!(page.text(), "<h1>crm</h1>");
    assert!(page.header("content-type").starts_with("text/html"), "{}", page.header("content-type"));
    assert_eq!(page.header("cache-control"), "no-cache");
    let script = f.from_frame("GET", &format!("{run}js/app.js")).await;
    assert_eq!(script.status, StatusCode::OK);
    assert!(script.header("content-type").contains("javascript"));

    for bad in [
        "../app.json",
        "%2e%2e/other/index.html",
        "js/%2e%2e/%2e%2e/other/index.html",
        "..%2fother%2findex.html",
        ".env",
        "data/leads.json",
        "data",
        "%2Fetc%2Fpasswd",
        "a%5Cb",
        "a%00b",
        "missing.html",
        "js",
    ] {
        let reply = f.from_frame("GET", &format!("{run}{bad}")).await;
        assert_eq!(reply.status, StatusCode::NOT_FOUND, "{bad}");
        assert_eq!(reply.text(), "Not found", "{bad}");
        // The old address refuses the same paths, without a redirect that would say more.
        let old = f.get(&format!("{base}/files/{bad}")).await;
        assert_eq!(old.status, StatusCode::NOT_FOUND, "old {bad}");
    }
    // Unknown apps and workspaces are 404s too.
    assert_eq!(f.get(&format!("{}/files/index.html", f.base("nope"))).await.status, StatusCode::NOT_FOUND);
    let unknown = format!("/api/hub/apps/{}/crm/files/index.html", uuid::Uuid::new_v4());
    assert_eq!(f.get(&unknown).await.status, StatusCode::NOT_FOUND);
    assert_eq!(f.get("/api/hub/apps/not-a-uuid/crm/files/index.html").await.status, StatusCode::NOT_FOUND);

    // The old address of a file, and of the bare folder, sends the browser to where the app runs now.
    for (path, file) in [
        (format!("{base}/files/"), "index.html"),
        (format!("{base}/files"), "index.html"),
        (format!("{base}/files/index.html"), "index.html"),
        (format!("{base}/files/js/app.js?v=2"), "js/app.js?v=2"),
    ] {
        let reply = f.get(&path).await;
        assert_eq!(reply.status, StatusCode::TEMPORARY_REDIRECT, "{path}");
        let location = reply.header("location").to_owned();
        assert!(location.starts_with(&format!("/apps-run/{}/crm/", f.workspace)) && location.ends_with(&format!("/{file}")), "{location}");
        assert_eq!(reply.header("cache-control"), "no-store");
        assert_eq!(f.from_frame("GET", &location).await.status, StatusCode::OK, "{location}");
    }

    // Without credentials the guard refuses the old address: it mints an address for the app.
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
    let run = f.frame("crm").await;
    assert_eq!(f.from_frame("GET", &format!("{run}index.html")).await.status, StatusCode::OK);
    assert_eq!(f.from_frame("GET", &format!("{run}link.txt")).await.status, StatusCode::NOT_FOUND);
    assert_eq!(f.from_frame("GET", &format!("{run}up/outside.txt")).await.status, StatusCode::NOT_FOUND);
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
    assert_eq!(manifest["permissions"], json!([]), "written out, so the agent sees the field");
    assert_eq!(entry["permissions"], json!([]));
    let page = f.open(entry["url"].as_str().unwrap()).await;
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
    let page = f.open(entry["url"].as_str().unwrap()).await;
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
    assert!(f.open(blank.json()["url"].as_str().unwrap()).await.text().contains("id=\"plus\""));
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
    // An app's frame reads it with no origin and no session (it is the same script for everyone).
    let framed = f.from_frame("GET", "/api/hub/apps/sdk.js").await;
    assert_eq!(framed.status, StatusCode::OK);
    assert_eq!(framed.header("access-control-allow-origin"), "*");
    assert_eq!(framed.header("cross-origin-resource-policy"), "cross-origin");
    assert_eq!(framed.text(), reply.text());
}

// ---------------------------------------------------------------------------
// Reload on its own, and undo (`live.rs`)

impl Fixture {
    fn id(&self) -> tendly_domain::WorkspaceId {
        self.workspace.parse().unwrap()
    }
    /// Plays the watcher: these paths changed.
    fn touch(&self, paths: &[&str]) {
        for path in paths {
            self.state.hub.app_live.touched(self.id(), &self.repo, path);
        }
    }
    /// Plays the task: the app went quiet.
    async fn settle(&self, slug: &str) -> Option<Value> {
        live::testing::settle(&self.state, self.id(), slug).await
    }
    fn read(&self, path: &str) -> String {
        fs::read_to_string(self.repo.join(path)).unwrap()
    }
    async fn scaffold(&self, slug: &str) {
        let url = format!("/api/hub/apps/{}/scaffold", self.workspace);
        let reply = self.send("POST", &url, json!({ "slug": slug, "name": "Demo" }).to_string(), true).await;
        assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.text());
    }
    async fn undo(&self, slug: &str, id: &str) -> Reply {
        self.send("POST", &format!("{}/changes/{id}/undo", self.base(slug)), axum::body::Body::empty(), true).await
    }
}

#[test]
fn hub_apps_live_only_app_files_reload_an_app() {
    assert_eq!(live::app_path("apps/crm/index.html"), Some(("crm", "index.html")));
    assert_eq!(live::app_path("apps/crm/js/app.js"), Some(("crm", "js/app.js")));
    assert_eq!(live::app_path("apps/crm/assets/data/x.json"), Some(("crm", "assets/data/x.json")));
    for other in [
        "apps/crm", "apps/crm/", "apps/crm/data", "apps/crm/data/leads.json", "apps/crm/.env", "apps/crm/js/.cache/x",
        "apps/crm/files", "apps/crm/files/photo.png",
        "apps/Bad Name/index.html", "src/apps/crm/index.html", "notes.md", "apps/index.html", "apps/crm//x",
    ] {
        assert_eq!(live::app_path(other), None, "{other}");
    }
}

#[tokio::test]
async fn hub_apps_live_a_burst_is_one_change_once_the_app_is_quiet() {
    let f = fixture();
    f.scaffold("demo").await;
    // Data the app saves and paths elsewhere open no burst.
    f.touch(&["apps/demo/data/notes.json", "apps/demo/data", "README.md", "apps/demo"]);
    assert_eq!(live::testing::open_bursts(&f.state), 0);
    assert_eq!(f.get(&format!("{}/changes", f.base("demo"))).await.json()["latest"], Value::Null);

    f.write("apps/demo/index.html", "<h1>two</h1>");
    f.write("apps/demo/app.js", "let a = 1;");
    f.touch(&["apps/demo/index.html", "apps/demo/app.js", "apps/demo/index.html"]);
    assert_eq!(live::testing::open_bursts(&f.state), 1);
    // Not due while the files are still moving, due after the quiet time.
    assert_eq!(live::testing::due(&f.state, std::time::Duration::ZERO), 0);
    assert_eq!(live::testing::due(&f.state, live::QUIET), 1);

    let change = f.settle("demo").await.expect("a change");
    assert_eq!(change["count"], 2);
    assert_eq!(change["paths"], json!(["apps/demo/app.js", "apps/demo/index.html"]));
    assert_eq!(change["undoable"], true);
    assert_eq!(change["undo_of"], Value::Null);
    let listed = f.get(&format!("{}/changes", f.base("demo"))).await.json();
    assert_eq!(listed["latest"]["id"], change["id"]);
    assert_eq!(listed["quiet_ms"], 600);

    // A file touched without being changed is not a change: nothing to reload.
    f.touch(&["apps/demo/index.html"]);
    assert_eq!(f.settle("demo").await, None);
    assert_eq!(f.get(&format!("{}/changes", f.base("demo"))).await.json()["latest"]["id"], change["id"]);
    // An app that does not exist has no changes to ask about.
    assert_eq!(f.get(&format!("{}/changes", f.base("ghost"))).await.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn hub_apps_live_undo_puts_the_files_back_and_undoing_that_is_the_redo() {
    let f = fixture();
    f.scaffold("demo").await;
    let original = f.read("apps/demo/index.html");
    f.write("apps/demo/style.css", "body { color: red; }");
    f.touch(&["apps/demo/style.css"]);
    f.settle("demo").await.expect("the stylesheet arrived");

    // One burst: a file edited, one created, one deleted.
    f.write("apps/demo/index.html", "<h1>broken</h1>");
    f.write("apps/demo/extra.js", "console.log(1);");
    fs::remove_file(f.repo.join("apps/demo/style.css")).unwrap();
    f.touch(&["apps/demo/index.html", "apps/demo/extra.js", "apps/demo/style.css"]);
    let change = f.settle("demo").await.expect("a change");
    assert_eq!((change["count"].clone(), change["undoable"].clone()), (json!(3), json!(true)));
    let id = change["id"].as_str().unwrap().to_owned();

    // Writes need the web header, like every other change.
    let plain = f.send("POST", &format!("{}/changes/{id}/undo", f.base("demo")), axum::body::Body::empty(), false).await;
    assert_eq!(plain.status, StatusCode::FORBIDDEN);

    let undone = f.undo("demo", &id).await;
    assert_eq!(undone.status, StatusCode::OK, "{}", undone.text());
    let body = undone.json();
    assert_eq!(body["undone"], true);
    assert_eq!(body["restored"], json!(["apps/demo/index.html", "apps/demo/style.css"]));
    assert_eq!(body["removed"], json!(["apps/demo/extra.js"]));
    assert_eq!(body["skipped"], json!([]));
    assert_eq!(f.read("apps/demo/index.html"), original);
    assert_eq!(f.read("apps/demo/style.css"), "body { color: red; }");
    assert!(!f.repo.join("apps/demo/extra.js").exists());

    // The undo's own writes are the next change, marked as the undo of the first.
    f.touch(&["apps/demo/index.html", "apps/demo/extra.js", "apps/demo/style.css"]);
    let echo = f.settle("demo").await.expect("the undo is a change");
    assert_eq!(echo["undo_of"], json!(id));
    assert_eq!((echo["undoable"].clone(), echo["redo"].clone()), (json!(true), json!(false)));
    // The first change is not the latest anymore.
    assert_eq!(f.undo("demo", &id).await.status, StatusCode::CONFLICT);

    // Undoing the undo is the redo: the three files are as the burst left them.
    let redo = f.undo("demo", echo["id"].as_str().unwrap()).await;
    assert_eq!(redo.status, StatusCode::OK, "{}", redo.text());
    assert_eq!(f.read("apps/demo/index.html"), "<h1>broken</h1>");
    assert_eq!(f.read("apps/demo/extra.js"), "console.log(1);");
    assert!(!f.repo.join("apps/demo/style.css").exists());
    // ...and is announced as a redo, which can be undone like any change.
    f.touch(&["apps/demo/index.html", "apps/demo/extra.js", "apps/demo/style.css"]);
    let again = f.settle("demo").await.expect("the redo is a change");
    assert_eq!((again["undo_of"].clone(), again["redo"].clone()), (echo["id"].clone(), json!(true)));
    assert_eq!(again["undoable"], true);

    // The file history has every step, the restores credited to the person.
    let history = f
        .get(&format!("/api/hub/history?workspace_id={}&path=apps/demo/index.html", f.workspace))
        .await
        .json();
    let authors: Vec<&str> = history["versions"].as_array().unwrap().iter().map(|v| v["author_kind"].as_str().unwrap()).collect();
    assert_eq!(authors, ["you", "you", "unknown", "unknown"]);

    assert_eq!(f.undo("demo", "no-such-change").await.status, StatusCode::NOT_FOUND);
    assert_eq!(f.undo("ghost", &id).await.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn hub_apps_live_undo_leaves_what_it_cannot_put_back() {
    let f = fixture();
    f.scaffold("demo").await;
    // A picture changes with the page: the page comes back, the picture stays and is named.
    fs::write(f.repo.join("apps/demo/logo.png"), [0x89, b'P', b'N', b'G', 0, 1]).unwrap();
    f.touch(&["apps/demo/logo.png"]);
    let first = f.settle("demo").await.expect("the picture arrived");
    assert_eq!(first["undoable"], false, "a new binary file cannot be undone");
    assert_eq!(f.undo("demo", first["id"].as_str().unwrap()).await.status, StatusCode::CONFLICT);

    let original = f.read("apps/demo/index.html");
    f.write("apps/demo/index.html", "<h1>new</h1>");
    fs::write(f.repo.join("apps/demo/logo.png"), [0x89, b'P', b'N', b'G', 0, 2]).unwrap();
    f.touch(&["apps/demo/index.html", "apps/demo/logo.png"]);
    let change = f.settle("demo").await.unwrap();
    let body = f.undo("demo", change["id"].as_str().unwrap()).await.json();
    assert_eq!(body["restored"], json!(["apps/demo/index.html"]));
    assert_eq!(body["skipped"][0]["path"], "apps/demo/logo.png");
    assert_eq!(f.read("apps/demo/index.html"), original);
    assert_eq!(fs::read(f.repo.join("apps/demo/logo.png")).unwrap()[5], 2);

    // An app made behind Tendly's back (no index yet): its first burst does not
    // know what was there, so nothing is removed, least of all app.json.
    f.write("apps/fresh/app.json", r#"{"name":"Fresh"}"#);
    f.write("apps/fresh/index.html", "<p>hi</p>");
    f.touch(&["apps/fresh/app.json", "apps/fresh/index.html"]);
    let born = f.settle("fresh").await.unwrap();
    assert_eq!(born["undoable"], false);
    assert_eq!(f.undo("fresh", born["id"].as_str().unwrap()).await.status, StatusCode::CONFLICT);
    assert!(f.repo.join("apps/fresh/app.json").exists());
    // From then on it is indexed like any other.
    f.write("apps/fresh/index.html", "<p>bye</p>");
    f.touch(&["apps/fresh/index.html"]);
    let edit = f.settle("fresh").await.unwrap();
    assert_eq!(f.undo("fresh", edit["id"].as_str().unwrap()).await.status, StatusCode::OK);
    assert_eq!(f.read("apps/fresh/index.html"), "<p>hi</p>");
}

#[tokio::test]
async fn hub_apps_live_a_flood_of_paths_reloads_but_cannot_be_undone() {
    let f = fixture();
    f.scaffold("demo").await;
    let paths: Vec<String> = (0..=live::testing::max_paths() + 5).map(|n| format!("apps/demo/gen/f{n}.txt")).collect();
    f.touch(&paths.iter().map(String::as_str).collect::<Vec<_>>());
    let change = f.settle("demo").await.expect("still a reload");
    assert_eq!((change["count"].clone(), change["undoable"].clone()), (json!(0), json!(false)));
    assert_eq!(f.undo("demo", change["id"].as_str().unwrap()).await.status, StatusCode::CONFLICT);
}

#[tokio::test]
async fn hub_apps_live_asking_for_changes_indexes_an_app_seen_for_the_first_time() {
    let f = fixture();
    f.write("apps/old/app.json", r#"{"name":"Old"}"#);
    f.write("apps/old/index.html", "<p>one</p>");
    // A window shows the app: that is when its files are written down.
    assert_eq!(f.get(&format!("{}/changes", f.base("old"))).await.status, StatusCode::OK);
    f.write("apps/old/index.html", "<p>two</p>");
    f.write("apps/old/new.js", "1");
    f.touch(&["apps/old/index.html", "apps/old/new.js"]);
    let change = f.settle("old").await.unwrap();
    let body = f.undo("old", change["id"].as_str().unwrap()).await.json();
    assert_eq!(body["restored"], json!(["apps/old/index.html"]));
    assert_eq!(body["removed"], json!(["apps/old/new.js"]));
    assert_eq!(f.read("apps/old/index.html"), "<p>one</p>");
    // Without the index, a file with no history is not taken for a new one.
    live::testing::forget_index(&f.state, f.id(), "old");
    f.write("apps/old/keep.js", "2");
    f.touch(&["apps/old/keep.js"]);
    let unknown = f.settle("old").await.unwrap();
    assert_eq!(unknown["undoable"], false);
    assert!(f.repo.join("apps/old/keep.js").exists());
}

#[tokio::test]
async fn hub_apps_live_every_window_hears_the_change_after_the_quiet_time() {
    let f = fixture();
    f.scaffold("demo").await;
    let mut heard = f.state.activity.subscribe();
    live::start(f.state.clone());
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    f.write("apps/demo/index.html", "<h1>live</h1>");
    let started = std::time::Instant::now();
    f.touch(&["apps/demo/index.html"]);
    let event = tokio::time::timeout(std::time::Duration::from_secs(5), heard.recv()).await.expect("in time").unwrap();
    assert!(started.elapsed() >= live::QUIET, "{:?}", started.elapsed());
    assert_eq!(event["type"], "hub");
    assert_eq!(event["event"], "app-changed");
    assert_eq!(event["workspace_id"], json!(f.workspace));
    assert_eq!(event["slug"], "demo");
    assert_eq!(event["change"]["paths"], json!(["apps/demo/index.html"]));
    assert_eq!(event["change"]["undoable"], true);
}

// ---------------------------------------------------------------------------
// An origin of its own (`frame.rs`)

#[test]
fn hub_apps_frame_tokens_open_one_app_for_a_while() {
    let (now, ws) = (1_800_000_000, "0a0a0a0a-0000-4000-8000-000000000001");
    let token = frame::sign("secret", ws, "crm", now + 60);
    assert_eq!(frame::check("secret", ws, "crm", &token, now, None), frame::Token::Valid);
    // Another app, another workspace, another server: not this token.
    assert_eq!(frame::check("secret", ws, "other", &token, now, None), frame::Token::Forged);
    assert_eq!(frame::check("secret", "0a0a0a0a-0000-4000-8000-000000000002", "crm", &token, now, None), frame::Token::Forged);
    assert_eq!(frame::check("other secret", ws, "crm", &token, now, None), frame::Token::Forged);
    // Past its time it is lapsed, unless the page that frames the app kept it alive, and only that long.
    assert_eq!(frame::check("secret", ws, "crm", &token, now + 60, None), frame::Token::Lapsed);
    assert_eq!(frame::check("secret", ws, "crm", &token, now + 61, Some(now + 600)), frame::Token::Valid);
    assert_eq!(frame::check("secret", ws, "crm", &token, now + 600, Some(now + 600)), frame::Token::Lapsed);
    // A later expiry cannot be written in: the signature covers it.
    let (_, mac) = token.split_once('.').unwrap();
    for forged in [
        format!("{}.{mac}", now + 999_999),
        format!("+{}.{mac}", now + 60),
        format!("0{}.{mac}", now + 60),
        format!("{}.{}", now + 60, "0".repeat(64)),
        format!("{}.", now + 60),
        mac.to_owned(),
        String::new(),
        "garbage".into(),
    ] {
        assert_eq!(frame::check("secret", ws, "crm", &forged, now, None), frame::Token::Forged, "{forged}");
        // Keeping a forged token alive does not make it one.
        assert_eq!(frame::check("secret", ws, "crm", &forged, now, Some(now + 600)), frame::Token::Forged, "{forged}");
    }
    assert_eq!(frame::base(ws, "crm", &token), format!("/apps-run/{ws}/crm/{token}/"));
}

#[test]
fn hub_apps_frame_requests_are_reads_of_app_files_and_the_sdk() {
    use axum::http::Method;
    assert!(frame::is_frame_request(&Method::GET, "/apps-run/w/crm/t/index.html"));
    assert!(frame::is_frame_request(&Method::HEAD, "/apps-run/w/crm/t/app.js"));
    assert!(frame::is_frame_request(&Method::GET, "/api/hub/apps/sdk.js"));
    for (method, path) in [
        (Method::POST, "/apps-run/w/crm/t/index.html"),
        (Method::PUT, "/api/hub/apps/sdk.js"),
        (Method::OPTIONS, "/apps-run/w/crm/t/index.html"),
        (Method::GET, "/api/hub/apps"),
        (Method::GET, "/api/hub/apps/sdk.js/x"),
        (Method::GET, "/api/hub/apps/w/crm/data/k"),
        (Method::GET, "/api/hub/apps/w/crm/frame"),
        (Method::GET, "/apps-runner"),
        (Method::GET, "/"),
    ] {
        assert!(!frame::is_frame_request(&method, path), "{method} {path}");
    }
    // The policy is what takes the origin away: scripts run, same-origin is never granted.
    assert!(frame::POLICY.starts_with("sandbox allow-scripts"));
    assert!(!frame::POLICY.contains("allow-same-origin") && !frame::POLICY.contains("allow-top-navigation"));
    assert!(!frame::POLICY.contains("allow-popups-to-escape-sandbox"));
    assert!(frame::POLICY.contains("frame-ancestors 'self'"));
}

#[tokio::test]
async fn hub_apps_frames_serve_an_app_sandboxed_on_a_signed_address() {
    let f = fixture();
    f.write("apps/crm/app.json", r#"{"name":"CRM","entry":"web/main.html"}"#);
    f.write("apps/crm/web/main.html", "<h1>crm</h1>");
    f.write("apps/crm/web/app.js", "export const a = 1;");
    let reply = f.get(&format!("{}/frame", f.base("crm"))).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text());
    let frame = reply.json();
    let (base, token) = (frame["base"].as_str().unwrap(), frame["token"].as_str().unwrap());
    assert_eq!(base, format!("/apps-run/{}/crm/{token}/", f.workspace));
    assert_eq!(frame["url"], format!("{base}web/main.html"));
    let expires = chrono::DateTime::parse_from_rfc3339(frame["expires_at"].as_str().unwrap()).unwrap();
    let left = (expires.with_timezone(&chrono::Utc) - chrono::Utc::now()).num_seconds();
    assert!((frame::TTL_SECONDS - 60..=frame::TTL_SECONDS).contains(&left), "a few hours: {left}");
    assert!(frame["renew_after_seconds"].as_i64().unwrap() < frame::TTL_SECONDS);

    // The page: no session, no origin, and it still loads, into a sandbox without allow-same-origin.
    let page = f.from_frame("GET", frame["url"].as_str().unwrap()).await;
    assert_eq!(page.status, StatusCode::OK);
    assert_eq!(page.text(), "<h1>crm</h1>");
    let policy = page.header("content-security-policy");
    assert_eq!(policy, frame::POLICY);
    assert!(policy.contains("sandbox") && !policy.contains("allow-same-origin"));
    assert_eq!(page.header("x-content-type-options"), "nosniff");
    assert_eq!(page.header("referrer-policy"), "no-referrer", "the address is not told to other sites");
    // Its own files are another origin to it: readable with CORS, and not blocked as a cross-origin resource.
    let module = f.from_frame("GET", &format!("{base}web/app.js")).await;
    assert_eq!(module.status, StatusCode::OK);
    assert_eq!(module.header("access-control-allow-origin"), "*");
    assert_eq!(module.header("cross-origin-resource-policy"), "cross-origin");
    assert_eq!(f.from_frame("HEAD", &format!("{base}web/app.js")).await.status, StatusCode::OK);
    // Plain navigation (a tab) is served the same sandboxed page.
    let tab = f.raw("GET", frame["url"].as_str().unwrap(), &[]).await;
    assert_eq!((tab.status, tab.header("content-security-policy")), (StatusCode::OK, frame::POLICY));
    // The bare folder goes to the entry page, at the same address.
    for bare in [base.to_owned(), base.trim_end_matches('/').to_owned()] {
        let reply = f.from_frame("GET", &bare).await;
        assert_eq!(reply.status, StatusCode::TEMPORARY_REDIRECT, "{bare}");
        assert_eq!(reply.header("location"), format!("{base}web/main.html"));
    }
    // Nothing else lives under that prefix, and nothing can be written there.
    for odd in ["/apps-run/x", "/apps-run/a/b", &format!("/apps-run/{}/crm", f.workspace)] {
        assert_eq!(f.from_frame("GET", odd).await.status, StatusCode::NOT_FOUND, "{odd}");
    }
    for method in ["POST", "PUT", "DELETE"] {
        let reply = f.from_frame(method, &format!("{base}web/main.html")).await;
        assert_eq!(reply.status, StatusCode::FORBIDDEN, "{method}");
    }
    // Every other answer of the server keeps its resources to itself.
    assert_eq!(f.get("/api/hub/apps").await.header("cross-origin-resource-policy"), "same-origin");
}

#[tokio::test]
async fn hub_apps_frame_token_cannot_read_another_app_or_outside_its_folder() {
    let f = fixture();
    for slug in ["crm", "other"] {
        f.write(&format!("apps/{slug}/app.json"), r#"{"name":"App"}"#);
        f.write(&format!("apps/{slug}/index.html"), slug);
        f.write(&format!("apps/{slug}/data/secret.json"), "[1]");
    }
    f.write("apps/crm/.env", "SECRET=1");
    f.write("secret.txt", "workspace secret");
    let elsewhere = f.dir.join("second");
    fs::create_dir_all(elsewhere.join("apps/crm")).unwrap();
    fs::write(elsewhere.join("apps/crm/app.json"), r#"{"name":"Twin"}"#).unwrap();
    fs::write(elsewhere.join("apps/crm/index.html"), "twin").unwrap();
    let second = f.state.store.create_workspace("Second", &elsewhere.to_string_lossy()).unwrap().id.to_string();

    let base = f.frame("crm").await;
    let token = base.trim_end_matches('/').rsplit('/').next().unwrap().to_owned();
    assert_eq!(f.from_frame("GET", &format!("{base}index.html")).await.text(), "crm");

    // The same token under another app's address, or the same slug in another workspace.
    for stolen in [
        format!("/apps-run/{}/other/{token}/index.html", f.workspace),
        format!("/apps-run/{second}/crm/{token}/index.html"),
        format!("/apps-run/{}/crm/{token}x/index.html", f.workspace),
    ] {
        let reply = f.from_frame("GET", &stolen).await;
        assert_eq!((reply.status, reply.text().as_str()), (StatusCode::NOT_FOUND, "Not found"), "{stolen}");
    }
    // Out of its folder, into its data, or at a dot-file.
    for escape in [
        "../other/index.html",
        "../../other/x/index.html",
        "%2e%2e/other/index.html",
        "..%2f..%2f..%2fsecret.txt",
        "%2e%2e%2f%2e%2e%2fsecret.txt",
        "js/../../../secret.txt",
        "data/secret.json",
        ".env",
        "%2Fetc%2Fpasswd",
    ] {
        let reply = f.from_frame("GET", &format!("{base}{escape}")).await;
        assert_eq!(reply.status, StatusCode::NOT_FOUND, "{escape}");
        assert!(!reply.text().contains("secret") && !reply.text().contains("other"), "{escape}: {}", reply.text());
    }
    // The other app has an address of its own, which opens only that app.
    let other = f.frame("other").await;
    assert_eq!(f.from_frame("GET", &format!("{other}index.html")).await.text(), "other");
    assert_ne!(other.rsplit('/').nth(1), base.rsplit('/').nth(1));
}

#[tokio::test]
async fn hub_apps_frame_expired_or_forged_tokens_get_a_bare_404() {
    let f = fixture();
    f.write("apps/crm/app.json", r#"{"name":"CRM"}"#);
    f.write("apps/crm/index.html", "crm");
    let base = f.frame("crm").await;
    let token = base.trim_end_matches('/').rsplit('/').next().unwrap().to_owned();
    let (written, mac) = token.split_once('.').unwrap();
    let (secret, now) = (f.frame_secret(), chrono::Utc::now().timestamp());
    assert!(secret.len() >= 32);
    let at = |token: &str| format!("/apps-run/{}/crm/{token}/index.html", f.workspace);
    assert_eq!(f.from_frame("GET", &at(&token)).await.status, StatusCode::OK);

    let expired = frame::sign(&secret, &f.workspace, "crm", now - 1);
    let mut flipped = mac.to_owned();
    flipped.replace_range(..1, if mac.starts_with('0') { "1" } else { "0" });
    let stretched = format!("{}.{mac}", written.parse::<i64>().unwrap() + 3600);
    let foreign = frame::sign("not this server", &f.workspace, "crm", now + 3600);
    for (what, bad) in [
        ("expired", expired.clone()),
        ("forged", format!("{written}.{flipped}")),
        ("longer life", stretched),
        ("another server", foreign),
        ("no signature", format!("{written}.")),
        ("made up", "abc".into()),
    ] {
        let reply = f.from_frame("GET", &at(&bad)).await;
        assert_eq!(reply.status, StatusCode::NOT_FOUND, "{what}");
        assert_eq!(reply.text(), "Not found", "{what}: the same answer as a missing file");
        // A session does not help: the token is the only thing that opens this address.
        let signed_in = f.get(&at(&bad)).await;
        assert_eq!(signed_in.status, StatusCode::NOT_FOUND, "{what}");
    }
    // An unknown app answers exactly the same, so a token learns nothing about what exists.
    let nowhere = frame::sign(&secret, &f.workspace, "nope", now + 3600);
    let reply = f.from_frame("GET", &format!("/apps-run/{}/nope/{nowhere}/index.html", f.workspace)).await;
    assert_eq!((reply.status, reply.text().as_str()), (StatusCode::NOT_FOUND, "Not found"));

    // Renewing: the page that frames the app keeps a live token; a lapsed or forged one is gone.
    let renew = format!("{}/frame/renew", f.base("crm"));
    let kept = f.send("POST", &renew, json!({ "token": token }).to_string(), true).await;
    assert_eq!(kept.status, StatusCode::OK, "{}", kept.text());
    assert!(chrono::DateTime::parse_from_rfc3339(kept.json()["expires_at"].as_str().unwrap()).is_ok());
    assert_eq!(f.send("POST", &renew, json!({ "token": expired }).to_string(), true).await.status, StatusCode::GONE);
    assert_eq!(f.from_frame("GET", &at(&expired)).await.status, StatusCode::NOT_FOUND, "asking does not revive it");
    assert_eq!(f.send("POST", &renew, json!({ "token": "abc" }).to_string(), true).await.status, StatusCode::NOT_FOUND);
    let other_app = format!("{}/frame/renew", f.base("nope"));
    assert_eq!(f.send("POST", &other_app, json!({ "token": token }).to_string(), true).await.status, StatusCode::NOT_FOUND);
    // Only Tendly's page can renew: it is a mutation of the API like any other.
    assert_eq!(f.send("POST", &renew, json!({ "token": token }).to_string(), false).await.status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn hub_apps_frame_cannot_call_the_api() {
    let f = fixture();
    f.write("apps/crm/app.json", r#"{"name":"CRM","permissions":["sessions:read"]}"#);
    f.write("apps/crm/index.html", "crm");
    f.allow("crm", &["sessions:read"]);
    let base = f.base("crm");
    let run = f.frame("crm").await;
    let bearer = format!("Bearer {TOKEN}");
    assert_eq!(f.from_frame("GET", &format!("{run}index.html")).await.status, StatusCode::OK);

    let api = [
        "/api/workspaces".to_owned(),
        "/api/hub/apps".to_owned(),
        "/api/hub/settings".to_owned(),
        format!("{base}/data"),
        format!("{base}/data/leads"),
        format!("{base}/frame"),
        format!("{base}/grants"),
        format!("{base}/tendly/sessions"),
        format!("{base}/files/index.html"),
        format!("/api/workspaces/{}/file?path=secret.txt", f.workspace),
    ];
    for path in &api {
        // As the browser sends it from the sandbox: no origin, cross-site, no cookie.
        let reply = f.from_frame("GET", path).await;
        assert_eq!(reply.status, StatusCode::FORBIDDEN, "{path}");
        // Each mark alone is enough, and so is their absence: without a session there is nothing.
        assert_eq!(f.raw("GET", path, &[("origin", "null")]).await.status, StatusCode::FORBIDDEN, "{path}");
        assert_eq!(f.raw("GET", path, &[("sec-fetch-site", "cross-site")]).await.status, StatusCode::FORBIDDEN, "{path}");
        assert_eq!(f.raw("GET", path, &[]).await.status, StatusCode::UNAUTHORIZED, "{path}");
        // Even if the app somehow held the person's credentials, a request from its origin is refused.
        for marks in [
            vec![("origin", "null"), ("authorization", bearer.as_str())],
            vec![("sec-fetch-site", "cross-site"), ("authorization", bearer.as_str())],
        ] {
            assert_eq!(f.raw("GET", path, &marks).await.status, StatusCode::FORBIDDEN, "{path} {marks:?}");
        }
        // The same request from Tendly's own page is what works.
        assert_ne!(f.get(path).await.status, StatusCode::FORBIDDEN, "{path}");
    }
    // Writing from the frame: refused before it is looked at.
    for (method, path) in [
        ("PUT", format!("{base}/data/leads")),
        ("DELETE", format!("{base}/data/leads")),
        ("PUT", format!("{base}/grants")),
        ("POST", format!("{base}/notify")),
        ("POST", format!("{base}/frame/renew")),
        ("POST", "/api/hub/start".to_owned()),
        ("OPTIONS", format!("{base}/data/leads")),
    ] {
        let marks = [("origin", "null"), ("sec-fetch-site", "cross-site"), ("authorization", bearer.as_str()), ("x-tendly-client", "web")];
        assert_eq!(f.raw(method, &path, &marks).await.status, StatusCode::FORBIDDEN, "{method} {path}");
    }
    assert!(!f.repo.join("apps/crm/data").exists(), "nothing was written");
    // Nor can it pass as a page of Tendly by naming its address as the origin of a cross-site request.
    let reply = f.raw("GET", "/api/workspaces", &[("origin", "http://127.0.0.1:8787"), ("sec-fetch-site", "cross-site"), ("authorization", bearer.as_str())]).await;
    assert_eq!(reply.status, StatusCode::FORBIDDEN);
}

#[test]
fn hub_apps_pages_ask_for_their_own_scripts_with_cors() {
    let page = concat!(
        "<!doctype html><head>\n",
        "<script src=\"/api/hub/apps/sdk.js\"></script>\n",
        "<SCRIPT SRC='js/app.js' defer></SCRIPT>\n",
        "<script type=module src=./main.js></script>\n",
        "<script src=\"https://cdn.example/lib.js\"></script>\n",
        "<script src=\"//cdn.example/lib.js\"></script>\n",
        "<script src=\"a.js\" crossorigin=\"use-credentials\"></script>\n",
        "<script src=\"b.js\" CrossOrigin></script>\n",
        "<script data-x=\"a > b\" src=\"c.js\"></script>\n",
        "<script>const s = '<script src=\"d.js\">'; if (a<script.length) {}</script>\n",
        "<scripts src=\"e.js\"></scripts><script-x src=\"f.js\"></script-x>\n",
        "<script src=\"\"></script><script async></script>\n",
        "<p>é <script src=\"g.js\"",
    );
    let out = with_cors_scripts(page);
    for changed in [
        "<script crossorigin src=\"/api/hub/apps/sdk.js\">",
        "<SCRIPT crossorigin SRC='js/app.js' defer>",
        "<script crossorigin type=module src=./main.js>",
        "<script crossorigin data-x=\"a > b\" src=\"c.js\">",
        "'<script crossorigin src=\"d.js\">'",
    ] {
        assert!(out.contains(changed), "{changed}\n{out}");
    }
    assert_eq!(out.matches(" crossorigin ").count(), 5, "{out}");
    for kept in [
        "<script src=\"https://cdn.example/lib.js\">",
        "<script src=\"//cdn.example/lib.js\">",
        "<script src=\"a.js\" crossorigin=\"use-credentials\">",
        "<script src=\"b.js\" CrossOrigin>",
        "if (a<script.length) {}",
        "<scripts src=\"e.js\">",
        "<script-x src=\"f.js\">",
        "<script src=\"\"></script><script async></script>",
        "<p>é <script src=\"g.js\"",
    ] {
        assert!(out.contains(kept), "{kept}\n{out}");
    }
    // Nothing to change: the page is handed back as it is.
    let plain = "<h1>no scripts</h1><script>let a = 1;</script>";
    assert!(matches!(with_cors_scripts(plain), std::borrow::Cow::Borrowed(_)));
}

#[tokio::test]
async fn hub_apps_frame_serves_pages_adjusted_and_everything_else_untouched() {
    let f = fixture();
    f.write("apps/crm/app.json", r#"{"name":"CRM"}"#);
    f.write("apps/crm/index.html", "<script src=\"app.js\"></script><script src=\"https://cdn.example/x.js\"></script>");
    f.write("apps/crm/app.js", "const t = '<script src=\"x.js\">';");
    let run = f.frame("crm").await;
    let page = f.from_frame("GET", &format!("{run}index.html")).await;
    assert_eq!(page.text(), "<script crossorigin src=\"app.js\"></script><script src=\"https://cdn.example/x.js\"></script>");
    assert_eq!(page.header("content-type"), "text/html; charset=utf-8");
    assert_eq!(f.from_frame("GET", &format!("{run}app.js")).await.text(), "const t = '<script src=\"x.js\">';");
    // The file on disk is the agent's: never rewritten.
    assert!(!f.read("apps/crm/index.html").contains("crossorigin"));
}

// ---------------------------------------------------------------------------
// Permissions (`grants.rs`)

#[test]
fn hub_apps_permissions_are_known_names_in_one_order() {
    let parse = |text: &str| grants::parse_permissions(serde_json::from_str::<Value>(text).ok().as_ref());
    assert_eq!(parse("null").unwrap(), Vec::<String>::new());
    assert_eq!(grants::parse_permissions(None).unwrap(), Vec::<String>::new());
    assert_eq!(parse(r#"["notify"," sessions:read ","notify"]"#).unwrap(), ["sessions:read", "notify"]);
    assert_eq!(
        parse(r#"["agent:draft","notify","automations:read","files:read","sessions:read"]"#).unwrap(),
        grants::PERMISSIONS
    );
    assert!(parse(r#"["sessions:read","everything"]"#).unwrap_err().contains("unknown permission \"everything\""));
    assert!(parse(r#"{"notify":true}"#).is_err());
    let m = parse_manifest("crm", r#"{"name":"CRM","permissions":["notify","files:read"]}"#).unwrap();
    assert_eq!(m.permissions, ["files:read", "notify"]);
}

#[tokio::test]
async fn hub_apps_grants_are_asked_once_and_again_when_the_list_grows() {
    let f = fixture();
    f.write("apps/plain/app.json", r#"{"name":"Plain"}"#);
    f.write("apps/plain/index.html", "x");
    f.write("apps/crm/app.json", r#"{"name":"CRM","permissions":["sessions:read","notify"]}"#);
    f.write("apps/crm/index.html", "x");
    let url = format!("{}/grants", f.base("crm"));

    // An app that asks for nothing has nothing to answer.
    let plain = f.get(&format!("{}/grants", f.base("plain"))).await.json();
    assert_eq!(plain, json!({ "requested": [], "granted": [], "refused": [], "pending": [], "status": "none" }));

    // First open: everything it asks waits for the person.
    let first = f.get(&url).await.json();
    assert_eq!(first["status"], "ask");
    assert_eq!(first["requested"], json!(["sessions:read", "notify"]));
    assert_eq!(first["pending"], first["requested"]);
    assert_eq!((first["granted"].clone(), first["refused"].clone()), (json!([]), json!([])));
    let list = f.get("/api/hub/apps").await.json();
    let crm = list["apps"].as_array().unwrap().iter().find(|a| a["slug"] == "crm").unwrap();
    assert_eq!(crm["permissions"], json!(["sessions:read", "notify"]));

    // Refuse: recorded, and not asked again.
    let refused = f.send("PUT", &url, json!({ "granted": [] }).to_string(), true).await;
    assert_eq!(refused.status, StatusCode::OK, "{}", refused.text());
    assert_eq!(refused.json()["status"], "refused");
    assert_eq!(f.get(&url).await.json()["refused"], json!(["sessions:read", "notify"]));
    // Allow one, then all.
    let partial = f.send("PUT", &url, json!({ "granted": ["notify"] }).to_string(), true).await.json();
    assert_eq!((partial["status"].clone(), partial["granted"].clone(), partial["refused"].clone()), (json!("partial"), json!(["notify"]), json!(["sessions:read"])));
    let all = f.send("PUT", &url, json!({ "granted": ["sessions:read", "notify"] }).to_string(), true).await.json();
    assert_eq!((all["status"].clone(), all["pending"].clone()), (json!("granted"), json!([])));

    // The app asks for one more thing: that is a new question; what was answered stays answered.
    f.write("apps/crm/app.json", r#"{"name":"CRM","permissions":["sessions:read","notify","files:read"]}"#);
    let grown = f.get(&url).await.json();
    assert_eq!(grown["status"], "ask");
    assert_eq!(grown["pending"], json!(["files:read"]));
    assert_eq!(grown["granted"], json!(["sessions:read", "notify"]));
    // It stops asking for something: the answer is dropped, so asking again is asked again.
    f.write("apps/crm/app.json", r#"{"name":"CRM","permissions":["sessions:read"]}"#);
    let shrunk = f.get(&url).await.json();
    assert_eq!((shrunk["status"].clone(), shrunk["requested"].clone()), (json!("granted"), json!(["sessions:read"])));
    f.write("apps/crm/app.json", r#"{"name":"CRM","permissions":["sessions:read","notify"]}"#);
    let back = f.get(&url).await.json();
    assert_eq!((back["status"].clone(), back["pending"].clone()), (json!("ask"), json!(["notify"])));

    // Only what the app asks can be allowed; the body is exact; the answer is a mutation.
    let extra = f.send("PUT", &url, json!({ "granted": ["files:read"] }).to_string(), true).await;
    assert_eq!(extra.status, StatusCode::BAD_REQUEST);
    assert!(extra.json()["error"].as_str().unwrap().contains("does not ask for \"files:read\""));
    assert!(f.send("PUT", &url, json!({ "granted": [], "all": true }).to_string(), true).await.status.is_client_error());
    assert_eq!(f.send("PUT", &url, json!({ "granted": [] }).to_string(), false).await.status, StatusCode::FORBIDDEN);
    assert_eq!(f.get(&format!("{}/grants", f.base("nope"))).await.status, StatusCode::NOT_FOUND);
    // Answers are per app.
    assert_eq!(f.get(&format!("{}/grants", f.base("plain"))).await.json()["status"], "none");
}

// ---------------------------------------------------------------------------
// Tendly's data, for apps (`tendly.rs`)

#[tokio::test]
async fn hub_apps_tendly_data_needs_the_permission_asked_and_allowed() {
    let f = fixture();
    f.write("apps/plain/app.json", r#"{"name":"Plain"}"#);
    f.write("apps/plain/index.html", "x");
    f.write("apps/crm/app.json", r#"{"name":"CRM","permissions":["sessions:read","files:read","automations:read","notify"]}"#);
    f.write("apps/crm/index.html", "x");
    let routes = [
        ("GET", "tendly/sessions", "sessions:read"),
        ("GET", "tendly/files", "files:read"),
        ("GET", "tendly/file?path=apps/crm/app.json", "files:read"),
        ("GET", "tendly/automations", "automations:read"),
        ("POST", "notify", "notify"),
    ];
    let body = || json!({ "title": "Hello" }).to_string();
    for (method, route, permission) in routes {
        // Not asked for in app.json: the error says where to ask.
        let reply = f.send(method, &format!("{}/{route}", f.base("plain")), body(), true).await;
        assert_eq!(reply.status, StatusCode::FORBIDDEN, "{route}");
        let message = reply.json()["error"].as_str().unwrap().to_owned();
        assert!(message.contains(&format!("no \"{permission}\" permission")) && message.contains("apps/plain/app.json"), "{message}");
        // Asked for and not answered, then refused: the error says who can allow it.
        for refused in [false, true] {
            if refused {
                let url = format!("{}/grants", f.base("crm"));
                assert_eq!(f.send("PUT", &url, json!({ "granted": [] }).to_string(), true).await.status, StatusCode::OK);
            }
            let reply = f.send(method, &format!("{}/{route}", f.base("crm")), body(), true).await;
            assert_eq!(reply.status, StatusCode::FORBIDDEN, "{route}");
            let message = reply.json()["error"].as_str().unwrap().to_owned();
            assert!(message.contains(&format!("\"{permission}\" permission was not allowed")) && message.contains("Permissions"), "{message}");
        }
        f.state.hub.with(|c| c.execute("DELETE FROM app_grants", [])).unwrap();
    }
    // Allowed: each answers.
    f.allow("crm", &["sessions:read", "files:read", "automations:read", "notify"]);
    for (method, route, _) in routes {
        let reply = f.send(method, &format!("{}/{route}", f.base("crm")), body(), true).await;
        assert_eq!(reply.status, StatusCode::OK, "{route}: {}", reply.text());
    }
    // One permission does not open another.
    f.state.hub.with(|c| c.execute("DELETE FROM app_grants", [])).unwrap();
    f.allow("crm", &["notify"]);
    assert_eq!(f.get(&format!("{}/tendly/sessions", f.base("crm"))).await.status, StatusCode::FORBIDDEN);
    // Nor does another app's.
    f.write("apps/twin/app.json", r#"{"name":"Twin","permissions":["sessions:read"]}"#);
    f.write("apps/twin/index.html", "x");
    f.allow("crm", &["sessions:read", "notify"]);
    assert_eq!(f.get(&format!("{}/tendly/sessions", f.base("twin"))).await.status, StatusCode::FORBIDDEN);
    assert_eq!(f.get(&format!("{}/tendly/sessions", f.base("nope"))).await.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn hub_apps_tendly_sessions_are_a_list_without_transcripts() {
    use tendly_domain::ProviderKind;
    let f = fixture();
    f.write("apps/board/app.json", r#"{"name":"Board","permissions":["sessions:read"]}"#);
    f.write("apps/board/index.html", "x");
    f.allow("board", &["sessions:read"]);
    let store = &f.state.store;
    let first = store.create_session(f.id(), ProviderKind::ClaudeCode, "Landing page").unwrap();
    let say = |event: Value| {
        store.append_conversation_event(first.id, event).unwrap();
    };
    say(json!({"type":"message","id":"u1","role":"user","text":"Fix the hero title","delta":false}));
    say(json!({"type":"message","id":"a1","role":"assistant","text":"On it, reading the page first.","delta":false}));
    say(json!({"type":"message","id":"u2","role":"user","text":"the staging password is hunter2","delta":false}));
    say(json!({"type":"message","id":"a2","role":"assistant","text":"I'll shorten the **hero title** in `index.html`. Then the footer, line by line, for a long while.","delta":false}));
    let terminal = store.create_session(f.id(), ProviderKind::Terminal, "Shell").unwrap();
    let other = store.create_workspace("Other", &f.dir.to_string_lossy()).unwrap();
    let second = store.create_session(other.id, ProviderKind::Codex, "Budget").unwrap();
    f.state
        .hub
        .with(|c| {
            c.execute(
                "INSERT INTO session_activity(session_id, last_turn_at, last_turn_status) VALUES (?1, '2026-11-06T12:00:00Z', 'completed')",
                [first.id.to_string()],
            )
        })
        .unwrap();

    let reply = f.get(&format!("{}/tendly/sessions", f.base("board"))).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text());
    let body = reply.json();
    assert_eq!(body["total"], 3);
    let sessions = body["sessions"].as_array().unwrap();
    let find = |id: tendly_domain::SessionId| sessions.iter().find(|s| s["id"] == id.to_string()).unwrap();
    let landing = find(first.id);
    // The title is the conversation's own (Tendly names it after the first thing the person asked).
    assert!(landing["title"].as_str().is_some_and(|title| !title.is_empty()));
    assert_eq!(landing["workspace_id"], f.workspace.as_str());
    assert_eq!(landing["workspace_name"], "Fixture");
    assert_eq!(landing["provider"], "claude_code");
    assert!(landing["state"].is_string());
    assert!(landing["age_seconds"].as_i64().unwrap() >= 0);
    assert_eq!(landing["archived"], false);
    assert_eq!((landing["unread"].clone(), landing["last_turn_status"].clone()), (json!(true), json!("completed")));
    // One line of what the agent said last; never the messages, the person's or the agent's.
    assert_eq!(landing["summary"], "I'll shorten the hero title in index.html.");
    let text = reply.text();
    assert!(!text.contains("hunter2") && !text.contains("line by line") && !text.contains("reading the page"), "{text}");
    let keys: Vec<&str> = landing.as_object().unwrap().keys().map(String::as_str).collect();
    for kept_out in ["events", "messages", "transcript", "native_config_dir", "environment", "endpoint_snapshot", "provider_session_id"] {
        assert!(!keys.contains(&kept_out), "{kept_out}");
    }
    assert_eq!(find(terminal.id)["summary"], Value::Null);
    assert_eq!((find(second.id)["workspace_name"].clone(), find(second.id)["provider"].clone()), (json!("Other"), json!("codex")));
    // Bounded, and archived conversations only when asked.
    let two = f.get(&format!("{}/tendly/sessions?limit=2", f.base("board"))).await.json();
    assert_eq!((two["sessions"].as_array().unwrap().len(), two["total"].clone()), (2, json!(3)));
}

#[tokio::test]
async fn hub_apps_tendly_files_are_the_workspace_read_only_without_dot_files() {
    let f = fixture();
    f.write("apps/notes/app.json", r#"{"name":"Notes","permissions":["files:read"]}"#);
    f.write("apps/notes/index.html", "x");
    f.write("docs/plan.md", "# Plan\n");
    f.write("docs/.hidden/x.md", "hidden");
    f.write(".env", "TOKEN=secret-value");
    f.write(".git/config", "[core]");
    f.write("big.txt", &"a".repeat(1024 * 1024 + 1));
    f.write("edge.txt", &"a".repeat(1024 * 1024));
    fs::write(f.repo.join("image.bin"), [0xff, 0xfe, 0x00, 0x01]).unwrap();
    f.allow("notes", &["files:read"]);
    let base = f.base("notes");

    let root = f.get(&format!("{base}/tendly/files")).await;
    assert_eq!(root.status, StatusCode::OK, "{}", root.text());
    let names: Vec<String> = root.json()["entries"].as_array().unwrap().iter().map(|e| e["name"].as_str().unwrap().to_owned()).collect();
    assert_eq!(names, ["apps", "docs", "big.txt", "edge.txt", "image.bin"], "folders first, no dot-files");
    let docs = f.get(&format!("{base}/tendly/files?path=docs")).await.json();
    assert_eq!(docs["path"], "docs");
    assert_eq!(docs["entries"], json!([{ "name": "plan.md", "path": "docs/plan.md", "kind": "file", "size": 7 }]));

    let file = f.get(&format!("{base}/tendly/file?path=docs/plan.md")).await;
    assert_eq!(file.json(), json!({ "path": "docs/plan.md", "content": "# Plan\n", "size": 7 }));
    assert_eq!(f.get(&format!("{base}/tendly/file?path=edge.txt")).await.status, StatusCode::OK, "1 MB exactly");
    for (path, status) in [
        ("big.txt", StatusCode::PAYLOAD_TOO_LARGE),
        ("image.bin", StatusCode::UNSUPPORTED_MEDIA_TYPE),
        (".env", StatusCode::FORBIDDEN),
        (".git/config", StatusCode::FORBIDDEN),
        ("docs/.hidden/x.md", StatusCode::FORBIDDEN),
        ("docs/../.env", StatusCode::FORBIDDEN),
        ("../outside.txt", StatusCode::FORBIDDEN),
        ("docs/../../outside.txt", StatusCode::FORBIDDEN),
        ("/etc/passwd", StatusCode::BAD_REQUEST),
        ("docs", StatusCode::NOT_FOUND),
        ("missing.md", StatusCode::NOT_FOUND),
        ("", StatusCode::BAD_REQUEST),
    ] {
        let reply = f.get(&format!("{base}/tendly/file?path={path}")).await;
        assert_eq!(reply.status, status, "{path}: {}", reply.text());
        assert!(!reply.text().contains("secret-value"), "{path}");
    }
    for (path, status) in [(".git", StatusCode::FORBIDDEN), ("docs/.hidden", StatusCode::FORBIDDEN), ("..", StatusCode::FORBIDDEN), ("missing", StatusCode::NOT_FOUND)] {
        assert_eq!(f.get(&format!("{base}/tendly/files?path={path}")).await.status, status, "{path}");
    }
    // Read-only: there is no way to write through these routes.
    for method in ["PUT", "POST", "DELETE"] {
        let reply = f.send(method, &format!("{base}/tendly/file?path=docs/plan.md"), json!({ "content": "x" }).to_string(), true).await;
        assert_eq!(reply.status, StatusCode::METHOD_NOT_ALLOWED, "{method}");
    }
    assert_eq!(f.read("docs/plan.md"), "# Plan\n");
}

#[tokio::test]
async fn hub_apps_tendly_automations_come_with_runs_and_without_their_commands() {
    let f = fixture();
    f.write("apps/ops/app.json", r#"{"name":"Ops","permissions":["automations:read"]}"#);
    f.write("apps/ops/index.html", "x");
    f.allow("ops", &["automations:read"]);
    let created = f
        .send(
            "POST",
            "/api/hub/automations",
            json!({ "name": "Backup", "kind": "script", "cron": "0 3 * * *", "command": "curl -H 'Authorization: Bearer sk-secret' https://example.com", "enabled": false }).to_string(),
            true,
        )
        .await;
    assert!(created.status.is_success(), "{}", created.text());
    let id = created.json()["id"].as_str().unwrap().to_owned();
    f.state
        .hub
        .with(|c| {
            for (status, output) in [("ok", "all good sk-secret"), ("failed", "boom"), ("ok", "fine")] {
                c.execute(
                    "INSERT INTO automation_runs(automation_id, started_at, finished_at, status, exit_code, output_tail, trigger)
                     VALUES (?1, '2026-11-06T03:00:00Z', '2026-11-06T03:00:05Z', ?2, 0, ?3, 'schedule')",
                    rusqlite::params![id, status, output],
                )?;
            }
            Ok(())
        })
        .unwrap();
    let reply = f.get(&format!("{}/tendly/automations?runs=2", f.base("ops"))).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text());
    let body = reply.json();
    let backup = &body["automations"][0];
    assert_eq!((backup["name"].clone(), backup["kind"].clone(), backup["cron"].clone(), backup["enabled"].clone()), (json!("Backup"), json!("script"), json!("0 3 * * *"), json!(false)));
    assert_eq!(backup["next_run"], Value::Null, "a paused routine has no next run");
    let runs = backup["runs"].as_array().unwrap();
    assert_eq!(runs.len(), 2, "the latest two");
    assert_eq!((runs[0]["status"].clone(), runs[1]["status"].clone()), (json!("ok"), json!("failed")));
    assert_eq!(runs[0]["trigger"], "schedule");
    // What may hold a secret is not there at all.
    let text = reply.text();
    for hidden in ["sk-secret", "command", "prompt", "output_tail", "boom"] {
        assert!(!text.contains(hidden), "{hidden}: {text}");
    }
    assert_eq!(f.get(&format!("{}/tendly/automations", f.base("ops"))).await.json()["automations"][0]["runs"].as_array().unwrap().len(), 3);
}

#[tokio::test]
async fn hub_apps_notify_reaches_the_bell_with_a_link_to_the_app_and_is_limited() {
    let f = fixture();
    f.write("apps/leads/app.json", r#"{"name":"Leads","permissions":["notify"]}"#);
    f.write("apps/leads/index.html", "x");
    f.allow("leads", &["notify"]);
    let url = format!("{}/notify", f.base("leads"));
    let sent = f.send("POST", &url, json!({ "title": "  New\nlead ", "body": "Maria asked for a quote" }).to_string(), true).await;
    assert_eq!(sent.status, StatusCode::OK, "{}", sent.text());
    let inbox = f.get("/api/hub/inbox").await.json();
    let item = &inbox["items"][0];
    assert_eq!(item["kind"], "app");
    assert_eq!(item["title"], "Leads: New lead", "said to come from the app");
    assert_eq!(item["body"], "Maria asked for a quote");
    assert_eq!(item["link"], format!("/apps/{}/leads", f.workspace));
    assert_eq!((item["session_id"].clone(), item["read_at"].clone(), inbox["unread"].clone()), (Value::Null, Value::Null, json!(1)));

    assert_eq!(f.send("POST", &url, json!({ "title": "  " }).to_string(), true).await.status, StatusCode::BAD_REQUEST);
    assert_eq!(f.send("POST", &url, json!({ "body": "no title" }).to_string(), true).await.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(f.send("POST", &url, json!({ "title": "x" }).to_string(), false).await.status, StatusCode::FORBIDDEN);
    // Long texts are cut, and an app cannot flood the bell.
    let long = f.send("POST", &url, json!({ "title": "t".repeat(500), "body": "b".repeat(5000) }).to_string(), true).await;
    assert_eq!(long.status, StatusCode::OK);
    let item = f.get("/api/hub/inbox").await.json()["items"][0].clone();
    assert!(item["title"].as_str().unwrap().chars().count() <= 90 && item["body"].as_str().unwrap().chars().count() <= 300);
    let mut refused = 0;
    for _ in 0..12 {
        let reply = f.send("POST", &url, json!({ "title": "again" }).to_string(), true).await;
        if reply.status == StatusCode::TOO_MANY_REQUESTS {
            refused += 1;
            assert!(reply.json()["error"].as_str().unwrap().contains("too many notifications"));
        }
    }
    assert_eq!(refused, 4, "ten per app in a while: two were sent before these twelve");
    // Older inbox entries have no link, and the list still reads.
    crate::hub::home::notify(&f.state, "automation_done", None, "Backup".into(), String::new()).await;
    assert_eq!(f.get("/api/hub/inbox").await.json()["items"][0]["link"], Value::Null);
}
