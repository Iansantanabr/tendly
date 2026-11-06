//! What this machine runs on a schedule outside Tendly: the person's crontab,
//! their LaunchAgents on macOS, the systemd timers on Linux. Read only, shown
//! beside the automations so "what runs here, and when" has one answer.
//!
//! Commands pass through the catalog's redaction first, and a little more of
//! it for what shell lines carry (`Authorization: Bearer …`, `-u user:pass`).
//! Environment lines of a crontab and the `EnvironmentVariables` of a
//! LaunchAgent are never returned at all.
use super::catalog::redact;
use crate::AppState;
use axum::{Json, Router, routing::get};
use serde::Serialize;
use serde_json::{Map, Value, json};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

const TIMEOUT: Duration = Duration::from_secs(8);
const MAX_JOBS: usize = 300;
const PLIST_LIMIT: u64 = 256 * 1024;
const COMMAND_CHARS: usize = 400;
const HIDDEN: &str = "***";

pub fn routes() -> Router<AppState> {
    Router::new().route("/api/hub/automations/server-jobs", get(list))
}

#[derive(Serialize, Debug, PartialEq, Clone)]
pub(crate) struct Job {
    /// `crontab`, `launchd` or `systemd`.
    source: &'static str,
    name: String,
    /// As the system writes it: a cron expression, launchd's keys, or empty.
    schedule: String,
    /// When it runs next, where the system says (systemd).
    #[serde(skip_serializing_if = "Option::is_none")]
    next: Option<String>,
    /// The command with credentials hidden; the unit a timer starts.
    command: String,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    disabled: bool,
}

// ---------------------------------------------------------------------------
// Redaction

fn bare(word: &str) -> &str {
    word.trim_matches(|c| matches!(c, '"' | '\'' | '`'))
}

/// A shell command line with credentials hidden: the catalog's rules (flag
/// values such as `--token x`, `NAME=value`, URLs, anything key-like), then
/// header values, `Bearer`/`Basic` credentials and `-u user:password`.
pub(crate) fn redact_line(line: &str) -> String {
    let scheme = |word: &str| matches!(word, "bearer" | "basic" | "token");
    let cleaned = redact::clean_command_line(line);
    let mut out: Vec<String> = Vec::new();
    // The next word is a credential: it follows `Bearer`, or a header name.
    let mut hide_next = false;
    let mut user_next = false;
    for word in cleaned.split(' ') {
        let plain = bare(word);
        let lower = plain.to_ascii_lowercase();
        let after_user = std::mem::take(&mut user_next);
        let shown = if plain.is_empty() {
            word.to_owned()
        } else if scheme(&lower) {
            hide_next = true;
            word.to_owned()
        } else if std::mem::take(&mut hide_next) {
            HIDDEN.to_owned()
        } else if let Some((name, value)) = plain.split_once(':')
            && !value.starts_with("//")
            && redact::secret_name(name)
        {
            // `X-Api-Key: value` (the value is the next word) or `x-api-key:value`.
            hide_next = value.is_empty() || scheme(&value.to_ascii_lowercase());
            if value.is_empty() { word.to_owned() } else { format!("{name}:{HIDDEN}") }
        } else if after_user && let Some((user, _)) = plain.split_once(':') {
            format!("{user}:{HIDDEN}")
        } else {
            user_next = matches!(plain, "-u" | "--user");
            word.to_owned()
        };
        out.push(shown);
    }
    let joined = out.join(" ");
    if joined.chars().count() > COMMAND_CHARS {
        let mut cut: String = joined.chars().take(COMMAND_CHARS - 1).collect();
        cut.push('…');
        cut
    } else {
        joined
    }
}

/// The program a command line runs, for a name: `backup.sh` out of
/// `cd /srv && KEY=1 nice ./bin/backup.sh --all`.
fn program_of(command: &str) -> String {
    const WRAPPERS: &[&str] = &["env", "nice", "nohup", "sudo", "time", "exec", "command", "ionice", "&&", ";"];
    let mut words = command.split_whitespace();
    while let Some(word) = words.next() {
        let plain = bare(word);
        if plain == "cd" {
            words.next();
            continue;
        }
        let assignment = plain.split_once('=').is_some_and(|(name, _)| {
            !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        });
        let base = plain.rsplit('/').next().unwrap_or(plain);
        if assignment || plain.starts_with('-') || WRAPPERS.contains(&base) || base.is_empty() {
            continue;
        }
        return base.chars().take(80).collect();
    }
    String::new()
}

