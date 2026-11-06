//! What a published page may bring along, and where it is found.
//!
//! An HTML page is published together with the relative files it actually
//! references -- `src`, `href`, `srcset`, `poster`, CSS `url()` and `@import`,
//! and ES module `import` specifiers, followed through the CSS and scripts it
//! loads -- never with the rest of its folder. Copying the folder would be
//! simpler, but a page at the root of a workspace would then publish every
//! file beside it. A file the page builds a path to at run time (a `fetch` of
//! a computed name) is therefore not included; a literal one is.
//!
//! Only references inside the page's own folder are followed (`../` that
//! leaves it is dropped), nothing whose name starts with a dot, nothing in
//! `node_modules`, nothing Tendly protects, and no symlink.
use std::{
    collections::{BTreeSet, VecDeque},
    fs, io,
    path::{Component, Path, PathBuf},
};

/// At most this many files, the page included, and this many bytes in all.
pub(super) const MAX_FILES: usize = 200;
pub(super) const MAX_BYTES: u64 = 20 * 1024 * 1024;
/// A single non-HTML file is frozen whole up to this size.
pub(super) const MAX_SINGLE_BYTES: u64 = 200 * 1024 * 1024;
/// Texts larger than this are copied but not searched for references.
const MAX_SCAN_BYTES: u64 = 2 * 1024 * 1024;

fn extension(path: &Path) -> String {
    path.extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
}
pub(super) fn is_html(path: &Path) -> bool {
    matches!(extension(path).as_str(), "html" | "htm")
}
pub(super) fn is_markdown(path: &Path) -> bool {
    matches!(extension(path).as_str(), "md" | "markdown")
}
fn is_scanned(path: &Path) -> bool {
    matches!(extension(path).as_str(), "html" | "htm" | "css" | "js" | "mjs")
}

/// A path component that may be published: no dot-files (so no `..`), no
/// dependency folders, nothing a path separator or drive could hide in.
fn allowed_component(part: &str) -> bool {
    !part.is_empty()
        && !part.starts_with('.')
        && part != "node_modules"
        && !part.contains(['\\', ':', '\0'])
}

/// A requested path below a published page, as the router decoded it
/// (`%2e%2e` arrives here as `..`). Refuses anything absolute, any `..` or
/// dot-file, and protected names.
pub(super) fn clean_rest(rest: &str) -> Option<PathBuf> {
    if rest.is_empty() || rest.starts_with('/') || Path::new(rest).is_absolute() {
        return None;
    }
    let mut out = PathBuf::new();
    for part in rest.split('/') {
        if !allowed_component(part) {
            return None;
        }
        out.push(part);
    }
    // Defence in depth: the components really are plain names.
    if out.components().any(|c| !matches!(c, Component::Normal(_)))
        || crate::workspace_io::is_protected_path(&out)
    {
        return None;
    }
    Some(out)
}

fn percent_decode(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = text.get(index + 1..index + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// A reference found in `base` (a folder relative to the page's folder) as a
/// path relative to the page's folder, or `None` when it is external,
/// root-relative, leaves the folder or names something never published.
pub(super) fn resolve_reference(base: &Path, reference: &str) -> Option<PathBuf> {
    let reference = reference.trim();
    let end = reference.find(['#', '?']).unwrap_or(reference.len());
    let reference = &reference[..end];
    if reference.is_empty() || reference.starts_with('/') || reference.starts_with('\\') {
        return None;
    }
    // A scheme (`https:`, `data:`, `javascript:`) comes before any slash.
    if let Some(colon) = reference.find(':')
        && !reference[..colon].contains('/')
    {
        return None;
    }
    let decoded = percent_decode(reference)?;
    let mut parts: Vec<String> = base
        .components()
        .filter_map(|c| match c {
            Component::Normal(part) => part.to_str().map(str::to_owned),
            _ => None,
        })
        .collect();
    for part in decoded.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            name => parts.push(name.to_owned()),
        }
    }
    if parts.is_empty() || !parts.iter().all(|p| allowed_component(p)) {
        return None;
    }
    let path: PathBuf = parts.iter().collect();
    (!crate::workspace_io::is_protected_path(&path)).then_some(path)
}

