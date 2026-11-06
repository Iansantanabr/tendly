//! Scheduled automations: shell scripts or agent routines run on a cron
//! schedule, with a log of every run. Routes live under `/api/hub/automations`;
//! the same create/update/list logic backs the `tendly_automation_*` agent tools.
//!
//! The scheduler ticks every 30 s and runs whatever fell due since the last
//! tick. When the gap is far longer than a tick (the machine slept, the server
//! was stopped), what was missed is not replayed: the clock just moves on.
use super::{cs, home, settings};
use crate::{
    ApiError, AppState, Result,
    activity::Answer,
    agent::{Caller, text},
    app::db,
};
use axum::{
    Json, Router,
    extract::{Path, Query, State},
    routing::{get, post},
};
use chrono::{DateTime, Utc};
use chrono_tz::Tz;
use croner::{
    Cron,
    parser::{CronParser, Seconds, Year},
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::{
    collections::HashSet,
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};
use tokio::io::AsyncReadExt;

const TICK: Duration = Duration::from_secs(30);
/// A gap between ticks longer than this means the machine slept or the
/// server was stopped: nothing in it is run.
const MAX_GAP_SECONDS: i64 = 5 * 60;
const SCRIPT_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const OUTPUT_TAIL: usize = 64 * 1024;
const RUNS_KEPT: i64 = 200;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/hub/automations", get(list_route).post(create_route))
        .route(
            "/api/hub/automations/{id}",
            axum::routing::patch(update_route).delete(delete_route),
        )
        .route("/api/hub/automations/{id}/run", post(run_route))
        .route("/api/hub/automations/{id}/runs", get(runs_route))
        .route("/api/hub/automations/recent-sessions", get(recent_sessions_route))
}

// ---------------------------------------------------------------------------
// Model

#[derive(Debug, Clone, Serialize, PartialEq)]
pub(crate) struct Automation {
    pub id: String,
    pub name: String,
    pub description: String,
    /// `script` or `agent`.
    pub kind: String,
    pub cron: String,
    /// IANA name; `None` is the server's local time zone.
    pub timezone: Option<String>,
    /// `None` runs a script in the home folder, an agent in the conversations
    /// folder (conversations without a project).
    pub workspace_id: Option<String>,
    pub command: Option<String>,
    pub prompt: Option<String>,
    pub provider: Option<String>,
    pub endpoint_id: Option<String>,
    pub model: Option<String>,
    pub enabled: bool,
    pub created_at: String,
    pub updated_at: String,
}

const COLUMNS: &str = "id, name, description, kind, cron, timezone, workspace_id, command, prompt, provider, endpoint_id, model, enabled, created_at, updated_at";

impl Automation {
    fn blank() -> Self {
        let at = now();
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            name: String::new(),
            description: String::new(),
            kind: "script".into(),
            cron: String::new(),
            timezone: None,
            workspace_id: None,
            command: None,
            prompt: None,
            provider: None,
            endpoint_id: None,
            model: None,
            enabled: true,
            created_at: at.clone(),
            updated_at: at,
        }
    }

    fn from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: r.get(0)?,
            name: r.get(1)?,
            description: r.get(2)?,
            kind: r.get(3)?,
            cron: r.get(4)?,
            timezone: r.get(5)?,
            workspace_id: r.get(6)?,
            command: r.get(7)?,
            prompt: r.get(8)?,
            provider: r.get(9)?,
            endpoint_id: r.get(10)?,
            model: r.get(11)?,
            enabled: r.get::<_, i64>(12)? != 0,
            created_at: r.get(13)?,
            updated_at: r.get(14)?,
        })
    }
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct Run {
    pub id: i64,
    pub automation_id: String,
    pub started_at: String,
    pub finished_at: Option<String>,
    /// `running`, `ok`, `failed` or `timeout`.
    pub status: String,
    pub exit_code: Option<i64>,
    pub output_tail: String,
    pub session_id: Option<String>,
    /// `schedule` or `manual`.
    pub trigger: String,
}

const RUN_COLUMNS: &str =
    "id, automation_id, started_at, finished_at, status, exit_code, output_tail, session_id, trigger";

impl Run {
    fn from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: r.get(0)?,
            automation_id: r.get(1)?,
            started_at: r.get(2)?,
            finished_at: r.get(3)?,
            status: r.get(4)?,
            exit_code: r.get(5)?,
            output_tail: r.get(6)?,
            session_id: r.get(7)?,
            trigger: r.get(8)?,
        })
    }
}

fn now() -> String {
    Utc::now().to_rfc3339()
}

// ---------------------------------------------------------------------------
// Schedules

/// A five-field cron pattern (minute hour day-of-month month day-of-week), or
/// an alias such as `@hourly`.
pub(crate) fn parse_cron(pattern: &str) -> std::result::Result<Cron, String> {
    let pattern = pattern.trim();
    let explain = |reason: String| {
        format!(
            "Invalid schedule \"{pattern}\": {reason}. Use five fields -- minute hour day-of-month month day-of-week -- for example \"0 9 * * 1-5\" for weekdays at 9:00."
        )
    };
    if pattern.is_empty() {
        return Err(explain("it is empty".into()));
    }
    if !pattern.starts_with('@') && pattern.split_whitespace().count() != 5 {
        return Err(explain(format!(
            "it has {} fields, not 5",
            pattern.split_whitespace().count()
        )));
    }
    CronParser::builder()
        .seconds(Seconds::Disallowed)
        .year(Year::Disallowed)
        .build()
        .parse(pattern)
        .map_err(|error| explain(error.to_string()))
}

fn parse_timezone(name: Option<&str>) -> std::result::Result<Option<chrono_tz::Tz>, String> {
    match name.map(str::trim).filter(|name| !name.is_empty()) {
        None => Ok(None),
        Some(name) => name
            .parse::<chrono_tz::Tz>()
            .map(Some)
            .map_err(|_| format!("Unknown time zone \"{name}\"; use an IANA name such as America/Sao_Paulo, or leave it empty for the time zone in Tendly's settings")),
    }
}

/// The zone an automation's schedule is read in: its own, else the one in
/// the hub settings. Never the machine's: a VPS clock is in UTC, and "every
/// day at 9" means 9 where the person is.
fn zone_of(automation: &Automation, default: Tz) -> Option<Tz> {
    parse_timezone(automation.timezone.as_deref()).ok().map(|own| own.unwrap_or(default))
}

/// The first scheduled time strictly after `after`, with the pattern read in `timezone`.
pub(crate) fn next_after(cron: &Cron, timezone: Tz, after: DateTime<Utc>) -> Option<DateTime<Utc>> {
    cron.find_next_occurrence(&after.with_timezone(&timezone), false)
        .ok()
        .map(|at| at.with_timezone(&Utc))
}

