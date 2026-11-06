//! MCP servers: what `claude mcp list` reports (claude.ai connectors, servers
//! the person added, plugin servers), what Codex is configured with, and the
//! `.mcp.json` of each workspace. Read only; secrets never leave this module.
use super::{home, read_capped, redact};
use crate::{ApiError, AppState, Result, app::db};
use axum::{
    Json,
    extract::{Query, State},
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    process::Stdio,
    sync::OnceLock,
    time::{Duration, Instant},
};
use tokio::sync::Mutex;

const LIST_TIMEOUT: Duration = Duration::from_secs(20);
const FRESH_FOR: Duration = Duration::from_secs(10 * 60);
/// A failed check is retried sooner than a good one.
const FAILURE_FRESH_FOR: Duration = Duration::from_secs(60);
const CONFIG_LIMIT: u64 = 4 * 1024 * 1024;

#[derive(Serialize, Clone, Debug, PartialEq)]
pub(super) struct Server {
    name: String,
    source: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    workspace_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    workspace_name: Option<String>,
    /// The Claude Code plugin that brings this server.
    #[serde(skip_serializing_if = "Option::is_none")]
    plugin: Option<String>,
    transport: &'static str,
    target: String,
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
}

impl Server {
    fn new(name: &str, source: &'static str, transport: &'static str, target: String) -> Self {
        Server {
            name: name.to_owned(),
            source,
            workspace_id: None,
            workspace_name: None,
            plugin: None,
            transport,
            target,
            status: "unknown",
            detail: None,
        }
    }
}

/// Errors are fixed English sentences the browser translates; `path` fills `{path}`.
#[derive(Serialize, Clone, Debug)]
struct CatalogError {
    message: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
}

#[derive(Clone)]
struct Checked {
    at: Instant,
    checked_at: DateTime<Utc>,
    servers: Vec<Server>,
    error: Option<&'static str>,
}

fn cache() -> &'static Mutex<Option<Checked>> {
    static CACHE: OnceLock<Mutex<Option<Checked>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

#[derive(Deserialize)]
pub(super) struct ListQuery {
    refresh: Option<String>,
}

pub(super) async fn list(State(state): State<AppState>, Query(query): Query<ListQuery>) -> Result<Json<Value>> {
    let refresh = matches!(query.refresh.as_deref(), Some("1" | "true" | "yes"));
    let workspaces = db(&state, |s| s.list_workspaces()).await?;
    let checked = claude_list(refresh).await;
    let known: HashSet<String> = checked.servers.iter().map(|s| s.name.clone()).collect();
    let listed_ok = checked.error.is_none();
    let (files, mut errors) = tokio::task::spawn_blocking(move || {
        let workspaces: Vec<(String, String, String)> =
            workspaces.into_iter().map(|w| (w.id.to_string(), w.name, w.root_path)).collect();
        file_sources(home().as_deref(), &workspaces, &known, listed_ok)
    })
    .await
    .map_err(ApiError::internal)?;
    if let Some(message) = checked.error {
        errors.insert(0, CatalogError { message, path: None });
    }
    let mut servers = checked.servers;
    servers.extend(files);
    Ok(Json(json!({
        "servers": servers,
        "checked_at": checked.checked_at.to_rfc3339(),
        "errors": errors,
    })))
}

/// `claude mcp list` checks every server's health, which takes seconds; its
/// answer is kept for ten minutes unless the person asks again.
async fn claude_list(refresh: bool) -> Checked {
    let mut cached = cache().lock().await;
    if let Some(checked) = cached.as_ref() {
        let fresh_for = if checked.error.is_some() { FAILURE_FRESH_FOR } else { FRESH_FOR };
        if !refresh && checked.at.elapsed() < fresh_for {
            return checked.clone();
        }
    }
    let (servers, error) = match run_claude_list().await {
        Ok(servers) => (servers, None),
        Err(error) => (Vec::new(), Some(error)),
    };
    let checked = Checked { at: Instant::now(), checked_at: Utc::now(), servers, error };
    *cached = Some(checked.clone());
    checked
}

