//! What the catalog shows of an MCP server's launch line: enough to recognise
//! it, never a secret. Env values and headers are never read out at all;
//! arguments and URLs pass through here first.

const HIDDEN: &str = "***";

/// Flag or variable names whose value is a credential.
fn secret_name(name: &str) -> bool {
    let name = name.trim_start_matches('-').to_ascii_lowercase();
    if name.is_empty() {
        return false;
    }
    const WORDS: &[&str] = &[
        "token", "secret", "passw", "apikey", "api-key", "api_key", "auth", "bearer", "credential", "private",
        "cookie", "session", "signature",
    ];
    WORDS.iter().any(|word| name.contains(word)) || name.ends_with("key") || name.ends_with("pat")
}

/// A value that reads like a credential on its own: a known token prefix, or
/// a long run of letters and digits with nothing path- or name-like about it.
pub(super) fn secret_value(value: &str) -> bool {
    const PREFIXES: &[&str] = &[
        "sk-", "sk_", "pk_live", "rk_live", "ghp_", "gho_", "ghs_", "ghu_", "github_pat_", "glpat-", "xox", "akia",
        "aiza", "eyj", "ya29.", "shpat_", "bearer ", "basic ", "npm_", "hf_",
    ];
    let lower = value.to_ascii_lowercase();
    if PREFIXES.iter().any(|prefix| lower.starts_with(prefix)) && value.len() > 8 {
        return true;
    }
    value.len() >= 24
        && value.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        && value.chars().any(|c| c.is_ascii_digit())
        && value.chars().any(|c| c.is_ascii_alphabetic())
}

/// A URL without its user, password, query or fragment, and with any path
/// segment that looks like a key hidden.
pub(super) fn clean_url(raw: &str) -> String {
    match url::Url::parse(raw) {
        Ok(mut url) if url.has_host() => {
            let _ = url.set_username("");
            let _ = url.set_password(None);
            url.set_query(None);
            url.set_fragment(None);
            let path: Vec<String> = url
                .path_segments()
                .map(|segments| {
                    segments.map(|s| if secret_value(s) { HIDDEN.to_owned() } else { s.to_owned() }).collect()
                })
                .unwrap_or_default();
            url.set_path(&path.join("/"));
            url.to_string()
        }
        _ => {
            let base = raw.split(['?', '#']).next().unwrap_or("");
            let base = match base.split_once("://") {
                Some((scheme, rest)) => format!("{scheme}://{}", rest.rsplit_once('@').map_or(rest, |(_, host)| host)),
                None => base.to_owned(),
            };
            base.split('/').map(|s| if secret_value(s) { HIDDEN } else { s }).collect::<Vec<_>>().join("/")
        }
    }
}

fn clean_word(word: &str) -> String {
    if word.contains("://") {
        return clean_url(word);
    }
    // `NAME=value`, as `env` or a shell would take it.
    if let Some((name, _)) = word.split_once('=')
        && !name.starts_with('-')
        && !name.is_empty()
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
    {
        return format!("{name}={HIDDEN}");
    }
    if secret_value(word) { HIDDEN.to_owned() } else { word.to_owned() }
}

/// `command arg…` with credentials hidden: values of flags such as `--token`,
/// `NAME=value` assignments, and anything that looks like a key on its own.
pub(super) fn clean_command(command: &str, args: &[String]) -> String {
    let mut out = vec![clean_word(command)];
    let mut hide_next = false;
    for arg in args {
        if hide_next {
            hide_next = false;
            if !arg.starts_with('-') {
                out.push(HIDDEN.to_owned());
                continue;
            }
        }
        if arg.starts_with('-') {
            if let Some((flag, _)) = arg.split_once('=') {
                if secret_name(flag) {
                    out.push(format!("{flag}={HIDDEN}"));
                    continue;
                }
            } else if secret_name(arg) {
                hide_next = true;
            }
        }
        out.push(clean_word(arg));
    }
    out.join(" ")
}

/// A launch line as one string (as `claude mcp list` prints it).
pub(super) fn clean_command_line(line: &str) -> String {
    let mut words = line.split_whitespace();
    let Some(command) = words.next() else { return String::new() };
    let args: Vec<String> = words.map(str::to_owned).collect();
    clean_command(command, &args)
}

/// Free text from a tool (an error message): URLs reduced, keys hidden.
pub(super) fn clean_text(text: &str) -> String {
    text.split(' ')
        .map(|word| {
            if word.contains("://") {
                let trimmed = word.trim_end_matches(['.', ',', ';', ')']);
                format!("{}{}", clean_url(trimmed), &word[trimmed.len()..])
            } else if secret_value(word.trim_end_matches(['.', ',', ';', ')'])) {
                HIDDEN.to_owned()
            } else {
                word.to_owned()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn hides_flag_values_and_assignments() {
        assert_eq!(
            clean_command("npx", &args(&["-y", "@acme/mcp@latest", "--api-key", "abc123", "--verbose"])),
            "npx -y @acme/mcp@latest --api-key *** --verbose"
        );
        assert_eq!(clean_command("server", &args(&["--token=xyz", "--port=8080"])), "server --token=*** --port=8080");
        assert_eq!(clean_command("env", &args(&["GITHUB_TOKEN=ghp_x", "node", "a.js"])), "env GITHUB_TOKEN=*** node a.js");
        assert_eq!(clean_command("node", &args(&["/Users/me/mcp/index.js"])), "node /Users/me/mcp/index.js");
    }

    #[test]
    fn hides_values_that_look_like_keys() {
        assert_eq!(clean_command_line("tool sk-ant-api03-abcdefgh run"), "tool *** run");
        assert_eq!(clean_command_line("tool Zk3j9Qm2Lp8Xv7Rt5Wn1Yb4Hc6"), "tool ***");
        assert!(!secret_value("@modelcontextprotocol/server-pdf"));
        assert!(!secret_value("--stdio"));
    }

    #[test]
    fn urls_lose_credentials_and_queries() {
        assert_eq!(clean_url("https://user:pw@mcp.example.com/sse?key=abc#x"), "https://mcp.example.com/sse");
        assert_eq!(
            clean_url("https://mcp.example.com/v1/a1b2c3d4e5f6g7h8i9j0k1l2m3/mcp"),
            "https://mcp.example.com/v1/***/mcp"
        );
        assert_eq!(
            clean_text("MCP endpoint not found at https://api.example.app/x?token=1. Check it."),
            "MCP endpoint not found at https://api.example.app/x. Check it."
        );
    }
}