// ---------------------------------------------------------------------------
// crontab

/// One of the five time fields. Only the month and the weekday take names
/// (`jan`, `mon`), which is what tells an entry from a line of prose.
fn cron_field(index: usize, field: &str) -> bool {
    let named = index >= 3;
    !field.is_empty()
        && field.chars().any(|c| c.is_ascii_digit() || c == '*' || (named && c.is_ascii_alphabetic()))
        && field.chars().all(|c| {
            c.is_ascii_digit() || matches!(c, '*' | '/' | ',' | '-' | '?' | '#' | 'L' | 'W') || (named && c.is_ascii_alphabetic())
        })
}

/// The entries of `crontab -l`. Comments and environment lines (`MAILTO=…`,
/// `API_KEY=…`) are skipped: only what runs is listed.
pub(crate) fn parse_crontab(text: &str) -> Vec<Job> {
    let mut jobs = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (schedule, command) = if line.starts_with('@') {
            let Some((when, command)) = line.split_once(char::is_whitespace) else { continue };
            (when.to_owned(), command.trim())
        } else {
            let mut rest = line;
            let mut fields = Vec::new();
            for _ in 0..5 {
                let Some((field, after)) = rest.split_once(char::is_whitespace) else { break };
                fields.push(field);
                rest = after.trim_start();
            }
            // An environment line, or something that is not an entry.
            if fields.len() != 5 || !fields.iter().enumerate().all(|(index, field)| cron_field(index, field)) {
                continue;
            }
            (fields.join(" "), rest)
        };
        if command.is_empty() {
            continue;
        }
        let name = program_of(command);
        jobs.push(Job {
            source: "crontab",
            name: if name.is_empty() { "cron".to_owned() } else { name },
            schedule,
            next: None,
            command: redact_line(command),
            disabled: false,
        });
    }
    jobs
}

// ---------------------------------------------------------------------------
// launchd (macOS): property lists in XML

#[derive(Debug, PartialEq)]
enum Token {
    Open(String),
    Close(String),
    Empty(String),
    Text(String),
}

fn unescape(text: &str) -> String {
    text.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&amp;", "&")
}

fn tokens(text: &str) -> Vec<Token> {
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(open) = rest.find('<') {
        let before = &rest[..open];
        if !before.trim().is_empty() {
            out.push(Token::Text(unescape(before)));
        }
        rest = &rest[open + 1..];
        if let Some(comment) = rest.strip_prefix("!--") {
            rest = comment.find("-->").map_or("", |end| &comment[end + 3..]);
            continue;
        }
        let Some(close) = rest.find('>') else { break };
        let tag = rest[..close].trim();
        rest = &rest[close + 1..];
        if tag.starts_with('?') || tag.starts_with('!') {
            continue;
        }
        let name = |tag: &str| tag.split_whitespace().next().unwrap_or("").to_owned();
        if let Some(closing) = tag.strip_prefix('/') {
            out.push(Token::Close(name(closing)));
        } else if let Some(empty) = tag.strip_suffix('/') {
            out.push(Token::Empty(name(empty)));
        } else {
            out.push(Token::Open(name(tag)));
        }
    }
    out
}

fn value_at(tokens: &[Token], at: &mut usize, depth: usize) -> Option<Value> {
    if depth > 32 {
        return None;
    }
    let token = tokens.get(*at)?;
    *at += 1;
    match token {
        Token::Empty(name) => Some(match name.as_str() {
            "true" => Value::Bool(true),
            "false" => Value::Bool(false),
            "dict" => Value::Object(Map::new()),
            "array" => Value::Array(Vec::new()),
            _ => Value::String(String::new()),
        }),
        Token::Open(name) if name == "dict" => {
            let mut map = Map::new();
            loop {
                match tokens.get(*at)? {
                    Token::Close(end) if end == "dict" => {
                        *at += 1;
                        return Some(Value::Object(map));
                    }
                    Token::Open(key) if key == "key" => {
                        *at += 1;
                        let name = match tokens.get(*at)? {
                            Token::Text(name) => {
                                *at += 1;
                                name.trim().to_owned()
                            }
                            _ => String::new(),
                        };
                        matches!(tokens.get(*at)?, Token::Close(end) if end == "key").then_some(())?;
                        *at += 1;
                        let value = value_at(tokens, at, depth + 1)?;
                        // What a job is given to run with is never kept.
                        if name != "EnvironmentVariables" {
                            map.insert(name, value);
                        }
                    }
                    Token::Empty(key) if key == "key" => {
                        *at += 1;
                        value_at(tokens, at, depth + 1)?;
                    }
                    _ => return None,
                }
            }
        }
        Token::Open(name) if name == "array" => {
            let mut items = Vec::new();
            loop {
                if matches!(tokens.get(*at)?, Token::Close(end) if end == "array") {
                    *at += 1;
                    return Some(Value::Array(items));
                }
                items.push(value_at(tokens, at, depth + 1)?);
            }
        }
        Token::Open(name) => {
            let mut text = String::new();
            loop {
                match tokens.get(*at)? {
                    Token::Text(piece) => text.push_str(piece),
                    Token::Close(end) if end == name => {
                        *at += 1;
                        break;
                    }
                    _ => return None,
                }
                *at += 1;
            }
            let text = text.trim();
            Some(match name.as_str() {
                "integer" => text.parse::<i64>().map_or(Value::Null, Value::from),
                _ => Value::String(text.to_owned()),
            })
        }
        _ => None,
    }
}

