//! Skills: `SKILL.md` folders from Claude Code (the person's own, installed
//! and synced plugins), from each workspace, and from Codex.
//!
//! Every place is read at a fixed depth (`<dir>/<skill>/SKILL.md`), so a
//! symlinked skill folder is followed once and a symlink loop cannot recurse.
use super::{home, read_capped};
use crate::{ApiError, AppState, Result, app::db};
use axum::{Json, extract::State};
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};

const SKILL_LIMIT: u64 = 64 * 1024;
/// Skill folders read from one directory at most.
const MAX_PER_DIR: usize = 500;
const MAX_DESCRIPTION: usize = 1200;

#[derive(Serialize, Debug, Clone)]
struct Skill {
    name: String,
    description: String,
    source: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    plugin: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    workspace_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    workspace_name: Option<String>,
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    rel_path: Option<String>,
}

pub(super) async fn list(State(state): State<AppState>) -> Result<Json<Value>> {
    let workspaces = db(&state, |s| s.list_workspaces()).await?;
    let skills = tokio::task::spawn_blocking(move || {
        let workspaces: Vec<(String, String, String)> =
            workspaces.into_iter().map(|w| (w.id.to_string(), w.name, w.root_path)).collect();
        collect(home().as_deref(), &workspaces)
    })
    .await
    .map_err(ApiError::internal)?;
    Ok(Json(json!({ "skills": skills })))
}

fn collect(home: Option<&Path>, workspaces: &[(String, String, String)]) -> Vec<Skill> {
    let mut skills = Vec::new();
    if let Some(home) = home {
        for (dir, skill) in skill_dirs(&home.join(".claude/skills")) {
            skills.push(read_skill(&dir, &skill, "claude_user", None));
        }
        let mut seen = HashSet::new();
        for (plugin, root) in plugin_roots(&home.join(".claude/plugins")) {
            for (dir, skill) in plugin_skill_dirs(&root) {
                let skill = read_skill(&dir, &skill, "claude_plugin", Some(plugin.clone()));
                if seen.insert((plugin.clone(), skill.name.clone())) {
                    skills.push(skill);
                }
            }
        }
        for (dir, skill) in skill_dirs(&home.join(".codex/skills")) {
            skills.push(read_skill(&dir, &skill, "codex", None));
        }
    }
    for (id, name, root) in workspaces {
        for (dir, folder) in skill_dirs(&Path::new(root).join(".claude/skills")) {
            let mut skill = read_skill(&dir, &folder, "workspace", None);
            skill.workspace_id = Some(id.clone());
            skill.workspace_name = Some(name.clone());
            skill.rel_path = Some(format!(".claude/skills/{folder}/SKILL.md"));
            skills.push(skill);
        }
    }
    skills
}

/// `(folder, folder name)` for each `<dir>/<name>/SKILL.md`, hidden folders skipped.
fn skill_dirs(dir: &Path) -> Vec<(PathBuf, String)> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut found: Vec<(PathBuf, String)> = entries
        .flatten()
        .take(MAX_PER_DIR * 2)
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let path = entry.path();
            (!name.starts_with('.') && path.join("SKILL.md").is_file()).then_some((path, name))
        })
        .take(MAX_PER_DIR)
        .collect();
    found.sort_by(|a, b| a.1.cmp(&b.1));
    found
}

fn read_skill(dir: &Path, folder: &str, source: &'static str, plugin: Option<String>) -> Skill {
    let path = dir.join("SKILL.md");
    let text = read_capped(&path, SKILL_LIMIT).unwrap_or_default();
    let fields = frontmatter(&text);
    let field = |key: &str| fields.iter().find(|(k, _)| k == key).map(|(_, v)| v.trim().to_owned());
    let name = field("name").filter(|n| !n.is_empty()).unwrap_or_else(|| folder.to_owned());
    let mut description = field("description").unwrap_or_default();
    if description.chars().count() > MAX_DESCRIPTION {
        description = description.chars().take(MAX_DESCRIPTION).collect::<String>() + "…";
    }
    Skill {
        name,
        description,
        source,
        plugin,
        workspace_id: None,
        workspace_name: None,
        path: path.display().to_string(),
        rel_path: None,
    }
}

fn manifest(root: &Path) -> Option<Value> {
    read_capped(&root.join(".claude-plugin/plugin.json"), SKILL_LIMIT)
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
}

/// A plugin's skills: the folders its manifest lists under `skills` (each a
/// skill, or a folder of skills), else `skills/*`. Paths outside the plugin
/// are ignored.
fn plugin_skill_dirs(root: &Path) -> Vec<(PathBuf, String)> {
    let listed: Vec<String> = match manifest(root).and_then(|m| m.get("skills").cloned()) {
        Some(Value::String(one)) => vec![one],
        Some(Value::Array(many)) => many.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect(),
        _ => return skill_dirs(&root.join("skills")),
    };
    let Ok(base) = dunce::canonicalize(root) else { return Vec::new() };
    let mut found = Vec::new();
    for entry in listed.iter().take(MAX_PER_DIR) {
        let Ok(dir) = dunce::canonicalize(root.join(entry)) else { continue };
        if !dir.starts_with(&base) {
            continue;
        }
        if dir.join("SKILL.md").is_file() {
            let name = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            found.push((dir, name));
        } else {
            found.extend(skill_dirs(&dir));
        }
    }
    found
}

