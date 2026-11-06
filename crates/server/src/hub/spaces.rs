//! Named spaces: saved Mesa layouts that can be reopened by name. Routes live
//! under `/api/hub/spaces`.
use crate::AppState;
use axum::Router;

pub fn routes() -> Router<AppState> {
    Router::new()
}
