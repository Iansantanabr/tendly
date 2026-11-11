# Current templates, upgraded (stage 1)

Six templates are upgraded; `blank` stays as it is. Each upgrade keeps the template's **collection name and record fields** exactly as today, because apps already made from them hold data in that shape; you may add fields, never rename or remove one.

Every upgraded template gains the four shared features of README §2.3 (Ajustes with Dados/Exemplos/Zona de perigo, examples with `<t-sample-banner>`, CSV export/import, detail + context). Below is only what is specific to each. Each template is assigned to one agent; the agent edits only `templates/<id>.html` and `templates/pt-BR/<id>.html`.

Shared reminders: settings via `tkit.settings('settings', DEFAULTS)`; the main view sets `tkit.context({ summary })` on every render; detail via `<t-detail>` with the field list described below (define the template's fields once as a `FIELDS` constant in the page, the same schema format as the kit's `<t-record-form>`, and use `<t-record-form>` for the editor modal too, unless the spec says the editor is custom).

---

## kanban — Kanban / CRM (collection `cards`)

Today: columns in `tendly.data` key `columns`; cards `{ title, column, text, order }`.
Change:
- Settings key stays compatible: read `settings` with defaults `{ v: 1, columns: <the three defaults>, fields: [] , currency: 'BRL' }`; **migration**: if `settings` has no `columns` but the old `columns` key exists, use it and save it into `settings` (keep the old key untouched).
- Card fields: `title` (text, required), `text` (longtext, label "Notas"), plus optional, off by default, toggled in Ajustes: `value` (money, label "Valor"), `due` (date, "Prazo"), `owner` (text, "Responsável"). Card meta line shows value and due when on (due in red tone when past).
- Ajustes: **Colunas** (`<t-list-editor tones>`; `.inUse` = cards per column; deleting a column with cards asks where to move them: a select of the remaining columns, then moves them), **Campos do cartão** (three switches for value/due/owner), **Moeda** (when value is on), then the shared blocks.
- Column header shows the count and, when `value` is on, the column total (`tkit.money`).
- Detail: `<t-detail>` with the enabled fields + column; actions Editar, Mover para… (select), Apagar.
- Examples (pt): a small sales funnel: 8 cards over the three default columns ("Proposta para escritório de contabilidade", value 4800, due +5 …).
- summary: "Quadro: 12 cartões. A fazer 5, Fazendo 4, Feito 3".

## table — Tabela (collection `entries`)

Today: `{ name, category, amount, date, notes }`, categories free text with a datalist, totals on top.
Change:
- Settings `{ v: 1, categories: [] (options {id,label,tone}), currency: 'BRL', amountLabel: 'Valor' }`. Categories become a managed list in Ajustes (`<t-list-editor tones>`); records keep storing the **label text** in `category` (compatibility with existing data); when a category is renamed in Ajustes, offer "Atualizar N registros" which rewrites the label in those records. Free-typed categories not in the list still display (as plain badge) and are offered in Ajustes as "Adicionar à lista".
- Totals cards: count, sum of amount, sum this month; pills by category with count; the table footer row shows the filtered sum.
- Ajustes: **Categorias**, **Moeda**, **Nome da coluna de valor** (text input: "Valor", "Custo", "Horas"… the label used everywhere), then shared blocks.
- Examples: 10 expenses/purchases across 4 categories over the last 40 days.
- summary: "Tabela: 24 registros, total R$ 3.420,00 (filtro: Material)".

## calendar — Calendário (collection `events`)

Today: `{ title, date, time, tone }`.
Change:
- Settings `{ v: 1, categories: [{id,label,tone}] (default: Reunião/accent, Prazo/warn, Pessoal/ok), weekStart: 0|1 (pt default 0 = domingo), showWeekends: true }`. Events gain optional `category` (option id), `end` (time), `place` (text), `notes` (longtext). `tone` stays for old events: display tone = category tone if category else `tone`.
- Add a second view **Agenda** (`data-icon="list"`): the next 30 days grouped by day ("Hoje", "Amanhã", "qui., 14 de nov."), each with time, title, category badge; empty: "Nada nos próximos 30 dias".
- Ajustes: **Categorias** (`<t-list-editor tones>`), **Semana começa** (`.t-segment` Domingo/Segunda), then shared blocks.
- Detail: date, time–end, place, category, notes; actions Editar, Duplicar (opens the editor prefilled, date +7), Apagar.
- Examples: 9 events over the current and next month (relative dates), mixed categories.
- summary: "Calendário de novembro: 9 eventos; hoje: 2".

## dashboard — Painel com gráficos (collection `entries`)