/// Whether a scheduled time fell in `(from, to]`.
fn due(cron: &Cron, timezone: Tz, from: DateTime<Utc>, to: DateTime<Utc>) -> bool {
    next_after(cron, timezone, from).is_some_and(|at| at <= to)
}

/// The enabled automations whose schedule fell in `(from, to]`.
fn fell_due(automations: Vec<Automation>, default: Tz, from: DateTime<Utc>, to: DateTime<Utc>) -> Vec<Automation> {
    automations
        .into_iter()
        .filter(|automation| automation.enabled)
        .filter(|automation| {
            let (Ok(cron), Some(timezone)) = (parse_cron(&automation.cron), zone_of(automation, default)) else {
                return false;
            };
            due(&cron, timezone, from, to)
        })
        .collect()
}

/// The span a tick should look at, or `None` when the clock went backwards or
/// jumped far ahead (sleep): missed runs are not replayed.
fn window(last: DateTime<Utc>, now: DateTime<Utc>) -> Option<(DateTime<Utc>, DateTime<Utc>)> {
    let gap = (now - last).num_seconds();
    (now > last && gap <= MAX_GAP_SECONDS).then_some((last, now))
}

fn next_run(automation: &Automation, default: Tz) -> Option<String> {
    let cron = parse_cron(&automation.cron).ok()?;
    next_after(&cron, zone_of(automation, default)?, Utc::now()).map(|at| at.to_rfc3339())
}

// ---------------------------------------------------------------------------
// Validation, shared by the routes and the agent tools

fn string_of(value: &Value, key: &str) -> Result<Option<String>> {
    match value {
        Value::Null => Ok(None),
        Value::String(text) => {
            let text = text.trim();
            Ok((!text.is_empty()).then(|| text.to_owned()))
        }
        _ => Err(ApiError::bad(format!("{key} must be a string or null"))),
    }
}

/// Applies the fields present in `patch`; absent fields keep their value.
fn apply(target: &mut Automation, patch: &Map<String, Value>) -> Result<()> {
    for (key, value) in patch {
        let field = string_of;
        match key.as_str() {
            "name" => target.name = field(value, key)?.unwrap_or_default(),
            "description" => target.description = field(value, key)?.unwrap_or_default(),
            "kind" => target.kind = field(value, key)?.unwrap_or_default(),
            "cron" => target.cron = field(value, key)?.unwrap_or_default(),
            "timezone" => target.timezone = field(value, key)?,
            "workspace_id" => target.workspace_id = field(value, key)?,
            "command" => target.command = field(value, key)?,
            "prompt" => target.prompt = field(value, key)?,
            "provider" => target.provider = field(value, key)?,
            "endpoint_id" => target.endpoint_id = field(value, key)?,
            "model" => target.model = field(value, key)?,
            "enabled" => {
                target.enabled = value
                    .as_bool()
                    .ok_or_else(|| ApiError::bad("enabled must be true or false"))?
            }
            // Read-only fields a client may send back as it got them.
            "id" | "created_at" | "updated_at" | "next_run" | "last_run" | "running" | "effective_timezone" => {}
            other => return Err(ApiError::bad(format!("Unknown automation field \"{other}\""))),
        }
    }
    Ok(())
}

fn validate(automation: &mut Automation) -> Result<()> {
    if automation.name.is_empty() {
        return Err(ApiError::bad("Give the automation a name"));
    }
    if automation.name.chars().count() > 120 {
        return Err(ApiError::bad("The name is longer than 120 characters"));
    }
    if automation.description.chars().count() > 2000 {
        return Err(ApiError::bad("The description is longer than 2000 characters"));
    }
    parse_cron(&automation.cron).map_err(ApiError::bad)?;
    automation.cron = automation.cron.split_whitespace().collect::<Vec<_>>().join(" ");
    parse_timezone(automation.timezone.as_deref()).map_err(ApiError::bad)?;
    if let Some(id) = &automation.workspace_id {
        uuid::Uuid::parse_str(id).map_err(|_| ApiError::bad("workspace_id is not a workspace id"))?;
    }
    match automation.kind.as_str() {
        "script" => match &automation.command {
            None => return Err(ApiError::bad("A script automation needs a command")),
            Some(command) if command.len() > 16 * 1024 => {
                return Err(ApiError::bad("The command is longer than 16 KB"));
            }
            Some(_) => {}
        },
        "agent" => {
            match &automation.prompt {
                None => return Err(ApiError::bad("An agent automation needs a prompt")),
                Some(prompt) if prompt.len() > 32 * 1024 => {
                    return Err(ApiError::bad("The prompt is longer than 32 KB"));
                }
                Some(_) => {}
            }
            let provider = automation.provider.get_or_insert_with(|| "claude_code".into());
            if !matches!(provider.as_str(), "claude_code" | "codex") {
                return Err(ApiError::bad("provider must be claude_code or codex"));
            }
        }
        _ => return Err(ApiError::bad("kind must be script or agent")),
    }
    Ok(())
}

async fn check_workspace(state: &AppState, automation: &Automation) -> Result<()> {
    let Some(id) = &automation.workspace_id else { return Ok(()) };
    let id = uuid::Uuid::parse_str(id).map_err(|_| ApiError::bad("workspace_id is not a workspace id"))?;
    db(state, move |s| s.get_workspace(id))
        .await?
        .map(|_| ())
        .ok_or_else(|| ApiError::bad("That workspace does not exist"))
}

/// A new automation, validated, not yet saved.
async fn draft_new(state: &AppState, patch: &Map<String, Value>) -> Result<Automation> {
    let mut automation = Automation::blank();
    apply(&mut automation, patch)?;
    validate(&mut automation)?;
    check_workspace(state, &automation).await?;
    Ok(automation)
}

/// An existing automation with `patch` applied, validated, not yet saved;
/// with the automation as it was.
async fn draft_update(state: &AppState, id: &str, patch: &Map<String, Value>) -> Result<(Automation, Automation)> {
    let key = id.to_owned();
    let before = cs(state, move |c| load(c, &key))
        .await?
        .ok_or_else(|| ApiError::missing("Automation"))?;
    let mut automation = before.clone();
    apply(&mut automation, patch)?;
    validate(&mut automation)?;
    check_workspace(state, &automation).await?;
    automation.updated_at = now();
    Ok((before, automation))
}

async fn save_new(state: &AppState, automation: Automation) -> Result<Value> {
    let saved = automation.clone();
    let default = cs(state, move |c| {
        insert(c, &saved)?;
        settings::timezone(c)
    })
    .await?;
    Ok(view(&automation, None, default))
}

