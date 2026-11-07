//! A check of an app without a browser, and the errors a browser saw.
//!
//! `GET /api/hub/apps/{ws}/{slug}/diagnostics` is what an agent (or the
//! `tendly-apps` skill) calls with `curl` after changing an app, to know
//! whether the page is sound: the static checks here (the entry page, its
//! local files, the SDK before the app's own scripts), and the errors the
//! page that framed the app reported since it last loaded (`sdk.js` catches
//! them, `AppView.vue` sends them here with `PUT`). The runtime part lives in
//! memory and is per app: the newest report wins, and a restart forgets them.
use super::{Found, clean_path, find};
use crate::{ApiError, AppState, Result};
use axum::{
    Json, Router,
    extract::{Path as UrlPath, State},
    routing::get,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fs,
    path::Path,
    sync::Mutex,
};
use tendly_domain::WorkspaceId;

const MAX_ERRORS: usize = 50;
const MAX_TEXT: usize = 2000;
/// The largest entry page the static check reads.
const MAX_PAGE: u64 = 2 * 1024 * 1024;

pub(super) fn routes() -> Router<AppState> {
    Router::new().route("/api/hub/apps/{workspace_id}/{slug}/diagnostics", get(get_route).put(put_route))
}

/// One error the app's page reported, as `sdk.js` describes it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) struct ReportedError {
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub file: String,
    #[serde(default)]
    pub line: u64,
    #[serde(default)]
    pub column: u64,
    #[serde(default = "one")]
    pub count: u64,
}

fn one() -> u64 {
    1
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct Report {
    /// The page of the app that was showing (its address inside the app).
    #[serde(default)]
    pub page: String,
    #[serde(default)]
    pub errors: Vec<ReportedError>,
    /// When the page that framed the app sent this.
    #[serde(default)]
    pub reported_at: String,
}

/// The latest report per app, in memory (`HubStore.app_health`).
#[derive(Default)]
pub(crate) struct Health {
    reports: Mutex<HashMap<(WorkspaceId, String), Report>>,
}

impl Health {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<(WorkspaceId, String), Report>> {
        self.reports.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub(crate) fn report(&self, workspace: WorkspaceId, slug: &str, report: Report) {
        self.lock().insert((workspace, slug.to_owned()), report);
    }

    pub(crate) fn latest(&self, workspace: WorkspaceId, slug: &str) -> Option<Report> {
        self.lock().get(&(workspace, slug.to_owned())).cloned()
    }

    /// How many errors each app reported last, for the list of apps.
    pub(crate) fn counts(&self) -> HashMap<(WorkspaceId, String), (usize, String)> {
        self.lock()
            .iter()
            .map(|(key, report)| (key.clone(), (report.errors.iter().map(|e| e.count.max(1) as usize).sum(), report.reported_at.clone())))
            .collect()
    }
}

// ---------------------------------------------------------------------------
// Static checks

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub(crate) struct Problem {
    /// `missing-file`, `sdk-missing`, `sdk-order`, `kit-order`, `entry-unreadable`.
    pub kind: &'static str,
    pub message: String,
    /// The file the problem is in (relative to the app folder), or the file that is missing.
    pub file: String,
}

fn problem(kind: &'static str, file: &str, message: String) -> Problem {
    Problem { kind, message, file: file.to_owned() }
}

/// Where a local reference points, relative to the app folder: `None` for
/// addresses elsewhere (other sites, data URLs, Tendly's own shared files, anchors).
fn local_reference(page_dir: &str, value: &str) -> Option<String> {
    let value = value.trim();
    let value = value.split(['?', '#']).next().unwrap_or_default();
    if value.is_empty() || value.starts_with("//") || value.contains(':') || value.starts_with('/') {
        return None;
    }
    let mut parts: Vec<&str> = page_dir.split('/').filter(|p| !p.is_empty()).collect();
    for part in value.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            other => parts.push(other),
        }
    }
    Some(parts.join("/"))
}

