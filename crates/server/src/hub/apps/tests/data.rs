//! Apps, stage D: collections with revisions (`records.rs`), what the open
//! windows hear of them, JSON and CSV in and out (`records/transfer.rs`), the
//! files a person uploads (`uploads.rs`), and the agent's tools
//! (`records/tools.rs`). Through the real router and its guard where a route
//! is what is being tested.
use super::*;
use crate::hub::apps::{records, uploads};
use records::{Failure, Filter, Scope, Write, transfer};
use serde_json::Map;

const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR-not-a-real-image";
const PDF: &[u8] = b"%PDF-1.7\n1 0 obj\n<<>>\nendobj\n";

impl Fixture {
    fn app(&self, slug: &str) {
        self.write(&format!("apps/{slug}/app.json"), r#"{"name":"CRM"}"#);
        self.write(&format!("apps/{slug}/index.html"), "ok");
    }
    fn db(&self, slug: &str, rest: &str) -> String {
        format!("{}/db{rest}", self.base(slug))
    }
    async fn post(&self, path: &str, body: Value) -> Reply {
        self.send("POST", path, body.to_string(), true).await
    }
    async fn patch(&self, path: &str, body: Value) -> Reply {
        self.send("PATCH", path, body.to_string(), true).await
    }
    async fn delete(&self, path: &str) -> Reply {
        self.send("DELETE", path, axum::body::Body::empty(), true).await
    }
    async fn insert(&self, slug: &str, collection: &str, data: Value) -> Value {
        let reply = self.post(&self.db(slug, &format!("/{collection}")), json!({ "data": data })).await;
        assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.text());
        reply.json()
    }
    async fn query(&self, slug: &str, collection: &str, body: Value) -> Reply {
        self.post(&self.db(slug, &format!("/{collection}/query")), body).await
    }
    /// The names of the records a query finds, in the order it gives them.
    async fn names(&self, body: Value) -> Vec<String> {
        let reply = self.query("crm", "leads", body.clone()).await;
        assert_eq!(reply.status, StatusCode::OK, "{body}: {}", reply.text());
        reply.json()["records"].as_array().unwrap().iter().map(|r| r["data"]["name"].as_str().unwrap_or("?").to_owned()).collect()
    }
    fn scope(&self, slug: &str, collection: &str) -> Scope {
        Scope { workspace: self.workspace.clone(), slug: slug.into(), collection: collection.into() }
    }
    /// An agent's tool call, as `tendly mcp` relays it.
    async fn tool(&self, name: &str, arguments: Value) -> (bool, Value, String) {
        let reply = self.post("/api/agent/call", json!({ "name": name, "arguments": arguments })).await;
        assert_eq!(reply.status, StatusCode::OK, "{}", reply.text());
        let body = reply.json();
        let text = body["content"][0]["text"].as_str().unwrap_or_default().to_owned();
        (body["isError"] == json!(false), serde_json::from_str(&text).unwrap_or(Value::Null), text)
    }
}

fn fields(value: Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap()
}

// ---------------------------------------------------------------------------
// Records

#[tokio::test]
async fn hub_apps_records_round_trip_and_every_write_is_a_revision() {
    let f = fixture();
    f.app("crm");
    let leads = f.db("crm", "/leads");

    // Nothing yet.
    assert_eq!(f.get(&f.db("crm", "")).await.json(), json!({ "collections": [] }));
    let empty = f.get(&leads).await;
    assert_eq!(empty.status, StatusCode::OK);
    assert_eq!(empty.json(), json!({ "records": [], "total": 0, "truncated": false }));

    let created = f.insert("crm", "leads", json!({ "name": "Ana", "stage": "new", "tags": ["vip"] })).await;
    let id = created["id"].as_str().unwrap().to_owned();
    assert_eq!(id.len(), 36, "an id is made when none is given");
    assert_eq!(created["rev"], 1);
    assert_eq!(created["created_at"], created["updated_at"]);
    assert_eq!(created["data"], json!({ "name": "Ana", "stage": "new", "tags": ["vip"] }));

    let one = format!("{leads}/r/{id}");
    let read = f.get(&one).await;
    assert_eq!(read.status, StatusCode::OK);
    assert_eq!(read.header("cache-control"), "no-store");
    assert_eq!(read.json(), created);

    // A patch changes the top-level fields it names and keeps the rest.
    let patched = f.patch(&one, json!({ "patch": { "stage": "won", "value": 1200 } })).await;
    assert_eq!(patched.status, StatusCode::OK, "{}", patched.text());
    let patched = patched.json();
    assert_eq!(patched["rev"], 2);
    assert_eq!(patched["created_at"], created["created_at"]);
    assert_eq!(patched["data"], json!({ "name": "Ana", "stage": "won", "tags": ["vip"], "value": 1200 }));

    // A put replaces the record whole, and creates the one that is not there under the id given.
    let replaced = f.send("PUT", &one, json!({ "data": { "name": "Ana Lima" } }).to_string(), true).await;
    assert_eq!(replaced.status, StatusCode::OK);
    assert_eq!(replaced.json()["rev"], 3);
    assert_eq!(replaced.json()["data"], json!({ "name": "Ana Lima" }));
    let made = f.send("PUT", &format!("{leads}/r/bia"), json!({ "data": { "name": "Bia" } }).to_string(), true).await;
    assert_eq!(made.status, StatusCode::CREATED);
    assert_eq!((made.json()["id"].as_str(), made.json()["rev"].as_i64()), (Some("bia"), Some(1)));

    // An id of the app's own choosing, once.
    let named = f.post(&leads, json!({ "id": "caio", "data": { "name": "Caio" } })).await;
    assert_eq!(named.status, StatusCode::CREATED);
    let again = f.post(&leads, json!({ "id": "caio", "data": { "name": "Other" } })).await;
    assert_eq!(again.status, StatusCode::CONFLICT);
    assert_eq!(again.json()["code"], "exists");
    assert_eq!(again.json()["current"]["data"]["name"], "Caio", "the record that is there comes back");

    let listed = f.get(&leads).await.json();
    assert_eq!(listed["total"], 3);
    let names: Vec<&str> = listed["records"].as_array().unwrap().iter().map(|r| r["data"]["name"].as_str().unwrap()).collect();
    assert_eq!(names, ["Ana Lima", "Bia", "Caio"], "oldest first");
    let collections = f.get(&f.db("crm", "")).await.json();
    assert_eq!(collections["collections"][0]["name"], "leads");
    assert_eq!(collections["collections"][0]["count"], 3);

    // Removing says whether there was something to remove; a record that is gone is not an error.
    assert_eq!(f.delete(&one).await.json(), json!({ "removed": true }));
    assert_eq!(f.delete(&one).await.json(), json!({ "removed": false }));
    assert_eq!(f.get(&one).await.status, StatusCode::NOT_FOUND);
    assert_eq!(f.patch(&one, json!({ "patch": { "a": 1 } })).await.status, StatusCode::NOT_FOUND);

    // Collections belong to one app: another app with the same collection name sees none of it.
    f.app("other");
    assert_eq!(f.get(&f.db("other", "/leads")).await.json()["total"], 0);
    f.insert("other", "leads", json!({ "name": "Elsewhere" })).await;
    assert_eq!(f.get(&leads).await.json()["total"], 2);

    // What is refused: a record that is not an object, names that are not names, writes without the client header, an app that is not there.
    for bad in [json!({ "data": [1, 2] }), json!({ "data": "text" }), json!({}), json!({ "data": {}, "extra": 1 })] {
        assert_eq!(f.post(&leads, bad.clone()).await.status.as_u16() / 100, 4, "{bad}");
    }
    assert_eq!(f.post(&leads, json!({ "id": "a b", "data": {} })).await.status, StatusCode::BAD_REQUEST);
    assert_eq!(f.post(&f.db("crm", "/bad.name"), json!({ "data": {} })).await.status, StatusCode::BAD_REQUEST);
    assert_eq!(f.send("POST", &leads, json!({ "data": {} }).to_string(), false).await.status, StatusCode::FORBIDDEN);
    assert_eq!(f.post(&f.db("nope", "/leads"), json!({ "data": {} })).await.status, StatusCode::NOT_FOUND);
    assert_eq!(f.get(&f.db("nope", "")).await.status, StatusCode::NOT_FOUND);

    // Emptying a collection.
    assert_eq!(f.delete(&leads).await.json(), json!({ "removed": 2 }));
    assert_eq!(f.get(&leads).await.json()["total"], 0);
    assert_eq!(f.get(&f.db("other", "/leads")).await.json()["total"], 1);
}