async fn save_update(state: &AppState, automation: Automation) -> Result<Value> {
    let saved = automation.clone();
    cs(state, move |c| update(c, &saved)).await?;
    let id = automation.id.clone();
    let (last, default) = cs(state, move |c| Ok((last_run(c, &id)?, settings::timezone(c)?))).await?;
    Ok(view(&automation, last.as_ref(), default))
}

// ---------------------------------------------------------------------------
// Storage

fn list_all(c: &Connection) -> rusqlite::Result<Vec<Automation>> {
    let mut stmt = c.prepare(&format!("SELECT {COLUMNS} FROM automations ORDER BY created_at"))?;
    stmt.query_map([], Automation::from_row)?.collect()
}

fn load(c: &Connection, id: &str) -> rusqlite::Result<Option<Automation>> {
    c.query_row(
        &format!("SELECT {COLUMNS} FROM automations WHERE id = ?1"),
        params![id],
        Automation::from_row,
    )
    .optional()
}

fn insert(c: &Connection, a: &Automation) -> rusqlite::Result<usize> {
    c.execute(
        &format!("INSERT INTO automations({COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)"),
        params![
            a.id, a.name, a.description, a.kind, a.cron, a.timezone, a.workspace_id, a.command, a.prompt,
            a.provider, a.endpoint_id, a.model, a.enabled as i64, a.created_at, a.updated_at
        ],
    )
}

fn update(c: &Connection, a: &Automation) -> rusqlite::Result<usize> {
    c.execute(
        "UPDATE automations SET name = ?2, description = ?3, kind = ?4, cron = ?5, timezone = ?6,
            workspace_id = ?7, command = ?8, prompt = ?9, provider = ?10, endpoint_id = ?11, model = ?12,
            enabled = ?13, updated_at = ?14
         WHERE id = ?1",
        params![
            a.id, a.name, a.description, a.kind, a.cron, a.timezone, a.workspace_id, a.command, a.prompt,
            a.provider, a.endpoint_id, a.model, a.enabled as i64, a.updated_at
        ],
    )
}

fn remove(c: &Connection, id: &str) -> rusqlite::Result<usize> {
    c.execute("DELETE FROM automation_runs WHERE automation_id = ?1", params![id])?;
    c.execute("DELETE FROM automations WHERE id = ?1", params![id])
}

fn last_run(c: &Connection, id: &str) -> rusqlite::Result<Option<Run>> {
    c.query_row(
        &format!("SELECT {RUN_COLUMNS} FROM automation_runs WHERE automation_id = ?1 ORDER BY id DESC LIMIT 1"),
        params![id],
        Run::from_row,
    )
    .optional()
}

fn last_runs(c: &Connection) -> rusqlite::Result<Vec<Run>> {
    let mut stmt = c.prepare(&format!(
        "SELECT {RUN_COLUMNS} FROM automation_runs
         WHERE id IN (SELECT MAX(id) FROM automation_runs GROUP BY automation_id)"
    ))?;
    stmt.query_map([], Run::from_row)?.collect()
}

fn runs(c: &Connection, id: &str, limit: i64) -> rusqlite::Result<Vec<Run>> {
    let mut stmt = c.prepare(&format!(
        "SELECT {RUN_COLUMNS} FROM automation_runs WHERE automation_id = ?1 ORDER BY id DESC LIMIT ?2"
    ))?;
    stmt.query_map(params![id, limit], Run::from_row)?.collect()
}

/// Conversations agent routines opened, newest first, one entry per conversation.
fn recent_sessions(c: &Connection, limit: i64) -> rusqlite::Result<Vec<Value>> {
    let mut stmt = c.prepare(
        "SELECT r.session_id, r.automation_id, a.name, r.started_at, r.status
         FROM automation_runs r JOIN automations a ON a.id = r.automation_id
         WHERE a.kind = 'agent' AND r.id IN
            (SELECT MAX(id) FROM automation_runs WHERE session_id IS NOT NULL AND session_id != '' GROUP BY session_id)
         ORDER BY r.started_at DESC, r.id DESC LIMIT ?1",
    )?;
    stmt.query_map(params![limit], |r| {
        Ok(json!({
            "session_id": r.get::<_, String>(0)?,
            "automation_id": r.get::<_, String>(1)?,
            "automation_name": r.get::<_, String>(2)?,
            "started_at": r.get::<_, String>(3)?,
            "status": r.get::<_, String>(4)?,
        }))
    })?
    .collect()
}

fn get_run(c: &Connection, id: i64) -> rusqlite::Result<Run> {
    c.query_row(
        &format!("SELECT {RUN_COLUMNS} FROM automation_runs WHERE id = ?1"),
        params![id],
        Run::from_row,
    )
}

fn start_run(c: &Connection, automation: &str, trigger: &str) -> rusqlite::Result<i64> {
    c.execute(
        "INSERT INTO automation_runs(automation_id, started_at, status, trigger) VALUES (?1, ?2, 'running', ?3)",
        params![automation, now(), trigger],
    )?;
    let id = c.last_insert_rowid();
    c.execute(
        "DELETE FROM automation_runs WHERE automation_id = ?1 AND id NOT IN
            (SELECT id FROM automation_runs WHERE automation_id = ?1 ORDER BY id DESC LIMIT ?2)",
        params![automation, RUNS_KEPT],
    )?;
    Ok(id)
}

fn finish_run(c: &Connection, id: i64, outcome: &Outcome) -> rusqlite::Result<usize> {
    c.execute(
        "UPDATE automation_runs SET finished_at = ?2, status = ?3, exit_code = ?4, output_tail = ?5, session_id = ?6
         WHERE id = ?1",
        params![id, now(), outcome.status, outcome.exit_code, outcome.output, outcome.session_id],
    )
}

/// Runs a previous server left `running` never finish.
fn abandon_running(c: &Connection) -> rusqlite::Result<usize> {
    c.execute(
        "UPDATE automation_runs SET status = 'failed', finished_at = ?1,
            output_tail = output_tail || char(10) || '[Tendly stopped before this run finished]'
         WHERE status = 'running'",
        params![now()],
    )
}

fn run_summary(run: &Run) -> Value {
    json!({
        "id": run.id, "status": run.status, "started_at": run.started_at, "finished_at": run.finished_at,
        "exit_code": run.exit_code, "session_id": run.session_id, "trigger": run.trigger,
    })
}

/// `default` is the hub's time zone, which the schedule follows when the
/// automation names none; `effective_timezone` says which one that is.
fn view(automation: &Automation, last: Option<&Run>, default: Tz) -> Value {
    let mut value = serde_json::to_value(automation).unwrap_or_else(|_| json!({}));
    value["next_run"] = json!(if automation.enabled { next_run(automation, default) } else { None });
    value["effective_timezone"] = json!(zone_of(automation, default).map(|zone| zone.name()));
    value["last_run"] = last.map(run_summary).unwrap_or(Value::Null);
    value["running"] = json!(is_running(&automation.id));
    value
}