/// What the entry page refers to, in order: `(tag, attribute value)`.
fn references(html: &str) -> Vec<(String, String)> {
    let lower = html.to_ascii_lowercase();
    let mut found = Vec::new();
    let mut at = 0;
    while let Some(open) = lower[at..].find('<') {
        let start = at + open + 1;
        let Some(close) = html[start..].find('>') else { break };
        let end = start + close;
        let tag_text = &html[start..end];
        let name: String = tag_text.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '-').collect::<String>().to_ascii_lowercase();
        at = end + 1;
        if name.is_empty() {
            continue;
        }
        let attributes = super::attributes(&tag_text[name.len()..]);
        let wanted = match name.as_str() {
            "script" | "img" | "iframe" | "source" | "audio" | "video" => "src",
            "link" => "href",
            _ => continue,
        };
        if name == "link" && !attributes.iter().any(|(k, v)| k == "rel" && v.to_ascii_lowercase().split_whitespace().any(|r| matches!(r, "stylesheet" | "icon" | "modulepreload"))) {
            continue;
        }
        if let Some((_, value)) = attributes.iter().find(|(k, _)| k == wanted) {
            found.push((name.clone(), value.clone()));
        }
        // An inline script marks where the app's own code starts.
        if name == "script" && !attributes.iter().any(|(k, _)| k == "src") {
            found.push((name, String::new()));
        }
    }
    found
}

/// The checks that need no browser, on the app's entry page.
pub(crate) fn check(dir: &Path, entry: &str) -> Vec<Problem> {
    let mut problems = Vec::new();
    let Some(relative) = clean_path(entry) else {
        return vec![problem("entry-unreadable", entry, "the entry page's path is not valid".into())];
    };
    let target = dir.join(&relative);
    let html = match fs::metadata(&target) {
        Ok(meta) if meta.len() > MAX_PAGE => return vec![problem("entry-unreadable", entry, "the entry page is larger than 2 MB".into())],
        Ok(_) => match fs::read_to_string(&target) {
            Ok(text) => text,
            Err(error) => return vec![problem("entry-unreadable", entry, format!("the entry page cannot be read: {error}"))],
        },
        Err(_) => return vec![problem("missing-file", entry, format!("the entry page {entry} is missing"))],
    };
    let page_dir = relative.parent().map(|p| p.to_string_lossy().replace('\\', "/")).unwrap_or_default();
    let mut sdk_at: Option<usize> = None;
    let mut first_own_script: Option<(usize, String)> = None;
    let mut kit_at: Option<usize> = None;
    for (index, (tag, value)) in references(&html).iter().enumerate() {
        if tag == "script" {
            if value.ends_with("/api/hub/apps/sdk.js") {
                sdk_at.get_or_insert(index);
                continue;
            }
            if value.ends_with("/api/hub/apps/kit.js") {
                kit_at.get_or_insert(index);
                continue;
            }
            if first_own_script.is_none() {
                first_own_script = Some((index, if value.is_empty() { "an inline script".into() } else { value.clone() }));
            }
        }
        let Some(local) = local_reference(&page_dir, value) else { continue };
        if local.is_empty() {
            continue;
        }
        let exists = clean_path(&local).is_some_and(|path| super::checked_file(dir, &path).is_some());
        if !exists {
            problems.push(problem("missing-file", &local, format!("{tag} refers to {value}, and there is no such file in the app folder")));
        }
    }
    let uses_tendly = html.contains("tendly.");
    match (sdk_at, first_own_script.clone()) {
        (None, _) if uses_tendly => problems.push(problem("sdk-missing", entry, "the page uses `tendly.` but does not include <script src=\"/api/hub/apps/sdk.js\"></script>".into())),
        (Some(sdk), Some((own, name))) if own < sdk => problems.push(problem("sdk-order", entry, format!("the SDK is included after the app's own script ({name}); put <script src=\"/api/hub/apps/sdk.js\"></script> first"))),
        _ => {}
    }
    if let (Some(kit), Some((own, name))) = (kit_at, first_own_script.as_ref()) {
        if *own < kit {
            problems.push(problem("kit-order", entry, format!("kit.js is included after the app's own script ({name}); include it before")));
        }
    }
    if html.contains("/api/hub/apps/kit.js") && !html.contains("/api/hub/apps/kit.css") {
        problems.push(problem("kit-css-missing", entry, "the page loads kit.js but not its stylesheet: add <link rel=\"stylesheet\" href=\"/api/hub/apps/kit.css\">".into()));
    }
    problems
}