/// The top dictionary of an XML property list.
pub(crate) fn plist(text: &str) -> Option<Value> {
    let tokens = tokens(text);
    let start = tokens.iter().position(|t| matches!(t, Token::Open(name) if name == "dict"))?;
    let mut at = start;
    value_at(&tokens, &mut at, 0)
}

fn calendar(entry: &Value) -> Option<String> {
    let entry = entry.as_object()?;
    let parts: Vec<String> = ["Month", "Day", "Weekday", "Hour", "Minute"]
        .iter()
        .filter_map(|key| entry.get(*key).and_then(Value::as_i64).map(|value| format!("{key}={value}")))
        .collect();
    Some(if parts.is_empty() { "every minute".to_owned() } else { parts.join(" ") })
}

/// When a LaunchAgent starts, in launchd's own key names.
fn launchd_schedule(agent: &Map<String, Value>) -> String {
    let mut parts = Vec::new();
    match agent.get("StartCalendarInterval") {
        Some(Value::Array(entries)) => {
            let listed: Vec<String> = entries.iter().filter_map(calendar).take(4).collect();
            if !listed.is_empty() {
                let more = if entries.len() > listed.len() { "; …" } else { "" };
                parts.push(format!("StartCalendarInterval {}{more}", listed.join("; ")));
            }
        }
        Some(entry) => {
            if let Some(when) = calendar(entry) {
                parts.push(format!("StartCalendarInterval {when}"));
            }
        }
        None => {}
    }
    if let Some(seconds) = agent.get("StartInterval").and_then(Value::as_i64) {
        parts.push(format!("StartInterval {seconds}"));
    }
    for key in ["RunAtLoad", "KeepAlive", "StartOnMount"] {
        match agent.get(key) {
            Some(Value::Bool(true)) | Some(Value::Object(_)) => parts.push(key.to_owned()),
            _ => {}
        }
    }
    for key in ["WatchPaths", "QueueDirectories"] {
        if agent.get(key).and_then(Value::as_array).is_some_and(|paths| !paths.is_empty()) {
            parts.push(key.to_owned());
        }
    }
    parts.join(", ")
}

/// One LaunchAgent from the text of its property list; `fallback` (the file
/// name) names it when the list has no `Label` or is not XML.
pub(crate) fn launch_agent(fallback: &str, text: &str) -> Job {
    let parsed = plist(text);
    let agent = parsed.as_ref().and_then(Value::as_object);
    let string = |key: &str| agent.and_then(|a| a.get(key)).and_then(Value::as_str).filter(|s| !s.is_empty());
    let arguments: Vec<String> = agent
        .and_then(|a| a.get("ProgramArguments"))
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(|item| item.as_str().map(str::to_owned)).collect())
        .unwrap_or_default();
    let line = match (arguments.split_first(), string("Program")) {
        (Some((program, rest)), _) => redact::clean_command(program, rest),
        (None, Some(program)) => redact::clean_command(program, &[]),
        (None, None) => String::new(),
    };
    Job {
        source: "launchd",
        name: string("Label").unwrap_or(fallback).chars().take(120).collect(),
        schedule: agent.map(launchd_schedule).unwrap_or_default(),
        next: None,
        command: redact_line(&line),
        disabled: agent.and_then(|a| a.get("Disabled")).and_then(Value::as_bool) == Some(true),
    }
}

