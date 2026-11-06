//! Collections: an app's records, kept in `hub.db`.
//!
//! `tendly.data` keeps one JSON file per key, which is fine for a document one
//! pane edits. A kanban open in two panes is not that: each pane would write
//! the whole list over the other's. A collection keeps one row per record
//! (`app_records`), each a JSON object with a revision that counts its writes.
//! A write may say which revision it saw; when the record moved on meanwhile
//! the answer is 409 with the record as it is now, and nothing is lost.
//!
//! Like everything of an app, these routes are for the Tendly page that frames
//! it (the app asks through `postMessage`, `sdk.js`): its frame cannot reach
//! the API. An app only ever reaches its own records, named by its workspace
//! and folder; no permission is asked, as for `tendly.data`.
//!
//! What an app can ask is small on purpose: `where` is equality on top-level
//! fields (or `in` a short list), never SQL. Field names and values are bound
//! as parameters of a fixed statement shape.
//!
//! Every write is told to the open windows over the agent-activity socket
//! (`{type:"hub", event:"app-records", ...}`), which is how two panes of the
//! same app keep up with each other (`collection.subscribe` in the SDK).
//!
//! `transfer.rs` reads and writes a collection as JSON or CSV; `tools.rs` is
//! what an agent gets (the `tendly_app_records_*` tools).
use super::{Found, find, valid_key};
use crate::{ApiError, AppState, Result, hub::cs};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path as UrlPath, Query, State},
    http::{HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use chrono::{SecondsFormat, Utc};
use rusqlite::{Connection, OptionalExtension, params, params_from_iter, types::Value as Sql};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

pub(crate) mod tools;
pub(crate) mod transfer;

/// The largest record, as the bytes of its JSON.
pub(crate) const MAX_RECORD_BYTES: usize = 5 * 1024 * 1024;
/// How many records a collection holds.
pub(crate) const MAX_RECORDS: i64 = 50_000;
/// How many collections an app has.
pub(crate) const MAX_COLLECTIONS: i64 = 100;
pub(crate) const DEFAULT_LIMIT: usize = 1000;
pub(crate) const MAX_LIMIT: usize = 5000;
/// A list stops here even when `limit` allows more, and says so (`truncated`).
const MAX_LIST_BYTES: usize = 32 * 1024 * 1024;
const MAX_CONDITIONS: usize = 20;
const MAX_IN_VALUES: usize = 100;
const MAX_TEXT_CHARS: usize = 1000;
const MAX_FIELD_CHARS: usize = 64;
/// The largest file an import takes.
pub(crate) const MAX_IMPORT_BYTES: usize = 50 * 1024 * 1024;
/// A collection larger than this is not exported in one answer.
const MAX_EXPORT_BYTES: i64 = 200 * 1024 * 1024;
/// A record larger than this is not sent along with the news of its change:
/// the page that relays it reads it when an app is listening.
const EVENT_RECORD_BYTES: usize = 256 * 1024;

pub(super) fn routes() -> Router<AppState> {
    let base = "/api/hub/apps/{workspace_id}/{slug}/db";
    // Room for the record and its envelope; a body somewhat over the limit still gets the message that says what the limit is.
    let record_body = DefaultBodyLimit::max(MAX_RECORD_BYTES + 3 * 1024 * 1024);
    Router::new()
        .route(base, get(collections_route))
        .route(
            &format!("{base}/{{collection}}"),
            get(list_route).post(insert_route).delete(clear_route).layer(record_body.clone()),
        )
        .route(&format!("{base}/{{collection}}/query"), post(query_route))
        .route(&format!("{base}/{{collection}}/export"), get(transfer::export_route))
        .route(
            &format!("{base}/{{collection}}/import"),
            post(transfer::import_route).layer(DefaultBodyLimit::max(MAX_IMPORT_BYTES + 4096)),
        )
        .route(
            &format!("{base}/{{collection}}/r/{{id}}"),
            get(get_route).put(put_route).patch(patch_route).delete(delete_route).layer(record_body),
        )
}

// ---------------------------------------------------------------------------
// Records

/// One record as an app (or an agent) gets it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub(crate) struct Record {
    pub id: String,
    /// 1 when created, one more on every write.
    pub rev: i64,
    pub created_at: String,
    pub updated_at: String,
    /// Always a JSON object.
    pub data: Value,
}

impl Record {
    fn fields(&self) -> Map<String, Value> {
        self.data.as_object().cloned().unwrap_or_default()
    }
}

/// Which collection of which app.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Scope {
    pub workspace: String,
    pub slug: String,
    pub collection: String,
}

