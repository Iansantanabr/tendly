# Kit additions (stage 1, written first, by one agent)

Files: `crates/server/src/hub/apps/kit.js`, `kit.css`, `kit-demo.html`, tests in `apps/web/src/features/hub/appsE-kit.test.mjs` (add to it) and a new `apps/web/src/features/hub/kit-v2.test.mjs` for the new pure helpers.

Read `README.md` first. Follow the kit's existing style exactly:
- ES5-compatible plain JavaScript inside the one IIFE (`var`, `function`, no arrow functions, no classes, no template literals, no optional chaining) — the existing file is written that way so it runs everywhere and in Node's `vm` for tests.
- Elements are built with the `Reflect.construct(HTMLElement, [], X)` pattern and registered with `define(name, X)`; plain DOM, no shadow DOM; events are bubbling `CustomEvent`s via `emit(el, name, detail)`.
- Every visible string goes through `t(key)` with entries in **both** `STRINGS.en` and `STRINGS.pt`.
- CSS: only `--t-*` variables already defined at the top of `kit.css` (add new variables there if truly needed, with light and dark values), class names prefixed `t-`, container query `t-app (max-width: 640px)` for phone layout (remember: a container query styles descendants of `t-app`, never `t-app` itself).
- Pure helpers must work in Node without a DOM (the test loads kit.js in `vm`): guard any DOM use inside elements or inside functions that are only called from elements.
- Bump `tkit.version` from 1 to 2. Keep every existing API working exactly as before (old apps use it).
- Update the big header comment of `kit.js` so it documents every addition in the same terse style; it is what agents read.

Add every new element to `kit-demo.html` with a small realistic example, in a new section per element.

---

## A. Routing: `#view/id` (change to `<t-app>`)

Today `<t-app>` treats the whole hash as a view name. Change it so the hash is `#<view>` or `#<view>/<rest>`:
- The view is the part before the first `/`. `<t-app>` shows that view; the rest is left alone.
- `tkit.route` (new helper):
  - `tkit.route.get()` → `{ view: 'board', id: 'abc123' | null }` (decoded).
  - `tkit.route.open(id)` sets `#<current view>/<encodeURIComponent(id)>` without changing view; `tkit.route.close()` sets `#<current view>`.
  - `tkit.route.on(fn)` calls `fn({ view, id })` on every hash change and once at start (after `<t-app>` showed its first view); returns an unsubscribe function.
- Switching view through the nav drops the id.
- Pure parsing goes in `tkit.parseRoute(hash)` (tested in Node): `'#board/a%20b'` → `{ view: 'board', id: 'a b' }`, `''` → `{ view: '', id: null }`, `'#x/'` → `{ view: 'x', id: null }`.

## B. Context for the agent

`tkit.context(patch)`: merges `patch` (`{ selection?, summary? }`, `null` clears a key) into the current context and calls `tendly.host.setContext({ view, selection, summary })` with the current view label (the one `<t-app>` already reports). Silently does nothing outside a frame. On a view switch `<t-app>` clears both `selection` and `summary` and reports the new view; the new view's render then sets its own `summary`.

## C. Settings: `tkit.settings(key, defaults)`

Returns a Promise of an object `S`:
- `S.value`: deep merge of `defaults` and the stored value (stored wins; arrays from storage replace default arrays whole; keys only in defaults are added). Always has `v`.
- `S.save(patch)`: shallow-merges `patch` into `S.value`, writes the whole value with `tendly.data.set(key, value)`, returns the Promise; calls listeners.
- `S.on(fn)`: called with the new value after every save; returns unsubscribe.
- If `tendly.data.get` fails, resolves with defaults and `S.error` set (the page shows a toast).
Pure part `tkit.mergeSettings(defaults, stored)` tested in Node.

## D. Schema forms

A **field** is `{ id, label, type, options?, required?, help?, formula?, currency?, placeholder? }` with `type` one of:
`text`, `longtext`, `number`, `money`, `date`, `datetime`, `choice` (one of `options`), `multi` (several of `options`), `checkbox`, `image`, `file` (PDF), `url`, `email`, `phone`, `formula` (read-only, computed from `formula`).
An **option** is `{ id, label, tone? }`, tone one of `'' | 'accent' | 'ok' | 'warn' | 'danger' | 'info' | 'violet'` (map to the kit badge colours; add `info` and `violet` badges to kit.css if missing, light and dark).

