//! One message pinned to the top of a conversation: the instruction or
//! question the person wants to keep in sight while the reply scrolls on.
//!
//! One pin per conversation, and only of something the person wrote. The
//! browser names the message; the text is read here from the stored
//! conversation, so what the bar shows is what was really said.
use super::cs;
use crate::{ApiError, AppState, Result, app::db};
use axum::{
    Json, Router,
    extract::{Path, State},
    http::StatusCode,
    routing::get,
};
use chrono::{SecondsFormat, Utc};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Deserialize;
use serde_json::{Value, json};
use tendly_domain::SessionId;

/// The most characters of a message the bar keeps.
const TEXT_CHARS: usize = 4000;
const ID_CHARS: usize = 200;

pub fn routes() -> Router<AppState> {
    Router::new().route("/api/hub/sessions/{id}/pin", get(show).put(pin).delete(unpin))
}

fn read(c: &Connection, session: &str) -> rusqlite::Result<Option<Value>> {
    c.query_row(
        "SELECT message_id, text, pinned_at FROM pinned_messages WHERE session_id = ?1",
        [session],
        |r| {
            Ok(json!({
                "message_id": r.get::<_, String>(0)?,
                "text": r.get::<_, String>(1)?,
                "pinned_at": r.get::<_, String>(2)?,
            }))
        },
    )
    .optional()
}

/// What the person said in the message `id`, when these events hold it as
/// theirs. An agent's message under that id is `Err`: it can not be pinned.
pub(crate) fn user_message(events: &[Value], id: &str) -> Option<std::result::Result<String, ()>> {
    let mut found = None;
    for event in events {
        if event["type"] != "message" || event["id"].as_str() != Some(id) {
            continue;
        }
        let Some(text) = event["text"].as_str() else { continue };
        if event["role"].as_str() != Some("user") {
            found = Some(Err(()));
        } else {
            found = Some(Ok(text.to_owned()));
        }
    }
    found
}

fn cut(text: &str) -> String {
    let text = text.trim();
    if text.chars().count() <= TEXT_CHARS {
        return text.to_owned();
    }
    let mut cut: String = text.chars().take(TEXT_CHARS - 1).collect();
    cut.push('…');
    cut
}

async fn show(State(state): State<AppState>, Path(id): Path<SessionId>) -> Result<Json<Value>> {
    let session = id.to_string();
    let pin = cs(&state, move |c| read(c, &session)).await?;
    Ok(Json(json!({ "pin": pin })))
}

#[derive(Deserialize)]
struct PinBody {
    message_id: String,
}

async fn pin(State(state): State<AppState>, Path(id): Path<SessionId>, Json(body): Json<PinBody>) -> Result<Json<Value>> {
    let message = body.message_id.trim().to_owned();
    if message.is_empty() || message.chars().count() > ID_CHARS {
        return Err(ApiError::bad("message_id is required"));
    }
    db(&state, move |s| s.get_session(id)).await?.ok_or_else(|| ApiError::missing("Session"))?;
    let stored = db(&state, move |s| s.conversation(id)).await?;
    let text = match user_message(&stored.events, &message) {
        None => return Err(ApiError::missing("Message")),
        Some(Err(())) => return Err(ApiError::bad("Only a message you wrote can be pinned")),
        Some(Ok(text)) => cut(&text),
    };
    if text.is_empty() {
        return Err(ApiError::bad("An empty message can not be pinned"));
    }
    let session = id.to_string();
    let at = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    let pin = cs(&state, move |c| {
        // One per conversation: a new pin takes the place of the old one.
        c.execute(
            "INSERT INTO pinned_messages(session_id, message_id, text, pinned_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(session_id) DO UPDATE SET message_id = ?2, text = ?3, pinned_at = ?4",
            params![session, message, text, at],
        )?;
        read(c, &session)
    })
    .await?;
    Ok(Json(json!({ "pin": pin })))
}

async fn unpin(State(state): State<AppState>, Path(id): Path<SessionId>) -> Result<StatusCode> {
    let session = id.to_string();
    cs(&state, move |c| c.execute("DELETE FROM pinned_messages WHERE session_id = ?1", [session])).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hub_pins_only_the_persons_own_message_is_found() {
        let events = vec![
            json!({"type":"message","id":"u1","role":"user","text":"Keep the tone formal"}),
            json!({"type":"message","id":"a1","role":"assistant","text":"Sure, ","delta":true}),
            json!({"type":"message","id":"a1","role":"assistant","text":"Sure, formal it is.","delta":false}),
            json!({"type":"tool","id":"u1","name":"Read","status":"running","text":"{}"}),
            json!({"type":"message","id":"u2","role":"user"}),
        ];
        assert_eq!(user_message(&events, "u1"), Some(Ok("Keep the tone formal".to_owned())));
        assert_eq!(user_message(&events, "a1"), Some(Err(())));
        assert_eq!(user_message(&events, "u2"), None);
        assert_eq!(user_message(&events, "nope"), None);
        assert_eq!(user_message(&[], "u1"), None);
    }

    #[test]
    fn hub_pins_long_messages_are_cut_on_characters() {
        assert_eq!(cut("  short  "), "short");
        let long = cut(&"é".repeat(TEXT_CHARS + 50));
        assert_eq!(long.chars().count(), TEXT_CHARS);
        assert!(long.ends_with('…'));
        assert_eq!(cut(&"a".repeat(TEXT_CHARS)).chars().count(), TEXT_CHARS);
    }
}