pub(crate) async fn list_views(state: &AppState) -> Result<Vec<Value>> {
    let (automations, last, default) = cs(state, |c| Ok((list_all(c)?, last_runs(c)?, settings::timezone(c)?))).await?;
    Ok(automations
        .iter()
        .map(|a| view(a, last.iter().find(|run| run.automation_id == a.id), default))
        .collect())
}

/// The automations as an app with `automations:read` sees them
/// (`apps/tendly.rs`): what each is and when it runs, with its latest runs.
/// Never the command, the prompt or a run's output, which may hold secrets.
pub(crate) async fn list_for_apps(state: &AppState, run_limit: i64) -> Result<Vec<Value>> {
    let (automations, default, latest) = cs(state, move |c| {
        let automations = list_all(c)?;
        let mut latest = Vec::new();
        for automation in &automations {
            latest.push(runs(c, &automation.id, run_limit)?);
        }
        Ok((automations, settings::timezone(c)?, latest))
    })
    .await?;
    Ok(automations
        .iter()
        .zip(latest)
        .map(|(a, runs)| {
            json!({
                "id": a.id, "name": a.name, "description": a.description, "kind": a.kind, "cron": a.cron,
                "timezone": zone_of(a, default).map(|zone| zone.name()),
                "workspace_id": a.workspace_id, "enabled": a.enabled,
                "next_run": if a.enabled { next_run(a, default) } else { None },
                "running": is_running(&a.id),
                "created_at": a.created_at, "updated_at": a.updated_at,
                "runs": runs.iter().map(run_summary).collect::<Vec<_>>(),
            })
        })
        .collect())
}

// ---------------------------------------------------------------------------
// Running

/// Automations running now; the same one never runs twice at once.
fn running() -> &'static Mutex<HashSet<String>> {
    static RUNNING: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    RUNNING.get_or_init(Default::default)
}

fn is_running(id: &str) -> bool {
    running().lock().expect("running").contains(id)
}

struct Claim(String);

impl Claim {
    fn take(id: &str) -> Option<Self> {
        running()
            .lock()
            .expect("running")
            .insert(id.to_owned())
            .then(|| Self(id.to_owned()))
    }
}

impl Drop for Claim {
    fn drop(&mut self) {
        running().lock().expect("running").remove(&self.0);
    }
}

#[derive(Debug)]
struct Outcome {
    status: &'static str,
    exit_code: Option<i64>,
    output: String,
    session_id: Option<String>,
    /// A short reason for the inbox when it failed.
    reason: String,
}

impl Outcome {
    fn failed(reason: impl Into<String>) -> Self {
        let reason = reason.into();
        Self { status: "failed", exit_code: None, output: reason.clone(), session_id: None, reason }
    }
}

/// Starts a run. With `wait`, returns once it is over (agent runs only take
/// as long as starting the session); otherwise it goes on in the background
/// and the run is returned as `running`.
async fn trigger(state: &AppState, automation: Automation, trigger: &'static str, wait: bool) -> Result<Run> {
    let claim = Claim::take(&automation.id)
        .ok_or_else(|| ApiError::conflict(format!("“{}” is running already", automation.name)))?;
    let id = automation.id.clone();
    let run_id = cs(state, move |c| start_run(c, &id, trigger)).await?;
    let task_state = state.clone();
    let task = async move {
        let _claim = claim;
        execute(&task_state, automation, run_id).await;
    };
    if wait {
        task.await;
    } else {
        tokio::spawn(task);
    }
    cs(state, move |c| get_run(c, run_id)).await
}

async fn execute(state: &AppState, automation: Automation, run_id: i64) {
    let outcome = if automation.kind == "agent" {
        run_agent(state, &automation).await
    } else {
        run_script(state, &automation).await
    };
    let saved = cs(state, move |c| finish_run(c, run_id, &outcome).map(|_| outcome)).await;
    let outcome = match saved {
        Ok(outcome) => outcome,
        Err(error) => {
            tracing::warn!(?error, automation = %automation.id, "could not record automation run");
            return;
        }
    };
    let session = outcome.session_id.as_deref().and_then(|id| uuid::Uuid::parse_str(id).ok());
    let (kind, body) = if outcome.status == "ok" {
        ("automation_done", String::new())
    } else {
        ("automation_failed", outcome.reason.chars().take(200).collect())
    };
    if session.is_none() {
        // Like a conversation, a script keeps one unread entry of each kind:
        // an hourly job should not bury the bell.
        let name = automation.name.clone();
        let _ = cs(state, move |c| {
            c.execute(
                "DELETE FROM notifications WHERE session_id IS NULL AND kind = ?1 AND title = ?2 AND read_at IS NULL",
                params![kind, name],
            )
        })
        .await;
    }
    home::notify(state, kind, session, automation.name.clone(), body).await;
}

async fn run_agent(state: &AppState, automation: &Automation) -> Outcome {
    let started = async {
        let workspace = match &automation.workspace_id {
            Some(id) => uuid::Uuid::parse_str(id).map_err(|_| ApiError::bad("The workspace id is not valid"))?,
            None => home::ensure_conversations(state).await?.id,
        };
        let arguments = json!({
            "provider": automation.provider.as_deref().unwrap_or("claude_code"),
            "prompt": automation.prompt.clone().unwrap_or_default(),
            "title": automation.name,
            "keep": true,
            "endpoint_id": automation.endpoint_id,
            "model": automation.model,
        });
        let start = crate::agent_sessions::start_of(&arguments, true)?;
        crate::agent_sessions::start_in(
            state,
            workspace,
            start,
            None,
            json!({ "kind": "session", "title": format!("Automation “{}”", automation.name) }),
            |_| async { Ok(()) },
        )
        .await
    };
    match started.await {
        Ok(started) => {
            let session = started["started"]["id"].as_str().map(str::to_owned);
            Outcome {
                status: "ok",
                exit_code: None,
                output: format!("Started conversation “{}”.", started["started"]["title"].as_str().unwrap_or(&automation.name)),
                session_id: session,
                reason: String::new(),
            }
        }
        Err(error) => Outcome::failed(format!("Could not start the agent: {}", error.message)),
    }
}

