//! A collection out of Tendly and back in: JSON, which keeps everything, and
//! CSV, for a spreadsheet.
//!
//! JSON export: `{ app, collection, exported_at, records: [{ id, rev,
//! created_at, updated_at, data }] }`. JSON import takes that, or a bare list.
//! An item with a `data` object is a record as exported (its `id` and
//! `created_at` are kept); any other object is the data of a new record.
//!
//! CSV is for flat records: one column per top-level field, after `id`. A
//! value that is itself a list or an object is written as JSON text in its
//! cell. Reading a CSV back guesses each column's type from all of its cells
//! (numbers only when every cell is a plain number, so a column of phone
//! numbers with a leading zero stays text), which makes CSV the convenient
//! format and JSON the faithful one.
use super::{Failure, Incoming, MAX_IMPORT_BYTES, Record, Scope, all, announce, import, now};
use crate::{ApiError, AppState, Result, hub::apps::find, hub::cs};
use axum::{
    Json,
    body::Bytes,
    extract::{Path as UrlPath, Query, State},
    http::{HeaderValue, header},
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use serde_json::{Map, Value, json};

// ---------------------------------------------------------------------------
// JSON

/// The fields of a record as it was exported; an object with only these (and a `data` object) is read as one.
const ENVELOPE: &[&str] = &["id", "rev", "created_at", "updated_at", "data"];

fn incoming(item: Value, index: usize) -> std::result::Result<Incoming, String> {
    let Value::Object(mut map) = item else {
        return Err(format!("Record {}: each record must be a JSON object", index + 1));
    };
    let exported = matches!(map.get("data"), Some(Value::Object(_))) && map.keys().all(|key| ENVELOPE.contains(&key.as_str()));
    if !exported {
        return Ok(Incoming { id: None, created_at: None, data: map });
    }
    let id = match map.get("id") {
        None | Some(Value::Null) => None,
        Some(Value::String(id)) => Some(id.clone()),
        Some(_) => return Err(format!("Record {}: id must be a text", index + 1)),
    };
    // Kept when it is a time; anything else means "now".
    let created_at = map
        .get("created_at")
        .and_then(Value::as_str)
        .filter(|text| chrono::DateTime::parse_from_rfc3339(text).is_ok())
        .map(str::to_owned);
    let Some(Value::Object(data)) = map.remove("data") else { unreachable!("checked above") };
    Ok(Incoming { id, created_at, data })
}

/// The records of a JSON file: `{ "records": [...] }` or `[...]`.
pub(crate) fn read_json(bytes: &[u8]) -> std::result::Result<Vec<Incoming>, String> {
    let value: Value = serde_json::from_slice(bytes).map_err(|error| format!("The file is not valid JSON: {error}"))?;
    let items = match value {
        Value::Array(items) => items,
        Value::Object(mut map) => match map.remove("records") {
            Some(Value::Array(items)) => items,
            _ => return Err("The file must be a list of records, or an object with a \"records\" list".into()),
        },
        _ => return Err("The file must be a list of records, or an object with a \"records\" list".into()),
    };
    items.into_iter().enumerate().map(|(index, item)| incoming(item, index)).collect()
}

pub(crate) fn write_json(scope: &Scope, records: &[Record], at: &str) -> String {
    serde_json::to_string_pretty(&json!({
        "app": scope.slug,
        "collection": scope.collection,
        "exported_at": at,
        "records": records,
    }))
    .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// CSV

/// The column of the record's own id.
const ID_COLUMN: &str = "id";
/// In front of a field whose name would be taken for something else (`id`, or one that starts like this).
const FIELD_PREFIX: &str = "data.";

fn column_of(field: &str) -> String {
    if field == ID_COLUMN || field.starts_with(FIELD_PREFIX) { format!("{FIELD_PREFIX}{field}") } else { field.to_owned() }
}

fn field_of(column: &str) -> &str {
    column.strip_prefix(FIELD_PREFIX).unwrap_or(column)
}

fn cell(text: &str) -> String {
    let quoted = text.contains([',', ';', '"', '\n', '\r', '\t']) || text.starts_with(' ') || text.ends_with(' ');
    if quoted { format!("\"{}\"", text.replace('"', "\"\"")) } else { text.to_owned() }
}

fn shown(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Bool(flag)) => flag.to_string(),
        Some(Value::Number(number)) => number.to_string(),
        Some(nested) => nested.to_string(),
    }
}

/// `id` and then one column per top-level field, in the order the fields first appear.
pub(crate) fn write_csv(records: &[Record]) -> String {
    let mut fields: Vec<&str> = Vec::new();
    for record in records {
        for field in record.data.as_object().into_iter().flat_map(|map| map.keys()) {
            if !fields.contains(&field.as_str()) {
                fields.push(field);
            }
        }
    }
    // A byte-order mark, so a spreadsheet reads the accents right.
    let mut out = String::from("\u{feff}");
    let header: Vec<String> = std::iter::once(ID_COLUMN.to_owned()).chain(fields.iter().map(|field| cell(&column_of(field)))).collect();
    out.push_str(&header.join(","));
    out.push_str("\r\n");
    for record in records {
        let row: Vec<String> = std::iter::once(cell(&record.id))
            .chain(fields.iter().map(|field| cell(&shown(record.data.get(*field)))))
            .collect();
        out.push_str(&row.join(","));
        out.push_str("\r\n");
    }
    out
}

