//! What the person allowed each app to do.
//!
//! An app asks in its `app.json`: `"permissions": ["sessions:read", "notify"]`.
//! Asking gives nothing. The first time the app is opened (and again whenever
//! it asks for something it had not asked before) Tendly shows the list and
//! the person allows or refuses; the answer is kept in `hub.db`
//! (`app_grants`), one row per app and permission. What an app may do is what
//! it asks for **and** was allowed: taking a permission out of `app.json`
//! drops its row, so putting it back asks again.
//!
//! The routes that hand Tendly's data to apps (`tendly.rs`) check here, on the
//! server, whatever the page that frames the app believes.
use super::{Found, find};
use crate::{ApiError, AppState, Result, hub::cs};
use axum::{
    Json, Router,
    extract::{Path as UrlPath, State},
    http::StatusCode,
    routing::get,
};
use rusqlite::{Connection, params};
use serde::Deserialize;
use serde_json::{Value, json};

/// Everything an app can ask for, in the order it is shown.
pub(crate) const PERMISSIONS: &[&str] = &["sessions:read", "files:read", "automations:read", "notify", "agent:draft"];

pub(super) fn routes() -> Router<AppState> {
    Router::new().route("/api/hub/apps/{workspace_id}/{slug}/grants", get(get_route).put(put_route))
}

/// `"permissions"` of an app.json: known names, each once, in the order of `PERMISSIONS`.
pub(crate) fn parse_permissions(value: Option<&Value>) -> std::result::Result<Vec<String>, String> {
    let list = match value {
        None | Some(Value::Null) => return Ok(Vec::new()),
        Some(Value::Array(list)) => list,
        Some(_) => return Err("\"permissions\" in app.json must be a list of strings".into()),
    };
    let mut asked = Vec::new();
    for item in list {
        let Some(name) = item.as_str().map(str::trim) else {
            return Err("\"permissions\" in app.json must be a list of strings".into());
        };
        if !PERMISSIONS.contains(&name) {
            return Err(format!("unknown permission \"{name}\" in app.json; the permissions are: {}", PERMISSIONS.join(", ")));
        }
        asked.push(name);
    }
    Ok(PERMISSIONS.iter().filter(|known| asked.contains(known)).map(|known| (*known).to_owned()).collect())
}

/// Where an app stands with the person.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Grants {
    pub requested: Vec<String>,
    pub granted: Vec<String>,
    pub refused: Vec<String>,
    /// Asked for and not answered yet.
    pub pending: Vec<String>,
}

impl Grants {
    /// `none` (asks for nothing), `ask` (something waits for an answer),
    /// `granted`, `refused`, or `partial`.
    pub(crate) fn status(&self) -> &'static str {
        if self.requested.is_empty() {
            "none"
        } else if !self.pending.is_empty() {
            "ask"
        } else if self.refused.is_empty() {
            "granted"
        } else if self.granted.is_empty() {
            "refused"
        } else {
            "partial"
        }
    }

    fn view(&self) -> Value {
        json!({
            "requested": self.requested, "granted": self.granted, "refused": self.refused,
            "pending": self.pending, "status": self.status(),
        })
    }
}

fn decisions(c: &Connection, workspace: &str, slug: &str) -> rusqlite::Result<Vec<(String, bool)>> {
    let mut stmt = c.prepare("SELECT permission, allowed FROM app_grants WHERE workspace_id = ?1 AND slug = ?2")?;
    stmt.query_map(params![workspace, slug], |r| Ok((r.get(0)?, r.get::<_, i64>(1)? != 0)))?.collect()
}

