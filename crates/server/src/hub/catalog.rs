//! Read-only catalogs of what the agents on this machine can use: MCP
//! integrations and skills. Routes live under `/api/hub/catalog`.
use crate::AppState;
use axum::{Router, routing::get};
use std::path::PathBuf;

mod integrations;
mod redact;
mod skills;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/hub/catalog/integrations", get(integrations::list))
        .route("/api/hub/catalog/skills", get(skills::list))
}

/// The person's home directory, where Claude Code and Codex keep their settings.
fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").filter(|home| !home.is_empty()).map(PathBuf::from)
}

/// Reads a small text file; anything over `limit` bytes is cut off.
fn read_capped(path: &std::path::Path, limit: u64) -> Option<String> {
    use std::io::Read;
    let file = std::fs::File::open(path).ok()?;
    let mut text = String::new();
    let mut bytes = Vec::new();
    file.take(limit).read_to_end(&mut bytes).ok()?;
    text.push_str(&String::from_utf8_lossy(&bytes));
    Some(text)
}