/// The separator of a CSV, told from its first line: a comma, or the semicolon or tab some spreadsheets write.
fn separator(text: &str) -> char {
    let (mut quoted, mut counts) = (false, [0usize; 3]);
    for c in text.chars() {
        match c {
            '"' => quoted = !quoted,
            '\n' | '\r' if !quoted => break,
            ',' if !quoted => counts[0] += 1,
            ';' if !quoted => counts[1] += 1,
            '\t' if !quoted => counts[2] += 1,
            _ => {}
        }
    }
    if counts[1] > counts[0] && counts[1] >= counts[2] {
        ';'
    } else if counts[2] > counts[0] {
        '\t'
    } else {
        ','
    }
}

/// The rows of a CSV: quoted cells may hold the separator, line breaks and `""` for a quote. Empty lines are skipped.
pub(crate) fn parse_csv(text: &str) -> std::result::Result<Vec<Vec<String>>, String> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let by = separator(text);
    let (mut rows, mut row, mut field) = (Vec::new(), Vec::new(), String::new());
    // `quoted`: inside quotes. `closed`: the cell was quoted, so it is kept even when empty.
    let (mut quoted, mut closed) = (false, false);
    let mut chars = text.chars().peekable();
    let mut end_row = |row: &mut Vec<String>, field: &mut String, closed: &mut bool| {
        row.push(std::mem::take(field));
        if !(row.len() == 1 && row[0].is_empty() && !*closed) {
            rows.push(std::mem::take(row));
        }
        row.clear();
        *closed = false;
    };
    while let Some(c) = chars.next() {
        if quoted {
            match c {
                '"' if chars.peek() == Some(&'"') => {
                    chars.next();
                    field.push('"');
                }
                '"' => quoted = false,
                other => field.push(other),
            }
            continue;
        }
        match c {
            '"' if field.is_empty() && !closed => {
                quoted = true;
                closed = true;
            }
            c if c == by => {
                row.push(std::mem::take(&mut field));
                closed = false;
            }
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                end_row(&mut row, &mut field, &mut closed);
            }
            '\n' => end_row(&mut row, &mut field, &mut closed),
            other => field.push(other),
        }
    }
    if quoted {
        return Err("The CSV ends inside a quoted cell".into());
    }
    if !field.is_empty() || !row.is_empty() || closed {
        end_row(&mut row, &mut field, &mut closed);
    }
    Ok(rows)
}

/// A number written the plain way: digits, an optional leading minus, an
/// optional decimal part. No leading zero, no exponent, and short enough to be exact.
fn plain_number(text: &str) -> bool {
    let digits = text.strip_prefix('-').unwrap_or(text);
    let (whole, decimal) = digits.split_once('.').unwrap_or((digits, "0"));
    text.len() <= 15
        && !whole.is_empty()
        && !decimal.is_empty()
        && whole.bytes().all(|b| b.is_ascii_digit())
        && decimal.bytes().all(|b| b.is_ascii_digit())
        && (whole == "0" || !whole.starts_with('0'))
}

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Number,
    Bool,
    Text,
}

fn typed(text: &str, kind: Kind) -> Value {
    match kind {
        Kind::Number => text
            .parse::<i64>()
            .map(Value::from)
            .or_else(|_| text.parse::<f64>().map(Value::from))
            .unwrap_or_else(|_| Value::String(text.to_owned())),
        Kind::Bool => Value::Bool(text.eq_ignore_ascii_case("true")),
        Kind::Text => {
            // A list or an object that was written as JSON text comes back as what it was.
            if text.starts_with(['{', '['])
                && let Ok(nested @ (Value::Object(_) | Value::Array(_))) = serde_json::from_str::<Value>(text)
            {
                return nested;
            }
            Value::String(text.to_owned())
        }
    }
}

