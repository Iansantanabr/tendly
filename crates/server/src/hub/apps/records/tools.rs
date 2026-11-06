//! What an agent gets of an app's collections: the `tendly_app_records_*`
//! tools of Tendly's MCP server (`agent.rs` lists and dispatches them).
//!
//! Each call names one app, by its folder under `apps/`, and works on that
//! app's records only: read them, write one, delete one. An agent uses them to
//! work *with* an app ("read the leads, write a suggested reply into the
//! record"); to change the app itself it edits the app's files. Writes are told
//! to the open windows like any other, so the app on screen shows them at once.
//!
//! Nothing here needs the person's confirmation: a record is the app's own
//! data, the same an agent could already reach by editing the app.
use super::{
    Failure, Filter, Scope, Write, announce, collections, fetch, insert, list_within, now, parse_order, parse_where, put, remove,
};
use crate::{
    ApiError, AppState, Result,
    agent::{Caller, text, tool},
    app::db,
    hub::{
        apps::{Found, find, scan, valid_key, valid_slug},
        cs,
    },
};
use serde_json::{Map, Value, json};

const DEFAULT_LIMIT: usize = 50;
const MAX_LIMIT: usize = 200;
/// The record data one answer carries: a model reads every byte of it.
const MAX_ANSWER_BYTES: usize = 256 * 1024;

fn schema(mut properties: Value, required: &[&str]) -> Value {
    properties["app"] = json!({ "type": "string", "description": "The app's folder name under apps/ (its slug), for example \"crm\"." });
    properties["workspace_id"] = json!({ "type": "string", "description": "The workspace the app lives in. Leave it out for an app of your own workspace, or when only one workspace has an app with that name." });
    let mut all = vec!["app"];
    all.extend_from_slice(required);
    json!({ "type": "object", "properties": properties, "required": all, "additionalProperties": false })
}

pub(crate) fn tools() -> Vec<Value> {
    let collection = json!({ "type": "string", "description": "The collection's name, as the app's code calls it in tendly.db.collection(name)." });
    vec![
        tool(
            "tendly_app_records_list",
            "Read the records a Tendly app keeps in a collection (its tendly.db data). Without `collection`, lists the app's collections with how many records each holds. Each record is { id, rev, created_at, updated_at, data }.",
            schema(
                json!({
                    "collection": collection,
                    "where": { "type": "object", "description": "Only records whose top-level fields equal these values: { \"stage\": \"new\" }, or one of several: { \"stage\": { \"in\": [\"new\", \"waiting\"] } }. Values are text, numbers, true, false or null." },
                    "order": { "type": "string", "description": "created_at (default), updated_at or a field name; put - in front for descending." },
                    "limit": { "type": "integer", "minimum": 1, "maximum": MAX_LIMIT, "description": "Default 50." },
                    "offset": { "type": "integer", "minimum": 0 }
                }),
                &[],
            ),
        ),
        tool(
            "tendly_app_records_get",
            "Read one record of a Tendly app's collection by its id.",
            schema(json!({ "collection": collection, "id": { "type": "string" } }), &["collection", "id"]),
        ),
        tool(
            "tendly_app_records_upsert",
            "Create or change one record of a Tendly app's collection. Without `id` a new record is created. With `id`, that record is replaced by `data` (or created with that id); with `merge: true` only the top-level fields in `data` change and the others stay. Pass the `rev` you read to refuse the write if the record changed meanwhile. The app on screen shows the change at once.",
            schema(
                json!({
                    "collection": collection,
                    "id": { "type": "string", "description": "Letters, digits, _ and -, up to 64." },
                    "data": { "type": "object", "description": "The record's fields (a JSON object, up to 5 MB)." },
                    "merge": { "type": "boolean", "description": "Only with id: keep the fields not named in data. Default false." },
                    "rev": { "type": "integer", "description": "Only with id: the revision you read." }
                }),
                &["collection", "data"],
            ),
        ),
        tool(
            "tendly_app_records_delete",
            "Delete one record of a Tendly app's collection. This cannot be undone. Pass the `rev` you read to refuse it if the record changed meanwhile.",
            schema(json!({ "collection": collection, "id": { "type": "string" }, "rev": { "type": "integer" } }), &["collection", "id"]),
        ),
    ]
}

/// The app a call names: in the workspace it gives, else in the caller's own, else the only one with that name.
async fn app_of(state: &AppState, caller: Caller, arguments: &Value) -> Result<Found> {
    let slug = text(arguments, "app").ok_or_else(|| ApiError::bad("app is required: the app's folder name under apps/"))?;
    if !valid_slug(slug) {
        return Err(ApiError::bad(format!("{slug:?} is not an app's folder name")));
    }
    if let Some(workspace) = text(arguments, "workspace_id") {
        return find(state, workspace, slug)
            .await
            .map_err(|_| ApiError { status: axum::http::StatusCode::NOT_FOUND, message: format!("There is no app \"{slug}\" in workspace {workspace}") });
    }
    if let Caller::Session(id) = caller
        && let Some(session) = db(state, move |store| store.get_session(id)).await?
        && let Ok(found) = find(state, &session.workspace_id.to_string(), slug).await
    {
        return Ok(found);
    }
    let workspaces = db(state, |store| store.list_workspaces()).await?;
    let (apps, _) = tokio::task::spawn_blocking(move || scan(&workspaces)).await.map_err(ApiError::internal)?;
    let named: Vec<_> = apps.iter().filter(|app| app.slug == slug).collect();
    match named.as_slice() {
        [only] => find(state, &only.workspace_id, slug).await,
        [] => {
            let known: Vec<String> = apps.iter().map(|app| format!("{} ({})", app.slug, app.workspace_name)).collect();
            Err(ApiError {
                status: axum::http::StatusCode::NOT_FOUND,
                message: if known.is_empty() {
                    format!("There is no app \"{slug}\": no workspace has an apps/ folder with a valid app")
                } else {
                    format!("There is no app \"{slug}\". The apps are: {}", known.join(", "))
                },
            })
        }
        several => Err(ApiError::bad(format!(
            "More than one workspace has an app \"{slug}\". Pass workspace_id: {}",
            several.iter().map(|app| format!("{} ({})", app.workspace_id, app.workspace_name)).collect::<Vec<_>>().join(", ")
        ))),
    }
}

