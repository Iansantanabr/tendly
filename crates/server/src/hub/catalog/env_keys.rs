//! Variable names found in the `.env` files of each workspace, so the keys
//! that live only in a file on this machine can be seen in one place.
//!
//! Names only. A file is read one byte at a time: the bytes before `=` are
//! the name, and everything after it is skipped to the end of the value
//! without ever being put in a string, returned or logged.
use super::redact;
use crate::{ApiError, AppState, Result, app::db, hub::history, workspace_io};
use axum::{Json, extract::State};
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    io::{BufReader, Read},
    path::{Path, PathBuf},
};

/// How deep below the workspace root files are looked for.
const MAX_DEPTH: usize = 6;
/// Directory entries looked at in one workspace before the scan gives up.
const MAX_ENTRIES: usize = 20_000;
const MAX_FILES: usize = 40;
const MAX_NAMES: usize = 200;
const FILE_LIMIT: u64 = 256 * 1024;
const NAME_LIMIT: usize = 80;
/// Files that document variables rather than hold them.
const TEMPLATES: &[&str] = &["example", "sample", "template", "dist", "defaults"];

#[derive(Serialize, Debug, PartialEq, Clone)]
pub(super) struct EnvName {
    name: String,
    /// The name reads like a credential (`…_TOKEN`, `…_KEY`, `…SECRET…`).
    secret: bool,
}

#[derive(Serialize, Debug, PartialEq, Clone)]
pub(super) struct EnvFile {
    /// Relative to the workspace root.
    path: String,
    names: Vec<EnvName>,
}

/// `.env` and `.env.<something>`, but not the templates that hold no value
/// (`.env.example`) and not `.envrc`, which is a shell script.
pub(super) fn is_env_file(name: &str) -> bool {
    let Some(rest) = name.strip_prefix(".env") else { return false };
    if rest.is_empty() {
        return true;
    }
    let Some(rest) = rest.strip_prefix('.') else { return false };
    !rest.is_empty() && !rest.split('.').any(|part| TEMPLATES.contains(&part.to_ascii_lowercase().as_str()))
}

fn skipped_dir(name: &str) -> bool {
    name.starts_with('.') || history::BUILD_DIRS.contains(&name)
}

/// The `.env` files of a workspace, relative to its root and sorted, and
/// whether the scan stopped early. Links are not followed; dot-directories,
/// dependency and build output and protected folders are not entered.
pub(super) fn env_files(root: &Path) -> (Vec<PathBuf>, bool) {
    let mut found = Vec::new();
    let mut entries = 0usize;
    let mut truncated = false;
    let mut stack = vec![(PathBuf::new(), 0usize)];
    'walk: while let Some((relative, depth)) = stack.pop() {
        let Ok(read) = std::fs::read_dir(root.join(&relative)) else { continue };
        for entry in read.flatten() {
            entries += 1;
            if entries > MAX_ENTRIES {
                truncated = true;
                break 'walk;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            let Ok(kind) = entry.file_type() else { continue };
            let child = relative.join(&name);
            if kind.is_dir() {
                if depth < MAX_DEPTH && !skipped_dir(&name) && !workspace_io::is_protected_path(&child) {
                    stack.push((child, depth + 1));
                }
            } else if kind.is_file() && is_env_file(&name) {
                found.push(child);
            }
        }
    }
    found.sort();
    if found.len() > MAX_FILES {
        found.truncate(MAX_FILES);
        truncated = true;
    }
    (found, truncated)
}

/// A variable name as a dotenv line may start: `NAME`, or `export NAME`.
fn name_of(head: &str) -> Option<&str> {
    let head = head.trim();
    let head = head.strip_prefix("export").filter(|rest| rest.starts_with([' ', '\t'])).map_or(head, str::trim_start);
    let mut chars = head.chars();
    let first = chars.next()?;
    let valid = (first.is_ascii_alphabetic() || first == '_')
        && head.len() <= NAME_LIMIT
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_');
    (valid && !key_material(head)).then_some(head)
}

/// A long run of letters and digits in mixed case with no underscore, as a
/// wrapped line of a key has: not what anyone names a variable.
fn key_material(head: &str) -> bool {
    head.len() >= 20
        && !head.contains('_')
        && head.chars().any(|c| c.is_ascii_uppercase())
        && head.chars().any(|c| c.is_ascii_lowercase())
        && head.chars().any(|c| c.is_ascii_digit())
}

/// Where the reader is in a dotenv text.
enum At {
    /// Before the `=` of a line.
    Head,
    /// Right after `=`: a quote here opens a value that may span lines.
    ValueStart,
    /// In a value (or a comment) that ends with the line.
    Rest,
    /// In a quoted value, until its closing quote; `bool` = after a backslash.
    Quoted(u8, bool),
}

