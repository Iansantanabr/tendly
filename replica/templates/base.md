# Base flexível / Flexible base (`base`) — stage 1

Files: `templates/base.html`, `templates/pt-BR/base.html`. Collection `records`. Settings key `settings`.

## Job

A small database the person shapes themself: they choose the fields, and see the same records as a **table**, a **board**, a **gallery** or a **calendar**. It is GCore's "start from anything" template and the first one in the list. Think "a tidy Airtable for one person", not a spreadsheet engine.

Typical uses: clientes, fornecedores, equipamentos, pedidos, ideias, contatos, imóveis, cursos.

## Settings shape

```js
const DEFAULTS = {
  v: 1,
  currency: 'BRL',            // en twin: 'USD'
  titleField: 'name',
  fields: [
    { id: 'name',   label: 'Nome',   type: 'text', required: true },
    { id: 'status', label: 'Status', type: 'choice', options: [
        { id: 'todo', label: 'A fazer', tone: '' }, { id: 'doing', label: 'Fazendo', tone: 'warn' }, { id: 'done', label: 'Feito', tone: 'ok' } ] },
    { id: 'date',   label: 'Data',   type: 'date' },
    { id: 'notes',  label: 'Notas',  type: 'longtext' }
  ],
  views: [
    { id: 'table',    type: 'table',    name: 'Tabela',     columns: ['name', 'status', 'date'], sort: { field: 'name', dir: 'asc' } },
    { id: 'board',    type: 'board',    name: 'Quadro',     groupBy: 'status' },
    { id: 'calendar', type: 'calendar', name: 'Calendário', dateField: 'date' }
  ]
};
```
(English twin: Name, Status, To do/Doing/Done, Date, Notes; Table, Board, Calendar.)

View types and their options:
- `table`: `columns` (field ids, ordered), `sort`. Rendered with `<t-table searchable>`; formula and money columns right-aligned (`type: 'number'` in t-table).
- `board`: `groupBy` (a `choice` field id). `<t-kanban>`; dragging changes that field and `order`. Records with no value go in a first column "Sem valor" that only shows when non-empty.
- `gallery`: `imageField` (an `image` field id, optional), `subtitleField` (optional), `badgeField` (a `choice`, optional). `<t-gallery>`.
- `calendar`: `dateField` (a `date`/`datetime` field). `<t-calendar>` + the day's list under it (like the calendar template). Clicking an empty day → new record with that date.

## Screens

Nav (built **at runtime** from `settings.views`, because the person adds views): one button per view with the view type's icon (`table`, `board`, `image`, `calendar`), then **Ajustes** last. Build the buttons and `<t-view>`s with `tkit.h`, insert them before the Ajustes button / view, then call `app.refresh()` (kit stage 1 makes `<t-nav>` and `<t-app>` accept screens added later). On a settings change, rebuild only what changed and call `app.refresh()` again.

One `<t-view name="v-<view id>">` per view, built at runtime too, each with:
- header: `{{NAME}}` title (only on the first view; others show the view name) + description, primary button "Novo registro" (en "New record"), a search input (filters all view types by any text field) and, when the base has a `choice` field, `<t-pills>` to filter by it (the board's groupBy field or the first choice field).
- the view's element.
- `<t-sample-banner>` when examples exist.

Record editing: `<t-modal>` with `<t-record-form>` (+ Salvar / Cancelar / Apagar). Detail: `<t-detail>` with actions Editar / Apagar; prev/next follow the current view's order.

**Ajustes** view, cards in this order:
1. **Campos** (Fields): `<t-fields-editor>`; `.inUse` counts non-empty values per field. Choose the title field (select of text fields) right under it.
2. **Visões** (Views): a list of the views (name input, type shown as a badge, the type's options as selects filtered to suitable fields, ↑/↓, delete; at least one view must remain), and "Adicionar visão" with a menu Tabela / Quadro / Galeria / Calendário. Adding a board needs a choice field: if none exists, offer "Criar um campo de escolha" which adds one named "Etapa"/"Stage" with three options.
3. **Moeda** (Currency): select BRL / USD / EUR (only when a money field exists).
4. Dados (CSV), Exemplos, Zona de perigo — as in README §2.3. CSV export uses all fields in field order (formulas computed).

## Examples (pt; en analogous)

Fields for the example set must match the defaults (so loading examples into a reshaped base still works: insert only the values whose field ids exist; skip others). 8 records like "Renovar contrato de limpeza" / Fazendo / today+3, "Orçamento da reforma da recepção" / A fazer / today+10, "Comprar cadeiras para a sala 2" / Feito / today-5 … with short notes.

## Context

summary per view: "Tabela: 14 registros (3 filtrados)", board "Quadro por Status: A fazer 5, Fazendo 4, Feito 5", gallery "Galeria: 14 registros", calendar "Calendário de novembro: 6 registros". selection when a detail is open: "Registro: <title>".

## Edge cases to handle

- A view pointing at a field that was deleted: show `<t-state kind="empty" title="Esta visão precisa de um campo de escolha">` with a button "Abrir Ajustes".
- Field renamed: views and records keep working (ids).
- Choice option deleted while in use: records keep the old id; display shows the raw id muted with "(opção removida)".
- 1,000+ records: table and gallery stay responsive (gallery renders the first 200 with "Mostrar mais").

## Acceptance

1. Empty base opens on Tabela with an empty state offering "Novo registro" and "Ver com exemplos".
2. Add a field "Valor" (money) and a formula field "Valor com imposto" = `valor * 1.1` in Ajustes; both appear in the form, the formula is read-only and computed; the table can show both.
3. Add a Galeria view with an image field; upload an image in a record; the gallery shows it.
4. Board drag changes the record's choice value and order; reload keeps it.
5. Calendar: click a day → form opens with that date; the record appears on that day.
6. Detail opens with its own `#v-table/<id>` hash; reloading the page reopens it; the agent context selection is set.
7. CSV export then import of the same file creates the same records (except ids).
8. Two panes of the same app: a change in one shows in the other (tkit.live).
9. Everything in pt-BR in the pt-BR file; the en file identical except text.
