//! A published Markdown file rendered as HTML (CommonMark plus tables,
//! strikethrough and task lists). Raw HTML in the file is never passed
//! through: it is shown as escaped text, so a published `.md` cannot carry a
//! script, a form or an iframe. Links and images keep only safe schemes.
use pulldown_cmark::{CowStr, Event, Options, Parser, Tag, TagEnd, html};

/// Link targets that run code or embed content when followed.
fn safe_url(url: &str) -> bool {
    let trimmed: String = url.trim().chars().filter(|c| !c.is_ascii_whitespace() && !c.is_ascii_control()).collect();
    let lower = trimmed.to_ascii_lowercase();
    match lower.find(':') {
        // A scheme is only what comes before the first ':' when no '/', '?' or '#' does.
        Some(colon) if !lower[..colon].contains(['/', '?', '#']) => {
            matches!(&lower[..colon], "http" | "https" | "mailto" | "tel")
        }
        _ => true,
    }
}

/// The Markdown text as an HTML fragment.
pub(super) fn render(text: &str) -> String {
    let options = Options::ENABLE_TABLES
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_YAML_STYLE_METADATA_BLOCKS;
    let mut in_metadata = false;
    let events = Parser::new_ext(text, options).filter_map(|event| match event {
        // Front matter is for tools, not readers.
        Event::Start(Tag::MetadataBlock(_)) => {
            in_metadata = true;
            None
        }
        Event::End(TagEnd::MetadataBlock(_)) => {
            in_metadata = false;
            None
        }
        _ if in_metadata => None,
        Event::Html(raw) | Event::InlineHtml(raw) => Some(Event::Text(raw)),
        Event::Start(Tag::Link { link_type, dest_url, title, id }) => Some(Event::Start(Tag::Link {
            link_type,
            dest_url: if safe_url(&dest_url) { dest_url } else { CowStr::Borrowed("#") },
            title,
            id,
        })),
        Event::Start(Tag::Image { link_type, dest_url, title, id }) => Some(Event::Start(Tag::Image {
            link_type,
            dest_url: if safe_url(&dest_url) || dest_url.trim().to_ascii_lowercase().starts_with("data:image/") {
                dest_url
            } else {
                CowStr::Borrowed("")
            },
            title,
            id,
        })),
        other => Some(other),
    });
    let mut out = String::with_capacity(text.len() * 3 / 2);
    html::push_html(&mut out, events);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hub_publish_markdown_renders_headings_tables_and_lists() {
        let html = render("# Title\n\nSome *text* and ~~old~~.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n- [ ] todo\n");
        assert!(html.contains("<h1>Title</h1>"), "{html}");
        assert!(html.contains("<em>text</em>"));
        assert!(html.contains("<del>old</del>"));
        assert!(html.contains("<table>") && html.contains("<th>a</th>") && html.contains("<td>2</td>"), "{html}");
        assert!(html.contains(r#"type="checkbox""#) && html.contains("checked"), "{html}");
    }

    #[test]
    fn hub_publish_markdown_never_passes_raw_html() {
        let html = render("<script>alert(1)</script>\n\nHi <img src=x onerror=alert(2)> there <b>bold</b>\n\n<iframe src=\"/api\"></iframe>\n");
        assert!(!html.contains("<script"), "{html}");
        assert!(!html.contains("<img"), "{html}");
        assert!(!html.contains("<iframe"), "{html}");
        assert!(!html.contains("<b>"), "{html}");
        assert!(html.contains("&lt;script&gt;"), "{html}");
    }

    #[test]
    fn hub_publish_markdown_drops_unsafe_link_schemes_and_front_matter() {
        let html = render("---\nsecret: x\n---\n[a](javascript:alert(1)) [b](JaVa\tScript:alert(1)) [c](https://example.com) [d](notes/other.md) ![i](data:text/html,x)\n");
        assert!(!html.to_ascii_lowercase().contains("javascript"), "{html}");
        assert!(!html.contains("data:text"), "{html}");
        assert!(html.contains(r#"href="https://example.com""#));
        assert!(html.contains(r#"href="notes/other.md""#));
        assert!(!html.contains("secret"), "{html}");
    }
}
