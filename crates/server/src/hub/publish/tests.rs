//! Publishing end to end, through the real router and its guard.
use super::*;
use crate::{agent, activity, accounts, conversations, file_watch, security, worktree_setup};
use axum::{body::to_bytes, http::Request as HttpRequest};
use serde_json::{Value, json};
use std::{fs, sync::Arc};
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

/// A server that needs `TOKEN`, as a network binding or the tailnet does.
fn fixture() -> Fixture {
    let dir = std::env::temp_dir().join(format!("hub-publish-api-{}", uuid::Uuid::new_v4()));
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
    async fn api(&self, method: &str, path: &str, body: Value) -> (StatusCode, Value) {
        let request = HttpRequest::builder()
            .method(method)
            .uri(path)
            .header("host", HOST)
            .header("x-tendly-client", "web")
            .header("authorization", format!("Bearer {TOKEN}"))
            .header("content-type", "application/json")
            .body(axum::body::Body::from(body.to_string()))
            .unwrap();
        let response = crate::router(self.state.clone()).oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), 1 << 20).await.unwrap();
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }
    async fn publish(&self, body: Value) -> (StatusCode, Value) {
        let mut body = body;
        body["workspace_id"] = json!(self.workspace);
        self.api("POST", "/api/hub/publications", body).await
    }
    /// A visitor's request: no token, only the headers given.
    async fn visit(&self, method: &str, uri: &str, headers: &[(&str, &str)], body: &str) -> (StatusCode, HeaderMap, String) {
        let mut request = HttpRequest::builder().method(method).uri(uri).header("host", HOST);
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        let response = crate::router(self.state.clone())
            .oneshot(request.body(axum::body::Body::from(body.to_owned())).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = to_bytes(response.into_body(), 1 << 20).await.unwrap();
        (status, headers, String::from_utf8_lossy(&bytes).into_owned())
    }
    async fn get(&self, uri: &str) -> (StatusCode, String) {
        let (status, _, body) = self.visit("GET", uri, &[], "").await;
        (status, body)
    }
}

#[test]
fn hub_publish_slugs_are_readable_and_validated() {
    assert_eq!(slug_base("docs/Relatório Q3.html"), "relatorio-q3");
    assert_eq!(slug_base("Ação & Coração!!.md"), "acao-coracao");
    assert_eq!(slug_base("???.txt"), "file");
    assert_eq!(slug_base(&format!("{}.html", "a".repeat(100))).len(), 40);
    let slug = generate_slug("relatorio-q3");
    assert!(slug.starts_with("relatorio-q3-") && slug.len() == "relatorio-q3-".len() + 4, "{slug}");
    assert!(valid_slug(&slug));
    assert_ne!(generate_slug("a"), generate_slug("a"));
    for good in ["abc", "relatorio-q3-k3f9", &"a".repeat(64)] {
        assert!(valid_slug(good), "{good}");
    }
    for bad in ["ab", "Abc", "a_b", "a b", "a/b", "../x", "ação", &"a".repeat(65), ""] {
        assert!(!valid_slug(bad), "{bad}");
    }
}

#[test]
fn hub_publish_html_policy_keeps_the_api_out_of_reach() {
    let policy = html_policy(Some(HOST), "page-ab12");
    assert!(policy.starts_with("sandbox allow-scripts allow-same-origin"));
    assert!(!policy.contains("allow-popups") && !policy.contains("allow-forms"));
    assert!(policy.contains(&format!("connect-src http://{HOST}/p/page-ab12/ https://{HOST}/p/page-ab12/;")));
    for directive in ["frame-src 'none'", "worker-src 'none'", "form-action 'none'", "frame-ancestors 'self'"] {
        assert!(policy.contains(directive), "{directive}");
    }
    // A Host that could smuggle a directive falls back to nothing at all.
    let odd = html_policy(Some("evil; script-src *"), "page-ab12");
    assert!(odd.contains("connect-src 'none'") && !odd.contains("evil"));
}

