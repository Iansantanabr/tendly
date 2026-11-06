//! The 1Password vaults the `op` CLI on this machine can see. Read only and
//! names only.
//!
//! This module runs three commands and no other: `op --version`,
//! `op whoami --format json` and `op vault list --format json`. It never
//! asks for an item or a field, never takes or stores a token (a service
//! account's token is read by `op` itself from the server's environment),
//! and what `op` writes to its error stream is never read.
use axum::{Json, extract::Query};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

/// The only commands this module may run.
const VERSION: &[&str] = &["--version"];
const WHOAMI: &[&str] = &["whoami", "--format", "json"];
const VAULT_LIST: &[&str] = &["vault", "list", "--format", "json"];

const QUICK: Duration = Duration::from_secs(8);
/// Listing after the person asked for it may wait for them to approve it in
/// the 1Password app.
const APPROVAL: Duration = Duration::from_secs(45);
const MAX_VAULTS: usize = 200;
const NAME_CHARS: usize = 120;

#[derive(Serialize, Debug, PartialEq, Default)]
pub(super) struct Vault {
    installed: bool,
    /// `macos`, `linux` or `other`: which install steps the page shows.
    platform: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<String>,
    signed_in: bool,
    /// The account's sign-in address (`my.1password.com`), never the e-mail.
    #[serde(skip_serializing_if = "Option::is_none")]
    account: Option<String>,
    service_account: bool,
    /// Whether the vaults were asked for; they are not when nobody is signed
    /// in and the person did not ask.
    listed: bool,
    vaults: Vec<String>,
    /// A fixed English sentence the page translates.
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<&'static str>,
}

fn platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "macos",
        "linux" => "linux",
        _ => "other",
    }
}

fn find_op() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).map(|dir| dir.join("op")).collect())
        .unwrap_or_default();
    for known in ["/opt/homebrew/bin/op", "/usr/local/bin/op", "/usr/bin/op"] {
        candidates.push(known.into());
    }
    candidates.into_iter().find(|path| path.is_file())
}

/// Runs one of the allowed commands: whether it succeeded and what it printed.
/// Nothing is typed into it, and its error stream goes nowhere.
async fn run(op: &Path, args: &'static [&'static str], limit: Duration) -> Option<(bool, String)> {
    debug_assert!([VERSION, WHOAMI, VAULT_LIST].contains(&args));
    let child = tokio::process::Command::new(op)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .ok()?;
    let output = tokio::time::timeout(limit, child.wait_with_output()).await.ok()?.ok()?;
    Some((output.status.success(), String::from_utf8_lossy(&output.stdout).into_owned()))
}

/// `2.30.3` from what `op --version` prints.
pub(super) fn version_of(text: &str) -> Option<String> {
    let line = text.lines().next()?.trim();
    let version: String =
        line.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-')).take(32).collect();
    (!version.is_empty()).then_some(version)
}

/// The sign-in address and whether it is a service account, from `op whoami`.
/// The e-mail and the ids in the same answer are not read.
pub(super) fn account_of(text: &str) -> Option<(Option<String>, bool)> {
    let value: Value = serde_json::from_str(text).ok()?;
    let object = value.as_object()?;
    let host = object
        .get("url")
        .and_then(Value::as_str)
        .and_then(|raw| url::Url::parse(raw).ok())
        .and_then(|url| url.host_str().map(str::to_owned));
    let kind = ["user_type", "ServiceAccountType"]
        .iter()
        .filter_map(|key| object.get(*key).and_then(Value::as_str))
        .any(|kind| kind.eq_ignore_ascii_case("service_account"));
    Some((host, kind))
}

/// The vault names from `op vault list --format json`, sorted. Only `name`
/// is read from each entry.
pub(super) fn vaults_of(text: &str) -> Option<Vec<String>> {
    let value: Value = serde_json::from_str(text).ok()?;
    let mut names: Vec<String> = value
        .as_array()?
        .iter()
        .filter_map(|vault| vault.get("name").and_then(Value::as_str))
        .map(|name| name.trim().chars().take(NAME_CHARS).collect::<String>())
        .filter(|name| !name.is_empty())
        .collect();
    names.sort_by_key(|name| name.to_lowercase());
    names.dedup();
    names.truncate(MAX_VAULTS);
    Some(names)
}