#[tokio::test]
async fn hub_apps_records_a_stale_revision_is_a_conflict_that_returns_the_current_record() {
    let f = fixture();
    f.app("crm");
    let card = f.insert("crm", "cards", json!({ "title": "Call Ana", "column": "todo", "note": "" })).await;
    let one = f.db("crm", &format!("/cards/r/{}", card["id"].as_str().unwrap()));

    // Two panes hold revision 1. The first one moves the card.
    let first = f.patch(&one, json!({ "patch": { "column": "doing" }, "rev": 1 })).await;
    assert_eq!(first.status, StatusCode::OK);
    assert_eq!(first.json()["rev"], 2);

    // The second one, still on revision 1, is refused and handed the record as it is now.
    let second = f.patch(&one, json!({ "patch": { "note": "she asked for a quote" }, "rev": 1 })).await;
    assert_eq!(second.status, StatusCode::CONFLICT, "{}", second.text());
    let refusal = second.json();
    assert_eq!(refusal["code"], "conflict");
    assert!(refusal["error"].as_str().unwrap().contains("revision 2"), "{refusal}");
    assert_eq!(refusal["current"]["rev"], 2);
    assert_eq!(refusal["current"]["data"], json!({ "title": "Call Ana", "column": "doing", "note": "" }));
    // Nothing was written by the refused change.
    assert_eq!(f.get(&one).await.json()["data"]["note"], "");

    // It repeats its change on what it was handed: both changes are there, nothing was lost.
    let retried = f.patch(&one, json!({ "patch": { "note": "she asked for a quote" }, "rev": refusal["current"]["rev"] })).await;
    assert_eq!(retried.status, StatusCode::OK);
    assert_eq!(retried.json()["rev"], 3);
    assert_eq!(retried.json()["data"], json!({ "title": "Call Ana", "column": "doing", "note": "she asked for a quote" }));

    // The same for a replace and for a removal.
    let replace = f.send("PUT", &one, json!({ "data": { "title": "x" }, "rev": 2 }).to_string(), true).await;
    assert_eq!(replace.status, StatusCode::CONFLICT);
    assert_eq!(replace.json()["current"]["rev"], 3);
    let removal = f.delete(&format!("{one}?rev=1")).await;
    assert_eq!(removal.status, StatusCode::CONFLICT);
    assert_eq!(removal.json()["code"], "conflict");
    assert_eq!(removal.json()["current"]["data"]["note"], "she asked for a quote");
    assert_eq!(f.get(&one).await.status, StatusCode::OK, "still there");

    // Without a revision the last write wins, as with tendly.data.
    assert_eq!(f.patch(&one, json!({ "patch": { "column": "done" } })).await.json()["rev"], 4);
    // With the right one the removal goes through; a revision for a record that is gone finds nothing.
    assert_eq!(f.delete(&format!("{one}?rev=4")).await.json(), json!({ "removed": true }));
    assert_eq!(f.send("PUT", &one, json!({ "data": {}, "rev": 4 }).to_string(), true).await.status, StatusCode::NOT_FOUND);
    assert_eq!(f.delete(&format!("{one}?rev=4")).await.json(), json!({ "removed": false }));
}