fn launch_agents(dir: &Path) -> Vec<Job> {
    let Ok(read) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut files: Vec<PathBuf> = read
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|e| e == "plist") && path.is_file())
        .collect();
    files.sort();
    files
        .into_iter()
        .take(MAX_JOBS)
        .map(|path| {
            let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
            // A binary list is named by its file; its content is not guessed at.
            let text = super::catalog::read_capped(&path, PLIST_LIMIT).filter(|t| !t.starts_with("bplist")).unwrap_or_default();
            launch_agent(&stem, &text)
        })
        .collect()
}

// ---------------------------------------------------------------------------
// systemd (Linux)

/// The table `systemctl list-timers --all --no-pager` prints.
pub(crate) fn parse_timers(text: &str) -> Vec<Job> {
    let mut lines = text.lines();
    let Some(header) = lines.by_ref().find(|line| line.contains("NEXT") && line.contains("UNIT")) else {
        return Vec::new();
    };
    let column = |name: &str| header.find(name).map(|byte| header[..byte].chars().count());
    let (Some(next_at), Some(left_at)) = (column("NEXT"), column("LEFT")) else { return Vec::new() };
    let mut jobs = Vec::new();
    for line in lines {
        if line.trim().is_empty() {
            break;
        }
        let words: Vec<&str> = line.split_whitespace().collect();
        let Some(unit_at) = words.iter().position(|word| word.ends_with(".timer")) else { continue };
        let next: String = line.chars().skip(next_at).take(left_at.saturating_sub(next_at)).collect();
        let next = next.trim();
        jobs.push(Job {
            source: "systemd",
            name: words[unit_at].chars().take(120).collect(),
            schedule: String::new(),
            next: (!matches!(next, "" | "n/a" | "-")).then(|| next.to_owned()),
            command: words.get(unit_at + 1).map(|unit| unit.chars().take(120).collect()).unwrap_or_default(),
            disabled: false,
        });
    }
    jobs
}

// ---------------------------------------------------------------------------
// Route

/// What a command printed, when it could be run at all.
async fn output_of(program: &str, args: &[&str]) -> Option<String> {
    let child = tokio::process::Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .ok()?;
    let output = tokio::time::timeout(TIMEOUT, child.wait_with_output()).await.ok()?.ok()?;
    Some(String::from_utf8_lossy(&output.stdout).into_owned())
}