/// What `op` at this path can see. Without `unlock`, the vaults are listed
/// only when someone is already signed in, so opening the page never makes
/// 1Password ask for approval on its own.
pub(super) async fn inspect(op: &Path, unlock: bool) -> Vault {
    let mut vault = Vault { installed: true, platform: platform(), ..Vault::default() };
    vault.version = run(op, VERSION, QUICK).await.and_then(|(_, text)| version_of(&text));
    let whoami = |text: &str, vault: &mut Vault| {
        if let Some((account, service)) = account_of(text) {
            vault.signed_in = true;
            vault.account = account;
            vault.service_account = service;
        }
    };
    if let Some((true, text)) = run(op, WHOAMI, QUICK).await {
        whoami(&text, &mut vault);
    }
    if !vault.signed_in && !unlock {
        return vault;
    }
    vault.listed = true;
    let limit = if vault.signed_in { QUICK } else { APPROVAL };
    match run(op, VAULT_LIST, limit).await {
        Some((true, text)) => match vaults_of(&text) {
            Some(names) => {
                vault.vaults = names;
                if !vault.signed_in {
                    // Approved just now: say whose vaults these are.
                    vault.signed_in = true;
                    if let Some((true, text)) = run(op, WHOAMI, QUICK).await {
                        whoami(&text, &mut vault);
                    }
                }
            }
            None => vault.error = Some("1Password answered in a form Tendly does not understand."),
        },
        Some((false, _)) if vault.signed_in => vault.error = Some("1Password could not list the vaults."),
        Some((false, _)) => vault.error = Some("1Password did not sign in. Approve the request in the 1Password app, or sign in with a service account."),
        None => vault.error = Some("1Password took too long to answer."),
    }
    vault
}

#[derive(Deserialize)]
pub(super) struct VaultQuery {
    unlock: Option<String>,
}