#[tokio::test]
async fn hub_publish_team_pages_refuse_visitors_who_are_not_signed_in() {
    let f = fixture();
    f.write("report.html", "<h1>Team report</h1>");
    let (status, p) = f.publish(json!({"path": "report.html", "visibility": "team", "mode": "live"})).await;
    assert_eq!(status, StatusCode::OK, "{p}");
    let slug = p["slug"].as_str().unwrap().to_owned();
    assert_eq!(p["url"], format!("/p/{slug}"));
    assert!(slug.starts_with("report-"));

    let (status, body) = f.get(&format!("/p/{slug}/")).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(body.contains("only for the team") && !body.contains("Team report"));
    let (status, _, body) = f
        .visit("GET", &format!("/p/{slug}/"), &[("authorization", &format!("Bearer {TOKEN}"))], "")
        .await;
    assert_eq!(status, StatusCode::OK);
    assert!(body.contains("Team report"));
    // The management API itself still needs the token.
    let (status, _) = f.get("/api/hub/publications").await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    // An unknown slug says nothing about anything.
    let (status, body) = f.get("/p/no-such-page/").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(!body.contains("team"));
    let (status, headers, _) = f.visit("GET", &format!("/p/{slug}"), &[], "").await;
    assert_eq!(status, StatusCode::PERMANENT_REDIRECT);
    assert_eq!(headers[header::LOCATION], format!("/p/{slug}/"));
}