/// The person's shell as a login shell, so a script sees the same PATH and
/// variables a new terminal would; plain `sh` when that shell is unusual.
fn shell_command(script: &str) -> tokio::process::Command {
    #[cfg(unix)]
    {
        let login = std::env::var("SHELL").ok().filter(|shell| {
            let path = std::path::Path::new(shell);
            matches!(
                path.file_name().and_then(|name| name.to_str()),
                Some("bash" | "zsh" | "sh")
            ) && path.is_file()
        });
        let mut command = tokio::process::Command::new(login.as_deref().unwrap_or("/bin/sh"));
        if login.is_some() {
            command.arg("-l");
        }
        command.arg("-c").arg(script);
        command
    }
    #[cfg(not(unix))]
    {
        let mut command = tokio::process::Command::new("cmd");
        command.arg("/C").arg(script);
        command
    }
}

fn push_tail(buffer: &mut Vec<u8>, chunk: &[u8]) {
    buffer.extend_from_slice(chunk);
    if buffer.len() > OUTPUT_TAIL {
        let cut = buffer.len() - OUTPUT_TAIL;
        buffer.drain(..cut);
    }
}

fn tail_text(buffer: &[u8]) -> String {
    // The cut may land inside a character; start at the next whole one.
    let start = buffer.iter().take(3).take_while(|b| (**b & 0xC0) == 0x80).count();
    String::from_utf8_lossy(&buffer[start..]).into_owned()
}

async fn read_into(mut pipe: impl tokio::io::AsyncRead + Unpin, buffer: Arc<Mutex<Vec<u8>>>) {
    let mut chunk = [0u8; 8192];
    loop {
        match pipe.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(read) => push_tail(&mut buffer.lock().expect("output"), &chunk[..read]),
        }
    }
}

async fn script_directory(state: &AppState, automation: &Automation) -> std::result::Result<std::path::PathBuf, String> {
    match &automation.workspace_id {
        Some(id) => {
            let id = uuid::Uuid::parse_str(id).map_err(|_| "The workspace id is not valid".to_owned())?;
            match db(state, move |s| s.get_workspace(id)).await {
                Ok(Some(workspace)) => Ok(workspace.root_path.into()),
                Ok(None) => Err("Its workspace no longer exists".into()),
                Err(error) => Err(error.message),
            }
        }
        None => std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .map(Into::into)
            .ok_or_else(|| "There is no home folder to run in".to_owned()),
    }
}

async fn run_script(state: &AppState, automation: &Automation) -> Outcome {
    let directory = match script_directory(state, automation).await {
        Ok(directory) => directory,
        Err(reason) => return Outcome::failed(reason),
    };
    run_command(&directory, automation, SCRIPT_TIMEOUT).await
}

async fn run_command(directory: &std::path::Path, automation: &Automation, limit: Duration) -> Outcome {
    let mut command = shell_command(automation.command.as_deref().unwrap_or_default());
    command
        .current_dir(directory)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .env("TENDLY_AUTOMATION_ID", &automation.id)
        .env("TENDLY_AUTOMATION_NAME", &automation.name)
        .kill_on_drop(true);
    // Its own process group, so a timeout stops what it started too.
    #[cfg(unix)]
    command.process_group(0);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => return Outcome::failed(format!("Could not start the shell in {}: {error}", directory.display())),
    };
    let output = Arc::new(Mutex::new(Vec::new()));
    let readers = [
        child.stdout.take().map(|pipe| tokio::spawn(read_into(pipe, output.clone()))),
        child.stderr.take().map(|pipe| tokio::spawn(read_into(pipe, output.clone()))),
    ];
    let waited = tokio::time::timeout(limit, child.wait()).await;
    if waited.is_err() {
        #[cfg(unix)]
        if let Some(pid) = child.id() {
            // SAFETY: signalling a process group this server created.
            unsafe { libc::kill(-(pid as i32), libc::SIGKILL) };
        }
        let _ = child.kill().await;
    }
    // Something it left in the background may hold the pipes open; do not wait on it.
    for reader in readers.into_iter().flatten() {
        let handle = reader.abort_handle();
        if tokio::time::timeout(Duration::from_secs(5), reader).await.is_err() {
            handle.abort();
        }
    }
    let mut text = tail_text(&output.lock().expect("output"));
    match waited {
        Err(_) => {
            let minutes = limit.as_secs().div_ceil(60);
            text.push_str(&format!("\n[Stopped after {minutes} min]"));
            Outcome { status: "timeout", exit_code: None, output: text, session_id: None, reason: format!("Timed out after {minutes} min") }
        }
        Ok(Err(error)) => Outcome::failed(format!("{text}\n[Could not wait for the script: {error}]")),
        Ok(Ok(status)) => {
            let code = status.code().map(i64::from);
            if status.success() {
                Outcome { status: "ok", exit_code: code, output: text, session_id: None, reason: String::new() }
            } else {
                let reason = match code {
                    Some(code) => format!("Exit code {code}"),
                    None => "Stopped by a signal".into(),
                };
                Outcome { status: "failed", exit_code: code, output: text, session_id: None, reason }
            }
        }
    }
}

/// Starts the background scheduler. Called once from `hub::warm`.
pub fn start_scheduler(state: AppState) {
    tokio::spawn(async move {
        if let Err(error) = cs(&state, abandon_running).await {
            tracing::warn!(?error, "could not close unfinished automation runs");
        }
        let mut interval = tokio::time::interval(TICK);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        interval.tick().await;
        let mut last = Utc::now();
        loop {
            interval.tick().await;
            let now = Utc::now();
            match window(last, now) {
                Some((from, to)) => tick(&state, from, to).await,
                None => tracing::info!(gap = (now - last).num_seconds(), "automations: skipped a gap, nothing missed is replayed"),
            }
            last = now;
        }
    });
}

async fn tick(state: &AppState, from: DateTime<Utc>, to: DateTime<Utc>) {
    let (automations, default) = match cs(state, |c| Ok((list_all(c)?, settings::timezone(c)?))).await {
        Ok(read) => read,
        Err(error) => {
            tracing::warn!(?error, "automations: could not read the schedule");
            return;
        }
    };
    for automation in fell_due(automations, default, from, to) {
        if is_running(&automation.id) {
            continue;
        }
        let id = automation.id.clone();
        if let Err(error) = trigger(state, automation, "schedule", false).await {
            tracing::warn!(error = %error.message, automation = %id, "automation did not start");
        }
    }
}

// ---------------------------------------------------------------------------
// Routes

fn object(body: Value) -> Result<Map<String, Value>> {
    match body {
        Value::Object(map) => Ok(map),
        _ => Err(ApiError::bad("Send a JSON object")),
    }
}

async fn list_route(State(state): State<AppState>) -> Result<Json<Value>> {
    Ok(Json(json!({ "automations": list_views(&state).await? })))
}

async fn create_route(State(state): State<AppState>, Json(body): Json<Value>) -> Result<Json<Value>> {
    let automation = draft_new(&state, &object(body)?).await?;
    Ok(Json(save_new(&state, automation).await?))
}