/// The records of a CSV with a header row. An `id` column names the records;
/// an empty cell is a field the record does not have.
pub(crate) fn read_csv(bytes: &[u8]) -> std::result::Result<Vec<Incoming>, String> {
    let text = std::str::from_utf8(bytes).map_err(|_| "The CSV must be UTF-8 text".to_owned())?;
    let mut rows = parse_csv(text)?.into_iter();
    let Some(header) = rows.next() else { return Err("The CSV is empty".into()) };
    let header: Vec<String> = header.iter().map(|name| name.trim().to_owned()).collect();
    for (index, name) in header.iter().enumerate() {
        if name.is_empty() {
            return Err(format!("Column {} has no name in the header row", index + 1));
        }
        if header[..index].contains(name) {
            return Err(format!("The column {name:?} appears twice in the header row"));
        }
    }
    let rows: Vec<Vec<String>> = rows.collect();
    for (index, row) in rows.iter().enumerate() {
        if row.len() > header.len() {
            return Err(format!("Row {} has more cells than the header row", index + 2));
        }
    }
    let kinds: Vec<Kind> = (0..header.len())
        .map(|column| {
            let mut cells = rows.iter().filter_map(|row| row.get(column)).map(|cell| cell.trim()).filter(|cell| !cell.is_empty()).peekable();
            if cells.peek().is_none() {
                Kind::Text
            } else if cells.clone().all(plain_number) {
                Kind::Number
            } else if cells.all(|cell| cell.eq_ignore_ascii_case("true") || cell.eq_ignore_ascii_case("false")) {
                Kind::Bool
            } else {
                Kind::Text
            }
        })
        .collect();
    let mut records = Vec::with_capacity(rows.len());
    for row in &rows {
        let (mut id, mut data) = (None, Map::new());
        for (column, text) in row.iter().enumerate() {
            if header[column] == ID_COLUMN {
                id = Some(text.trim().to_owned()).filter(|id| !id.is_empty());
            } else if !text.trim().is_empty() {
                let value = match kinds[column] {
                    Kind::Text => typed(text, Kind::Text),
                    kind => typed(text.trim(), kind),
                };
                data.insert(field_of(&header[column]).to_owned(), value);
            }
        }
        records.push(Incoming { id, created_at: None, data });
    }
    Ok(records)
}

// ---------------------------------------------------------------------------
// Routes

#[derive(Clone, Copy, PartialEq, Eq)]
enum Format {
    Json,
    Csv,
}

fn format_of(name: Option<&str>) -> Result<Format> {
    match name.map(str::trim) {
        None | Some("" | "json") => Ok(Format::Json),
        Some("csv") => Ok(Format::Csv),
        Some(_) => Err(ApiError::bad("format must be json or csv")),
    }
}

#[derive(Deserialize)]
pub(super) struct ExportQuery {
    format: Option<String>,
}

pub(super) async fn export_route(
    State(state): State<AppState>,
    UrlPath((workspace, slug, collection)): UrlPath<(String, String, String)>,
    Query(query): Query<ExportQuery>,
) -> Result<Response> {
    let scope = Scope::of(&find(&state, &workspace, &slug).await?, &collection)?;
    let format = format_of(query.format.as_deref())?;
    let target = scope.clone();
    let records = cs(&state, move |c| all(c, &target)).await?.map_err(|failure| failure.api())?;
    let (body, kind, extension) = match format {
        Format::Json => (write_json(&scope, &records, &now()), "application/json; charset=utf-8", "json"),
        Format::Csv => (write_csv(&records), "text/csv; charset=utf-8", "csv"),
    };
    // Slugs and collection names are plain ASCII, so the file name needs no quoting rules.
    let disposition = format!("attachment; filename=\"{}-{}.{extension}\"", scope.slug, scope.collection);
    Ok((
        [
            (header::CONTENT_TYPE, HeaderValue::from_static(kind)),
            (header::CACHE_CONTROL, HeaderValue::from_static("no-store")),
            (header::CONTENT_DISPOSITION, HeaderValue::from_str(&disposition).map_err(ApiError::internal)?),
        ],
        body,
    )
        .into_response())
}

#[derive(Deserialize)]
pub(super) struct ImportQuery {
    format: Option<String>,
    /// `merge` (the default): records whose id exists are replaced, the rest added. `replace`: the collection is emptied first.
    mode: Option<String>,
}

pub(super) async fn import_route(
    State(state): State<AppState>,
    UrlPath((workspace, slug, collection)): UrlPath<(String, String, String)>,
    Query(query): Query<ImportQuery>,
    body: Bytes,
) -> Result<Response> {
    let scope = Scope::of(&find(&state, &workspace, &slug).await?, &collection)?;
    let format = format_of(query.format.as_deref())?;
    let replace = match query.mode.as_deref().map(str::trim) {
        None | Some("" | "merge") => false,
        Some("replace") => true,
        Some(_) => return Err(ApiError::bad("mode must be merge or replace")),
    };
    if body.len() > MAX_IMPORT_BYTES {
        return Err(ApiError { status: axum::http::StatusCode::PAYLOAD_TOO_LARGE, message: "A file to import can be at most 50 MB".into() });
    }
    let records = tokio::task::spawn_blocking(move || match format {
        Format::Json => read_json(&body),
        Format::Csv => read_csv(&body),
    })
    .await
    .map_err(ApiError::internal)?
    .map_err(ApiError::bad)?;
    let (target, at) = (scope.clone(), now());
    let done = match cs(&state, move |c| import(c, &target, &records, replace, &at)).await? {
        Ok(done) => done,
        Err(failure @ Failure::Full(_)) => return Err(failure.api()),
        Err(failure) => return Err(ApiError::bad(failure.message())),
    };
    if done.inserted + done.updated + done.removed > 0 {
        // Many records at once: whoever listens reads the collection again.
        announce(&state, &scope, "reset", None, None);
    }
    Ok(Json(done).into_response())
}