fn scope_of(found: &Found, arguments: &Value) -> Result<Scope> {
    let collection = text(arguments, "collection").ok_or_else(|| ApiError::bad("collection is required"))?;
    Scope::of(found, collection)
}

fn id_of(arguments: &Value) -> Result<String> {
    let id = text(arguments, "id").ok_or_else(|| ApiError::bad("id is required"))?;
    if !valid_key(id) {
        return Err(ApiError::bad("Record ids are letters, digits, _ and -, up to 64 characters"));
    }
    Ok(id.to_owned())
}

fn whole(arguments: &Value, key: &str) -> Result<Option<i64>> {
    match arguments.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value.as_i64().map(Some).ok_or_else(|| ApiError::bad(format!("{key} must be a whole number"))),
    }
}

/// A refusal as an agent reads it: with the record as it is now, so it can decide and repeat.
fn refused(failure: Failure) -> ApiError {
    let mut error = failure.api();
    if let Failure::Conflict(current) | Failure::Exists(current) = &failure {
        error.message = format!("{} Current record: {}", error.message, serde_json::to_string(current).unwrap_or_default());
    }
    error
}

pub(crate) async fn call(state: &AppState, caller: Caller, name: &str, arguments: &Value) -> Result<Value> {
    let found = app_of(state, caller, arguments).await?;
    let app = json!({ "slug": found.slug, "name": found.app.manifest.name, "workspace_id": found.workspace.id });
    match name {
        "tendly_app_records_list" => {
            if text(arguments, "collection").is_none() {
                let (workspace, slug) = (found.workspace.id.to_string(), found.slug.clone());
                let listed = cs(state, move |c| collections(c, &workspace, &slug)).await?;
                return Ok(json!({ "app": app, "collections": listed }));
            }
            let scope = scope_of(&found, arguments)?;
            let limit = whole(arguments, "limit")?.unwrap_or(DEFAULT_LIMIT as i64).clamp(1, MAX_LIMIT as i64) as usize;
            let offset = whole(arguments, "offset")?.unwrap_or(0).max(0) as usize;
            let filter = Filter {
                conditions: parse_where(arguments.get("where")).map_err(ApiError::bad)?,
                order: parse_order(arguments.get("order")).map_err(ApiError::bad)?,
                limit: Some(limit),
                offset,
            };
            let collection = scope.collection.clone();
            let page = cs(state, move |c| list_within(c, &scope, &filter, MAX_ANSWER_BYTES)).await?;
            let next = offset + page.records.len();
            let mut answer = json!({ "app": app, "collection": collection, "total": page.total, "returned": page.records.len(), "records": page.records });
            if (next as i64) < page.total {
                answer["next_offset"] = json!(next);
            }
            Ok(answer)
        }
        "tendly_app_records_get" => {
            let (scope, id) = (scope_of(&found, arguments)?, id_of(arguments)?);
            let record = cs(state, move |c| fetch(c, &scope, &id)).await?.ok_or_else(|| ApiError::missing("Record"))?;
            Ok(json!({ "app": app, "record": record }))
        }
        "tendly_app_records_upsert" => {
            let scope = scope_of(&found, arguments)?;
            let Some(Value::Object(data)) = arguments.get("data") else {
                return Err(ApiError::bad("data is required: the record's fields, as a JSON object"));
            };
            let data: Map<String, Value> = data.clone();
            let rev = whole(arguments, "rev")?;
            let merge = arguments.get("merge").and_then(Value::as_bool).unwrap_or(false);
            let (target, at) = (scope.clone(), now());
            let (record, created) = if text(arguments, "id").is_some() {
                let id = id_of(arguments)?;
                let write = if merge { Write::Merge(data) } else { Write::Replace(data) };
                cs(state, move |c| put(c, &target, &id, &write, rev, &at)).await?.map_err(refused)?
            } else {
                if rev.is_some() || merge {
                    return Err(ApiError::bad("rev and merge need the id of the record to change"));
                }
                (cs(state, move |c| insert(c, &target, None, &data, &at)).await?.map_err(refused)?, true)
            };
            announce(state, &scope, if created { "insert" } else { "update" }, Some(&record.id), Some(&record));
            let mut answer = json!({ "app": app });
            answer[if created { "created" } else { "updated" }] = json!(record);
            Ok(answer)
        }
        "tendly_app_records_delete" => {
            let (scope, id) = (scope_of(&found, arguments)?, id_of(arguments)?);
            let rev = whole(arguments, "rev")?;
            let (target, wanted) = (scope.clone(), id.clone());
            let removed = cs(state, move |c| remove(c, &target, &wanted, rev)).await?.map_err(refused)?;
            if removed.is_some() {
                announce(state, &scope, "remove", Some(&id), None);
            }
            Ok(json!({ "app": app, "deleted": removed.is_some() }))
        }
        other => Err(ApiError::bad(format!("Unknown Tendly tool {other:?}"))),
    }
}
