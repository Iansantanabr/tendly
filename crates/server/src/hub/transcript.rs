//! A conversation as plain text, so another conversation (or an agent through
//! the `tendly_read_conversation` tool) can take it as context.
//!
//! The text is what was said, turn by turn ("You:" / "Agent:"), with each tool
//! call folded into one line (its name and a short argument). Raw inputs and
//! results, attachment contents and streamed pieces never appear. A long
//! conversation keeps its opening message and its latest part, with a marker
//! saying how much was left out between them.
use crate::{ApiError, AppState, Result, app::db};
use axum::{
    Json, Router,
    extract::{Path, Query, State},
    routing::get,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashMap;
use tendly_domain::SessionId;

/// Characters returned when the caller does not say.
pub(crate) const DEFAULT_CHARS: usize = 20_000;
/// The most characters one read returns.
pub(crate) const MAX_CHARS: usize = 100_000;
/// The shortest budget worth honouring: below it the marker alone would not fit.
const MIN_CHARS: usize = 200;
/// How long the argument shown beside a tool's name may be.
const ARGUMENT_CHARS: usize = 80;

pub fn routes() -> Router<AppState> {
    Router::new().route("/api/hub/sessions/{id}/transcript", get(transcript))
}

#[derive(Deserialize)]
struct TranscriptQuery {
    max_chars: Option<usize>,
}

async fn transcript(
    State(state): State<AppState>,
    Path(id): Path<SessionId>,
    Query(query): Query<TranscriptQuery>,
) -> Result<Json<Value>> {
    read(&state, id, query.max_chars).await.map(Json)
}

/// The conversation `id` as `{session_id, title, workspace_id, text, truncated}`.
pub(crate) async fn read(state: &AppState, id: SessionId, max_chars: Option<usize>) -> Result<Value> {
    let session = db(state, move |s| s.get_session(id))
        .await?
        .ok_or_else(|| ApiError::missing("Session"))?;
    let stored = db(state, move |s| s.conversation(id)).await?;
    let limit = max_chars.unwrap_or(DEFAULT_CHARS).clamp(MIN_CHARS, MAX_CHARS);
    let (text, truncated) = fit(&blocks(&stored.events), limit);
    Ok(json!({
        "session_id": session.id,
        "title": session.title,
        "workspace_id": session.workspace_id,
        "text": text,
        "truncated": truncated || stored.truncated,
    }))
}

/// The session a value names: a bare id, or any Tendly link that holds one
/// (`…/session/<id>`, `…?chat=<id>`).
pub(crate) fn session_in(value: &str) -> Option<SessionId> {
    let value = value.trim();
    if let Ok(id) = value.parse::<SessionId>() {
        return Some(id);
    }
    for marker in ["/session/", "chat=", "session="] {
        let mut rest = value;
        while let Some(at) = rest.find(marker) {
            rest = &rest[at + marker.len()..];
            let candidate: String = rest.chars().take(36).collect();
            if let Ok(id) = candidate.parse::<SessionId>() {
                return Some(id);
            }
        }
    }
    None
}

/// One block of the transcript, in order.
#[derive(Debug, Clone, PartialEq)]
enum Block {
    Said { user: bool, text: String },
    Tool(String),
    Note(String),
}

impl Block {
    fn render(&self) -> Option<String> {
        match self {
            Block::Said { text, .. } if text.trim().is_empty() => None,
            Block::Said { user, text } => Some(format!(
                "{}:\n{}",
                if *user { "You" } else { "Agent" },
                text.trim()
            )),
            Block::Tool(line) | Block::Note(line) => Some(line.clone()),
        }
    }
}

/// A tool call as it is known so far: its name, its input, how it ended.
struct Call {
    name: String,
    argument: Option<String>,
    status: Option<String>,
}

/// The stored events read the way the conversation view reads them: streamed
/// pieces add up to a message and the finished message replaces them; a tool
/// call is reported once, where it started, with its last status.
fn blocks(events: &[Value]) -> Vec<String> {
    let mut out: Vec<Block> = Vec::new();
    let mut messages = HashMap::<String, usize>::new();
    let mut calls = HashMap::<String, (usize, Call)>::new();
    for event in events {
        match event["type"].as_str() {
            Some("message") => {
                let (Some(id), Some(text)) = (event["id"].as_str(), event["text"].as_str()) else {
                    continue;
                };
                let user = event["role"].as_str() == Some("user");
                let delta = event["delta"].as_bool() == Some(true);
                match messages.get(id).copied() {
                    Some(at) if matches!(&out[at], Block::Said { user: was, .. } if *was == user) => {
                        if let Block::Said { text: said, .. } = &mut out[at] {
                            if delta {
                                said.push_str(text);
                            } else {
                                *said = text.to_owned();
                            }
                        }
                    }
                    _ => {
                        messages.insert(id.to_owned(), out.len());
                        out.push(Block::Said { user, text: text.to_owned() });
                    }
                }
            }
            Some("tool") => {
                // Calls a subagent made inside another call are its own detail.
                if event.get("parent").is_some_and(|p| !p.is_null()) {
                    continue;
                }
                let (Some(id), Some(name)) = (event["id"].as_str(), event["name"].as_str()) else {
                    continue;
                };
                let status = event["status"].as_str().map(str::to_owned);
                let argument = event["text"].as_str().and_then(argument_of);
                match calls.get_mut(id) {
                    Some((_, call)) => {
                        if call.argument.is_none() && status.as_deref() == Some("running") {
                            call.argument = argument;
                        }
                        if status.is_some() {
                            call.status = status;
                        }
                    }
                    None => {
                        let argument = argument.filter(|_| status.as_deref() != Some("completed") && status.as_deref() != Some("failed"));
                        calls.insert(id.to_owned(), (out.len(), Call { name: name.to_owned(), argument, status }));
                        out.push(Block::Tool(String::new()));
                    }
                }
            }
            Some("cleared") => {
                messages.clear();
                out.push(Block::Note("[The conversation was cleared here.]".into()));
            }
            Some("configuration") => messages.clear(),
            Some("error") => {
                if let Some(message) = event["message"].as_str() {
                    out.push(Block::Note(format!("[Error: {}]", one_line(message, 160))));
                }
            }
            _ => {}
        }
    }
    for (at, call) in calls.into_values() {
        let mut line = format!("[Tool: {}", call.name);
        if let Some(argument) = &call.argument {
            line.push_str(&format!(" — {argument}"));
        }
        if call.status.as_deref() == Some("failed") {
            line.push_str(" (failed)");
        }
        line.push(']');
        out[at] = Block::Tool(line);
    }
    out.iter().filter_map(Block::render).collect()
}

/// A short, readable argument from a tool's input: the field that says what
/// the call is about, never the whole JSON.
fn argument_of(text: &str) -> Option<String> {
    let input: Value = serde_json::from_str(text).ok()?;
    let object = input.as_object()?;
    const KEYS: &[&str] = &[
        "command", "file_path", "path", "pattern", "query", "url", "description",
        "question", "prompt", "skill", "name", "session",
    ];
    let pick = KEYS
        .iter()
        .find_map(|key| object.get(*key).and_then(Value::as_str))
        .or_else(|| object.values().find_map(Value::as_str))?;
    Some(one_line(pick, ARGUMENT_CHARS)).filter(|value| !value.is_empty())
}

/// What the agent said last in the turn these events end in: the text of its
/// newest message since the person last spoke, streamed pieces added up.
/// Nothing when the agent has not spoken in this turn yet, so words from an
/// earlier turn are never taken for what it is doing now.
pub(crate) fn last_agent_text(events: &[Value]) -> Option<String> {
    let mut last: Option<(String, String)> = None;
    for event in events {
        match event["type"].as_str() {
            Some("message") => {}
            Some("cleared") => {
                last = None;
                continue;
            }
            _ => continue,
        }
        let (Some(id), Some(text)) = (event["id"].as_str(), event["text"].as_str()) else {
            continue;
        };
        match event["role"].as_str() {
            Some("assistant") => {}
            Some("user") => {
                last = None;
                continue;
            }
            _ => continue,
        }
        let delta = event["delta"].as_bool() == Some(true);
        match &mut last {
            Some((was, said)) if was == id => {
                if delta {
                    said.push_str(text);
                } else {
                    *said = text.to_owned();
                }
            }
            // A new message with nothing in it yet does not hide the one before.
            _ if text.trim().is_empty() => {}
            _ => last = Some((id.to_owned(), text.to_owned())),
        }
    }
    last.map(|(_, said)| said).filter(|said| !said.trim().is_empty())
}

/// `text` folded onto one line and cut to `limit` characters.
pub(crate) fn one_line(text: &str, limit: usize) -> String {
    let folded = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if folded.chars().count() <= limit {
        return folded;
    }
    let mut cut: String = folded.chars().take(limit.saturating_sub(1)).collect();
    cut.push('…');
    cut
}

fn chars(text: &str) -> usize {
    text.chars().count()
}

fn head(text: &str, count: usize) -> String {
    text.chars().take(count).collect()
}

fn tail(text: &str, count: usize) -> String {
    let total = chars(text);
    text.chars().skip(total.saturating_sub(count)).collect()
}

/// The blocks joined, at most `limit` characters: the first block (the
/// opening message) and as much of the end as fits, with the omitted count
/// marked between them.
fn fit(blocks: &[String], limit: usize) -> (String, bool) {
    const GAP: &str = "\n\n";
    let whole = blocks.join(GAP);
    let total = chars(&whole);
    if total <= limit {
        return (whole, false);
    }
    // Room for the marker, with a generous width for the number.
    let marker_room = chars("[… 0000000000 characters omitted …]") + 2 * chars(GAP);
    let budget = limit.saturating_sub(marker_room);
    let opening = blocks.first().map(String::as_str).unwrap_or("");
    // The opening keeps at most a third, so the latest part is never squeezed out.
    let first = if chars(opening) <= budget / 3 {
        opening.to_owned()
    } else {
        head(opening, budget / 3)
    };
    let mut room = budget.saturating_sub(chars(&first));
    let mut latest: Vec<String> = Vec::new();
    for block in blocks.iter().skip(1).rev() {
        let need = chars(block) + if latest.is_empty() { 0 } else { chars(GAP) };
        if need <= room {
            latest.push(block.clone());
            room -= need;
        } else {
            // The newest block always shows, if only its end.
            if latest.is_empty() && room > 0 {
                latest.push(tail(block, room));
            }
            break;
        }
    }
    latest.reverse();
    let latest = latest.join(GAP);
    let omitted = total.saturating_sub(chars(&first) + chars(&latest));
    let marker = format!("[… {omitted} characters omitted …]");
    let text = if latest.is_empty() {
        format!("{first}{GAP}{marker}")
    } else {
        format!("{first}{GAP}{marker}{GAP}{latest}")
    };
    (text, true)
}

/// The text of a conversation for the `tendly_read_conversation` tool.
pub(crate) fn tool() -> Value {
    crate::agent::tool(
        "tendly_read_conversation",
        "Read another Tendly conversation as plain text (\"You:\" / \"Agent:\" turns, each tool call in one line), to use it as context. A long conversation keeps its opening message and its latest part. Use it when the person points you at a conversation by link or id.",
        json!({
            "type": "object",
            "properties": {
                "session": { "type": "string", "description": "The conversation's session id, or a Tendly link that contains it (…/session/<id> or …?chat=<id>)." },
                "max_chars": { "type": "integer", "minimum": MIN_CHARS, "maximum": MAX_CHARS, "description": "At most this many characters of text. Default 20000." }
            },
            "required": ["session"],
            "additionalProperties": false
        }),
    )
}

pub(crate) async fn call(state: &AppState, arguments: &Value) -> Result<Value> {
    let named = crate::agent::text(arguments, "session").ok_or_else(|| ApiError::bad("session is required"))?;
    let id = session_in(named).ok_or_else(|| ApiError::bad("session must be a session id or a Tendly link that contains one"))?;
    let max_chars = arguments
        .get("max_chars")
        .and_then(Value::as_u64)
        .map(|value| value as usize);
    read(state, id, max_chars).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn said(id: &str, role: &str, text: &str, delta: bool) -> Value {
        json!({"type":"message","id":id,"role":role,"text":text,"delta":delta})
    }
    fn tool(id: &str, name: &str, status: &str, text: &str) -> Value {
        json!({"type":"tool","id":id,"name":name,"status":status,"text":text})
    }

    #[test]
    fn hub_transcript_reads_turns_and_folds_tools_into_one_line() {
        let events = vec![
            json!({"type":"ready","native_session_id":"x"}),
            said("u1", "user", "  List the files  ", false),
            said("a1", "assistant", "Sure, ", true),
            said("a1", "assistant", "looking", true),
            tool("t1", "Bash", "running", "{}"),
            tool("t1", "Bash", "running", r#"{"command":"ls -la\n  /tmp","description":"List"}"#),
            tool("t1", "Bash", "completed", "total 0\n{\"big\":\"result blob\"}"),
            tool("t2", "Read", "running", r#"{"file_path":"/a/b.rs"}"#),
            tool("t2", "Read", "failed", "nope"),
            json!({"type":"tool","id":"t3","name":"Grep","status":"running","text":"{\"pattern\":\"x\"}","parent":"t1"}),
            said("a1", "assistant", "Sure, here they are.", false),
            json!({"type":"usage","input_tokens":3}),
        ];
        let text = blocks(&events).join("\n\n");
        assert_eq!(
            text,
            "You:\nList the files\n\nAgent:\nSure, here they are.\n\n[Tool: Bash — ls -la /tmp]\n\n[Tool: Read — /a/b.rs (failed)]"
        );
        assert!(!text.contains("result blob") && !text.contains("Grep"));
    }

    #[test]
    fn hub_transcript_tool_without_input_and_clear_and_errors() {
        let events = vec![
            tool("t1", "TodoWrite", "completed", "done"),
            json!({"type":"cleared"}),
            json!({"type":"error","message":"Rate\nlimited"}),
            said("u1", "user", "", false),
        ];
        assert_eq!(
            blocks(&events),
            vec!["[Tool: TodoWrite]", "[The conversation was cleared here.]", "[Error: Rate limited]"]
        );
    }

    #[test]
    fn hub_transcript_last_agent_text_is_this_turns_newest_message() {
        let mut events = vec![
            said("u1", "user", "Fix the title", false),
            said("a1", "assistant", "Looking at ", true),
            said("a1", "assistant", "the page.", true),
            tool("t1", "Read", "running", r#"{"file_path":"/a/index.html"}"#),
        ];
        assert_eq!(last_agent_text(&events).as_deref(), Some("Looking at the page."));
        // The finished message replaces its pieces; a newer one wins.
        events.push(said("a1", "assistant", "Looking at the page now.", false));
        assert_eq!(last_agent_text(&events).as_deref(), Some("Looking at the page now."));
        events.push(said("a2", "assistant", "I'll tighten the title.", false));
        events.push(said("a3", "assistant", "  ", true));
        assert_eq!(last_agent_text(&events).as_deref(), Some("I'll tighten the title."));
        // Once the person speaks again, the earlier turn's words no longer count.
        events.push(said("u2", "user", "Now the footer", false));
        assert_eq!(last_agent_text(&events), None);
        events.push(said("a4", "assistant", "On it.", true));
        assert_eq!(last_agent_text(&events).as_deref(), Some("On it."));
        events.push(json!({"type":"cleared"}));
        assert_eq!(last_agent_text(&events), None);
        assert_eq!(last_agent_text(&[]), None);
    }

    #[test]
    fn hub_transcript_short_text_is_whole() {
        let parts = vec!["You:\nhi".to_owned(), "Agent:\nhello".to_owned()];
        assert_eq!(fit(&parts, 1000), ("You:\nhi\n\nAgent:\nhello".to_owned(), false));
    }

    #[test]
    fn hub_transcript_long_text_keeps_opening_and_latest() {
        let mut parts = vec!["You:\nOPENING question".to_owned()];
        for n in 0..200 {
            parts.push(format!("Agent:\nmiddle reply number {n} {}", "x".repeat(50)));
        }
        parts.push("You:\nLATEST words".to_owned());
        let whole = chars(&parts.join("\n\n"));
        let (text, truncated) = fit(&parts, 1000);
        assert!(truncated);
        assert!(chars(&text) <= 1000, "{}", chars(&text));
        assert!(text.starts_with("You:\nOPENING question\n\n[… "));
        assert!(text.ends_with("You:\nLATEST words"));
        assert!(text.contains("middle reply number 199"));
        assert!(!text.contains("middle reply number 0 "));
        // The marker counts exactly what is missing.
        let marker = text.split("[… ").nth(1).unwrap();
        let omitted: usize = marker.split(' ').next().unwrap().parse().unwrap();
        let shown = chars(&text) - chars(&format!("\n\n[… {omitted} characters omitted …]\n\n"));
        assert_eq!(omitted + shown, whole);
    }

    #[test]
    fn hub_transcript_huge_blocks_are_cut_not_dropped() {
        let parts = vec!["Q".repeat(5000), "A".repeat(5000)];
        let (text, truncated) = fit(&parts, 1200);
        assert!(truncated && chars(&text) <= 1200);
        assert!(text.starts_with('Q') && text.ends_with('A'));
        assert!(text.contains("characters omitted"));
    }

    #[test]
    fn hub_transcript_session_in_links_and_ids() {
        let id = "3f2b8c1e-9a4d-4e2f-8b7a-1c2d3e4f5a6b";
        let want: SessionId = id.parse().unwrap();
        for value in [
            id.to_owned(),
            format!("  {id} "),
            format!("http://127.0.0.1:7500/session/{id}"),
            format!("https://box.tail.ts.net/session/{id}?x=1"),
            format!("http://localhost:7500/mesa?chat={id}&y=2"),
        ] {
            assert_eq!(session_in(&value), Some(want), "{value}");
        }
        assert_eq!(session_in("not a link"), None);
        assert_eq!(session_in("http://x/session/123"), None);
    }
}
