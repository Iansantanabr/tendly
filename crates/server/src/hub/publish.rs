//! Publishing a workspace file at `/p/{slug}`: for the team, behind a
//! password, or public; frozen at publish time or live from disk. Management
//! routes live under `/api/hub/publications`.
use crate::AppState;
use axum::Router;

pub fn routes() -> Router<AppState> {
    Router::new()
}
