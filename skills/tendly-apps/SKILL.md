---
name: tendly-apps
description: Build, change or fix a custom app inside Tendly (a mini-app, dashboard, CRM, tracker, calculator or any small tool that opens on the Mesa). Use when the person asks to create, edit, improve or debug an app, mini-app, dashboard, CRM or tool "in Tendly", "na Mesa", "no Tendly", or mentions the Apps page or an app in its sidebar.
---

# Tendly apps

A Tendly app is a folder of static files (HTML, CSS, JS) inside a workspace. Tendly lists it in the Apps page and sidebar, opens it on the Mesa in a pane, and stores its state through a small data API. There is no server code and no build step.

## Folder convention

```
<workspace root>/apps/<slug>/
  app.json        required: describes the app
  index.html      the entry page (or whatever "entry" names)
  ...             any other files: css, js, images
  data/           the app's saved state, written by Tendly; do not create or edit by hand
```

- `<slug>` is the folder name: lowercase letters, digits and dashes, starting with a letter or digit, up to 64 characters (`pipeline`, `crm`, `habit-tracker`).
- `app.json` fields:
  - `name` (required): shown in the Apps page and the pane header.
  - `letter` (optional, 1 or 2 characters): the icon letter. Default: first letter of `name`.
  - `color` (optional): one of `amber`, `green`, `blue`, `violet`, `rose`, `slate`, `teal`, `orange`. Default: chosen from the slug.
  - `description` (optional, up to 500 characters).
  - `entry` (optional): the page to open, relative to the app folder. Default `index.html`. Must not be inside `data/` or start with a dot.
- An invalid `app.json` (bad JSON, missing name, unknown color, missing entry file) makes the app show up as an error in the Apps page. Fix the file and it reappears.
- Files whose name starts with a dot and anything under `data/` are never served.

## Writing the page

- Plain static files. Use vanilla JS, or ES modules from a CDN with a pinned version, for example `import { html, render } from 'https://cdn.jsdelivr.net/npm/lit-html@3.2.1/+esm'`. No npm install, no bundler.
- Reference other files with relative paths (`./app.js`, `css/style.css`).
- The page runs in a narrow pane: make it responsive down to about 360px wide (no fixed widths, wrap rows, let tables scroll horizontally).
- Support light and dark: set `color-scheme: light dark` and use CSS variables switched with `@media (prefers-color-scheme: dark)`.
- Show loading and error states; never leave the page blank when a call fails.

## Saving data with the SDK

Include the SDK before your own scripts:

```html
<script src="/api/hub/apps/sdk.js"></script>
```

It exposes `window.tendly` (every call returns a Promise and throws an `Error` with the server message on failure):

- `tendly.app` is `{ workspaceId, slug }`.
- `await tendly.data.get(key, fallback)` returns the stored JSON value, or `fallback` (default `null`) when the key does not exist.
- `await tendly.data.set(key, value)` stores any JSON value up to 1 MB and returns `{ key, size, updated_at }`.
- `await tendly.data.list()` returns `[{ key, size, updated_at }]`.
- `await tendly.data.remove(key)` deletes a key.

Keys are letters, digits, `_` and `-`, up to 64 characters. Each key is saved as `data/<key>.json`. Prefer a few keys holding whole documents (`leads`, `settings`) over one key per item; debounce saves from text inputs.

While the app is open, do not edit files in `data/` by hand: the app may overwrite your change or read a half-written file. To change stored data, change the app (or ask the person to close it first).

## Delivering

- After creating an app, tell the person to find it in the Apps page or the sidebar and open it on the Mesa.
- To change an existing app, edit its files in `apps/<slug>/`, then tell the person to press reload in the app's header to see the new version.
- When fixing a bug, read the app's files first; check `app.json` if the app does not appear at all.

## Complete example

`apps/reading-list/app.json`:

```json
{
  "name": "Reading list",
  "letter": "R",
  "color": "teal",
  "description": "Books to read, with a done checkbox.",
  "entry": "index.html"
}
```

`apps/reading-list/index.html`:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Reading list</title>
  <script src="/api/hub/apps/sdk.js"></script>
  <style>
    :root { color-scheme: light dark; --bg: #fafafa; --text: #1f2328; --line: #e5e7eb; --accent: #0d9488; }
    @media (prefers-color-scheme: dark) { :root { --bg: #16181c; --text: #e6e6e6; --line: #2d3139; } }
    body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, sans-serif; }
    main { max-width: 600px; margin: 0 auto; padding: 16px; }
    form { display: flex; gap: 8px; }
    input[type=text] { flex: 1; min-width: 0; padding: 6px 8px; border: 1px solid var(--line); border-radius: 6px; background: transparent; color: inherit; }
    button { padding: 6px 12px; border: 0; border-radius: 6px; background: var(--accent); color: #fff; }
    li { display: flex; gap: 8px; align-items: center; padding: 6px 0; border-bottom: 1px solid var(--line); }
    li.done span { text-decoration: line-through; opacity: .6; }
    ul { list-style: none; padding: 0; }
  </style>
</head>
<body>
  <main>
    <h1>Reading list</h1>
    <form id="add"><input type="text" id="title" placeholder="Book title" required><button>Add</button></form>
    <ul id="list"></ul>
    <p id="status"></p>
  </main>
  <script>
    let books = [];
    const list = document.getElementById('list');
    const status = (t) => { document.getElementById('status').textContent = t; };

    function draw() {
      list.replaceChildren(...books.map((book, i) => {
        const li = document.createElement('li');
        li.className = book.done ? 'done' : '';
        const box = Object.assign(document.createElement('input'), { type: 'checkbox', checked: book.done });
        box.onchange = () => { books[i].done = box.checked; save(); };
        const span = Object.assign(document.createElement('span'), { textContent: book.title });
        li.append(box, span);
        return li;
      }));
    }
    async function save() {
      draw();
      try { await tendly.data.set('books', books); status(''); }
      catch (e) { status('Could not save: ' + e.message); }
    }
    document.getElementById('add').onsubmit = (event) => {
      event.preventDefault();
      const input = document.getElementById('title');
      books.push({ title: input.value.trim(), done: false });
      input.value = '';
      save();
    };
    tendly.data.get('books', []).then((saved) => { books = saved; draw(); })
      .catch((e) => status('Could not load: ' + e.message));
  </script>
</body>
</html>
```