Helpers (pure, Node-tested):
- `tkit.slug(label, taken)` → `[a-z0-9_]` id from the label (accents folded, spaces to `_`, max 40), suffixed `_2`, `_3` if in `taken` (array).
- `tkit.fieldValue(field, raw)` → normalized value for storage (number from `"1.234,5"` or `"1234.5"` according to lang; date `YYYY-MM-DD`; checkbox boolean; multi array of option ids; empty string → `null`).
- `tkit.fieldText(field, value, settings?)` → display text (choice → label; money with `tkit.money`; date with `tkit.date`; multi → labels joined ", "; checkbox → "Sim"/"Não" via `t`; image/file → file name).
- `tkit.validate(fields, data)` → `{ ok, errors: { [fieldId]: message } }` (required, number parse, email, url `^https?://`).
- `tkit.compute(fields, data)` → copy of `data` with every `formula` field computed (see F); errors give `null` and are listed in `result._errors`.

Elements:
- `<t-record-form>`: `.fields = [...]`, `.value = {...}`, `.settings = { currency }`. Renders one `.t-field` per non-formula field with the right input (`choice` → `<select>` with an empty option unless required; `multi` → a group of checkboxes; `longtext` → `<textarea>`; `image`/`file` → a file picker + preview + "Remover", uploading through `tendly.files.upload` at submit time and storing `{ path, name, type }`; `checkbox` → a switch-looking checkbox; formula fields shown read-only, recomputed live). Shows inline errors from `tkit.validate`. Has `.submit()` → Promise of the normalized data (or rejects with the errors), and fires `t-input` on every change (so the page can `holdReload(true)`). It renders no buttons; the page puts its own Save/Cancel.
- `<t-list-editor>`: edits an ordered list of options `[{ id, label, tone? }]`. `.items`, `.addLabel`, `.inUse = { [id]: count }`. Rows: drag handle (and ↑/↓ buttons for keyboard), label input, tone picker (small swatches; optional with attribute `tones`), delete button. Deleting an item with `inUse[id] > 0` asks `tkit.confirm` naming the count and that the records keep the value. Event `t-change` `{ items }` on every committed change (blur/Enter/reorder/delete), never per keystroke. New ids via `tkit.slug`.
- `<t-fields-editor>`: edits a field list. Each field row shows label, type (select with human names via `t`), required toggle, and an expander for options (a nested `<t-list-editor>` for `choice`/`multi`), currency (`money`), formula text (`formula`, validated live with `tkit.formula.compile` against the other field ids, error shown under it, with a help line listing usable field ids). Reorder, add ("Adicionar campo" with a type menu), delete (same in-use warning; `.inUse`). Changing the type of a field that has data asks for confirmation. Event `t-change` `{ fields }`.

## E. Detail

`<t-detail>`: `.fields`, `.record` (a record), `.settings`, attribute `title-field` (field id used as heading, default the first text field). Shows the heading, then a definition list of every field with a value (`tkit.fieldText`; images as `<img>` from `tendly.files.url(path)` with `alt` = field label; files as a link that calls `tendly.files.open(path)`; URLs as links with `target="_blank" rel="noopener"`), then "Criado"/"Atualizado" (`tkit.ago`). Slot: children with `slot="actions"` go to its footer (the page adds Edit/Delete). Methods `.open()` / `.close()`: on screens wider than 640px it opens as a right-hand drawer (`<dialog>` styled `.t-drawer`, 420px, full height); narrower, as a full-screen sheet. Opening calls `tkit.route.open(record.id)` and `tkit.context({ selection })` with `"<title-field label>: <title>"`; closing reverses both and fires `t-close`. Prev/next buttons when `.siblings = [ids]` is set fire `t-nav` `{ id }`.

## F. Formulas: `tkit.formula`