pub(super) async fn show(Query(query): Query<VaultQuery>) -> Json<Vault> {
    let unlock = matches!(query.unlock.as_deref(), Some("1" | "true" | "yes"));
    Json(match find_op() {
        Some(op) => inspect(&op, unlock).await,
        None => Vault { platform: platform(), ..Vault::default() },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hub_vault_reads_only_names_from_what_op_prints() {
        assert_eq!(version_of("2.30.3\n").as_deref(), Some("2.30.3"));
        assert_eq!(version_of("2.31.0-beta.01 (extra)\nmore").as_deref(), Some("2.31.0-beta.01extra"));
        assert_eq!(version_of("\n"), None);

        let person = r#"{"url":"https://my.1password.com","email":"me@example.com","user_uuid":"U1","account_uuid":"A1"}"#;
        assert_eq!(account_of(person), Some((Some("my.1password.com".into()), false)));
        let service = r#"{"url":"https://team.1password.eu","integration_id":"I1","user_type":"SERVICE_ACCOUNT"}"#;
        assert_eq!(account_of(service), Some((Some("team.1password.eu".into()), true)));
        assert_eq!(account_of("{}"), Some((None, false)));
        assert_eq!(account_of("[ERROR] not signed in"), None);

        let list = r#"[{"id":"v2","name":"Shared","content_version":4},{"id":"v1","name":" private "},{"id":"v3"},{"id":"v4","name":""},{"id":"v5","name":"Shared"}]"#;
        assert_eq!(vaults_of(list), Some(vec!["private".to_owned(), "Shared".to_owned()]));
        assert_eq!(vaults_of("[]"), Some(vec![]));
        assert_eq!(vaults_of("not json"), None);
        assert_eq!(vaults_of(r#"{"name":"x"}"#), None);
        let many: Vec<Value> = (0..300).map(|i| serde_json::json!({ "name": format!("v{i:03}") })).collect();
        assert_eq!(vaults_of(&Value::Array(many).to_string()).unwrap().len(), MAX_VAULTS);
    }

    #[test]
    fn hub_vault_module_runs_three_commands_and_no_other() {
        // Reading an item, a field or a document, or signing in with a token
        // typed here, is not something this file can do.
        let source = include_str!("vault.rs");
        let code = source.split("#[cfg(test)]").next().unwrap();
        for forbidden in ["\"item\"", "\"read\"", "\"inject\"", "\"document\"", "\"signin\"", "\"run\"", "--reveal", "OP_SERVICE_ACCOUNT_TOKEN", "OP_SESSION", ".env("] {
            assert!(!code.contains(forbidden), "{forbidden}");
        }
        assert_eq!(code.matches(".args(").count(), 1);
        assert_eq!(code.matches("Command::new").count(), 1);
        // The error stream, where a CLI may echo what it was given, is never read.
        assert!(code.contains(".stderr(Stdio::null())") && !code.contains("output.stderr"));
    }

    #[cfg(unix)]
    mod with_a_stand_in {
        use super::*;
        use std::os::unix::fs::PermissionsExt;

        /// A stand-in `op` that notes every call beside itself.
        fn stand_in(whoami: &str, vaults: &str) -> (PathBuf, PathBuf) {
            let dir = std::env::temp_dir().join(format!("hub-vault-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            let op = dir.join("op");
            let script = format!(
                "#!/bin/sh\necho \"$*\" >> \"$0.calls\"\ncase \"$1\" in\n  --version) echo 2.30.3 ;;\n  whoami) {whoami} ;;\n  vault) {vaults} ;;\n  *) echo SECRET-ITEM-VALUE ;;\nesac\n"
            );
            std::fs::write(&op, script).unwrap();
            std::fs::set_permissions(&op, std::fs::Permissions::from_mode(0o755)).unwrap();
            (dir, op)
        }

        fn calls(op: &Path) -> Vec<String> {
            std::fs::read_to_string(op.with_file_name("op.calls"))
                .unwrap_or_default()
                .lines()
                .map(str::to_owned)
                .collect()
        }

        #[tokio::test]
        async fn hub_vault_signed_in_lists_vault_names() {
            let (dir, op) = stand_in(
                r#"echo '{"url":"https://my.1password.com","email":"me@example.com","user_type":"SERVICE_ACCOUNT"}'"#,
                r#"echo '[{"id":"a","name":"Servers"},{"id":"b","name":"Clients"}]'"#,
            );
            let vault = inspect(&op, false).await;
            assert_eq!(
                vault,
                Vault {
                    installed: true,
                    platform: platform(),
                    version: Some("2.30.3".into()),
                    signed_in: true,
                    account: Some("my.1password.com".into()),
                    service_account: true,
                    listed: true,
                    vaults: vec!["Clients".into(), "Servers".into()],
                    error: None,
                }
            );
            let sent = serde_json::to_string(&vault).unwrap();
            assert!(!sent.contains("me@example.com") && !sent.contains("SECRET"), "{sent}");
            assert_eq!(calls(&op), ["--version", "whoami --format json", "vault list --format json"]);
            std::fs::remove_dir_all(dir).ok();
        }

        #[tokio::test]
        async fn hub_vault_signed_out_does_not_ask_until_told_to() {
            let (dir, op) = stand_in("exit 1", r#"echo '[{"id":"a","name":"Private"}]'"#);
            let vault = inspect(&op, false).await;
            assert!(vault.installed && !vault.signed_in && !vault.listed && vault.vaults.is_empty());
            assert_eq!(vault.error, None);
            // Opening the page asked for nothing that needs approval.
            assert_eq!(calls(&op), ["--version", "whoami --format json"]);

            // The person asked: the list runs, and what it returns is shown.
            let vault = inspect(&op, true).await;
            assert!(vault.signed_in && vault.listed);
            assert_eq!(vault.vaults, ["Private"]);
            assert!(calls(&op).contains(&"vault list --format json".to_owned()));
            std::fs::remove_dir_all(dir).ok();
        }

        #[tokio::test]
        async fn hub_vault_refusals_and_odd_answers_are_plain_errors() {
            let (dir, op) = stand_in("exit 1", "echo 'not signed in' >&2; exit 1");
            let vault = inspect(&op, true).await;
            assert!(!vault.signed_in && vault.vaults.is_empty());
            assert!(vault.error.unwrap().starts_with("1Password did not sign in."));
            std::fs::remove_dir_all(dir).ok();

            let (dir, op) = stand_in(r#"echo '{"url":"https://my.1password.com"}'"#, "echo 'Vaults: none'");
            let vault = inspect(&op, false).await;
            assert!(vault.signed_in);
            assert_eq!(vault.error, Some("1Password answered in a form Tendly does not understand."));
            std::fs::remove_dir_all(dir).ok();
        }
    }
}