impl Scope {
    pub(super) fn of(found: &Found, collection: &str) -> Result<Self> {
        if !valid_key(collection) {
            return Err(ApiError::bad("Collection names are letters, digits, _ and -, up to 64 characters"));
        }
        Ok(Self { workspace: found.workspace.id.to_string(), slug: found.slug.clone(), collection: collection.to_owned() })
    }
}

/// Why a write or a read was refused.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Failure {
    Missing,
    /// The revision given is not the record's: here is the record as it is now.
    Conflict(Record),
    /// A new record was given an id that is taken.
    Exists(Record),
    /// The collection, or the app's list of collections, is full.
    Full(String),
    TooLarge,
    Bad(String),
}

impl Failure {
    pub(crate) fn status(&self) -> StatusCode {
        match self {
            Failure::Missing => StatusCode::NOT_FOUND,
            Failure::Conflict(_) | Failure::Exists(_) => StatusCode::CONFLICT,
            Failure::Full(_) | Failure::TooLarge => StatusCode::PAYLOAD_TOO_LARGE,
            Failure::Bad(_) => StatusCode::BAD_REQUEST,
        }
    }

    pub(crate) fn message(&self) -> String {
        match self {
            Failure::Missing => "Record not found".into(),
            Failure::Conflict(current) => format!(
                "This record changed since it was read: it is at revision {} now. Read it again and repeat the change.",
                current.rev
            ),
            Failure::Exists(_) => "A record with this id already exists in the collection".into(),
            Failure::Full(message) | Failure::Bad(message) => message.clone(),
            Failure::TooLarge => "A record can be at most 5 MB".into(),
        }
    }

    /// For an app: the message, what kind of refusal, and the record as it is now when there is one.
    fn respond(&self) -> Response {
        let mut body = json!({ "error": self.message() });
        match self {
            Failure::Conflict(current) => {
                body["code"] = json!("conflict");
                body["current"] = json!(current);
            }
            Failure::Exists(current) => {
                body["code"] = json!("exists");
                body["current"] = json!(current);
            }
            Failure::Full(_) => body["code"] = json!("full"),
            _ => {}
        }
        (self.status(), [(header::CACHE_CONTROL, "no-store")], Json(body)).into_response()
    }

    pub(crate) fn api(&self) -> ApiError {
        ApiError { status: self.status(), message: self.message() }
    }
}

/// A store operation: the database may fail, and the operation may be refused.
pub(crate) type Outcome<T> = rusqlite::Result<std::result::Result<T, Failure>>;

pub(crate) fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

const COLUMNS: &str = "id, rev, created_at, updated_at, data";

fn read_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Record> {
    let text: String = row.get(4)?;
    let data = serde_json::from_str(&text)
        .map_err(|error| rusqlite::Error::FromSqlConversionFailure(4, rusqlite::types::Type::Text, Box::new(error)))?;
    Ok(Record { id: row.get(0)?, rev: row.get(1)?, created_at: row.get(2)?, updated_at: row.get(3)?, data })
}

/// The JSON a record is stored as; refused when it is over the limit.
fn encode(data: &Map<String, Value>) -> std::result::Result<String, Failure> {
    let text = serde_json::to_string(data).map_err(|error| Failure::Bad(error.to_string()))?;
    if text.len() > MAX_RECORD_BYTES { Err(Failure::TooLarge) } else { Ok(text) }
}

pub(crate) fn fetch(c: &Connection, scope: &Scope, id: &str) -> rusqlite::Result<Option<Record>> {
    c.prepare_cached(&format!(
        "SELECT {COLUMNS} FROM app_records WHERE workspace_id = ?1 AND slug = ?2 AND collection = ?3 AND id = ?4"
    ))?
    .query_row(params![scope.workspace, scope.slug, scope.collection, id], read_row)
    .optional()
}

fn size(c: &Connection, scope: &Scope) -> rusqlite::Result<i64> {
    c.prepare_cached("SELECT count(*) FROM app_records WHERE workspace_id = ?1 AND slug = ?2 AND collection = ?3")?
        .query_row(params![scope.workspace, scope.slug, scope.collection], |r| r.get(0))
}

