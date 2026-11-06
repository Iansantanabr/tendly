//! A conversation as plain text, so another conversation (or an agent through
//! the `tendly_read_conversation` tool) can take it as context.
use crate::AppState;
use axum::Router;

pub fn routes() -> Router<AppState> {
    Router::new()
}