A small, safe expression language. **No `eval`, no `Function`.** Hand-written tokenizer + Pratt or recursive-descent parser producing an AST, evaluated by a tree walk.
- Numbers (`1`, `1.5`, `1,5` is **not** accepted: decimal point only in formulas), strings in double quotes, `true`/`false`.
- Identifiers: field ids (`[a-z_][a-z0-9_]*`). Unknown identifier → compile error "Campo desconhecido: x".
- Operators by precedence: `^` (right-assoc), unary `-`, `* / %`, `+ -`, `& ` (text join), comparisons `= <> < <= > >=`, `and`, `or`, `not`.
- Functions: `if(c, a, b)`, `min(…)`, `max(…)`, `round(x, n=0)`, `floor`, `ceil`, `abs`, `sqrt`, `sum(…)`, `avg(…)`, `days(dateA, dateB)` (whole days from A to B), `today()`, `year(d)`, `month(d)`, `len(text)`, `upper`, `lower`, `concat(…)`, `pct(part, whole)` (= part/whole*100), `coalesce(a, b)`.
- Division by zero → `null` (shown as "—"); a `null` input propagates `null` through arithmetic.
- API: `tkit.formula.compile(text, ids)` → `{ ok: true, deps: [...ids], run: function (values) {…} }` or `{ ok: false, error: 'message', at: index }`. `tkit.formula.evaluate(text, values)` convenience.
- Cycles between formula fields are detected by `tkit.compute` (error "Fórmula circular").
Test thoroughly in `kit-v2.test.mjs`: precedence, unary minus, `^` right-assoc, every function, null propagation, division by zero, unknown id, unbalanced parentheses, a 200-character expression, a cycle.

## G. CSV

- `tkit.csv.stringify(rows, columns)` where `columns = [{ key, label, format? }]` → text with header, `\r\n` line ends, RFC 4180 quoting, UTF-8 BOM prefix (so Excel opens accents correctly).
- `tkit.csv.parse(text)` → `{ header: [...], rows: [[...]] }`: RFC 4180 (quotes, doubled quotes, newlines in quotes), strips BOM, auto-detects `,` vs `;` vs tab from the header line (Brazilian Excel uses `;`).
- `tkit.csv.download(text, filename)` → Blob + temporary `<a download>` click (the frame allows downloads).
- `<t-import>`: `.fields`, `.open()` → Promise of `[data objects]` or `null` if cancelled. Dialog steps: (1) choose a `.csv` file (also accepts drag-and-drop); (2) table preview of 5 rows + per-column select "Importar como: [field | Ignorar]" auto-matched by folded label; (3) validation summary ("48 linhas prontas, 2 com problemas: linha 7 Valor não é número…") with "Importar 48" / "Cancelar". Values pass through `tkit.fieldValue`. The page does the inserting.

## H. Examples

- `tkit.samples.load(collection, docs)` → inserts each doc with `_sample: true` (sequential), resolves the count.
- `tkit.samples.clear(collection)` → lists `where: { _sample: true }` and removes each, resolves the count.
- `tkit.samples.count(records)` pure.
- `<t-sample-banner>`: `.count`; shows "Você está vendo N exemplos." + button "Apagar exemplos" (event `t-clear`); hidden when count is 0. Light `.t-card`-like strip with an info tone.
- `tkit.daysFromToday(n)` → `YYYY-MM-DD` (pure), for relative example dates.

## I. Gallery, checklist, progress, steps

- `<t-gallery>`: `.items = [{ id, title, subtitle?, image?, badge?, tone?, meta? }]` (image is a URL already resolved), responsive grid (min 200px cards, 1 column under 400px), 4:3 image area with a neutral placeholder icon when no image, title clamped to 2 lines; keyboard: cards are focusable, Enter → `t-open` `{ id }`; attribute `empty-text`.
- `<t-checklist>`: `.items = [{ id, label, done, note?, required?, by?, at? }]`, `.readonly`. Each item: a large checkbox (44px target), label, optional note line, "por X às 14:32" when done. Toggling fires `t-toggle` `{ id, done }`; does not change itself (the page sets `.items` again). Shows progress on top via `<t-progress>`.
- `<t-progress value="3" max="10" label="…">`: bar + "3 de 10" text; tone `ok` at 100%.
- `<t-steps>`: `.steps = [labels]`, `.current = index`; a horizontal step indicator (wraps to "Passo 2 de 5" on phones). Used by Quiz and by `<t-import>`.

## J. Markdown

`tkit.markdown(text, { linkArticle?: function (slug) → href|null })` → a `DocumentFragment` built with DOM nodes only (no innerHTML). Supports: `#`–`###` headings, paragraphs, blank-line separation, `**bold**`, `*italic*`, `` `code` ``, fenced code blocks, `-`/`*`/`1.` lists (one level of nesting), `> quote`, `---` rule, links `[text](https://…)` (http/https/mailto only, `target=_blank rel=noopener`) and wiki links `[[Article title]]` resolved through `linkArticle` (unresolved ones render as muted text with a "criar" affordance: the page decides via an event `t-wikilink` `{ title }` fired on click). Anything else is literal text. Pure part `tkit.parseMarkdown(text)` → an AST array, tested in Node (including that `<script>` in input comes out as text).