/// Whether `more` records fit in the collection, which may be a new one.
fn room(c: &Connection, scope: &Scope, more: i64) -> Outcome<()> {
    let held = size(c, scope)?;
    if held + more > MAX_RECORDS {
        return Ok(Err(Failure::Full(format!("A collection holds at most {MAX_RECORDS} records"))));
    }
    if held == 0 && more > 0 {
        let collections: i64 = c.query_row(
            "SELECT count(DISTINCT collection) FROM app_records WHERE workspace_id = ?1 AND slug = ?2",
            params![scope.workspace, scope.slug],
            |r| r.get(0),
        )?;
        if collections >= MAX_COLLECTIONS {
            return Ok(Err(Failure::Full(format!("An app has at most {MAX_COLLECTIONS} collections"))));
        }
    }
    Ok(Ok(()))
}

fn write_new(c: &Connection, scope: &Scope, id: &str, text: &str, created: &str, at: &str) -> rusqlite::Result<()> {
    c.prepare_cached(
        "INSERT INTO app_records(workspace_id, slug, collection, id, data, rev, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?7)",
    )?
    .execute(params![scope.workspace, scope.slug, scope.collection, id, text, created, at])?;
    Ok(())
}

fn write_over(c: &Connection, scope: &Scope, id: &str, text: &str, at: &str) -> rusqlite::Result<()> {
    c.prepare_cached(
        "UPDATE app_records SET data = ?5, rev = rev + 1, updated_at = ?6
         WHERE workspace_id = ?1 AND slug = ?2 AND collection = ?3 AND id = ?4",
    )?
    .execute(params![scope.workspace, scope.slug, scope.collection, id, text, at])?;
    Ok(())
}

/// A new record. Without an id it gets one; with an id that is taken it is refused.
pub(crate) fn insert(c: &Connection, scope: &Scope, id: Option<&str>, data: &Map<String, Value>, at: &str) -> Outcome<Record> {
    let text = match encode(data) {
        Ok(text) => text,
        Err(failure) => return Ok(Err(failure)),
    };
    let id = match id {
        Some(id) if !valid_key(id) => {
            return Ok(Err(Failure::Bad("Record ids are letters, digits, _ and -, up to 64 characters".into())));
        }
        Some(id) => id.to_owned(),
        None => uuid::Uuid::new_v4().to_string(),
    };
    if let Some(current) = fetch(c, scope, &id)? {
        return Ok(Err(Failure::Exists(current)));
    }
    if let Err(failure) = room(c, scope, 1)? {
        return Ok(Err(failure));
    }
    write_new(c, scope, &id, &text, at, at)?;
    Ok(Ok(Record { id, rev: 1, created_at: at.to_owned(), updated_at: at.to_owned(), data: Value::Object(data.clone()) }))
}

/// How a write changes a record that exists.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Write {
    /// The top-level fields given replace those of the record; the others stay.
    Merge(Map<String, Value>),
    /// The record becomes exactly this.
    Replace(Map<String, Value>),
}

/// Changes a record. With `rev`, only when that is still the record's revision.
pub(crate) fn update(c: &Connection, scope: &Scope, id: &str, write: &Write, rev: Option<i64>, at: &str) -> Outcome<Record> {
    let Some(current) = fetch(c, scope, id)? else { return Ok(Err(Failure::Missing)) };
    if rev.is_some_and(|seen| seen != current.rev) {
        return Ok(Err(Failure::Conflict(current)));
    }
    let data = match write {
        Write::Replace(data) => data.clone(),
        Write::Merge(patch) => {
            let mut data = current.fields();
            for (field, value) in patch {
                data.insert(field.clone(), value.clone());
            }
            data
        }
    };
    let text = match encode(&data) {
        Ok(text) => text,
        Err(failure) => return Ok(Err(failure)),
    };
    write_over(c, scope, id, &text, at)?;
    Ok(Ok(Record { id: current.id, rev: current.rev + 1, created_at: current.created_at, updated_at: at.to_owned(), data: Value::Object(data) }))
}

/// Creates the record with this id or replaces it; the flag says it was created.
/// With `rev` the record must exist at that revision.
pub(crate) fn put(c: &Connection, scope: &Scope, id: &str, write: &Write, rev: Option<i64>, at: &str) -> Outcome<(Record, bool)> {
    if fetch(c, scope, id)?.is_some() {
        return Ok(update(c, scope, id, write, rev, at)?.map(|record| (record, false)));
    }
    if rev.is_some() {
        return Ok(Err(Failure::Missing));
    }
    let (Write::Merge(data) | Write::Replace(data)) = write;
    Ok(insert(c, scope, Some(id), data, at)?.map(|record| (record, true)))
}

