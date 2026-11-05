//! Read-only catalogs of what the agents on this machine can use: MCP
//! integrations and skills. Routes live under `/api/hub/catalog`.
use crate::AppState;
use axum::Router;

pub fn routes() -> Router<AppState> {
    Router::new()
}