#[tokio::test]
async fn hub_publish_frozen_keeps_the_snapshot_and_live_follows_the_file() {
    let f = fixture();
    f.write("site/index.html", r#"<link rel="stylesheet" href="css/site.css"><p>first</p>"#);
    f.write("site/css/site.css", "body{color:red}");
    f.write("notes.md", "# Notes\n<b>v1</b>");
    let (_, frozen) = f
        .publish(json!({"path": "site/index.html", "visibility": "public", "mode": "frozen", "slug": "my-site"}))
        .await;
    assert_eq!(frozen["slug"], "my-site");
    assert!(frozen["frozen_at"].is_string());
    assert!(f.state.state_dir.join("published/my-site/css/site.css").is_file());
    let (_, live) = f.publish(json!({"path": "./notes.md", "visibility": "public", "mode": "live"})).await;
    let live_slug = live["slug"].as_str().unwrap().to_owned();

    f.write("site/index.html", r#"<link rel="stylesheet" href="css/site.css"><p>second</p>"#);
    f.write("site/css/site.css", "body{color:blue}");
    f.write("notes.md", "# Notes\n<b>v2</b>");
    let (status, page) = f.get("/p/my-site/").await;
    assert_eq!(status, StatusCode::OK);
    assert!(page.contains("first"));
    assert!(f.get("/p/my-site/css/site.css").await.1.contains("red"));
    let (status, headers, markdown) = f.visit("GET", &format!("/p/{live_slug}/"), &[], "").await;
    assert_eq!(status, StatusCode::OK);
    assert!(markdown.contains("&lt;b&gt;v2&lt;/b&gt;"), "escaped, current: {markdown}");
    assert!(headers[header::CONTENT_TYPE].to_str().unwrap().starts_with("text/html"));

    let (status, refreshed) = f.api("POST", "/api/hub/publications/my-site/refresh", json!({})).await;
    assert_eq!(status, StatusCode::OK, "{refreshed}");
    assert!(f.get("/p/my-site/").await.1.contains("second"));
    assert!(f.get("/p/my-site/css/site.css").await.1.contains("blue"));
    let (status, _) = f.api("POST", &format!("/api/hub/publications/{live_slug}/refresh"), json!({})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // Publishing the same file again edits it; one publication per file.
    let (status, again) = f.publish(json!({"path": "site/index.html", "visibility": "team", "mode": "live"})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!((again["slug"].as_str(), again["mode"].as_str()), (Some("my-site"), Some("live")));
    assert!(again["frozen_at"].is_null());
    assert!(!f.state.state_dir.join("published/my-site").exists(), "a live page keeps no copy");
    let (_, list) = f.api("GET", "/api/hub/publications", Value::Null).await;
    assert_eq!(list.as_array().unwrap().len(), 2);
    let uri = format!("/api/hub/publications/for?workspace_id={}&path=site/index.html", f.workspace);
    assert_eq!(f.api("GET", &uri, Value::Null).await.1["slug"], "my-site");

    // Unpublishing removes it and its copy.
    let (status, _) = f.api("PATCH", "/api/hub/publications/my-site", json!({"mode": "frozen"})).await;
    assert_eq!(status, StatusCode::OK);
    assert!(f.state.state_dir.join("published/my-site").exists());
    let (status, _) = f.api("DELETE", "/api/hub/publications/my-site", Value::Null).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert!(!f.state.state_dir.join("published/my-site").exists());
    assert_eq!(f.get("/p/my-site/").await.0, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn hub_publish_custom_slugs_are_checked_and_unique() {
    let f = fixture();
    f.write("a.txt", "a");
    f.write("b.txt", "b");
    let (status, _) = f.publish(json!({"path": "a.txt", "visibility": "public", "mode": "live", "slug": "taken"})).await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = f.publish(json!({"path": "b.txt", "visibility": "public", "mode": "live", "slug": "taken"})).await;
    assert_eq!(status, StatusCode::CONFLICT);
    let (status, _) = f.publish(json!({"path": "b.txt", "visibility": "public", "mode": "live", "slug": "Not Valid"})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = f.publish(json!({"path": "b.txt", "visibility": "world", "mode": "live"})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = f.publish(json!({"path": "../outside.txt", "visibility": "public", "mode": "live"})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = f.publish(json!({"path": "missing.txt", "visibility": "public", "mode": "live"})).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, p) = f.api("PATCH", "/api/hub/publications/taken", json!({"slug": "renamed"})).await;
    assert_eq!((status, p["url"].as_str()), (StatusCode::OK, Some("/p/renamed")));
    assert_eq!(f.get("/p/renamed/").await.0, StatusCode::OK);
    assert_eq!(f.get("/p/taken/").await.0, StatusCode::NOT_FOUND);
    // A text file gets a charset and the locked-down policy.
    let (_, headers, body) = f.visit("GET", "/p/renamed/", &[], "").await;
    assert_eq!(body, "a");
    assert_eq!(headers[header::CONTENT_TYPE], "text/plain; charset=utf-8");
    assert!(headers[header::CONTENT_SECURITY_POLICY].to_str().unwrap().starts_with("sandbox; default-src 'none'"));
}

#[tokio::test]
async fn hub_publish_paths_below_a_page_never_escape_it() {
    let f = fixture();
    f.write("secret.txt", "top secret");
    f.write(".env", "TOKEN=1");
    f.write("site/index.html", r#"<img src="img/a.png"><a href="../secret.txt">x</a><a href=".env">"#);
    f.write("site/img/a.png", "png");
    f.write("site/unreferenced.txt", "beside the page");
    f.write("site/.env", "TOKEN=2");
    #[cfg(unix)]
    std::os::unix::fs::symlink(f.dir.join("repo/secret.txt"), f.dir.join("repo/site/img/link.png")).unwrap();
    for mode in ["live", "frozen"] {
        let slug = format!("site-{mode}");
        let (status, p) = f
            .publish(json!({"path": "site/index.html", "visibility": "public", "mode": mode, "slug": slug}))
            .await;
        assert_eq!(status, StatusCode::OK, "{p}");
        assert_eq!(f.get(&format!("/p/{slug}/img/a.png")).await, (StatusCode::OK, "png".into()), "{mode}");
        for attempt in [
            "../secret.txt",
            "..%2fsecret.txt",
            "%2e%2e/secret.txt",
            "%2e%2e%2fsecret.txt",
            "img/..%2f..%2fsecret.txt",
            "%252e%252e/secret.txt",
            "%2fetc%2fpasswd",
            "/etc/passwd",
            ".env",
            "%2eenv",
            "unreferenced.txt",
            "img/link.png",
            "img",
        ] {
            let (status, body) = f.get(&format!("/p/{slug}/{attempt}")).await;
            assert_eq!(status, StatusCode::NOT_FOUND, "{mode} {attempt}");
            assert!(!body.contains("secret") && !body.contains("TOKEN") && !body.contains("beside"), "{attempt}");
        }
        let (_, headers, _) = f.visit("GET", &format!("/p/{slug}/"), &[], "").await;
        let policy = headers[header::CONTENT_SECURITY_POLICY].to_str().unwrap();
        assert!(policy.contains(&format!("connect-src http://{HOST}/p/{slug}/")), "{policy}");
        // Changing the mode on the second pass edits the same publication.
        f.api("DELETE", &format!("/api/hub/publications/{slug}"), Value::Null).await;
    }
    // A non-HTML file has nothing below it.
    let (_, p) = f.publish(json!({"path": "secret.txt", "visibility": "public", "mode": "live"})).await;
    let slug = p["slug"].as_str().unwrap();
    assert_eq!(f.get(&format!("/p/{slug}/secret.txt")).await.0, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn hub_publish_passwords_unlock_with_a_cookie_that_a_new_password_revokes() {
    let f = fixture();
    f.write("plan.html", r#"<p>the plan</p><img src="a.png">"#);
    f.write("a.png", "png");
    let (status, _) = f.publish(json!({"path": "plan.html", "visibility": "password", "mode": "frozen", "slug": "plan"})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "a password is required");
    let (status, _) = f
        .publish(json!({"path": "plan.html", "visibility": "password", "password": "abc", "mode": "frozen", "slug": "plan"}))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "too short");
    let (status, p) = f
        .publish(json!({"path": "plan.html", "visibility": "password", "password": "open sesame", "mode": "frozen", "slug": "plan"}))
        .await;
    assert_eq!(status, StatusCode::OK, "{p}");
    assert_eq!(p["has_password"], true);
    assert!(p.get("password_hash").is_none());

    let (status, page) = f.get("/p/plan/").await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert!(page.contains(r#"type="password""#) && !page.contains("the plan"));
    assert_eq!(f.get("/p/plan/a.png").await.0, StatusCode::UNAUTHORIZED);

    let form = [("content-type", "application/x-www-form-urlencoded"), ("origin", "http://127.0.0.1:8787")];
    let (status, _, body) = f.visit("POST", "/p/plan", &form, "password=wrong").await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert!(body.contains("not right"));
    let (status, headers, _) = f.visit("POST", "/p/plan/", &form, "password=open+sesame").await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    let set = headers[header::SET_COOKIE].to_str().unwrap().to_owned();
    assert!(set.contains("Path=/p/plan;") && set.contains("HttpOnly") && set.contains("SameSite=Lax"), "{set}");
    let cookie = set.split(';').next().unwrap().to_owned();
    let with_cookie = [("cookie", cookie.as_str())];
    let (status, _, body) = f.visit("GET", "/p/plan/", &with_cookie, "").await;
    assert_eq!(status, StatusCode::OK);
    assert!(body.contains("the plan"));
    assert_eq!(f.visit("GET", "/p/plan/a.png", &with_cookie, "").await.0, StatusCode::OK);
    // From another site, the form is refused by the guard.
    let (status, _, _) = f
        .visit("POST", "/p/plan", &[("content-type", "application/x-www-form-urlencoded"), ("origin", "https://evil.example")], "password=x")
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // Saving the same settings keeps the password (and the cookie)...
    let (status, _) = f.publish(json!({"path": "plan.html", "visibility": "password", "mode": "frozen"})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(f.visit("GET", "/p/plan/", &with_cookie, "").await.0, StatusCode::OK);
    // ...a new password signs every browser out.
    let (status, _) = f.api("PATCH", "/api/hub/publications/plan", json!({"password": "another one"})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(f.visit("GET", "/p/plan/", &with_cookie, "").await.0, StatusCode::UNAUTHORIZED);
    // Going public drops the password altogether.
    let (_, p) = f.api("PATCH", "/api/hub/publications/plan", json!({"visibility": "public"})).await;
    assert_eq!(p["has_password"], false);
    assert_eq!(f.get("/p/plan/").await.0, StatusCode::OK);
}

#[tokio::test]
async fn hub_publish_wrong_passwords_are_rate_limited() {
    let f = fixture();
    f.write("x.txt", "x");
    f.publish(json!({"path": "x.txt", "visibility": "password", "password": "right one", "mode": "live", "slug": "limited-page"}))
        .await;
    let form = [("content-type", "application/x-www-form-urlencoded")];
    for _ in 0..10 {
        assert_eq!(f.visit("POST", "/p/limited-page", &form, "password=nope").await.0, StatusCode::UNAUTHORIZED);
    }
    let (status, _, body) = f.visit("POST", "/p/limited-page", &form, "password=right+one").await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert!(body.contains("Too many attempts"));
}