/// Removes a record and returns it; `None` when there was none (which is not a failure: it is gone).
pub(crate) fn remove(c: &Connection, scope: &Scope, id: &str, rev: Option<i64>) -> Outcome<Option<Record>> {
    let Some(current) = fetch(c, scope, id)? else { return Ok(Ok(None)) };
    if rev.is_some_and(|seen| seen != current.rev) {
        return Ok(Err(Failure::Conflict(current)));
    }
    c.execute(
        "DELETE FROM app_records WHERE workspace_id = ?1 AND slug = ?2 AND collection = ?3 AND id = ?4",
        params![scope.workspace, scope.slug, scope.collection, id],
    )?;
    Ok(Ok(Some(current)))
}

/// Empties a collection; how many records went.
pub(crate) fn clear(c: &Connection, scope: &Scope) -> rusqlite::Result<usize> {
    c.execute(
        "DELETE FROM app_records WHERE workspace_id = ?1 AND slug = ?2 AND collection = ?3",
        params![scope.workspace, scope.slug, scope.collection],
    )
}

/// An app's collections: `[{ name, count, updated_at }]`, by name.
pub(crate) fn collections(c: &Connection, workspace: &str, slug: &str) -> rusqlite::Result<Vec<Value>> {
    let mut stmt = c.prepare(
        "SELECT collection, count(*), max(updated_at) FROM app_records
         WHERE workspace_id = ?1 AND slug = ?2 GROUP BY collection ORDER BY collection",
    )?;
    stmt.query_map(params![workspace, slug], |r| {
        Ok(json!({ "name": r.get::<_, String>(0)?, "count": r.get::<_, i64>(1)?, "updated_at": r.get::<_, String>(2)? }))
    })?
    .collect()
}

// ---------------------------------------------------------------------------
// The small filter

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Scalar {
    /// A field that is `null` or not there.
    Null,
    Bool(bool),
    Int(i64),
    Real(f64),
    Text(String),
}