/// The plugin's own name: its manifest, else its folder without the `~g2`-style suffix.
fn plugin_name(root: &Path, fallback: &str) -> String {
    manifest(root)
        .and_then(|manifest| manifest.get("name").and_then(Value::as_str).map(str::to_owned))
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| fallback.split('~').next().unwrap_or(fallback).to_owned())
}

/// Folders of the plugins Claude Code has installed (`installed_plugins.json`,
/// pointing into `cache/`), then plugins synced from claude.ai (`synced/*/*`).
/// Without the install list, the newest version of each plugin in `cache/`.
fn plugin_roots(plugins: &Path) -> Vec<(String, PathBuf)> {
    let mut roots = Vec::new();
    let installed = read_capped(&plugins.join("installed_plugins.json"), 4 * 1024 * 1024)
        .and_then(|text| serde_json::from_str::<Value>(&text).ok());
    match installed.as_ref().and_then(|v| v.get("plugins")).and_then(Value::as_object) {
        Some(list) => {
            for (key, installs) in list {
                let id = key.split('@').next().unwrap_or(key);
                for install in installs.as_array().into_iter().flatten() {
                    if let Some(path) = install.get("installPath").and_then(Value::as_str) {
                        let root = PathBuf::from(path);
                        if root.is_dir() {
                            roots.push((plugin_name(&root, id), root));
                        }
                    }
                }
            }
        }
        None => {
            for marketplace in subdirs(&plugins.join("cache")) {
                for plugin in subdirs(&marketplace) {
                    let mut versions = subdirs(&plugin);
                    versions.sort();
                    if let Some(latest) = versions.pop() {
                        let id = plugin.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                        roots.push((plugin_name(&latest, &id), latest));
                    }
                }
            }
        }
    }
    for account in subdirs(&plugins.join("synced")) {
        for plugin in subdirs(&account) {
            let id = plugin.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            roots.push((plugin_name(&plugin, &id), plugin));
        }
    }
    roots
}

fn subdirs(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    entries
        .flatten()
        .take(MAX_PER_DIR)
        .filter(|e| !e.file_name().to_string_lossy().starts_with('.'))
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect()
}

/// Top-level `key: value` pairs of a YAML front matter block. Enough YAML for
/// skill headers: plain, quoted and folded (`>`) or literal (`|`) values.
pub(super) fn frontmatter(text: &str) -> Vec<(String, String)> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut lines = text.lines();
    if lines.next().map(str::trim_end) != Some("---") {
        return Vec::new();
    }
    let block: Vec<&str> = lines.take_while(|l| !matches!(l.trim_end(), "---" | "...")).collect();
    let mut fields = Vec::new();
    let mut i = 0;
    while i < block.len() {
        let line = block[i];
        i += 1;
        if line.starts_with([' ', '\t']) || line.trim_start().starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once(':') else { continue };
        let key = key.trim().to_owned();
        let value = value.trim();
        // The indented lines that belong to this key.
        let start = i;
        while i < block.len() && (block[i].starts_with([' ', '\t']) || block[i].trim().is_empty()) {
            i += 1;
        }
        let more = &block[start..i];
        let value = if let Some(indicator) = value.strip_prefix(['>', '|']).map(|_| value.chars().next().unwrap()) {
            block_scalar(more, indicator == '>')
        } else if value.starts_with('"') || value.starts_with('\'') {
            let joined = std::iter::once(value).chain(more.iter().map(|l| l.trim())).collect::<Vec<_>>().join(" ");
            unquote(joined.trim())
        } else {
            let plain = strip_comment(value);
            std::iter::once(plain)
                .chain(more.iter().map(|l| l.trim()).filter(|l| !l.is_empty()))
                .filter(|l| !l.is_empty())
                .collect::<Vec<_>>()
                .join(" ")
        };
        fields.push((key, value));
    }
    fields
}

fn strip_comment(value: &str) -> &str {
    value.find(" #").map_or(value, |at| &value[..at]).trim()
}

fn block_scalar(lines: &[&str], folded: bool) -> String {
    let indent = lines
        .iter()
        .filter(|l| !l.trim().is_empty())
        .map(|l| l.len() - l.trim_start().len())
        .min()
        .unwrap_or(0);
    let lines: Vec<&str> = lines.iter().map(|l| l.get(indent..).unwrap_or("")).collect();
    if !folded {
        return lines.join("\n").trim_end().to_owned();
    }
    let mut out = String::new();
    for line in lines {
        if line.trim().is_empty() {
            out.push('\n');
        } else {
            if !out.is_empty() && !out.ends_with('\n') {
                out.push(' ');
            }
            out.push_str(line.trim_end());
        }
    }
    out.trim().to_owned()
}