Today: `{ date, amount, category, notes }`; totals, by month, by category.
Change:
- Settings `{ v: 1, metricLabel: 'Valor', unit: 'money' | 'number', currency: 'BRL', categories: [], goal: null, period: 'month' }`.
- Overview: four stat cards (Total no período, Média por lançamento, Maior categoria, Meta: x% when `goal` set, with a `<t-progress>`), period `.t-segment` (Mês / Trimestre / Ano / Tudo) filtering everything, the two charts (by month as bar, by category as bar sorted desc), and "Últimos lançamentos" (5 rows, link "Ver todos").
- Ajustes: **Métrica** (label + unit money/number + currency), **Meta** (number per period, optional), **Categorias** (list editor, same compatibility rule as Tabela: store the label), then shared blocks.
- Examples: 30 entries over the last 6 months, 4 categories, a visible trend.
- summary: "Painel (trimestre): total R$ 18.300,00 em 42 lançamentos; meta 76%".

## form — Formulário + lista (collection `submissions`)

Today: fixed fields name, email, phone, subject (select), message.
Change:
- The form becomes schema-driven: settings `{ v: 1, title: '<{{NAME}}>' , intro: '', fields: [the five current fields as a schema with the same ids], thanks: 'Recebido. Obrigado!', statuses: [{id:'new',label:'Novo',tone:'accent'},{id:'seen',label:'Visto',tone:''},{id:'done',label:'Resolvido',tone:'ok'}] }`. Do **not** put `{{NAME}}` inside the script: read the title from the DOM `<h1>` at start-up when settings has no title.
- Fill view: `<t-record-form>` from `settings.fields` + Enviar / Limpar; after sending show the thanks message with "Enviar outro".
- Submissions view: `<t-table>` with columns from the fields (first four non-longtext) + Status + Recebido; pills by status; each submission has `status` (new by default); detail shows all answers, status select, and "Copiar respostas" (plain text to clipboard via `navigator.clipboard` with a fallback textarea).
- Ajustes: **Formulário** (title, intro, thanks message), **Campos** (`<t-fields-editor>`, no `formula` type offered here), **Status** (list editor), then shared blocks.
- Old submissions (without `status`) count as "Novo".
- Examples: 7 submissions with varied subjects and statuses.
- summary: "Formulário: 18 respostas, 5 novas".

## knowledge — Base de conhecimento (replaces `document`, collection `articles`)

New file pair `templates/knowledge.html` + `templates/pt-BR/knowledge.html`. (`document.html` stays in the repo; the server will map the `document` id to it for old references — Opus handles the registry.) The collection is **`articles`**, not `docs` (new apps only; old document apps keep their own page).

Article: `{ title, body (markdown), topic (option id), tags: [text], summary (short text), pinned: bool, order }`.
Settings `{ v: 1, topics: [{id,label,tone}] (default: Geral, Procedimentos, Perguntas frequentes, Políticas), home: 'topics' }`.

Screens:
- **Início** (`data-icon="book"`): search box (searches title, summary, tags and body; results list with the matching snippet, matched words in `<mark>`), "Fixados" (pinned articles as cards), then topics as sections each listing its articles (title + summary). Primary "Novo artigo".
- **Article** (a view `article` reached by `tkit.route` `#article/<id>`; not in the nav): breadcrumb "Início › Tópico", title, meta (topic badge, tags, "Atualizado há 2 dias"), body rendered with `tkit.markdown` and `linkArticle` resolving `[[Título]]` to `#article/<id>` by case/accent-folded title; an unresolved wiki link click offers "Criar artigo 'Título'". On the side (below on phones): "Neste artigo" (the article's headings as anchor links) and "Artigos relacionados" (same topic, up to 5). Buttons Editar, Fixar/Desafixar, Apagar.
- **Editor** (modal or full view on phones): title, topic select, tags (comma-separated input shown as chips), summary, and the body in a monospace `<textarea>` with a toolbar (Negrito, Itálico, Título, Lista, Link, Link para artigo) that wraps the selection with markdown, plus a "Visualizar" toggle (`.t-segment` Escrever / Visualizar). Autosave: 800 ms after the last keystroke, with `rev` conflict handling and a small "Salvo" / "Salvando…" status; `holdReload(true)` while there are unsaved keystrokes.
- **Ajustes**: **Tópicos** (list editor; deleting a topic with articles asks where to move them), then shared blocks (CSV exports title, topic label, tags, summary, body).
- Examples: 6 short articles in 3 topics, linking each other with `[[…]]` (e.g. "Como abrir um chamado", "Política de reembolso", "Perguntas frequentes sobre férias"), one pinned.
- summary: "Base de conhecimento: 23 artigos em 4 tópicos". selection on an article: "Artigo: <title>".

---

## Acceptance (each template)

1. An app already made from the old template version keeps its data and shows it correctly after its `index.html` is replaced by the new one (test mentally against the old record shapes listed above; for kanban, the old `columns` key migrates).
2. The four shared features work as in README §2.3.
3. The template-specific items above, one by one.
4. `appsE-kit.test.mjs` passes; en and pt-BR differ only in text.
