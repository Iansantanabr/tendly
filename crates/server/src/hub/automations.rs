//! Scheduled automations: shell scripts or agent routines run on a cron
//! schedule, with a log of every run. Routes live under `/api/hub/automations`.
use crate::AppState;
use axum::Router;

pub fn routes() -> Router<AppState> {
    Router::new()
}

/// Starts the background scheduler. Called once from `hub::warm`.
pub fn start_scheduler(_state: AppState) {}
