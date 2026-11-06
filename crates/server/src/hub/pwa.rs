//! What makes Tendly installable on a phone: the web app manifest and the
//! service worker.
//!
//! Both are served by routes rather than left to the web build, so they are
//! the same whether the pages come from inside this binary or from
//! `~/.tendly/web`, they carry the content types and cache headers browsers
//! insist on, and the worker can name its cache after the build it belongs to.
//! The icons are plain files of the web build (`apps/web/public/icons`).
use crate::AppState;
use axum::{
    Router,
    extract::State,
    http::{HeaderValue, header},
    response::{IntoResponse, Response},
    routing::get,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::path::Path;

const WORKER: &str = include_str!("pwa/sw.js");
/// `--bg` of the light theme (`replica/design/tokens.json`): the splash screen
/// and the phone's status bar match the page behind them.
const BACKGROUND: &str = "#f1eee8";

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/manifest.webmanifest", get(manifest))
        .route("/sw.js", get(worker))
}

fn manifest_json() -> Value {
    let icon = |file: &str, size: u32, purpose: &str| {
        json!({ "src": format!("/icons/{file}"), "sizes": format!("{size}x{size}"), "type": "image/png", "purpose": purpose })
    };
    json!({
        "name": "Tendly",
        "short_name": "Tendly",
        "description": "Your space to build with Claude Code and Codex.",
        "id": "/",
        "start_url": "/",
        "scope": "/",
        "display": "standalone",
        "background_color": BACKGROUND,
        "theme_color": BACKGROUND,
        "icons": [
            icon("icon-192.png", 192, "any"),
            icon("icon-512.png", 512, "any"),
            icon("icon-maskable-192.png", 192, "maskable"),
            icon("icon-maskable-512.png", 512, "maskable"),
        ],
    })
}

async fn manifest() -> Response {
    served(manifest_json().to_string(), "application/manifest+json")
}

/// The worker, with its cache named after this build of the pages.
async fn worker(State(state): State<AppState>) -> Response {
    let state_dir = state.state_dir.clone();
    let build = tokio::task::spawn_blocking(move || build_id(&state_dir)).await.unwrap_or_else(|_| "dev".into());
    let mut response = served(worker_source(&build), "text/javascript; charset=utf-8");
    // It answers for the whole site, wherever a proxy might mount it.
    response.headers_mut().insert("service-worker-allowed", HeaderValue::from_static("/"));
    response
}

fn worker_source(build: &str) -> String {
    WORKER.replace("__BUILD__", build)
}

/// Browsers revalidate both on every visit, so a new build is noticed at once.
fn served(body: String, content_type: &'static str) -> Response {
    let mut response = body.into_response();
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    response
}

/// A short name for the pages being served: the hash of the page that lists
/// their assets, read from where `main.rs` serves them (disk first, else the
/// copy inside this binary).
fn build_id(state_dir: &Path) -> String {
    let on_disk = std::fs::read(crate::installation::web_directory(state_dir).join("index.html")).ok();
    let page = on_disk.or_else(|| crate::embedded::Web::get("index.html").map(|file| file.data.into_owned()));
    match page {
        Some(page) => Sha256::digest(&page).iter().take(6).map(|byte| format!("{byte:02x}")).collect(),
        None => "dev".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo(path: &str) -> std::path::PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../..").join(path)
    }

    #[test]
    fn hub_pwa_manifest_is_installable() {
        let manifest = manifest_json();
        assert_eq!(manifest["name"], "Tendly");
        assert_eq!(manifest["short_name"], "Tendly");
        assert_eq!(manifest["start_url"], "/");
        assert_eq!(manifest["display"], "standalone");
        let icons = manifest["icons"].as_array().unwrap();
        for (size, purpose) in [("192x192", "any"), ("512x512", "any"), ("192x192", "maskable"), ("512x512", "maskable")] {
            assert!(
                icons.iter().any(|icon| icon["sizes"] == size && icon["purpose"] == purpose && icon["type"] == "image/png"),
                "{size} {purpose}"
            );
        }
        // Every icon it names is a real PNG of that size in the web build's public folder.
        for icon in icons {
            let file = repo("apps/web/public").join(icon["src"].as_str().unwrap().trim_start_matches('/'));
            let bytes = std::fs::read(&file).unwrap_or_else(|_| panic!("{} is missing", file.display()));
            assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
            let width = u32::from_be_bytes(bytes[16..20].try_into().unwrap());
            let height = u32::from_be_bytes(bytes[20..24].try_into().unwrap());
            assert_eq!(format!("{width}x{height}"), icon["sizes"].as_str().unwrap(), "{}", file.display());
        }
    }

    #[test]
    fn hub_pwa_manifest_colours_are_the_light_page_background() {
        let tokens: Value =
            serde_json::from_slice(&std::fs::read(repo("replica/design/tokens.json")).unwrap()).unwrap();
        let manifest = manifest_json();
        assert_eq!(manifest["background_color"], tokens["color"]["bg"]);
        assert_eq!(manifest["theme_color"], tokens["color"]["bg"]);
    }

    #[test]
    fn hub_pwa_worker_is_named_after_the_build_and_leaves_the_api_alone() {
        let source = worker_source("abc123");
        assert!(source.contains(r#"const BUILD = "abc123";"#));
        assert!(!source.contains("__BUILD__"));
        // The contract the web tests exercise in detail (features/hub/pwa.test.mjs).
        for needle in [
            r#"url.pathname.startsWith("/api/")"#,
            r#"addEventListener("push""#,
            r#"addEventListener("notificationclick""#,
            "showNotification",
            "openWindow",
        ] {
            assert!(source.contains(needle), "{needle}");
        }
    }

    #[test]
    fn hub_pwa_build_id_follows_the_page_on_disk() {
        let dir = std::env::temp_dir().join(format!("hub-pwa-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("web")).unwrap();
        std::fs::write(dir.join("web/index.html"), "<html>one</html>").unwrap();
        // Skipped where TENDLY_WEB_DIR points the server elsewhere.
        if std::env::var_os("TENDLY_WEB_DIR").is_none() {
            let first = build_id(&dir);
            assert_eq!(first.len(), 12);
            assert_eq!(first, build_id(&dir), "stable for the same page");
            std::fs::write(dir.join("web/index.html"), "<html>two</html>").unwrap();
            assert_ne!(first, build_id(&dir), "a new build gets a new cache");
        }
        std::fs::remove_dir_all(dir).ok();
    }
}