// ---------------------------------------------------------------------------
// Routes

fn view(found: &Found, problems: Vec<Problem>, runtime: Option<Report>) -> Value {
    let count: usize = runtime.as_ref().map(|r| r.errors.iter().map(|e| e.count.max(1) as usize).sum()).unwrap_or(0);
    json!({
        "workspace_id": found.workspace.id.to_string(),
        "slug": found.slug,
        "entry": found.app.manifest.entry,
        "ok": problems.is_empty() && count == 0,
        "problems": problems,
        "runtime": runtime.map(|report| json!({
            "page": report.page,
            "reported_at": report.reported_at,
            "count": count,
            "errors": report.errors,
        })),
        "note": "`problems` are checked on the files; `runtime` is what the last Tendly window showing the app reported since it loaded (null when none has)",
    })
}

async fn get_route(State(state): State<AppState>, UrlPath((workspace, slug)): UrlPath<(String, String)>) -> Result<Json<Value>> {
    let found = find(&state, &workspace, &slug).await?;
    let (dir, entry) = (found.app.dir.clone(), found.app.manifest.entry.clone());
    let problems = tokio::task::spawn_blocking(move || check(&dir, &entry)).await.map_err(ApiError::internal)?;
    let runtime = state.hub.app_health.latest(found.workspace.id, &found.slug);
    Ok(Json(view(&found, problems, runtime)))
}

/// The page that frames the app says what it saw. The whole list each time
/// (the SDK counts repeats), so a page that loaded clean sends an empty one.
async fn put_route(
    State(state): State<AppState>,
    UrlPath((workspace, slug)): UrlPath<(String, String)>,
    Json(mut report): Json<Report>,
) -> Result<Json<Value>> {
    let found = find(&state, &workspace, &slug).await?;
    report.errors.truncate(MAX_ERRORS);
    for error in &mut report.errors {
        error.message = clip(&error.message);
        error.file = clip(&error.file);
        error.kind = clip(&error.kind);
    }
    report.page = clip(&report.page);
    report.reported_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let count: usize = report.errors.iter().map(|e| e.count.max(1) as usize).sum();
    state.hub.app_health.report(found.workspace.id, &found.slug, report);
    Ok(Json(json!({ "recorded": true, "count": count })))
}