fn unquote(value: &str) -> String {
    let quote = value.chars().next().unwrap_or('"');
    let inner = value.strip_prefix(quote).unwrap_or(value);
    let inner = inner.rfind(quote).map_or(inner, |end| &inner[..end]);
    if quote == '\'' {
        return inner.replace("''", "'");
    }
    let mut out = String::new();
    let mut chars = inner.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n') => out.push('\n'),
            Some('t') => out.push('\t'),
            Some(other) => out.push(other),
            None => {}
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn get(text: &str, key: &str) -> Option<String> {
        frontmatter(text).into_iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    #[test]
    fn plain_and_quoted_values() {
        let text = "---\nname: pdf-tools\ndescription: \"Read \\\"PDFs\\\": fast\"\n---\n# Body\nname: not this";
        assert_eq!(get(text, "name").as_deref(), Some("pdf-tools"));
        assert_eq!(get(text, "description").as_deref(), Some("Read \"PDFs\": fast"));
        let text = "---\nname: 'it''s'\ndescription: Plain words # a comment\n  that continue\n---\n";
        assert_eq!(get(text, "name").as_deref(), Some("it's"));
        assert_eq!(get(text, "description").as_deref(), Some("Plain words that continue"));
    }

    #[test]
    fn folded_and_literal_blocks() {
        let text = "---\nname: x\ndescription: >-\n  Go and find the reels\n  that work.\n\n  Second paragraph.\nlicense: MIT\n---\n";
        assert_eq!(get(text, "description").as_deref(), Some("Go and find the reels that work.\nSecond paragraph."));
        assert_eq!(get(text, "license").as_deref(), Some("MIT"));
        let text = "---\ndescription: |\n  line one\n  line two\n---\n";
        assert_eq!(get(text, "description").as_deref(), Some("line one\nline two"));
    }

    #[test]
    fn no_front_matter() {
        assert!(frontmatter("# Just a title\nname: x").is_empty());
        assert!(frontmatter("").is_empty());
        assert_eq!(get("\u{feff}---\r\nname: crlf\r\n---\r\n", "name").as_deref(), Some("crlf"));
    }

    #[test]
    fn manifest_lists_nested_skills() {
        let root = std::env::temp_dir().join(format!("tendly-plugin-{}", uuid::Uuid::new_v4()));
        for dir in ["skills/eng/tdd", "skills/prod/grill", "skills/prod/handoff"] {
            std::fs::create_dir_all(root.join(dir)).unwrap();
            std::fs::write(root.join(dir).join("SKILL.md"), "---\n---\n").unwrap();
        }
        std::fs::create_dir_all(root.join(".claude-plugin")).unwrap();
        std::fs::write(
            root.join(".claude-plugin/plugin.json"),
            r#"{"name":"p","skills":["./skills/eng/tdd","./skills/prod","../../etc"]}"#,
        )
        .unwrap();
        let names: Vec<String> = plugin_skill_dirs(&root).into_iter().map(|(_, n)| n).collect();
        assert_eq!(names, vec!["tdd", "grill", "handoff"]);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn collects_every_source() {
        let dir = std::env::temp_dir().join(format!("tendly-skills-{}", uuid::Uuid::new_v4()));
        let home = dir.join("home");
        let project = dir.join("project");
        let write = |path: PathBuf, text: &str| {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        };
        write(home.join(".claude/skills/mine/SKILL.md"), "---\nname: mine\ndescription: Mine.\n---\n");
        write(home.join(".claude/skills/bare/SKILL.md"), "# no header\n");
        let plugin = home.join(".claude/plugins/cache/market/tools/1.0.0");
        write(plugin.join("skills/lint/SKILL.md"), "---\nname: lint\n---\n");
        write(
            home.join(".claude/plugins/installed_plugins.json"),
            &json!({ "plugins": { "tools@market": [
                { "installPath": plugin.display().to_string() },
                { "installPath": plugin.display().to_string() },
            ] } })
            .to_string(),
        );
        write(home.join(".claude/plugins/synced/acct/design~g2/skills/ux/SKILL.md"), "---\nname: ux\n---\n");
        write(home.join(".codex/skills/cx/SKILL.md"), "---\nname: cx\n---\n");
        write(project.join(".claude/skills/local/SKILL.md"), "---\nname: Local one\n---\n");
        let workspaces = vec![("w1".to_owned(), "Proj".to_owned(), project.display().to_string())];
        let skills = collect(Some(&home), &workspaces);
        let summary: Vec<(String, &str, Option<String>)> =
            skills.iter().map(|s| (s.name.clone(), s.source, s.plugin.clone())).collect();
        assert_eq!(
            summary,
            vec![
                ("bare".to_owned(), "claude_user", None),
                ("mine".to_owned(), "claude_user", None),
                ("lint".to_owned(), "claude_plugin", Some("tools".to_owned())),
                ("ux".to_owned(), "claude_plugin", Some("design".to_owned())),
                ("cx".to_owned(), "codex", None),
                ("Local one".to_owned(), "workspace", None),
            ]
        );
        let local = skills.last().unwrap();
        assert_eq!(local.rel_path.as_deref(), Some(".claude/skills/local/SKILL.md"));
        assert_eq!(local.workspace_id.as_deref(), Some("w1"));
        let _ = std::fs::remove_dir_all(dir);
    }
}