async fn update_route(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>> {
    let (_, automation) = draft_update(&state, &id, &object(body)?).await?;
    Ok(Json(save_update(&state, automation).await?))
}

async fn delete_route(State(state): State<AppState>, Path(id): Path<String>) -> Result<Json<Value>> {
    if cs(&state, move |c| remove(c, &id)).await? == 0 {
        return Err(ApiError::missing("Automation"));
    }
    Ok(Json(json!({ "ok": true })))
}

async fn run_route(State(state): State<AppState>, Path(id): Path<String>) -> Result<Json<Value>> {
    let automation = cs(&state, move |c| load(c, &id))
        .await?
        .ok_or_else(|| ApiError::missing("Automation"))?;
    let wait = automation.kind == "agent";
    let run = trigger(&state, automation, "manual", wait).await?;
    Ok(Json(serde_json::to_value(run).map_err(ApiError::internal)?))
}

#[derive(Deserialize)]
struct RunsQuery {
    limit: Option<i64>,
}

async fn runs_route(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<RunsQuery>,
) -> Result<Json<Value>> {
    let limit = query.limit.unwrap_or(20).clamp(1, RUNS_KEPT);
    let rows = cs(&state, move |c| runs(c, &id, limit)).await?;
    Ok(Json(json!({ "runs": rows })))
}

async fn recent_sessions_route(State(state): State<AppState>, Query(query): Query<RunsQuery>) -> Result<Json<Value>> {
    let limit = query.limit.unwrap_or(10).clamp(1, 50);
    let items = cs(&state, move |c| recent_sessions(c, limit)).await?;
    Ok(Json(json!({ "items": items })))
}

// ---------------------------------------------------------------------------
// Agent tools

fn fields() -> Value {
    json!({
        "name": { "type": "string" },
        "description": { "type": "string" },
        "kind": { "type": "string", "enum": ["script", "agent"], "description": "script runs a shell command; agent starts a Claude Code or Codex conversation with a prompt." },
        "cron": { "type": "string", "description": "Five-field cron: minute hour day-of-month month day-of-week, e.g. \"0 9 * * 1-5\" (weekdays 9:00), \"0 * * * *\" (hourly)." },
        "timezone": { "type": ["string", "null"], "description": "IANA time zone such as America/Sao_Paulo; null for the one set in Tendly's settings (Settings → Addresses and time zone)." },
        "workspace_id": { "type": ["string", "null"], "description": "Workspace to run in (see tendly_list what=workspaces). null: scripts run in the home folder, agents in a conversation without a project." },
        "command": { "type": ["string", "null"], "description": "For kind=script: the shell command, run with the person's login shell. Times out after 10 minutes." },
        "prompt": { "type": ["string", "null"], "description": "For kind=agent: what the agent is asked each time." },
        "provider": { "type": ["string", "null"], "enum": ["claude_code", "codex", null], "description": "For kind=agent; default claude_code." },
        "endpoint_id": { "type": ["string", "null"], "description": "For kind=agent: endpoint profile id; null for the default." },
        "model": { "type": ["string", "null"] },
        "enabled": { "type": "boolean" }
    })
}

pub(crate) fn tools() -> Vec<Value> {
    let mut update_fields = fields();
    update_fields["id"] = json!({ "type": "string", "description": "The automation's id, from tendly_automation_list." });
    vec![
        crate::agent::tool(
            "tendly_automation_list",
            "List the person's scheduled automations (Tendly's Automations page): each with its schedule, next run and last result.",
            json!({ "type": "object", "properties": {}, "additionalProperties": false }),
        ),
        crate::agent::tool(
            "tendly_automation_create",
            "Create a scheduled automation: a shell script or an agent prompt run on a cron schedule on this machine. A script is confirmed by the person in the Tendly window first.",
            json!({ "type": "object", "properties": fields(), "required": ["name", "kind", "cron"], "additionalProperties": false }),
        ),
        crate::agent::tool(
            "tendly_automation_update",
            "Change a scheduled automation: only the fields given change. Set enabled false to pause it. A new or changed script command is confirmed by the person in the Tendly window first.",
            json!({ "type": "object", "properties": update_fields, "required": ["id"], "additionalProperties": false }),
        ),
    ]
}

/// Scheduling a shell command is asked first: it would keep running on its
/// own long after this conversation. Everything else is reported.
async fn confirm_script(state: &AppState, caller: Caller, automation: &Automation, title: &str) -> Result<()> {
    let who = crate::agent_config::who(state, caller).await;
    let place = match &automation.workspace_id {
        Some(id) => {
            let id = uuid::Uuid::parse_str(id).ok();
            match id {
                Some(id) => db(state, move |s| s.get_workspace(id)).await.ok().flatten().map(|w| w.root_path),
                None => None,
            }
            .unwrap_or_default()
        }
        None => "~".into(),
    };
    let answer = state
        .activity
        .ask(
            who,
            title,
            json!({ "name": automation.name }),
            vec![
                ("Schedule", automation.cron.clone()),
                ("Command", automation.command.clone().unwrap_or_default()),
                ("Runs in", place),
            ],
            vec!["It runs on this machine with your permissions, on its schedule, until you turn it off."],
            None,
        )
        .await?;
    match answer {
        Answer::Approved { .. } => Ok(()),
        Answer::Declined => Err(ApiError::bad("The person declined. Nothing was changed.")),
    }
}

pub(crate) async fn call(state: &AppState, caller: Caller, name: &str, arguments: &Value) -> Result<Value> {
    let patch = arguments.as_object().cloned().unwrap_or_default();
    match name {
        "tendly_automation_list" => Ok(json!({ "automations": list_views(state).await? })),
        "tendly_automation_create" => {
            let automation = draft_new(state, &patch).await?;
            if automation.kind == "script" {
                confirm_script(state, caller, &automation, "Schedule the command of “{name}”?").await?;
            }
            let view = save_new(state, automation).await?;
            let who = crate::agent_config::who(state, caller).await;
            state.activity.notify(who, "Created automation “{name}”", json!({ "name": view["name"] }), None);
            Ok(json!({ "created": view }))
        }
        "tendly_automation_update" => {
            let id = text(arguments, "id").ok_or_else(|| ApiError::bad("id is required"))?.to_owned();
            let (before, automation) = draft_update(state, &id, &patch).await?;
            let script_changed = automation.kind == "script"
                && (before.kind != "script" || before.command != automation.command);
            if script_changed {
                confirm_script(state, caller, &automation, "Change the command of “{name}”?").await?;
            }
            let view = save_update(state, automation).await?;
            let who = crate::agent_config::who(state, caller).await;
            state.activity.notify(who, "Changed automation “{name}”", json!({ "name": view["name"] }), None);
            Ok(json!({ "updated": view }))
        }
        other => Err(ApiError::bad(format!("Unknown Tendly tool {other:?}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utc(text: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(text).unwrap().with_timezone(&Utc)
    }

    #[test]
    fn hub_cron_next_run_follows_the_pattern_and_time_zone() {
        let weekdays = parse_cron("0 9 * * 1-5").unwrap();
        let utc_tz = chrono_tz::UTC;
        // Friday 2026-11-06 10:00 UTC: the next is Monday 9:00.
        assert_eq!(next_after(&weekdays, utc_tz, utc("2026-11-06T10:00:00Z")), Some(utc("2026-11-09T09:00:00Z")));
        // Strictly after: exactly 9:00 moves on to the next day.
        assert_eq!(next_after(&weekdays, utc_tz, utc("2026-11-05T09:00:00Z")), Some(utc("2026-11-06T09:00:00Z")));
        let hourly = parse_cron("0 * * * *").unwrap();
        assert_eq!(next_after(&hourly, utc_tz, utc("2026-11-05T09:59:30Z")), Some(utc("2026-11-05T10:00:00Z")));
        // 9:00 in São Paulo (UTC-3, no daylight saving) is 12:00 UTC.
        let daily = parse_cron("0 9 * * *").unwrap();
        let sao_paulo = parse_timezone(Some("America/Sao_Paulo")).unwrap().unwrap();
        assert_eq!(next_after(&daily, sao_paulo, utc("2026-11-05T00:00:00Z")), Some(utc("2026-11-05T12:00:00Z")));
        assert!(parse_cron("@hourly").is_ok());
    }

    #[test]
    fn hub_cron_rejects_invalid_patterns_with_a_clear_message() {
        for bad in ["", "* * * *", "0 0 9 * * *", "61 * * * *", "0 25 * * *", "bogus * * * *"] {
            let error = parse_cron(bad).expect_err(bad);
            assert!(error.contains("Invalid schedule") && error.contains("five fields"), "{bad}: {error}");
        }
        assert!(parse_timezone(Some("Mars/Olympus")).is_err());
        assert_eq!(parse_timezone(Some("  ")).unwrap(), None);
    }

    #[test]
    fn hub_due_only_inside_the_window_and_gaps_are_not_replayed() {
        let hourly = parse_cron("0 * * * *").unwrap();
        let tz = chrono_tz::UTC;
        assert!(due(&hourly, tz, utc("2026-11-05T09:59:45Z"), utc("2026-11-05T10:00:15Z")));
        assert!(due(&hourly, tz, utc("2026-11-05T09:59:45Z"), utc("2026-11-05T10:00:00Z")));
        assert!(!due(&hourly, tz, utc("2026-11-05T10:00:00Z"), utc("2026-11-05T10:00:30Z")));
        assert!(!due(&hourly, tz, utc("2026-11-05T10:00:15Z"), utc("2026-11-05T10:00:45Z")));
        let last = utc("2026-11-05T09:00:00Z");
        assert!(window(last, utc("2026-11-05T09:00:30Z")).is_some());
        assert!(window(last, utc("2026-11-05T17:00:00Z")).is_none(), "slept for hours");
        assert!(window(last, utc("2026-11-05T08:59:00Z")).is_none(), "clock went back");
    }

    /// The move to a VPS: the machine's clock is in UTC, the person is not.
    #[test]
    fn hub_schedule_follows_the_settings_time_zone_not_the_machines() {
        let hub = crate::hub::HubStore::memory();
        let daily = |id: &str, timezone: Option<&str>| {
            let mut a = script("true");
            a.id = id.into();
            a.cron = "0 9 * * *".into();
            a.timezone = timezone.map(str::to_owned);
            a
        };
        let all = || vec![daily("plain", None), daily("lisbon", Some("Europe/Lisbon")), daily("utc", Some("UTC"))];
        let ids = |due: Vec<Automation>| due.into_iter().map(|a| a.id).collect::<Vec<_>>();
        let around = |time: &str| {
            let at = utc(time);
            (at - chrono::Duration::seconds(15), at + chrono::Duration::seconds(15))
        };

        // Nothing stored yet: São Paulo, where 9:00 is 12:00 UTC all year.
        let default = hub.with(settings::timezone).unwrap();
        assert_eq!(default.name(), "America/Sao_Paulo");
        let (from, to) = around("2026-11-05T12:00:00Z");
        assert_eq!(ids(fell_due(all(), default, from, to)), ["plain"], "9:00 in São Paulo");
        let (from, to) = around("2026-11-05T09:00:00Z");
        assert_eq!(ids(fell_due(all(), default, from, to)), ["lisbon", "utc"], "9:00 UTC is 6:00 in São Paulo");
        // A whole day of 30 s ticks runs it exactly once, at 12:00 UTC.
        let plain = daily("plain", None);
        let mut ran = Vec::new();
        let mut tick = utc("2026-11-05T00:00:00Z");
        while tick < utc("2026-11-06T00:00:00Z") {
            let next = tick + chrono::Duration::seconds(30);
            if !fell_due(vec![plain.clone()], default, tick, next).is_empty() {
                ran.push(next);
            }
            tick = next;
        }
        assert_eq!(ran, [utc("2026-11-05T12:00:00Z")]);
        let shown = view(&plain, None, default);
        assert_eq!(shown["effective_timezone"], "America/Sao_Paulo");
        let next = DateTime::parse_from_rfc3339(shown["next_run"].as_str().unwrap()).unwrap().with_timezone(&default);
        assert_eq!(next.format("%H:%M").to_string(), "09:00");
        assert_eq!(view(&daily("lisbon", Some("Europe/Lisbon")), None, default)["effective_timezone"], "Europe/Lisbon");

        // The person changes the setting: the same automation follows it.
        hub.with(|c| c.execute("INSERT INTO hub_settings(key, value, updated_at) VALUES ('timezone', 'Asia/Tokyo', 'now')", []))
            .unwrap();
        let tokyo = hub.with(settings::timezone).unwrap();
        let (from, to) = around("2026-11-05T00:00:00Z");
        assert_eq!(ids(fell_due(all(), tokyo, from, to)), ["plain"], "9:00 in Tokyo");
        let (from, to) = around("2026-11-05T12:00:00Z");
        assert!(fell_due(all(), tokyo, from, to).is_empty());

        // Off, or with a schedule that no longer parses: never due.
        let mut off = daily("off", None);
        off.enabled = false;
        let mut broken = daily("broken", None);
        broken.cron = "nonsense".into();
        let mut lost = daily("lost", Some("Mars/Olympus"));
        lost.enabled = true;
        let (from, to) = around("2026-11-05T12:00:00Z");
        assert!(fell_due(vec![off, broken, lost], default, from, to).is_empty());
    }

    /// The schedule code must not consult the machine's zone at all.
    #[test]
    fn hub_schedule_code_never_reads_the_machine_clock_zone() {
        let source = include_str!("automations.rs");
        let code = source.split("#[cfg(test)]").next().unwrap();
        assert!(!code.contains("Local"), "chrono::Local would follow the VPS clock (UTC)");
    }

    #[test]
    fn hub_drafts_validate_kind_fields_and_patches() {
        let mut a = Automation::blank();
        let patch = |v: Value| v.as_object().unwrap().clone();
        apply(&mut a, &patch(json!({ "name": " Backup ", "cron": "0  3 * * *", "command": "echo hi" }))).unwrap();
        validate(&mut a).unwrap();
        assert_eq!((a.name.as_str(), a.cron.as_str()), ("Backup", "0 3 * * *"));
        apply(&mut a, &patch(json!({ "kind": "agent" }))).unwrap();
        assert!(validate(&mut a).unwrap_err().message.contains("prompt"));
        apply(&mut a, &patch(json!({ "prompt": "Summarize the day" }))).unwrap();
        validate(&mut a).unwrap();
        assert_eq!(a.provider.as_deref(), Some("claude_code"));
        apply(&mut a, &patch(json!({ "provider": "other" }))).unwrap();
        assert!(validate(&mut a).is_err());
        assert!(apply(&mut a, &patch(json!({ "colour": "red" }))).is_err());
        assert!(apply(&mut a, &patch(json!({ "enabled": "yes" }))).is_err());
        let mut b = Automation::blank();
        apply(&mut b, &patch(json!({ "name": "x", "cron": "nope", "command": "true" }))).unwrap();
        assert!(validate(&mut b).unwrap_err().message.contains("Invalid schedule"));
    }

    #[test]
    fn hub_output_keeps_the_last_64_kb_on_a_character_boundary() {
        let mut buffer = Vec::new();
        push_tail(&mut buffer, &vec![b'a'; OUTPUT_TAIL]);
        push_tail(&mut buffer, "é!".as_bytes());
        assert_eq!(buffer.len(), OUTPUT_TAIL);
        assert!(tail_text(&buffer).ends_with("é!"));
        // Cut in the middle of "é": the stray byte is dropped, not shown as garbage.
        let text = tail_text(&"é".as_bytes()[1..]);
        assert_eq!(text, "");
    }

    #[test]
    fn hub_runs_are_pruned_and_unfinished_ones_closed() {
        let store = super::super::HubStore::memory();
        store
            .with(|c| {
                let mut a = Automation::blank();
                a.name = "n".into();
                a.cron = "* * * * *".into();
                a.command = Some("true".into());
                insert(c, &a)?;
                for _ in 0..(RUNS_KEPT + 5) {
                    start_run(c, &a.id, "schedule")?;
                }
                let count: i64 = c.query_row("SELECT COUNT(*) FROM automation_runs", [], |r| r.get(0))?;
                assert_eq!(count, RUNS_KEPT);
                abandon_running(c)?;
                let last = last_run(c, &a.id)?.unwrap();
                assert_eq!(last.status, "failed");
                assert_eq!(last_runs(c)?.len(), 1);
                assert_eq!(runs(c, &a.id, 3)?.len(), 3);
                remove(c, &a.id)?;
                assert!(load(c, &a.id)?.is_none());
                let count: i64 = c.query_row("SELECT COUNT(*) FROM automation_runs", [], |r| r.get(0))?;
                assert_eq!(count, 0);
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn hub_recent_sessions_lists_agent_conversations_newest_first() {
        let store = super::super::HubStore::memory();
        store
            .with(|c| {
                let mut agent = Automation::blank();
                agent.name = "Morning brief".into();
                agent.kind = "agent".into();
                agent.cron = "0 8 * * *".into();
                agent.prompt = Some("brief".into());
                insert(c, &agent)?;
                let mut job = Automation::blank();
                job.name = "Backup".into();
                job.cron = "* * * * *".into();
                job.command = Some("true".into());
                insert(c, &job)?;
                let run = |automation: &str, at: &str, session: Option<&str>| -> rusqlite::Result<()> {
                    let id = start_run(c, automation, "schedule")?;
                    c.execute(
                        "UPDATE automation_runs SET started_at = ?2, status = 'ok', session_id = ?3 WHERE id = ?1",
                        params![id, at, session],
                    )?;
                    Ok(())
                };
                run(&agent.id, "2026-11-01T08:00:00+00:00", Some("s1"))?;
                run(&agent.id, "2026-11-02T08:00:00+00:00", Some("s2"))?;
                run(&agent.id, "2026-11-03T08:00:00+00:00", None)?;
                // A later run that reports the same conversation again stays one entry.
                run(&agent.id, "2026-11-04T08:00:00+00:00", Some("s1"))?;
                run(&job.id, "2026-11-05T08:00:00+00:00", Some("not-an-agent"))?;
                let items = recent_sessions(c, 10)?;
                let ids: Vec<&str> = items.iter().map(|i| i["session_id"].as_str().unwrap()).collect();
                assert_eq!(ids, ["s1", "s2"]);
                assert_eq!(items[0]["automation_name"], "Morning brief");
                assert_eq!(items[0]["automation_id"], agent.id.as_str());
                assert_eq!(items[0]["started_at"], "2026-11-04T08:00:00+00:00");
                assert_eq!(items[0]["status"], "ok");
                assert_eq!(recent_sessions(c, 1)?.len(), 1);
                Ok(())
            })
            .unwrap();
    }

    fn script(command: &str) -> Automation {
        let mut a = Automation::blank();
        a.name = "test".into();
        a.cron = "* * * * *".into();
        a.command = Some(command.into());
        a
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn hub_script_runs_capture_output_exit_code_and_time_out() {
        let dir = std::env::temp_dir();
        let done = run_command(&dir, &script("echo out; echo err 1>&2; pwd; exit 3"), Duration::from_secs(30)).await;
        assert_eq!((done.status, done.exit_code), ("failed", Some(3)));
        assert!(done.output.contains("out") && done.output.contains("err"), "{}", done.output);
        assert_eq!(done.reason, "Exit code 3");
        let ok = run_command(&dir, &script("echo \"$TENDLY_AUTOMATION_NAME\""), Duration::from_secs(30)).await;
        assert_eq!((ok.status, ok.exit_code), ("ok", Some(0)));
        assert!(ok.output.contains("test"));
        let started = std::time::Instant::now();
        let slow = run_command(&dir, &script("sleep 30 & sleep 30"), Duration::from_millis(500)).await;
        assert_eq!(slow.status, "timeout");
        assert!(started.elapsed() < Duration::from_secs(10), "the timeout stops the whole group");
    }
}
