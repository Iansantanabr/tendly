//! Additions to this fork of Tendly: the home page, the inbox and unread
//! conversations, and (in later modules) automations, the integration and
//! skill catalogs, file history, publishing, custom apps, and the phone:
//! an installable app (`pwa`) and Web Push (`push`), and the settings a move
//! to a VPS needs (`settings`: time zone, public link address, dictation).
//!
//! Everything here keeps its rows in a database of its own, `hub.db` beside
//! the main one, so upstream schema migrations never collide with ours.
use crate::{ApiError, AppState, Result};
use axum::Router;
use std::{
    path::Path,
    sync::{Arc, Mutex},
};

mod apps;
pub(crate) mod automations;
mod catalog;
mod history;
mod home;
mod publish;
mod push;
mod pwa;
pub(crate) mod settings;
mod spaces;
pub(crate) mod transcript;
mod store;

pub use store::HubStore;

/// Shared handle kept in `AppState`.
pub type Hub = Arc<HubStore>;

pub fn open(database: &Path) -> Hub {
    let path = database.with_file_name("hub.db");
    match HubStore::open(&path) {
        Ok(store) => Arc::new(store),
        Err(error) => {
            tracing::error!(%error, path=%path.display(), "hub database unavailable; using memory");
            Arc::new(HubStore::memory())
        }
    }
}

/// Startup work: the folder for conversations without a project exists before
/// the first browser asks for the workspace list.
pub fn warm(state: AppState) {
    settings::ensure_defaults(&state.hub);
    let home_state = state.clone();
    tokio::spawn(async move {
        if let Err(error) = home::ensure_conversations(&home_state).await {
            tracing::warn!(?error, "could not prepare the conversations folder");
        }
    });
    history::start(state.clone());
    automations::start_scheduler(state);
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .merge(home::routes())
        .merge(automations::routes())
        .merge(catalog::routes())
        .merge(history::routes())
        .merge(publish::routes())
        .merge(push::routes())
        .merge(pwa::routes())
        .merge(settings::routes())
        .merge(spaces::routes())
        .merge(transcript::routes())
        .merge(apps::routes())
}

/// Runs a blocking operation against the Hub database off the async runtime.
pub(crate) async fn cs<T: Send + 'static>(
    state: &AppState,
    operation: impl FnOnce(&rusqlite::Connection) -> rusqlite::Result<T> + Send + 'static,
) -> Result<T> {
    let store = state.hub.clone();
    tokio::task::spawn_blocking(move || store.with(operation))
        .await
        .map_err(ApiError::internal)?
        .map_err(ApiError::internal)
}

/// Called when a structured conversation finishes a turn.
pub(crate) async fn on_turn_finished(state: &AppState, id: tendly_domain::SessionId, status: &str) {
    home::record_turn(state, id, status).await;
}

/// Called after the person saves a file from the browser (not an agent edit),
/// with the content just written.
pub(crate) async fn on_file_saved(state: &AppState, workspace: tendly_domain::WorkspaceId, path: &str, content: &str) {
    history::record_saved(state, workspace, path, content).await;
}

/// Called when a conversation starts waiting on an approval from the person.
pub(crate) async fn on_waiting(state: &AppState, id: tendly_domain::SessionId) {
    home::record_waiting(state, id).await;
}

pub(crate) type SharedConnection = Mutex<rusqlite::Connection>;