/// The variable names a dotenv text assigns, in order, each once. No byte of
/// a value is kept: after `=` the reader only looks for where the value ends.
pub(super) fn names_in(reader: impl Read) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    let mut seen = HashSet::new();
    let mut head = String::new();
    let mut at = At::Head;
    for byte in BufReader::new(reader).bytes() {
        let Ok(byte) = byte else { break };
        at = match (at, byte) {
            (At::Quoted(quote, false), found) if found == quote => At::Rest,
            (At::Quoted(quote, escaped), found) => At::Quoted(quote, quote == b'"' && !escaped && found == b'\\'),
            (_, b'\n' | b'\r') => {
                head.clear();
                At::Head
            }
            (At::Head, b'=') => {
                if let Some(name) = name_of(&head)
                    && names.len() < MAX_NAMES
                    && seen.insert(name.to_owned())
                {
                    names.push(name.to_owned());
                }
                head.clear();
                At::ValueStart
            }
            (At::Head, b'#') if head.trim().is_empty() => At::Rest,
            (At::Head, _) if head.len() > NAME_LIMIT + 16 => At::Rest,
            (At::Head, other) => {
                // Anything that is not plain ASCII can not be part of a name.
                head.push(if other.is_ascii() { other as char } else { '\u{fffd}' });
                At::Head
            }
            (At::ValueStart, b' ' | b'\t') => At::ValueStart,
            (At::ValueStart, quote @ (b'"' | b'\'' | b'`')) => At::Quoted(quote, false),
            (At::ValueStart | At::Rest, _) => At::Rest,
        };
    }
    names
}

fn read_names(path: &Path) -> Vec<EnvName> {
    let Ok(file) = std::fs::File::open(path) else { return Vec::new() };
    names_in(file.take(FILE_LIMIT))
        .into_iter()
        .map(|name| EnvName { secret: redact::secret_name(&name), name })
        .collect()
}

/// The folder of a file, as `git check-ignore` is asked about it.
fn folder_of(file: &Path) -> Option<String> {
    let parent = file.parent()?.to_str()?.replace('\\', "/");
    (!parent.is_empty()).then(|| format!("{parent}/"))
}

/// The `.env` files of one workspace with the names each assigns. Files in a
/// folder the repository ignores are left out; the files themselves are
/// expected to be ignored, so they are not asked about.
pub(super) async fn scan(root: PathBuf) -> (Vec<EnvFile>, bool) {
    let walk_root = root.clone();
    let Ok((files, truncated)) = tokio::task::spawn_blocking(move || env_files(&walk_root)).await else {
        return (Vec::new(), false);
    };
    let mut folders: Vec<String> = files.iter().filter_map(|file| folder_of(file)).collect();
    folders.dedup();
    let ignored = history::git_ignored(&root, &folders).await;
    let read = tokio::task::spawn_blocking(move || {
        files
            .into_iter()
            .filter(|file| folder_of(file).is_none_or(|folder| !ignored.contains(&folder)))
            .filter_map(|file| {
                let names = read_names(&root.join(&file));
                let path = file.to_str()?.replace('\\', "/");
                (!names.is_empty()).then_some(EnvFile { path, names })
            })
            .collect::<Vec<_>>()
    })
    .await
    .unwrap_or_default();
    (read, truncated)
}