## K. Small things

- New icons in `ICONS` (24×24 stroke paths, same style as the existing ones): `image`, `grid`, `check-square`, `calculator`, `scale` (comparison), `book`, `map-pin`, `map`, `help` (question mark in circle), `repeat`, `play`, `clipboard`, `filter`, `external`, `copy`, `drag` (six dots), `arrow-left`, `arrow-right`, `chevron-down`, `file` (document page), `bell`.
- **Dynamic screens**: `<t-nav>` must decorate buttons added after it connected (a `MutationObserver` on its children), and `<t-app>` must accept `<t-view>`s and nav buttons added or removed later: `app.refresh()` re-reads them, keeps the current view if it still exists, else shows the first. The Base flexível builds its views at runtime and relies on this.
- `.t-nav-end` in `<t-nav>`: pushed to the bottom of the sidebar (`margin-top: auto`); in the phone bottom bar it stays the last button.
- `.t-drawer` dialog style (see E). `.t-switch` checkbox style. `.t-card-head` (a card header row with title left, actions right). `.t-kv` (definition list for details: label muted above value on phones, side by side wider). `.t-segment` (segmented control for 2–4 options; buttons with `aria-pressed`).
- `tkit.download(blob, filename)` shared by CSV.
- `tkit.fold(text)` (lowercase, accents removed) exported (it exists internally as `normalize`).

## Acceptance (kit)

1. All existing tests still pass; `appsE-kit.test.mjs` updated for `version: 2` and the new helpers list; new `kit-v2.test.mjs` covers B (pure part), C, D (slug, fieldValue pt/en, fieldText, validate, compute), F (as listed), G (stringify/parse round trip with `;`, quotes, newlines, BOM), H (count, daysFromToday), A (parseRoute), J (parseMarkdown incl. script-as-text).
2. `kit-demo.html` shows every new element working with fake data that doesn't need the SDK (guard calls to `tendly.*` so the demo works standalone: the demo page runs as its own page).
3. Every new string exists in `en` and `pt`.
4. No existing template changes behaviour (they still pass their test and still work: the `#view` hash form keeps working).
5. Report: the final public API list (names + one line each) exactly as documented in the header comment.

---

## Notes for template authors (from the kit implementation, 2026-11-11)

- `<t-app>` clears `selection` and `summary` on every view switch: set `summary` again in a `t-view` listener, not only when data renders.
- `<t-fields-editor>` / `<t-list-editor>` don't redraw when you set `.fields`/`.items` to what they just emitted (focus survives save-and-echo). Their nested `t-change` events don't bubble to the page. `<t-fields-editor>` also has `.optionsInUse = { fieldId: { optionId: count } }` and `.types` (or attribute `types="text,number,…"`) to restrict the type menu (the Form template hides `formula`).
- `<t-record-form>.submit()` resolves the whole `.value` merged with the form (so `_sample`, `order` survive an edit), formula ids removed; rejects with `err.code === 'invalid'` for validation (don't toast those; toast other errors).
- `<t-detail>` opens itself as drawer/sheet; to reopen from a link, listen with `tkit.route.on(({ view, id }) => …)` and call `detail.open()`. Close from outside with `detail.close()` (it cleans the hash and context). Its default selection is "<title-field label>: <title>"; override with `tkit.context({ selection })` right after `open()` when the spec wants another text.
- `<t-checklist>` flips the box at once: always set `.items` again after saving (also after a failed save, so it snaps back).
- CSV: in pt-BR templates export with `tkit.csv.stringify(rows, cols, { delimiter: tkit.csv.delimiter() })` (`;` for pt, `,` for en). Formula-looking cells are escaped by the kit.
- Markdown: `#` renders as `<h2>` (the page keeps its single `<h1>`); headings carry `data-anchor`. For an outline use `tkit.markdownOutline(text)` and `scrollIntoView` — never `#anchor` links (the hash belongs to the router).
- `tkit.compute()` caches compiled formulas (cheap per row). `tkit.parseNumber` reads "1.234,5", "1,234.5", "R$ 12,50".
- Ids from `tkit.slug` never start with a digit (`f_` prefix) and avoid `and/or/not/true/false` (they are formula names too).