fn clip(text: &str) -> String {
    if text.chars().count() <= MAX_TEXT { text.to_owned() } else { text.chars().take(MAX_TEXT).collect::<String>() + "…" }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Dir(std::path::PathBuf);
    impl Dir {
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn app(files: &[(&str, &str)]) -> Dir {
        let dir = std::env::temp_dir().join(format!("hub-apps-diag-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let dir = Dir(dunce::canonicalize(dir).unwrap());
        for (name, body) in files {
            let path = dir.path().join(name);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, body).unwrap();
        }
        dir
    }

    #[test]
    fn hub_apps_diagnostics_local_references_resolve_against_the_page() {
        assert_eq!(local_reference("", "app.js").as_deref(), Some("app.js"));
        assert_eq!(local_reference("pages", "./x.css?v=1").as_deref(), Some("pages/x.css"));
        assert_eq!(local_reference("pages", "../shared/x.css#a").as_deref(), Some("shared/x.css"));
        assert_eq!(local_reference("", "../x.css"), None, "outside the app");
        for elsewhere in ["https://cdn.example/x.js", "//cdn.example/x.js", "data:text/plain,hi", "/api/hub/apps/sdk.js", "#top", ""] {
            assert_eq!(local_reference("", elsewhere), None, "{elsewhere}");
        }
    }

    #[test]
    fn hub_apps_diagnostics_find_missing_files_and_the_sdk_out_of_order() {
        let dir = app(&[
            ("index.html", r#"<html><head><link rel="stylesheet" href="/api/hub/apps/kit.css"><link rel="stylesheet" href="style.css"><script src="/api/hub/apps/sdk.js"></script><script src="/api/hub/apps/kit.js"></script></head><body><img src="img/logo.png"><script src="app.js"></script><script>tendly.data.get('x')</script></body></html>"#),
            ("style.css", "body{}"),
        ]);
        let found = check(dir.path(), "index.html");
        let kinds: Vec<(&str, &str)> = found.iter().map(|p| (p.kind, p.file.as_str())).collect();
        assert_eq!(kinds, vec![("missing-file", "img/logo.png"), ("missing-file", "app.js")]);

        let dir = app(&[("index.html", r#"<script src="app.js"></script><script src="/api/hub/apps/sdk.js"></script>"#), ("app.js", "1")]);
        let found = check(dir.path(), "index.html");
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].kind, "sdk-order");

        let dir = app(&[("index.html", "<script>tendly.data.get('x')</script>")]);
        assert_eq!(check(dir.path(), "index.html")[0].kind, "sdk-missing");

        let dir = app(&[("index.html", r#"<script src="/api/hub/apps/sdk.js"></script><script src="/api/hub/apps/kit.js"></script><script>tkit.toast('hi')</script>"#)]);
        assert_eq!(check(dir.path(), "index.html")[0].kind, "kit-css-missing");

        let dir = app(&[("index.html", "<p>plain</p>")]);
        assert!(check(dir.path(), "index.html").is_empty(), "a page without scripts needs nothing");
        assert_eq!(check(dir.path(), "missing.html")[0].kind, "missing-file");
    }

    #[test]
    fn hub_apps_diagnostics_every_template_passes_the_static_check() {
        let manifest = super::super::parse_manifest("demo", r#"{"name":"Demo","color":"blue"}"#).unwrap();
        for (name, _) in super::super::TEMPLATES {
            for locale in [None, Some("pt-BR")] {
                let page = super::super::template_page_in(name, &manifest, locale).unwrap();
                let dir = app(&[("index.html", &page)]);
                assert_eq!(check(dir.path(), "index.html"), Vec::new(), "template {name} {locale:?}");
                assert!(!page.contains("{{"), "template {name} {locale:?} has a placeholder left");
            }
        }
        for (name, _) in super::super::TEMPLATES_PT_BR {
            let page = super::super::template_page_in(name, &manifest, Some("pt-BR")).unwrap();
            assert!(page.contains(r#"<html lang="pt-BR""#), "template {name} in Portuguese says so");
        }
    }

    #[test]
    fn hub_apps_diagnostics_reports_are_kept_per_app_and_counted() {
        let health = Health::default();
        let ws = WorkspaceId::new_v4();
        assert!(health.latest(ws, "a").is_none());
        let errors = vec![ReportedError { kind: "error".into(), message: "x".into(), file: "".into(), line: 0, column: 0, count: 3 }, ReportedError { kind: "console".into(), message: "y".into(), file: "".into(), line: 0, column: 0, count: 0 }];
        health.report(ws, "a", Report { page: "/".into(), errors, reported_at: "now".into() });
        assert_eq!(health.counts().get(&(ws, "a".to_owned())).map(|c| c.0), Some(4), "a count of 0 still counts once");
        health.report(ws, "a", Report { page: "/".into(), errors: vec![], reported_at: "later".into() });
        assert_eq!(health.counts().get(&(ws, "a".to_owned())).map(|c| c.0), Some(0), "the newest report wins");
    }
}