/// Literal values after `needle` in `text`: quoted, or (when `bare`) up to the
/// next space or `>`. `needle` is lowercase and matched case-insensitively.
fn values_after(text: &str, lower: &str, needle: &str, bare: bool, attribute: bool, out: &mut Vec<String>) {
    let mut from = 0;
    while let Some(found) = lower[from..].find(needle) {
        let start = from + found;
        from = start + needle.len();
        // `src=` but not `xsrc=`; `data-src=` is a lazy-loaded image and counts.
        if attribute
            && start > 0
            && !lower.as_bytes()[start - 1].is_ascii_whitespace()
            && lower.as_bytes()[start - 1] != b'-'
        {
            continue;
        }
        let rest = text[from..].trim_start();
        let rest = if attribute {
            match rest.strip_prefix('=') {
                Some(r) => r.trim_start(),
                None => continue,
            }
        } else {
            rest
        };
        let value = match rest.chars().next() {
            Some(quote @ ('"' | '\'' | '`')) => rest[1..].split(quote).next(),
            Some(_) if bare => rest.split(|c: char| c.is_whitespace() || c == '>' || c == ')').next(),
            _ => None,
        };
        if let Some(value) = value.filter(|v| !v.is_empty() && v.len() < 2048) {
            out.push(value.to_owned());
        }
    }
}

/// Candidate references in an HTML, CSS or JavaScript text.
pub(super) fn references(text: &str) -> Vec<String> {
    let lower = text.to_ascii_lowercase();
    let mut out = Vec::new();
    for attribute in ["src", "href", "poster", "data"] {
        values_after(text, &lower, attribute, true, true, &mut out);
    }
    let mut sets = Vec::new();
    values_after(text, &lower, "srcset", true, true, &mut sets);
    for set in sets {
        out.extend(
            set.split(',')
                .filter_map(|item| item.split_whitespace().next())
                .map(str::to_owned),
        );
    }
    values_after(text, &lower, "url(", true, false, &mut out);
    values_after(text, &lower, "@import", false, false, &mut out);
    values_after(text, &lower, "from", false, false, &mut out);
    values_after(text, &lower, "import(", false, false, &mut out);
    values_after(text, &lower, "import", false, false, &mut out);
    out
}

/// A file below `root` that may be served: a regular file reached without a
/// symlink at its last step, and still inside `root` once every link on the
/// way has been resolved.
pub(super) fn checked_file(root: &Path, relative: &Path) -> Option<PathBuf> {
    if relative
        .components()
        .any(|c| !matches!(c, Component::Normal(p) if p.to_str().is_some_and(allowed_component)))
    {
        return None;
    }
    let joined = root.join(relative);
    let metadata = fs::symlink_metadata(&joined).ok()?;
    if !metadata.file_type().is_file() {
        return None;
    }
    let canonical_root = dunce::canonicalize(root).ok()?;
    let canonical = dunce::canonicalize(&joined).ok()?;
    canonical.starts_with(&canonical_root).then_some(canonical)
}

/// What a page brings along.
#[derive(Debug, Default, PartialEq)]
pub(super) struct Collected {
    /// Relative to the page's folder, the page itself first.
    pub files: Vec<PathBuf>,
    pub bytes: u64,
    /// Something referenced was left out because a limit was reached.
    pub truncated: bool,
}

/// The page `entry` in `root` and every file it references, within limits.
pub(super) fn collect(root: &Path, entry: &Path) -> io::Result<Collected> {
    let Some(first) = checked_file(root, entry) else {
        return Err(io::Error::new(io::ErrorKind::NotFound, "file not found"));
    };
    let mut collected = Collected {
        files: vec![entry.to_path_buf()],
        bytes: fs::metadata(&first)?.len(),
        truncated: false,
    };
    if !is_html(entry) {
        return Ok(collected);
    }
    let mut seen: BTreeSet<PathBuf> = [entry.to_path_buf()].into();
    let mut queue: VecDeque<(PathBuf, PathBuf)> = [(entry.to_path_buf(), first)].into();
    while let Some((relative, absolute)) = queue.pop_front() {
        if !is_scanned(&relative) {
            continue;
        }
        let Ok(metadata) = fs::metadata(&absolute) else { continue };
        if metadata.len() > MAX_SCAN_BYTES {
            continue;
        }
        let Ok(bytes) = fs::read(&absolute) else { continue };
        let text = String::from_utf8_lossy(&bytes);
        let base = relative.parent().unwrap_or(Path::new("")).to_path_buf();
        for reference in references(&text) {
            let Some(found) = resolve_reference(&base, &reference) else { continue };
            if !seen.insert(found.clone()) {
                continue;
            }
            let Some(target) = checked_file(root, &found) else { continue };
            let size = fs::metadata(&target).map(|m| m.len()).unwrap_or(0);
            if collected.files.len() >= MAX_FILES || collected.bytes + size > MAX_BYTES {
                collected.truncated = true;
                continue;
            }
            collected.bytes += size;
            collected.files.push(found.clone());
            queue.push_back((found, target));
        }
    }
    Ok(collected)
}

