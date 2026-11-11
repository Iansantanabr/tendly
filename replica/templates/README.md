# App templates for GCore: philosophy, architecture and rules

Read this whole file before writing any code. Then read `kit.md` and the one spec for your task, then the reference template `crates/server/src/hub/apps/templates/kanban.html` (and its `pt-BR/` twin), then `crates/server/src/hub/apps/kit.js` (its header comment documents every element and helper) and the header comment of `crates/server/src/hub/apps/sdk.js`.

Decided with Ian on 2026-11-11. Planning was done by Opus; the code is written by Sonnet agents from these specs. When a spec leaves a choice open, follow this file. If a spec contradicts this file, follow the spec and report it.

---

## 1. What a template is

GCore (a fork of Tendly; the code still says `tendly` everywhere, which is correct, never rename identifiers) lets a person create a small **app** from a sentence ("um quadro dos meus fornecedores") and a **template**. The server copies the template's HTML into `apps/<slug>/index.html` of the person's workspace, fills `{{NAME}}`, `{{LETTER}}`, `{{DESCRIPTION}}`, `{{COLOR}}`, `{{ACCENT}}`, and opens it. Then an AI agent reads that page and **edits it** into what the person described.

So a template has two readers, and both matter equally:

1. **The person**, who must get something that already works and looks finished the second it opens, before any agent touches it.
2. **The agent**, who must understand the page in one read and change it safely: rename fields, add a screen, change a rule.

### The six principles

1. **Useful in the first minute.** A template is a working app, never a demo. Empty, it says what to do next and offers "Ver com exemplos" (see examples). Every button does something real.
2. **One clear job per template.** The name says what it does. Choose the most common shape of that job and do it well; do not bolt on every option. The Base flexível is the one deliberately general template.
3. **The person adjusts; the agent transforms.** Everything a person would reasonably change on a normal day (columns, categories, form fields, currency, colours, frequencies) is editable inside the app, on its **Ajustes** (Settings) screen, with no agent. Structural changes (a new screen, a new rule, an integration) are for the agent, and the page is written so that is easy.
4. **Short, readable page; heavy lifting in the kit.** The page reads top to bottom: markup of the screens, then one `<script>` with: constants and default settings → state → render functions → event handlers → start-up. Reusable machinery (forms from a schema, CSV, examples, detail routing, formulas, markdown, gallery, checklists) lives in `kit.js`/`kit.css`, which GCore serves to every app, so improving the kit improves every app, including old ones. Target size of a template page: 150–350 lines. If you need more, something belongs in the kit: say so in your report instead of growing the page.
5. **The data outlives the screen.** Records that change one at a time go in a collection (`tendly.db.collection(name)`), never in one big JSON value. Small settings go in `tendly.data` under one key. Field ids never change once created (labels can). Deleting a field or option never silently destroys data: it warns, and the values stay in the records until the person clears them.
6. **It looks like GCore.** Only kit classes and the kit's CSS variables (`--t-*`). No new fonts, no hex colours in templates, no emoji as icons (use `tkit.icon(name)`), green (accent) only for the primary action and for "where you are". Light and dark both work because the kit's variables already do.

---

## 2. Architecture

```
crates/server/src/hub/apps/
  kit.js, kit.css          shared machinery and look (served at /api/hub/apps/kit.js|css)
  sdk.js                   window.tendly: data, db (collections), files, host (do not change in template work)
  templates/<id>.html      English template
  templates/pt-BR/<id>.html  the same page in Brazilian Portuguese (only visible text and lang differ)
  kit-demo.html            the kit's showcase page (add every new element there)
crates/server/src/hub/apps.rs        TEMPLATES / TEMPLATES_PT_BR registry, scaffold (Opus integrates)
apps/web/src/features/hub/builder.ts the template list shown in "Criar com o agente" (Opus integrates)
apps/web/src/features/hub/appsE-kit.test.mjs  kit + template tests (Node, no browser)
skills/tendly-apps/SKILL.md          what agents read about apps (Opus updates)
```

**Ownership while agents work in parallel.** A template agent touches only its own two template files (`templates/<id>.html`, `templates/pt-BR/<id>.html`) and, if asked, one new test file named in its spec. It never edits `kit.js`, `kit.css`, `apps.rs`, `builder.ts`, `pt-BR.json`, `SKILL.md` or another template. If the kit lacks something, the agent writes it inside its page in a clearly marked block `// KIT-CANDIDATE: <what>` and reports it. Only the kit agent edits the kit. Nobody runs `~/tendly-src/build.sh`, restarts the server, commits, pushes or switches branches.

### 2.1 Page anatomy (every template)