/// A top-level field that must equal one of `any` (one value for equality, several for `in`).
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Condition {
    pub field: String,
    pub any: Vec<Scalar>,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Order {
    /// When the record was created (the default, oldest first).
    Created { descending: bool },
    Updated { descending: bool },
    /// A top-level field of the records.
    Field { name: String, descending: bool },
}

impl Default for Order {
    fn default() -> Self {
        Order::Created { descending: false }
    }
}

#[derive(Debug, Clone, PartialEq, Default)]
pub(crate) struct Filter {
    pub conditions: Vec<Condition>,
    pub order: Order,
    pub limit: Option<usize>,
    pub offset: usize,
}

/// A name that can sit inside the quotes of a JSON path (`$."name"`): no
/// quote, no backslash, no control character. It is bound as a parameter, so
/// this is about meaning what was said, not about what could be run.
fn valid_field(name: &str) -> bool {
    !name.is_empty() && name.chars().count() <= MAX_FIELD_CHARS && !name.chars().any(|c| c == '"' || c == '\\' || c.is_control())
}

fn scalar(value: &Value) -> std::result::Result<Scalar, String> {
    match value {
        Value::Null => Ok(Scalar::Null),
        Value::Bool(flag) => Ok(Scalar::Bool(*flag)),
        Value::Number(number) => match (number.as_i64(), number.as_f64()) {
            (Some(whole), _) => Ok(Scalar::Int(whole)),
            (None, Some(real)) => Ok(Scalar::Real(real)),
            _ => Err("where: that number cannot be compared".into()),
        },
        Value::String(text) if text.chars().count() <= MAX_TEXT_CHARS => Ok(Scalar::Text(text.clone())),
        Value::String(_) => Err(format!("where: a text to compare can have at most {MAX_TEXT_CHARS} characters")),
        _ => Err("where compares a field with a text, a number, true, false or null, or with a list: { field: { in: [...] } }".into()),
    }
}

/// `{ "stage": "won", "owner": { "in": ["ana", "bia"] }, "done": false }`.
pub(crate) fn parse_where(value: Option<&Value>) -> std::result::Result<Vec<Condition>, String> {
    let map = match value {
        None | Some(Value::Null) => return Ok(Vec::new()),
        Some(Value::Object(map)) => map,
        Some(_) => return Err("where must be an object: { field: value }".into()),
    };
    if map.len() > MAX_CONDITIONS {
        return Err(format!("where takes at most {MAX_CONDITIONS} fields"));
    }
    let mut conditions = Vec::new();
    for (field, wanted) in map {
        if !valid_field(field) {
            return Err(format!("where: {field:?} is not a field name that can be filtered on"));
        }
        let any = match wanted {
            Value::Object(inner) => {
                let list = match (inner.len(), inner.get("in")) {
                    (1, Some(Value::Array(list))) => list,
                    _ => return Err("where: the only operator is { in: [...] }".into()),
                };
                if list.len() > MAX_IN_VALUES {
                    return Err(format!("where: in takes at most {MAX_IN_VALUES} values"));
                }
                list.iter().map(scalar).collect::<std::result::Result<Vec<_>, _>>()?
            }
            other => vec![scalar(other)?],
        };
        conditions.push(Condition { field: field.clone(), any });
    }
    Ok(conditions)
}

/// `"created_at"` (the default), `"updated_at"` or a field name; `-` in front for descending.
pub(crate) fn parse_order(value: Option<&Value>) -> std::result::Result<Order, String> {
    let text = match value {
        None | Some(Value::Null) => return Ok(Order::default()),
        Some(Value::String(text)) => text.trim(),
        Some(_) => return Err("order must be a field name, with - in front for descending".into()),
    };
    let (name, descending) = match text.strip_prefix('-') {
        Some(name) => (name, true),
        None => (text, false),
    };
    match name {
        "" | "created_at" => Ok(Order::Created { descending }),
        "updated_at" => Ok(Order::Updated { descending }),
        name if valid_field(name) => Ok(Order::Field { name: name.to_owned(), descending }),
        _ => Err(format!("order: {name:?} is not a field name that can be sorted on")),
    }
}

fn path(field: &str) -> Sql {
    Sql::Text(format!("$.\"{field}\""))
}

/// The SQL of the conditions (each `AND ...`), with what it binds, in order.
fn conditions_sql(conditions: &[Condition], bound: &mut Vec<Sql>) -> String {
    let mut sql = String::new();
    for condition in conditions {
        let options: Vec<&str> = condition
            .any
            .iter()
            .map(|wanted| match wanted {
                Scalar::Null => {
                    bound.push(path(&condition.field));
                    "coalesce(json_type(data, ?), 'null') = 'null'"
                }
                Scalar::Bool(flag) => {
                    bound.push(path(&condition.field));
                    if *flag { "json_type(data, ?) = 'true'" } else { "json_type(data, ?) = 'false'" }
                }
                Scalar::Int(_) | Scalar::Real(_) => {
                    bound.extend([path(&condition.field), path(&condition.field)]);
                    bound.push(match wanted {
                        Scalar::Int(whole) => Sql::Integer(*whole),
                        Scalar::Real(real) => Sql::Real(*real),
                        _ => Sql::Null,
                    });
                    "(json_type(data, ?) IN ('integer', 'real') AND json_extract(data, ?) = ?)"
                }
                Scalar::Text(text) => {
                    bound.extend([path(&condition.field), path(&condition.field), Sql::Text(text.clone())]);
                    "(json_type(data, ?) = 'text' AND json_extract(data, ?) = ?)"
                }
            })
            .collect();
        // `in: []` matches nothing.
        sql.push_str(&if options.is_empty() { " AND 0".to_owned() } else { format!(" AND ({})", options.join(" OR ")) });
    }
    sql
}

fn scope_bound(scope: &Scope) -> Vec<Sql> {
    vec![Sql::Text(scope.workspace.clone()), Sql::Text(scope.slug.clone()), Sql::Text(scope.collection.clone())]
}

const IN_SCOPE: &str = "workspace_id = ? AND slug = ? AND collection = ?";

pub(crate) fn count(c: &Connection, scope: &Scope, conditions: &[Condition]) -> rusqlite::Result<i64> {
    let mut bound = scope_bound(scope);
    let wanted = conditions_sql(conditions, &mut bound);
    c.query_row(&format!("SELECT count(*) FROM app_records WHERE {IN_SCOPE}{wanted}"), params_from_iter(bound), |r| r.get(0))
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub(crate) struct Page {
    pub records: Vec<Record>,
    /// How many records match, whatever `limit` and `offset` say.
    pub total: i64,
    /// The list was cut short of `limit` because it grew too large for one answer.
    pub truncated: bool,
}

pub(crate) fn list(c: &Connection, scope: &Scope, filter: &Filter) -> rusqlite::Result<Page> {
    list_within(c, scope, filter, MAX_LIST_BYTES)
}

/// `budget`: the bytes of record data one answer may carry (the first record always goes).
pub(crate) fn list_within(c: &Connection, scope: &Scope, filter: &Filter, budget: usize) -> rusqlite::Result<Page> {
    let total = count(c, scope, &filter.conditions)?;
    let mut bound = scope_bound(scope);
    let wanted = conditions_sql(&filter.conditions, &mut bound);
    let direction = |descending: bool| if descending { "DESC" } else { "ASC" };
    let order = match &filter.order {
        Order::Created { descending } => format!("created_at {0}, rowid {0}", direction(*descending)),
        Order::Updated { descending } => format!("updated_at {0}, rowid {0}", direction(*descending)),
        Order::Field { name, descending } => {
            bound.push(path(name));
            format!("json_extract(data, ?) {}, created_at ASC, rowid ASC", direction(*descending))
        }
    };
    let limit = filter.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    bound.extend([Sql::Integer(limit as i64), Sql::Integer(filter.offset as i64)]);
    let mut stmt = c.prepare(&format!(
        "SELECT {COLUMNS}, length(data) FROM app_records WHERE {IN_SCOPE}{wanted} ORDER BY {order} LIMIT ? OFFSET ?"
    ))?;
    let mut rows = stmt.query(params_from_iter(bound))?;
    let (mut records, mut bytes, mut truncated) = (Vec::new(), 0usize, false);
    while let Some(row) = rows.next()? {
        let length = row.get::<_, i64>(5)? as usize;
        if !records.is_empty() && bytes + length > budget {
            truncated = true;
            break;
        }
        bytes += length;
        records.push(read_row(row)?);
    }
    Ok(Page { records, total, truncated })
}

/// Every record of a collection, oldest first: for an export.
pub(crate) fn all(c: &Connection, scope: &Scope) -> Outcome<Vec<Record>> {
    let bytes: i64 = c.query_row(
        "SELECT coalesce(sum(length(data)), 0) FROM app_records WHERE workspace_id = ?1 AND slug = ?2 AND collection = ?3",
        params![scope.workspace, scope.slug, scope.collection],
        |r| r.get(0),
    )?;
    if bytes > MAX_EXPORT_BYTES {
        return Ok(Err(Failure::Full("This collection is too large to export in one file".into())));
    }
    let mut stmt = c.prepare(&format!(
        "SELECT {COLUMNS} FROM app_records WHERE workspace_id = ?1 AND slug = ?2 AND collection = ?3 ORDER BY created_at, rowid"
    ))?;
    let records = stmt.query_map(params![scope.workspace, scope.slug, scope.collection], read_row)?.collect::<rusqlite::Result<_>>()?;
    Ok(Ok(records))
}

// ---------------------------------------------------------------------------
// Many at once (an import)

/// A record on its way in.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Incoming {
    /// Kept when given; a record with this id is replaced.
    pub id: Option<String>,
    pub created_at: Option<String>,
    pub data: Map<String, Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub(crate) struct Imported {
    pub inserted: usize,
    pub updated: usize,
    /// What `replace` took out before.
    pub removed: usize,
    /// How many records the collection holds now.
    pub total: i64,
}

/// Writes `records` into the collection, all or none. `replace` empties it
/// first; otherwise a record whose id exists is replaced and the rest are added.
pub(crate) fn import(c: &Connection, scope: &Scope, records: &[Incoming], replace: bool, at: &str) -> Outcome<Imported> {
    let tx = c.unchecked_transaction()?;
    let mut done = Imported { inserted: 0, updated: 0, removed: 0, total: 0 };
    if replace {
        done.removed = clear(&tx, scope)?;
    }
    for (index, record) in records.iter().enumerate() {
        let refused = |failure: Failure| Failure::Bad(format!("Record {}: {}", index + 1, failure.message()));
        if let Some(id) = &record.id
            && !valid_key(id)
        {
            return Ok(Err(refused(Failure::Bad(format!("{id:?} is not an id (letters, digits, _ and -, up to 64)")))));
        }
        let text = match encode(&record.data) {
            Ok(text) => text,
            Err(failure) => return Ok(Err(refused(failure))),
        };
        let id = record.id.clone().unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        if fetch(&tx, scope, &id)?.is_some() {
            write_over(&tx, scope, &id, &text, at)?;
            done.updated += 1;
        } else {
            write_new(&tx, scope, &id, &text, record.created_at.as_deref().unwrap_or(at), at)?;
            done.inserted += 1;
        }
    }
    done.total = size(&tx, scope)?;
    if done.total > MAX_RECORDS {
        return Ok(Err(Failure::Full(format!(
            "A collection holds at most {MAX_RECORDS} records; this import would leave it with {}",
            done.total
        ))));
    }
    // This may have been a collection the app did not have yet.
    let collections: i64 = tx.query_row(
        "SELECT count(DISTINCT collection) FROM app_records WHERE workspace_id = ?1 AND slug = ?2",
        params![scope.workspace, scope.slug],
        |r| r.get(0),
    )?;
    if collections > MAX_COLLECTIONS {
        return Ok(Err(Failure::Full(format!("An app has at most {MAX_COLLECTIONS} collections"))));
    }
    tx.commit()?;
    Ok(Ok(done))
}

// ---------------------------------------------------------------------------
// Telling the open windows

/// What changed, for every open window: the panes showing this app pass it on
/// to the app when it subscribed to the collection.
pub(crate) fn announce(state: &AppState, scope: &Scope, op: &str, id: Option<&str>, record: Option<&Record>) {
    let fits = record.is_some_and(|record| serde_json::to_string(&record.data).is_ok_and(|text| text.len() <= EVENT_RECORD_BYTES));
    state.activity.hub_event(json!({
        "type": "hub",
        "event": "app-records",
        "workspace_id": scope.workspace,
        "slug": scope.slug,
        "collection": scope.collection,
        "change": {
            "op": op,
            "id": id,
            "rev": record.map(|record| record.rev),
            "record": if fits { json!(record) } else { Value::Null },
            // Too large to send along: read it (`GET .../r/<id>`).
            "large": record.is_some() && !fits,
        },
    }));
}

// ---------------------------------------------------------------------------
// Routes

/// Runs a store operation and turns a refusal into its answer.
async fn run<T: Send + 'static>(
    state: &AppState,
    operation: impl FnOnce(&Connection) -> Outcome<T> + Send + 'static,
) -> Result<std::result::Result<T, Response>> {
    Ok(cs(state, operation).await?.map_err(|failure| failure.respond()))
}

fn object(value: Option<Value>, what: &str) -> Result<Map<String, Value>> {
    match value {
        Some(Value::Object(map)) => Ok(map),
        _ => Err(ApiError::bad(format!("{what} must be a JSON object"))),
    }
}

fn fresh(value: impl Serialize) -> Response {
    ([(header::CACHE_CONTROL, HeaderValue::from_static("no-store"))], Json(value)).into_response()
}

async fn collections_route(
    State(state): State<AppState>,
    UrlPath((workspace, slug)): UrlPath<(String, String)>,
) -> Result<Response> {
    let found = find(&state, &workspace, &slug).await?;
    let (workspace, slug) = (found.workspace.id.to_string(), found.slug);
    let listed = cs(&state, move |c| collections(c, &workspace, &slug)).await?;
    Ok(fresh(json!({ "collections": listed })))
}

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct QueryBody {
    #[serde(default, rename = "where")]
    wanted: Option<Value>,
    #[serde(default)]
    order: Option<Value>,
    #[serde(default)]
    limit: Option<usize>,
    #[serde(default)]
    offset: Option<usize>,
    /// Only how many match.
    #[serde(default)]
    count: bool,
}

pub(crate) fn filter_of(wanted: Option<&Value>, order: Option<&Value>, limit: Option<usize>, offset: Option<usize>) -> Result<Filter> {
    Ok(Filter {
        conditions: parse_where(wanted).map_err(ApiError::bad)?,
        order: parse_order(order).map_err(ApiError::bad)?,
        limit,
        offset: offset.unwrap_or(0),
    })
}

async fn query_route(
    State(state): State<AppState>,
    UrlPath((workspace, slug, collection)): UrlPath<(String, String, String)>,
    Json(body): Json<QueryBody>,
) -> Result<Response> {
    let scope = Scope::of(&find(&state, &workspace, &slug).await?, &collection)?;
    let filter = filter_of(body.wanted.as_ref(), body.order.as_ref(), body.limit, body.offset)?;
    if body.count {
        let total = cs(&state, move |c| count(c, &scope, &filter.conditions)).await?;
        return Ok(fresh(json!({ "total": total })));
    }
    Ok(fresh(cs(&state, move |c| list(c, &scope, &filter)).await?))
}

#[derive(Deserialize)]
struct ListQuery {
    limit: Option<usize>,
    offset: Option<usize>,
    order: Option<String>,
    /// The filter, as JSON text.
    #[serde(rename = "where")]
    wanted: Option<String>,
}

async fn list_route(
    State(state): State<AppState>,
    UrlPath((workspace, slug, collection)): UrlPath<(String, String, String)>,
    Query(query): Query<ListQuery>,
) -> Result<Response> {
    let scope = Scope::of(&find(&state, &workspace, &slug).await?, &collection)?;
    let wanted = match query.wanted.as_deref().map(str::trim).filter(|text| !text.is_empty()) {
        Some(text) => Some(serde_json::from_str::<Value>(text).map_err(|_| ApiError::bad("where must be JSON"))?),
        None => None,
    };
    let filter = filter_of(wanted.as_ref(), query.order.map(Value::String).as_ref(), query.limit, query.offset)?;
    Ok(fresh(cs(&state, move |c| list(c, &scope, &filter)).await?))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct InsertBody {
    data: Option<Value>,
    #[serde(default)]
    id: Option<String>,
}

async fn insert_route(
    State(state): State<AppState>,
    UrlPath((workspace, slug, collection)): UrlPath<(String, String, String)>,
    Json(body): Json<InsertBody>,
) -> Result<Response> {
    let scope = Scope::of(&find(&state, &workspace, &slug).await?, &collection)?;
    let data = object(body.data, "data")?;
    let (target, at) = (scope.clone(), now());
    let record = match run(&state, move |c| insert(c, &target, body.id.as_deref(), &data, &at)).await? {
        Ok(record) => record,
        Err(refusal) => return Ok(refusal),
    };
    announce(&state, &scope, "insert", Some(&record.id), Some(&record));
    Ok((StatusCode::CREATED, fresh(record)).into_response())
}

async fn clear_route(
    State(state): State<AppState>,
    UrlPath((workspace, slug, collection)): UrlPath<(String, String, String)>,
) -> Result<Response> {
    let scope = Scope::of(&find(&state, &workspace, &slug).await?, &collection)?;
    let target = scope.clone();
    let removed = cs(&state, move |c| clear(c, &target)).await?;
    if removed > 0 {
        announce(&state, &scope, "reset", None, None);
    }
    Ok(fresh(json!({ "removed": removed })))
}

async fn get_route(
    State(state): State<AppState>,
    UrlPath((workspace, slug, collection, id)): UrlPath<(String, String, String, String)>,
) -> Result<Response> {
    let scope = Scope::of(&find(&state, &workspace, &slug).await?, &collection)?;
    let record = cs(&state, move |c| fetch(c, &scope, &id)).await?.ok_or_else(|| ApiError::missing("Record"))?;
    Ok(fresh(record))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PutBody {
    data: Option<Value>,
    #[serde(default)]
    rev: Option<i64>,
}

async fn put_route(
    State(state): State<AppState>,
    UrlPath((workspace, slug, collection, id)): UrlPath<(String, String, String, String)>,
    Json(body): Json<PutBody>,
) -> Result<Response> {
    let scope = Scope::of(&find(&state, &workspace, &slug).await?, &collection)?;
    let write = Write::Replace(object(body.data, "data")?);
    let (target, at) = (scope.clone(), now());
    let (record, created) = match run(&state, move |c| put(c, &target, &id, &write, body.rev, &at)).await? {
        Ok(done) => done,
        Err(refusal) => return Ok(refusal),
    };
    announce(&state, &scope, if created { "insert" } else { "update" }, Some(&record.id), Some(&record));
    Ok((if created { StatusCode::CREATED } else { StatusCode::OK }, fresh(record)).into_response())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PatchBody {
    patch: Option<Value>,
    #[serde(default)]
    rev: Option<i64>,
}

async fn patch_route(
    State(state): State<AppState>,
    UrlPath((workspace, slug, collection, id)): UrlPath<(String, String, String, String)>,
    Json(body): Json<PatchBody>,
) -> Result<Response> {
    let scope = Scope::of(&find(&state, &workspace, &slug).await?, &collection)?;
    let write = Write::Merge(object(body.patch, "patch")?);
    let (target, at) = (scope.clone(), now());
    let record = match run(&state, move |c| update(c, &target, &id, &write, body.rev, &at)).await? {
        Ok(record) => record,
        Err(refusal) => return Ok(refusal),
    };
    announce(&state, &scope, "update", Some(&record.id), Some(&record));
    Ok(fresh(record))
}

#[derive(Deserialize)]
struct RevQuery {
    rev: Option<i64>,
}

async fn delete_route(
    State(state): State<AppState>,
    UrlPath((workspace, slug, collection, id)): UrlPath<(String, String, String, String)>,
    Query(query): Query<RevQuery>,
) -> Result<Response> {
    let scope = Scope::of(&find(&state, &workspace, &slug).await?, &collection)?;
    let (target, wanted) = (scope.clone(), id.clone());
    let removed = match run(&state, move |c| remove(c, &target, &wanted, query.rev)).await? {
        Ok(removed) => removed,
        Err(refusal) => return Ok(refusal),
    };
    if removed.is_some() {
        announce(&state, &scope, "remove", Some(&id), None);
    }
    Ok(fresh(json!({ "removed": removed.is_some() })))
}