#[tokio::test]
async fn hub_apps_records_where_is_a_small_filter_and_never_sql() {
    let f = fixture();
    f.app("crm");
    for (name, stage, value, hot, owner) in [
        ("Ana", "new", json!(100), json!(true), json!("rui")),
        ("Bia", "won", json!(250.5), json!(false), json!("sol")),
        ("Caio", "new", json!(100), json!(false), Value::Null),
        ("Duda", "lost", json!("100"), json!(true), json!("rui")),
    ] {
        f.insert("crm", "leads", json!({ "name": name, "stage": stage, "value": value, "hot": hot, "owner": owner })).await;
    }
    // One more without most fields: a field that is not there counts as null.
    f.insert("crm", "leads", json!({ "name": "Eva" })).await;

    assert_eq!(f.names(json!({})).await, ["Ana", "Bia", "Caio", "Duda", "Eva"]);
    assert_eq!(f.names(json!({ "where": { "stage": "new" } })).await, ["Ana", "Caio"]);
    assert_eq!(f.names(json!({ "where": { "stage": "new", "hot": true } })).await, ["Ana"], "every field must match");
    // Types are told apart: the number 100 is not the text "100", and true is not 1.
    assert_eq!(f.names(json!({ "where": { "value": 100 } })).await, ["Ana", "Caio"]);
    assert_eq!(f.names(json!({ "where": { "value": "100" } })).await, ["Duda"]);
    assert_eq!(f.names(json!({ "where": { "value": 250.5 } })).await, ["Bia"]);
    assert_eq!(f.names(json!({ "where": { "hot": false } })).await, ["Bia", "Caio"]);
    assert_eq!(f.names(json!({ "where": { "hot": 1 } })).await, Vec::<String>::new());
    assert_eq!(f.names(json!({ "where": { "owner": null } })).await, ["Caio", "Eva"]);
    assert_eq!(f.names(json!({ "where": { "stage": { "in": ["won", "lost"] } } })).await, ["Bia", "Duda"]);
    assert_eq!(f.names(json!({ "where": { "owner": { "in": ["sol", null] } } })).await, ["Bia", "Caio", "Eva"]);
    assert_eq!(f.names(json!({ "where": { "stage": { "in": [] } } })).await, Vec::<String>::new());

    // Order, limit and offset; `total` is how many match, whatever the page.
    assert_eq!(f.names(json!({ "order": "-name" })).await, ["Eva", "Duda", "Caio", "Bia", "Ana"]);
    assert_eq!(f.names(json!({ "order": "-created_at", "limit": 2 })).await, ["Eva", "Duda"]);
    assert_eq!(f.names(json!({ "order": "name", "limit": 2, "offset": 3 })).await, ["Duda", "Eva"]);
    let page = f.query("crm", "leads", json!({ "where": { "stage": "new" }, "limit": 1 })).await.json();
    assert_eq!((page["records"].as_array().unwrap().len(), page["total"].as_i64()), (1, Some(2)));
    assert_eq!(f.query("crm", "leads", json!({ "where": { "hot": true }, "count": true })).await.json(), json!({ "total": 2 }));
    // The most recently written first.
    let ana = f.query("crm", "leads", json!({ "where": { "name": "Ana" } })).await.json()["records"][0]["id"].as_str().unwrap().to_owned();
    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    f.patch(&f.db("crm", &format!("/leads/r/{ana}")), json!({ "patch": { "stage": "won" } })).await;
    assert_eq!(f.names(json!({ "order": "-updated_at", "limit": 1 })).await, ["Ana"]);

    // The same filter in the address, for a list read with GET.
    let listed = f.get(&f.db("crm", "/leads?where=%7B%22stage%22%3A%22lost%22%7D&order=-name&limit=5")).await;
    assert_eq!(listed.status, StatusCode::OK, "{}", listed.text());
    assert_eq!(listed.json()["records"][0]["data"]["name"], "Duda");
    assert_eq!(f.get(&f.db("crm", "/leads?where=nope")).await.status, StatusCode::BAD_REQUEST);

    // Text that would be SQL is only text: it is compared, finds nothing, and breaks nothing.
    for attack in ["' OR 1=1 --", "new' OR '1'='1", "\"; DROP TABLE app_records; --", "%", "new\0"] {
        assert_eq!(f.names(json!({ "where": { "stage": attack } })).await, Vec::<String>::new(), "{attack}");
    }
    for field in ["stage') OR 1=1 --", "stage' OR '1'='1", "x; DROP TABLE app_records", "a.b", "$", "naïve", "[0]"] {
        let mut wanted = Map::new();
        wanted.insert(field.to_owned(), json!("new"));
        assert_eq!(f.names(json!({ "where": wanted })).await, Vec::<String>::new(), "{field}");
        let sorted = f.query("crm", "leads", json!({ "order": field })).await;
        assert_eq!(sorted.status, StatusCode::OK, "{field}: {}", sorted.text());
        assert_eq!(sorted.json()["total"], 5, "{field}");
    }
    assert_eq!(f.names(json!({})).await.len(), 5, "the table is still there, with everything in it");

    // What the filter does not do is said, not guessed.
    for bad in [
        json!({ "where": { "stage": { "like": "n%" } } }),
        json!({ "where": { "stage": { "in": ["a"], "not": 1 } } }),
        json!({ "where": { "stage": { "in": "new" } } }),
        json!({ "where": { "stage": ["new"] } }),
        json!({ "where": { "stage": { "in": [["new"]] } } }),
        json!({ "where": "stage = 'new'" }),
        json!({ "where": { "sta\"ge": "new" } }),
        json!({ "where": { "sta\\ge": "new" } }),
        json!({ "where": { "": "new" } }),
        json!({ "where": { "x".repeat(65): "new" } }),
        json!({ "where": { "stage": "x".repeat(1001) } }),
        json!({ "order": 3 }),
        json!({ "order": "na\"me" }),
        json!({ "sql": "select 1" }),
    ] {
        let reply = f.query("crm", "leads", bad.clone()).await;
        assert_eq!(reply.status.as_u16() / 100, 4, "{bad}: {}", reply.text());
    }
    let many: Map<String, Value> = (0..21).map(|n| (format!("f{n}"), json!(1))).collect();
    assert_eq!(f.query("crm", "leads", json!({ "where": many })).await.status, StatusCode::BAD_REQUEST);
    let values: Vec<Value> = (0..101).map(|n| json!(n)).collect();
    assert_eq!(f.query("crm", "leads", json!({ "where": { "value": { "in": values } } })).await.status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn hub_apps_records_are_limited_in_size_and_in_number() {
    let f = fixture();
    f.app("crm");
    let scope = f.scope("crm", "big");

    // 5 MB of JSON per record: the largest that fits, and one byte more.
    let fits = fields(json!({ "t": "a".repeat(records::MAX_RECORD_BYTES - 8) }));
    assert_eq!(serde_json::to_string(&fits).unwrap().len(), records::MAX_RECORD_BYTES);
    let stored = f.state.hub.with(|c| records::insert(c, &scope, Some("max"), &fits, "now")).unwrap();
    assert_eq!(stored.unwrap().rev, 1);
    let over = fields(json!({ "t": "a".repeat(records::MAX_RECORD_BYTES - 7) }));
    let refused = f.state.hub.with(|c| records::insert(c, &scope, None, &over, "now")).unwrap();
    assert_eq!(refused, Err(Failure::TooLarge));
    // Growing a record past the limit is refused too, and leaves it as it was.
    let grown = f.state.hub.with(|c| records::update(c, &scope, "max", &Write::Merge(fields(json!({ "more": "x" }))), None, "now")).unwrap();
    assert_eq!(grown, Err(Failure::TooLarge));
    assert_eq!(f.state.hub.with(|c| records::fetch(c, &scope, "max")).unwrap().unwrap().rev, 1);
    // Through the route the refusal says what the limit is.
    let reply = f.post(&f.db("crm", "/big"), json!({ "data": over })).await;
    assert_eq!(reply.status, StatusCode::PAYLOAD_TOO_LARGE);
    assert!(reply.json()["error"].as_str().unwrap().contains("5 MB"), "{}", reply.text());
    // A list is cut where it would grow past what one answer carries, and says so.
    f.insert("crm", "big", json!({ "t": "small" })).await;
    let page = f.state.hub.with(|c| records::list_within(c, &scope, &Filter::default(), 1024)).unwrap();
    assert_eq!((page.records.len(), page.total, page.truncated), (1, 2, true));

    // 50,000 records per collection.
    let full = f.scope("crm", "full");
    f.state
        .hub
        .with(|c| {
            c.execute(
                "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?4)
                 INSERT INTO app_records(workspace_id, slug, collection, id, data, created_at, updated_at)
                 SELECT ?1, ?2, ?3, 'r' || i, '{}', 'now', 'now' FROM n",
                rusqlite::params![full.workspace, full.slug, full.collection, records::MAX_RECORDS],
            )
        })
        .unwrap();
    let reply = f.post(&f.db("crm", "/full"), json!({ "data": { "one": "more" } })).await;
    assert_eq!(reply.status, StatusCode::PAYLOAD_TOO_LARGE, "{}", reply.text());
    assert_eq!(reply.json()["code"], "full");
    assert!(reply.json()["error"].as_str().unwrap().contains("50000"), "{}", reply.text());
    // Changing and removing what is there still works, and removing makes room.
    assert_eq!(f.patch(&f.db("crm", "/full/r/r1"), json!({ "patch": { "a": 1 } })).await.status, StatusCode::OK);
    assert_eq!(f.delete(&f.db("crm", "/full/r/r2")).await.json(), json!({ "removed": true }));
    assert_eq!(f.post(&f.db("crm", "/full"), json!({ "data": {} })).await.status, StatusCode::CREATED);
    // An import that would overflow writes nothing.
    let import = f.send("POST", &f.db("crm", "/full/import"), json!([{ "a": 1 }, { "a": 2 }]).to_string(), true).await;
    assert_eq!(import.status, StatusCode::PAYLOAD_TOO_LARGE, "{}", import.text());
    assert_eq!(f.state.hub.with(|c| records::count(c, &full, &[])).unwrap(), records::MAX_RECORDS);
    // The default page and the largest page.
    assert_eq!(f.get(&f.db("crm", "/full")).await.json()["records"].as_array().unwrap().len(), records::DEFAULT_LIMIT);
    let page = f.state.hub.with(|c| records::list(c, &full, &Filter { limit: Some(1_000_000), ..Filter::default() })).unwrap();
    assert_eq!(page.records.len(), records::MAX_LIMIT);

    // 100 collections per app.
    f.app("many");
    f.state
        .hub
        .with(|c| {
            for n in 0..records::MAX_COLLECTIONS {
                c.execute(
                    "INSERT INTO app_records(workspace_id, slug, collection, id, data, created_at, updated_at) VALUES (?1, 'many', ?2, 'a', '{}', 'now', 'now')",
                    rusqlite::params![f.workspace, format!("c{n}")],
                )?;
            }
            Ok(())
        })
        .unwrap();
    let reply = f.post(&f.db("many", "/one-more"), json!({ "data": {} })).await;
    assert_eq!(reply.status, StatusCode::PAYLOAD_TOO_LARGE);
    assert!(reply.json()["error"].as_str().unwrap().contains("100 collections"), "{}", reply.text());
    assert_eq!(f.post(&f.db("many", "/c0"), json!({ "data": {} })).await.status, StatusCode::CREATED, "an existing collection still grows");
    let import = f.send("POST", &f.db("many", "/another/import"), json!([{ "a": 1 }]).to_string(), true).await;
    assert_eq!(import.status, StatusCode::PAYLOAD_TOO_LARGE, "{}", import.text());
}

// ---------------------------------------------------------------------------
// Live

/// The next thing the windows are told about an app's records.
async fn heard(receiver: &mut tokio::sync::broadcast::Receiver<Value>) -> Value {
    loop {
        let event = tokio::time::timeout(std::time::Duration::from_secs(5), receiver.recv()).await.expect("in time").unwrap();
        if event["event"] == "app-records" {
            return event;
        }
    }
}

#[tokio::test]
async fn hub_apps_records_two_subscribers_hear_every_write_of_any_pane() {
    let f = fixture();
    f.app("crm");
    // Two windows (or two panes of one): each listens on its own.
    let (mut one, mut two) = (f.state.activity.subscribe(), f.state.activity.subscribe());

    let created = f.insert("crm", "cards", json!({ "title": "Call Ana", "column": "todo" })).await;
    let id = created["id"].as_str().unwrap().to_owned();
    for receiver in [&mut one, &mut two] {
        let event = heard(receiver).await;
        assert_eq!(event["type"], "hub");
        assert_eq!(event["workspace_id"], json!(f.workspace));
        assert_eq!((event["slug"].as_str(), event["collection"].as_str()), (Some("crm"), Some("cards")));
        assert_eq!(event["change"]["op"], "insert");
        assert_eq!(event["change"]["id"], json!(id));
        assert_eq!(event["change"]["rev"], 1);
        assert_eq!(event["change"]["record"], created, "the record goes along, so the other pane needs no read");
        assert_eq!(event["change"]["large"], false);
    }

    let one_card = f.db("crm", &format!("/cards/r/{id}"));
    let moved = f.patch(&one_card, json!({ "patch": { "column": "doing" }, "rev": 1 })).await.json();
    for receiver in [&mut one, &mut two] {
        let event = heard(receiver).await;
        assert_eq!((event["change"]["op"].as_str(), event["change"]["rev"].as_i64()), (Some("update"), Some(2)));
        assert_eq!(event["change"]["record"], moved);
    }

    // A write that was refused is not news.
    assert_eq!(f.patch(&one_card, json!({ "patch": { "column": "done" }, "rev": 1 })).await.status, StatusCode::CONFLICT);
    // A record too large to send along is announced without its data.
    let large = f.insert("crm", "cards", json!({ "title": "x".repeat(300 * 1024) })).await;
    for receiver in [&mut one, &mut two] {
        let event = heard(receiver).await;
        assert_eq!(event["change"]["op"], "insert", "the refused write said nothing");
        assert_eq!(event["change"]["id"], large["id"]);
        assert_eq!((event["change"]["record"].clone(), event["change"]["large"].clone()), (Value::Null, json!(true)));
    }

    assert_eq!(f.delete(&one_card).await.json(), json!({ "removed": true }));
    // Removing what is not there changes nothing, so nothing is said.
    assert_eq!(f.delete(&one_card).await.json(), json!({ "removed": false }));
    // Many records at once (an import, emptying the collection): one "read it again".
    let import = f.send("POST", &f.db("crm", "/cards/import"), json!([{ "title": "A" }, { "title": "B" }]).to_string(), true).await;
    assert_eq!(import.status, StatusCode::OK, "{}", import.text());
    assert_eq!(f.delete(&f.db("crm", "/cards")).await.json(), json!({ "removed": 3 }));
    for receiver in [&mut one, &mut two] {
        let removed = heard(receiver).await;
        assert_eq!((removed["change"]["op"].as_str(), removed["change"]["id"].as_str()), (Some("remove"), Some(id.as_str())));
        assert_eq!(removed["change"]["record"], Value::Null);
        assert_eq!(heard(receiver).await["change"]["op"], "reset");
        assert_eq!(heard(receiver).await["change"]["op"], "reset");
        assert!(receiver.try_recv().is_err(), "nothing else was said");
    }
}

// ---------------------------------------------------------------------------
// Out and back in

#[test]
fn hub_apps_records_csv_reads_quotes_line_breaks_and_other_separators() {
    let rows = transfer::parse_csv("\u{feff}name,note\r\nAna,\"said \"\"hi\"\", then left\"\r\n\r\nBia,\"two\nlines\"\n").unwrap();
    assert_eq!(rows, [vec!["name", "note"], vec!["Ana", "said \"hi\", then left"], vec!["Bia", "two\nlines"]]);
    // A spreadsheet set to Portuguese writes semicolons; a tab-separated file works too.
    assert_eq!(transfer::parse_csv("nome;valor\nAna;1,5\n").unwrap(), [vec!["nome", "valor"], vec!["Ana", "1,5"]]);
    assert_eq!(transfer::parse_csv("a\tb\n1\t2").unwrap(), [vec!["a", "b"], vec!["1", "2"]]);
    // An empty quoted cell is a row; trailing empty cells are kept.
    assert_eq!(transfer::parse_csv("a,b\n\"\"\n1,\n").unwrap(), [vec!["a", "b"], vec![""], vec!["1", ""]]);
    assert!(transfer::parse_csv("a\n\"open").unwrap_err().contains("quoted"));
    assert_eq!(transfer::parse_csv("").unwrap(), Vec::<Vec<String>>::new());
}

#[test]
fn hub_apps_records_csv_guesses_a_type_per_column() {
    let csv = "id,name,value,phone,active,tags,empty,data.id\n\
               ana,Ana,10,011999,true,\"[\"\"vip\"\"]\",,7\n\
               ,Bia,2.5,5511888,FALSE,,,8\n\
               ,\" Caio \",-3,,true,plain,,\n";
    let records = transfer::read_csv(csv.as_bytes()).unwrap();
    assert_eq!(records.len(), 3);
    assert_eq!(records[0].id.as_deref(), Some("ana"));
    assert_eq!(records[1].id, None, "an empty id cell means a new record");
    // `value` is all plain numbers; `phone` has a leading zero, so the whole column stays text.
    assert_eq!(
        Value::Object(records[0].data.clone()),
        json!({ "name": "Ana", "value": 10, "phone": "011999", "active": true, "tags": ["vip"], "id": 7 })
    );
    assert_eq!(Value::Object(records[1].data.clone()), json!({ "name": "Bia", "value": 2.5, "phone": "5511888", "active": false, "id": 8 }));
    // An empty cell is a field the record does not have; text keeps its spaces.
    assert_eq!(Value::Object(records[2].data.clone()), json!({ "name": " Caio ", "value": -3, "active": true, "tags": "plain" }));

    for (bad, needle) in [
        ("", "empty"),
        ("a,,c\n1,2,3\n", "Column 2 has no name"),
        ("a,b,a\n1,2,3\n", "appears twice"),
        ("a,b\n1,2,3\n", "Row 2 has more cells"),
    ] {
        assert!(transfer::read_csv(bad.as_bytes()).unwrap_err().contains(needle), "{bad:?}");
    }
    assert!(transfer::read_csv(&[0xff, 0xfe, 0x00]).unwrap_err().contains("UTF-8"));
}

#[tokio::test]
async fn hub_apps_records_export_and_import_as_json_and_csv() {
    let f = fixture();
    f.app("crm");
    let ana = f.insert("crm", "leads", json!({ "name": "Ana, \"the first\"", "value": 10, "hot": true, "id": "legacy-1" })).await;
    let bia = f.insert("crm", "leads", json!({ "name": "Bia", "tags": ["a", "b"], "address": { "city": "Recife" }, "note": "two\nlines" })).await;
    f.patch(&f.db("crm", &format!("/leads/r/{}", ana["id"].as_str().unwrap())), json!({ "patch": { "value": 20 } })).await;

    // JSON keeps everything.
    let exported = f.get(&f.db("crm", "/leads/export")).await;
    assert_eq!(exported.status, StatusCode::OK);
    assert!(exported.header("content-type").starts_with("application/json"));
    assert_eq!(exported.header("content-disposition"), "attachment; filename=\"crm-leads.json\"");
    let file = exported.json();
    assert_eq!((file["app"].as_str(), file["collection"].as_str()), (Some("crm"), Some("leads")));
    assert_eq!(file["records"].as_array().unwrap().len(), 2);
    assert_eq!(file["records"][0]["rev"], 2);
    assert_eq!(file["records"][1]["data"], bia["data"]);

    // Into another collection: same ids, same creation times, same data; revisions start over.
    let copied = f.send("POST", &f.db("crm", "/copy/import?format=json"), exported.body.clone(), true).await;
    assert_eq!(copied.status, StatusCode::OK, "{}", copied.text());
    assert_eq!(copied.json(), json!({ "inserted": 2, "updated": 0, "removed": 0, "total": 2 }));
    let copy = f.get(&f.db("crm", "/copy")).await.json();
    for (index, original) in [&ana, &bia].into_iter().enumerate() {
        assert_eq!(copy["records"][index]["id"], original["id"]);
        assert_eq!(copy["records"][index]["created_at"], original["created_at"]);
        assert_eq!(copy["records"][index]["rev"], 1);
    }
    assert_eq!(copy["records"][0]["data"]["value"], 20);
    // The same file again: the records are replaced, not doubled.
    let again = f.send("POST", &f.db("crm", "/copy/import"), exported.body.clone(), true).await;
    assert_eq!(again.json(), json!({ "inserted": 0, "updated": 2, "removed": 0, "total": 2 }));
    assert_eq!(f.get(&f.db("crm", "/copy")).await.json()["records"][0]["rev"], 2);
    // A bare list of objects is new records; `replace` empties the collection first.
    let replaced = f.send("POST", &f.db("crm", "/copy/import?mode=replace"), json!([{ "name": "Only" }, { "data": "not an envelope", "x": 1 }]).to_string(), true).await;
    assert_eq!(replaced.json(), json!({ "inserted": 2, "updated": 0, "removed": 2, "total": 2 }));
    let only = f.get(&f.db("crm", "/copy")).await.json();
    assert_eq!(only["records"][0]["data"], json!({ "name": "Only" }));
    assert_eq!(only["records"][1]["data"], json!({ "data": "not an envelope", "x": 1 }));

    // CSV: one column per top-level field after `id`; a field called id is told apart; nested values are JSON text.
    let csv = f.get(&f.db("crm", "/leads/export?format=csv")).await;
    assert_eq!(csv.status, StatusCode::OK);
    assert!(csv.header("content-type").starts_with("text/csv"));
    assert_eq!(csv.header("content-disposition"), "attachment; filename=\"crm-leads.csv\"");
    let text = csv.text();
    let mut lines = text.split("\r\n");
    assert_eq!(lines.next().unwrap(), "\u{feff}id,name,value,hot,data.id,tags,address,note");
    assert_eq!(lines.next().unwrap(), format!("{},\"Ana, \"\"the first\"\"\",20,true,legacy-1,,,", ana["id"].as_str().unwrap()));
    assert!(lines.next().unwrap().starts_with(&format!("{},Bia,,,,\"[\"\"a\"\",\"\"b\"\"]\",\"{{\"\"city\"\":\"\"Recife\"\"}}\",\"two", bia["id"].as_str().unwrap())));
    // And back: the same records, with the types a spreadsheet can carry.
    let back = f.send("POST", &f.db("crm", "/sheet/import?format=csv"), csv.body.clone(), true).await;
    assert_eq!(back.status, StatusCode::OK, "{}", back.text());
    assert_eq!(back.json()["inserted"], 2);
    let sheet = f.get(&f.db("crm", "/sheet")).await.json();
    let by_id = |id: &Value| sheet["records"].as_array().unwrap().iter().find(|r| &r["id"] == id).unwrap()["data"].clone();
    assert_eq!(by_id(&ana["id"]), json!({ "name": "Ana, \"the first\"", "value": 20, "hot": true, "id": "legacy-1" }));
    assert_eq!(by_id(&bia["id"]), bia["data"]);

    // A file that cannot be read says where, and writes nothing.
    let before = f.get(&f.db("crm", "/leads")).await.json();
    for (query, body, needle) in [
        ("", "{nope".to_owned(), "not valid JSON"),
        ("", json!({ "rows": [] }).to_string(), "\"records\" list"),
        ("", json!([{ "ok": 1 }, "text"]).to_string(), "Record 2"),
        ("", json!([{ "ok": 1 }, { "id": "bad id", "data": {} }]).to_string(), "Record 2"),
        ("", json!([{ "id": 7, "data": {} }]).to_string(), "id must be a text"),
        ("?format=csv", "a,b\n1,2,3\n".to_owned(), "Row 2"),
        ("?format=csv", "id,a\nbad id,1\n".to_owned(), "Record 1"),
        ("?format=xml", "[]".to_owned(), "json or csv"),
        ("?mode=append", "[]".to_owned(), "merge or replace"),
    ] {
        let reply = f.send("POST", &f.db("crm", &format!("/leads/import{query}")), body.clone(), true).await;
        assert_eq!(reply.status, StatusCode::BAD_REQUEST, "{body}: {}", reply.text());
        assert!(reply.json()["error"].as_str().unwrap().contains(needle), "{body}: {}", reply.text());
    }
    assert_eq!(f.get(&f.db("crm", "/leads")).await.json(), before, "a refused import left the collection as it was");
    assert_eq!(f.send("POST", &f.db("crm", "/leads/import"), "[]", false).await.status, StatusCode::FORBIDDEN);
    assert_eq!(f.get(&f.db("crm", "/leads/export?format=pdf")).await.status, StatusCode::BAD_REQUEST);
    // An empty collection exports as an empty file of its kind.
    assert_eq!(f.get(&f.db("crm", "/none/export")).await.json()["records"], json!([]));
    assert_eq!(f.get(&f.db("crm", "/none/export?format=csv")).await.text(), "\u{feff}id\r\n");
}

// ---------------------------------------------------------------------------
// Uploaded files

#[test]
fn hub_apps_uploads_names_are_made_safe_and_kinds_come_from_the_bytes() {
    for (given, stem) in [
        ("photo.png", "photo"),
        ("Relatório de Março.PDF", "Relatorio-de-Marco"),
        ("../../etc/passwd", "passwd"),
        ("..\\..\\windows\\system.ini", "system"),
        ("/abs/olá mundo.jpeg", "ola-mundo"),
        (".env", "env"),
        ("...", "file"),
        ("", "file"),
        ("a/b/", "file"),
        ("наименование.png", "file"),
        ("x\0y<z>.png", "x-y-z"),
        ("archive.tar.gz", "archive-tar"),
        ("no_extension", "no_extension"),
        ("--weird--name--.gif", "weird-name"),
    ] {
        let made = uploads::safe_stem(given);
        assert_eq!(made, stem, "{given:?}");
        assert!(uploads::valid_name(&format!("{made}.png")), "{made}");
    }
    assert_eq!(uploads::safe_stem(&"ã".repeat(500)).len(), 80, "long names are cut");
    for bad in ["", ".env", "..", "a/b.png", "a\\b.png", "-rf", "a b.png", "ç.png", "a..png", &"a".repeat(200)] {
        assert!(!uploads::valid_name(bad), "{bad:?}");
    }

    assert_eq!(uploads::kind_of(PNG), Some(("image/png", "png")));
    assert_eq!(uploads::kind_of(&[0xFF, 0xD8, 0xFF, 0xE0, 0, 0]), Some(("image/jpeg", "jpg")));
    assert_eq!(uploads::kind_of(b"GIF89a..."), Some(("image/gif", "gif")));
    assert_eq!(uploads::kind_of(b"RIFF\x10\0\0\0WEBPVP8 "), Some(("image/webp", "webp")));
    assert_eq!(uploads::kind_of(b"\0\0\0\x1cftypavif\0\0\0\0"), Some(("image/avif", "avif")));
    assert_eq!(uploads::kind_of(PDF), Some(("application/pdf", "pdf")));
    let others: [&[u8]; 9] = [
        b"<!doctype html><script>alert(1)</script>", b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>", b"#!/bin/sh\nrm -rf ~", b"PK\x03\x04zip",
        b"MZ\x90\0exe", b"RIFF\x10\0\0\0WAVEfmt ", b"\0\0\0\x1cftypisom", b"", b"GIF",
    ];
    for other in others {
        assert_eq!(uploads::kind_of(other), None, "{:?}", String::from_utf8_lossy(other));
    }
}

#[tokio::test]
async fn hub_apps_uploads_keep_images_and_pdfs_inside_the_apps_files_folder() {
    let f = fixture();
    f.app("crm");
    let uploads_url = format!("{}/uploads", f.base("crm"));
    assert_eq!(f.get(&uploads_url).await.json(), json!({ "files": [] }));

    // The name is a hint: whatever path it carries, the file lands in files/ under a plain name.
    let photo = f.send("POST", &format!("{uploads_url}?name=..%2F..%2Fapp.json"), PNG, true).await;
    assert_eq!(photo.status, StatusCode::CREATED, "{}", photo.text());
    let stored = photo.json();
    assert_eq!(stored["path"], "files/app.png", "the extension is what the file is, not what it was called");
    assert_eq!((stored["name"].as_str(), stored["type"].as_str(), stored["size"].as_u64()), (Some("app.png"), Some("image/png"), Some(PNG.len() as u64)));
    assert_eq!(fs::read(f.repo.join("apps/crm/files/app.png")).unwrap(), PNG);
    assert_eq!(fs::read_to_string(f.repo.join("apps/crm/app.json")).unwrap(), r#"{"name":"CRM"}"#, "nothing else was touched");
    assert!(!f.repo.join("app.json").exists() && !f.repo.join("apps/app.json").exists());

    let report = f.send("POST", &format!("{uploads_url}?name=Relat%C3%B3rio%20de%20Mar%C3%A7o.pdf"), PDF, true).await;
    assert_eq!(report.json()["path"], "files/Relatorio-de-Marco.pdf");
    assert_eq!(report.json()["type"], "application/pdf");
    // A name that is taken is never overwritten.
    let second = f.send("POST", &format!("{uploads_url}?name=app.png"), [PNG, b"-2"].concat(), true).await;
    assert_eq!(second.json()["path"], "files/app-2.png");
    let third = f.send("POST", &uploads_url, PNG, true).await;
    assert_eq!(third.json()["path"], "files/file.png", "no name at all");
    assert_eq!(fs::read(f.repo.join("apps/crm/files/app.png")).unwrap(), PNG);

    let listed = f.get(&uploads_url).await.json();
    let names: Vec<&str> = listed["files"].as_array().unwrap().iter().map(|file| file["name"].as_str().unwrap()).collect();
    assert_eq!(names, ["app-2.png", "app.png", "file.png", "Relatorio-de-Marco.pdf"]);
    assert_eq!(fs::read_dir(f.repo.join("apps/crm/files")).unwrap().count(), 4, "no temporary file is left");

    // The app shows it from its own address, sandboxed like the rest of its files.
    let frame = f.frame("crm").await;
    let shown = f.from_frame("GET", &format!("{frame}files/app.png")).await;
    assert_eq!(shown.status, StatusCode::OK);
    assert_eq!(shown.header("content-type"), "image/png");
    assert_eq!(shown.body, PNG);
    assert!(shown.header("content-security-policy").starts_with("sandbox"));
    assert_eq!(shown.header("access-control-allow-origin"), "*");
    let pdf = f.from_frame("GET", &format!("{frame}files/Relatorio-de-Marco.pdf")).await;
    assert_eq!((pdf.status, pdf.header("content-type")), (StatusCode::OK, "application/pdf"));
    // The app's frame cannot upload or remove by itself: it asks the Tendly page.
    assert_eq!(f.from_frame("POST", &uploads_url).await.status, StatusCode::FORBIDDEN);
    assert_eq!(f.from_frame("DELETE", &format!("{uploads_url}/app.png")).await.status, StatusCode::FORBIDDEN);
    assert_eq!(f.from_frame("GET", &uploads_url).await.status, StatusCode::FORBIDDEN);

    // What is not an image or a PDF is refused, whatever it is called.
    let refused: [(&str, &'static [u8]); 4] = [
        ("photo.png", b"<!doctype html><script>fetch('/api')</script>"),
        ("logo.svg", b"<svg xmlns=\"http://www.w3.org/2000/svg\"><script>1</script></svg>"),
        ("run.pdf", b"#!/bin/sh\nrm -rf ~"),
        ("index.html", b"<h1>replaced</h1>"),
    ];
    for (name, bytes) in refused {
        let reply = f.send("POST", &format!("{uploads_url}?name={name}"), bytes, true).await;
        assert_eq!(reply.status, StatusCode::UNSUPPORTED_MEDIA_TYPE, "{name}");
        assert!(reply.json()["error"].as_str().unwrap().contains("PDF"), "{}", reply.text());
    }
    assert_eq!(f.send("POST", &uploads_url, axum::body::Body::empty(), true).await.status, StatusCode::BAD_REQUEST, "an empty file");
    assert_eq!(fs::read_to_string(f.repo.join("apps/crm/index.html")).unwrap(), "ok");
    // 20 MB: the largest that fits, and one byte more.
    let mut big = PNG.to_vec();
    big.resize(uploads::MAX_UPLOAD_BYTES, 0);
    assert_eq!(f.send("POST", &format!("{uploads_url}?name=big"), big.clone(), true).await.status, StatusCode::CREATED);
    big.push(0);
    let too_big = f.send("POST", &format!("{uploads_url}?name=bigger"), big, true).await;
    assert_eq!(too_big.status, StatusCode::PAYLOAD_TOO_LARGE);
    assert!(too_big.json()["error"].as_str().unwrap().contains("20 MB"), "{}", too_big.text());
    assert!(!f.repo.join("apps/crm/files/bigger.png").exists());
    assert_eq!(f.send("POST", &uploads_url, PNG, false).await.status, StatusCode::FORBIDDEN, "writes need the client header");
    assert_eq!(f.send("POST", &format!("{}/uploads", f.base("nope")), PNG, true).await.status, StatusCode::NOT_FOUND);

    // Removing: only a plain name of a file in files/.
    assert_eq!(f.delete(&format!("{uploads_url}/app-2.png")).await.json(), json!({ "removed": true }));
    assert_eq!(f.delete(&format!("{uploads_url}/app-2.png")).await.json(), json!({ "removed": false }));
    for bad in ["..", ".env", "..%2Fapp.json", "..%2Findex.html", "a%20b.png", "%2Fetc%2Fpasswd"] {
        let reply = f.delete(&format!("{uploads_url}/{bad}")).await;
        assert!(matches!(reply.status, StatusCode::BAD_REQUEST | StatusCode::NOT_FOUND), "{bad}: {}", reply.status);
    }
    assert!(f.repo.join("apps/crm/app.json").is_file() && f.repo.join("apps/crm/index.html").is_file());
    assert_eq!(f.get(&uploads_url).await.json()["files"].as_array().unwrap().len(), 4);

    // An upload is not a change to the app: it never reloads it.
    assert_eq!(live::app_path("apps/crm/files/app.png"), None);
    assert_eq!(live::app_path("apps/crm/files"), None);
    assert_eq!(live::app_path("apps/crm/assets/files/app.js"), Some(("crm", "assets/files/app.js")));
}

#[cfg(unix)]
#[tokio::test]
async fn hub_apps_uploads_never_follow_a_link_out_of_the_app() {
    let f = fixture();
    f.app("crm");
    let outside = f.dir.join("outside");
    fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join("secret.png"), PNG).unwrap();
    std::os::unix::fs::symlink(&outside, f.repo.join("apps/crm/files")).unwrap();
    let uploads_url = format!("{}/uploads", f.base("crm"));

    let reply = f.send("POST", &format!("{uploads_url}?name=x.png"), PNG, true).await;
    assert_eq!(reply.status, StatusCode::CONFLICT, "{}", reply.text());
    assert!(reply.json()["error"].as_str().unwrap().contains("not usable"));
    assert_eq!(fs::read_dir(&outside).unwrap().count(), 1, "nothing was written out there");
    assert_eq!(f.get(&uploads_url).await.status, StatusCode::CONFLICT);
    assert_eq!(f.delete(&format!("{uploads_url}/secret.png")).await.status, StatusCode::CONFLICT);
    assert!(outside.join("secret.png").is_file());

    // A link inside files/ is not a file of the app either: not listed, not removed.
    fs::remove_file(f.repo.join("apps/crm/files")).unwrap();
    fs::create_dir(f.repo.join("apps/crm/files")).unwrap();
    std::os::unix::fs::symlink(outside.join("secret.png"), f.repo.join("apps/crm/files/link.png")).unwrap();
    assert_eq!(f.get(&uploads_url).await.json(), json!({ "files": [] }));
    assert_eq!(f.delete(&format!("{uploads_url}/link.png")).await.json(), json!({ "removed": false }));
    assert!(outside.join("secret.png").is_file());
}

// ---------------------------------------------------------------------------
// The agent's tools

#[tokio::test]
async fn hub_apps_records_tools_let_an_agent_read_and_write_one_apps_records() {
    let f = fixture();
    f.app("crm");
    let names: Vec<String> = crate::agent::tools().iter().map(|tool| tool["name"].as_str().unwrap().to_owned()).collect();
    for tool in ["tendly_app_records_list", "tendly_app_records_get", "tendly_app_records_upsert", "tendly_app_records_delete"] {
        assert!(names.iter().any(|name| name == tool), "{tool} is listed");
        let listed = crate::agent::tools().into_iter().find(|listed| listed["name"] == tool).unwrap();
        assert_eq!(listed["inputSchema"]["required"][0], "app", "{tool} names one app");
    }
    assert!(crate::agent::INSTRUCTIONS.contains("tendly_app_records_list"));

    let lead = f.insert("crm", "leads", json!({ "name": "Ana", "stage": "new", "message": "Do you deliver on Saturdays?" })).await;
    let id = lead["id"].as_str().unwrap().to_owned();
    f.insert("crm", "leads", json!({ "name": "Bia", "stage": "won" })).await;
    let mut window = f.state.activity.subscribe();

    // What the app keeps, then the records of one collection.
    let (ok, found, _) = f.tool("tendly_app_records_list", json!({ "app": "crm" })).await;
    assert!(ok);
    assert_eq!(found["app"]["slug"], "crm");
    assert_eq!(found["collections"], json!([{ "name": "leads", "count": 2, "updated_at": found["collections"][0]["updated_at"] }]));
    let (ok, listed, _) = f.tool("tendly_app_records_list", json!({ "app": "crm", "collection": "leads", "where": { "stage": "new" } })).await;
    assert!(ok);
    assert_eq!((listed["total"].as_i64(), listed["returned"].as_i64()), (Some(1), Some(1)));
    assert_eq!(listed["records"][0]["data"]["message"], "Do you deliver on Saturdays?");
    let (_, paged, _) = f.tool("tendly_app_records_list", json!({ "app": "crm", "collection": "leads", "limit": 1, "order": "-name" })).await;
    assert_eq!((paged["records"][0]["data"]["name"].as_str(), paged["next_offset"].as_i64()), (Some("Bia"), Some(1)));

    let (ok, got, _) = f.tool("tendly_app_records_get", json!({ "app": "crm", "collection": "leads", "id": id })).await;
    assert!(ok);
    assert_eq!(got["record"], lead);

    // The agent writes its suggested reply into the lead: the other fields stay, and the open app hears of it.
    let (ok, written, _) = f
        .tool(
            "tendly_app_records_upsert",
            json!({ "app": "crm", "collection": "leads", "id": id, "merge": true, "rev": 1, "data": { "suggested_reply": "Yes, until noon." } }),
        )
        .await;
    assert!(ok);
    assert_eq!(written["updated"]["rev"], 2);
    assert_eq!(written["updated"]["data"]["message"], "Do you deliver on Saturdays?");
    assert_eq!(written["updated"]["data"]["suggested_reply"], "Yes, until noon.");
    let event = heard(&mut window).await;
    assert_eq!((event["slug"].as_str(), event["change"]["op"].as_str(), event["change"]["rev"].as_i64()), (Some("crm"), Some("update"), Some(2)));
    assert_eq!(f.get(&f.db("crm", &format!("/leads/r/{id}"))).await.json()["data"]["suggested_reply"], "Yes, until noon.");

    // A stale revision is refused with the record as it is now, in words a model can act on.
    let (ok, _, text) = f
        .tool("tendly_app_records_upsert", json!({ "app": "crm", "collection": "leads", "id": id, "rev": 1, "data": { "name": "Overwritten" } }))
        .await;
    assert!(!ok);
    assert!(text.contains("revision 2") && text.contains("Current record:") && text.contains("Yes, until noon."), "{text}");
    assert_eq!(f.get(&f.db("crm", &format!("/leads/r/{id}"))).await.json()["data"]["name"], "Ana");

    // A new record, with an id made for it or one the agent chose; without merge a record is replaced.
    let (ok, created, _) = f.tool("tendly_app_records_upsert", json!({ "app": "crm", "collection": "notes", "data": { "text": "Call back Monday" } })).await;
    assert!(ok);
    assert_eq!(created["created"]["rev"], 1);
    assert_eq!(heard(&mut window).await["change"]["op"], "insert");
    let (_, named, _) = f.tool("tendly_app_records_upsert", json!({ "app": "crm", "collection": "notes", "id": "pinned", "data": { "text": "A", "keep": 1 } })).await;
    assert_eq!(named["created"]["id"], "pinned");
    let (_, replaced, _) = f.tool("tendly_app_records_upsert", json!({ "app": "crm", "collection": "notes", "id": "pinned", "data": { "text": "B" } })).await;
    assert_eq!(replaced["updated"]["data"], json!({ "text": "B" }));

    let (ok, deleted, _) = f.tool("tendly_app_records_delete", json!({ "app": "crm", "collection": "notes", "id": "pinned", "rev": 2 })).await;
    assert!(ok);
    assert_eq!(deleted["deleted"], true);
    let (ok, deleted, _) = f.tool("tendly_app_records_delete", json!({ "app": "crm", "collection": "notes", "id": "pinned" })).await;
    assert!(ok);
    assert_eq!(deleted["deleted"], false);

    // One app per call: another app's records are another app's.
    f.app("other");
    f.insert("other", "leads", json!({ "name": "Elsewhere" })).await;
    let (_, mine, _) = f.tool("tendly_app_records_list", json!({ "app": "crm", "collection": "leads" })).await;
    assert_eq!(mine["total"], 2);
    let (_, theirs, _) = f.tool("tendly_app_records_list", json!({ "app": "other", "collection": "leads", "workspace_id": f.workspace })).await;
    assert_eq!(theirs["records"][0]["data"]["name"], "Elsewhere");

    // What is refused, and how it is said.
    for (tool, arguments, needle) in [
        ("tendly_app_records_list", json!({}), "app is required"),
        ("tendly_app_records_list", json!({ "app": "../etc" }), "not an app's folder name"),
        ("tendly_app_records_list", json!({ "app": "nope" }), "There is no app \"nope\". The apps are: crm (Fixture), other (Fixture)"),
        ("tendly_app_records_list", json!({ "app": "crm", "workspace_id": "not-a-workspace" }), "There is no app \"crm\" in workspace"),
        ("tendly_app_records_list", json!({ "app": "crm", "collection": "bad name" }), "Collection names"),
        ("tendly_app_records_list", json!({ "app": "crm", "collection": "leads", "where": { "stage": { "like": "n" } } }), "only operator"),
        ("tendly_app_records_get", json!({ "app": "crm", "collection": "leads" }), "id is required"),
        ("tendly_app_records_get", json!({ "app": "crm", "collection": "leads", "id": "missing" }), "Record not found"),
        ("tendly_app_records_upsert", json!({ "app": "crm", "collection": "leads" }), "data is required"),
        ("tendly_app_records_upsert", json!({ "app": "crm", "collection": "leads", "data": [1] }), "data is required"),
        ("tendly_app_records_upsert", json!({ "app": "crm", "collection": "leads", "data": {}, "rev": 1 }), "need the id"),
        ("tendly_app_records_upsert", json!({ "app": "crm", "collection": "leads", "id": "a b", "data": {} }), "Record ids"),
        ("tendly_app_records_upsert", json!({ "app": "crm", "collection": "leads", "id": "ghost", "rev": 3, "data": {} }), "Record not found"),
        ("tendly_app_records_delete", json!({ "app": "crm", "collection": "leads", "id": id, "rev": 1 }), "revision 2"),
        ("tendly_app_records_purge", json!({ "app": "crm" }), "Unknown Tendly tool"),
    ] {
        let (ok, _, text) = f.tool(tool, arguments.clone()).await;
        assert!(!ok, "{tool} {arguments}");
        assert!(text.contains(needle), "{tool} {arguments}: {text}");
    }
    assert_eq!(f.get(&f.db("crm", "/leads")).await.json()["total"], 2, "the refused calls changed nothing");

    // A long list is cut to what a model should read, and says where to go on.
    let scope = f.scope("crm", "bulk");
    f.state
        .hub
        .with(|c| {
            for n in 0..300 {
                records::insert(c, &scope, Some(&format!("r{n:03}")), &fields(json!({ "n": n, "text": "x".repeat(2000) })), &format!("t{n:03}"))?.unwrap();
            }
            Ok(())
        })
        .unwrap();
    let (_, bulk, _) = f.tool("tendly_app_records_list", json!({ "app": "crm", "collection": "bulk", "limit": 5000 })).await;
    let returned = bulk["returned"].as_u64().unwrap();
    assert!(returned > 50 && returned < 200, "{returned}: cut by size before the 200 a call may ask for");
    assert_eq!((bulk["total"].as_i64(), bulk["next_offset"].as_u64()), (Some(300), Some(returned)));
}

#[tokio::test]
async fn hub_apps_records_tools_find_the_app_by_workspace_when_the_name_is_shared() {
    let f = fixture();
    f.app("crm");
    // A second workspace with an app of the same name.
    let second = f.dir.join("second");
    fs::create_dir_all(second.join("apps/crm")).unwrap();
    fs::write(second.join("apps/crm/app.json"), r#"{"name":"CRM two"}"#).unwrap();
    fs::write(second.join("apps/crm/index.html"), "ok").unwrap();
    let second = dunce::canonicalize(second).unwrap();
    let other = f.state.store.create_workspace("Second", &second.to_string_lossy()).unwrap().id.to_string();

    let (ok, _, text) = f.tool("tendly_app_records_list", json!({ "app": "crm" })).await;
    assert!(!ok);
    assert!(text.contains("More than one workspace has an app \"crm\"") && text.contains(&other) && text.contains(&f.workspace), "{text}");

    let (ok, written, _) = f.tool("tendly_app_records_upsert", json!({ "app": "crm", "workspace_id": other, "collection": "leads", "data": { "name": "Two" } })).await;
    assert!(ok);
    assert_eq!(written["app"]["name"], "CRM two");
    let (_, first, _) = f.tool("tendly_app_records_list", json!({ "app": "crm", "workspace_id": f.workspace, "collection": "leads" })).await;
    assert_eq!(first["total"], 0, "the same folder name in another workspace is another app");
    let (_, there, _) = f.tool("tendly_app_records_list", json!({ "app": "crm", "workspace_id": other, "collection": "leads" })).await;
    assert_eq!(there["total"], 1);
}