```html
<!doctype html>
<html lang="en" data-app-color="{{COLOR}}">          <!-- pt-BR twin: lang="pt-BR" -->
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{{NAME}}</title>
  <link rel="stylesheet" href="/api/hub/apps/kit.css">
  <script src="/api/hub/apps/sdk.js"></script>        <!-- always before kit.js and the page's script -->
  <script src="/api/hub/apps/kit.js"></script>
  <style>/* only what this template needs that the kit has no class for; short */</style>
</head>
<body>
  <t-app>
    <t-nav label="Sections">
      <span class="t-nav-title"><span class="t-tile" aria-hidden="true">{{LETTER}}</span><span>{{NAME}}</span></span>
      <button data-view="main" data-icon="…">…</button>
      …
      <button data-view="settings" data-icon="settings" class="t-nav-end">Settings</button>   <!-- Ajustes, always last -->
    </t-nav>
    <main class="t-app-main">
      <t-view name="main"> <div class="t-page"> <header class="t-page-head"> <div><h1 class="t-title">{{NAME}}</h1><p class="t-muted">{{DESCRIPTION}}</p></div> <button class="t-button primary">…</button> </header> … </div> </t-view>
      <t-view name="settings"> … </t-view>
    </main>
  </t-app>
  <t-modal …> … </t-modal>
  <script> … one script … </script>
</body>
</html>
```

Rules:
- Only `{{NAME}}`, `{{LETTER}}`, `{{DESCRIPTION}}` in text, `{{COLOR}}` in `data-app-color`. Never put a placeholder inside JavaScript strings (they are HTML-escaped, not JS-escaped).
- The first view is the main job. `settings` is always the last nav button and uses `class="t-nav-end"` (kit pushes it to the bottom; on phones it is the last item of the bottom bar).
- Use `tkit.h` and `textContent` to put any user data on screen. **Never** `innerHTML` with data (markdown goes through `tkit.markdown`, which is safe).
- No `alert`, `confirm`, `prompt`: use `tkit.toast`, `tkit.confirm`, `<t-modal>`.
- No `localStorage` for anything that must survive (the frame has none that persists). Settings in `tendly.data`, records in collections.
- No network access to anything but GCore through the SDK. The single exception is the Mapa template (OpenStreetMap tiles and address search), described in its spec.
- `tendly.host.holdReload(true)` while a form has unsaved input; `false` when it closes or saves (the kanban template shows the pattern).

### 2.2 Data conventions

- **Records**: `const things = tendly.db.collection('<plural noun>')`; draw with `tkit.live(things, render, { onError })`. Record = `{ id, rev, created_at, updated_at, data }`.
- **Order** within a list or column: numeric `data.order`; to place between two items use the midpoint (see kanban `t-move`).
- **Updates**: `collection.update(id, patch, { rev })` from an editor that showed a record; on `error.code === 'conflict'` reload `error.current` into the form and toast "Someone changed this meanwhile; it was reloaded." (pt: "Alguém mudou isto enquanto isso; recarreguei.").
- **Settings**: one `tendly.data` key `settings`, an object with `v: 1` and the template's options, read with `tkit.settings('settings', DEFAULTS)` (kit). Merge saved over defaults so new defaults appear in old apps.
- **Examples**: inserted with `tkit.samples.load(collection, docs)`; they carry `data._sample = true`. Never mix: "Apagar exemplos" removes exactly the `_sample` records. When the person edits an example, the record keeps `_sample` (it is still an example) — the banner says "N exemplos" and the person can clear them.
- **Field ids**: lowercase ASCII, `[a-z0-9_]`, made once from the label (`tkit.slug(label)`, de-duplicated). Labels can change, ids never.
- **Dates** `YYYY-MM-DD`; date-times ISO 8601 with offset; money stored as a number in the currency's major unit (12.5 = R$ 12,50) and shown with `tkit.money(value, settings.currency)`.

### 2.3 The four features every template has (except Em branco, which stays minimal)

1. **Ajustes** (`settings` view): the template's everyday options (spelled out in each spec), then the shared blocks in this order, each a `.t-card`:
   - the template's own options;
   - **Dados** (Data): `Exportar CSV`, `Importar CSV` (kit `tkit.csv` + `<t-import>`);
   - **Exemplos** (Examples): `Ver com exemplos` / `Apagar exemplos` (count shown);
   - **Zona de perigo** (Danger zone): `Apagar todos os registros` behind `tkit.confirm` with tone danger and the exact count.