async fn list() -> Json<Value> {
    let mut jobs = Vec::new();
    // The places looked at, so an empty list says where nothing was found.
    let mut sources = Vec::new();
    // No crontab at all exits with an error and prints nothing: no entries.
    if let Some(text) = output_of("crontab", &["-l"]).await {
        sources.push("crontab");
        jobs.extend(parse_crontab(&text));
    }
    if cfg!(target_os = "macos")
        && let Some(home) = std::env::var_os("HOME").filter(|home| !home.is_empty())
    {
        let dir = PathBuf::from(home).join("Library/LaunchAgents");
        if let Ok(found) = tokio::task::spawn_blocking(move || dir.is_dir().then(|| launch_agents(&dir))).await
            && let Some(found) = found
        {
            sources.push("launchd");
            jobs.extend(found);
        }
    }
    if cfg!(target_os = "linux")
        && let Some(text) = output_of("systemctl", &["list-timers", "--all", "--no-pager"]).await
    {
        sources.push("systemd");
        jobs.extend(parse_timers(&text));
    }
    let truncated = jobs.len() > MAX_JOBS;
    jobs.truncate(MAX_JOBS);
    Json(json!({ "jobs": jobs, "sources": sources, "truncated": truncated }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hub_server_jobs_crontab_entries_without_comments_or_environment() {
        let text = concat!(
            "# m h dom mon dow command\n",
            "MAILTO=ops@example.com\n",
            "API_KEY=sk-live-DO-NOT-SHOW\n",
            "PATH=/usr/local/bin:/usr/bin\n",
            "\n",
            "# 0 4 * * * /old/job --token COMMENTED-OUT\n",
            "30 6 * * 1-5 cd /srv/app && TOKEN=INLINE-SECRET ./bin/report.sh --api-key FLAG-SECRET --verbose >> /var/log/report.log 2>&1\n",
            "*/15 * * * * /usr/bin/curl -s -H \"Authorization: Bearer HEADER-SECRET\" https://user:URL-SECRET@api.example.com/ping?key=QUERY-SECRET\n",
            "@daily   /usr/local/bin/backup -u admin:USER-SECRET /data\n",
            "0 0 1 jan * nice /opt/yearly\n",
            "not a cron line at all\n",
            "1 2 3 4\n",
        );
        let jobs = parse_crontab(text);
        let seen: Vec<(&str, &str, &str)> = jobs.iter().map(|j| (j.name.as_str(), j.schedule.as_str(), j.command.as_str())).collect();
        assert_eq!(
            seen,
            vec![
                ("report.sh", "30 6 * * 1-5", "cd /srv/app && TOKEN=*** ./bin/report.sh --api-key *** --verbose >> /var/log/report.log 2>&1"),
                ("curl", "*/15 * * * *", "/usr/bin/curl -s -H \"Authorization: Bearer *** https://api.example.com/ping"),
                ("backup", "@daily", "/usr/local/bin/backup -u admin:*** /data"),
                ("yearly", "0 0 1 jan *", "nice /opt/yearly"),
            ]
        );
        let sent = serde_json::to_string(&jobs).unwrap();
        assert!(!sent.contains("SECRET") && !sent.contains("DO-NOT-SHOW") && !sent.contains("COMMENTED") && !sent.contains("MAILTO"), "{sent}");
        assert!(jobs.iter().all(|j| j.source == "crontab" && !j.disabled && j.next.is_none()));
        assert!(parse_crontab("").is_empty());
        assert!(parse_crontab("crontab: no crontab for me\n").is_empty());
    }

    #[test]
    fn hub_server_jobs_redaction_covers_headers_and_users() {
        assert_eq!(redact_line("curl -H x-api-key:abc123 https://h.example/a"), "curl -H x-api-key:*** https://h.example/a");
        assert_eq!(redact_line("curl -H 'X-Api-Key: abc123' https://h.example/a"), "curl -H 'X-Api-Key: *** https://h.example/a");
        assert_eq!(redact_line("curl --user me:pw https://h.example"), "curl --user me:*** https://h.example/");
        assert_eq!(redact_line("mysqldump -u root -h db.internal shop"), "mysqldump -u root -h db.internal shop");
        assert_eq!(redact_line("http GET example.com 'Authorization:Token abc'"), "http GET example.com Authorization:*** ***");
        assert_eq!(redact_line("curl -H \"Authorization: Bearer abc.def\" -H \"Accept: text/plain\" x"), "curl -H \"Authorization: Bearer *** -H \"Accept: text/plain\" x");
        // Ordinary lines stay readable.
        assert_eq!(redact_line("rsync -a /data/ backup:/srv/data/"), "rsync -a /data/ backup:/srv/data/");
        assert_eq!(redact_line("/usr/bin/python3 /home/me/job.py --date 2026-11-06"), "/usr/bin/python3 /home/me/job.py --date 2026-11-06");
        assert_eq!(redact_line(""), "");
        let long = redact_line(&format!("echo {}", "word ".repeat(200)));
        assert_eq!(long.chars().count(), COMMAND_CHARS);
        assert_eq!(program_of("cd /srv && KEY=1 nice ./bin/backup.sh --all"), "backup.sh");
        assert_eq!(program_of("/usr/bin/env python3 job.py"), "python3");
        assert_eq!(program_of("A=1"), "");
    }

    const AGENT: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<!-- nightly sync -->
<dict>
    <key>Label</key>
    <string>com.example.sync</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>SYNC_TOKEN</key>
        <string>ENV-SECRET</string>
    </dict>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/sync</string>
        <string>--password</string>
        <string>ARG-SECRET</string>
        <string>--target</string>
        <string>a &amp; b</string>
    </array>
    <key>StartCalendarInterval</key>
    <array>
        <dict><key>Hour</key><integer>3</integer><key>Minute</key><integer>30</integer></dict>
        <dict><key>Weekday</key><integer>1</integer><key>Hour</key><integer>9</integer></dict>
    </array>
    <key>StartInterval</key>
    <integer>3600</integer>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <false/>
    <key>Disabled</key>
    <true/>
</dict>
</plist>"#;

    #[test]
    fn hub_server_jobs_launch_agent_from_its_property_list() {
        let job = launch_agent("file-name", AGENT);
        assert_eq!(
            job,
            Job {
                source: "launchd",
                name: "com.example.sync".into(),
                schedule: "StartCalendarInterval Hour=3 Minute=30; Weekday=1 Hour=9, StartInterval 3600, RunAtLoad".into(),
                next: None,
                command: "/usr/local/bin/sync --password *** --target a & b".into(),
                disabled: true,
            }
        );
        let sent = serde_json::to_string(&job).unwrap();
        assert!(!sent.contains("SECRET") && !sent.contains("SYNC_TOKEN"), "{sent}");
        // The environment is dropped while the list is read, not only at the end.
        assert!(!plist(AGENT).unwrap().to_string().contains("ENV-SECRET"));

        // A single calendar entry, a bare program, a watcher.
        let simple = "<plist><dict><key>Program</key><string>/Applications/X.app/Contents/MacOS/helper</string><key>StartCalendarInterval</key><dict><key>Minute</key><integer>0</integer></dict><key>WatchPaths</key><array><string>/tmp/x</string></array><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict></dict></plist>";
        let job = launch_agent("com.x.helper", simple);
        assert_eq!((job.name.as_str(), job.schedule.as_str()), ("com.x.helper", "StartCalendarInterval Minute=0, KeepAlive, WatchPaths"));
        assert_eq!(job.command, "/Applications/X.app/Contents/MacOS/helper");
        assert!(!job.disabled);

        // Binary, empty or broken lists still name the agent and invent nothing.
        for text in ["", "bplist00\u{1}\u{2}", "<plist><dict><key>Label</key>", "<dict><string>no key</string></dict>", "just text"] {
            let job = launch_agent("com.broken.agent", text);
            assert_eq!((job.name.as_str(), job.schedule.as_str(), job.command.as_str()), ("com.broken.agent", "", ""), "{text:?}");
        }
        // Nesting has an end.
        let deep = format!("{}{}", "<array>".repeat(100), "</array>".repeat(100));
        assert_eq!(plist(&format!("<dict><key>a</key>{deep}</dict>")), None);
    }

    #[test]
    fn hub_server_jobs_systemd_timers_table() {
        let text = concat!(
            "NEXT                        LEFT          LAST                        PASSED       UNIT                         ACTIVATES\n",
            "Sat 2026-11-07 06:30:00 UTC 5h 3min left  Fri 2026-11-06 06:30:00 UTC 18h ago      tendly-backup.timer          tendly-backup.service\n",
            "Sat 2026-11-07 00:00:00 UTC 22min left    Fri 2026-11-06 00:00:00 UTC 23h ago      logrotate.timer              logrotate.service\n",
            "n/a                         n/a           n/a                         n/a          snapd.snap-repair.timer      snapd.snap-repair.service\n",
            "-                           -             -                           -            fwupd-refresh.timer          fwupd-refresh.service\n",
            "\n",
            "4 timers listed.\n",
            "Pass --all to see loaded but inactive timers, too.\n",
        );
        let jobs = parse_timers(text);
        let seen: Vec<(&str, Option<&str>, &str)> = jobs.iter().map(|j| (j.name.as_str(), j.next.as_deref(), j.command.as_str())).collect();
        assert_eq!(
            seen,
            vec![
                ("tendly-backup.timer", Some("Sat 2026-11-07 06:30:00 UTC"), "tendly-backup.service"),
                ("logrotate.timer", Some("Sat 2026-11-07 00:00:00 UTC"), "logrotate.service"),
                ("snapd.snap-repair.timer", None, "snapd.snap-repair.service"),
                ("fwupd-refresh.timer", None, "fwupd-refresh.service"),
            ]
        );
        assert!(jobs.iter().all(|j| j.source == "systemd" && j.schedule.is_empty()));
        assert!(parse_timers("0 timers listed.\n").is_empty());
        assert!(parse_timers("").is_empty());
    }

    #[test]
    fn hub_server_jobs_reads_a_folder_of_launch_agents() {
        let dir = std::env::temp_dir().join(format!("hub-jobs-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("b.sync.plist"), AGENT).unwrap();
        std::fs::write(dir.join("a.binary.plist"), b"bplist00\x01\x02\xff").unwrap();
        std::fs::write(dir.join("notes.txt"), "not an agent").unwrap();
        let jobs = launch_agents(&dir);
        let names: Vec<&str> = jobs.iter().map(|j| j.name.as_str()).collect();
        assert_eq!(names, ["a.binary", "com.example.sync"]);
        assert!(launch_agents(&dir.join("missing")).is_empty());
        std::fs::remove_dir_all(dir).ok();
    }
}