fn find_claude() -> Option<PathBuf> {
    let on_path = std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).map(|dir| dir.join("claude")).collect::<Vec<_>>())
        .unwrap_or_default();
    let mut candidates = on_path;
    if let Some(home) = home() {
        let mut nvm: Vec<PathBuf> = std::fs::read_dir(home.join(".nvm/versions/node"))
            .map(|entries| entries.flatten().map(|e| e.path().join("bin/claude")).collect())
            .unwrap_or_default();
        nvm.sort();
        nvm.reverse();
        candidates.extend(nvm);
        candidates.push(home.join(".local/bin/claude"));
        candidates.push(home.join(".claude/local/claude"));
    }
    candidates.push("/opt/homebrew/bin/claude".into());
    candidates.push("/usr/local/bin/claude".into());
    candidates.into_iter().find(|path| path.is_file())
}

async fn run_claude_list() -> std::result::Result<Vec<Server>, &'static str> {
    let binary = find_claude().ok_or("Claude Code (claude) was not found on this computer.")?;
    let mut command = tokio::process::Command::new(&binary);
    command
        .args(["mcp", "list"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // From the home folder, so no project's own servers are mixed in.
    if let Some(home) = home() {
        command.current_dir(home);
    }
    // `claude` is a Node script: its own folder (where node lives) goes first.
    if let Some(dir) = binary.parent() {
        let mut paths = vec![dir.to_path_buf()];
        if let Some(path) = std::env::var_os("PATH") {
            paths.extend(std::env::split_paths(&path));
        }
        if let Ok(joined) = std::env::join_paths(paths) {
            command.env("PATH", joined);
        }
    }
    let child = command.spawn().map_err(|_| "Claude Code (claude) could not be started.")?;
    let output = match tokio::time::timeout(LIST_TIMEOUT, child.wait_with_output()).await {
        Err(_) => return Err("Claude Code took longer than 20 seconds to list its integrations."),
        Ok(Err(_)) => return Err("Claude Code (claude) could not be started."),
        Ok(Ok(output)) => output,
    };
    let text = format!("{}\n{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
    let servers: Vec<Server> = text.lines().filter_map(parse_list_line).collect();
    if servers.is_empty() && !output.status.success() {
        return Err("Claude Code could not list its integrations.");
    }
    Ok(servers)
}

/// One line of `claude mcp list`, such as
/// `claude.ai Notion: https://mcp.notion.com/mcp - ✔ Connected` or
/// `plugin:marketing:canva: https://mcp.canva.com/mcp (HTTP) - ! Needs authentication`.
pub(super) fn parse_list_line(line: &str) -> Option<Server> {
    let line = line.trim();
    // The status follows the first " - " that starts with a status mark.
    let (index, status_text) = line.match_indices(" - ").find_map(|(index, _)| {
        let rest = line[index + 3..].trim_start();
        let first = rest.chars().next()?;
        let marked = "✔✓✗✘!⚠-×".contains(first)
            || ["connected", "failed", "needs", "not "].iter().any(|w| rest.to_ascii_lowercase().starts_with(w));
        marked.then_some((index, rest))
    })?;
    let head = &line[..index];
    let (full_name, rest) = head.split_once(": ").or_else(|| head.strip_suffix(':').map(|n| (n, "")))?;
    let full_name = full_name.trim();
    if full_name.is_empty() {
        return None;
    }
    let mut target = rest.trim();
    let mut transport = None;
    for (suffix, kind) in [("(HTTP)", "http"), ("(SSE)", "sse"), ("(stdio)", "stdio")] {
        if let Some(stripped) = target.strip_suffix(suffix) {
            target = stripped.trim_end();
            transport = Some(kind);
        }
    }
    let is_url = target.starts_with("http://") || target.starts_with("https://");
    let transport = transport.unwrap_or(if is_url {
        "http"
    } else if target.is_empty() {
        "unknown"
    } else {
        "stdio"
    });
    let target = if is_url { redact::clean_url(target) } else { redact::clean_command_line(target) };

    let (name, source, plugin) = if let Some(name) = full_name.strip_prefix("claude.ai ") {
        (name.to_owned(), "claude_account", None)
    } else if let Some(rest) = full_name.strip_prefix("plugin:") {
        match rest.split_once(':') {
            Some((plugin, name)) => (name.to_owned(), "claude_user", Some(plugin.to_owned())),
            None => (rest.to_owned(), "claude_user", None),
        }
    } else {
        (full_name.to_owned(), "claude_user", None)
    };

    let words = status_text.trim_start_matches(|c: char| !c.is_alphanumeric()).trim();
    let lower = words.to_ascii_lowercase();
    let (status, detail) = if lower.contains("needs auth") || lower.contains("authentication") || lower.contains("authorize")
    {
        ("needs_auth", None)
    } else if lower.starts_with("failed") || lower.contains("error") {
        let detail = words.split_once(['—', ':']).map(|(_, d)| d.trim()).filter(|d| !d.is_empty());
        ("failed", detail.map(redact::clean_text))
    } else if lower.starts_with("connected") || lower.starts_with("ok") {
        ("connected", None)
    } else {
        ("unknown", (!words.is_empty()).then(|| redact::clean_text(words)))
    };
    let mut server = Server::new(&name, source, transport, target);
    server.plugin = plugin;
    server.status = status;
    server.detail = detail;
    Some(server)
}

fn transport_of(kind: Option<&str>, fallback: &'static str) -> &'static str {
    match kind.map(str::to_ascii_lowercase).as_deref() {
        None | Some("") => fallback,
        Some("stdio") => "stdio",
        Some("http" | "streamable-http" | "streamable_http" | "streamablehttp") => "http",
        Some("sse") => "sse",
        Some(_) => "unknown",
    }
}

/// A server entry from a JSON or TOML config. Only `type`, `url`, `command`
/// and `args` are read; `env`, `headers` and the rest are never looked at.
pub(super) fn from_config(name: &str, source: &'static str, entry: &Value) -> Server {
    let kind = entry.get("type").or_else(|| entry.get("transport")).and_then(Value::as_str);
    let mut server = if let Some(url) = entry.get("url").and_then(Value::as_str) {
        Server::new(name, source, transport_of(kind, "http"), redact::clean_url(url))
    } else if let Some(command) = entry.get("command").and_then(Value::as_str) {
        let args: Vec<String> = entry
            .get("args")
            .and_then(Value::as_array)
            .map(|args| args.iter().filter_map(|a| a.as_str().map(str::to_owned)).collect())
            .unwrap_or_default();
        Server::new(name, source, transport_of(kind, "stdio"), redact::clean_command(command, &args))
    } else {
        Server::new(name, source, transport_of(kind, "unknown"), String::new())
    };
    if entry.get("enabled").and_then(Value::as_bool) == Some(false)
        || entry.get("disabled").and_then(Value::as_bool) == Some(true)
    {
        server.detail = Some("Turned off".to_owned());
    }
    server
}

fn servers_in(config: &Value, key: &str) -> Vec<(String, Value)> {
    config
        .get(key)
        .and_then(Value::as_object)
        .map(|servers| servers.iter().map(|(name, entry)| (name.clone(), entry.clone())).collect())
        .unwrap_or_default()
}

fn read_json(path: &Path, errors: &mut Vec<CatalogError>) -> Option<Value> {
    let text = read_capped(path, CONFIG_LIMIT)?;
    match serde_json::from_str(&text) {
        Ok(value) => Some(value),
        Err(_) => {
            errors.push(CatalogError { message: "{path} could not be read.", path: Some(path.display().to_string()) });
            None
        }
    }
}

fn same_dir(a: &str, b: &str) -> bool {
    let canonical = |p: &str| dunce::canonicalize(p).unwrap_or_else(|_| PathBuf::from(p));
    a.trim_end_matches('/') == b.trim_end_matches('/') || canonical(a) == canonical(b)
}

/// Everything read from files. `known` are the names `claude mcp list`
/// already gave, so the person's own servers are not shown twice.
fn file_sources(
    home: Option<&Path>,
    workspaces: &[(String, String, String)],
    known: &HashSet<String>,
    listed_ok: bool,
) -> (Vec<Server>, Vec<CatalogError>) {
    let mut servers = Vec::new();
    let mut errors = Vec::new();
    let mut seen_user: HashSet<String> = known.clone();
    if let Some(home) = home {
        // Claude Code's own settings: what `mcp list` could not report.
        if let Some(config) = read_json(&home.join(".claude.json"), &mut errors) {
            for (name, entry) in servers_in(&config, "mcpServers") {
                if seen_user.insert(name.clone()) {
                    let mut server = from_config(&name, "claude_user", &entry);
                    if listed_ok {
                        server.detail.get_or_insert_with(|| "Not reported by Claude Code".to_owned());
                    }
                    servers.push(server);
                }
            }
            // Servers added to one project only (local scope).
            if let Some(projects) = config.get("projects").and_then(Value::as_object) {
                for (path, project) in projects {
                    let Some((id, workspace_name, _)) = workspaces.iter().find(|(_, _, root)| same_dir(root, path))
                    else {
                        continue;
                    };
                    for (name, entry) in servers_in(project, "mcpServers") {
                        let mut server = from_config(&name, "claude_project", &entry);
                        server.workspace_id = Some(id.clone());
                        server.workspace_name = Some(workspace_name.clone());
                        servers.push(server);
                    }
                }
            }
        }
        if let Some(config) = read_json(&home.join(".claude/settings.json"), &mut errors) {
            for (name, entry) in servers_in(&config, "mcpServers") {
                if seen_user.insert(name.clone()) {
                    servers.push(from_config(&name, "claude_user", &entry));
                }
            }
        }
        let codex = home.join(".codex/config.toml");
        if let Some(text) = read_capped(&codex, CONFIG_LIMIT) {
            // A TOML error quotes the offending line, so it is never passed on.
            match text.parse::<toml::Table>().ok().and_then(|table| serde_json::to_value(table).ok()) {
                Some(config) => {
                    for (name, entry) in servers_in(&config, "mcp_servers") {
                        servers.push(from_config(&name, "codex", &entry));
                    }
                }
                None => errors.push(CatalogError {
                    message: "{path} could not be read.",
                    path: Some(codex.display().to_string()),
                }),
            }
        }
    }
    for (id, workspace_name, root) in workspaces {
        let path = Path::new(root).join(".mcp.json");
        if let Some(config) = read_json(&path, &mut errors) {
            for (name, entry) in servers_in(&config, "mcpServers") {
                let mut server = from_config(&name, "workspace", &entry);
                server.workspace_id = Some(id.clone());
                server.workspace_name = Some(workspace_name.clone());
                servers.push(server);
            }
        }
    }
    (servers, errors)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_claude_account_connectors() {
        let server = parse_list_line("claude.ai Google Drive: https://drivemcp.googleapis.com/mcp/v1 - ✔ Connected").unwrap();
        assert_eq!(server.name, "Google Drive");
        assert_eq!(server.source, "claude_account");
        assert_eq!(server.transport, "http");
        assert_eq!(server.target, "https://drivemcp.googleapis.com/mcp/v1");
        assert_eq!(server.status, "connected");
    }

    #[test]
    fn parses_plugin_servers_needing_auth_and_unconfigured() {
        let server =
            parse_list_line("plugin:marketing:canva: https://mcp.canva.com/mcp (HTTP) - ! Needs authentication").unwrap();
        assert_eq!((server.name.as_str(), server.plugin.as_deref()), ("canva", Some("marketing")));
        assert_eq!((server.status, server.transport), ("needs_auth", "http"));

        let server = parse_list_line("plugin:design:google calendar:  (HTTP) - - Not configured").unwrap();
        assert_eq!(server.name, "google calendar");
        assert_eq!(server.target, "");
        assert_eq!(server.status, "unknown");
        assert_eq!(server.detail.as_deref(), Some("Not configured"));
    }

    #[test]
    fn parses_failures_and_stdio_servers() {
        let server = parse_list_line(
            "plugin:data:definite: https://api.definite.app/mcp?k=1 (HTTP) - ✘ Failed to connect — MCP endpoint not found at https://api.definite.app/mcp?k=1. Check the URL.",
        )
        .unwrap();
        assert_eq!(server.status, "failed");
        assert_eq!(server.target, "https://api.definite.app/mcp");
        assert_eq!(server.detail.as_deref(), Some("MCP endpoint not found at https://api.definite.app/mcp. Check the URL."));

        let server = parse_list_line("otto: node /Users/me/mcp-otto/index.js --api-key s3cr3t - ✔ Connected").unwrap();
        assert_eq!((server.name.as_str(), server.source), ("otto", "claude_user"));
        assert_eq!(server.transport, "stdio");
        assert_eq!(server.target, "node /Users/me/mcp-otto/index.js --api-key ***");
    }

    #[test]
    fn ignores_other_lines() {
        assert!(parse_list_line("Checking MCP server health…").is_none());
        assert!(parse_list_line("").is_none());
        assert!(parse_list_line("No MCP servers configured. Use `claude mcp add` to add a server.").is_none());
    }

    #[test]
    fn config_entries_never_carry_env_or_headers() {
        let entry = json!({
            "command": "npx", "args": ["-y", "pkg", "--token", "abc"],
            "env": { "API_KEY": "very-secret" },
        });
        let server = from_config("x", "workspace", &entry);
        let text = serde_json::to_string(&server).unwrap();
        assert!(!text.contains("very-secret") && !text.contains("abc"));
        assert_eq!(server.target, "npx -y pkg --token ***");

        let entry = json!({ "type": "http", "url": "https://h.example/mcp?key=1", "headers": { "Authorization": "Bearer zz" } });
        let server = from_config("y", "codex", &entry);
        assert_eq!((server.transport, server.target.as_str()), ("http", "https://h.example/mcp"));
        assert!(!serde_json::to_string(&server).unwrap().contains("Bearer"));
    }

    #[test]
    fn reads_codex_and_workspace_configs() {
        let dir = std::env::temp_dir().join(format!("tendly-catalog-{}", uuid::Uuid::new_v4()));
        let home = dir.join("home");
        let project = dir.join("project");
        std::fs::create_dir_all(home.join(".codex")).unwrap();
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(
            home.join(".codex/config.toml"),
            "[mcp_servers.repl]\ncommand = \"node\"\nargs = [\"repl.js\"]\n[mcp_servers.repl.env]\nTOKEN = \"hide-me\"\n",
        )
        .unwrap();
        std::fs::write(home.join(".claude.json"), r#"{"mcpServers":{"mobbin":{"type":"http","url":"https://api.mobbin.com/mcp"},"extra":{"command":"x"}}}"#).unwrap();
        std::fs::write(project.join(".mcp.json"), r#"{"mcpServers":{"db":{"command":"psql-mcp","env":{"PW":"hide-me"}}}}"#)
            .unwrap();
        let workspaces = vec![("w1".to_owned(), "Proj".to_owned(), project.display().to_string())];
        let known: HashSet<String> = ["mobbin".to_owned()].into();
        let (servers, errors) = file_sources(Some(&home), &workspaces, &known, true);
        assert!(errors.is_empty());
        let names: Vec<(&str, &str)> = servers.iter().map(|s| (s.name.as_str(), s.source)).collect();
        assert_eq!(names, vec![("extra", "claude_user"), ("repl", "codex"), ("db", "workspace")]);
        assert_eq!(servers[2].workspace_id.as_deref(), Some("w1"));
        assert!(!serde_json::to_string(&servers).unwrap().contains("hide-me"));
        let _ = std::fs::remove_dir_all(dir);
    }
}