2. **Examples**: the empty state of the main view has two actions: the primary action (e.g. "Novo cartão") and a secondary "Ver com exemplos". While examples exist, `<t-sample-banner>` sits above the main content: "Você está vendo N exemplos. [Apagar exemplos]". Examples are realistic, neutral business data (no real brands, no real people's names beyond common first names, no CarSoul), 5–12 records, in the page's language, with dates relative to today (computed at load time, so they never look stale).
3. **CSV**: export uses the visible columns/fields with their labels as the header row, values formatted for a spreadsheet (dates `YYYY-MM-DD`, numbers with `.` decimal, choices as their label); file name `<app name> - <view> - YYYY-MM-DD.csv`. Import goes through `<t-import>`: choose a file → preview of the first 5 rows → map each CSV column to a field (auto-matched by label, case/accents folded) → "Importar N linhas". Invalid values are reported per row; nothing is written until the person confirms; rows are inserted with `insertMany`-style batching (sequential `insert`, with a progress toast every 50).
4. **Detail and context**: opening a record shows its detail (`<t-detail>` in a modal on desktop or a full view on phones — the kit decides) and sets the hash to `#<view>/<record id>` (`tkit.route`), so the link reopens it. While a record is open, call `tkit.context({ selection: '<Type>: <title>' })`; on close, `tkit.context({ selection: null })`. Each main view also sets `summary` (e.g. "12 cards: 5 To do, 4 Doing, 3 Done") whenever it renders.

### 2.4 States

Every view handles: **loading** (`<t-state kind="loading">`), **empty** (title + one sentence + actions), **error** (`kind="error"` with the message and "Tentar de novo"), **filtered to nothing** ("Nada encontrado" + "Limpar filtro"). Mutations show a toast only on failure or when the result is not visible (e.g. "Exportado: 24 linhas").

### 2.5 Text and language

- Two files per template: English (`templates/<id>.html`, `lang="en"`) and Brazilian Portuguese (`templates/pt-BR/<id>.html`, `lang="pt-BR"`). Same code, same ids, same structure; only visible strings (and example data) differ. Write the English one first, then translate; diff them at the end: only strings may differ.
- Portuguese: natural Brazilian Portuguese, "você", sentence case ("Novo cartão", not "Novo Cartão"), short labels, no anglicisms when a common word exists (Ajustes, Exportar, Apagar, Salvar, Cancelar, Buscar). Use the kit's own words when it has them (`tkit.t`).
- No em dash in UI copy. Numbers, dates and money through `tkit.number/date/money` (they follow `lang`).

### 2.6 Accessibility and responsiveness

- Real `<button>`s, every icon-only button has `aria-label`. Inputs have visible labels (`.t-field > span`).
- Keyboard: everything reachable by Tab; Enter opens a focused card/row; Esc closes modals (the kit does it).
- Phones (app narrower than 640px): the kit turns `t-nav` into a bottom bar; nothing may overflow horizontally; touch targets ≥ 44px; tables scroll inside `.t-table-scroll`, never the page.
- `prefers-reduced-motion`: no animation beyond the kit's.

### 2.7 Done means

1. Both files exist and differ only in visible text and `lang`.
2. `node --no-experimental-webstorage --import tsx --test --test-reporter=dot apps/web/src/features/hub/appsE-kit.test.mjs` passes (from the repo root with PATH including `/opt/homebrew/bin` and `~/.nvm/versions/node/v24.22.2/bin`). It parses every template for the kit tags, classes and helpers it uses and compiles the script.
3. Your spec's acceptance list is satisfied, item by item, and your report says how for each.
4. Report: files changed, any `KIT-CANDIDATE` blocks, anything in the spec you could not do and why. Do not claim browser checks you did not do; Opus checks in Chrome.

---

## 3. The catalogue (what exists after the three stages)

Grouped as the "Começar de" list will show them. `Base flexível` is first and highlighted.

| id | name (pt / en) | group | collection(s) | stage | spec |
|---|---|---|---|---|---|
| `base` | Base flexível / Flexible base | (destaque) | `records` | 1 | base.md |
| `blank` | Em branco / Blank | (destaque) | `items` | — | unchanged |
| `kanban` | Kanban / CRM | Organizar | `cards` | 1 | existing.md |
| `table` | Tabela / Table | Organizar | `entries` | 1 | existing.md |
| `catalog` | Catálogo / Catalog | Organizar | `items` | 2 | catalog.md |
| `calendar` | Calendário / Calendar | Agenda | `events` | 1 | existing.md |
| `booking` | Reservas / Bookings | Agenda | `resources`, `bookings` | 3 | booking.md |
| `dashboard` | Painel com gráficos / Dashboard | Acompanhar | `entries` | 1 | existing.md |
| `checklist` | Checklist / Rotina | Acompanhar | `routines`, `runs` | 2 | checklist.md |
| `form` | Formulário + lista / Form + list | Coletar | `submissions` | 1 | existing.md |
| `quiz` | Quiz / Avaliação | Coletar | `questions`, `attempts` | 3 | quiz.md |
| `calculator` | Calculadora / Simulador | Decidir | `scenarios` | 2 | calculator.md |
| `compare` | Comparador / Comparison | Decidir | `options` | 2 | compare.md |
| `knowledge` | Base de conhecimento / Knowledge base | Conteúdo | `articles` | 1 | existing.md (replaces `document`) |
| `map` | Mapa / Locais / Map | Conteúdo | `places` | 3 | map.md |

Deferred to multi-user (Phase 6): Portal / Central de acessos, Mural / Feed.

`document` keeps working for apps already made from it (the server keeps the id as an alias of `knowledge`), but it is no longer listed.

## 4. Stages

1. **Kit + Base flexível + current templates upgraded** (kit.md, base.md, existing.md). Kit first, alone; then the templates in parallel.
2. **Catálogo, Checklist, Calculadora, Comparador.**
3. **Reservas, Quiz, Mapa** (Mapa needs Leaflet vendored: Opus asks Ian before downloading it), the grouped list in the builder, and the skill update.

Ian reviews at the end of each stage.
