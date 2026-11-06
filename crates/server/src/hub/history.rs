//! File version history: every text file a workspace changes, by the person
//! or by an agent, kept as content-addressed versions that can be compared
//! and restored. Routes live under `/api/hub/history`.
use crate::AppState;
use axum::Router;
use tendly_domain::WorkspaceId;

pub fn routes() -> Router<AppState> {
    Router::new()
}

/// Starts watching the workspaces for changes. Called once from `hub::warm`.
pub fn start(_state: AppState) {}

/// The person saved this file from the browser.
pub async fn record_saved(_state: &AppState, _workspace: WorkspaceId, _path: &str, _content: &str) {}