/// The answers on record for what the app asks now. Answers about something it
/// no longer asks are dropped here, so asking for it again is a new question.
pub(crate) fn read(c: &Connection, workspace: &str, slug: &str, requested: &[String]) -> rusqlite::Result<Grants> {
    let mut grants = Grants { requested: requested.to_vec(), granted: Vec::new(), refused: Vec::new(), pending: Vec::new() };
    let known = decisions(c, workspace, slug)?;
    for (permission, _) in known.iter().filter(|(permission, _)| !requested.contains(permission)) {
        c.execute(
            "DELETE FROM app_grants WHERE workspace_id = ?1 AND slug = ?2 AND permission = ?3",
            params![workspace, slug, permission],
        )?;
    }
    for permission in requested {
        match known.iter().find(|(name, _)| name == permission) {
            Some((_, true)) => grants.granted.push(permission.clone()),
            Some((_, false)) => grants.refused.push(permission.clone()),
            None => grants.pending.push(permission.clone()),
        }
    }
    Ok(grants)
}

/// Records the person's answer for everything the app asks: `granted` is
/// allowed, the rest refused. The time of an answer that did not change stays.
pub(crate) fn decide(
    c: &Connection,
    workspace: &str,
    slug: &str,
    requested: &[String],
    granted: &[String],
    at: &str,
) -> rusqlite::Result<Grants> {
    for permission in requested {
        c.execute(
            "INSERT INTO app_grants(workspace_id, slug, permission, allowed, granted_at) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(workspace_id, slug, permission) DO UPDATE SET
               granted_at = CASE WHEN allowed = excluded.allowed THEN granted_at ELSE excluded.granted_at END,
               allowed = excluded.allowed",
            params![workspace, slug, permission, i64::from(granted.contains(permission)), at],
        )?;
    }
    read(c, workspace, slug, requested)
}

/// Refuses, saying what to do about it, unless the app asked for `permission` and the person allowed it.
pub(super) async fn require(state: &AppState, found: &Found, permission: &'static str) -> Result<()> {
    let forbidden = |message: String| ApiError { status: StatusCode::FORBIDDEN, message };
    if !found.app.manifest.permissions.iter().any(|asked| asked == permission) {
        return Err(forbidden(format!(
            "This app has no \"{permission}\" permission. Add it to \"permissions\" in apps/{}/app.json; Tendly then asks the person to allow it.",
            found.slug
        )));
    }
    let (workspace, slug) = (found.workspace.id.to_string(), found.slug.clone());
    let allowed = cs(state, move |c| {
        Ok(decisions(c, &workspace, &slug)?.into_iter().any(|(name, allowed)| allowed && name == permission))
    })
    .await?;
    if allowed {
        Ok(())
    } else {
        Err(forbidden(format!(
            "The \"{permission}\" permission was not allowed for this app. The person can allow it under Permissions, in the app's header."
        )))
    }
}

async fn get_route(
    State(state): State<AppState>,
    UrlPath((workspace, slug)): UrlPath<(String, String)>,
) -> Result<Json<Value>> {
    let found = find(&state, &workspace, &slug).await?;
    let (workspace, slug, requested) = (found.workspace.id.to_string(), found.slug, found.app.manifest.permissions);
    let grants = cs(&state, move |c| read(c, &workspace, &slug, &requested)).await?;
    Ok(Json(grants.view()))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Decision {
    /// What is allowed, out of what the app asks; everything else it asks is refused.
    granted: Vec<String>,
}

async fn put_route(
    State(state): State<AppState>,
    UrlPath((workspace, slug)): UrlPath<(String, String)>,
    Json(body): Json<Decision>,
) -> Result<Json<Value>> {
    let found = find(&state, &workspace, &slug).await?;
    let (workspace, slug, requested) = (found.workspace.id.to_string(), found.slug, found.app.manifest.permissions);
    if let Some(extra) = body.granted.iter().find(|name| !requested.contains(name)) {
        return Err(ApiError::bad(format!("This app does not ask for \"{extra}\"")));
    }
    let at = chrono::Utc::now().to_rfc3339();
    let grants = cs(&state, move |c| decide(c, &workspace, &slug, &requested, &body.granted, &at)).await?;
    Ok(Json(grants.view()))
}