/// Copy `entry` (a file in `root`) and what it references into `destination`,
/// replacing what was there only once the new copy is complete.
pub(super) fn snapshot(root: &Path, entry: &Path, destination: &Path) -> io::Result<Collected> {
    let collected = collect(root, entry)?;
    let limit = if is_html(entry) { MAX_BYTES } else { MAX_SINGLE_BYTES };
    if collected.files.len() == 1 && collected.bytes > limit {
        return Err(io::Error::new(io::ErrorKind::FileTooLarge, "file too large to freeze"));
    }
    let parent = destination
        .parent()
        .ok_or_else(|| io::Error::other("snapshot destination has no parent"))?;
    fs::create_dir_all(parent)?;
    let staging = parent.join(format!(".staging-{}", uuid::Uuid::new_v4().simple()));
    let result = (|| {
        for file in &collected.files {
            // Checked again at copy time; something may have changed since.
            let Some(source) = checked_file(root, file) else { continue };
            let target = staging.join(file);
            if let Some(dir) = target.parent() {
                fs::create_dir_all(dir)?;
            }
            fs::copy(&source, &target)?;
        }
        if !staging.join(entry).is_file() {
            return Err(io::Error::new(io::ErrorKind::NotFound, "file not found"));
        }
        remove(destination)?;
        fs::rename(&staging, destination)
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    result.map(|()| collected)
}

/// Remove a snapshot folder; one that is already gone is fine.
pub(super) fn remove(destination: &Path) -> io::Result<()> {
    match fs::remove_dir_all(destination) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hub-publish-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dunce::canonicalize(dir).unwrap()
    }

    #[test]
    fn hub_publish_rest_paths_refuse_traversal_absolute_and_dot_files() {
        assert_eq!(clean_rest("img/logo.png"), Some(PathBuf::from("img/logo.png")));
        for bad in [
            "",
            "../secret.txt",
            "img/../../secret.txt",
            "..",
            "/etc/passwd",
            "//etc/passwd",
            ".env",
            "img/.hidden.png",
            ".git/config",
            "a\\..\\b",
            "C:/Windows",
            "a//b",
            "./a",
            "secrets/key.txt",
        ] {
            assert_eq!(clean_rest(bad), None, "{bad}");
        }
        // `%2e%2e` reaches this function decoded, as `..`; still encoded (a
        // double-encoded request) it is a literal name that does not exist.
        assert_eq!(clean_rest(&percent_decode("%2e%2e/secret").unwrap()), None);
        assert_eq!(clean_rest(&percent_decode("img%2f..%2f..%2fx").unwrap()), None);
    }

    #[test]
    fn hub_publish_references_resolve_inside_the_page_folder_only() {
        let base = Path::new("");
        assert_eq!(resolve_reference(base, "css/site.css?v=2#x"), Some("css/site.css".into()));
        assert_eq!(resolve_reference(Path::new("css"), "../img/a%20b.png"), Some("img/a b.png".into()));
        for bad in [
            "https://example.com/a.png",
            "//cdn.example.com/a.js",
            "/api/hub/publications",
            "data:image/png;base64,xx",
            "javascript:alert(1)",
            "mailto:a@b.c",
            "../outside.png",
            "%2e%2e/outside.png",
            "img/%2e%2e/%2e%2e/outside.png",
            ".env",
            "node_modules/x/y.js",
            "#top",
            "",
        ] {
            assert_eq!(resolve_reference(base, bad), None, "{bad}");
        }
        let found = references(
            r#"<link rel="stylesheet" HREF='css/site.css'><img src=logo.png alt=x>
            <img srcset="a.png 1x, b.png 2x"><div style="background:url('bg.jpg')"></div>
            <script type="module">import x from "./mod.js"; import("./lazy.js")</script><a data-src="lazy.png">"#,
        );
        for want in ["css/site.css", "logo.png", "a.png", "b.png", "bg.jpg", "./mod.js", "./lazy.js", "lazy.png"] {
            assert!(found.iter().any(|f| f == want), "{want} in {found:?}");
        }
    }

    #[test]
    fn hub_publish_collects_only_what_the_page_references() {
        let dir = temp();
        let page = dir.join("site");
        fs::create_dir_all(page.join("css")).unwrap();
        fs::create_dir_all(page.join("img")).unwrap();
        fs::write(
            page.join("index.html"),
            r#"<link href="css/site.css" rel=stylesheet><img src="img/a.png"><img src="../outside.png"><img src=".hidden.png"><a href="missing.png">"#,
        )
        .unwrap();
        fs::write(page.join("css/site.css"), "body{background:url(../img/bg.png)}").unwrap();
        fs::write(page.join("img/a.png"), "a").unwrap();
        fs::write(page.join("img/bg.png"), "bg").unwrap();
        fs::write(page.join("notes.txt"), "not referenced").unwrap();
        fs::write(page.join(".hidden.png"), "hidden").unwrap();
        fs::write(dir.join("outside.png"), "outside").unwrap();
        let collected = collect(&page, Path::new("index.html")).unwrap();
        let mut names: Vec<_> = collected.files.iter().map(|p| p.to_string_lossy().replace('\\', "/")).collect();
        assert_eq!(names[0], "index.html", "the page comes first");
        names.sort();
        assert_eq!(names, ["css/site.css", "img/a.png", "img/bg.png", "index.html"]);
        assert!(!collected.truncated);

        let destination = dir.join("published").join("slug");
        snapshot(&page, Path::new("index.html"), &destination).unwrap();
        assert!(destination.join("img/bg.png").is_file());
        assert!(!destination.join("notes.txt").exists());
        assert!(!destination.join(".hidden.png").exists());
        // A second snapshot replaces the first.
        fs::write(page.join("index.html"), "<p>v2</p>").unwrap();
        snapshot(&page, Path::new("index.html"), &destination).unwrap();
        assert_eq!(fs::read_to_string(destination.join("index.html")).unwrap(), "<p>v2</p>");
        assert!(!destination.join("css").exists());
        fs::remove_dir_all(dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn hub_publish_symlinks_out_of_the_folder_are_never_served_or_copied() {
        let dir = temp();
        let page = dir.join("site");
        fs::create_dir_all(&page).unwrap();
        fs::write(dir.join("secret.txt"), "secret").unwrap();
        std::os::unix::fs::symlink(dir.join("secret.txt"), page.join("link.txt")).unwrap();
        std::os::unix::fs::symlink(&dir, page.join("up")).unwrap();
        fs::write(page.join("index.html"), r#"<a href="link.txt"></a><a href="up/secret.txt">"#).unwrap();
        assert_eq!(checked_file(&page, Path::new("link.txt")), None);
        assert_eq!(checked_file(&page, Path::new("up/secret.txt")), None);
        assert_eq!(checked_file(&page, Path::new("/etc/passwd")), None);
        assert_eq!(checked_file(&page, Path::new("../secret.txt")), None);
        let collected = collect(&page, Path::new("index.html")).unwrap();
        assert_eq!(collected.files, [PathBuf::from("index.html")]);
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn hub_publish_limits_bound_what_is_collected() {
        let dir = temp();
        let mut html = String::new();
        for index in 0..(MAX_FILES + 5) {
            fs::write(dir.join(format!("f{index}.png")), "x").unwrap();
            html.push_str(&format!("<img src=\"f{index}.png\">"));
        }
        fs::write(dir.join("index.html"), html).unwrap();
        let collected = collect(&dir, Path::new("index.html")).unwrap();
        assert_eq!(collected.files.len(), MAX_FILES);
        assert!(collected.truncated);
        fs::remove_dir_all(dir).ok();
    }
}