pub(super) async fn list(State(state): State<AppState>) -> Result<Json<Value>> {
    let workspaces = db(&state, |s| s.list_workspaces()).await?;
    let mut out = Vec::new();
    for workspace in workspaces {
        let root = PathBuf::from(&workspace.root_path);
        let Ok(root) = tokio::task::spawn_blocking(move || dunce::canonicalize(root)).await.map_err(ApiError::internal)?
        else {
            continue;
        };
        let (files, truncated) = scan(root).await;
        if files.is_empty() {
            continue;
        }
        out.push(json!({
            "workspace_id": workspace.id,
            "workspace_name": workspace.name,
            "files": files,
            "truncated": truncated,
        }));
    }
    Ok(Json(json!({ "workspaces": out })))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hub-env-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dunce::canonicalize(dir).unwrap()
    }

    fn write(root: &Path, path: &str, content: &str) {
        let target = root.join(path);
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::write(target, content).unwrap();
    }

    #[test]
    fn hub_env_keys_file_names() {
        for yes in [".env", ".env.local", ".env.production", ".env.development.local"] {
            assert!(is_env_file(yes), "{yes}");
        }
        for no in [".envrc", ".env.example", ".env.sample", ".env.local.example", ".env.Template", "env", "prod.env", ".env.", ".environment"] {
            assert!(!is_env_file(no), "{no}");
        }
    }

    #[test]
    fn hub_env_keys_names_are_read_and_values_never() {
        let text = concat!(
            "# OPENAI_API_KEY=commented-out\n",
            "OPENAI_API_KEY=sk-live-VALUE-ONE\n",
            "export  GITHUB_TOKEN = \"VALUE-TWO\"\r\n",
            "\n",
            "PORT=3000\n",
            "OPENAI_API_KEY=VALUE-THREE-again\n",
            "  spaced_name=VALUE=WITH=EQUALS\n",
            "not a name=VALUE-FOUR\n",
            "1BAD=VALUE-FIVE\n",
            "dotted.name=VALUE-SIX\n",
            "EMPTY=\n",
            "LAST_ONE=VALUE-SEVEN",
        );
        let names = names_in(text.as_bytes());
        assert_eq!(names, ["OPENAI_API_KEY", "GITHUB_TOKEN", "PORT", "spaced_name", "EMPTY", "LAST_ONE"]);
        assert!(!names.join(" ").contains("VALUE"));
    }

    #[test]
    fn hub_env_keys_a_value_over_several_lines_gives_no_name() {
        // A private key wrapped in quotes: its base64 lines end in `=` and
        // would read as assignments if the quote were not followed.
        let text = concat!(
            "PRIVATE_KEY=\"-----BEGIN PRIVATE KEY-----\n",
            "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC=\n",
            "abc123==\n",
            "said \\\" still inside\n",
            "INSIDE=not-a-name\n",
            "-----END PRIVATE KEY-----\"\n",
            "AFTER='single\nSTILL_INSIDE=x\n'\n",
            "DONE=1\n",
        );
        assert_eq!(names_in(text.as_bytes()), ["PRIVATE_KEY", "AFTER", "DONE"]);
        // A quote that never closes hides the rest of the file rather than guess.
        assert_eq!(names_in("A=\"open\nB=1\nC=2\n".as_bytes()), ["A"]);
        // Something that reads like a key is not reported as a name, wherever it sits.
        assert_eq!(names_in("Zk3j9Qm2Lp8Xv7Rt5Wn1Yb4Hc6=\nOK=1\n".as_bytes()), ["OK"]);
        // Ordinary long names, and names that start like a token prefix, are kept.
        assert_eq!(
            names_in("NPM_TOKEN=x\nAWS_S3_BUCKET_NAME_PRODUCTION=y\nNEXT_PUBLIC_SUPABASE_ANON_KEY_V2=z\n".as_bytes()),
            ["NPM_TOKEN", "AWS_S3_BUCKET_NAME_PRODUCTION", "NEXT_PUBLIC_SUPABASE_ANON_KEY_V2"]
        );
        // Long lines and bytes that are not text end nothing early.
        let mut noisy = vec![0xff, 0xfe, b'=', b'x', b'\n'];
        noisy.extend_from_slice("x".repeat(500).as_bytes());
        noisy.extend_from_slice(b"=1\nREAL=2\n");
        assert_eq!(names_in(noisy.as_slice()), ["REAL"]);
        // At most 200 names from one file.
        let many: String = (0..300).map(|i| format!("N{i}=1\n")).collect();
        assert_eq!(names_in(many.as_bytes()).len(), MAX_NAMES);
    }

    #[tokio::test]
    async fn hub_env_keys_scan_skips_dependencies_templates_and_ignored_folders() {
        let root = temp();
        write(&root, ".env", "API_KEY=one\nPORT=1\n");
        write(&root, ".env.example", "API_KEY=\n");
        write(&root, "apps/web/.env.local", "NEXT_PUBLIC_URL=x\nSESSION_SECRET=two\n");
        write(&root, "node_modules/pkg/.env", "IN_DEPENDENCY=1\n");
        write(&root, ".cache/.env", "IN_DOT_DIR=1\n");
        write(&root, "secrets/.env", "IN_PROTECTED=1\n");
        write(&root, "scratch/.env", "IN_IGNORED_FOLDER=1\n");
        write(&root, "empty/.env", "# nothing here\n");
        write(&root, "a/b/c/d/e/f/g/.env", "TOO_DEEP=1\n");
        #[cfg(unix)]
        std::os::unix::fs::symlink(root.join("apps"), root.join("linked")).unwrap();
        let git = |args: &[&str]| {
            std::process::Command::new("git").args(args).current_dir(&root).output().unwrap();
        };
        git(&["init", "-q"]);
        write(&root, ".gitignore", ".env*\nscratch/\n");
        let (files, truncated) = scan(root.clone()).await;
        assert!(!truncated);
        let listed: Vec<(&str, Vec<(&str, bool)>)> = files
            .iter()
            .map(|f| (f.path.as_str(), f.names.iter().map(|n| (n.name.as_str(), n.secret)).collect()))
            .collect();
        assert_eq!(
            listed,
            vec![
                (".env", vec![("API_KEY", true), ("PORT", false)]),
                ("apps/web/.env.local", vec![("NEXT_PUBLIC_URL", false), ("SESSION_SECRET", true)]),
            ]
        );
        let text = serde_json::to_string(&files).unwrap();
        assert!(!text.contains("one") && !text.contains("two"), "{text}");
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn hub_env_keys_scan_stops_at_its_limits() {
        let root = temp();
        for i in 0..(MAX_FILES + 5) {
            write(&root, &format!("svc{i:03}/.env"), "A=1\n");
        }
        let (files, truncated) = env_files(&root);
        assert_eq!(files.len(), MAX_FILES);
        assert!(truncated);
        assert_eq!(files[0], PathBuf::from("svc000/.env"));
        std::fs::remove_dir_all(root).ok();
    }
}
