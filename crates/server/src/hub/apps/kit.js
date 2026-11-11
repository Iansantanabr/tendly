/**
 * Tendly app kit, served at /api/hub/apps/kit.js. Web components and helpers
 * for apps, no build step. Include it after the SDK and the kit's stylesheet:
 *
 *   <link rel="stylesheet" href="/api/hub/apps/kit.css">
 *   <script src="/api/hub/apps/sdk.js"></script>
 *   <script src="/api/hub/apps/kit.js"></script>
 *
 * Everything is plain DOM (no shadow DOM): kit.css and the app's own CSS reach
 * every element. Events are CustomEvents that bubble, with the detail below.
 *
 * ELEMENTS
 *   <t-app view="board">            the shell: a sidebar <t-nav> that becomes a bottom bar when the app
 *                                   is narrower than 640px, and <main class="t-app-main"> with one
 *                                   <t-view name="…"> per screen. app.view = 'board' switches; the hash
 *                                   keeps it ("#board", or "#board/<id>": the view is what is before the first
 *                                   slash; the rest is the page's, see tkit.route); event "t-view" {view}.
 *                                   It tells Tendly the view's name (tendly.host.setContext) so the chat chip
 *                                   reads "App · Board". Switching view clears the context's selection and summary.
 *                                   app.refresh() re-reads the views and nav buttons after a page added or
 *                                   removed some at run time (keeps the current view if it still exists).
 *   <t-nav label="Sections">        <button data-view="board" data-icon="board">Board</button> …
 *                                   (a button without data-view is an ordinary action). An optional
 *                                   <span class="t-nav-title"> on top shows the app's name. Buttons added later
 *                                   get their icon too. class="t-nav-end" on the last one (Settings) pushes it
 *                                   to the bottom of the sidebar; it is always the last item of the phone bar.
 *   <t-view name="board">           one screen; only the active one is shown.
 *   <t-kanban addable>              .columns = [{ id, title }], .cards = [{ id, column, title, text?, meta?, tone? }]
 *                                   drag (mouse: at once; touch: hold 350 ms) and ← → with a card focused;
 *                                   events "t-move" {id, to, index, card}, "t-open" {id, card}, "t-add" {column}.
 *   <t-table searchable>            .columns = [{ key, label, type?: 'text'|'number'|'date'|'badge', format? }],
 *                                   .rows = [{ id, … }], .filter = fn(row) (pills, say); sorts by a column
 *                                   header; event "t-open" {id, row}. Attribute empty-text.
 *   <t-pills>                       .options = [{ value, label, count? }], .value; event "t-change" {value}
 *   <t-modal title="New card">      its children become the body of a <dialog>; .open(), .close();
 *                                   event "t-close". <form method="dialog"> inside closes it.
 *   <t-state kind="empty" title="…" text="…">   also kind="loading" | "error"; children are its actions.
 *   <t-chart type="bar" label="…">  .data = [{ label, value }]; type "bar" or "line"; SVG, no library.
 *   <t-calendar month="2026-11">    .events = [{ id, date: 'YYYY-MM-DD', title, tone? }], .selected;
 *                                   events "t-day" {date}, "t-open" {id, event}, "t-month" {month}.
 *
 * ELEMENTS, version 2 (fields are described under SCHEMA below)
 *   <t-record-form>                 .fields, .value = {…}, .settings = { currency }. One .t-field per field with the
 *                                   right input; formula fields read-only and live. .submit() -> Promise of the data to
 *                                   save (normalized; other keys of .value kept; pending image/file uploaded through
 *                                   tendly.files.upload and stored as { path, name, type }) or rejects with an Error
 *                                   (code "invalid", .errors {fieldId: message}) after showing the errors inline.
 *                                   Event "t-input" {field} on every change (holdReload). No buttons: the page adds
 *                                   its own Save/Cancel. .focus() goes to the first input.
 *   <t-list-editor tones>           .items = [{ id, label, tone? }], .addLabel, .inUse = { id: count }. Drag by the dots
 *                                   or use the up/down buttons; label edits commit on Enter/blur; deleting an item in use
 *                                   asks first (the records keep the value). Attribute tones adds the colour picker. New
 *                                   ids via tkit.slug. Event "t-change" {items}, never per keystroke.
 *   <t-fields-editor>               .fields, .inUse = { fieldId: count }, .optionsInUse = { fieldId: { optionId: count } },
 *                                   .types = [allowed types] (or attribute types="text,number"; default all). Label, type,
 *                                   required, options (nested list editor), currency, formula (checked live against the
 *                                   other ids). A field added a moment ago gets its id from the name typed first.
 *                                   Event "t-change" {fields}. Setting .fields/.items to what it just emitted is a no-op.
 *   <t-detail title-field="name">   .fields, .record (a record), .settings, .siblings = [ids]; children with
 *                                   slot="actions" become its footer. .open() / .close(): a drawer on the right (full
 *                                   screen under 640px); opening sets the hash to "#view/<id>" and tkit.context
 *                                   {selection: "<label>: <title>"}, closing undoes both. Events "t-close", "t-nav" {id}
 *                                   (the prev/next buttons; the page sets .record again). .opened tells if it is showing.
 *   <t-import>                      .fields; .open() -> Promise of [data objects] or null (cancelled): choose or drop a
 *                                   .csv, map each column to a field (matched by label), review, import. The page inserts.
 *   <t-sample-banner>               .count; "You are seeing N examples." + Delete examples -> event "t-clear". Hidden at 0.
 *   <t-gallery empty-text="…">      .items = [{ id, title, subtitle?, image?, badge?, tone?, meta? }]; cards focusable;
 *                                   Enter/click -> "t-open" {id, item}.
 *   <t-checklist>                   .items = [{ id, label, done, note?, required?, by?, at? }], .readonly; shows progress.
 *                                   Click -> "t-toggle" {id, done}. The box shows the new state at once; set .items again
 *                                   with the saved state (also after a failed save, so it snaps back).
 *   <t-progress value max label>    a bar and "3 of 10"; tone ok at 100%.
 *   <t-steps>                       .steps = [labels], .current = index; "Step 2 of 5" on a phone.
 *
 * HELPERS (window.tkit)
 *   tkit.h(tag, props, ...children)   an element: props are attributes, class, text, dataset, on* handlers
 *   tkit.icon(name, size)            an inline SVG (tkit.icons lists the names)
 *   tkit.toast(text, { tone, ms })   a short message inside the app (tone: 'info' | 'success' | 'error')
 *   tkit.confirm(text, { confirm, cancel, tone })  a dialog; resolves true or false. Never window.confirm.
 *   tkit.live(collection, render, { where, order, limit, onError })
 *                                    loads a collection, subscribes, and calls render(records) on every
 *                                    change by any pane or agent. Returns { records, ready, reload, stop }.
 *   tkit.form(form) / tkit.fill(form, values)   the fields of a <form> as an object, and back
 *   tkit.date(value, style), tkit.ago(value), tkit.money(value, currency), tkit.number(value)
 *   tkit.filterRows(rows, text, keys), tkit.sortRows(rows, key, dir), tkit.groupBy(list, key),
 *   tkit.monthGrid(year, month, weekStart), tkit.today()    pure helpers (kit.test.mjs covers them)
 *   tkit.t(key)                      the kit's own few strings, in the page's language (en, pt)
 *
 * HELPERS, version 2 (tkit.version is 2, tkit.minor 2; kit-v2.test.mjs covers every pure one)
 *   tkit.parseRoute(hash)            '#board/a%20b' -> { view: 'board', id: 'a b' }; '' -> { view: '', id: null }
 *   tkit.route.get()                 { view, id } now.            tkit.route.close()   sets "#<view>"
 *   tkit.route.open(id)              sets "#<view>/<id>" (the view does not change)
 *   tkit.route.on(fn)                fn({ view, id }) on every hash change and once at start (after <t-app> showed
 *                                    its first view); returns a stop function. Use it to reopen a record from a link.
 *   tkit.context({ selection?, summary? })  merges into what the agent is told (null clears a key) and calls
 *                                    tendly.host.setContext({ view, selection, summary }); silent outside Tendly.
 *                                    <t-app> clears both on a view switch: set summary again on the "t-view" event.
 *   tkit.settings(key, defaults)     Promise of S: S.value (defaults under the stored value, deep; arrays from storage
 *                                    replace whole; always has v), S.save(patch) (shallow merge, writes the whole value
 *                                    with tendly.data.set, shows at once, taken back if the write fails; Promise),
 *                                    S.on(fn) (fn(value) after each save; returns a stop function), S.error (the read
 *                                    failed: defaults are in use). tkit.mergeSettings(defaults, stored) is the pure part.
 *   tkit.samples.load(coll, docs)    inserts each doc with data._sample = true; Promise of how many
 *   tkit.samples.clear(coll)         removes exactly the records with _sample; Promise of how many
 *   tkit.samples.count(records)      how many records are examples;   tkit.daysFromToday(n)  'YYYY-MM-DD', n days from today
 *   tkit.csv.stringify(rows, columns, { delimiter? })  columns = [{ key, label, format?(value, row) }] -> text with a header,
 *                                    CRLF, RFC 4180 quoting and a BOM; cells that start with = or @ get a ' in front
 *   tkit.csv.parse(text)             -> { header, rows, delimiter }: quotes, doubled quotes, newlines in quotes, BOM
 *                                    stripped, "," ";" or a tab found in the header line; short rows padded
 *   tkit.csv.delimiter()             ";" in Portuguese (what Brazilian Excel splits on), "," otherwise
 *   tkit.csv.download(text, filename) / tkit.download(blob, filename)   save a file (a temporary <a download>)
 *   tkit.formula.compile(text, ids)  -> { ok: true, deps, run(values, { today? }) } or { ok: false, error, at }; ids are the
 *                                    names a formula may use (leave out to allow any). tkit.formula.evaluate(text, values)
 *                                    -> the result. No eval. Numbers (1.5, decimal point only), "text" (a "" inside is a
 *                                    quote), true/false, field ids; ^ (right-assoc, tighter than unary -), * / %, + -, &
 *                                    (join text), = <> < <= > >=, not, and, or. Functions (tkit.formula.functions):
 *                                    if(c,a,b) min max sum avg (skip empty values) round(x,n=0) floor ceil abs sqrt
 *                                    days(a,b) today() year month len upper lower concat pct(part,whole) coalesce.
 *                                    An empty input makes arithmetic empty (null, shown as a dash); division by zero is
 *                                    null; an empty value is false in comparisons. Names are not case sensitive.
 *   tkit.markdown(text, { linkArticle?(title) -> href|null, headingBase? })   a DocumentFragment, DOM nodes only. # ## ###
 *                                    (tags h2 h3 h4 by default), paragraphs (a newline is a line break), **bold** *italic*
 *                                    `code`, fenced code, - * 1. lists (one level of nesting), > quote, ---, [text](http|https|
 *                                    mailto), [[Wiki links]] (resolved through linkArticle; unresolved ones are a button
 *                                    ".t-wikilink.missing" that fires "t-wikilink" {title} on click). Anything else, HTML
 *                                    included, is text. Put it in <div class="t-md">. Headings carry data-anchor.
 *   tkit.parseMarkdown(text)         the tree it is built from (pure); tkit.markdownOutline(text) -> [{ level, text, anchor }]
 *   tkit.fold(text)                  lowercase, accents removed (to match labels and search)
 *   tkit.parseNumber(text)           "1.234,5" (pt) / "1,234.5" (en) / "1234.5" / "R$ 12,50" -> number or null
 *
 * SCHEMA (what the forms, details, CSV and editors share)
 *   A field is { id, label, type, options?, required?, help?, formula?, currency?, placeholder?, creatable? }; type is one of
 *   tkit.fieldTypes: text longtext number money date datetime time choice multi checkbox image file url email phone formula
 *   (formula is read-only, computed from `formula`; image/file are { path, name, type } of tendly.files).
 *   An option is { id, label, tone? }, tone one of tkit.tones: '' accent ok warn danger info violet (the .t-badge colours).
 *   Ids are [a-z0-9_] and never change once made; labels can. Dates are YYYY-MM-DD, date-times ISO 8601 with an offset,
 *   money a number in the major unit, multi an array of option ids, empty is null.
 *   tkit.slug(label, taken)          'Valor total' -> 'valor_total', 'valor_total_2' if taken; never starts with a digit
 *   tkit.fieldValue(field, raw)      what to store for what was typed (numbers by the page's language; a label from a CSV
 *                                    finds its option id; what cannot be read stays as text so validate can say so)
 *   tkit.fieldText(field, value, settings?)  what to show (choice -> label, money with settings.currency, dates, Sim/Nao...)
 *   tkit.validate(fields, data)      { ok, errors: { fieldId: message } }: required, numbers, e-mail, http(s) links, dates
 *   tkit.compute(fields, data)       a copy of data with every formula field computed; failures give null and are in
 *                                    result._errors (not enumerable); cycles say "Circular formula"
 *
 * KIT v2.1 (tkit.minor is 1; tkit.version stays 2; kit-v2.test.mjs covers every pure part)
 *   <t-data-tools hide="import examples danger">   the Dados, Exemplos and Zona de perigo cards of an Ajustes screen (Data, Examples,
 *                                    Danger zone). .collection (a tendly.db collection), .fields (schema: CSV columns and import),
 *                                    .records (the current records: counts, and what to export), .examples (array of docs, or a
 *                                    function called at click time so dates are fresh), .filename ('Cards': the file is
 *                                    "<document.title> - Cards - YYYY-MM-DD.csv"), .noun { one, many } ('card', 'cards'),
 *                                    .exportRows (records -> rows; default: tkit.compute of each record's data), .exportColumns (array or
 *                                    function; default tkit.csv.columnsFor(fields)), .beforeInsert (doc -> doc | null to skip, for
 *                                    importing), .beforeExamples (async, runs before examples load: seed settings). Hides: export
 *                                    import examples danger. Events "t-imported" {count, failed}, "t-examples" {action: 'loaded'|'cleared',
 *                                    loaded, cleared, count}, "t-cleared" {count}. Import inserts one by one with a progress toast every 50.
 *   <t-empty-start title text action>  the main view's empty state: <t-state> with a primary button (the `action` label; none if
 *                                    left out) and "See with examples". Events "t-action" and "t-examples"; it calls nothing itself.
 *   <t-table>.footer = { key: 'sum' | 'avg' | 'count' | 'text' | fn(rows, column) }   a <tfoot> over the rows shown (filtered, searched),
 *                                    kept through sorting; money/number cells like their column. count = rows with a value in it.
 *   <t-kanban>.columnMeta = fn(columnId, cards) -> text   shown in each column header after the count (a money total, say).
 *   <t-calendar hide-weekends week-start="1">   5 columns; events on a Saturday or Sunday are listed under the Friday they follow,
 *                                    after a "+ weekend" label (a grid that starts on a weekend day uses the Friday after it).
 *   <t-fields-editor>.extra = fn(field) -> Node | null   the page's own controls inside the field's detail panel (a switch, a number
 *                                    box); any field type gets the panel when it returns a Node. fe.update(fieldId, patch) changes a
 *                                    field from such a control and fires "t-change" without redrawing (undefined removes a key).
 *   <t-record-form>   type "time" (HH:MM, <input type="time">); a choice or multi field with creatable: true ends with "New option…":
 *                                    type the label, Enter adds { id: tkit.slug(label), label } to the form's field and fires
 *                                    "t-option-added" {fieldId, option} so the page saves it; Esc cancels. Setting .fields to what
 *                                    the page saved afterwards keeps what was typed.
 *   tkit.h('t-state', { title, text, kind })   for tags starting with t-, props (text and title included) are attributes; other
 *                                    tags keep text -> textContent. Objects and functions are still assigned as properties.
 *   tkit.copy(text)                  Promise of true/false: Clipboard API, else a hidden textarea; a "Copied" toast on success.
 *   tkit.csv.columnsFor(fields, settings)  columns for tkit.csv.stringify from a schema: labels as header, numbers with ".", dates
 *                                    and times ISO, choices by label, files by name (compute formula fields first). tkit.csv.filename(app, name, day)
 *                                    is the file name "<app> - <name> - day.csv" without characters a file cannot have.
 *   tkit.search.match(text, query)   [[start, end)] of every query word (accents and case ignored; every word must be there) or null
 *   tkit.search.highlight(text, ranges)  a DocumentFragment with <mark> around the ranges;  tkit.search.snippet(text, ranges, size = 160)
 *                                    about `size` characters around the first range, with … at cut ends ('' with no match)
 *   tkit.autosave(saveFn, { delay: 800, onStatus(status, error) })  -> { touch(), flush(), status, error }: debounced, one save at a
 *                                    time; status idle | typing | saving | saved | error; tendly.host.holdReload(true) while there is
 *                                    unsaved text, false once saved; an error keeps it dirty (next touch or flush retries). flush() is
 *                                    a Promise that resolves when nothing is pending (use it before leaving the editor).
 *   tkit.textarea.wrap(area, before, after, placeholder?)  wraps the selection (placeholder if none) / .prefixLines(area, prefix) toggles
 *                                    a prefix on the selected lines; execCommand('insertText') so undo works, else setRangeText.
 *                                    wrapEdit / prefixEdit are the pure parts: (value, start, end, …) -> { from, to, insert, selFrom, selTo }.
 *   tkit.tableFooter(columns, footer, rows) and tkit.weekdayGrid(year, month, weekStart) are the pure parts of the footer and hide-weekends.
 *
 * CSS classes added in kit.css: t-nav-end, t-card-head, t-kv, t-segment (buttons with aria-pressed), t-switch (a checkbox),
 * t-drawer, t-chip, t-input-group, t-pre, t-md, t-badge.info and .violet; see kit-demo.html for every element working.
 *
 * KIT v2.2 (tkit.minor is 2; tkit.version stays 2; kit-v2.test.mjs covers every pure part)
 *   <t-row-editor>                   an ordered list of rows whose cells the page builds. .rows = [{ id, … }], .cells = fn(row, change) -> Node |
 *                                    Node[] (change(patch) merges into that row and tells the page, undefined removes a key; change(patch,
 *                                    { redraw: true }) also draws the cells again), .addLabel, .newRow = fn() -> row (an id is made if
 *                                    missing), .canRemove = fn(row) -> true | 'reason' (anything else keeps the row and toasts the
 *                                    reason), .confirmRemove = async fn(row) -> boolean. Each row: drag handle, the cells, up/down and remove
 *                                    buttons. Event "t-change" {rows} once per commit (a cell's own change/blur/Enter, reorder, add,
 *                                    remove), never per keystroke; setting .rows to what it just emitted is a no-op; .refresh() draws
 *                                    the cells again. Focus survives a redraw.
 *   <t-menu label="Actions">         the "…" button. .items = [{ id, label, icon?, tone?: 'danger', disabled? } | '-'] opens a popover under the
 *                                    button (above it near the bottom; inside the app), role="menu": arrows, Home, End, a letter, Enter,
 *                                    Esc (focus goes back to the button), Tab or a click outside close it. Event "t-select" {id}. .open(),
 *                                    .close(), .opened. Clicks and keys inside do not reach a clickable row around it.
 *   tkit.editCell(button, spec)      makes a <button class="t-cell"> editable in place; returns { open(), cancel(), spec }. Click/Enter swaps
 *                                    in the input, Enter or leaving it saves, Esc cancels (focus back on the button). spec = { type: 'number' |
 *                                    'money' | 'score' (1-5 radio stars, min/max) | 'yesno' | 'text' | 'choice' (options), value, options?,
 *                                    currency?, min?, max?, label, format?(value), save: async fn(value) }. While save() runs the cell is busy;
 *                                    on success the button shows the new text (in its [data-cell-value] element if it has one, else all of it);
 *                                    on failure the editor stays with the error. tkit.cellValue(spec, raw) -> { ok, value } | { ok: false, error }
 *                                    is the parsing ("12,5" -> 12.5, min/max, y/n -> true/false, a choice label -> its id, empty -> null) and
 *                                    tkit.cellText(spec, value) the shown text (money, stars, Yes/No, label, "—").
 *   <t-gallery placeholder="letter" sortable>   placeholder="letter": an item with no picture shows a tile with the first letter of its title
 *                                    in the item's tone (accent ok warn danger info violet; tkit.letterOf is the pure part). items[].badges =
 *                                    [{ text, tone }] (several; badge still works), items[].muted dims a card. sortable (attribute or property)
 *                                    is the reorder mode: each card gets a handle (drag) and up/down buttons (Alt + arrows on a focused card
 *                                    too), cards do not open; event "t-reorder" {ids} with the whole new order (the gallery already shows it).
 *   tkit.moveId(ids, id, to)         a copy of ids with id moved to index `to`;  tkit.dropIndex(rects, x, y, axis) where a drag lands ('y' list, 'xy' grid).
 *   tkit.chooseMove({ title, text?, options: [{ id, label }], confirm? })   Promise of the chosen id or null: a small <t-modal> with a select
 *                                    ("Move to"), for moving records before the thing that holds them is deleted. null at once if options is empty.
 *   <t-list-editor>.beforeRemove = async fn(item, inUse) -> boolean   runs when a row's delete is pressed, in place of the built-in "N records use
 *                                    this" question (so a page can run chooseMove and move records); true removes the row, false keeps it.
 *   <t-action-bar>                   a screen's main actions: a right-aligned row; under 640px it sticks to the bottom of .t-app-main above the nav
 *                                    (safe-area padding). Children with slot="summary" (a total, say) sit on the left and take the free room.
 *   <t-fields-editor hide-required>  hides the "required" switch of every row.
 *   tkit.menuIndex(items, current, key) / tkit.menuPosition(anchor, size, bound, gap)   the pure parts of <t-menu> (keyboard, placement).
 *   Icons: chevron-up arrow-up arrow-down more move (star was there).
 *   CSS: .t-back (a compact ghost button with the arrow-left icon for an in-app sub-screen's "Back": a catalog item page, a checklist run, an
 *   article; never full width), .t-cell (+ .empty .saving .error, the in-place cell button), .t-filters (a filter row); under 640px every
 *   .t-input / select.t-input in .t-toolbar, .t-filters, .t-table-tools or a *-tools row takes the full width.
 */
(function () {
  'use strict';
  if (window.tkit) return;

  // ---- Language ------------------------------------------------------------
  var STRINGS = {
    en: { filter: 'Filter', noResults: 'Nothing matches', of: 'of', close: 'Close', cancel: 'Cancel', ok: 'OK', today: 'Today', prev: 'Previous month', next: 'Next month', empty: 'Nothing here yet', loading: 'Loading…', error: 'Something went wrong', add: 'Add', more: 'more', moved: 'Moved to', items: 'items',
    yes: 'Yes', no: 'No', required: 'Required', notNumber: 'Not a number', badEmail: 'Not a valid e-mail',
    badUrl: 'Must start with http:// or https://', badDate: 'Not a valid date', delete: 'Delete', change: 'Change', back: 'Back',
    continue: 'Continue', create: 'create', progress: 'Progress', row: 'Row', created: 'Created', updated: 'Updated', prevItem: 'Previous',
    nextItem: 'Next', choose: 'Choose…', removedOption: '(removed option)', chooseImage: 'Choose image', choosePdf: 'Choose PDF',
    changeFile: 'Change', remove: 'Remove', noFile: 'No file', fileTooBig: 'That file is over 20 MB', addItem: 'Add', itemName: 'Name',
    moveUp: 'Move up', moveDown: 'Move down', reorder: 'Drag to reorder', color: 'Colour', movedTo: 'Moved to position {n} of {m}',
    usedOne: 'Used by {n} record', usedMany: 'Used by {n} records',
    inUseOne: '{n} record uses this. It keeps the value, but it will no longer appear in the list. Delete anyway?',
    inUseMany: '{n} records use this. They keep the value, but it will no longer appear in the list. Delete anyway?',
    fieldInUseOne: '{n} record has a value in this field. It keeps the value, but the field will stop showing. Delete the field anyway?',
    fieldInUseMany: '{n} records have a value in this field. They keep the value, but the field will stop showing. Delete the field anyway?',
    typeChangeOne: '{n} record has a value in this field. It stays saved, but may not look right in the new type. Change anyway?',
    typeChangeMany: '{n} records have a value in this field. They stay saved, but may not look right in the new type. Change anyway?',
    tone_none: 'Neutral', tone_accent: 'Accent', tone_ok: 'Green', tone_warn: 'Amber', tone_danger: 'Red', tone_info: 'Blue',
    tone_violet: 'Violet', addField: 'Add field', addOption: 'Add option', fieldName: 'Field name', fieldType: 'Type',
    requiredToggle: 'Required', options: 'Options', currency: 'Currency', currencyDefault: 'App default', details: 'Details',
    formula: 'Formula', formulaFields: 'Fields you can use:', formulaFunctions: 'Functions:', type_text: 'Text', type_longtext: 'Long text',
    type_number: 'Number', type_money: 'Money', type_date: 'Date', type_datetime: 'Date and time', type_choice: 'Choice',
    type_multi: 'Multiple choice', type_checkbox: 'Yes / No', type_image: 'Image', type_file: 'PDF', type_url: 'Link', type_email: 'E-mail',
    type_phone: 'Phone', type_formula: 'Formula', fUnknownField: 'Unknown field: {x}', fUnknownFunction: 'Unknown function: {x}',
    fUnbalanced: 'A parenthesis is not closed', fUnexpectedClose: 'Unexpected )', fUnexpectedEnd: 'The formula ends too soon',
    fUnexpected: 'Unexpected {x}', fBadChar: 'Unexpected character: {x}', fUnterminated: 'A text is missing its closing quote',
    fArgs: 'Wrong number of values for {x}', fTooLong: 'The formula is too long', fTooDeep: 'The formula is too complex',
    fEmpty: 'The formula is empty', fCircular: 'Circular formula', importTitle: 'Import CSV', stepFile: 'File', stepColumns: 'Columns',
    stepReview: 'Review', stepOf: 'Step {n} of {m}', chooseCsv: 'Choose a .csv file', dropHere: 'Drop the file here, or',
    importAs: 'Import as', ignore: 'Ignore', rowsOne: '{n} row', rowsMany: '{n} rows', previewRows: 'first {n} shown',
    mapRequired: 'Match the required field: {x}', csvEmpty: 'This file has no rows', csvReadError: 'Could not read the file',
    rowsReadyOne: '{n} row ready', rowsReadyMany: '{n} rows ready', rowsProblems: '{n} with problems', andMore: 'and {n} more',
    importN: 'Import {n}', samplesOne: 'You are seeing {n} example.', samplesMany: 'You are seeing {n} examples.',
    clearSamples: 'Delete examples', createWiki: 'Create article "{x}"', doneBy: 'by {by} at {at}', doneAt: 'at {at}',
    badTime: 'Not a valid time', type_time: 'Time', newOption: 'New option…', newOptionName: 'Name of the new option',
    copied: 'Copied', weekendMore: '+ weekend', nounOne: 'record', nounMany: 'records',
    dataTitle: 'Data', dataTextBoth: 'Export {x} to a spreadsheet, or import them from a CSV file.', dataTextExport: 'Export {x} to a spreadsheet.',
    exportCsv: 'Export CSV', importCsv: 'Import CSV', exported: 'Exported: {x}', imported: 'Imported: {x}', importing: 'Importing… {n} of {m}',
    importFailed: 'Could not save {n}', examplesTitle: 'Examples', examplesText: 'Fill the app with sample data to see how it works. You can delete it any time.',
    seeExamples: 'See with examples', dangerTitle: 'Danger zone', dangerText: 'Delete all the data in this app at once. This cannot be undone.',
    deleteAll: 'Delete all records', deleteAllOne: 'Delete {n} {x}? This cannot be undone.', deleteAllMany: 'Delete all {n} {x}? This cannot be undone.',
    actions: 'Actions', saving: 'Saving…', rangeBetween: 'Between {min} and {max}', rangeMin: 'At least {min}', rangeMax: 'At most {max}',
    notAnOption: 'Not one of the options', scoreOf: '{n} of {m}', clearValue: 'Clear', moveTo: 'Move to' },
    pt: { filter: 'Filtrar', noResults: 'Nada encontrado', of: 'de', close: 'Fechar', cancel: 'Cancelar', ok: 'OK', today: 'Hoje', prev: 'Mês anterior', next: 'Mês seguinte', empty: 'Nada por aqui ainda', loading: 'Carregando…', error: 'Algo deu errado', add: 'Adicionar', more: 'mais', moved: 'Movido para', items: 'itens',
    yes: 'Sim', no: 'Não', required: 'Obrigatório', notNumber: 'Não é um número', badEmail: 'E-mail inválido',
    badUrl: 'Deve começar com http:// ou https://', badDate: 'Data inválida', delete: 'Apagar', change: 'Mudar', back: 'Voltar',
    continue: 'Continuar', create: 'criar', progress: 'Progresso', row: 'Linha', created: 'Criado', updated: 'Atualizado',
    prevItem: 'Anterior', nextItem: 'Próximo', choose: 'Escolher…', removedOption: '(opção removida)', chooseImage: 'Escolher imagem',
    choosePdf: 'Escolher PDF', changeFile: 'Trocar', remove: 'Remover', noFile: 'Nenhum arquivo', fileTooBig: 'Esse arquivo passa de 20 MB',
    addItem: 'Adicionar', itemName: 'Nome', moveUp: 'Subir', moveDown: 'Descer', reorder: 'Arraste para reordenar', color: 'Cor',
    movedTo: 'Movido para a posição {n} de {m}', usedOne: 'Usado em {n} registro', usedMany: 'Usado em {n} registros',
    inUseOne: '{n} registro usa isto. Ele mantém o valor, mas ele deixa de aparecer na lista. Apagar mesmo assim?',
    inUseMany: '{n} registros usam isto. Eles mantêm o valor, mas ele deixa de aparecer na lista. Apagar mesmo assim?',
    fieldInUseOne: '{n} registro tem valor neste campo. Ele mantém o valor, mas o campo deixa de aparecer. Apagar o campo mesmo assim?',
    fieldInUseMany: '{n} registros têm valor neste campo. Eles mantêm o valor, mas o campo deixa de aparecer. Apagar o campo mesmo assim?',
    typeChangeOne: '{n} registro tem valor neste campo. Ele continua salvo, mas pode não aparecer direito no novo tipo. Mudar mesmo assim?',
    typeChangeMany: '{n} registros têm valor neste campo. Eles continuam salvos, mas podem não aparecer direito no novo tipo. Mudar mesmo assim?',
    tone_none: 'Neutra', tone_accent: 'Destaque', tone_ok: 'Verde', tone_warn: 'Âmbar', tone_danger: 'Vermelha', tone_info: 'Azul',
    tone_violet: 'Violeta', addField: 'Adicionar campo', addOption: 'Adicionar opção', fieldName: 'Nome do campo', fieldType: 'Tipo',
    requiredToggle: 'Obrigatório', options: 'Opções', currency: 'Moeda', currencyDefault: 'Padrão do app', details: 'Detalhes',
    formula: 'Fórmula', formulaFields: 'Campos que você pode usar:', formulaFunctions: 'Funções:', type_text: 'Texto',
    type_longtext: 'Texto longo', type_number: 'Número', type_money: 'Dinheiro', type_date: 'Data', type_datetime: 'Data e hora',
    type_choice: 'Escolha', type_multi: 'Várias escolhas', type_checkbox: 'Sim / Não', type_image: 'Imagem', type_file: 'PDF',
    type_url: 'Link', type_email: 'E-mail', type_phone: 'Telefone', type_formula: 'Fórmula', fUnknownField: 'Campo desconhecido: {x}',
    fUnknownFunction: 'Função desconhecida: {x}', fUnbalanced: 'Falta fechar um parêntese', fUnexpectedClose: ') inesperado',
    fUnexpectedEnd: 'A fórmula termina cedo demais', fUnexpected: 'Inesperado: {x}', fBadChar: 'Caractere inesperado: {x}',
    fUnterminated: 'Falta fechar as aspas de um texto', fArgs: 'Quantidade de valores errada em {x}', fTooLong: 'A fórmula é longa demais',
    fTooDeep: 'A fórmula é complexa demais', fEmpty: 'A fórmula está vazia', fCircular: 'Fórmula circular', importTitle: 'Importar CSV',
    stepFile: 'Arquivo', stepColumns: 'Colunas', stepReview: 'Revisar', stepOf: 'Passo {n} de {m}', chooseCsv: 'Escolher arquivo .csv',
    dropHere: 'Solte o arquivo aqui, ou', importAs: 'Importar como', ignore: 'Ignorar', rowsOne: '{n} linha', rowsMany: '{n} linhas',
    previewRows: 'primeiras {n} mostradas', mapRequired: 'Associe o campo obrigatório: {x}', csvEmpty: 'Esse arquivo não tem linhas',
    csvReadError: 'Não consegui ler o arquivo', rowsReadyOne: '{n} linha pronta', rowsReadyMany: '{n} linhas prontas',
    rowsProblems: '{n} com problemas', andMore: 'e mais {n}', importN: 'Importar {n}', samplesOne: 'Você está vendo {n} exemplo.',
    samplesMany: 'Você está vendo {n} exemplos.', clearSamples: 'Apagar exemplos', createWiki: 'Criar artigo "{x}"',
    doneBy: 'por {by} às {at}', doneAt: 'às {at}',
    badTime: 'Hora inválida', type_time: 'Hora', newOption: 'Nova opção…', newOptionName: 'Nome da nova opção',
    copied: 'Copiado', weekendMore: '+ fim de semana', nounOne: 'registro', nounMany: 'registros',
    dataTitle: 'Dados', dataTextBoth: 'Exporte {x} para uma planilha ou importe de um arquivo CSV.', dataTextExport: 'Exporte {x} para uma planilha.',
    exportCsv: 'Exportar CSV', importCsv: 'Importar CSV', exported: 'Exportado: {x}', imported: 'Importado: {x}', importing: 'Importando… {n} de {m}',
    importFailed: 'Não consegui salvar {n}', examplesTitle: 'Exemplos', examplesText: 'Preencha o app com dados de exemplo para ver como funciona. Você pode apagá-los quando quiser.',
    seeExamples: 'Ver com exemplos', dangerTitle: 'Zona de perigo', dangerText: 'Apaga de uma vez todos os dados deste app. Isso não pode ser desfeito.',
    deleteAll: 'Apagar todos os registros', deleteAllOne: 'Apagar {n} {x}? Isso não pode ser desfeito.', deleteAllMany: 'Apagar {n} {x}? Isso não pode ser desfeito.',
    actions: 'Ações', saving: 'Salvando…', rangeBetween: 'Entre {min} e {max}', rangeMin: 'No mínimo {min}', rangeMax: 'No máximo {max}',
    notAnOption: 'Não é uma das opções', scoreOf: '{n} de {m}', clearValue: 'Limpar', moveTo: 'Mover para' }
  };
  function language() {
    var lang = '';
    try { lang = document.documentElement.lang || navigator.language || ''; } catch (_) { /* no document */ }
    return lang.toLowerCase().indexOf('pt') === 0 ? 'pt' : 'en';
  }
  function locale() {
    try { return document.documentElement.lang || navigator.language || 'en'; } catch (_) { return 'en'; }
  }
  function t(key) { var table = STRINGS[language()] || STRINGS.en; return table[key] || STRINGS.en[key] || key; }

  // ---- Pure helpers -----------------------------------------------------------
  function text(value) { return value === undefined || value === null ? '' : String(value); }
  function normalize(value) {
    var plain = text(value).toLowerCase();
    try { plain = plain.normalize('NFD').replace(/[̀-ͯ]/g, ''); } catch (_) { /* old engine */ }
    return plain;
  }
  /** Rows whose `keys` (every own field when keys is empty) contain every word of `query`. */
  function filterRows(rows, query, keys) {
    var words = normalize(query).split(/\s+/).filter(Boolean);
    if (!words.length) return rows.slice();
    return rows.filter(function (row) {
      var fields = keys && keys.length ? keys : Object.keys(row);
      var haystack = normalize(fields.map(function (key) { var v = row[key]; return v && typeof v === 'object' ? JSON.stringify(v) : text(v); }).join(' '));
      return words.every(function (word) { return haystack.indexOf(word) >= 0; });
    });
  }
  function compare(a, b) {
    var na = typeof a === 'number' || (a !== '' && a !== null && a !== undefined && !isNaN(a) && typeof a !== 'boolean');
    var nb = typeof b === 'number' || (b !== '' && b !== null && b !== undefined && !isNaN(b) && typeof b !== 'boolean');
    if (a === null || a === undefined || a === '') return b === null || b === undefined || b === '' ? 0 : 1;
    if (b === null || b === undefined || b === '') return -1;
    if (na && nb) return Number(a) - Number(b);
    return normalize(a).localeCompare(normalize(b));
  }
  /** A sorted copy; dir is 'asc' or 'desc'; empty values go last either way. */
  function sortRows(rows, key, dir) {
    var sign = dir === 'desc' ? -1 : 1;
    return rows.slice().sort(function (x, y) {
      var c = compare(x[key], y[key]);
      var emptyX = x[key] === null || x[key] === undefined || x[key] === '', emptyY = y[key] === null || y[key] === undefined || y[key] === '';
      return emptyX || emptyY ? c : c * sign;
    });
  }
  function groupBy(list, key) {
    var groups = {};
    list.forEach(function (item) {
      var k = text(typeof key === 'function' ? key(item) : item[key]);
      (groups[k] = groups[k] || []).push(item);
    });
    return groups;
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function isoDate(date) { return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()); }
  function today() { return isoDate(new Date()); }
  /** The 6 weeks shown for a month (1–12): [{ date: 'YYYY-MM-DD', day, other, today }], weekStart 0 = Sunday. */
  function monthGrid(year, month, weekStart) {
    weekStart = weekStart || 0;
    var first = new Date(year, month - 1, 1);
    var offset = (first.getDay() - weekStart + 7) % 7;
    var start = new Date(year, month - 1, 1 - offset);
    var now = today(), cells = [];
    for (var i = 0; i < 42; i++) {
      var day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      var iso = isoDate(day);
      cells.push({ date: iso, day: day.getDate(), other: day.getMonth() !== month - 1, today: iso === now, weekday: day.getDay() });
    }
    return cells;
  }
  function parseDate(value) {
    if (value instanceof Date) return value;
    var s = text(value);
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) { var p = s.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
    var d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }
  function date(value, style) {
    var d = parseDate(value);
    if (!d) return '';
    var options = style === 'long' ? { dateStyle: 'long' } : style === 'time' ? { dateStyle: 'short', timeStyle: 'short' } : { dateStyle: 'medium' };
    try { return new Intl.DateTimeFormat(locale(), options).format(d); } catch (_) { return d.toLocaleDateString(); }
  }
  function ago(value) {
    var d = parseDate(value);
    if (!d) return '';
    var seconds = Math.round((d.getTime() - Date.now()) / 1000), abs = Math.abs(seconds);
    var unit = abs < 60 ? 'second' : abs < 3600 ? 'minute' : abs < 86400 ? 'hour' : abs < 86400 * 30 ? 'day' : abs < 86400 * 365 ? 'month' : 'year';
    var size = { second: 1, minute: 60, hour: 3600, day: 86400, month: 86400 * 30, year: 86400 * 365 }[unit];
    try { return new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' }).format(Math.round(seconds / size), unit); } catch (_) { return date(d); }
  }
  function money(value, currency) {
    var n = Number(value) || 0;
    try { return new Intl.NumberFormat(locale(), { style: 'currency', currency: currency || (language() === 'pt' ? 'BRL' : 'USD') }).format(n); } catch (_) { return n.toFixed(2); }
  }
  function number(value, digits) {
    var n = Number(value) || 0;
    try { return new Intl.NumberFormat(locale(), { maximumFractionDigits: digits === undefined ? 2 : digits }).format(n); } catch (_) { return String(n); }
  }
  function uid() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); }

  // ==== v2: pure helpers (no DOM; kit-v2.test.mjs runs them in Node) ================

  /** t() with {name} placeholders filled in. */
  function tf(key, vars) {
    var out = t(key);
    if (vars) Object.keys(vars).forEach(function (name) { out = out.split('{' + name + '}').join(text(vars[name])); });
    return out;
  }
  /** "1 record" / "3 records": two keys, {n} filled in. */
  function plural(n, one, many) { return tf(n === 1 ? one : many, { n: n }); }
  function isPlain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.prototype.toString.call(value) !== '[object Date]'; }
  function isDateObject(value) { return Object.prototype.toString.call(value) === '[object Date]'; }
  function clone(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }
  function basename(path) { return text(path).split('/').pop(); }

  // ---- Routing: "#view" or "#view/id" ------------------------------------------------
  function decodePart(part) { try { return decodeURIComponent(part); } catch (_) { return part; } }
  /** '#board/a%20b' -> { view: 'board', id: 'a b' }; '' -> { view: '', id: null }; '#x/' -> { view: 'x', id: null }. */
  function parseRoute(hash) {
    var s = text(hash).replace(/^#/, '');
    var at = s.indexOf('/');
    var id = at < 0 ? '' : s.slice(at + 1);
    return { view: decodePart(at < 0 ? s : s.slice(0, at)), id: id ? decodePart(id) : null };
  }

  // ---- Context for the agent -----------------------------------------------------------
  /** The next { selection, summary }: a key in `patch` replaces it, null clears it, a key left out stays. */
  function mergeContext(current, patch) {
    var out = { selection: current && current.selection !== undefined ? current.selection : null, summary: current && current.summary !== undefined ? current.summary : null };
    patch = patch || {};
    ['selection', 'summary'].forEach(function (key) {
      if (patch[key] === undefined) return;
      out[key] = patch[key] === null ? null : text(patch[key]);
    });
    return out;
  }

  // ---- Settings ---------------------------------------------------------------------------
  function mergeValue(defaults, stored) {
    if (stored === undefined) return clone(defaults);
    if (isPlain(defaults) && isPlain(stored)) {
      var out = {};
      Object.keys(defaults).forEach(function (key) { if (key !== '__proto__') out[key] = mergeValue(defaults[key], stored[key]); });
      Object.keys(stored).forEach(function (key) { if (key !== '__proto__' && !Object.prototype.hasOwnProperty.call(out, key)) out[key] = clone(stored[key]); });
      return out;
    }
    return clone(stored); // arrays and scalars from storage win whole
  }
  /** Defaults with the stored value laid over them, deeply; always has `v`. A copy: neither input is touched. */
  function mergeSettings(defaults, stored) {
    var out = mergeValue(isPlain(defaults) ? defaults : {}, isPlain(stored) ? stored : undefined);
    if (out.v === undefined || out.v === null) out.v = 1;
    return out;
  }

  // ---- Numbers and dates as people type them ------------------------------------------------
  /** "1.234,5" (pt) / "1,234.5" (en) / "1234.5" / "R$ 12,50" -> number, or null when it is not one. */
  function parseNumber(raw, lang) {
    if (typeof raw === 'number') return isFinite(raw) ? raw : null;
    lang = lang || language();
    var s = text(raw).replace(/\s/g, '').replace(/[\u2212\u2013]/g, '-').replace(/[^\d.,+-]/g, '');
    var sign = '';
    if (s.charAt(0) === '-' || s.charAt(0) === '+') { sign = s.charAt(0) === '-' ? '-' : ''; s = s.slice(1); }
    if (!/^(\d[\d.,]*|[.,]\d+)$/.test(s)) return null;
    var dot = s.lastIndexOf('.'), comma = s.lastIndexOf(',');
    var decimal = ''; // the decimal separator, when there is one
    if (dot >= 0 && comma >= 0) decimal = dot > comma ? '.' : ',';
    else if (dot >= 0 || comma >= 0) {
      var sep = dot >= 0 ? '.' : ',';
      var parts = s.split(sep);
      if (parts.length > 2) {
        // 1.234.567: only a separator used as grouping can repeat; the groups must be of three
        if (!parts.slice(1).every(function (p) { return p.length === 3; }) || parts[0].length > 3 || !parts[0]) return null;
      } else if (parts[1].length === 3 && parts[0].length >= 1 && parts[0].length <= 3 && parts[0] !== '0') {
        // 1.234 is a thousand in Portuguese and 1.234 in English: the page's language decides
        decimal = sep === (lang === 'pt' ? ',' : '.') ? sep : '';
      } else decimal = sep;
    }
    var out;
    if (decimal) {
      var cut = s.lastIndexOf(decimal);
      var whole = s.slice(0, cut).replace(/[.,]/g, ''), frac = s.slice(cut + 1);
      if (/[.,]/.test(frac)) return null;
      out = (whole || '0') + '.' + frac;
    } else out = s.replace(/[.,]/g, '');
    var n = Number(sign + out);
    return isFinite(n) ? n : null;
  }
  function validYmd(y, m, d) {
    var probe = new Date(y, m - 1, d);
    if (probe.getFullYear() !== y || probe.getMonth() !== m - 1 || probe.getDate() !== d) return null;
    return y + '-' + pad(m) + '-' + pad(d);
  }
  /** 'YYYY-MM-DD', a Date, an ISO date-time or 'dd/mm/yyyy' (pt) / 'mm/dd/yyyy' (en) -> 'YYYY-MM-DD', or null. */
  function normalizeDate(raw) {
    if (isDateObject(raw)) return isNaN(raw.getTime()) ? null : isoDate(raw);
    var s = text(raw).trim(), m;
    if ((m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/.exec(s))) return validYmd(+m[1], +m[2], +m[3]);
    if ((m = /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/.exec(s))) {
      var a = +m[1], b = +m[2], dayFirst = language() === 'pt' || a > 12;
      return dayFirst ? validYmd(+m[3], b, a) : validYmd(+m[3], a, b);
    }
    return null;
  }
  function isoWithOffset(d) {
    var minutes = -d.getTimezoneOffset(), sign = minutes < 0 ? '-' : '+', abs = Math.abs(minutes);
    return isoDate(d) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + sign + pad(Math.floor(abs / 60)) + ':' + pad(abs % 60);
  }
  /** A Date, 'YYYY-MM-DDTHH:mm' (what <input type=datetime-local> gives: local time) or an ISO string with an offset
   *  -> ISO 8601 with offset (one with an offset is kept as written), or null. */
  function normalizeDateTime(raw) {
    if (isDateObject(raw)) return isNaN(raw.getTime()) ? null : isoWithOffset(raw);
    var s = text(raw).trim(), m;
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(s)) return isNaN(new Date(s).getTime()) ? null : s;
    if ((m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(s))) {
      if (!validYmd(+m[1], +m[2], +m[3]) || +m[4] > 23 || +m[5] > 59 || +m[6] > 59) return null;
      return isoWithOffset(new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)));
    }
    return null;
  }
  /** "9h30", "9:30", "0930", "930", "9h", "9", "09:30:15", "9:30pm" -> "HH:MM" (24 hours), or null when it is not a time. */
  function normalizeTime(raw) {
    var s = normalize(raw).replace(/\s+/g, ''), m, hour, minute, meridiem = '';
    if (!s) return null;
    if ((m = /(am|pm)$/.exec(s))) { meridiem = m[1]; s = s.slice(0, -2); }
    if ((m = /^(\d{1,2})(?:[:h.](\d{2})?(?::\d{2}(?:\.\d+)?)?)?$/.exec(s))) { hour = +m[1]; minute = m[2] ? +m[2] : 0; }
    else if ((m = /^(\d{2})(\d{2})$/.exec(s)) || (m = /^(\d)(\d{2})$/.exec(s))) { hour = +m[1]; minute = +m[2]; }
    else return null;
    if (meridiem) {
      if (hour < 1 || hour > 12) return null;
      if (meridiem === 'pm' && hour < 12) hour += 12;
      if (meridiem === 'am' && hour === 12) hour = 0;
    }
    return hour > 23 || minute > 59 ? null : pad(hour) + ':' + pad(minute);
  }
  /** "HH:MM" as the page's language writes it (9:30 AM, 09:30). */
  function timeText(value) {
    var hhmm = normalizeTime(value);
    if (hhmm === null) return text(value);
    if (language() === 'pt') return hhmm; // Brazil writes 09:30
    var parts = hhmm.split(':');
    try { return new Intl.DateTimeFormat(locale(), { hour: 'numeric', minute: '2-digit' }).format(new Date(2000, 0, 1, +parts[0], +parts[1])); } catch (_) { return hhmm; }
  }
  /** YYYY-MM-DD, n days from today (n may be negative): for relative example dates. */
  function daysFromToday(n) {
    var now = new Date();
    return isoDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() + (Number(n) || 0)));
  }

  // ---- Fields: the schema forms, details and imports share ------------------------------------
  var FIELD_TYPES = ['text', 'longtext', 'number', 'money', 'date', 'datetime', 'time', 'choice', 'multi', 'checkbox', 'image', 'file', 'url', 'email', 'phone', 'formula'];
  var TONES = ['', 'accent', 'ok', 'warn', 'danger', 'info', 'violet'];
  var RESERVED = ['true', 'false', 'and', 'or', 'not'];
  /** A [a-z0-9_] id from a label ("Valor total" -> valor_total), made unique against `taken` (-> valor_total_2). */
  function slug(label, taken) {
    var base = normalize(label).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40).replace(/_+$/, '');
    if (!base) base = 'field';
    if (/^[0-9]/.test(base)) base = ('f_' + base).slice(0, 40); // an id doubles as a formula name, which cannot start with a digit
    var id = base, n = 2;
    taken = taken || [];
    while (taken.indexOf(id) >= 0 || RESERVED.indexOf(id) >= 0) { var suffix = '_' + n++; id = base.slice(0, 40 - suffix.length) + suffix; }
    return id;
  }
  function emptyRaw(raw) { return raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === ''); }
  function emptyValue(value) { return emptyRaw(value) || (Array.isArray(value) && !value.length); }
  function truthy(raw) {
    if (typeof raw === 'boolean') return raw;
    if (typeof raw === 'number') return raw !== 0;
    return ['true', '1', 'sim', 's', 'yes', 'y', 'x', 'on', 'verdadeiro'].indexOf(normalize(raw).trim()) >= 0;
  }
  function findOption(field, raw) {
    var s = text(raw).trim(), options = field.options || [];
    for (var i = 0; i < options.length; i++) if (text(options[i].id) === s) return options[i];
    for (var j = 0; j < options.length; j++) if (normalize(options[j].label) === normalize(s)) return options[j];
    return null;
  }
  /** What to store for what the person typed or picked. Whatever cannot be understood (a number that is not
   *  one) is kept as the text, so validate() can say so; empty is null. */
  function fieldValue(field, raw) {
    var type = field.type;
    if (type === 'formula') return null;
    if (type === 'checkbox') return truthy(raw);
    if (type === 'multi') {
      var joined = text(raw);
      var list = Array.isArray(raw) ? raw : emptyRaw(raw) ? [] : joined.split(/[;|]/.test(joined) ? /\s*[;|]\s*/ : /\s*,\s*/);
      var ids = [];
      list.forEach(function (item) {
        if (emptyRaw(item)) return;
        var option = findOption(field, item), id = option ? option.id : text(item).trim();
        if (ids.indexOf(id) < 0) ids.push(id);
      });
      return ids.length ? ids : null;
    }
    if (emptyRaw(raw)) return null;
    var s;
    switch (type) {
      case 'number': case 'money': { var n = parseNumber(raw); return n === null ? text(raw).trim() : n; }
      case 'date': { var d = normalizeDate(raw); return d === null ? text(raw).trim() : d; }
      case 'datetime': { var dt = normalizeDateTime(raw); return dt === null ? text(raw).trim() : dt; }
      case 'time': { var tm = normalizeTime(raw); return tm === null ? text(raw).trim() : tm; }
      case 'choice': { var option = findOption(field, raw); return option ? option.id : text(raw).trim(); }
      case 'image': case 'file':
        if (isPlain(raw) && raw.path !== undefined) return { path: text(raw.path), name: text(raw.name || basename(raw.path)), type: text(raw.type) };
        s = text(raw).trim();
        return s ? { path: s, name: basename(s), type: '' } : null;
      case 'longtext': return text(raw).replace(/^\s+|\s+$/g, '');
      default: return text(raw).trim();
    }
  }
  /** What to show for a stored value (a formula's result included; an empty formula shows an em dash). */
  function fieldText(field, value, settings) {
    settings = settings || {};
    var type = field.type;
    if (type === 'checkbox') return value === undefined || value === null ? '' : value ? t('yes') : t('no');
    if (emptyValue(value)) return type === 'formula' ? '—' : '';
    switch (type) {
      case 'number': return number(value, 6);
      case 'money': return money(value, field.currency || settings.currency);
      case 'date': return date(value);
      case 'datetime': return date(value, 'time');
      case 'time': return timeText(value);
      case 'choice': { var option = findOption(field, value); return option ? text(option.label) : text(value); }
      case 'multi': return (Array.isArray(value) ? value : [value]).map(function (id) { var o = findOption(field, id); return o ? text(o.label) : text(id); }).join(', ');
      case 'image': case 'file': return isPlain(value) ? text(value.name || basename(value.path)) : basename(value);
      case 'formula':
        if (typeof value === 'number') return field.currency ? money(value, field.currency) : number(value, 2);
        if (typeof value === 'boolean') return value ? t('yes') : t('no');
        return text(value);
      default: return text(value);
    }
  }
  /** { ok, errors: { fieldId: message } }: required, numbers, e-mails, links and dates. Formula fields are never checked. */
  function validate(fields, data) {
    var errors = {};
    data = data || {};
    (fields || []).forEach(function (field) {
      if (field.type === 'formula') return;
      var value = data[field.id];
      if (field.type === 'checkbox') { if (field.required && value !== true) errors[field.id] = t('required'); return; }
      if (emptyValue(value)) { if (field.required) errors[field.id] = t('required'); return; }
      var message = '';
      if ((field.type === 'number' || field.type === 'money') && (typeof value !== 'number' || !isFinite(value))) message = t('notNumber');
      else if (field.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(text(value))) message = t('badEmail');
      else if (field.type === 'url' && !/^https?:\/\/\S+$/i.test(text(value))) message = t('badUrl');
      else if (field.type === 'date' && normalizeDate(value) !== text(value)) message = t('badDate'); // also catches 2026-02-31
      else if (field.type === 'datetime' && normalizeDateTime(value) === null) message = t('badDate');
      else if (field.type === 'time' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(text(value))) message = t('badTime');
      if (message) errors[field.id] = message;
    });
    return { ok: Object.keys(errors).length === 0, errors: errors };
  }

  // ---- Formulas: tkit.formula ---------------------------------------------------------------------
  // A hand-written tokenizer and recursive-descent parser build a small tree that is compiled to
  // closures. No eval, no Function: a formula can only do what this table lets it do.
  var FORMULA_MAX_LENGTH = 1000, FORMULA_MAX_DEPTH = 100;
  function formulaError(key, vars, at) { return { formulaError: true, message: tf(key, vars), at: at || 0 }; }
  function tokenize(src) {
    var tokens = [], i = 0, n = src.length, m;
    while (i < n) {
      var c = src.charAt(i);
      if (/\s/.test(c)) { i++; continue; }
      if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src.charAt(i + 1)))) {
        m = /^(?:\d+(?:\.\d+)?|\.\d+)/.exec(src.slice(i));
        tokens.push({ k: 'num', v: Number(m[0]), at: i }); i += m[0].length; continue;
      }
      if (c === '"') {
        var value = '', j = i + 1, closed = false;
        while (j < n) {
          var d = src.charAt(j);
          if (d === '"') { if (src.charAt(j + 1) === '"') { value += '"'; j += 2; continue; } closed = true; j++; break; }
          if (d === '\\' && (src.charAt(j + 1) === '"' || src.charAt(j + 1) === '\\')) { value += src.charAt(j + 1); j += 2; continue; }
          value += d; j++;
        }
        if (!closed) throw formulaError('fUnterminated', null, i);
        tokens.push({ k: 'str', v: value, at: i }); i = j; continue;
      }
      if (/[A-Za-z_]/.test(c)) {
        m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
        var word = m[0].toLowerCase();
        tokens.push({ k: word === 'and' || word === 'or' || word === 'not' ? 'op' : 'id', v: word, at: i }); i += m[0].length; continue;
      }
      var two = src.substr(i, 2);
      if (two === '<>' || two === '<=' || two === '>=' || two === '!=' || two === '==') { tokens.push({ k: 'op', v: two === '!=' ? '<>' : two === '==' ? '=' : two, at: i }); i += 2; continue; }
      if ('+-*/%^&=<>(),'.indexOf(c) >= 0) { tokens.push({ k: 'op', v: c, at: i }); i++; continue; }
      throw formulaError('fBadChar', { x: c }, i);
    }
    tokens.push({ k: 'end', v: '', at: n });
    return tokens;
  }
  function parseFormula(tokens, ids) {
    var pos = 0, depth = 0, deps = [];
    function peek() { return tokens[pos]; }
    function isOp(v) { var tok = tokens[pos]; return tok.k === 'op' && tok.v === v; }
    function take() { return tokens[pos++]; }
    function unexpected(tok) {
      if (tok.k === 'end') return formulaError('fUnexpectedEnd', null, tok.at);
      if (tok.k === 'op' && tok.v === ')') return formulaError('fUnexpectedClose', null, tok.at);
      return formulaError('fUnexpected', { x: tok.k === 'str' ? '"' + tok.v + '"' : tok.k === 'num' ? String(tok.v) : tok.v }, tok.at);
    }
    function binary(next, ops) {
      return function () {
        var left = next();
        while (peek().k === 'op' && ops.indexOf(peek().v) >= 0) { var op = take().v; left = { k: 'bin', op: op, a: left, b: next() }; }
        return left;
      };
    }
    var parseOr, parseUnary;
    function parsePrimary() {
      var tok = take();
      if (tok.k === 'num') return { k: 'lit', v: tok.v };
      if (tok.k === 'str') return { k: 'lit', v: tok.v };
      if (tok.k === 'op' && tok.v === '(') {
        var inner = parseOr();
        if (!isOp(')')) throw peek().k === 'end' ? formulaError('fUnbalanced', null, peek().at) : unexpected(peek());
        take();
        return inner;
      }
      if (tok.k === 'id') {
        if (tok.v === 'true' || tok.v === 'false') return { k: 'lit', v: tok.v === 'true' };
        if (isOp('(')) {
          take();
          var fn = Object.prototype.hasOwnProperty.call(FORMULA_FUNCTIONS, tok.v) ? FORMULA_FUNCTIONS[tok.v] : null;
          if (!fn) throw formulaError('fUnknownFunction', { x: tok.v }, tok.at);
          var args = [];
          if (!isOp(')')) {
            args.push(parseOr());
            while (isOp(',')) { take(); args.push(parseOr()); }
          }
          if (!isOp(')')) throw peek().k === 'end' ? formulaError('fUnbalanced', null, peek().at) : unexpected(peek());
          take();
          if (args.length < fn.min || args.length > fn.max) throw formulaError('fArgs', { x: tok.v }, tok.at);
          return { k: 'call', name: tok.v, fn: fn, args: args };
        }
        if (ids && ids.indexOf(tok.v) < 0) throw formulaError('fUnknownField', { x: tok.v }, tok.at);
        if (deps.indexOf(tok.v) < 0) deps.push(tok.v);
        return { k: 'id', name: tok.v };
      }
      throw unexpected(tok);
    }
    // ^ binds tighter than unary minus (-2^2 is -4) and is right-associative; its exponent may be negative (2^-1).
    function parsePower() {
      var base = parsePrimary();
      if (isOp('^')) { take(); return { k: 'bin', op: '^', a: base, b: parseUnary() }; }
      return base;
    }
    parseUnary = function () {
      if (isOp('-')) { take(); return { k: 'neg', a: parseUnary() }; }
      if (isOp('+')) { take(); return parseUnary(); }
      return parsePower();
    };
    var parseMul = binary(parseUnary, ['*', '/', '%']);
    var parseAdd = binary(parseMul, ['+', '-']);
    var parseConcat = binary(parseAdd, ['&']);
    var parseCompare = binary(parseConcat, ['=', '<>', '<', '<=', '>', '>=']);
    function parseNot() {
      if (isOp('not')) { take(); return { k: 'not', a: parseNot() }; }
      return parseCompare();
    }
    var parseAnd = binary(parseNot, ['and']);
    parseOr = function () {
      if (++depth > FORMULA_MAX_DEPTH) throw formulaError('fTooDeep', null, peek().at);
      var node = binary(parseAnd, ['or'])();
      depth--;
      return node;
    };
    var tree = parseOr();
    if (peek().k !== 'end') throw unexpected(peek());
    return { tree: tree, deps: deps };
  }

  // ---- Values inside a formula: number, text, true/false or null ----
  function fNumber(v) {
    if (typeof v === 'number') return isFinite(v) ? v : null;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v === 'string' && v.trim() !== '') { var n = Number(v); return isFinite(n) ? n : null; }
    return null;
  }
  function fTruthy(v) { return v === null || v === undefined ? false : typeof v === 'number' ? v !== 0 : typeof v === 'string' ? v.length > 0 : !!v; }
  function fText(v) { return v === null || v === undefined ? '' : String(v); }
  function fFinite(n) { return typeof n === 'number' && isFinite(n) ? n : null; }
  function fIncoming(v) {
    if (v === undefined || v === null) return null;
    if (typeof v === 'number') return isFinite(v) ? v : null;
    if (typeof v === 'string' || typeof v === 'boolean') return v;
    if (Array.isArray(v)) return v.join(', ');
    return null; // files and other objects have no value a formula can use
  }
  function fDay(v) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(text(v));
    return m && validYmd(+m[1], +m[2], +m[3]) ? { y: +m[1], m: +m[2], d: +m[3] } : null;
  }
  function fNumbers(args) {
    var out = [];
    args.forEach(function (v) { if (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '' && isFinite(Number(v)))) out.push(Number(v)); });
    return out;
  }
  function fRound(x, digits) {
    var f = Math.pow(10, Math.max(0, Math.min(10, Math.round(digits))));
    var scaled = Number((Math.abs(x) * f).toPrecision(15)); // 1.005 * 100 is 100.49999999999999: look at 15 digits
    return (x < 0 ? -1 : 1) * Math.round(scaled) / f;
  }
  function unary(fn) { return function (a) { var x = fNumber(a[0]); return x === null ? null : fFinite(fn(x)); }; }
  var FORMULA_FUNCTIONS = {
    min: { min: 1, max: Infinity, run: function (a) { var n = fNumbers(a); return n.length ? Math.min.apply(null, n) : null; } },
    max: { min: 1, max: Infinity, run: function (a) { var n = fNumbers(a); return n.length ? Math.max.apply(null, n) : null; } },
    sum: { min: 1, max: Infinity, run: function (a) { return fNumbers(a).reduce(function (s, x) { return s + x; }, 0); } },
    avg: { min: 1, max: Infinity, run: function (a) { var n = fNumbers(a); return n.length ? n.reduce(function (s, x) { return s + x; }, 0) / n.length : null; } },
    round: { min: 1, max: 2, run: function (a) { var x = fNumber(a[0]), d = a.length > 1 ? fNumber(a[1]) : 0; return x === null || d === null ? null : fRound(x, d); } },
    floor: { min: 1, max: 1, run: unary(Math.floor) },
    ceil: { min: 1, max: 1, run: unary(Math.ceil) },
    abs: { min: 1, max: 1, run: unary(Math.abs) },
    sqrt: { min: 1, max: 1, run: unary(Math.sqrt) },
    days: { min: 2, max: 2, run: function (a) {
      var from = fDay(a[0]), to = fDay(a[1]);
      return from && to ? Math.round((Date.UTC(to.y, to.m - 1, to.d) - Date.UTC(from.y, from.m - 1, from.d)) / 86400000) : null;
    } },
    today: { min: 0, max: 0, run: function (a, env) { return env.today; } },
    year: { min: 1, max: 1, run: function (a) { var d = fDay(a[0]); return d ? d.y : null; } },
    month: { min: 1, max: 1, run: function (a) { var d = fDay(a[0]); return d ? d.m : null; } },
    len: { min: 1, max: 1, run: function (a) { return fText(a[0]).length; } },
    upper: { min: 1, max: 1, run: function (a) { return a[0] === null ? null : fText(a[0]).toUpperCase(); } },
    lower: { min: 1, max: 1, run: function (a) { return a[0] === null ? null : fText(a[0]).toLowerCase(); } },
    concat: { min: 1, max: Infinity, run: function (a) { return a.map(fText).join(''); } },
    pct: { min: 2, max: 2, run: function (a) { var p = fNumber(a[0]), w = fNumber(a[1]); return p === null || w === null || w === 0 ? null : fFinite(p / w * 100); } },
    coalesce: { min: 1, max: Infinity, run: function (a) { for (var i = 0; i < a.length; i++) if (a[i] !== null && a[i] !== '') return a[i]; return null; } },
    'if': { min: 2, max: 3, lazy: true }
  };
  function fEquals(a, b) { return a === b; } // an empty value equals only another empty value
  function fCompare(op, a, b) {
    if (op === '=') return fEquals(a, b);
    if (op === '<>') return !fEquals(a, b);
    if (a === null || b === null) return false; // an empty value is neither greater nor smaller
    var x, y;
    if (typeof a === 'string' && typeof b === 'string') { x = a; y = b; } else { x = fNumber(a); y = fNumber(b); if (x === null || y === null) return false; }
    return op === '<' ? x < y : op === '<=' ? x <= y : op === '>' ? x > y : x >= y;
  }
  function fArithmetic(op, a, b) {
    var x = fNumber(a), y = fNumber(b);
    if (x === null || y === null) return null; // an empty input makes the result empty
    switch (op) {
      case '+': return fFinite(x + y);
      case '-': return fFinite(x - y);
      case '*': return fFinite(x * y);
      case '/': return y === 0 ? null : fFinite(x / y);
      case '%': return y === 0 ? null : fFinite(x % y);
      default: return fFinite(Math.pow(x, y));
    }
  }
  function buildFormula(node) {
    switch (node.k) {
      case 'lit': return function () { return node.v; };
      case 'id': return function (env) { return fIncoming(env.values[node.name]); };
      case 'neg': { var inner = buildFormula(node.a); return function (env) { var x = fNumber(inner(env)); return x === null ? null : -x; }; }
      case 'not': { var operand = buildFormula(node.a); return function (env) { return !fTruthy(operand(env)); }; }
      case 'bin': {
        var left = buildFormula(node.a), right = buildFormula(node.b), op = node.op;
        if (op === 'and') return function (env) { return fTruthy(left(env)) && fTruthy(right(env)); };
        if (op === 'or') return function (env) { return fTruthy(left(env)) || fTruthy(right(env)); };
        if (op === '&') return function (env) { return fText(left(env)) + fText(right(env)); };
        if (op === '+' || op === '-' || op === '*' || op === '/' || op === '%' || op === '^') return function (env) { return fArithmetic(op, left(env), right(env)); };
        return function (env) { return fCompare(op, left(env), right(env)); };
      }
      default: { // call
        var args = node.args.map(buildFormula), fn = node.fn;
        if (fn.lazy) return function (env) { return fTruthy(args[0](env)) ? args[1](env) : args.length > 2 ? args[2](env) : null; };
        return function (env) { return fn.run(args.map(function (arg) { return arg(env); }), env); };
      }
    }
  }
  /** { ok: true, deps, run(values, { today }) } or { ok: false, error, at }. `ids` are the field ids a formula may name
   *  (leave it out to allow any name). */
  function compileFormula(source, ids) {
    var src = text(source);
    try {
      if (!src.trim()) throw formulaError('fEmpty', null, 0);
      if (src.length > FORMULA_MAX_LENGTH) throw formulaError('fTooLong', null, FORMULA_MAX_LENGTH);
      var parsed = parseFormula(tokenize(src), ids ? ids.map(function (id) { return text(id).toLowerCase(); }) : null);
      var run = buildFormula(parsed.tree);
      return { ok: true, deps: parsed.deps, run: function (values, options) {
        var env = { values: values || {}, today: options && options.today ? options.today : today() };
        var result = run(env);
        return result === undefined || (typeof result === 'number' && !isFinite(result)) ? null : result;
      } };
    } catch (error) {
      if (error && error.formulaError) return { ok: false, error: error.message, at: error.at };
      throw error;
    }
  }
  function evaluateFormula(source, values, options) {
    var compiled = compileFormula(source, Object.keys(values || {}));
    return compiled.ok ? compiled.run(values, options) : null;
  }
  // A table computes the same few formulas for every row: parse each once.
  var formulaCache = {}, formulaCacheSize = 0;
  function compileCached(source, ids) {
    var key = text(source) + '\u0000' + ids.join(',');
    if (Object.prototype.hasOwnProperty.call(formulaCache, key)) return formulaCache[key];
    if (formulaCacheSize >= 200) { formulaCache = {}; formulaCacheSize = 0; }
    formulaCacheSize++;
    return (formulaCache[key] = compileFormula(source, ids));
  }
  /** `data` with every formula field computed. A formula that fails gives null and its message in result._errors
   *  (not enumerable, so saving the result does not store it). Formulas may use each other, not themselves. */
  function compute(fields, data) {
    var out = Object.assign({}, data), errors = {}, compiled = {}, state = {}, circular = {}, stack = [];
    var ids = (fields || []).map(function (f) { return f.id; });
    (fields || []).forEach(function (f) { if (f.type === 'formula') compiled[f.id] = compileCached(f.formula, ids); });
    function visit(id) {
      if (state[id] === 2) return;
      if (state[id] === 1) { for (var i = stack.indexOf(id); i < stack.length; i++) circular[stack[i]] = true; return; }
      state[id] = 1; stack.push(id);
      var c = compiled[id];
      if (c.ok) c.deps.forEach(function (dep) { if (compiled[dep]) visit(dep); });
      stack.pop(); state[id] = 2;
      if (circular[id]) { out[id] = null; errors[id] = t('fCircular'); }
      else if (!c.ok) { out[id] = null; errors[id] = c.error; }
      else out[id] = c.run(out);
    }
    Object.keys(compiled).forEach(visit);
    Object.defineProperty(out, '_errors', { value: errors, enumerable: false });
    return out;
  }

  // ---- CSV ----------------------------------------------------------------------------------------------
  function csvDelimiter() { return language() === 'pt' ? ';' : ','; }
  /** A cell that a spreadsheet would run as a formula (=HYPERLINK(...)) gets a ' in front. A phone number (+55 11 9...) does not. */
  function csvSafe(s) { return /^[=@\t\r]/.test(s) || (/^[+-]/.test(s) && !/^[+-][\d\s().,-]*$/.test(s)) ? "'" + s : s; }
  function csvCell(value, delimiter) {
    var s;
    if (value === undefined || value === null) return '';
    if (typeof value === 'number') s = String(value);
    else if (typeof value === 'boolean') s = value ? t('yes') : t('no');
    else if (isDateObject(value)) s = isoDate(value);
    else if (Array.isArray(value)) s = csvSafe(value.map(text).join('; '));
    else if (isPlain(value)) s = text(value.name || value.path);
    else s = csvSafe(String(value));
    return s.indexOf('"') >= 0 || s.indexOf(delimiter) >= 0 || /[\r\n]/.test(s) || /^\s|\s$/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  /** columns = [{ key, label, format?(value, row) }]; header row, CRLF, RFC 4180 quoting, a BOM so Excel reads accents.
   *  options.delimiter defaults to "," (csv.delimiter() is ";" in Portuguese, which is what Brazilian Excel splits on). */
  function csvStringify(rows, columns, options) {
    var delimiter = (options && options.delimiter) || ',';
    var lines = [columns.map(function (c) { return csvCell(c.label === undefined ? c.key : c.label, delimiter); }).join(delimiter)];
    (rows || []).forEach(function (row) {
      lines.push(columns.map(function (c) {
        var value = row[c.key];
        return csvCell(typeof c.format === 'function' ? c.format(value, row) : value, delimiter);
      }).join(delimiter));
    });
    return '\uFEFF' + lines.join('\r\n') + '\r\n';
  }
  function detectDelimiter(s) {
    var counts = { ',': 0, ';': 0, '\t': 0 }, quoted = false;
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      if (c === '"') quoted = !quoted;
      else if (!quoted && (c === '\n' || c === '\r')) break;
      else if (!quoted && counts[c] !== undefined) counts[c]++;
    }
    return counts[';'] > counts[','] && counts[';'] >= counts['\t'] ? ';' : counts['\t'] > counts[','] ? '\t' : ',';
  }
  /** RFC 4180 with quotes, doubled quotes and newlines inside quotes; a BOM is dropped; "," ";" or a tab is found in the
   *  first line. -> { header, rows, delimiter }; short rows are padded to the header's length. */
  function csvParse(input) {
    var s = text(input).replace(/^\uFEFF/, '');
    var delimiter = detectDelimiter(s), all = [], row = [], cell = '', quoted = false, i = 0, n = s.length;
    while (i < n) {
      var c = s.charAt(i);
      if (quoted) {
        if (c === '"') { if (s.charAt(i + 1) === '"') { cell += '"'; i += 2; continue; } quoted = false; i++; continue; }
        cell += c; i++; continue;
      }
      if (c === '"' && cell === '') { quoted = true; i++; continue; }
      if (c === delimiter) { row.push(cell); cell = ''; i++; continue; }
      if (c === '\n' || c === '\r') {
        if (c === '\r' && s.charAt(i + 1) === '\n') i++;
        row.push(cell); all.push(row); row = []; cell = ''; i++; continue;
      }
      cell += c; i++;
    }
    if (cell !== '' || row.length) { row.push(cell); all.push(row); }
    all = all.filter(function (r) { return !(r.length === 1 && r[0] === ''); });
    var header = (all.shift() || []).map(function (h) { return h.trim(); });
    all.forEach(function (r) { while (r.length < header.length) r.push(''); });
    return { header: header, rows: all, delimiter: delimiter };
  }

  // ---- Examples ------------------------------------------------------------------------------------------
  function samplesCount(records) {
    return (records || []).filter(function (r) { return r && ((r.data && r.data._sample === true) || r._sample === true); }).length;
  }
  /** Inserts each doc with data._sample = true, one after the other; resolves how many. */
  function samplesLoad(collection, docs) {
    var made = 0, chain = Promise.resolve();
    (docs || []).forEach(function (doc) {
      chain = chain.then(function () { return collection.insert(Object.assign({}, doc, { _sample: true })); }).then(function () { made++; });
    });
    return chain.then(function () { return made; });
  }
  /** Removes exactly the records marked _sample; resolves how many. */
  function samplesClear(collection) {
    return collection.list({ where: { _sample: true }, limit: 5000 }).then(function (records) {
      var gone = 0, chain = Promise.resolve();
      records.forEach(function (record) { chain = chain.then(function () { return collection.remove(record.id); }).then(function () { gone++; }); });
      return chain.then(function () { return gone; });
    });
  }

  // ---- Markdown -> a small tree (tkit.markdown turns it into DOM; nothing here touches HTML) ----------------
  var MD_LINK = /^(https?:\/\/|mailto:)[^\s<>]+$/i;
  function mdFindClose(src, from, token) {
    for (var j = from; j < src.length; j++) {
      var c = src.charAt(j);
      if (c === '\\') { j++; continue; }
      if (c === '`') { var end = src.indexOf('`', j + 1); if (end > 0) { j = end; continue; } }
      if (src.substr(j, token.length) === token && (token.length > 1 || src.charAt(j + 1) !== '*') && j > from && !/\s/.test(src.charAt(j - 1))) {
        while (token === '**' && src.charAt(j + 2) === '*') j++; // "***": the last two close the bold, the first closes an italic inside
        return j;
      }
    }
    return -1;
  }
  function mdInline(src, depth, inLink) {
    var out = [], buf = '', i = 0, n = src.length;
    function flush() { if (buf) { out.push({ type: 'text', text: buf }); buf = ''; } }
    while (i < n) {
      var c = src.charAt(i), end;
      if (c === '\\' && i + 1 < n && '\\`*[]'.indexOf(src.charAt(i + 1)) >= 0) { buf += src.charAt(i + 1); i += 2; continue; }
      if (c === '\n') { flush(); out.push({ type: 'br' }); i++; continue; }
      if (c === '`') {
        end = src.indexOf('`', i + 1);
        if (end > i + 1) { flush(); out.push({ type: 'code', text: src.slice(i + 1, end) }); i = end + 1; continue; }
      }
      if (c === '*' && depth < 4) {
        if (src.charAt(i + 1) === '*') {
          end = /\S/.test(src.charAt(i + 2)) ? mdFindClose(src, i + 2, '**') : -1;
          if (end > 0) { flush(); out.push({ type: 'strong', children: mdInline(src.slice(i + 2, end), depth + 1, inLink) }); i = end + 2; continue; }
        } else if (/\S/.test(src.charAt(i + 1))) {
          end = mdFindClose(src, i + 1, '*');
          if (end > 0) { flush(); out.push({ type: 'em', children: mdInline(src.slice(i + 1, end), depth + 1, inLink) }); i = end + 1; continue; }
        }
      }
      if (c === '[' && !inLink) {
        if (src.charAt(i + 1) === '[') {
          end = src.indexOf(']]', i + 2);
          var title = end > 0 ? src.slice(i + 2, end).trim() : '';
          if (title && title.length <= 200 && !/[\[\]\n]/.test(title)) { flush(); out.push({ type: 'wikilink', title: title }); i = end + 2; continue; }
        } else {
          var close = src.indexOf(']', i + 1), m = close > 0 ? /^\(([^\s()]+)\)/.exec(src.slice(close + 1)) : null;
          if (m && MD_LINK.test(m[1]) && close > i + 1 && src.slice(i + 1, close).indexOf('\n') < 0) {
            flush();
            out.push({ type: 'link', href: m[1], children: mdInline(src.slice(i + 1, close), depth + 1, true) });
            i = close + 1 + m[0].length; continue;
          }
        }
      }
      buf += c; i++;
    }
    flush();
    return out;
  }
  var MD_LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
  function mdIndent(s) { return s.replace(/\t/g, '    ').length; }
  function mdStartsBlock(line) {
    var m;
    if (/^\s{0,3}(`{3,}|~{3,})/.test(line) || /^\s{0,3}#{1,3}\s+\S/.test(line) || /^\s{0,3}-{3,}\s*$/.test(line) || /^\s{0,3}>/.test(line)) return true;
    m = MD_LIST.exec(line);
    return !!m && (m[2].length === 1 || /^1[.)]$/.test(m[2])); // only "1." may interrupt a paragraph
  }
  function mdList(lines, at) {
    var first = MD_LIST.exec(lines[at]), base = mdIndent(first[1]);
    var ordered = /\d/.test(first[2]), start = ordered ? parseInt(first[2], 10) : 1;
    var items = [], i = at;
    while (i < lines.length) {
      var line = lines[i], m = MD_LIST.exec(line);
      if (/^\s*$/.test(line)) {
        var next = i + 1;
        while (next < lines.length && /^\s*$/.test(lines[next])) next++;
        var after = next < lines.length ? MD_LIST.exec(lines[next]) : null;
        if (after && mdIndent(after[1]) >= base) { i = next; continue; }
        break;
      }
      if (!m) {
        if (items.length && mdIndent(line) >= base + 2) { var last = items[items.length - 1]; var target = last.sub ? last.sub[last.sub.length - 1] : last; target.raw += '\n' + line.trim(); i++; continue; }
        break;
      }
      var indent = mdIndent(m[1]), isOrdered = /\d/.test(m[2]);
      if (indent < base) break;
      if (indent >= base + 2 && items.length) {
        var parent = items[items.length - 1];
        if (!parent.sub) { parent.sub = []; parent.subOrdered = isOrdered; }
        parent.sub.push({ raw: m[3] });
      } else {
        if (items.length && isOrdered !== ordered) break; // a different kind of list starts here
        items.push({ raw: m[3], sub: null });
      }
      i++;
    }
    return { block: { type: 'list', ordered: ordered, start: start, items: items.map(function (item) {
      return { children: mdInline(item.raw, 0, false), sub: item.sub ? { type: 'list', ordered: item.subOrdered, start: 1, items: item.sub.map(function (s) { return { children: mdInline(s.raw, 0, false), sub: null }; }) } : null };
    }) }, next: i };
  }
  function isFenceEnd(line, fence) {
    var m = /^\s{0,3}(`{3,}|~{3,})\s*$/.exec(line);
    return !!m && m[1].charAt(0) === fence.charAt(0) && m[1].length >= fence.length;
  }
  function mdBlocks(lines, depth) {
    var blocks = [], i = 0, m;
    while (i < lines.length) {
      var line = lines[i];
      if (/^\s*$/.test(line)) { i++; continue; }
      if ((m = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/.exec(line))) {
        var fence = m[1], body = [];
        i++;
        while (i < lines.length && !isFenceEnd(lines[i], fence)) { body.push(lines[i]); i++; }
        i++; // the closing fence (or the end)
        blocks.push({ type: 'code', lang: m[2], text: body.join('\n') });
        continue;
      }
      if ((m = /^\s{0,3}(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line))) { blocks.push({ type: 'heading', level: m[1].length, children: mdInline(m[2], 0, false) }); i++; continue; }
      if (/^\s{0,3}-{3,}\s*$/.test(line)) { blocks.push({ type: 'rule' }); i++; continue; }
      if (/^\s{0,3}>/.test(line) && depth < 4) {
        var quoted = [];
        while (i < lines.length && /^\s{0,3}>/.test(lines[i])) { quoted.push(lines[i].replace(/^\s{0,3}>\s?/, '')); i++; }
        blocks.push({ type: 'quote', children: mdBlocks(quoted, depth + 1) });
        continue;
      }
      if (MD_LIST.test(line)) { var made = mdList(lines, i); blocks.push(made.block); i = made.next; continue; }
      var para = [line];
      i++;
      while (i < lines.length && !/^\s*$/.test(lines[i]) && !mdStartsBlock(lines[i])) { para.push(lines[i].trim()); i++; }
      blocks.push({ type: 'paragraph', children: mdInline(para.join('\n').trim(), 0, false) });
    }
    return blocks;
  }
  function mdPlain(nodes) {
    return (nodes || []).map(function (n) { return n.type === 'text' || n.type === 'code' ? n.text : n.type === 'wikilink' ? n.title : n.type === 'br' ? ' ' : mdPlain(n.children); }).join('');
  }
  /** The tree: blocks heading {level, children, anchor} | paragraph {children} | code {lang, text} | list {ordered, start,
   *  items:[{children, sub}]} | quote {children: blocks} | rule; inline text | strong | em | code | br | link {href, children}
   *  | wikilink {title}. Only http, https and mailto links survive; everything else (HTML included) stays text. */
  function parseMarkdown(src) {
    var blocks = mdBlocks(text(src).replace(/\r\n?/g, '\n').split('\n'), 0), taken = [];
    blocks.forEach(function (block) {
      if (block.type === 'heading') { block.anchor = slug(mdPlain(block.children), taken); taken.push(block.anchor); }
    });
    return blocks;
  }
  /** [{ level, text, anchor }] for a "table of contents"; anchors match the data-anchor of the rendered headings. */
  function markdownOutline(src) {
    return parseMarkdown(src).filter(function (b) { return b.type === 'heading'; }).map(function (b) { return { level: b.level, text: mdPlain(b.children), anchor: b.anchor }; });
  }

  // ==== v2.1: pure helpers ============================================================

  // ---- Search: tkit.search ------------------------------------------------------------------
  /** Folds `src` and remembers, for every folded character, where it came from (folding can change the length). */
  function foldMap(src) {
    var f = normalize(src);
    if (f.length === src.length) return { f: f, map: null };
    var out = '', map = [];
    for (var i = 0; i < src.length; i++) {
      var piece = normalize(src.charAt(i));
      for (var k = 0; k < piece.length; k++) { out += piece.charAt(k); map.push(i); }
    }
    return { f: out, map: map };
  }
  /** [[start, end)] of every occurrence of every word of `query` in `src` (accents and case ignored, overlaps merged),
   *  or null when there is no word or some word is missing. The ranges index the original text. */
  function searchMatch(src, query) {
    var words = normalize(query).split(/\s+/).filter(Boolean);
    if (!words.length) return null;
    var folded = foldMap(text(src)), f = folded.f, map = folded.map, found = [];
    for (var w = 0; w < words.length; w++) {
      var word = words[w], at = f.indexOf(word), hits = 0;
      if (at < 0) return null;
      while (at >= 0 && hits < 500) {
        found.push([map ? map[at] : at, (map ? map[at + word.length - 1] : at + word.length - 1) + 1]);
        at = f.indexOf(word, at + word.length); hits++;
      }
    }
    found.sort(function (a, b) { return a[0] - b[0]; });
    var merged = [];
    found.forEach(function (r) { var last = merged[merged.length - 1]; if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]); else merged.push([r[0], r[1]]); });
    return merged;
  }
  /** About `size` characters of `src` around the first range, with … where it was cut; '' when there is no match. */
  function searchSnippet(src, ranges, size) {
    src = text(src);
    size = size > 0 ? size : 160;
    if (!ranges || !ranges.length) return '';
    var lead = Math.min(50, Math.floor(size / 3)), start = Math.max(0, ranges[0][0] - lead);
    if (start > 0) { var space = src.indexOf(' ', start); if (space >= 0 && space < ranges[0][0]) start = space + 1; }
    var end = Math.min(src.length, start + size);
    return (start > 0 ? '…' : '') + src.slice(start, end).trim() + (end < src.length ? '…' : '');
  }
  /** `src` as a DocumentFragment with the ranges wrapped in <mark> (DOM nodes only, never innerHTML). */
  function searchHighlight(src, ranges) {
    src = text(src);
    var out = document.createDocumentFragment(), at = 0;
    (ranges || []).forEach(function (r) {
      if (r[0] < at) return;
      if (r[0] > at) out.appendChild(document.createTextNode(src.slice(at, r[0])));
      out.appendChild(h('mark', { text: src.slice(r[0], r[1]) }));
      at = r[1];
    });
    if (at < src.length) out.appendChild(document.createTextNode(src.slice(at)));
    return out;
  }

  // ---- Text areas: tkit.textarea ----------------------------------------------------------------------
  /** What wrapping the selection start..end of `value` in before/after changes: { from, to, insert, selFrom, selTo }.
   *  With nothing selected, `placeholder` (default empty) goes between and is left selected. */
  function wrapEdit(value, start, end, before, after, placeholder) {
    var chosen = value.slice(start, end) || text(placeholder);
    return { from: start, to: end, insert: before + chosen + after, selFrom: start + before.length, selTo: start + before.length + chosen.length };
  }
  /** What putting `prefix` in front of every line touched by start..end changes. If every non-empty line already has it, it
   *  is taken off instead. */
  function prefixEdit(value, start, end, prefix) {
    var from = start === 0 ? 0 : value.lastIndexOf('\n', start - 1) + 1;
    var stop = end > start && value.charAt(end - 1) === '\n' ? end - 1 : end;
    var to = value.indexOf('\n', stop);
    if (to < 0) to = value.length;
    if (to < from) to = from;
    var lines = value.slice(from, to).split('\n');
    var filled = lines.filter(function (line) { return line.trim() !== ''; });
    var remove = filled.length > 0 && filled.every(function (line) { return line.indexOf(prefix) === 0; });
    var out = lines.map(function (line) {
      if (remove) return line.indexOf(prefix) === 0 ? line.slice(prefix.length) : line;
      return (line.trim() === '' && lines.length > 1) || line.indexOf(prefix) === 0 ? line : prefix + line;
    }).join('\n');
    return { from: from, to: to, insert: out, selFrom: from, selTo: from + out.length };
  }
  /** Writes an edit into a textarea the way typing would (execCommand keeps the browser's undo), else with setRangeText. */
  function applyEdit(area, edit) {
    var before = area.value;
    area.focus();
    area.setSelectionRange(edit.from, edit.to);
    var ok = false;
    try { ok = document.execCommand('insertText', false, edit.insert); } catch (_) { /* not available */ }
    if (!ok || (area.value === before && edit.insert !== before.slice(edit.from, edit.to))) {
      area.setRangeText(edit.insert, edit.from, edit.to, 'end');
      area.dispatchEvent(new Event('input', { bubbles: true }));
    }
    area.setSelectionRange(edit.selFrom, edit.selTo);
  }
  function textareaWrap(area, before, after, placeholder) { applyEdit(area, wrapEdit(area.value, area.selectionStart, area.selectionEnd, text(before), text(after), placeholder)); }
  function textareaPrefixLines(area, prefix) { applyEdit(area, prefixEdit(area.value, area.selectionStart, area.selectionEnd, text(prefix))); }

  // ---- Autosave: tkit.autosave ---------------------------------------------------------------------------
  function holdReload(on) {
    try { if (window.tendly && tendly.host && typeof tendly.host.holdReload === 'function') tendly.host.holdReload(on); } catch (_) { /* no SDK */ }
  }
  /** Debounced, one save at a time. touch() says "the text changed"; flush() saves now and resolves when nothing is pending.
   *  status is idle | typing | saving | saved | error. Reloads are held while there is unsaved text. A failed save keeps the
   *  text dirty (status error) and is tried again by the next touch() or flush(). saveFn() may return a Promise. */
  function autosave(saveFn, options) {
    options = options || {};
    var delay = options.delay === undefined ? 800 : options.delay;
    var dirty = false, timer = null, saving = null, status = 'idle', failure = null;
    var api = {};
    function setStatus(next, error) {
      status = next; failure = error || null;
      if (typeof options.onStatus === 'function') { try { options.onStatus(next, error); } catch (e) { setTimeout(function () { throw e; }); } }
    }
    function run() {
      clearTimeout(timer); timer = null;
      if (saving) return saving;
      if (!dirty) return Promise.resolve();
      dirty = false;
      setStatus('saving');
      saving = Promise.resolve().then(saveFn).then(function () { return null; }, function (error) { return error || new Error(t('error')); }).then(function (error) {
        saving = null;
        if (error) { dirty = true; setStatus('error', error); return; }
        if (dirty) { setStatus('typing'); if (!timer) timer = setTimeout(run, Math.min(delay, 300)); return; }
        setStatus('saved');
        holdReload(false);
      });
      return saving;
    }
    api.touch = function () {
      dirty = true;
      holdReload(true);
      setStatus('typing');
      clearTimeout(timer);
      if (!saving) timer = setTimeout(run, delay);
    };
    api.flush = function () {
      clearTimeout(timer); timer = null;
      var rounds = 0;
      function step() {
        if (!dirty && !saving) return Promise.resolve();
        if (++rounds > 3) return Promise.resolve();
        return run().then(function () { return status === 'error' ? undefined : step(); });
      }
      return step();
    };
    Object.defineProperty(api, 'status', { get: function () { return status; }, enumerable: true });
    Object.defineProperty(api, 'error', { get: function () { return failure; }, enumerable: true });
    return api;
  }

  // ---- CSV from a schema ---------------------------------------------------------------------------------------
  function csvFormat(field, value) {
    if (value === undefined || value === null || value === '') return '';
    switch (field.type) {
      case 'number': case 'money': return typeof value === 'number' ? String(value) : text(value);
      case 'formula': return typeof value === 'number' ? String(Math.round(value * 1e10) / 1e10) : typeof value === 'boolean' ? (value ? t('yes') : t('no')) : text(value);
      case 'multi': return (Array.isArray(value) ? value : [value]).map(function (id) { var o = findOption(field, id); return o ? text(o.label) : text(id); }).join('; ');
      case 'choice': case 'checkbox': case 'image': case 'file': return fieldText(field, value);
      default: return text(value); // text, dates and times are written as stored (ISO), so a spreadsheet can read them back
    }
  }
  /** Columns for tkit.csv.stringify from a field list: label as the header, numbers with ".", dates ISO, choices by label,
   *  files by name. Formula fields are exported too: compute the rows with tkit.compute first. `settings` is accepted so a
   *  later version can use it (money is exported as a plain number, with no symbol). */
  function csvColumnsFor(fields, settings) {
    return (fields || []).map(function (field) {
      return { key: field.id, label: field.label === undefined ? field.id : field.label, format: function (value) { return csvFormat(field, value, settings); } };
    });
  }
  /** "<app> - <name> - YYYY-MM-DD.csv" without characters a file name cannot hold. */
  function csvFileName(app, name, day) {
    var parts = [app, name, day || today()].map(function (part) { return text(part).replace(/[\\/:*?"<>|\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim(); }).filter(Boolean);
    return parts.join(' - ') + '.csv';
  }

  // ---- Table footer ------------------------------------------------------------------------------------------------------
  function footerNumbers(rows, key) {
    var out = [];
    (rows || []).forEach(function (row) {
      var v = row[key];
      if (typeof v === 'number') { if (isFinite(v)) out.push(v); }
      else if (typeof v === 'string' && v.trim() !== '' && isFinite(Number(v))) out.push(Number(v));
    });
    return out;
  }
  /** The footer of a table: one { key, value, num } per column. A column's spec is 'sum' | 'avg' (over the numbers it has;
   *  empty if none) | 'count' (rows with a value in it) | any other text (as it is) | a function (rows, column) -> text or Node.
   *  money columns are formatted with their currency, the rest as numbers. */
  function tableFooter(columns, footer, rows) {
    return (columns || []).map(function (column) {
      var spec = footer && Object.prototype.hasOwnProperty.call(footer, column.key) ? footer[column.key] : undefined, value = '';
      var numeric = column.type === 'number' || column.type === 'money';
      if (typeof spec === 'function') value = spec(rows, column);
      else if (spec === 'sum' || spec === 'avg') {
        var nums = footerNumbers(rows, column.key);
        if (nums.length) {
          var total = nums.reduce(function (s, x) { return s + x; }, 0);
          if (spec === 'avg') total = total / nums.length;
          value = column.type === 'money' ? money(total, column.currency) : number(total, 2);
        }
      } else if (spec === 'count') value = number((rows || []).filter(function (row) { return !emptyValue(row[column.key]); }).length, 0);
      else if (typeof spec === 'string') value = spec;
      return { key: column.key, value: value === undefined || value === null ? '' : value, num: numeric };
    });
  }

  // ---- Weekdays only: the calendar without Saturday and Sunday --------------------------------------------------
  /** monthGrid without Saturdays and Sundays (weekday 0 and 6). Each cell has `weekend`, the dates of the weekend days that
   *  belong to it: a Friday gets the Saturday and Sunday after it (or, at the start of a grid that begins on a weekend day,
   *  before it); the other cells have an empty list. */
  function weekdayGrid(year, month, weekStart) {
    var all = monthGrid(year, month, weekStart);
    all.forEach(function (cell) { cell.weekend = []; });
    all.forEach(function (cell, i) {
      if (cell.weekday !== 0 && cell.weekday !== 6) return;
      var back = cell.weekday === 6 ? 1 : 2, target = all[i - back];
      if (!target || target.weekday !== 5) target = all[i + (cell.weekday === 6 ? 6 : 5)];
      if (target) target.weekend.push(cell.date);
    });
    return all.filter(function (cell) { return cell.weekday !== 0 && cell.weekday !== 6; });
  }

  // ---- Clipboard -----------------------------------------------------------------------------------------------------------
  function copyFallback(str) {
    var area, kept = null, ok = false;
    try {
      kept = document.activeElement;
      area = h('textarea', { readonly: true, 'aria-hidden': 'true', tabindex: '-1', style: { position: 'fixed', top: '0', left: '0', opacity: '0' } });
      area.value = str;
      document.body.appendChild(area);
      area.select();
      ok = !!document.execCommand('copy');
    } catch (_) { ok = false; }
    try { if (area && area.parentNode) area.parentNode.removeChild(area); if (kept && kept.focus) kept.focus(); } catch (_) { /* gone */ }
    return ok;
  }
  /** Puts text on the clipboard: the Clipboard API first, then a hidden textarea (frames often refuse the API). Resolves
   *  true or false; on success it shows a "Copied" toast. */
  function copy(str) {
    str = text(str);
    var first = Promise.resolve(false);
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        first = Promise.resolve(navigator.clipboard.writeText(str)).then(function () { return true; }, function () { return false; });
      }
    } catch (_) { /* no Clipboard API */ }
    return first.then(function (ok) { return ok || copyFallback(str); }).then(function (ok) {
      if (ok) { try { toast(t('copied'), { tone: 'success' }); } catch (_) { /* no page to show it on */ } }
      return ok;
    });
  }

  // ==== v2.2: pure helpers ============================================================

  // ---- Reordering: tkit.moveId and tkit.dropIndex --------------------------------------------------------
  /** A copy of `ids` with `id` moved to position `to` (counted in the list as it is now, kept inside it). Unknown id or a
   *  `to` that is not a number: an unchanged copy. */
  function moveId(ids, id, to) {
    var list = (ids || []).slice(), from = -1, target = Math.round(Number(to));
    list.forEach(function (x, n) { if (text(x) === text(id)) from = n; });
    if (from < 0 || isNaN(target)) return list;
    target = Math.max(0, Math.min(list.length - 1, target));
    var item = list.splice(from, 1)[0];
    list.splice(target, 0, item);
    return list;
  }
  /** Where a dragged item lands: `rects` are the boxes ({ left, top, width, height }) of the OTHER items in order and the answer is
   *  an index into that list (0 = before the first, rects.length = after the last). axis 'y' is a column of rows (the pointer's
   *  height decides); 'xy' is a grid (the nearest box decides, before it or after it by which half of it the pointer is over). */
  function dropIndex(rects, x, y, axis) {
    var n = (rects || []).length, i;
    if (!n) return 0;
    if (axis !== 'xy') {
      for (i = 0; i < n; i++) if (y < rects[i].top + rects[i].height / 2) return i;
      return n;
    }
    var best = 0, bestDistance = Infinity;
    for (i = 0; i < n; i++) {
      var dx = x - (rects[i].left + rects[i].width / 2), dy = y - (rects[i].top + rects[i].height / 2), d = dx * dx + dy * dy;
      if (d < bestDistance) { bestDistance = d; best = i; }
    }
    var r = rects[best], sameRow = y >= r.top && y <= r.top + r.height;
    var before = sameRow ? x < r.left + r.width / 2 : y < r.top + r.height / 2;
    return before ? best : best + 1;
  }

  // ---- The letter tile of a gallery card -------------------------------------------------------------------
  /** The first letter or digit of a title, upper case ("état" -> "É"); "?" when there is none. */
  function letterOf(title) {
    var chars = text(title).trim();
    chars = typeof Array.from === 'function' ? Array.from(chars) : chars.split('');
    for (var i = 0; i < chars.length; i++) if (!/[\s\-_.,;:!?'"()\[\]{}*#@\/\\|+=<>~`&%$^]/.test(chars[i])) return chars[i].toUpperCase();
    return '?';
  }

  // ---- In-place cells: tkit.cellValue and tkit.cellText ---------------------------------------------------------
  var YES_WORDS = ['y', 'yes', 'sim', 's', 'true', '1'], NO_WORDS = ['n', 'no', 'nao', 'false', '0'];
  function cellFail(message) { return { ok: false, value: null, error: message }; }
  function cellOk(value) { return { ok: true, value: value }; }
  function scoreBounds(spec) {
    var min = spec.min === undefined || spec.min === null ? 1 : Math.round(Number(spec.min)), max = spec.max === undefined || spec.max === null ? 5 : Math.round(Number(spec.max));
    if (isNaN(min)) min = 1;
    if (isNaN(max)) max = 5;
    return { min: min, max: Math.max(min, Math.min(min + 9, max)) };
  }
  function hasBound(value) { return value !== undefined && value !== null && value !== ''; }
  function rangeMessage(min, max) {
    if (hasBound(min) && hasBound(max)) return tf('rangeBetween', { min: number(min), max: number(max) });
    return hasBound(min) ? tf('rangeMin', { min: number(min) }) : tf('rangeMax', { max: number(max) });
  }
  /** What to save for what an in-place cell holds. spec.type: number | money (typed as people write it, min/max checked), score
   *  (a whole number from spec.min = 1 to spec.max = 5), yesno (y n yes no sim nao true false), text, choice (an option id or
   *  label out of spec.options). Empty is { ok: true, value: null }; a bad value is { ok: false, error }. */
  function cellValue(spec, raw) {
    spec = spec || {};
    var type = spec.type || 'text';
    if (type === 'yesno') {
      if (typeof raw === 'boolean') return cellOk(raw);
      if (emptyRaw(raw)) return cellOk(null);
      var word = normalize(raw).trim();
      if (YES_WORDS.indexOf(word) >= 0) return cellOk(true);
      if (NO_WORDS.indexOf(word) >= 0) return cellOk(false);
      return cellFail(t('notAnOption'));
    }
    if (emptyRaw(raw)) return cellOk(null);
    if (type === 'number' || type === 'money') {
      var n = parseNumber(raw);
      if (n === null) return cellFail(t('notNumber'));
      if ((hasBound(spec.min) && n < Number(spec.min)) || (hasBound(spec.max) && n > Number(spec.max))) return cellFail(rangeMessage(spec.min, spec.max));
      return cellOk(n);
    }
    if (type === 'score') {
      var bounds = scoreBounds(spec), s = Number(typeof raw === 'string' ? raw.trim() : raw);
      if (!isFinite(s) || Math.round(s) !== s) return cellFail(t('notNumber'));
      return s < bounds.min || s > bounds.max ? cellFail(rangeMessage(bounds.min, bounds.max)) : cellOk(s);
    }
    if (type === 'choice') {
      var option = findOption(spec, raw);
      return option ? cellOk(option.id) : cellFail(t('notAnOption'));
    }
    return cellOk(text(raw).trim());
  }
  /** What an in-place cell shows for its value: numbers and money as the page's language writes them, a score as stars, yes/no
   *  as Yes/No, a choice by its label, and an em dash when empty. spec.format(value) wins for a value that is there. */
  function cellText(spec, value) {
    spec = spec || {};
    if (value === undefined || value === null || value === '') return '—';
    if (typeof spec.format === 'function') return text(spec.format(value));
    switch (spec.type || 'text') {
      case 'number': return number(value, 6);
      case 'money': return money(value, spec.currency);
      case 'score': {
        var bounds = scoreBounds(spec), stars = '', v = Number(value);
        for (var i = bounds.min; i <= bounds.max; i++) stars += i <= v ? '★' : '☆';
        return stars;
      }
      case 'yesno': return value ? t('yes') : t('no');
      case 'choice': { var option = findOption(spec, value); return option ? text(option.label) : text(value); }
      default: return text(value);
    }
  }

  // ---- The "…" menu: keyboard and placement ------------------------------------------------------------------------
  function menuEnabled(item) { return !!item && item !== '-' && typeof item === 'object' && !item.disabled; }
  /** Which menu item a key lands on. items = [{ id, label, disabled? } | '-']; current is the index now (-1: none). ArrowDown and
   *  ArrowUp wrap and skip separators and disabled items, Home and End jump to the first and last, a single character jumps to
   *  the next label that starts with it (accents and case ignored). Any other key: current. -1 when nothing can be chosen. */
  function menuIndex(items, current, key) {
    var list = items || [], enabled = [], i;
    for (i = 0; i < list.length; i++) if (menuEnabled(list[i])) enabled.push(i);
    if (!enabled.length) return -1;
    current = typeof current === 'number' ? current : -1;
    if (key === 'Home') return enabled[0];
    if (key === 'End') return enabled[enabled.length - 1];
    if (key === 'ArrowDown') {
      for (i = 0; i < enabled.length; i++) if (enabled[i] > current) return enabled[i];
      return enabled[0];
    }
    if (key === 'ArrowUp') {
      for (i = enabled.length - 1; i >= 0; i--) if (enabled[i] < current) return enabled[i];
      return enabled[enabled.length - 1];
    }
    if (typeof key === 'string' && key.length === 1 && key !== ' ') {
      var letter = normalize(key);
      for (var step = 1; step <= list.length; step++) {
        var at = (Math.max(current, -1) + step) % list.length;
        if (menuEnabled(list[at]) && normalize(list[at].label).indexOf(letter) === 0) return at;
      }
    }
    return current;
  }
  /** Where a popover goes: `anchor` is the button's box, `size` the popover's, `bound` the area it must stay in (boxes are
   *  { left, top, right, bottom }; size is { width, height }). Right edges line up (left edges when that would leave the area);
   *  it opens below and flips above when below would not fit and above does. Returns { left, top, flipped }. */
  function menuPosition(anchor, size, bound, gap) {
    gap = gap === undefined ? 4 : gap;
    var left = anchor.right - size.width;
    if (left < bound.left + gap) left = anchor.left;
    left = Math.max(bound.left + gap, Math.min(left, bound.right - size.width - gap));
    var below = anchor.bottom + gap, above = anchor.top - gap - size.height, flipped = false, top = below;
    if (below + size.height > bound.bottom - gap && above >= bound.top + gap) { top = above; flipped = true; }
    else top = Math.max(bound.top + gap, Math.min(below, bound.bottom - gap - size.height));
    return { left: left, top: top, flipped: flipped };
  }

  // ---- DOM helpers -----------------------------------------------------------
  function h(tag, props) {
    var el = document.createElement(tag);
    var custom = tag.indexOf('t-') === 0; // a kit element: its props are attributes (text, title, kind…), not DOM properties
    props = props || {};
    Object.keys(props).forEach(function (key) {
      var value = props[key];
      if (value === undefined || value === null || value === false) return;
      if (key === 'class') el.className = value;
      else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
      else if (key === 'dataset') Object.keys(value).forEach(function (k) { el.dataset[k] = value[k]; });
      else if (key.indexOf('on') === 0 && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
      else if (custom && key === 'children') append(el, value);
      else if (custom && typeof value !== 'object' && typeof value !== 'function') el.setAttribute(key, value === true ? '' : String(value));
      else if (key === 'text') el.textContent = value;
      else if (key in el && typeof value !== 'string' && key !== 'value') el[key] = value;
      else el.setAttribute(key, value === true ? '' : value);
    });
    for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }
  function append(el, child) {
    if (child === undefined || child === null || child === false) return;
    if (Array.isArray(child)) child.forEach(function (c) { append(el, c); });
    else if (child instanceof Node) el.appendChild(child);
    else el.appendChild(document.createTextNode(String(child)));
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }
  var ICONS = {
    board: 'M4 5h4v14H4zM10 5h4v9h-4zM16 5h4v6h-4z',
    table: 'M4 5h16v14H4zM4 10h16M4 15h16M10 5v14',
    calendar: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4',
    chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
    form: 'M5 4h14v16H5zM8 9h8M8 13h8M8 17h5',
    doc: 'M6 3h9l4 4v14H6zM15 3v4h4M9 12h6M9 16h6',
    list: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
    home: 'M3 11l9-8 9 8v10H3zM10 21v-6h4v6',
    users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
    inbox: 'M22 12h-6l-2 3h-4l-2-3H2M5 5h14l3 7v7H2v-7z',
    plus: 'M12 5v14M5 12h14',
    search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
    settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
    close: 'M6 6l12 12M18 6L6 18',
    check: 'M5 12l5 5L20 7',
    trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 14h10l1-14M9 7V4h6v3',
    edit: 'M4 20h4l10-10-4-4L4 16zM13 7l4 4',
    chevronLeft: 'M15 6l-6 6 6 6',
    chevronRight: 'M9 6l6 6-6 6',
    arrowUp: 'M12 19V5M5 12l7-7 7 7',
    arrowDown: 'M12 5v14M5 12l7 7 7-7',
    info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 8h.01M11 12h1v4h1',
    alert: 'M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
    spinner: 'M12 2v4M12 18v4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M2 12h4M18 12h4M4.9 19.1l2.8-2.8M16.3 7.7l2.8-2.8',
    link: 'M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1',
    download: 'M12 3v12M6 11l6 6 6-6M4 21h16',
    upload: 'M12 21V9M6 13l6-6 6 6M4 3h16',
    star: 'M12 2l3 7 7 .6-5.3 4.7L18.4 22 12 18l-6.4 4 1.7-7.7L2 9.6 9 9z',
    tag: 'M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L2 12V2h10l8.6 8.6a2 2 0 0 1 0 2.8zM7 7h.01',
    clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2',
    money: 'M2 6h20v12H2zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6M6 12h.01M18 12h.01',
    image: 'M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M9 9h.01',
    grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
    'check-square': 'M4 4h16v16H4zM8 12l3 3 5-6',
    calculator: 'M6 3h12v18H6zM9 7h6M9 12h.01M12 12h.01M15 12h.01M9 16h.01M12 16h.01M15 16h.01',
    scale: 'M12 4v16M8 20h8M4 8h16M5 8l-3 7h6zM19 8l-3 7h6zM2 15a3 3 0 0 0 6 0M16 15a3 3 0 0 0 6 0',
    book: 'M5 4h14v16H7a2 2 0 0 1-2-2zM5 18a2 2 0 0 1 2-2h12M9 8h6',
    'map-pin': 'M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11zM12 12a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
    map: 'M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2zM9 4v14M15 6v14',
    help: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 1-1 1.7M12 17h.01',
    repeat: 'M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3',
    play: 'M7 4l13 8-13 8z',
    clipboard: 'M9 4h6v3H9zM7 5H5v16h14V5h-2M9 12h6M9 16h4',
    filter: 'M3 4h18l-7 9v6l-4 2v-8z',
    external: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
    copy: 'M9 9h11v11H9zM5 15V4h11',
    drag: 'M9 5a1 1 0 1 0 0 2 1 1 0 0 0 0-2M15 5a1 1 0 1 0 0 2 1 1 0 0 0 0-2M9 11a1 1 0 1 0 0 2 1 1 0 0 0 0-2M15 11a1 1 0 1 0 0 2 1 1 0 0 0 0-2M9 17a1 1 0 1 0 0 2 1 1 0 0 0 0-2M15 17a1 1 0 1 0 0 2 1 1 0 0 0 0-2',
    'arrow-left': 'M19 12H5M12 19l-7-7 7-7',
    'arrow-right': 'M5 12h14M12 5l7 7-7 7',
    'chevron-down': 'M6 9l6 6 6-6',
    file: 'M6 3h9l4 4v14H6zM15 3v4h4',
    bell: 'M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10 21a2 2 0 0 0 4 0',
    'chevron-up': 'M6 15l6-6 6 6',
    'arrow-up': 'M12 19V5M5 12l7-7 7 7',
    'arrow-down': 'M12 5v14M5 12l7 7 7-7',
    more: 'M5 11a1 1 0 1 0 0 2 1 1 0 0 0 0-2M12 11a1 1 0 1 0 0 2 1 1 0 0 0 0-2M19 11a1 1 0 1 0 0 2 1 1 0 0 0 0-2',
    move: 'M5 9l-3 3 3 3M9 5l3-3 3 3M15 19l-3 3-3-3M19 9l3 3-3 3M2 12h20M12 2v20'
  };
  var SVG = 'http://www.w3.org/2000/svg';
  function icon(name, size) {
    var svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('class', 't-icon');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', String(size || 16));
    svg.setAttribute('height', String(size || 16));
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    var path = document.createElementNS(SVG, 'path');
    path.setAttribute('d', ICONS[name] || ICONS.info);
    svg.appendChild(path);
    return svg;
  }
  function emit(el, name, detail) { el.dispatchEvent(new CustomEvent(name, { detail: detail, bubbles: true })); }
  /** Runs `fn` once the element's children are parsed (a script in <head> sees none at connect time). */
  function whenParsed(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once: true });
    else fn();
  }
  /** A property set before the element was upgraded is kept. */
  function adopt(el, names) {
    names.forEach(function (name) {
      if (Object.prototype.hasOwnProperty.call(el, name)) { var kept = el[name]; delete el[name]; el[name] = kept; }
    });
  }

  // ---- Toasts and confirm -------------------------------------------------------
  var toastRegion;
  function toast(message, options) {
    options = options || {};
    if (!toastRegion) {
      toastRegion = h('div', { class: 't-toasts', role: 'status', 'aria-live': 'polite' });
      document.body.appendChild(toastRegion);
    }
    var el = h('div', { class: 't-toast' + (options.tone && options.tone !== 'info' ? ' ' + options.tone : ''), text: text(message) });
    toastRegion.appendChild(el);
    while (toastRegion.children.length > 3) toastRegion.removeChild(toastRegion.firstChild);
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, options.ms || 3200);
    return el;
  }
  function confirm(message, options) {
    options = options || {};
    return new Promise(function (resolve) {
      var done = false;
      var dialog = h('dialog', { class: 't-dialog', 'aria-label': text(options.title || message) });
      function finish(answer) {
        if (done) return;
        done = true;
        try { dialog.close(); } catch (_) { /* already closed */ }
        if (dialog.parentNode) dialog.parentNode.removeChild(dialog);
        resolve(answer);
      }
      var cancel = h('button', { type: 'button', class: 't-button', text: options.cancel || t('cancel'), onClick: function () { finish(false); } });
      var ok = h('button', { type: 'button', class: 't-button ' + (options.tone === 'danger' ? 'danger' : 'primary'), text: options.confirm || t('ok'), onClick: function () { finish(true); } });
      dialog.appendChild(h('div', { class: 't-dialog-body' }, h('p', { text: text(message) }), h('div', { class: 't-actions' }, cancel, ok)));
      dialog.addEventListener('close', function () { finish(false); });
      dialog.addEventListener('cancel', function (event) { event.preventDefault(); finish(false); });
      document.body.appendChild(dialog);
      try { dialog.showModal(); } catch (_) { dialog.setAttribute('open', ''); }
      cancel.focus();
    });
  }

  // ---- Forms --------------------------------------------------------------------
  function form(el) {
    var out = {};
    Array.prototype.forEach.call(el.elements, function (field) {
      if (!field.name || field.disabled) return;
      if (field.type === 'checkbox') out[field.name] = field.checked;
      else if (field.type === 'radio') { if (field.checked) out[field.name] = field.value; }
      else if (field.type === 'number' || field.type === 'range') out[field.name] = field.value === '' ? null : Number(field.value);
      else out[field.name] = field.value;
    });
    return out;
  }
  function fill(el, values) {
    values = values || {};
    Array.prototype.forEach.call(el.elements, function (field) {
      if (!field.name) return;
      var value = values[field.name];
      if (field.type === 'checkbox') field.checked = !!value;
      else if (field.type === 'radio') field.checked = field.value === text(value);
      else field.value = value === undefined || value === null ? '' : String(value);
    });
  }

  // ---- Live collections -----------------------------------------------------------
  /** Keeps `records` as the collection is, calling render on every change; stop() ends it. */
  function live(collection, render, options) {
    options = options || {};
    var state = { records: [], stop: null, ready: null, reload: null };
    var stopped = false, loading = null;
    function draw() { try { render(state.records, state); } catch (error) { setTimeout(function () { throw error; }); } }
    function failed(error) { if (options.onError) options.onError(error); else { console.error(error); toast(error && error.message ? error.message : t('error'), { tone: 'error' }); } }
    function reload() {
      if (loading) return loading;
      loading = collection.list({ where: options.where, order: options.order, limit: options.limit }).then(function (records) {
        loading = null;
        if (stopped) return state.records;
        state.records = records;
        draw();
        return records;
      }, function (error) { loading = null; failed(error); throw error; });
      return loading;
    }
    var unsubscribe = null;
    try {
      unsubscribe = collection.subscribe(function (change) {
        if (stopped) return;
        if (change.type === 'reset') { reload().catch(function () { /* said */ }); return; }
        var index = -1;
        for (var i = 0; i < state.records.length; i++) if (state.records[i].id === change.id) { index = i; break; }
        if (change.type === 'remove') { if (index >= 0) state.records.splice(index, 1); }
        else if (change.record) {
          if (index >= 0) state.records[index] = change.record;
          else if (change.type === 'insert' || change.type === 'update') state.records.push(change.record);
          if (options.where && !matches(change.record, options.where)) { var at = state.records.indexOf(change.record); if (at >= 0) state.records.splice(at, 1); }
        }
        draw();
      });
    } catch (error) { failed(error); }
    state.reload = reload;
    state.ready = reload().catch(function () { return state.records; });
    state.stop = function () { stopped = true; if (unsubscribe) unsubscribe(); };
    return state;
  }
  function matches(record, where) {
    var data = record.data || {};
    return Object.keys(where).every(function (key) {
      var want = where[key], got = data[key];
      if (want && typeof want === 'object' && Array.isArray(want.in)) return want.in.indexOf(got) >= 0;
      if (want === null) return got === null || got === undefined;
      return got === want;
    });
  }

  // ==== v2: services that touch the page (still only called from pages and elements) ===============

  // ---- Download ----------------------------------------------------------------------------
  /** Saves a Blob as a file: a temporary <a download> that is clicked (the app frame allows downloads). */
  function download(blob, filename) {
    var url = URL.createObjectURL(blob);
    var link = h('a', { href: url, download: text(filename) || 'download', hidden: true });
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  // ---- Route: #view/id ----------------------------------------------------------------------
  // One hashchange listener serves the shell and the pages, in that order, so a page's
  // route.on handler always sees <t-app> already on the right view.
  var currentApp = null, routeListeners = [], routeStarted = false, routeWaiting = [];
  function hashNow() { try { return location.hash; } catch (_) { return ''; } }
  function setHash(value) { try { location.hash = value; } catch (_) { /* a sandbox that refuses */ } }
  function routeGet() { return parseRoute(hashNow()); }
  function routeView() { return currentApp && currentApp.view ? currentApp.view : routeGet().view; }
  function routeCall(fn) { try { fn(routeGet()); } catch (error) { setTimeout(function () { throw error; }); } }
  /** #view/<id>: the same view with a record open (the id is encoded). */
  function routeOpen(id) { setHash(routeView() + '/' + encodeURIComponent(text(id))); }
  /** #view: back to the list. */
  function routeClose() { setHash(routeView()); }
  /** fn({ view, id }) on every hash change and once at start (after <t-app> showed its first view); returns a stop function. */
  function routeOn(fn) {
    routeListeners.push(fn);
    if (routeStarted) setTimeout(function () { if (routeListeners.indexOf(fn) >= 0) routeCall(fn); }, 0);
    else routeWaiting.push(fn);
    return function () {
      var at = routeListeners.indexOf(fn);
      if (at >= 0) routeListeners.splice(at, 1);
      at = routeWaiting.indexOf(fn);
      if (at >= 0) routeWaiting.splice(at, 1);
    };
  }
  /** <t-app> calls this once its first view is up; a page with no <t-app> starts when the document is parsed. */
  function routeStart() {
    if (routeStarted) return;
    routeStarted = true;
    var waiting = routeWaiting;
    routeWaiting = [];
    setTimeout(function () { waiting.forEach(function (fn) { if (routeListeners.indexOf(fn) >= 0) routeCall(fn); }); }, 0);
  }
  if (typeof window.addEventListener === 'function') {
    window.addEventListener('hashchange', function () {
      if (currentApp) currentApp._syncHash();
      routeListeners.slice().forEach(routeCall);
    });
    whenParsed(function () { setTimeout(function () { if (!document.querySelector('t-app')) routeStart(); }, 0); });
  }

  // ---- Context for the agent ----------------------------------------------------------------
  var context = { selection: null, summary: null }, contextView = '';
  function reportContext() {
    try {
      if (!window.tendly || !tendly.host || !tendly.host.framed) return;
      var payload = { view: contextView };
      if (context.selection !== null) payload.selection = context.selection;
      if (context.summary !== null) payload.summary = context.summary;
      tendly.host.setContext(payload);
    } catch (_) { /* no SDK */ }
  }
  /** Tells the agent what is on screen: { selection?, summary? }, null clears one; the view comes from <t-app>. */
  function setContext(patch) { context = mergeContext(context, patch); reportContext(); }
  /** <t-app> switched view: the old selection and summary no longer apply. */
  function resetContext(view) { context = { selection: null, summary: null }; contextView = view; reportContext(); }

  // ---- Settings -------------------------------------------------------------------------------
  /** Promise of S: S.value (defaults under the stored value), S.save(patch), S.on(fn), S.error. A save shows at once
   *  (listeners run, S.value changes) and is written with tendly.data.set; if the write fails it is taken back. */
  function settings(key, defaults) {
    var listeners = [];
    var S = { value: mergeSettings(defaults, null), error: null };
    function tell(value) { listeners.slice().forEach(function (fn) { try { fn(value); } catch (error) { setTimeout(function () { throw error; }); } }); }
    var data = window.tendly && window.tendly.data;
    S.on = function (fn) {
      listeners.push(fn);
      return function () { var at = listeners.indexOf(fn); if (at >= 0) listeners.splice(at, 1); };
    };
    S.save = function (patch) {
      var before = S.value, next = Object.assign({}, before, patch);
      if (next.v === undefined || next.v === null) next.v = 1;
      S.value = next;
      tell(next);
      if (!data || typeof data.set !== 'function') return Promise.resolve(next);
      return Promise.resolve().then(function () { return data.set(key, next); }).then(function () { return next; }, function (error) {
        if (S.value === next) { S.value = before; tell(before); }
        throw error;
      });
    };
    var loading = data && typeof data.get === 'function' ? Promise.resolve().then(function () { return data.get(key, null); }) : Promise.resolve(null);
    return loading.then(function (stored) { S.value = mergeSettings(defaults, stored); return S; }, function (error) { S.error = error; return S; });
  }

  // ==== v2.2: services that touch the page ==========================================================

  // ---- Move before delete: tkit.chooseMove --------------------------------------------------------
  /** Asks where records should go before the thing they sit in is deleted. { title, text?, options: [{ id, label }], confirm? }
   *  -> Promise of the chosen option's id, or null when cancelled (or there is nowhere to move to). A small <t-modal>. */
  function chooseMove(options) {
    options = options || {};
    var choices = Array.isArray(options.options) ? options.options : [];
    if (!choices.length) return Promise.resolve(null);
    return new Promise(function (resolve) {
      var done = false, heading = text(options.title || t('moveTo'));
      var select = h('select', { class: 't-input', 'aria-label': t('moveTo') });
      choices.forEach(function (choice) { select.appendChild(h('option', { value: text(choice.id), text: text(choice.label) })); });
      var modal = h('t-modal', { title: heading });
      function finish(answer) {
        if (done) return;
        done = true;
        try { modal.close(); } catch (_) { /* already closed */ }
        if (modal.parentNode) modal.parentNode.removeChild(modal);
        resolve(answer);
      }
      function chosen() {
        for (var i = 0; i < choices.length; i++) if (text(choices[i].id) === select.value) return choices[i].id;
        return null;
      }
      var ok = h('button', { type: 'button', class: 't-button primary', text: options.confirm || t('ok'), onClick: function () { finish(chosen()); } });
      select.addEventListener('keydown', function (event) { if (event.key === 'Enter') { event.preventDefault(); finish(chosen()); } });
      if (options.text) modal.appendChild(h('p', { text: text(options.text) }));
      modal.appendChild(h('label', { class: 't-field' }, h('span', { text: t('moveTo') }), select));
      modal.appendChild(h('div', { class: 't-actions' }, h('button', { type: 'button', class: 't-button', text: t('cancel'), onClick: function () { finish(null); } }), ok));
      modal.addEventListener('t-close', function () { finish(null); });
      document.body.appendChild(modal);
      modal.open();
    });
  }

  // ---- Dragging by a handle (the row editor and the gallery) -----------------------------------------------------
  /** Starts a drag on pointerdown. opts: handle (the element that got the event), item (the element being dragged), others()
   *  (the other items' elements, in order), axis ('y' | 'xy'), onDrop(index) (index into the others, see dropIndex). A bar shows
   *  where it will land (.t-drop-before / .t-drop-after on a neighbour). */
  function dragReorder(event, opts) {
    if (event.button || !opts.item) return;
    event.preventDefault();
    var handle = opts.handle, item = opts.item, index = null, moved = false, mark = null;
    try { handle.setPointerCapture(event.pointerId); } catch (_) { /* gone */ }
    item.classList.add('dragging');
    function unmark() { if (mark) { mark.classList.remove('t-drop-before'); mark.classList.remove('t-drop-after'); mark = null; } }
    function move(e) {
      var others = opts.others();
      var rects = others.map(function (el) { var box = el.getBoundingClientRect(); return { left: box.left, top: box.top, width: box.width, height: box.height }; });
      index = dropIndex(rects, e.clientX, e.clientY, opts.axis);
      moved = true;
      unmark();
      if (!others.length) return;
      mark = others[Math.min(index, others.length - 1)];
      mark.classList.add(index < others.length ? 't-drop-before' : 't-drop-after');
    }
    function finish(apply) {
      handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); handle.removeEventListener('pointercancel', cancel);
      item.classList.remove('dragging');
      unmark();
      if (apply && moved && index !== null) opts.onDrop(index);
    }
    var up = function () { finish(true); }, cancel = function () { finish(false); };
    handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', up); handle.addEventListener('pointercancel', cancel);
  }

  // ---- In-place cells: tkit.editCell ---------------------------------------------------------------------------------
  /** One input for one cell: { node, get(), focus(), disable(flag), wire(commit, cancel) }. */
  function cellControl(spec, current) {
    var type = spec.type || 'text', label = text(spec.label), control;
    if (type === 'score') {
      var bounds = scoreBounds(spec), name = 't-score-' + uid(), group = h('span', { class: 't-cell-stars', role: 'radiogroup', 'aria-label': label }), stars = [], inputs = [];
      var paint = function () {
        var picked = 0;
        inputs.forEach(function (input) { if (input.checked) picked = Number(input.value); });
        stars.forEach(function (star, i) { star.classList.toggle('on', bounds.min + i <= picked); });
      };
      for (var n = bounds.min; n <= bounds.max; n++) {
        var input = h('input', { type: 'radio', name: name, value: String(n), 'aria-label': tf('scoreOf', { n: n, m: bounds.max }) });
        input.checked = Number(current) === n;
        inputs.push(input);
        var star = h('label', { class: 't-star' }, input, icon('star', 22));
        stars.push(star);
        group.appendChild(star);
      }
      var clearButton = h('button', { type: 'button', class: 't-icon-button t-cell-clear', 'aria-label': t('clearValue'), title: t('clearValue') }, icon('close', 14));
      group.appendChild(clearButton);
      paint();
      control = {
        node: group,
        get: function () { var picked = ''; inputs.forEach(function (input) { if (input.checked) picked = input.value; }); return picked; },
        focus: function () { var on = null; inputs.forEach(function (input) { if (input.checked) on = input; }); (on || inputs[0]).focus(); },
        disable: function (flag) { inputs.forEach(function (input) { input.disabled = flag; }); clearButton.disabled = flag; },
        wire: function (commit) {
          group.addEventListener('change', paint);
          // A real click or tap saves at once; the arrow keys (which also "click" a radio, with detail 0) only move the choice, Enter saves.
          group.addEventListener('click', function (event) {
            if (event.target === clearButton || (event.target.closest && event.target.closest('.t-cell-clear'))) { inputs.forEach(function (input) { input.checked = false; }); paint(); commit(); }
            else if (event.target.type === 'radio' && event.detail > 0) { paint(); commit(); }
          });
        }
      };
      return control;
    }
    var field;
    if (type === 'yesno' || type === 'choice') {
      field = h('select', { class: 't-input t-cell-input', 'aria-label': label });
      var items = type === 'yesno' ? [['', '—'], ['y', t('yes')], ['n', t('no')]] : [['', '—']].concat((spec.options || []).map(function (o) { return [text(o.id), text(o.label)]; }));
      items.forEach(function (pair) { field.appendChild(h('option', { value: pair[0], text: pair[1] })); });
      field.value = type === 'yesno' ? (current === true ? 'y' : current === false ? 'n' : '') : (current === undefined || current === null ? '' : text(current));
    } else {
      field = h('input', { class: 't-input t-cell-input', type: 'text', 'aria-label': label });
      if (type === 'number' || type === 'money') field.setAttribute('inputmode', 'decimal');
      field.value = type === 'number' || type === 'money' ? (typeof current === 'number' ? String(current).replace('.', language() === 'pt' ? ',' : '.') : text(current)) : text(current);
    }
    return {
      node: field,
      get: function () { return field.value; },
      focus: function () { field.focus(); if (field.select && field.tagName === 'INPUT') field.select(); },
      disable: function (flag) { field.disabled = flag; },
      wire: function (commit) {
        if (field.tagName !== 'SELECT') return;
        // A choice made with the mouse saves at once; with the arrow keys it only moves (a closed select "changes" on every arrow).
        var typed = false;
        field.addEventListener('pointerdown', function () { typed = false; });
        field.addEventListener('keydown', function (event) { if (event.key !== 'Enter' && event.key !== 'Escape' && event.key !== 'Tab') typed = true; });
        field.addEventListener('change', function () { if (!typed) commit(); });
      }
    };
  }
  /** Makes `button` (a <button class="t-cell"> showing a value) editable in place; returns { open(), cancel(), spec }. Click or Enter
   *  swaps in the right input; Enter or leaving it saves, Esc cancels. spec = { type: 'number' | 'money' | 'score' | 'yesno' | 'text' |
   *  'choice', value, options?, currency?, min?, max?, label, format?, save: async function (value) }. save() is awaited with the
   *  new value (see cellValue); while it runs the cell is busy, on success the button shows the new text (put the value in an
   *  element with data-cell-value to keep other things inside the button), on failure the editor stays with the error. Calling
   *  it again on the same button only replaces the spec. */
  function editCell(button, spec) {
    if (!button) return null;
    if (button._tCell) { button._tCell.spec = spec || {}; return button._tCell; }
    var api = { spec: spec || {}, editing: false, busy: false, open: open, cancel: cancel };
    var wrap = null, control = null, message = null, hadFocus = false;
    function sameValue(a, b) { return (a === undefined || a === '' ? null : a) === (b === undefined || b === '' ? null : b); }
    function paint() {
      var shown = cellText(api.spec, api.spec.value), target = button.querySelector('[data-cell-value]') || button;
      target.textContent = shown;
      button.classList.toggle('empty', api.spec.value === undefined || api.spec.value === null || api.spec.value === '');
    }
    function showError(error) {
      if (!message) { message = h('small', { class: 't-error t-cell-error', role: 'alert' }); wrap.appendChild(message); }
      message.textContent = text(error);
      wrap.classList.add('error');
    }
    function clearError() {
      if (message && message.parentNode) message.parentNode.removeChild(message);
      message = null;
      if (wrap) wrap.classList.remove('error');
    }
    function close(refocus) {
      if (!api.editing) return;
      api.editing = false;
      if (wrap && wrap.parentNode) wrap.parentNode.replaceChild(button, wrap);
      wrap = null; control = null; message = null;
      paint();
      if (refocus) button.focus();
    }
    function cancel() { if (api.editing && !api.busy) close(true); }
    function commit() {
      if (!api.editing || api.busy) return;
      var spec = api.spec, parsed = cellValue(spec, control.get());
      hadFocus = !!wrap && !!document.activeElement && wrap.contains(document.activeElement);
      if (!parsed.ok) { showError(parsed.error); if (hadFocus) control.focus(); return; }
      if (sameValue(parsed.value, spec.value)) { close(hadFocus); return; }
      clearError();
      api.busy = true;
      wrap.classList.add('saving');
      wrap.setAttribute('aria-busy', 'true');
      control.disable(true);
      var spinner = h('span', { class: 't-cell-spin', role: 'status', 'aria-label': t('saving') }, icon('spinner', 14));
      wrap.appendChild(spinner);
      Promise.resolve().then(function () { return typeof spec.save === 'function' ? spec.save(parsed.value) : undefined; }).then(function () {
        spec.value = parsed.value;
        api.busy = false;
        close(hadFocus);
      }, function (error) {
        api.busy = false;
        if (!api.editing || !wrap) return;
        wrap.classList.remove('saving');
        wrap.removeAttribute('aria-busy');
        if (spinner.parentNode) spinner.parentNode.removeChild(spinner);
        control.disable(false);
        showError(error && error.message ? error.message : t('error'));
        if (hadFocus) control.focus();
      });
    }
    function open() {
      if (api.editing || !button.parentNode) return;
      api.editing = true;
      control = cellControl(api.spec, api.spec.value);
      wrap = h('span', { class: 't-cell-edit' }, control.node);
      wrap.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' && event.target.tagName !== 'BUTTON') { event.preventDefault(); commit(); }
        else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel(); }
        else if (event.key !== 'Tab' && message) clearError();
      });
      wrap.addEventListener('focusout', function (event) {
        if (api.busy || (event.relatedTarget && wrap && wrap.contains(event.relatedTarget))) return;
        setTimeout(function () { if (api.editing && !api.busy && wrap && !wrap.contains(document.activeElement)) commit(); }, 0);
      });
      control.wire(commit);
      button.parentNode.replaceChild(wrap, button);
      control.focus();
    }
    button._tCell = api;
    button.addEventListener('click', function (event) { event.preventDefault(); open(); });
    return api;
  }

  // ---- Markdown -> DOM -------------------------------------------------------------------------
  function mdInlineNodes(nodes, options) {
    var out = document.createDocumentFragment();
    nodes.forEach(function (node) {
      if (node.type === 'text') out.appendChild(document.createTextNode(node.text));
      else if (node.type === 'br') out.appendChild(document.createElement('br'));
      else if (node.type === 'code') out.appendChild(h('code', { text: node.text }));
      else if (node.type === 'strong') out.appendChild(h('strong', {}, mdInlineNodes(node.children, options)));
      else if (node.type === 'em') out.appendChild(h('em', {}, mdInlineNodes(node.children, options)));
      else if (node.type === 'link') {
        if (MD_LINK.test(node.href)) out.appendChild(h('a', { href: node.href, target: '_blank', rel: 'noopener noreferrer' }, mdInlineNodes(node.children, options)));
        else out.appendChild(mdInlineNodes(node.children, options));
      } else if (node.type === 'wikilink') {
        var href = options && typeof options.linkArticle === 'function' ? options.linkArticle(node.title) : null;
        if (href) out.appendChild(h('a', { class: 't-wikilink', href: href }, node.title));
        else {
          var missing = h('button', { type: 'button', class: 't-wikilink missing', title: tf('createWiki', { x: node.title }) }, h('span', { text: node.title }), h('small', { text: t('create') }));
          missing.addEventListener('click', function () { emit(missing, 't-wikilink', { title: node.title }); });
          out.appendChild(missing);
        }
      }
    });
    return out;
  }
  function mdListNode(list, options) {
    var el = h(list.ordered ? 'ol' : 'ul');
    if (list.ordered && list.start > 1) el.setAttribute('start', String(list.start));
    list.items.forEach(function (item) {
      var li = h('li', {}, mdInlineNodes(item.children, options));
      if (item.sub) li.appendChild(mdListNode(item.sub, options));
      el.appendChild(li);
    });
    return el;
  }
  function mdBlockNodes(blocks, options) {
    var out = document.createDocumentFragment(), base = (options && options.headingBase) || 2;
    blocks.forEach(function (block) {
      if (block.type === 'heading') {
        out.appendChild(h('h' + Math.min(6, base + block.level - 1), { class: 't-md-h' + block.level, dataset: { anchor: block.anchor } }, mdInlineNodes(block.children, options)));
      } else if (block.type === 'paragraph') out.appendChild(h('p', {}, mdInlineNodes(block.children, options)));
      else if (block.type === 'code') out.appendChild(h('pre', { class: 't-md-code' }, h('code', { text: block.text, dataset: block.lang ? { lang: block.lang } : {} })));
      else if (block.type === 'list') out.appendChild(mdListNode(block, options));
      else if (block.type === 'quote') out.appendChild(h('blockquote', {}, mdBlockNodes(block.children, options)));
      else if (block.type === 'rule') out.appendChild(document.createElement('hr'));
    });
    return out;
  }
  /** Markdown text -> a DocumentFragment of DOM nodes (never innerHTML). options.linkArticle(title) -> href | null resolves
   *  [[wiki links]]; options.headingBase (default 2) is the tag level of "#" so the page's own h1 stays the only one. */
  function markdown(src, options) { return mdBlockNodes(parseMarkdown(src), options); }

  // ---- Elements --------------------------------------------------------------------
  var elements = [];
  function define(name, cls) {
    if (!window.customElements || customElements.get(name)) return;
    customElements.define(name, cls);
    elements.push(name);
  }

  if (window.HTMLElement && window.customElements) {
    // <t-app>
    var TApp = function () { return Reflect.construct(HTMLElement, [], TApp); };
    TApp.prototype = Object.create(HTMLElement.prototype);
    TApp.prototype.constructor = TApp;
    Object.setPrototypeOf(TApp, HTMLElement);
    TApp.prototype.connectedCallback = function () {
      var self = this;
      whenParsed(function () {
        if (self._ready) return;
        self._ready = true;
        currentApp = self;
        self.addEventListener('click', function (event) {
          var button = event.target && event.target.closest ? event.target.closest('t-nav > button[data-view]') : null;
          if (button && self.contains(button)) self.view = button.dataset.view;
        });
        // The hash is "#view" or "#view/id": the view is what is before the first slash, the rest is the page's (tkit.route).
        var start = parseRoute(location.hash).view || self.getAttribute('view') || '';
        if (!start || !self._has(start)) { var first = self.querySelector('t-view'); start = first ? first.getAttribute('name') || '' : ''; }
        self._show(start, true);
        routeStart();
      });
    };
    TApp.prototype._has = function (name) {
      return Array.prototype.some.call(this.querySelectorAll('t-view'), function (view) { return view.getAttribute('name') === name; });
    };
    /** Called by the one hashchange listener: follow the address to another view, and leave the id alone. */
    TApp.prototype._syncHash = function () {
      var wanted = parseRoute(location.hash).view;
      if (!wanted || wanted === this._view || !this._has(wanted)) return;
      this._show(wanted, true); // silent: the address already says it, and keeps its "/id"
      var main = this.querySelector('.t-app-main');
      if (main) main.scrollTop = 0;
    };
    /** Re-reads the <t-view>s and nav buttons (added or removed later). Keeps the current view if it still exists, else the first. */
    TApp.prototype.refresh = function () {
      if (!this._ready) return;
      var name = this._view;
      if (!name || !this._has(name)) { var first = this.querySelector('t-view'); name = first ? first.getAttribute('name') || '' : ''; }
      if (name === this._view) this._mark(name); else this._show(name, false);
    };
    /** Active view and current nav button; returns the view's label (the nav button's text, else the name). */
    TApp.prototype._mark = function (name) {
      var label = name;
      Array.prototype.forEach.call(this.querySelectorAll('t-view'), function (view) {
        if (view.getAttribute('name') === name) view.setAttribute('active', ''); else view.removeAttribute('active');
      });
      Array.prototype.forEach.call(this.querySelectorAll('t-nav > button[data-view]'), function (button) {
        if (button.dataset.view === name) { button.setAttribute('aria-current', 'page'); label = button.textContent.trim() || name; }
        else button.removeAttribute('aria-current');
      });
      this.setAttribute('view', name);
      return label;
    };
    TApp.prototype._show = function (name, silent) {
      var self = this, label = self._mark(name);
      self._view = name;
      // Switching through the nav drops any record id from the address: "#board/abc" becomes "#table".
      if (!silent) setHash(name);
      var main = self.querySelector('.t-app-main');
      if (main && !silent) main.scrollTop = 0;
      resetContext(label); // the old selection and summary no longer apply; the new view sets its own
      emit(self, 't-view', { view: name, label: label });
    };
    Object.defineProperty(TApp.prototype, 'view', {
      get: function () { return this._view || ''; },
      set: function (name) { if (this._ready && name !== this._view) this._show(String(name), false); else if (!this._ready) this.setAttribute('view', String(name)); }
    });
    define('t-app', TApp);

    // <t-nav>: icons on its buttons
    var TNav = function () { return Reflect.construct(HTMLElement, [], TNav); };
    TNav.prototype = Object.create(HTMLElement.prototype);
    TNav.prototype.constructor = TNav;
    Object.setPrototypeOf(TNav, HTMLElement);
    TNav.prototype.connectedCallback = function () {
      var self = this;
      whenParsed(function () {
        if (!self.getAttribute('role')) self.setAttribute('role', 'navigation');
        if (self.getAttribute('label') && !self.getAttribute('aria-label')) self.setAttribute('aria-label', self.getAttribute('label'));
        self._decorate();
        // Buttons added or removed later (an app that builds its screens at run time) get their icon too.
        if (!self._observer && window.MutationObserver) {
          self._observer = new MutationObserver(function () { self._decorate(); });
          self._observer.observe(self, { childList: true });
        }
      });
    };
    TNav.prototype.disconnectedCallback = function () { if (this._observer) { this._observer.disconnect(); this._observer = null; } };
    TNav.prototype._decorate = function () {
      Array.prototype.forEach.call(this.querySelectorAll(':scope > button'), function (button) {
        if (button.dataset.iconDone) return;
        button.dataset.iconDone = '1';
        button.type = 'button';
        var label = button.textContent.trim();
        clear(button);
        if (button.dataset.icon) button.appendChild(icon(button.dataset.icon, 18));
        button.appendChild(h('span', { text: label }));
      });
      var app = this.closest ? this.closest('t-app') : null;
      if (app && app._ready && app._view !== undefined) app._mark(app._view); // a button for the current view may have just arrived
    };
    define('t-nav', TNav);

    var TView = function () { return Reflect.construct(HTMLElement, [], TView); };
    TView.prototype = Object.create(HTMLElement.prototype);
    TView.prototype.constructor = TView;
    Object.setPrototypeOf(TView, HTMLElement);
    define('t-view', TView);

    // <t-state>
    var TState = function () { return Reflect.construct(HTMLElement, [], TState); };
    TState.prototype = Object.create(HTMLElement.prototype);
    TState.prototype.constructor = TState;
    Object.setPrototypeOf(TState, HTMLElement);
    TState.observedAttributes = ['kind', 'title', 'text'];
    TState.prototype.connectedCallback = function () { this._draw(); };
    TState.prototype.attributeChangedCallback = function () { if (this.isConnected) this._draw(); };
    TState.prototype._draw = function () {
      var self = this, kind = self.getAttribute('kind') || 'empty';
      Array.prototype.forEach.call(self.querySelectorAll(':scope > .t-state-icon, :scope > .t-state-title, :scope > .t-state-text'), function (old) { self.removeChild(old); });
      var title = self.getAttribute('title'), body = self.getAttribute('text');
      if (title === null && kind !== 'empty') title = t(kind);
      if (title === null) title = t('empty');
      var glyph = kind === 'error' ? 'alert' : kind === 'loading' ? 'spinner' : 'inbox';
      var nodes = [h('div', { class: 't-state-icon' }, icon(glyph, 20)), h('h3', { class: 't-state-title', text: title })];
      if (body) nodes.push(h('p', { class: 't-state-text', text: body }));
      nodes.reverse().forEach(function (node) { self.insertBefore(node, self.firstChild); });
      if (kind === 'loading') self.setAttribute('aria-busy', 'true'); else self.removeAttribute('aria-busy');
      self.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    };
    define('t-state', TState);

    // <t-pills>
    var TPills = function () { return Reflect.construct(HTMLElement, [], TPills); };
    TPills.prototype = Object.create(HTMLElement.prototype);
    TPills.prototype.constructor = TPills;
    Object.setPrototypeOf(TPills, HTMLElement);
    TPills.prototype.connectedCallback = function () {
      var self = this;
      adopt(self, ['options', 'value']);
      self.setAttribute('role', 'radiogroup');
      if (!self._bound) {
        self._bound = true;
        self.addEventListener('click', function (event) {
          var button = event.target.closest ? event.target.closest('button[data-value]') : null;
          if (button && self.contains(button)) { self.value = button.dataset.value; emit(self, 't-change', { value: self._value }); }
        });
        self.addEventListener('keydown', function (event) {
          if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
          var buttons = Array.prototype.slice.call(self.querySelectorAll('button[data-value]'));
          var at = buttons.indexOf(document.activeElement);
          if (at < 0) return;
          event.preventDefault();
          var next = buttons[(at + (event.key === 'ArrowRight' ? 1 : buttons.length - 1)) % buttons.length];
          next.focus(); self.value = next.dataset.value; emit(self, 't-change', { value: self._value });
        });
      }
      self._draw();
    };
    TPills.prototype._draw = function () {
      var self = this;
      if (!self.isConnected) return;
      clear(self);
      (self._options || []).forEach(function (option) {
        var on = text(option.value) === text(self._value);
        var button = h('button', { type: 'button', role: 'radio', 'aria-checked': on ? 'true' : 'false', tabindex: on ? '0' : '-1', dataset: { value: text(option.value) } }, option.label);
        if (option.count !== undefined && option.count !== null) button.appendChild(h('small', { text: text(option.count) }));
        self.appendChild(button);
      });
      if (!self.querySelector('[tabindex="0"]') && self.firstChild) self.firstChild.setAttribute('tabindex', '0');
    };
    Object.defineProperty(TPills.prototype, 'options', { get: function () { return this._options || []; }, set: function (v) { this._options = Array.isArray(v) ? v : []; this._draw(); } });
    Object.defineProperty(TPills.prototype, 'value', { get: function () { return this._value; }, set: function (v) { this._value = v; this._draw(); } });
    define('t-pills', TPills);

    // <t-modal>
    var TModal = function () { return Reflect.construct(HTMLElement, [], TModal); };
    TModal.prototype = Object.create(HTMLElement.prototype);
    TModal.prototype.constructor = TModal;
    Object.setPrototypeOf(TModal, HTMLElement);
    TModal.prototype.connectedCallback = function () {
      var self = this;
      whenParsed(function () {
        if (self._dialog) return;
        var dialog = h('dialog', { class: 't-dialog' });
        var title = h('h2', { text: self.getAttribute('title') || '' });
        var closeButton = h('button', { type: 'button', class: 't-icon-button', 'aria-label': t('close'), onClick: function () { self.close(); } }, icon('close', 16));
        var body = h('div', { class: 't-dialog-body' });
        while (self.firstChild) body.appendChild(self.firstChild);
        dialog.appendChild(h('div', { class: 't-dialog-head' }, title, closeButton));
        dialog.appendChild(body);
        dialog.addEventListener('close', function () { emit(self, 't-close', {}); });
        dialog.addEventListener('click', function (event) { if (event.target === dialog) self.close(); });
        self.appendChild(dialog);
        self._dialog = dialog; self._title = title;
        self.removeAttribute('title');
        if (self.hasAttribute('open')) self.open();
      });
    };
    TModal.prototype.open = function () {
      var dialog = this._dialog;
      if (!dialog) { this.setAttribute('open', ''); return; }
      if (dialog.open) return;
      try { dialog.showModal(); } catch (_) { dialog.setAttribute('open', ''); }
      var first = dialog.querySelector('.t-dialog-body input, .t-dialog-body select, .t-dialog-body textarea, .t-dialog-body button');
      if (first) first.focus();
    };
    TModal.prototype.close = function () { if (this._dialog && this._dialog.open) this._dialog.close(); };
    Object.defineProperty(TModal.prototype, 'title', { get: function () { return this._title ? this._title.textContent : this.getAttribute('title') || ''; }, set: function (v) { if (this._title) this._title.textContent = text(v); else this.setAttribute('title', text(v)); } });
    Object.defineProperty(TModal.prototype, 'opened', { get: function () { return !!(this._dialog && this._dialog.open); } });
    define('t-modal', TModal);

    // <t-table>
    var TTable = function () { return Reflect.construct(HTMLElement, [], TTable); };
    TTable.prototype = Object.create(HTMLElement.prototype);
    TTable.prototype.constructor = TTable;
    Object.setPrototypeOf(TTable, HTMLElement);
    TTable.prototype.connectedCallback = function () {
      var self = this;
      adopt(self, ['columns', 'rows', 'filter', 'footer']);
      if (!self._bound) {
        self._bound = true;
        self._query = ''; self._sort = null;
        self.addEventListener('click', function (event) {
          var head = event.target.closest ? event.target.closest('th > button[data-key]') : null;
          if (head && self.contains(head)) { self._sortBy(head.dataset.key); return; }
          var row = event.target.closest ? event.target.closest('tbody > tr[data-id]') : null;
          if (row && self.contains(row)) self._open(row.dataset.id);
        });
        self.addEventListener('keydown', function (event) {
          var row = event.target.closest ? event.target.closest('tbody > tr[data-id]') : null;
          if (!row || !self.contains(row)) return;
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); self._open(row.dataset.id); }
          else if (event.key === 'ArrowDown' && row.nextElementSibling) { event.preventDefault(); row.nextElementSibling.focus(); }
          else if (event.key === 'ArrowUp' && row.previousElementSibling) { event.preventDefault(); row.previousElementSibling.focus(); }
        });
      }
      self._draw();
    };
    TTable.prototype._open = function (id) {
      var row = (this._rows || []).filter(function (r) { return text(r.id) === id; })[0];
      if (row) emit(this, 't-open', { id: row.id, row: row });
    };
    TTable.prototype._sortBy = function (key) {
      var current = this._sort;
      this._sort = current && current.key === key ? (current.dir === 'asc' ? { key: key, dir: 'desc' } : null) : { key: key, dir: 'asc' };
      this._draw();
    };
    TTable.prototype.visible = function () {
      var self = this, rows = self._rows || [];
      if (typeof self._filter === 'function') rows = rows.filter(self._filter);
      rows = filterRows(rows, self._query, (self._columns || []).map(function (c) { return c.key; }));
      if (self._sort) rows = sortRows(rows, self._sort.key, self._sort.dir);
      return rows;
    };
    TTable.prototype._cell = function (column, row) {
      var value = row[column.key];
      if (typeof column.format === 'function') { var made = column.format(value, row); return made instanceof Node ? made : document.createTextNode(text(made)); }
      if (column.type === 'badge') return value === undefined || value === null || value === '' ? document.createTextNode('') : h('span', { class: 't-badge' + (column.tones && column.tones[value] ? ' ' + column.tones[value] : ''), text: text(value) });
      if (column.type === 'date') return document.createTextNode(date(value));
      if (column.type === 'number') return document.createTextNode(value === undefined || value === null || value === '' ? '' : number(value));
      if (column.type === 'money') return document.createTextNode(value === undefined || value === null || value === '' ? '' : money(value, column.currency));
      return document.createTextNode(text(value));
    };
    TTable.prototype._draw = function () {
      var self = this;
      if (!self.isConnected) return;
      var columns = self._columns || [], all = self._rows || [], rows = self.visible();
      var search = self._search;
      clear(self);
      if (self.hasAttribute('searchable')) {
        if (!search) {
          search = self._search = h('input', { class: 't-input', type: 'search', placeholder: t('filter'), 'aria-label': t('filter'), onInput: function () { self._query = search.value; self._drawBody(); } });
        }
        self.appendChild(h('div', { class: 't-table-tools' }, search, self._count = h('span', { class: 't-table-count', 'aria-live': 'polite' })));
      }
      var head = h('tr');
      columns.forEach(function (column) {
        var sorted = self._sort && self._sort.key === column.key;
        var th = h('th', { class: column.type === 'number' || column.type === 'money' ? 'num' : null, scope: 'col', 'aria-sort': sorted ? (self._sort.dir === 'asc' ? 'ascending' : 'descending') : 'none' });
        var button = h('button', { type: 'button', dataset: { key: column.key } }, h('span', { text: column.label || column.key }));
        if (sorted) button.appendChild(icon(self._sort.dir === 'asc' ? 'arrowUp' : 'arrowDown', 12));
        th.appendChild(button);
        head.appendChild(th);
      });
      self._body = h('tbody');
      self._table = h('table', { class: 't-table' }, h('thead', {}, head), self._body);
      self.appendChild(h('div', { class: 't-table-scroll' }, self._table));
      self._drawBody();
    };
    TTable.prototype._drawBody = function () {
      var self = this, columns = self._columns || [], all = self._rows || [], rows = self.visible(), body = self._body;
      if (!body) return;
      clear(body);
      if (!rows.length) {
        body.appendChild(h('tr', {}, h('td', { colspan: String(Math.max(1, columns.length)) }, h('t-state', { kind: 'empty', title: all.length ? t('noResults') : (self.getAttribute('empty-text') || t('empty')) }))));
      }
      rows.forEach(function (row) {
        var tr = h('tr', { tabindex: '0', dataset: { id: text(row.id) } });
        columns.forEach(function (column) { tr.appendChild(h('td', { class: column.type === 'number' || column.type === 'money' ? 'num' : null }, self._cell(column, row))); });
        body.appendChild(tr);
      });
      if (self._count) self._count.textContent = rows.length === all.length ? all.length + ' ' + t('items') : rows.length + ' ' + t('of') + ' ' + all.length;
      // The footer sums what is shown (filtered and searched), and is rebuilt with the body so sorting keeps it.
      var table = self._table, old = table ? table.querySelector('tfoot') : null;
      if (old) old.parentNode.removeChild(old);
      if (table && self._footer && rows.length) {
        var foot = h('tr');
        tableFooter(columns, self._footer, rows).forEach(function (cell) {
          var td = h('td', { class: cell.num ? 'num' : null });
          if (cell.value instanceof Node) td.appendChild(cell.value); else td.textContent = text(cell.value);
          foot.appendChild(td);
        });
        table.appendChild(h('tfoot', {}, foot));
      }
    };
    Object.defineProperty(TTable.prototype, 'columns', { get: function () { return this._columns || []; }, set: function (v) { this._columns = Array.isArray(v) ? v : []; this._draw(); } });
    Object.defineProperty(TTable.prototype, 'rows', { get: function () { return this._rows || []; }, set: function (v) { this._rows = Array.isArray(v) ? v : []; this._drawBody(); if (!this._body) this._draw(); } });
    Object.defineProperty(TTable.prototype, 'footer', { get: function () { return this._footer || null; }, set: function (v) { this._footer = isPlain(v) ? v : null; this._drawBody(); } });
    Object.defineProperty(TTable.prototype, 'filter', { get: function () { return this._filter; }, set: function (v) { this._filter = typeof v === 'function' ? v : null; this._drawBody(); } });
    define('t-table', TTable);

    // <t-kanban>
    var TKanban = function () { return Reflect.construct(HTMLElement, [], TKanban); };
    TKanban.prototype = Object.create(HTMLElement.prototype);
    TKanban.prototype.constructor = TKanban;
    Object.setPrototypeOf(TKanban, HTMLElement);
    TKanban.prototype.connectedCallback = function () {
      var self = this;
      adopt(self, ['columns', 'cards', 'columnMeta']);
      if (!self._bound) {
        self._bound = true;
        self.setAttribute('role', 'group');
        self.addEventListener('click', function (event) {
          var add = event.target.closest ? event.target.closest('button[data-add]') : null;
          if (add && self.contains(add)) { emit(self, 't-add', { column: add.dataset.add }); return; }
          var card = event.target.closest ? event.target.closest('.t-kanban-card') : null;
          if (card && self.contains(card) && !self._dragged) self._open(card.dataset.id);
          self._dragged = false;
        });
        self.addEventListener('keydown', function (event) {
          var card = event.target.closest ? event.target.closest('.t-kanban-card') : null;
          if (!card || !self.contains(card)) return;
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); self._open(card.dataset.id); return; }
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault();
            var columns = self._columns || [], item = self._find(card.dataset.id);
            if (!item) return;
            var at = columns.map(function (c) { return text(c.id); }).indexOf(text(item.column));
            var target = columns[at + (event.key === 'ArrowRight' ? 1 : -1)];
            if (target) self._move(item.id, target.id, Infinity, true);
          } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            var sibling = event.key === 'ArrowDown' ? card.nextElementSibling : card.previousElementSibling;
            if (sibling && sibling.classList.contains('t-kanban-card')) { event.preventDefault(); sibling.focus(); }
          }
        });
        self.addEventListener('pointerdown', function (event) { self._pointerDown(event); });
        self.addEventListener('touchmove', function (event) { if (self._drag && self._drag.active) event.preventDefault(); }, { passive: false });
        self._live = h('span', { class: 't-sr', 'aria-live': 'polite' });
      }
      self._draw();
    };
    TKanban.prototype._find = function (id) { return (this._cards || []).filter(function (c) { return text(c.id) === text(id); })[0]; };
    TKanban.prototype._open = function (id) { var card = this._find(id); if (card) emit(this, 't-open', { id: card.id, card: card }); };
    /** Moves the card in what the board shows, then tells the app (which saves and sets .cards again). */
    TKanban.prototype._move = function (id, to, index, focus) {
      var self = this, card = self._find(id);
      if (!card) return;
      var column = (self._columns || []).filter(function (c) { return text(c.id) === text(to); })[0];
      if (!column) return;
      var cards = (self._cards || []).filter(function (c) { return c !== card; });
      var inColumn = cards.filter(function (c) { return text(c.column) === text(to); });
      var position = Math.max(0, Math.min(index, inColumn.length));
      var before = inColumn[position];
      var at = before ? cards.indexOf(before) : cards.length;
      card.column = column.id;
      cards.splice(at, 0, card);
      self._cards = cards;
      self._draw();
      if (self._live) self._live.textContent = t('moved') + ' ' + (column.title || column.id);
      if (focus) { var el = self.querySelector('.t-kanban-card[data-id="' + text(id).replace(/"/g, '\\"') + '"]'); if (el) el.focus(); }
      emit(self, 't-move', { id: card.id, to: column.id, index: position, card: card });
    };
    TKanban.prototype._pointerDown = function (event) {
      var self = this;
      if (event.button) return;
      var card = event.target.closest ? event.target.closest('.t-kanban-card') : null;
      if (!card || !self.contains(card) || event.target.closest('button, a, input, textarea, select')) return;
      var drag = self._drag = { card: card, id: card.dataset.id, x: event.clientX, y: event.clientY, active: false, pointer: event.pointerId, timer: null, ghost: null, marker: null };
      var start = function () {
        if (self._drag !== drag || drag.active) return;
        drag.active = true;
        self._dragged = true;
        try { card.setPointerCapture(drag.pointer); } catch (_) { /* gone */ }
        var box = card.getBoundingClientRect();
        drag.dx = drag.x - box.left; drag.dy = drag.y - box.top;
        var ghost = card.cloneNode(true);
        ghost.classList.add('t-kanban-ghost'); ghost.removeAttribute('tabindex');
        ghost.style.width = box.width + 'px'; ghost.style.left = box.left + 'px'; ghost.style.top = box.top + 'px';
        document.body.appendChild(ghost);
        drag.ghost = ghost;
        drag.marker = h('div', { class: 't-kanban-drop' });
        card.classList.add('dragging');
      };
      if (event.pointerType === 'mouse') { /* starts on the first real movement */ }
      else drag.timer = setTimeout(start, 350);
      var move = function (e) {
        if (self._drag !== drag) return;
        var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (!drag.active) {
          var far = Math.abs(dx) > 6 || Math.abs(dy) > 6;
          if (e.pointerType === 'mouse' && far) start();
          else if (far && e.pointerType !== 'mouse') { clearTimeout(drag.timer); cleanup(); }
          if (!drag.active) return;
        }
        e.preventDefault();
        drag.ghost.style.left = (e.clientX - drag.dx) + 'px'; drag.ghost.style.top = (e.clientY - drag.dy) + 'px';
        drag.ghost.hidden = true;
        var under = document.elementFromPoint(e.clientX, e.clientY);
        drag.ghost.hidden = false;
        var column = under && under.closest ? under.closest('.t-kanban-col') : null;
        Array.prototype.forEach.call(self.querySelectorAll('.t-kanban-col.over'), function (c) { if (c !== column) c.classList.remove('over'); });
        if (drag.marker.parentNode) drag.marker.parentNode.removeChild(drag.marker);
        if (!column || !self.contains(column)) { drag.to = null; return; }
        column.classList.add('over');
        var list = column.querySelector('.t-kanban-list');
        var siblings = Array.prototype.filter.call(list.children, function (c) { return c.classList.contains('t-kanban-card') && c !== card; });
        var index = siblings.length;
        for (var i = 0; i < siblings.length; i++) { var r = siblings[i].getBoundingClientRect(); if (e.clientY < r.top + r.height / 2) { index = i; break; } }
        drag.to = column.dataset.col; drag.index = index;
        list.insertBefore(drag.marker, siblings[index] || null);
      };
      var cleanup = function () {
        clearTimeout(drag.timer);
        try { card.releasePointerCapture(drag.pointer); } catch (_) { /* fine */ }
        if (drag.ghost && drag.ghost.parentNode) drag.ghost.parentNode.removeChild(drag.ghost);
        if (drag.marker && drag.marker.parentNode) drag.marker.parentNode.removeChild(drag.marker);
        Array.prototype.forEach.call(self.querySelectorAll('.t-kanban-col.over'), function (c) { c.classList.remove('over'); });
        card.classList.remove('dragging');
        card.removeEventListener('pointermove', move); card.removeEventListener('pointerup', up); card.removeEventListener('pointercancel', cancel);
        if (self._drag === drag) self._drag = null;
      };
      var up = function () {
        var active = drag.active, to = drag.to, index = drag.index;
        cleanup();
        if (active && to !== null && to !== undefined) self._move(drag.id, to, index, false);
        if (!active) self._dragged = false;
      };
      var cancel = function () { cleanup(); };
      card.addEventListener('pointermove', move); card.addEventListener('pointerup', up); card.addEventListener('pointercancel', cancel);
    };
    TKanban.prototype._draw = function () {
      var self = this;
      if (!self.isConnected) return;
      clear(self);
      var cards = self._cards || [];
      (self._columns || []).forEach(function (column) {
        var mine = cards.filter(function (c) { return text(c.column) === text(column.id); });
        var head = h('div', { class: 't-kanban-head' }, h('span', { text: column.title || column.id }), h('span', { class: 't-badge', text: String(mine.length) }));
        if (typeof self._columnMeta === 'function') {
          var extra = self._columnMeta(column.id, mine);
          if (extra !== undefined && extra !== null && extra !== '') head.appendChild(h('span', { class: 't-kanban-meta', text: text(extra) }));
        }
        if (self.hasAttribute('addable')) head.appendChild(h('button', { type: 'button', class: 't-icon-button', 'aria-label': t('add') + ': ' + (column.title || column.id), dataset: { add: text(column.id) } }, icon('plus', 16)));
        var list = h('div', { class: 't-kanban-list' });
        mine.forEach(function (card) {
          var el = h('article', { class: 't-kanban-card', tabindex: '0', dataset: { id: text(card.id) }, 'aria-label': text(card.title) }, h('strong', { text: text(card.title) }));
          if (card.text) el.appendChild(h('p', { text: text(card.text) }));
          if (card.meta || card.tone) {
            var meta = h('small');
            if (card.tone) meta.appendChild(h('span', { class: 't-badge ' + card.tone, text: text(card.meta || card.tone) })); else meta.textContent = text(card.meta);
            el.appendChild(meta);
          }
          list.appendChild(el);
        });
        if (!mine.length) list.appendChild(h('div', { class: 't-kanban-empty', text: self.getAttribute('empty-text') || '' }));
        self.appendChild(h('section', { class: 't-kanban-col', dataset: { col: text(column.id) }, 'aria-label': column.title || column.id }, head, list));
      });
      if (self._live) self.appendChild(self._live);
    };
    Object.defineProperty(TKanban.prototype, 'columns', { get: function () { return this._columns || []; }, set: function (v) { this._columns = Array.isArray(v) ? v : []; this._draw(); } });
    Object.defineProperty(TKanban.prototype, 'cards', { get: function () { return this._cards || []; }, set: function (v) { this._cards = Array.isArray(v) ? v.slice() : []; this._draw(); } });
    Object.defineProperty(TKanban.prototype, 'columnMeta', { get: function () { return this._columnMeta || null; }, set: function (v) { this._columnMeta = typeof v === 'function' ? v : null; this._draw(); } });
    define('t-kanban', TKanban);

    // <t-chart>
    var TChart = function () { return Reflect.construct(HTMLElement, [], TChart); };
    TChart.prototype = Object.create(HTMLElement.prototype);
    TChart.prototype.constructor = TChart;
    Object.setPrototypeOf(TChart, HTMLElement);
    TChart.observedAttributes = ['type'];
    TChart.prototype.connectedCallback = function () { adopt(this, ['data']); this._draw(); };
    TChart.prototype.attributeChangedCallback = function () { if (this.isConnected) this._draw(); };
    TChart.prototype._draw = function () {
      var self = this, data = self._data || [];
      if (!self.isConnected) return;
      clear(self);
      var W = 320, H = 160, left = 36, bottom = 24, top = 12, right = 8;
      var svg = document.createElementNS(SVG, 'svg');
      svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
      svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label', (self.getAttribute('label') || '') + (data.length ? ': ' + data.map(function (d) { return text(d.label) + ' ' + number(d.value); }).join(', ') : ''));
      // A round top for the axis (2, 5, 10, 20…), so the middle line is a number worth reading:
      // with nothing yet, 0 · 1 · 2 rather than 0 · 1 · 1.
      var top0 = data.reduce(function (m, d) { return Math.max(m, Number(d.value) || 0); }, 0);
      var mag = Math.pow(10, Math.floor(Math.log10(Math.max(top0, 1))));
      var max = [1, 2, 5, 10].map(function (k) { return k * mag; }).filter(function (v) { return v >= top0 && v >= 2; })[0] || 2 * mag;
      var plotW = W - left - right, plotH = H - top - bottom;
      function el(name, attrs) { var node = document.createElementNS(SVG, name); Object.keys(attrs).forEach(function (k) { node.setAttribute(k, String(attrs[k])); }); return node; }
      [0, 0.5, 1].forEach(function (f) {
        var y = top + plotH - plotH * f;
        svg.appendChild(el('line', { class: 't-chart-axis', x1: left, x2: W - right, y1: y, y2: y }));
        var label = el('text', { class: 't-chart-label', x: left - 6, y: y + 4, 'text-anchor': 'end' });
        label.textContent = number(max * f, Number.isInteger(max * f) ? 0 : 1);
        svg.appendChild(label);
      });
      var n = data.length, step = n ? plotW / n : plotW;
      var type = self.getAttribute('type') === 'line' ? 'line' : 'bar';
      var points = [];
      data.forEach(function (d, i) {
        var v = Math.max(0, Number(d.value) || 0), hgt = plotH * v / max;
        var cx = left + step * i + step / 2, y = top + plotH - hgt;
        if (type === 'bar') {
          var w = Math.max(4, Math.min(40, step * 0.6));
          svg.appendChild(el('rect', { class: 't-chart-bar', x: cx - w / 2, y: y, width: w, height: hgt, rx: 3 }));
        }
        points.push([cx, y]);
        if (n <= 12 || i % Math.ceil(n / 12) === 0) {
          var lab = el('text', { class: 't-chart-label', x: cx, y: H - 6, 'text-anchor': 'middle' });
          lab.textContent = text(d.label).slice(0, 10);
          svg.appendChild(lab);
        }
        if (n <= 12) { var val = el('text', { class: 't-chart-value', x: cx, y: y - 4, 'text-anchor': 'middle' }); val.textContent = number(v, 0); svg.appendChild(val); }
      });
      if (type === 'line' && points.length) {
        var path = points.map(function (p, i) { return (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join(' ');
        svg.appendChild(el('path', { class: 't-chart-area', d: path + ' L' + points[points.length - 1][0].toFixed(1) + ' ' + (top + plotH) + ' L' + points[0][0].toFixed(1) + ' ' + (top + plotH) + ' Z' }));
        svg.appendChild(el('path', { class: 't-chart-line', d: path }));
        points.forEach(function (p) { svg.appendChild(el('circle', { class: 't-chart-dot', cx: p[0], cy: p[1], r: 3 })); });
      }
      self.appendChild(svg);
    };
    Object.defineProperty(TChart.prototype, 'data', { get: function () { return this._data || []; }, set: function (v) { this._data = Array.isArray(v) ? v : []; this._draw(); } });
    define('t-chart', TChart);

    // <t-calendar>
    var TCalendar = function () { return Reflect.construct(HTMLElement, [], TCalendar); };
    TCalendar.prototype = Object.create(HTMLElement.prototype);
    TCalendar.prototype.constructor = TCalendar;
    Object.setPrototypeOf(TCalendar, HTMLElement);
    TCalendar.observedAttributes = ['month', 'hide-weekends', 'week-start'];
    TCalendar.prototype.connectedCallback = function () {
      var self = this;
      adopt(self, ['events', 'selected']);
      if (!self._bound) {
        self._bound = true;
        if (!self.getAttribute('month')) self.setAttribute('month', today().slice(0, 7));
        self.addEventListener('click', function (event) {
          var nav = event.target.closest ? event.target.closest('button[data-nav]') : null;
          if (nav && self.contains(nav)) { self._shift(nav.dataset.nav); return; }
          var chip = event.target.closest ? event.target.closest('.t-cal-event[data-id]') : null;
          if (chip && self.contains(chip)) { event.stopPropagation(); var ev = self._find(chip.dataset.id); if (ev) emit(self, 't-open', { id: ev.id, event: ev }); return; }
          var day = event.target.closest ? event.target.closest('.t-cal-day') : null;
          if (day && self.contains(day)) { self.selected = day.dataset.date; emit(self, 't-day', { date: day.dataset.date }); }
        });
      }
      self._draw();
    };
    TCalendar.prototype.attributeChangedCallback = function () { if (this.isConnected && this._bound) this._draw(); };
    TCalendar.prototype._find = function (id) { return (this._events || []).filter(function (e) { return text(e.id) === text(id); })[0]; };
    TCalendar.prototype._shift = function (how) {
      var m = this.month;
      var next = how === 'today' ? today().slice(0, 7) : (function () { var d = new Date(+m.slice(0, 4), +m.slice(5, 7) - 1 + (how === 'next' ? 1 : -1), 1); return d.getFullYear() + '-' + pad(d.getMonth() + 1); })();
      this.setAttribute('month', next);
      if (how === 'today') this.selected = today();
      emit(this, 't-month', { month: next });
    };
    TCalendar.prototype._draw = function () {
      var self = this;
      if (!self.isConnected) return;
      var m = self.month, year = +m.slice(0, 4), month = +m.slice(5, 7);
      var weekStart = Number(self.getAttribute('week-start')) || 0;
      var hide = self.hasAttribute('hide-weekends');
      var cells = hide ? weekdayGrid(year, month, weekStart) : monthGrid(year, month, weekStart);
      var byDay = groupBy(self._events || [], 'date');
      clear(self);
      var title;
      try { title = new Intl.DateTimeFormat(locale(), { month: 'long', year: 'numeric' }).format(new Date(year, month - 1, 1)); } catch (_) { title = m; }
      // Only the first letter: "Novembro de 2026", not "Novembro De 2026" (CSS capitalize does every word).
      title = String(title).charAt(0).toUpperCase() + String(title).slice(1);
      self.appendChild(h('div', { class: 't-cal-head' },
        h('strong', { text: title, 'aria-live': 'polite' }),
        h('button', { type: 'button', class: 't-button small', dataset: { nav: 'today' }, text: t('today') }),
        h('button', { type: 'button', class: 't-icon-button', 'aria-label': t('prev'), dataset: { nav: 'prev' } }, icon('chevronLeft', 16)),
        h('button', { type: 'button', class: 't-icon-button', 'aria-label': t('next'), dataset: { nav: 'next' } }, icon('chevronRight', 16))));
      var grid = h('div', { class: 't-cal-grid' + (hide ? ' five' : ''), role: 'grid' });
      for (var w = 0; w < 7; w++) {
        var name, dow = (w + weekStart) % 7;
        if (hide && (dow === 0 || dow === 6)) continue;
        try { name = new Intl.DateTimeFormat(locale(), { weekday: 'short' }).format(new Date(2024, 0, 7 + ((w + weekStart) % 7))); } catch (_) { name = String(w); }
        grid.appendChild(h('div', { class: 't-cal-weekday', role: 'columnheader', text: name.replace(/\.$/, '') }));
      }
      cells.forEach(function (cell) {
        var mine = byDay[cell.date] || [], weekend = [];
        (cell.weekend || []).forEach(function (iso) { weekend = weekend.concat(byDay[iso] || []); }); // hidden Saturday and Sunday: listed under this Friday
        var count = mine.length + weekend.length;
        var day = h('button', { type: 'button', class: 't-cal-day' + (cell.other ? ' other' : '') + (cell.today ? ' today' : ''), role: 'gridcell', dataset: { date: cell.date }, 'aria-label': date(cell.date, 'long') + (count ? ', ' + count : ''), 'aria-pressed': self._selected === cell.date ? 'true' : 'false' }, h('span', { class: 't-cal-num', text: String(cell.day) }));
        mine.slice(0, 3).forEach(function (ev) { day.appendChild(h('span', { class: 't-cal-event' + (ev.tone ? ' ' + ev.tone : ''), dataset: { id: text(ev.id) }, text: text(ev.title), title: text(ev.title) })); });
        if (mine.length > 3) day.appendChild(h('span', { class: 't-cal-more', text: '+' + (mine.length - 3) + ' ' + t('more') }));
        if (weekend.length) {
          day.appendChild(h('span', { class: 't-cal-wkend', text: t('weekendMore') }));
          weekend.slice(0, 2).forEach(function (ev) { day.appendChild(h('span', { class: 't-cal-event' + (ev.tone ? ' ' + ev.tone : ''), dataset: { id: text(ev.id) }, text: text(ev.title), title: date(ev.date) + ' · ' + text(ev.title) })); });
          if (weekend.length > 2) day.appendChild(h('span', { class: 't-cal-more', text: '+' + (weekend.length - 2) + ' ' + t('more') }));
        }
        if (count) day.appendChild(h('span', { class: 't-cal-dots' }, mine.concat(weekend).slice(0, 3).map(function () { return h('i'); })));
        grid.appendChild(day);
      });
      self.appendChild(grid);
    };
    Object.defineProperty(TCalendar.prototype, 'month', { get: function () { var m = this.getAttribute('month') || ''; return /^\d{4}-\d{2}$/.test(m) ? m : today().slice(0, 7); }, set: function (v) { this.setAttribute('month', text(v)); } });
    Object.defineProperty(TCalendar.prototype, 'events', { get: function () { return this._events || []; }, set: function (v) { this._events = Array.isArray(v) ? v : []; this._draw(); } });
    Object.defineProperty(TCalendar.prototype, 'selected', { get: function () { return this._selected; }, set: function (v) { this._selected = v ? text(v) : undefined; this._draw(); } });
    define('t-calendar', TCalendar);

    // ==== v2 elements ===============================================================================
    /** The Reflect.construct class every element here is made from (see TApp above for the long form). */
    function makeElement() {
      var Cls = function () { return Reflect.construct(HTMLElement, [], Cls); };
      Cls.prototype = Object.create(HTMLElement.prototype);
      Cls.prototype.constructor = Cls;
      Object.setPrototypeOf(Cls, HTMLElement);
      return Cls;
    }
    function sameJson(a, b) { try { return JSON.stringify(a) === JSON.stringify(b); } catch (_) { return false; } }
    function copyList(list) { return (Array.isArray(list) ? list : []).map(function (item) { return isPlain(item) ? Object.assign({}, item) : item; }); }
    function rowById(root, id) {
      var rows = root.querySelectorAll('[data-id]');
      for (var i = 0; i < rows.length; i++) if (rows[i].dataset.id === text(id)) return rows[i];
      return null;
    }
    function fileUrl(path) { try { return window.tendly && tendly.files ? tendly.files.url(path) : ''; } catch (_) { return ''; } }
    var uniqueId = 0;
    function domId(prefix) { return prefix + (++uniqueId); }
    function toneBadge(tone, label) { return h('span', { class: 't-badge' + (tone ? ' ' + tone : ''), text: text(label) }); }
    function currencySymbol(code) {
      try {
        var parts = new Intl.NumberFormat(locale(), { style: 'currency', currency: code || (language() === 'pt' ? 'BRL' : 'USD') }).formatToParts(0);
        for (var i = 0; i < parts.length; i++) if (parts[i].type === 'currency') return parts[i].value;
      } catch (_) { /* no Intl */ }
      return code || '';
    }
    function numberInputText(value) { return typeof value === 'number' ? String(value).replace('.', language() === 'pt' ? ',' : '.') : text(value); }
    function localInput(value) {
      var d = value ? new Date(value) : null;
      return d && !isNaN(d.getTime()) ? isoDate(d) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()) : '';
    }

    // ---- <t-sample-banner> -------------------------------------------------------------------------
    var TSampleBanner = makeElement();
    TSampleBanner.prototype.connectedCallback = function () {
      var self = this;
      adopt(self, ['count']);
      if (!self._bound) {
        self._bound = true;
        self.addEventListener('click', function (event) {
          var button = event.target.closest ? event.target.closest('button') : null;
          if (button && self.contains(button)) emit(self, 't-clear', {});
        });
      }
      self._draw();
    };
    TSampleBanner.prototype._draw = function () {
      var self = this, n = Number(self._count) || 0;
      if (!self.isConnected) return;
      clear(self);
      self.hidden = n <= 0;
      if (n <= 0) return;
      self.setAttribute('role', 'status');
      self.appendChild(icon('info', 16));
      self.appendChild(h('span', { class: 't-sample-text', text: plural(n, 'samplesOne', 'samplesMany') }));
      self.appendChild(h('button', { type: 'button', class: 't-button small', text: t('clearSamples') }));
    };
    Object.defineProperty(TSampleBanner.prototype, 'count', { get: function () { return this._count || 0; }, set: function (v) { this._count = Number(v) || 0; this._draw(); } });
    define('t-sample-banner', TSampleBanner);

    // ---- <t-progress> --------------------------------------------------------------------------------
    var TProgress = makeElement();
    TProgress.observedAttributes = ['value', 'max', 'label'];
    TProgress.prototype.connectedCallback = function () { this._draw(); };
    TProgress.prototype.attributeChangedCallback = function () { if (this.isConnected) this._draw(); };
    TProgress.prototype._draw = function () {
      var self = this;
      if (!self.isConnected) return;
      var value = Math.max(0, Number(self.getAttribute('value')) || 0), max = self.hasAttribute('max') ? Math.max(0, Number(self.getAttribute('max')) || 0) : 100;
      var percent = max > 0 ? Math.min(100, value / max * 100) : 0;
      clear(self);
      self.classList.toggle('ok', max > 0 && value >= max);
      self.appendChild(h('div', { class: 't-progress-track', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(max), 'aria-valuenow': String(Math.min(value, max)), 'aria-label': self.getAttribute('label') || t('progress') },
        h('div', { class: 't-progress-fill', style: { width: percent + '%' } })));
      self.appendChild(h('span', { class: 't-progress-text', text: number(value, 0) + ' ' + t('of') + ' ' + number(max, 0) }));
    };
    ['value', 'max'].forEach(function (name) {
      Object.defineProperty(TProgress.prototype, name, { get: function () { return Number(this.getAttribute(name)) || 0; }, set: function (v) { this.setAttribute(name, String(v)); } });
    });
    define('t-progress', TProgress);

    // ---- <t-steps> -------------------------------------------------------------------------------------
    var TSteps = makeElement();
    TSteps.prototype.connectedCallback = function () { adopt(this, ['steps', 'current']); this._draw(); };
    TSteps.prototype._draw = function () {
      var self = this, steps = self._steps || [], current = Math.max(0, Math.min(steps.length - 1, Number(self._current) || 0));
      if (!self.isConnected) return;
      clear(self);
      var list = h('ol', { class: 't-steps-list' });
      steps.forEach(function (label, index) {
        var li = h('li', { class: index < current ? 'done' : index === current ? 'current' : '' }, h('span', { class: 't-steps-dot', 'aria-hidden': 'true' }, index < current ? icon('check', 12) : String(index + 1)), h('span', { class: 't-steps-label', text: text(label) }));
        if (index === current) li.setAttribute('aria-current', 'step');
        list.appendChild(li);
      });
      self.appendChild(list);
      // On a phone the row would not fit: "Step 2 of 5 · Columns" and a thin bar instead.
      self.appendChild(h('p', { class: 't-steps-compact', text: tf('stepOf', { n: current + 1, m: steps.length }) + (steps[current] ? ' · ' + steps[current] : '') }));
    };
    Object.defineProperty(TSteps.prototype, 'steps', { get: function () { return this._steps || []; }, set: function (v) { this._steps = Array.isArray(v) ? v.slice() : []; this._draw(); } });
    Object.defineProperty(TSteps.prototype, 'current', { get: function () { return this._current || 0; }, set: function (v) { this._current = Number(v) || 0; this._draw(); } });
    define('t-steps', TSteps);

    // ---- <t-gallery> ---------------------------------------------------------------------------------------
    var TGallery = makeElement();
    TGallery.observedAttributes = ['sortable', 'placeholder', 'empty-text'];
    TGallery.prototype.attributeChangedCallback = function () { if (this.isConnected && this._bound) this._draw(); };
    TGallery.prototype.connectedCallback = function () {
      var self = this;
      adopt(self, ['items', 'sortable']);
      if (!self._bound) {
        self._bound = true;
        self._live = h('span', { class: 't-sr', 'aria-live': 'polite' });
        self.addEventListener('click', function (event) {
          var button = event.target.closest ? event.target.closest('button[data-act]') : null;
          var card = event.target.closest ? event.target.closest('.t-gal-card') : null;
          if (!card || !self.contains(card)) return;
          if (button && self.contains(button)) { self._nudge(card.dataset.id, button.dataset.act === 'up' ? -1 : 1, button.dataset.act); return; }
          if (!self.sortable) self._open(card.dataset.id);
        });
        self.addEventListener('keydown', function (event) {
          var card = event.target.closest ? event.target.closest('.t-gal-card') : null;
          if (!card || !self.contains(card) || event.target !== card) return;
          if (self.sortable) {
            // Alt + arrows move the focused card earlier or later; a plain arrow is left to the page.
            var earlier = event.key === 'ArrowUp' || event.key === 'ArrowLeft', later = event.key === 'ArrowDown' || event.key === 'ArrowRight';
            if (event.altKey && (earlier || later)) { event.preventDefault(); self._nudge(card.dataset.id, earlier ? -1 : 1, earlier ? 'up' : 'down', true); }
          } else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); self._open(card.dataset.id); }
        });
        self.addEventListener('pointerdown', function (event) {
          var handle = event.target.closest ? event.target.closest('.t-gal-handle') : null;
          var card = handle ? handle.closest('.t-gal-card') : null;
          if (!handle || !card || !self.contains(card) || !self.sortable) return;
          var id = card.dataset.id;
          dragReorder(event, {
            handle: handle, item: card, axis: 'xy',
            others: function () { return Array.prototype.filter.call(self.querySelectorAll('.t-gal-card'), function (c) { return c !== card; }); },
            onDrop: function (index) {
              var ids = Array.prototype.filter.call(self.querySelectorAll('.t-gal-card'), function (c) { return c !== card; }).map(function (c) { return c.dataset.id; });
              ids.splice(index, 0, id);
              self._apply(ids, id);
            }
          });
        });
      }
      self._draw();
    };
    TGallery.prototype._open = function (id) {
      var item = (this._items || []).filter(function (i) { return text(i.id) === text(id); })[0];
      if (item) emit(this, 't-open', { id: item.id, item: item });
    };
    /** Puts the cards in the order of `ids` at once and tells the page (which sets .items again, or not). */
    TGallery.prototype._apply = function (ids, movedId, act) {
      var self = this, items = self._items || [], before = items.map(function (i) { return text(i.id); });
      if (sameJson(ids.map(text), before)) return;
      self._items = ids.map(function (id) { return items.filter(function (i) { return text(i.id) === text(id); })[0]; });
      self._live.textContent = tf('movedTo', { n: ids.map(text).indexOf(text(movedId)) + 1, m: ids.length });
      self._draw();
      if (act) {
        var card = rowById(self, movedId), button = card ? card.querySelector('button[data-act="' + act + '"]:not(:disabled)') || card.querySelector('button[data-act]:not(:disabled)') : null;
        if (button) button.focus();
      }
      emit(self, 't-reorder', { ids: ids.slice() });
    };
    TGallery.prototype._nudge = function (id, delta, act, keepCardFocus) {
      var ids = (this._items || []).map(function (i) { return i.id; }), at = ids.map(text).indexOf(text(id));
      if (at < 0) return;
      this._apply(moveId(ids, id, at + delta), id, act);
      if (keepCardFocus) { var card = rowById(this, id); if (card) card.focus(); }
    };
    TGallery.prototype._draw = function () {
      var self = this, items = self._items || [], sortable = self.sortable, letters = self.getAttribute('placeholder') === 'letter';
      if (!self.isConnected) return;
      clear(self);
      if (!items.length) { self.appendChild(h('t-state', { kind: 'empty', title: self.getAttribute('empty-text') || t('empty') })); return; }
      var grid = h('div', { class: 't-gal-grid' + (sortable ? ' sorting' : '') });
      items.forEach(function (item, index) {
        var media = h('div', { class: 't-gal-media' });
        var placeholder = function () {
          clear(media);
          media.className = 't-gal-media';
          if (letters) {
            media.className += ' letter' + (TONES.indexOf(item.tone) > 0 ? ' ' + item.tone : '');
            media.appendChild(h('span', { class: 't-gal-letter', 'aria-hidden': 'true', text: letterOf(item.title) }));
          } else media.appendChild(h('span', { class: 't-gal-empty' }, icon('image', 28)));
        };
        if (item.image) {
          var img = h('img', { src: text(item.image), alt: '', loading: 'lazy' });
          img.addEventListener('error', placeholder);
          media.appendChild(img);
        } else placeholder();
        var body = h('div', { class: 't-gal-body' }, h('strong', { class: 't-gal-title', text: text(item.title) }));
        if (item.subtitle) body.appendChild(h('span', { class: 't-gal-sub', text: text(item.subtitle) }));
        var badges = (item.badge ? [{ text: item.badge, tone: item.tone }] : []).concat(Array.isArray(item.badges) ? item.badges : []);
        if (badges.length || item.meta) {
          var foot = h('div', { class: 't-gal-foot' });
          badges.forEach(function (badge) { if (badge && badge.text !== undefined && badge.text !== null && badge.text !== '') foot.appendChild(toneBadge(badge.tone, badge.text)); });
          if (item.meta) foot.appendChild(h('small', { text: text(item.meta) }));
          body.appendChild(foot);
        }
        var card = h('article', { class: 't-gal-card' + (item.muted ? ' muted' : ''), tabindex: '0', dataset: { id: text(item.id) }, 'aria-label': text(item.title) }, media, body);
        if (sortable) {
          card.appendChild(h('div', { class: 't-gal-tools' },
            h('span', { class: 't-gal-handle', 'aria-hidden': 'true', title: t('reorder') }, icon('drag', 16)),
            h('span', { class: 't-gal-buttons' },
              h('button', { type: 'button', class: 't-icon-button', 'aria-label': t('moveUp') + ': ' + text(item.title), disabled: index === 0, dataset: { act: 'up' } }, icon('arrow-up', 14)),
              h('button', { type: 'button', class: 't-icon-button', 'aria-label': t('moveDown') + ': ' + text(item.title), disabled: index === items.length - 1, dataset: { act: 'down' } }, icon('arrow-down', 14)))));
        }
        grid.appendChild(card);
      });
      self.appendChild(grid);
      self.appendChild(self._live);
    };
    Object.defineProperty(TGallery.prototype, 'items', { get: function () { return this._items || []; }, set: function (v) { this._items = Array.isArray(v) ? v : []; this._draw(); } });
    Object.defineProperty(TGallery.prototype, 'sortable', { get: function () { return this.hasAttribute('sortable'); }, set: function (v) { if (v) this.setAttribute('sortable', ''); else this.removeAttribute('sortable'); } });
    define('t-gallery', TGallery);

    // ---- <t-checklist> --------------------------------------------------------------------------------------
    function doneTime(at) {
      var d = parseDate(at);
      if (!d) return '';
      try {
        var sameDay = isoDate(d) === today();
        return new Intl.DateTimeFormat(locale(), sameDay ? { hour: '2-digit', minute: '2-digit' } : { dateStyle: 'short', timeStyle: 'short' }).format(d);
      } catch (_) { return ''; }
    }
    var TChecklist = makeElement();
    TChecklist.prototype.connectedCallback = function () {
      var self = this;
      adopt(self, ['items', 'readonly']);
      if (!self._bound) {
        self._bound = true;
        self.addEventListener('change', function (event) {
          var box = event.target;
          if (!box.classList || !box.classList.contains('t-check-big') || self._readonly) return;
          emit(self, 't-toggle', { id: box.closest('[data-id]').dataset.id, done: box.checked });
        });
      }
      self._draw();
    };
    TChecklist.prototype._draw = function () {
      var self = this, items = self._items || [];
      if (!self.isConnected) return;
      var focused = document.activeElement && self.contains(document.activeElement) && document.activeElement.closest ? document.activeElement.closest('[data-id]') : null;
      var focusId = focused ? focused.dataset.id : null;
      clear(self);
      var done = items.filter(function (i) { return i.done; }).length;
      self.appendChild(h('t-progress', { value: String(done), max: String(items.length) }));
      var list = h('ul', { class: 't-check-list' });
      items.forEach(function (item) {
        var box = h('input', { type: 'checkbox', class: 't-check-big', checked: !!item.done, disabled: !!self._readonly });
        var body = h('span', { class: 't-check-body' }, h('span', { class: 't-check-label', text: text(item.label) }));
        if (item.required) body.appendChild(h('span', { class: 't-badge warn', text: t('required') }));
        if (item.note) body.appendChild(h('small', { class: 't-check-note', text: text(item.note) }));
        if (item.done && (item.by || item.at)) {
          var when = doneTime(item.at);
          body.appendChild(h('small', { class: 't-check-by', text: item.by ? tf('doneBy', { by: item.by, at: when }) : tf('doneAt', { at: when }) }));
        }
        list.appendChild(h('li', { dataset: { id: text(item.id) } }, h('label', { class: 't-check-item' + (item.done ? ' done' : '') }, box, body)));
      });
      self.appendChild(list);
      if (focusId !== null) { var again = rowById(self, focusId); if (again) { var input = again.querySelector('input'); if (input) input.focus(); } }
    };
    Object.defineProperty(TChecklist.prototype, 'items', { get: function () { return this._items || []; }, set: function (v) { this._items = Array.isArray(v) ? v : []; this._draw(); } });
    Object.defineProperty(TChecklist.prototype, 'readonly', { get: function () { return !!this._readonly; }, set: function (v) { this._readonly = !!v; this._draw(); } });
    define('t-checklist', TChecklist);

    // ---- <t-record-form> ---------------------------------------------------------------------------------------
    /** One control for one field: { kind, node, input?, get(), focus(), finish?() }. */
    function fileControl(field, value, id) {
      var isImage = field.type === 'image';
      var state = { value: isPlain(value) && value.path !== undefined ? value : null, file: null, preview: '' };
      var box = h('div', { class: 't-file' });
      var picker = h('input', { type: 'file', id: id, hidden: true, accept: isImage ? 'image/png,image/jpeg,image/gif,image/webp,image/avif' : 'application/pdf' });
      var control = { kind: 'single', node: box, input: null };
      function changed() { box.dispatchEvent(new Event('input', { bubbles: true })); }
      function draw() {
        if (state.preview) { try { URL.revokeObjectURL(state.preview); } catch (_) { /* gone */ } state.preview = ''; }
        clear(box);
        box.appendChild(picker);
        var name = state.file ? state.file.name : state.value ? text(state.value.name || basename(state.value.path)) : '';
        var thumb = h('div', { class: 't-file-thumb' });
        var src = '';
        if (isImage && state.file) { state.preview = URL.createObjectURL(state.file); src = state.preview; }
        else if (isImage && state.value) src = fileUrl(state.value.path);
        thumb.appendChild(src ? h('img', { src: src, alt: '' }) : icon(isImage ? 'image' : 'file', 20));
        box.appendChild(thumb);
        box.appendChild(h('span', { class: 't-file-name', text: name || t('noFile') }));
        control.focusTarget = h('button', { type: 'button', class: 't-button small', text: name ? t('changeFile') : t(isImage ? 'chooseImage' : 'choosePdf'), onClick: function () { picker.click(); } });
        box.appendChild(control.focusTarget);
        if (name) box.appendChild(h('button', { type: 'button', class: 't-button small ghost', text: t('remove'), onClick: function () { state.file = null; state.value = null; draw(); changed(); } }));
      }
      picker.addEventListener('change', function () {
        var file = picker.files && picker.files[0];
        picker.value = '';
        if (!file) return;
        if (file.size > 20 * 1024 * 1024) { toast(t('fileTooBig'), { tone: 'error' }); return; }
        state.file = file; draw(); changed();
      });
      control.get = function () { return state.file ? { path: '', name: state.file.name, type: state.file.type } : state.value; };
      control.focus = function () { if (control.focusTarget) control.focusTarget.focus(); };
      /** Uploads a file picked but not yet sent; resolves the value to store. */
      control.finish = function () {
        if (!state.file) return Promise.resolve(state.value);
        if (!window.tendly || !tendly.files) return Promise.reject(new Error(t('error')));
        var file = state.file;
        return tendly.files.upload(file, { name: file.name }).then(function (done) {
          state.value = { path: done.path, name: done.name || file.name, type: done.type || file.type };
          state.file = null; draw();
          return state.value;
        });
      };
      draw();
      return control;
    }
    var NEW_OPTION = '\u0001new';
    /** A small input that takes the place of `slot` until Enter (confirm) or Esc (cancel); done(label) gets '' on cancel. */
    function askOptionName(slot, done) {
      var finished = false;
      var input = h('input', { class: 't-input t-new-option', type: 'text', maxlength: '80', autocomplete: 'off', placeholder: t('newOptionName'), 'aria-label': t('newOptionName') });
      function finish(label) {
        if (finished) return;
        finished = true;
        done(label);
      }
      input.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); finish(input.value.trim()); }
        else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(''); } // not the dialog's Esc
      });
      input.addEventListener('blur', function () { finish(input.value.trim()); });
      slot.parentNode.replaceChild(input, slot);
      input.focus();
      return input;
    }
    function recordControl(field, value, settings, hooks) {
      var id = domId('tf'), type = field.type, c;
      var placeholder = field.placeholder ? text(field.placeholder) : null;
      function textInput(extra) {
        var input = h('input', Object.assign({ class: 't-input', type: 'text', id: id, placeholder: placeholder, autocomplete: 'off' }, extra || {}));
        return input;
      }
      if (type === 'longtext') {
        var area = h('textarea', { class: 't-input', id: id, rows: '4', placeholder: placeholder });
        area.value = text(value);
        c = { kind: 'single', node: area, input: area, get: function () { return area.value; }, focus: function () { area.focus(); } };
      } else if (type === 'choice') {
        var select = h('select', { class: 't-input', id: id });
        var options = (field.options || []).slice(), previous = emptyValue(value) ? '' : (findOption(field, value) ? findOption(field, value).id : text(value));
        var fillSelect = function (selected) {
          clear(select);
          if (!field.required) select.appendChild(h('option', { value: '', text: '' }));
          else if (emptyValue(selected)) select.appendChild(h('option', { value: '', text: t('choose'), disabled: true }));
          options.forEach(function (o) { select.appendChild(h('option', { value: text(o.id), text: text(o.label) })); });
          if (!emptyValue(selected) && !findOption({ options: options }, selected)) select.appendChild(h('option', { value: text(selected), text: text(selected) + ' ' + t('removedOption') }));
          if (field.creatable) select.appendChild(h('option', { value: NEW_OPTION, text: t('newOption') }));
          select.value = emptyValue(selected) ? '' : (findOption({ options: options }, selected) ? findOption({ options: options }, selected).id : text(selected));
        };
        fillSelect(previous);
        c = { kind: 'single', node: select, input: select, get: function () { return select.value === NEW_OPTION ? previous : select.value; }, focus: function () { select.focus(); } };
        if (field.creatable) select.addEventListener('change', function () {
          if (select.value !== NEW_OPTION) { previous = select.value; return; }
          var slotParent = select.parentNode;
          askOptionName(select, function (label) {
            var existing = label ? findOption({ options: options }, label) : null, option = existing;
            if (label && !existing) {
              option = { id: slug(label, options.map(function (o) { return text(o.id); })), label: label };
              options.push(option);
              if (hooks && hooks.optionAdded) hooks.optionAdded(option);
            }
            if (option) previous = option.id;
            fillSelect(previous);
            var typed = slotParent.querySelector('.t-new-option');
            if (typed) slotParent.replaceChild(select, typed); else slotParent.appendChild(select);
            select.focus();
            if (option) select.dispatchEvent(new Event('input', { bubbles: true }));
          });
        });
      } else if (type === 'multi') {
        var group = h('div', { class: 't-check-group' });
        var chosen = Array.isArray(value) ? value.map(text) : emptyValue(value) ? [] : [text(value)];
        var known = (field.options || []).map(function (o) { return { id: text(o.id), label: text(o.label) }; });
        chosen.forEach(function (v) { if (!known.some(function (k) { return k.id === v; })) known.push({ id: v, label: v + ' ' + t('removedOption') }); });
        var adder = null;
        var addCheck = function (o, on) {
          var box = h('input', { type: 'checkbox', value: o.id, checked: on });
          var line = h('label', { class: 't-check' }, box, h('span', { text: o.label }));
          if (adder) group.insertBefore(line, adder); else group.appendChild(line);
          return box;
        };
        known.forEach(function (o) { addCheck(o, chosen.indexOf(o.id) >= 0); });
        if (field.creatable) {
          adder = h('button', { type: 'button', class: 't-button small ghost t-new-option-button', text: t('newOption') });
          adder.addEventListener('click', function () {
            askOptionName(adder, function (label) {
              var typed = group.querySelector('.t-new-option');
              if (typed) group.replaceChild(adder, typed); // the button is back first: new boxes go before it
              var existing = label ? known.filter(function (k) { return k.id === label || normalize(k.label) === normalize(label); })[0] : null, focusBox = null;
              if (existing) {
                Array.prototype.forEach.call(group.querySelectorAll('input[type="checkbox"]'), function (i) { if (i.value === existing.id) { i.checked = true; focusBox = i; } });
              } else if (label) {
                var option = { id: slug(label, known.map(function (k) { return k.id; })), label: label };
                known.push({ id: option.id, label: option.label });
                focusBox = addCheck(option, true);
                if (hooks && hooks.optionAdded) hooks.optionAdded(option);
              }
              (focusBox || adder).focus();
              if (label) adder.dispatchEvent(new Event('input', { bubbles: true }));
            });
          });
          group.appendChild(adder);
        }
        c = { kind: 'fieldset', node: group, get: function () { return Array.prototype.filter.call(group.querySelectorAll('input[type="checkbox"]'), function (i) { return i.checked; }).map(function (i) { return i.value; }); }, focus: function () { var first = group.querySelector('input[type="checkbox"]'); if (first) first.focus(); else if (adder) adder.focus(); } };
      } else if (type === 'checkbox') {
        var box = h('input', { type: 'checkbox', class: 't-switch', id: id, checked: value === true });
        c = { kind: 'inline', node: h('label', { class: 't-switch-line', for: id }, box, h('span', { text: text(field.label) }, field.required ? h('i', { class: 't-req', 'aria-hidden': 'true', text: ' *' }) : null)), input: box, get: function () { return box.checked; }, focus: function () { box.focus(); } };
      } else if (type === 'image' || type === 'file') {
        c = fileControl(field, value, id);
      } else {
        var input;
        if (type === 'number' || type === 'money') input = textInput({ inputmode: 'decimal' });
        else if (type === 'date') input = h('input', { class: 't-input', type: 'date', id: id });
        else if (type === 'datetime') input = h('input', { class: 't-input', type: 'datetime-local', id: id });
        else if (type === 'time') input = h('input', { class: 't-input', type: 'time', id: id });
        else if (type === 'email') input = textInput({ inputmode: 'email', autocomplete: 'email', autocapitalize: 'off' });
        else if (type === 'url') input = textInput({ inputmode: 'url', autocapitalize: 'off', placeholder: placeholder || 'https://' });
        else if (type === 'phone') input = textInput({ inputmode: 'tel', autocomplete: 'tel' });
        else input = textInput();
        input.value = type === 'number' || type === 'money' ? numberInputText(value) : type === 'date' ? (normalizeDate(value) || '') : type === 'time' ? (normalizeTime(value) || '') : type === 'datetime' ? localInput(value) : text(value);
        var node = input;
        if (type === 'money') node = h('div', { class: 't-input-group' }, h('span', { class: 't-input-prefix', text: currencySymbol(field.currency || (settings && settings.currency)), 'aria-hidden': 'true' }), input);
        c = { kind: 'single', node: node, input: input, get: function () { return input.value; }, focus: function () { input.focus(); } };
      }
      var help = field.help ? h('small', { class: 't-help', id: id + 'h', text: text(field.help) }) : null;
      var error = h('small', { class: 't-error', id: id + 'e', hidden: true, 'aria-live': 'polite' });
      var described = (help ? id + 'h ' : '') + id + 'e';
      if (c.input) { c.input.setAttribute('aria-describedby', described); if (field.required) c.input.setAttribute('aria-required', 'true'); }
      var label = [text(field.label), field.required ? h('i', { class: 't-req', 'aria-hidden': 'true', text: ' *' }) : null];
      if (c.kind === 'fieldset') c.root = h('fieldset', { class: 't-field t-fieldset', dataset: { field: field.id }, 'aria-describedby': described }, h('legend', {}, label), c.node, help, error);
      else if (c.kind === 'inline') c.root = h('div', { class: 't-field', dataset: { field: field.id } }, c.node, help, error);
      else c.root = h('div', { class: 't-field', dataset: { field: field.id } }, h('label', { for: id }, label), c.node, help, error);
      c.setError = function (message) {
        error.textContent = message || '';
        error.hidden = !message;
        if (c.input) { if (message) c.input.setAttribute('aria-invalid', 'true'); else c.input.removeAttribute('aria-invalid'); }
      };
      return c;
    }

    var TRecordForm = makeElement();
    TRecordForm.prototype.connectedCallback = function () {
      var self = this;
      adopt(self, ['fields', 'value', 'settings']);
      if (!self._bound) {
        self._bound = true;
        self.addEventListener('input', function (event) {
          var row = event.target.closest ? event.target.closest('[data-field]') : null;
          if (row && self._controls && self._controls[row.dataset.field]) self._controls[row.dataset.field].setError('');
          self._refresh();
          emit(self, 't-input', { field: row ? row.dataset.field : null });
        });
      }
      self._draw();
    };
    TRecordForm.prototype._draw = function () {
      var self = this;
      if (!self.isConnected) return;
      var value = self._value || {};
      clear(self);
      self._controls = {}; self._outputs = {};
      (self._fields || []).forEach(function (field) {
        if (field.type === 'formula') {
          var output = h('output', { class: 't-computed' });
          self._outputs[field.id] = output;
          self.appendChild(h('div', { class: 't-field', dataset: { field: field.id } }, h('span', { text: text(field.label) }), output, field.help ? h('small', { class: 't-help', text: text(field.help) }) : null));
        } else {
          var control = recordControl(field, value[field.id], self._settings, { optionAdded: function (option) { self._optionAdded(field.id, option); } });
          self._controls[field.id] = control;
          self.appendChild(control.root);
        }
      });
      self._refresh();
    };
    /** A "New option…" was typed in a creatable choice: keep it in this form's field and tell the page, which saves it. */
    TRecordForm.prototype._optionAdded = function (fieldId, option) {
      var self = this;
      self._fields = (self._fields || []).map(function (f) { return f.id === fieldId ? Object.assign({}, f, { options: (f.options || []).concat([Object.assign({}, option)]) }) : f; });
      // The page will set .fields to what it saved: for a little while that must not wipe what is being typed.
      var echo = self._echo = {};
      setTimeout(function () { if (self._echo === echo) self._echo = null; }, 3000);
      emit(self, 't-option-added', { fieldId: fieldId, option: Object.assign({}, option) });
    };
    /** The values as they stand now, normalized; a file waiting to be uploaded shows as its name. */
    TRecordForm.prototype._collect = function () {
      var self = this, out = {};
      (self._fields || []).forEach(function (field) {
        var control = self._controls && self._controls[field.id];
        if (control) out[field.id] = fieldValue(field, control.get());
      });
      return out;
    };
    /** Formula fields follow what is typed. */
    TRecordForm.prototype._refresh = function () {
      var self = this, fields = self._fields || [];
      if (!fields.some(function (f) { return f.type === 'formula'; })) return;
      var computed = compute(fields, Object.assign({}, self._value, self._collect()));
      fields.forEach(function (field) {
        var output = self._outputs && self._outputs[field.id];
        if (!output) return;
        output.textContent = fieldText(field, computed[field.id], self._settings);
        if (computed._errors[field.id]) output.setAttribute('title', computed._errors[field.id]); else output.removeAttribute('title');
      });
    };
    /** Checks the form, shows the errors and, if all is well, uploads pending files and resolves the data to save.
     *  Rejects (code "invalid", .errors) when something is wrong; other keys of .value are kept. */
    TRecordForm.prototype.submit = function () {
      var self = this, fields = self._fields || [], data = self._collect();
      var result = validate(fields, data);
      Object.keys(self._controls || {}).forEach(function (id) { self._controls[id].setError(result.errors[id] || ''); });
      if (!result.ok) {
        var firstId = fields.map(function (f) { return f.id; }).filter(function (id) { return result.errors[id]; })[0];
        if (self._controls[firstId]) self._controls[firstId].focus();
        var invalid = new Error(result.errors[firstId]);
        invalid.code = 'invalid'; invalid.errors = result.errors;
        return Promise.reject(invalid);
      }
      var chain = Promise.resolve();
      fields.forEach(function (field) {
        var control = self._controls[field.id];
        if (control && control.finish) chain = chain.then(function () { return control.finish(); }).then(function (stored) { data[field.id] = stored ? fieldValue(field, stored) : null; });
      });
      return chain.then(function () {
        var out = Object.assign({}, self._value, data);
        fields.forEach(function (field) { if (field.type === 'formula') delete out[field.id]; });
        return out;
      });
    };
    TRecordForm.prototype.focus = function () {
      var first = this._fields && this._fields.filter(function (f) { return f.type !== 'formula'; })[0];
      if (first && this._controls[first.id]) this._controls[first.id].focus();
    };
    Object.defineProperty(TRecordForm.prototype, 'fields', { get: function () { return this._fields || []; }, set: function (v) {
      var next = Array.isArray(v) ? v : [], echo = this._echo;
      this._echo = null;
      if (echo && this._controls) {
        if (sameJson(next, this._fields)) { this._fields = next; return; } // the page saved the option just added: nothing changes
        var typed = this._collect();
        next.forEach(function (f) { if (f.type === 'image' || f.type === 'file') delete typed[f.id]; });
        this._value = Object.assign({}, this._value, typed); // some other change came with it: redraw, but keep what was typed
      }
      this._fields = next; this._draw();
    } });
    Object.defineProperty(TRecordForm.prototype, 'value', { get: function () { return this._value || {}; }, set: function (v) { this._echo = null; this._value = isPlain(v) ? Object.assign({}, v) : {}; this._draw(); } });
    Object.defineProperty(TRecordForm.prototype, 'settings', { get: function () { return this._settings || {}; }, set: function (v) { this._settings = isPlain(v) ? v : {}; this._draw(); } });
    define('t-record-form', TRecordForm);

    // ---- <t-list-editor> ---------------------------------------------------------------------------------------------
    function tonePicker(current) {
      var group = h('div', { class: 't-swatches', role: 'group', 'aria-label': t('color') });
      TONES.forEach(function (tone) {
        group.appendChild(h('button', { type: 'button', class: 't-swatch' + (tone ? ' ' + tone : ''), 'aria-label': t('tone_' + (tone || 'none')), 'aria-pressed': (current || '') === tone ? 'true' : 'false', title: t('tone_' + (tone || 'none')), dataset: { act: 'tone', tone: tone } }));
      });
      return group;
    }
    var TListEditor = makeElement();
    TListEditor.prototype.connectedCallback = function () {
      var self = this;
      adopt(self, ['items', 'addLabel', 'inUse', 'beforeRemove']);
      if (!self._bound) {
        self._bound = true;
        self._live = h('span', { class: 't-sr', 'aria-live': 'polite' });
        self.addEventListener('change', function (event) {
          var input = event.target, row = input.closest ? input.closest('[data-id]') : null;
          if (row && input.classList.contains('t-le-label')) self._rename(row.dataset.id, input.value);
        });
        self.addEventListener('keydown', function (event) {
          if (event.key !== 'Enter') return;
          var target = event.target, row = target.closest ? target.closest('[data-id]') : null;
          if (target.classList && target.classList.contains('t-le-label') && row) { event.preventDefault(); self._rename(row.dataset.id, target.value); }
          else if (target.classList && target.classList.contains('t-le-add-input')) { event.preventDefault(); self._add(); }
        });
        self.addEventListener('click', function (event) {
          var button = event.target.closest ? event.target.closest('button[data-act]') : null;
          if (!button || !self.contains(button)) return;
          var row = button.closest('[data-id]'), id = row ? row.dataset.id : null, act = button.dataset.act;
          if (act === 'up') self._move(id, -1, 'up');
          else if (act === 'down') self._move(id, 1, 'down');
          else if (act === 'delete') self._remove(id);
          else if (act === 'tone') self._tone(id, button.dataset.tone);
          else if (act === 'add') self._add();
        });
        self.addEventListener('pointerdown', function (event) {
          var handle = event.target.closest ? event.target.closest('.t-le-handle') : null;
          if (handle && self.contains(handle)) self._drag(event, handle.closest('[data-id]'));
        });
      }
      self._draw();
    };
    TListEditor.prototype._find = function (id) { return (this._items || []).filter(function (i) { return text(i.id) === text(id); })[0]; };
    TListEditor.prototype._commit = function (items, focus) {
      var self = this;
      self._items = items;
      self._draw();
      if (focus) {
        var row = rowById(self, focus.id), button = row ? row.querySelector('button[data-act="' + focus.act + '"]:not(:disabled)') || row.querySelector('button[data-act="' + (focus.act === 'up' ? 'down' : 'up') + '"]:not(:disabled)') : null;
        if (button) button.focus();
      }
      emit(self, 't-change', { items: copyList(items) });
    };
    TListEditor.prototype._rename = function (id, value) {
      var item = this._find(id), label = text(value).trim();
      if (!item) return;
      var row = rowById(this, id), input = row ? row.querySelector('.t-le-label') : null;
      if (!label) { if (input) input.value = text(item.label); return; } // a name is needed: keep the old one
      if (label === item.label) return;
      var hadFocus = !!input && document.activeElement === input; // Enter commits and keeps typing where it was
      this._commit(this._items.map(function (i) { return i === item ? Object.assign({}, i, { label: label }) : i; }));
      var again = rowById(this, id);
      if (hadFocus && again) again.querySelector('.t-le-label').focus();
    };
    TListEditor.prototype._tone = function (id, tone) {
      var item = this._find(id);
      if (!item || (item.tone || '') === tone) return;
      this._commit(this._items.map(function (i) { return i === item ? Object.assign({}, i, { tone: tone }) : i; }));
      var row = rowById(this, id), button = row ? row.querySelector('button[data-tone="' + tone + '"]') : null;
      if (button) button.focus();
    };
    TListEditor.prototype._move = function (id, delta, act) {
      var items = this._items.slice(), from = -1;
      items.forEach(function (i, n) { if (text(i.id) === text(id)) from = n; });
      var to = from + delta;
      if (from < 0 || to < 0 || to >= items.length) return;
      var moved = items.splice(from, 1)[0];
      items.splice(to, 0, moved);
      this._live.textContent = tf('movedTo', { n: to + 1, m: items.length });
      this._commit(items, { id: id, act: act });
    };
    TListEditor.prototype._remove = function (id) {
      var self = this, item = self._find(id);
      if (!item) return Promise.resolve();
      var n = Number(self._inUse && self._inUse[id]) || 0;
      // beforeRemove (the page's own question, say chooseMove) replaces the built-in warning; it runs even when nothing uses the item.
      var ask = typeof self._beforeRemove === 'function' ? Promise.resolve().then(function () { return self._beforeRemove(Object.assign({}, item), n); }).then(function (yes) { return !!yes; })
        : n > 0 ? confirm(plural(n, 'inUseOne', 'inUseMany'), { confirm: t('delete'), tone: 'danger' }) : Promise.resolve(true);
      return ask.then(function (yes) {
        if (!yes || !self._find(id)) return;
        self._commit(self._items.filter(function (i) { return text(i.id) !== text(id); }));
        var add = self.querySelector('.t-le-add-input');
        if (add) add.focus();
      });
    };
    TListEditor.prototype._add = function () {
      var self = this, input = self.querySelector('.t-le-add-input'), label = input ? input.value.trim() : '';
      if (!label) { if (input) input.focus(); return; }
      var item = { id: slug(label, self._items.map(function (i) { return text(i.id); })), label: label };
      if (self.hasAttribute('tones')) item.tone = '';
      self._commit(self._items.concat([item]));
      var fresh = self.querySelector('.t-le-add-input');
      if (fresh) fresh.focus();
    };
    /** Drag by the handle: a line shows where it will land, and the order changes when the pointer is released. */
    TListEditor.prototype._drag = function (event, row) {
      var self = this;
      if (event.button || !row) return;
      event.preventDefault();
      var handle = row.querySelector('.t-le-handle'), list = row.parentNode, marker = h('li', { class: 't-le-drop', 'aria-hidden': 'true' });
      var before = null, moved = false, id = row.dataset.id;
      try { handle.setPointerCapture(event.pointerId); } catch (_) { /* gone */ }
      row.classList.add('dragging');
      var move = function (e) {
        var rows = Array.prototype.filter.call(list.children, function (r) { return r !== row && r.dataset && r.dataset.id; });
        before = null;
        for (var i = 0; i < rows.length; i++) { var box = rows[i].getBoundingClientRect(); if (e.clientY < box.top + box.height / 2) { before = rows[i]; break; } }
        moved = true;
        list.insertBefore(marker, before);
      };
      var finish = function (apply) {
        handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); handle.removeEventListener('pointercancel', cancel);
        row.classList.remove('dragging');
        if (marker.parentNode) marker.parentNode.removeChild(marker);
        if (!apply || !moved) return;
        var items = self._items.slice(), from = -1;
        items.forEach(function (i, n) { if (text(i.id) === id) from = n; });
        var item = items.splice(from, 1)[0], to = items.length;
        if (before) items.forEach(function (i, n) { if (text(i.id) === before.dataset.id) to = n; });
        items.splice(to, 0, item);
        if (!sameJson(items.map(function (i) { return i.id; }), self._items.map(function (i) { return i.id; }))) { self._live.textContent = tf('movedTo', { n: to + 1, m: items.length }); self._commit(items); }
      };
      var up = function () { finish(true); }, cancel = function () { finish(false); };
      handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', up); handle.addEventListener('pointercancel', cancel);
    };
    TListEditor.prototype._draw = function () {
      var self = this;
      if (!self.isConnected) return;
      var items = self._items || [], tones = self.hasAttribute('tones'), counts = self._inUse || {}, addLabel = self._addLabel || t('addItem');
      clear(self);
      var list = h('ul', { class: 't-le-list' });
      items.forEach(function (item, index) {
        var n = Number(counts[item.id]) || 0;
        var row = h('li', { class: 't-le-row', dataset: { id: text(item.id) } },
          h('span', { class: 't-le-handle', 'aria-hidden': 'true', title: t('reorder') }, icon('drag', 16)),
          h('input', { class: 't-input t-le-label', type: 'text', value: text(item.label), 'aria-label': t('itemName') }));
        if (n > 0) row.appendChild(h('small', { class: 't-le-count', text: String(n), title: plural(n, 'usedOne', 'usedMany') }));
        if (tones) row.appendChild(tonePicker(item.tone));
        row.appendChild(h('span', { class: 't-le-buttons' },
          h('button', { type: 'button', class: 't-icon-button', 'aria-label': t('moveUp') + ': ' + text(item.label), disabled: index === 0, dataset: { act: 'up' } }, icon('arrowUp', 14)),
          h('button', { type: 'button', class: 't-icon-button', 'aria-label': t('moveDown') + ': ' + text(item.label), disabled: index === items.length - 1, dataset: { act: 'down' } }, icon('arrowDown', 14)),
          h('button', { type: 'button', class: 't-icon-button', 'aria-label': t('delete') + ': ' + text(item.label), dataset: { act: 'delete' } }, icon('trash', 14))));
        list.appendChild(row);
      });
      self.appendChild(list);
      self.appendChild(h('div', { class: 't-le-add' },
        h('input', { class: 't-input t-le-add-input', type: 'text', placeholder: addLabel, 'aria-label': addLabel }),
        h('button', { type: 'button', class: 't-button', dataset: { act: 'add' } }, icon('plus', 14), h('span', { text: addLabel }))));
      self.appendChild(self._live);
    };
    Object.defineProperty(TListEditor.prototype, 'items', { get: function () { return copyList(this._items); }, set: function (v) {
      var next = copyList(v);
      if (this._items && sameJson(next, this._items)) return; // the page echoing what we just told it: leave the focus alone
      this._items = next; this._draw();
    } });
    Object.defineProperty(TListEditor.prototype, 'addLabel', { get: function () { return this._addLabel || ''; }, set: function (v) { this._addLabel = text(v); this._draw(); } });
    Object.defineProperty(TListEditor.prototype, 'inUse', { get: function () { return this._inUse || {}; }, set: function (v) { this._inUse = isPlain(v) ? v : {}; this._draw(); } });
    Object.defineProperty(TListEditor.prototype, 'beforeRemove', { get: function () { return this._beforeRemove || null; }, set: function (v) { this._beforeRemove = typeof v === 'function' ? v : null; } });
    define('t-list-editor', TListEditor);

    // ---- <t-fields-editor> --------------------------------------------------------------------------------------------------
    var DETAIL_TYPES = ['choice', 'multi', 'money', 'formula'];
    var CURRENCIES = ['BRL', 'USD', 'EUR', 'GBP'];
    var TFieldsEditor = makeElement();
    TFieldsEditor.observedAttributes = ['hide-required'];
    TFieldsEditor.prototype.attributeChangedCallback = function () { if (this.isConnected && this._bound) this._draw(); };
    TFieldsEditor.prototype.connectedCallback = function () {
      var self = this;
      adopt(self, ['fields', 'inUse', 'optionsInUse', 'types', 'extra']);
      if (!self._bound) {
        self._bound = true;
        self._open = {}; self._fresh = {}; self._menu = false;
        self._live = h('span', { class: 't-sr', 'aria-live': 'polite' });
        self.addEventListener('t-change', function (event) {
          if (event.target === self) return;
          event.stopPropagation(); // from a nested <t-list-editor>: the options of one field, not the field list
          var row = event.target.closest('[data-id]');
          if (row) self._edit(row.dataset.id, { options: event.detail.items }, false);
        });
        self.addEventListener('change', function (event) {
          var el = event.target, row = el.closest ? el.closest('[data-id]') : null;
          if (!row || !self.contains(row) || el.closest('t-list-editor')) return;
          var id = row.dataset.id;
          if (el.classList.contains('t-fe-label')) self._rename(id, el.value);
          else if (el.classList.contains('t-fe-type')) self._retype(id, el.value, el);
          else if (el.dataset.act === 'required') self._edit(id, { required: el.checked }, false);
          else if (el.classList.contains('t-fe-currency')) self._edit(id, { currency: el.value || undefined }, false);
          else if (el.classList.contains('t-fe-formula')) self._edit(id, { formula: el.value.trim() }, false);
        });
        self.addEventListener('input', function (event) {
          if (event.target.classList && event.target.classList.contains('t-fe-formula')) self._checkFormula(event.target);
        });
        self.addEventListener('keydown', function (event) {
          if (event.key === 'Enter' && event.target.classList && event.target.classList.contains('t-fe-label')) { event.preventDefault(); var row = event.target.closest('[data-id]'); self._rename(row.dataset.id, event.target.value); }
        });
        self.addEventListener('click', function (event) {
          var button = event.target.closest ? event.target.closest('button[data-act]') : null;
          if (!button || !self.contains(button) || button.closest('t-list-editor')) return; // those belong to the nested editor
          var row = button.closest('[data-id]'), id = row ? row.dataset.id : null, act = button.dataset.act;
          if (act === 'up' || act === 'down') self._move(id, act === 'up' ? -1 : 1, act);
          else if (act === 'delete') self._remove(id);
          else if (act === 'toggle') { self._open[id] = !self._open[id]; self._draw(); var again = rowById(self, id); if (again) again.querySelector('[data-act="toggle"]').focus(); }
          else if (act === 'menu') { self._menu = !self._menu; self._draw(); var opener = self.querySelector('[data-act="menu"]'); if (opener) opener.focus(); }
          else if (act === 'addtype') self._addField(button.dataset.type);
          else if (act === 'chip') self._insert(button);
        });
      }
      self._draw();
    };
    TFieldsEditor.prototype._allowedTypes = function () {
      var list = this._types || (this.getAttribute('types') ? this.getAttribute('types').split(',').map(function (s) { return s.trim(); }) : FIELD_TYPES);
      return list.filter(function (type) { return FIELD_TYPES.indexOf(type) >= 0; });
    };
    TFieldsEditor.prototype._find = function (id) { return (this._fields || []).filter(function (f) { return text(f.id) === text(id); })[0]; };
    TFieldsEditor.prototype._ids = function (except) { return (this._fields || []).map(function (f) { return text(f.id); }).filter(function (id) { return id !== except; }); };
    TFieldsEditor.prototype._emit = function () { emit(this, 't-change', { fields: copyList(this._fields) }); };
    /** Changes one field. `redraw` is false when the control already shows the new state (typing must keep its focus). */
    TFieldsEditor.prototype._edit = function (id, patch, redraw) {
      var field = this._find(id);
      if (!field) return;
      Object.keys(patch).forEach(function (key) { if (patch[key] === undefined) delete field[key]; else field[key] = patch[key]; });
      if (redraw) this._draw();
      this._emit();
    };
    TFieldsEditor.prototype._referenced = function (id) {
      var pattern = new RegExp('(^|[^a-z0-9_])' + id + '([^a-z0-9_]|$)', 'i');
      return (this._fields || []).some(function (f) { return f.type === 'formula' && f.id !== id && pattern.test(text(f.formula)); });
    };
    TFieldsEditor.prototype._rename = function (id, value) {
      var field = this._find(id), label = text(value).trim(), row = rowById(this, id);
      if (!field) return;
      if (!label) { if (row) row.querySelector('.t-fe-label').value = text(field.label); return; }
      if (label === field.label) return;
      field.label = label;
      // A field added a moment ago has not been used yet: its id follows the real name instead of the placeholder one.
      if (this._fresh[id]) {
        delete this._fresh[id];
        var next = slug(label, this._ids(id));
        if (next !== id && !(Number(this._inUse && this._inUse[id]) > 0) && !this._referenced(id)) {
          field.id = next;
          if (this._open[id]) { this._open[next] = true; delete this._open[id]; }
          if (row) row.dataset.id = next;
        }
      }
      this._emit();
    };
    TFieldsEditor.prototype._retype = function (id, type, select) {
      var self = this, field = self._find(id);
      if (!field || field.type === type) return Promise.resolve();
      var n = Number(self._inUse && self._inUse[id]) || 0;
      var ask = n > 0 ? confirm(plural(n, 'typeChangeOne', 'typeChangeMany'), { confirm: t('change'), tone: 'danger' }) : Promise.resolve(true);
      return ask.then(function (yes) {
        if (!yes) { select.value = field.type; return; }
        field.type = type;
        if ((type === 'choice' || type === 'multi') && !Array.isArray(field.options)) field.options = [];
        if (type === 'formula') { field.required = false; if (field.formula === undefined) field.formula = ''; }
        if (DETAIL_TYPES.indexOf(type) >= 0) self._open[id] = true;
        self._draw();
        var again = rowById(self, id);
        if (again) again.querySelector('.t-fe-type').focus();
        self._emit();
      });
    };
    TFieldsEditor.prototype._move = function (id, delta, act) {
      var fields = this._fields, from = -1;
      fields.forEach(function (f, n) { if (text(f.id) === text(id)) from = n; });
      var to = from + delta;
      if (from < 0 || to < 0 || to >= fields.length) return;
      fields.splice(to, 0, fields.splice(from, 1)[0]);
      this._live.textContent = tf('movedTo', { n: to + 1, m: fields.length });
      this._draw();
      var row = rowById(this, id), button = row ? row.querySelector('button[data-act="' + act + '"]:not(:disabled)') || row.querySelector('button[data-act="' + (act === 'up' ? 'down' : 'up') + '"]:not(:disabled)') : null;
      if (button) button.focus();
      this._emit();
    };
    TFieldsEditor.prototype._remove = function (id) {
      var self = this, field = self._find(id);
      if (!field) return Promise.resolve();
      var n = Number(self._inUse && self._inUse[id]) || 0;
      var ask = n > 0 ? confirm(plural(n, 'fieldInUseOne', 'fieldInUseMany'), { confirm: t('delete'), tone: 'danger' }) : Promise.resolve(true);
      return ask.then(function (yes) {
        if (!yes || !self._find(id)) return;
        self._fields = self._fields.filter(function (f) { return text(f.id) !== text(id); });
        delete self._open[id]; delete self._fresh[id];
        self._draw();
        var add = self.querySelector('[data-act="menu"]');
        if (add) add.focus();
        self._emit();
      });
    };
    TFieldsEditor.prototype._addField = function (type) {
      var label = t('type_' + type), field = { id: slug(label, this._ids()), label: label, type: type };
      if (type === 'choice' || type === 'multi') field.options = [];
      if (type === 'formula') field.formula = '';
      this._fields.push(field);
      this._fresh[field.id] = true;
      if (DETAIL_TYPES.indexOf(type) >= 0) this._open[field.id] = true;
      this._menu = false;
      this._draw();
      var row = rowById(this, field.id), input = row ? row.querySelector('.t-fe-label') : null;
      if (input) { input.focus(); input.select(); }
      this._emit();
    };
    TFieldsEditor.prototype._checkFormula = function (area) {
      var row = area.closest('[data-id]'), message = row ? row.querySelector('.t-fe-formula-error') : null;
      if (!message) return;
      var result = area.value.trim() ? compileFormula(area.value, this._ids(row.dataset.id)) : { ok: true };
      message.textContent = result.ok ? '' : result.error;
      message.hidden = result.ok;
      if (result.ok) area.removeAttribute('aria-invalid'); else area.setAttribute('aria-invalid', 'true');
    };
    TFieldsEditor.prototype._insert = function (chip) {
      var row = chip.closest('[data-id]'), area = row ? row.querySelector('.t-fe-formula') : null;
      if (!area) return;
      var start = area.selectionStart === undefined ? area.value.length : area.selectionStart, end = area.selectionEnd === undefined ? start : area.selectionEnd;
      area.value = area.value.slice(0, start) + chip.dataset.name + area.value.slice(end);
      area.focus();
      area.setSelectionRange(start + chip.dataset.name.length, start + chip.dataset.name.length);
      this._checkFormula(area);
      this._edit(row.dataset.id, { formula: area.value.trim() }, false);
    };
    /** Changes a field from outside (a page's `extra` control) and tells the page, without redrawing the row: undefined removes a key. */
    TFieldsEditor.prototype.update = function (id, patch) { this._edit(id, patch || {}, false); };
    TFieldsEditor.prototype._detail = function (field, extra) {
      var self = this, box = h('div', { class: 't-fe-detail' });
      if (field.type === 'choice' || field.type === 'multi') {
        var editor = h('t-list-editor', { tones: true });
        editor.items = field.options || [];
        editor.addLabel = t('addOption');
        editor.inUse = (self._optionsInUse && self._optionsInUse[field.id]) || {};
        box.appendChild(h('div', { class: 't-field' }, h('span', { text: t('options') }), editor));
      }
      if (field.type === 'money') {
        var select = h('select', { class: 't-input t-fe-currency', 'aria-label': t('currency') }, h('option', { value: '', text: t('currencyDefault') }));
        CURRENCIES.forEach(function (code) { select.appendChild(h('option', { value: code, text: code })); });
        select.value = field.currency || '';
        box.appendChild(h('div', { class: 't-field' }, h('span', { text: t('currency') }), select));
      }
      if (field.type === 'formula') {
        var area = h('textarea', { class: 't-input t-fe-formula', rows: '2', spellcheck: 'false', autocapitalize: 'off', 'aria-label': t('formula'), placeholder: 'preco * quantidade' });
        area.value = text(field.formula);
        var error = h('small', { class: 't-error t-fe-formula-error', hidden: true, 'aria-live': 'polite' });
        var chips = h('div', { class: 't-fe-chips' }, h('small', { text: t('formulaFields') }));
        self._fields.forEach(function (other) { if (other.id !== field.id && other.type !== 'image' && other.type !== 'file') chips.appendChild(h('button', { type: 'button', class: 't-chip', title: text(other.label), dataset: { act: 'chip', name: text(other.id) }, text: text(other.id) })); });
        box.appendChild(h('div', { class: 't-field' }, h('span', { text: t('formula') }), area, error, chips, h('small', { class: 't-help', text: t('formulaFunctions') + ' ' + Object.keys(FORMULA_FUNCTIONS).join(', ') })));
        if (field.formula) setTimeout(function () { self._checkFormula(area); }, 0);
      }
      if (extra) box.appendChild(h('div', { class: 't-fe-extra' }, extra));
      return box;
    };
    TFieldsEditor.prototype._draw = function () {
      var self = this;
      if (!self.isConnected) return;
      var fields = self._fields || [], allowed = self._allowedTypes();
      clear(self);
      var list = h('ul', { class: 't-fe-list' });
      fields.forEach(function (field, index) {
        var extra = typeof self._extra === 'function' ? self._extra(Object.assign({}, field)) : null; // the page's own controls for this field
        if (!(extra instanceof Node)) extra = null;
        var hasDetail = DETAIL_TYPES.indexOf(field.type) >= 0 || !!extra;
        var open = !!self._open[field.id] && hasDetail;
        var typeSelect = h('select', { class: 't-input t-fe-type', 'aria-label': t('fieldType') });
        (allowed.indexOf(field.type) >= 0 ? allowed : allowed.concat([field.type])).forEach(function (type) { typeSelect.appendChild(h('option', { value: type, text: t('type_' + type) })); });
        typeSelect.value = field.type;
        var main = h('div', { class: 't-fe-main' },
          h('span', { class: 't-fe-move' },
            h('button', { type: 'button', class: 't-icon-button', 'aria-label': t('moveUp') + ': ' + text(field.label), disabled: index === 0, dataset: { act: 'up' } }, icon('arrowUp', 14)),
            h('button', { type: 'button', class: 't-icon-button', 'aria-label': t('moveDown') + ': ' + text(field.label), disabled: index === fields.length - 1, dataset: { act: 'down' } }, icon('arrowDown', 14))),
          h('input', { class: 't-input t-fe-label', type: 'text', value: text(field.label), 'aria-label': t('fieldName') }),
          typeSelect);
        if (field.type !== 'formula' && !self.hasAttribute('hide-required')) main.appendChild(h('label', { class: 't-fe-req' }, h('input', { type: 'checkbox', class: 't-switch', checked: !!field.required, dataset: { act: 'required' } }), h('span', { text: t('requiredToggle') })));
        if (hasDetail) main.appendChild(h('button', { type: 'button', class: 't-icon-button t-fe-toggle', 'aria-expanded': open ? 'true' : 'false', 'aria-label': t('details') + ': ' + text(field.label), dataset: { act: 'toggle' } }, icon('chevron-down', 16)));
        main.appendChild(h('button', { type: 'button', class: 't-icon-button', 'aria-label': t('delete') + ': ' + text(field.label), dataset: { act: 'delete' } }, icon('trash', 14)));
        var row = h('li', { class: 't-fe-row' + (open ? ' open' : ''), dataset: { id: text(field.id) } }, main);
        if (open) row.appendChild(self._detail(field, extra));
        list.appendChild(row);
      });
      self.appendChild(list);
      var add = h('div', { class: 't-fe-add' }, h('button', { type: 'button', class: 't-button', 'aria-expanded': self._menu ? 'true' : 'false', dataset: { act: 'menu' } }, icon('plus', 14), h('span', { text: t('addField') })));
      if (self._menu) {
        var menu = h('div', { class: 't-fe-menu', role: 'group', 'aria-label': t('fieldType') });
        allowed.forEach(function (type) { menu.appendChild(h('button', { type: 'button', class: 't-button small', dataset: { act: 'addtype', type: type }, text: t('type_' + type) })); });
        add.appendChild(menu);
      }
      self.appendChild(add);
      self.appendChild(self._live);
    };
    Object.defineProperty(TFieldsEditor.prototype, 'fields', { get: function () { return copyList(this._fields); }, set: function (v) {
      var next = copyList(v), self = this;
      if (self._fields && sameJson(next, self._fields)) return; // the page echoing what we just told it: leave the focus alone
      self._fields = next;
      var ids = next.map(function (f) { return f.id; });
      [self._open, self._fresh].forEach(function (map) { if (map) Object.keys(map).forEach(function (id) { if (ids.indexOf(id) < 0) delete map[id]; }); });
      self._draw();
    } });
    ['inUse', 'optionsInUse', 'types'].forEach(function (name) {
      Object.defineProperty(TFieldsEditor.prototype, name, { get: function () { return this['_' + name]; }, set: function (v) { this['_' + name] = v; if (name !== 'inUse') this._draw(); } });
    });
    Object.defineProperty(TFieldsEditor.prototype, 'extra', { get: function () { return this._extra || null; }, set: function (v) { this._extra = typeof v === 'function' ? v : null; this._draw(); } });
    define('t-fields-editor', TFieldsEditor);

    // ---- <t-detail> ----------------------------------------------------------------------------------------------------------------
    function detailValue(field, value, settings) {
      var type = field.type, shown = fieldText(field, value, settings);
      if (type === 'image' && isPlain(value)) {
        var src = fileUrl(value.path);
        return src ? h('img', { class: 't-detail-image', src: src, alt: text(field.label), loading: 'lazy' }) : document.createTextNode(shown);
      }
      if (type === 'file' && isPlain(value)) {
        return h('a', { href: '#', onClick: function (event) { event.preventDefault(); try { tendly.files.open(value.path); } catch (_) { toast(t('error'), { tone: 'error' }); } } }, icon('file', 14), ' ', shown);
      }
      if (type === 'url' && /^https?:\/\//i.test(text(value))) return h('a', { href: text(value), target: '_blank', rel: 'noopener noreferrer' }, shown, ' ', icon('external', 12));
      if (type === 'email' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text(value))) return h('a', { href: 'mailto:' + text(value) }, shown);
      if (type === 'phone' && /^[+\d][\d\s().-]{3,}$/.test(text(value))) return h('a', { href: 'tel:' + text(value).replace(/[^\d+]/g, '') }, shown);
      if (type === 'choice') { var option = findOption(field, value); return option ? toneBadge(option.tone, option.label) : document.createTextNode(shown); }
      if (type === 'multi') {
        var wrap = h('span', { class: 't-detail-badges' });
        (Array.isArray(value) ? value : [value]).forEach(function (id) { var o = findOption(field, id); wrap.appendChild(o ? toneBadge(o.tone, o.label) : toneBadge('', id)); });
        return wrap;
      }
      return type === 'longtext' ? h('p', { class: 't-pre', text: shown }) : document.createTextNode(shown);
    }
    var TDetail = makeElement();
    TDetail.prototype.connectedCallback = function () {
      var self = this;
      adopt(self, ['fields', 'record', 'settings', 'siblings']);
      whenParsed(function () {
        if (self._dialog) return;
        var titleId = domId('td');
        var actions = h('div', { class: 't-drawer-actions' });
        Array.prototype.slice.call(self.children).forEach(function (child) { if (child.getAttribute('slot') === 'actions') actions.appendChild(child); });
        self._prev = h('button', { type: 'button', class: 't-icon-button', 'aria-label': t('prevItem'), onClick: function () { self._go(-1); } }, icon('arrow-left', 16));
        self._next = h('button', { type: 'button', class: 't-icon-button', 'aria-label': t('nextItem'), onClick: function () { self._go(1); } }, icon('arrow-right', 16));
        self._heading = h('h2', { id: titleId });
        self._body = h('div', { class: 't-dialog-body t-detail-body' });
        var dialog = h('dialog', { class: 't-dialog t-drawer', 'aria-labelledby': titleId },
          h('div', { class: 't-dialog-head' }, self._prev, self._next, self._heading, h('button', { type: 'button', class: 't-icon-button', 'aria-label': t('close'), onClick: function () { self.close(); } }, icon('close', 16))),
          self._body,
          h('div', { class: 't-drawer-foot' }, actions));
        dialog.addEventListener('close', function () { self._closed(); });
        dialog.addEventListener('click', function (event) { if (event.target === dialog) self.close(); });
        self.appendChild(dialog);
        self._dialog = dialog;
        self._render();
        if (self._wantOpen) { self._wantOpen = false; self.open(); }
      });
    };
    /** The field that names a record: the title-field attribute, else the first text field. */
    TDetail.prototype._titleField = function () {
      var fields = this._fields || [], id = this.getAttribute('title-field');
      return fields.filter(function (f) { return f.id === id; })[0] || fields.filter(function (f) { return f.type === 'text'; })[0] || fields[0] || null;
    };
    TDetail.prototype._title = function () {
      var field = this._titleField(), record = this._record;
      if (!field || !record) return '';
      return fieldText(field, (record.data || {})[field.id], this._settings) || '—';
    };
    TDetail.prototype._selection = function () { var field = this._titleField(); return field ? text(field.label) + ': ' + this._title() : this._title(); };
    TDetail.prototype._render = function () {
      var self = this;
      if (!self._dialog) return;
      var record = self._record, fields = self._fields || [], titleField = self._titleField();
      clear(self._body);
      self._heading.textContent = self._title();
      var ids = self._siblings || [], at = record ? ids.indexOf(record.id) : -1;
      self._prev.hidden = self._next.hidden = at < 0;
      self._prev.disabled = at <= 0;
      self._next.disabled = at < 0 || at >= ids.length - 1;
      if (!record) return;
      var data = compute(fields, record.data || {});
      var list = h('dl', { class: 't-kv' });
      fields.forEach(function (field) {
        if (titleField && field.id === titleField.id) return;
        var value = data[field.id];
        if (value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length)) return;
        list.appendChild(h('div', {}, h('dt', { text: text(field.label) }), h('dd', {}, detailValue(field, value, self._settings))));
      });
      self._body.appendChild(list);
      var meta = h('p', { class: 't-muted t-detail-meta' });
      if (record.created_at) meta.appendChild(h('span', { text: t('created') + ' ' + ago(record.created_at) }));
      if (record.updated_at && record.updated_at !== record.created_at) meta.appendChild(h('span', { text: t('updated') + ' ' + ago(record.updated_at) }));
      self._body.appendChild(meta);
    };
    TDetail.prototype._go = function (delta) {
      var ids = this._siblings || [], at = this._record ? ids.indexOf(this._record.id) : -1, target = ids[at + delta];
      if (at >= 0 && target !== undefined) emit(this, 't-nav', { id: target });
    };
    /** Opens as a drawer beside the page (full screen on a phone) and puts the record in the address and the agent's context. */
    TDetail.prototype.open = function () {
      var self = this;
      if (!self._dialog) { self._wantOpen = true; return; }
      if (!self._record) return;
      if (!self._dialog.open) { try { self._dialog.showModal(); } catch (_) { self._dialog.setAttribute('open', ''); } }
      self._announce();
    };
    TDetail.prototype._announce = function () {
      var record = this._record;
      if (!record) return;
      if (routeGet().id !== text(record.id)) routeOpen(record.id);
      setContext({ selection: this._selection() });
    };
    TDetail.prototype.close = function () { if (this._dialog && this._dialog.open) this._dialog.close(); };
    TDetail.prototype._closed = function () {
      var record = this._record;
      setContext({ selection: null });
      if (record && routeGet().id === text(record.id)) routeClose();
      emit(this, 't-close', {});
    };
    ['fields', 'settings', 'siblings'].forEach(function (name) {
      Object.defineProperty(TDetail.prototype, name, { get: function () { return this['_' + name]; }, set: function (v) { this['_' + name] = name === 'settings' ? (isPlain(v) ? v : {}) : Array.isArray(v) ? v : []; this._render(); } });
    });
    Object.defineProperty(TDetail.prototype, 'record', { get: function () { return this._record; }, set: function (v) {
      var changed = !this._record || !v || this._record.id !== v.id;
      this._record = v || null;
      this._render();
      if (this.opened && this._record && changed) this._announce(); // moved to a neighbour while open
    } });
    Object.defineProperty(TDetail.prototype, 'opened', { get: function () { return !!(this._dialog && this._dialog.open); } });
    define('t-detail', TDetail);

    // ---- <t-import> ----------------------------------------------------------------------------------------------------------------------
    function readFileText(file) {
      if (file.text) return file.text();
      return new Promise(function (resolve, reject) {
        var reader = new FileReader();
        reader.onload = function () { resolve(String(reader.result)); };
        reader.onerror = function () { reject(reader.error); };
        reader.readAsText(file);
      });
    }
    var TImport = makeElement();
    TImport.prototype.connectedCallback = function () { adopt(this, ['fields']); };
    /** Asks for a CSV file, maps its columns to the fields and resolves the rows that pass as data objects (null if cancelled). */
    TImport.prototype.open = function () {
      var self = this;
      if (self._pending) return self._pending;
      var finishWith, promise = new Promise(function (resolve) { finishWith = resolve; });
      self._pending = promise;
      var fields = (self._fields || []).filter(function (f) { return f.type !== 'formula' && f.type !== 'image' && f.type !== 'file'; });
      var state = { step: 0, parsed: null, mapping: [], fileName: '', error: '' };
      var steps = h('t-steps'), content = h('div', { class: 't-import-content' }), actions = h('div', { class: 't-actions' });
      steps.steps = [t('stepFile'), t('stepColumns'), t('stepReview')];
      var dialog = h('dialog', { class: 't-dialog wide', 'aria-label': t('importTitle') },
        h('div', { class: 't-dialog-head' }, h('h2', { text: t('importTitle') }), h('button', { type: 'button', class: 't-icon-button', 'aria-label': t('close'), onClick: function () { done(null); } }, icon('close', 16))),
        h('div', { class: 't-dialog-body' }, steps, content, actions));
      var finished = false;
      function done(value) {
        if (finished) return;
        finished = true;
        try { dialog.close(); } catch (_) { /* closed */ }
        if (dialog.parentNode) dialog.parentNode.removeChild(dialog);
        self._pending = null;
        finishWith(value);
      }
      dialog.addEventListener('cancel', function (event) { event.preventDefault(); done(null); });
      dialog.addEventListener('close', function () { done(null); });
      function button(label, handler, kind, disabled) { return h('button', { type: 'button', class: 't-button' + (kind ? ' ' + kind : ''), text: label, disabled: !!disabled, onClick: handler }); }
      function mappedFields() { return state.mapping.map(function (id) { return fields.filter(function (f) { return f.id === id; })[0] || null; }); }
      function missingRequired() {
        var mapped = state.mapping;
        return fields.filter(function (f) { return f.required && mapped.indexOf(f.id) < 0; });
      }
      function automap(header) {
        var taken = {};
        return header.map(function (name) {
          var key = normalize(name), match = fields.filter(function (f) { return !taken[f.id] && (normalize(f.label) === key || normalize(f.id) === key); })[0];
          if (match) taken[match.id] = true;
          return match ? match.id : '';
        });
      }
      function handleFile(file) {
        if (!file) return;
        if (file.size > 5 * 1024 * 1024) { state.error = t('fileTooBig'); render(); return; }
        readFileText(file).then(function (source) {
          var parsed = csvParse(source);
          if (!parsed.header.length || !parsed.rows.length) { state.error = t('csvEmpty'); render(); return; }
          state.parsed = parsed; state.fileName = file.name; state.error = '';
          state.mapping = automap(parsed.header);
          state.step = 1;
          render();
        }, function () { state.error = t('csvReadError'); render(); });
      }
      function stepFile() {
        var picker = h('input', { type: 'file', accept: '.csv,.txt,text/csv,text/plain', hidden: true });
        picker.addEventListener('change', function () { handleFile(picker.files && picker.files[0]); });
        var zone = h('div', { class: 't-drop' }, icon('upload', 24), h('p', { text: t('dropHere') }), h('button', { type: 'button', class: 't-button primary', text: t('chooseCsv'), onClick: function () { picker.click(); } }), picker);
        zone.addEventListener('dragover', function (event) { event.preventDefault(); zone.classList.add('over'); });
        zone.addEventListener('dragleave', function () { zone.classList.remove('over'); });
        zone.addEventListener('drop', function (event) { event.preventDefault(); zone.classList.remove('over'); handleFile(event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0]); });
        content.appendChild(zone);
        if (state.error) content.appendChild(h('p', { class: 't-error', role: 'alert', text: state.error }));
        actions.appendChild(button(t('cancel'), function () { done(null); }));
      }
      function stepColumns() {
        var parsed = state.parsed, gate = h('p', { class: 't-error', 'aria-live': 'polite' }), next = button(t('continue'), function () { state.step = 2; render(); }, 'primary');
        function gateUpdate() {
          var missing = missingRequired();
          gate.textContent = missing.length ? tf('mapRequired', { x: missing.map(function (f) { return f.label; }).join(', ') }) : '';
          next.disabled = missing.length > 0 || state.mapping.every(function (id) { return !id; });
        }
        content.appendChild(h('p', { class: 't-muted', text: state.fileName + ' · ' + plural(parsed.rows.length, 'rowsOne', 'rowsMany') + ' · ' + tf('previewRows', { n: Math.min(5, parsed.rows.length) }) }));
        var head = h('tr'), selects = [];
        parsed.header.forEach(function (name, index) {
          var select = h('select', { class: 't-input', 'aria-label': t('importAs') + ': ' + name }, h('option', { value: '', text: t('ignore') }));
          fields.forEach(function (f) { select.appendChild(h('option', { value: f.id, text: text(f.label) })); });
          select.value = state.mapping[index] || '';
          select.addEventListener('change', function () {
            state.mapping[index] = select.value;
            if (select.value) selects.forEach(function (other, j) { if (j !== index && other.value === select.value) { other.value = ''; state.mapping[j] = ''; } });
            gateUpdate();
          });
          selects.push(select);
          head.appendChild(h('th', { scope: 'col' }, h('span', { class: 't-import-col', text: name || ('#' + (index + 1)) }), select));
        });
        var body = h('tbody');
        parsed.rows.slice(0, 5).forEach(function (row) { body.appendChild(h('tr', {}, row.slice(0, parsed.header.length).map(function (cell) { return h('td', { text: cell }); }))); });
        content.appendChild(h('div', { class: 't-table-scroll' }, h('table', { class: 't-table t-import-table' }, h('thead', {}, head), body)));
        content.appendChild(gate);
        actions.appendChild(button(t('back'), function () { state.step = 0; render(); }));
        actions.appendChild(button(t('cancel'), function () { done(null); }));
        actions.appendChild(next);
        gateUpdate();
      }
      function review() {
        var mapped = mappedFields(), good = [], problems = [];
        state.parsed.rows.forEach(function (row, index) {
          if (row.every(function (cell) { return !cell.trim(); })) return;
          var data = {};
          mapped.forEach(function (field, col) {
            if (!field) return;
            var value = fieldValue(field, row[col]);
            if (value !== null) data[field.id] = value;
          });
          var check = validate(mapped.filter(Boolean), data);
          if (check.ok) good.push(data);
          else problems.push({ line: index + 2, errors: check.errors });
        });
        return { good: good, problems: problems };
      }
      function stepReview() {
        var result = review();
        content.appendChild(h('p', {}, h('strong', { text: plural(result.good.length, 'rowsReadyOne', 'rowsReadyMany') }), result.problems.length ? ', ' + tf('rowsProblems', { n: result.problems.length }) : ''));
        if (result.problems.length) {
          var list = h('ul', { class: 't-import-problems' });
          result.problems.slice(0, 8).forEach(function (problem) {
            Object.keys(problem.errors).forEach(function (id) {
              var field = fields.filter(function (f) { return f.id === id; })[0];
              list.appendChild(h('li', { text: t('row') + ' ' + problem.line + ' · ' + (field ? field.label : id) + ': ' + problem.errors[id] }));
            });
          });
          if (result.problems.length > 8) list.appendChild(h('li', { class: 't-muted', text: tf('andMore', { n: result.problems.length - 8 }) }));
          content.appendChild(list);
        }
        actions.appendChild(button(t('back'), function () { state.step = 1; render(); }));
        actions.appendChild(button(t('cancel'), function () { done(null); }));
        actions.appendChild(button(tf('importN', { n: result.good.length }), function () { done(result.good); }, 'primary', !result.good.length));
      }
      function render() {
        clear(content); clear(actions);
        steps.current = state.step;
        [stepFile, stepColumns, stepReview][state.step]();
        var first = state.step === 0 ? content.querySelector('button') : state.step === 1 ? content.querySelector('select') : actions.querySelector('.primary') || actions.querySelector('button');
        if (first) first.focus();
      }
      self.appendChild(dialog);
      render();
      try { dialog.showModal(); } catch (_) { dialog.setAttribute('open', ''); }
      var start = content.querySelector('button');
      if (start) start.focus();
      return promise;
    };
    Object.defineProperty(TImport.prototype, 'fields', { get: function () { return this._fields || []; }, set: function (v) { this._fields = Array.isArray(v) ? v : []; } });
    define('t-import', TImport);

    // ==== v2.1 elements ===============================================================================

    // ---- <t-data-tools> ---------------------------------------------------------------------------------------
    function appTitle() { try { return document.title || ''; } catch (_) { return ''; } }
    function failToast(error) { toast(error && error.message ? error.message : t('error'), { tone: 'error' }); }
    var TDataTools = makeElement();
    TDataTools.prototype.connectedCallback = function () {
      var self = this;
      adopt(self, ['collection', 'fields', 'records', 'examples', 'filename', 'exportRows', 'exportColumns', 'noun', 'beforeInsert', 'beforeExamples']);
      if (!self._bound) {
        self._bound = true;
        self._body = h('div', { class: 't-dt-body' });
        self._importer = h('t-import'); // outside the body: a redraw must not take an open import dialog away
        self.appendChild(self._body);
        self.appendChild(self._importer);
        self.addEventListener('click', function (event) {
          var button = event.target.closest ? event.target.closest('button[data-act]') : null;
          if (!button || !self.contains(button) || button.disabled || self._busy) return;
          var act = button.dataset.act;
          if (act === 'export') self._export();
          else if (act === 'import') self._import();
          else if (act === 'examples') self._loadExamples();
          else if (act === 'clear-examples') self._clearExamples();
          else if (act === 'delete-all') self._deleteAll();
        });
      }
      self._draw();
    };
    TDataTools.prototype.attributeChangedCallback = function () { if (this.isConnected && this._bound) this._draw(); };
    TDataTools.observedAttributes = ['hide'];
    TDataTools.prototype._hidden = function (block) {
      return (this.getAttribute('hide') || '').toLowerCase().split(/[\s,]+/).indexOf(block) >= 0;
    };
    TDataTools.prototype._nounMany = function () { return (this._noun && this._noun.many) || t('nounMany'); };
    TDataTools.prototype._draw = function () {
      var self = this;
      if (!self.isConnected || !self._body) return;
      var focused = document.activeElement && self.contains(document.activeElement) && document.activeElement.dataset ? document.activeElement.dataset.act : null;
      var known = Array.isArray(self._records), total = known ? self._records.length : 0, samples = known ? samplesCount(self._records) : 0, busy = !!self._busy;
      clear(self._body);
      function button(act, label, iconName, kind, disabled) {
        return h('button', { type: 'button', class: 't-button' + (kind ? ' ' + kind : ''), disabled: busy || !!disabled, dataset: { act: act } }, iconName ? icon(iconName, 14) : null, h('span', { text: label }));
      }
      function card(title, body, buttons, kind) {
        return h('section', { class: 't-card t-dt-card' + (kind ? ' ' + kind : '') }, h('div', { class: 't-card-head' }, h('h2', { text: title })), h('p', { class: 't-muted', text: body }), h('div', { class: 't-dt-actions' }, buttons));
      }
      var canImport = !self._hidden('import'), canExport = !self._hidden('export');
      if (canImport || canExport) {
        var buttons = [];
        if (canExport) buttons.push(button('export', t('exportCsv'), 'download'));
        if (canImport) buttons.push(button('import', t('importCsv'), 'upload'));
        self._body.appendChild(card(t('dataTitle'), tf(canImport ? 'dataTextBoth' : 'dataTextExport', { x: self._nounMany() }), buttons));
      }
      if (!self._hidden('examples')) {
        var examples = [];
        if (!known || samples === 0) examples.push(button('examples', t('seeExamples'), 'play'));
        if (!known || samples > 0) examples.push(button('clear-examples', t('clearSamples'), 'trash'));
        self._body.appendChild(card(t('examplesTitle'), samples > 0 ? plural(samples, 'samplesOne', 'samplesMany') : t('examplesText'), examples));
      }
      if (!self._hidden('danger')) self._body.appendChild(card(t('dangerTitle'), t('dangerText'), [button('delete-all', t('deleteAll'), 'trash', 'danger', known && total === 0)], 't-dt-danger'));
      if (focused) { var again = self._body.querySelector('button[data-act="' + focused + '"]:not(:disabled)'); if (again) again.focus(); }
    };
    TDataTools.prototype._work = function (job) { // one job at a time: buttons are off while it runs
      var self = this;
      self._busy = true; self._draw();
      var finish = function () { self._busy = false; self._draw(); };
      return Promise.resolve().then(job).then(function (value) { finish(); return value; }, function (error) { finish(); failToast(error); });
    };
    TDataTools.prototype._current = function () {
      var self = this;
      if (!self._collection) return Promise.reject(new Error(t('error')));
      return Promise.resolve(self._collection.list({ limit: 5000 }));
    };
    TDataTools.prototype._export = function () {
      var self = this;
      self._work(function () {
        var load = Array.isArray(self._records) ? Promise.resolve(self._records) : self._current();
        return load.then(function (records) {
          var fields = self._fields || [];
          var rows = typeof self._exportRows === 'function' ? self._exportRows(records) : records.map(function (r) { return compute(fields, r.data || {}); });
          return Promise.resolve(rows).then(function (list) {
            var columns = typeof self._exportColumns === 'function' ? self._exportColumns() : Array.isArray(self._exportColumns) ? self._exportColumns : csvColumnsFor(fields);
            csvDownload(csvStringify(list, columns, { delimiter: csvDelimiter() }), csvFileName(appTitle(), self._filename !== undefined ? self._filename : self.getAttribute('filename'), today()));
            toast(tf('exported', { x: plural(list.length, 'rowsOne', 'rowsMany') }));
          });
        });
      });
    };
    TDataTools.prototype._import = function () {
      var self = this;
      self._importer.fields = self._fields || [];
      self._importer.open().then(function (docs) {
        if (!docs || !docs.length) return;
        return self._work(function () {
          var made = 0, failed = 0, chain = Promise.resolve();
          docs.forEach(function (doc, index) {
            chain = chain.then(function () {
              var prepared;
              try { prepared = typeof self._beforeInsert === 'function' ? self._beforeInsert(doc) : doc; } catch (_) { failed++; return null; }
              return Promise.resolve(prepared).then(function (data) {
                if (!data) return null; // the page skipped this row
                return self._collection.insert(data).then(function () { made++; }, function () { failed++; });
              });
            }).then(function () { if ((index + 1) % 50 === 0 && index + 1 < docs.length) toast(tf('importing', { n: index + 1, m: docs.length })); });
          });
          return chain.then(function () {
            toast(tf('imported', { x: plural(made, 'rowsOne', 'rowsMany') }), { tone: made ? 'success' : 'error' });
            if (failed) toast(tf('importFailed', { n: failed }), { tone: 'error' });
            emit(self, 't-imported', { count: made, failed: failed });
          });
        });
      });
    };
    TDataTools.prototype._loadExamples = function () {
      var self = this;
      self._work(function () {
        return Promise.resolve(typeof self._beforeExamples === 'function' ? self._beforeExamples() : null).then(function () {
          return typeof self._examples === 'function' ? self._examples() : self._examples;
        }).then(function (docs) {
          return samplesLoad(self._collection, Array.isArray(docs) ? docs : []);
        }).then(function (count) { emit(self, 't-examples', { action: 'loaded', loaded: true, cleared: false, count: count }); });
      });
    };
    TDataTools.prototype._clearExamples = function () {
      var self = this;
      self._work(function () {
        return samplesClear(self._collection).then(function (count) { emit(self, 't-examples', { action: 'cleared', loaded: false, cleared: true, count: count }); });
      });
    };
    TDataTools.prototype._deleteAll = function () {
      var self = this;
      self._work(function () {
        var load = Array.isArray(self._records) ? Promise.resolve(self._records) : self._current();
        return load.then(function (records) {
          var n = records.length, noun = self._noun || {};
          if (!n) return;
          var message = tf(n === 1 ? 'deleteAllOne' : 'deleteAllMany', { n: n, x: n === 1 ? (noun.one || t('nounOne')) : (noun.many || t('nounMany')) });
          return confirm(message, { confirm: t('delete'), tone: 'danger' }).then(function (yes) {
            if (!yes) return;
            var gone = 0;
            function sweep(round) { // lists again, in case there are more than one page of records
              return self._current().then(function (all) {
                if (!all.length || round > 20) return gone;
                var chain = Promise.resolve();
                all.forEach(function (record) { chain = chain.then(function () { return self._collection.remove(record.id); }).then(function () { gone++; }); });
                return chain.then(function () { return sweep(round + 1); });
              });
            }
            return sweep(0).then(function (count) { emit(self, 't-cleared', { count: count }); });
          });
        });
      });
    };
    ['collection', 'fields', 'records', 'examples', 'filename', 'exportRows', 'exportColumns', 'noun', 'beforeInsert', 'beforeExamples'].forEach(function (name) {
      Object.defineProperty(TDataTools.prototype, name, { get: function () { return this['_' + name]; }, set: function (v) { this['_' + name] = v; if (name === 'records' || name === 'noun') this._draw(); } });
    });
    define('t-data-tools', TDataTools);

    // ---- <t-empty-start> -----------------------------------------------------------------------------------------
    var TEmptyStart = makeElement();
    TEmptyStart.observedAttributes = ['title', 'text', 'action'];
    TEmptyStart.prototype.connectedCallback = function () {
      var self = this;
      if (!self._bound) {
        self._bound = true;
        self.addEventListener('click', function (event) {
          var button = event.target.closest ? event.target.closest('button[data-act]') : null;
          if (!button || !self.contains(button)) return;
          emit(self, button.dataset.act === 'examples' ? 't-examples' : 't-action', {});
        });
      }
      self._draw();
    };
    TEmptyStart.prototype.attributeChangedCallback = function (name, before, after) {
      if (name === 'title') { if (after === null) return; this._title = after; this.removeAttribute('title'); } // no browser tooltip over the whole block
      if (this.isConnected && this._bound) this._draw();
    };
    TEmptyStart.prototype._draw = function () {
      var self = this;
      if (!self.isConnected) return;
      if (self.hasAttribute('title')) { self._title = self.getAttribute('title'); self.removeAttribute('title'); }
      clear(self);
      var actions = h('div', { class: 't-state-actions' });
      if (self.getAttribute('action')) actions.appendChild(h('button', { type: 'button', class: 't-button primary', dataset: { act: 'action' }, text: self.getAttribute('action') }));
      actions.appendChild(h('button', { type: 'button', class: 't-button', dataset: { act: 'examples' }, text: t('seeExamples') }));
      self.appendChild(h('t-state', { kind: 'empty', title: self._title === undefined ? null : self._title, text: self.getAttribute('text') }, actions));
    };
    define('t-empty-start', TEmptyStart);

    // ==== v2.2 elements ===============================================================================

    // ---- <t-row-editor> ------------------------------------------------------------------------------------
    var TRowEditor = makeElement();
    TRowEditor.prototype.connectedCallback = function () {
      var self = this;
      adopt(self, ['rows', 'cells', 'addLabel', 'newRow', 'canRemove', 'confirmRemove']);
      if (!self._bound) {
        self._bound = true;
        self._live = h('span', { class: 't-sr', 'aria-live': 'polite' });
        self.addEventListener('t-change', function (event) { if (event.target !== self) event.stopPropagation(); }); // a nested editor in a cell: not ours
        self.addEventListener('click', function (event) {
          var button = event.target.closest ? event.target.closest('button[data-act]') : null;
          if (!button || !self.contains(button) || button.closest('t-row-editor') !== self) return;
          var row = button.closest('[data-id]'), id = row ? row.dataset.id : null, act = button.dataset.act;
          if (act === 'up') self._move(id, -1, 'up');
          else if (act === 'down') self._move(id, 1, 'down');
          else if (act === 'remove') self._remove(id, button);
          else if (act === 'add') self._add();
        });
        self.addEventListener('pointerdown', function (event) {
          var handle = event.target.closest ? event.target.closest('.t-re-handle') : null;
          var row = handle ? handle.closest('.t-re-row') : null;
          if (!handle || !row || !self.contains(row)) return;
          var others = function () { return Array.prototype.filter.call(row.parentNode.children, function (r) { return r !== row && r.dataset && r.dataset.id; }); };
          dragReorder(event, {
            handle: handle, item: row, axis: 'y', others: others,
            onDrop: function (index) {
              var ids = others().map(function (r) { return r.dataset.id; });
              ids.splice(index, 0, row.dataset.id);
              self._reorder(ids, row.dataset.id);
            }
          });
        });
      }
      self._draw();
    };
    TRowEditor.prototype._find = function (id) { return (this._rows || []).filter(function (r) { return text(r.id) === text(id); })[0]; };
    TRowEditor.prototype._commit = function (rows) {
      this._rows = rows;
      this._draw();
      emit(this, 't-change', { rows: copyList(rows) });
    };
    /** The page's `change(patch)` for one row: merges (undefined removes a key), tells the page, redraws only when asked (typing keeps its focus). */
    TRowEditor.prototype._changer = function (id) {
      var self = this;
      return function (patch, options) {
        var row = self._find(id);
        if (!row) return;
        var next = Object.assign({}, row);
        Object.keys(patch || {}).forEach(function (key) { if (patch[key] === undefined) delete next[key]; else next[key] = patch[key]; });
        self._rows = self._rows.map(function (r) { return r === row ? next : r; });
        if (options && options.redraw) self._draw();
        emit(self, 't-change', { rows: copyList(self._rows) });
      };
    };
    TRowEditor.prototype._reorder = function (ids, movedId, act) {
      var self = this, rows = self._rows || [];
      if (sameJson(ids.map(text), rows.map(function (r) { return text(r.id); }))) return;
      var next = ids.map(function (id) { return self._find(id); });
      self._live.textContent = tf('movedTo', { n: ids.map(text).indexOf(text(movedId)) + 1, m: ids.length });
      self._commit(next);
      if (act) {
        var row = rowById(self, movedId), button = row ? row.querySelector('button[data-act="' + act + '"]:not(:disabled)') || row.querySelector('button[data-act="' + (act === 'up' ? 'down' : 'up') + '"]:not(:disabled)') : null;
        if (button) button.focus();
      }
    };
    TRowEditor.prototype._move = function (id, delta, act) {
      var ids = (this._rows || []).map(function (r) { return r.id; }), at = ids.map(text).indexOf(text(id));
      if (at < 0 || at + delta < 0 || at + delta >= ids.length) return;
      this._reorder(moveId(ids, id, at + delta), id, act);
    };
    TRowEditor.prototype._add = function () {
      var self = this, row = typeof self._newRow === 'function' ? self._newRow() : {};
      row = isPlain(row) ? Object.assign({}, row) : {};
      if (row.id === undefined || row.id === null || row.id === '') row.id = uid();
      self._commit((self._rows || []).concat([row]));
      var li = rowById(self, row.id), first = li ? li.querySelector('.t-re-cells input, .t-re-cells select, .t-re-cells textarea, .t-re-cells button') : null;
      if (first) first.focus();
    };
    TRowEditor.prototype._remove = function (id, button) {
      var self = this, row = self._find(id);
      if (!row) return Promise.resolve();
      var verdict = typeof self._canRemove === 'function' ? self._canRemove(Object.assign({}, row)) : true;
      if (verdict !== true && verdict !== undefined) { toast(typeof verdict === 'string' ? verdict : t('error'), { tone: 'error' }); return Promise.resolve(); }
      var ask = typeof self._confirmRemove === 'function' ? Promise.resolve().then(function () { return self._confirmRemove(Object.assign({}, row)); }) : Promise.resolve(true);
      return ask.then(function (yes) {
        if (!yes || !self._find(id)) return;
        self._commit(self._rows.filter(function (r) { return text(r.id) !== text(id); }));
        var add = self.querySelector('[data-act="add"]');
        if (add) add.focus();
      });
    };
    /** The control that has focus, as { id, index } (which row, which control inside it), to put focus back after a redraw. */
    TRowEditor.prototype._focusMark = function () {
      var el = document.activeElement;
      if (!el || !this.contains(el) || !el.closest) return null;
      var row = el.closest('.t-re-row');
      if (!row) return el.dataset && el.dataset.act === 'add' ? { add: true } : null;
      var controls = Array.prototype.slice.call(row.querySelectorAll('input, select, textarea, button'));
      return { id: row.dataset.id, index: controls.indexOf(el), start: el.selectionStart, end: el.selectionEnd };
    };
    TRowEditor.prototype._focusBack = function (mark) {
      if (!mark) return;
      var el = null;
      if (mark.add) el = this.querySelector('[data-act="add"]');
      else {
        var row = rowById(this, mark.id);
        el = row ? Array.prototype.slice.call(row.querySelectorAll('input, select, textarea, button'))[mark.index] : null;
      }
      if (!el) return;
      el.focus();
      try { if (mark.start !== undefined && mark.start !== null && el.setSelectionRange) el.setSelectionRange(mark.start, mark.end); } catch (_) { /* not a text box */ }
    };
    TRowEditor.prototype._draw = function () {
      var self = this;
      if (!self.isConnected) return;
      var rows = self._rows || [], addLabel = self._addLabel || t('addItem'), mark = self._focusMark();
      clear(self);
      var list = h('ul', { class: 't-re-list' });
      rows.forEach(function (row, index) {
        var nodes = typeof self._cells === 'function' ? self._cells(Object.assign({}, row), self._changer(row.id)) : null;
        var name = t('row') + ' ' + (index + 1);
        var verdict = typeof self._canRemove === 'function' ? self._canRemove(Object.assign({}, row)) : true;
        var removable = verdict === true || verdict === undefined;
        var li = h('li', { class: 't-re-row', dataset: { id: text(row.id) } },
          h('span', { class: 't-re-handle', 'aria-hidden': 'true', title: t('reorder') }, icon('drag', 16)),
          h('div', { class: 't-re-cells' }, nodes),
          h('span', { class: 't-re-buttons' },
            h('button', { type: 'button', class: 't-icon-button', 'aria-label': t('moveUp') + ': ' + name, disabled: index === 0, dataset: { act: 'up' } }, icon('arrow-up', 14)),
            h('button', { type: 'button', class: 't-icon-button', 'aria-label': t('moveDown') + ': ' + name, disabled: index === rows.length - 1, dataset: { act: 'down' } }, icon('arrow-down', 14)),
            h('button', { type: 'button', class: 't-icon-button' + (removable ? '' : ' unavailable'), 'aria-label': t('remove') + ': ' + name, 'aria-disabled': removable ? null : 'true', title: removable || typeof verdict !== 'string' ? null : verdict, dataset: { act: 'remove' } }, icon('trash', 14))));
        list.appendChild(li);
      });
      self.appendChild(list);
      self.appendChild(h('div', { class: 't-re-add' }, h('button', { type: 'button', class: 't-button', dataset: { act: 'add' } }, icon('plus', 14), h('span', { text: addLabel }))));
      self.appendChild(self._live);
      self._focusBack(mark);
    };
    /** Draws the rows again with what the page's `cells` function builds now (the rows themselves did not change), keeping focus. */
    TRowEditor.prototype.refresh = function () { this._draw(); };
    Object.defineProperty(TRowEditor.prototype, 'rows', { get: function () { return copyList(this._rows); }, set: function (v) {
      var next = copyList(v);
      if (this._rows && sameJson(next, this._rows)) return; // the page echoing what we just told it: leave the focus alone
      this._rows = next; this._draw();
    } });
    ['cells', 'addLabel', 'newRow', 'canRemove', 'confirmRemove'].forEach(function (name) {
      Object.defineProperty(TRowEditor.prototype, name, { get: function () { return this['_' + name]; }, set: function (v) {
        this['_' + name] = name === 'addLabel' ? text(v) : typeof v === 'function' ? v : null;
        if (name === 'cells' || name === 'addLabel' || name === 'canRemove') this._draw();
      } });
    });
    define('t-row-editor', TRowEditor);

    // ---- <t-menu> -----------------------------------------------------------------------------------------------
    var TMenu = makeElement();
    TMenu.observedAttributes = ['label'];
    TMenu.prototype.connectedCallback = function () {
      var self = this;
      adopt(self, ['items']);
      if (!self._bound) {
        self._bound = true;
        self._opened = false;
        self.addEventListener('click', function (event) {
          event.stopPropagation(); // a menu in a clickable row must not also open the row
          var item = event.target.closest ? event.target.closest('.t-menu-item') : null;
          var trigger = event.target.closest ? event.target.closest('.t-menu-button') : null;
          if (item && self.contains(item) && !item.disabled) self._select(item.dataset.id);
          else if (trigger && self.contains(trigger)) { if (self._opened) self.close(true); else self.open(); }
        });
        self.addEventListener('keydown', function (event) {
          var key = event.key;
          if (!self._opened) {
            if (event.target.closest && event.target.closest('.t-menu-button') && (key === 'ArrowDown' || key === 'ArrowUp')) { event.preventDefault(); event.stopPropagation(); self.open(key === 'ArrowUp'); }
            else if (event.target.closest && event.target.closest('.t-menu-button') && (key === 'Enter' || key === ' ')) event.stopPropagation(); // the click that follows opens it
            return;
          }
          if (key === 'Escape') { event.preventDefault(); event.stopPropagation(); self.close(true); return; }
          if (key === 'Tab') { self.close(false); return; }
          var buttons = self._itemButtons(), at = buttons.indexOf(document.activeElement), items = self._items || [];
          var current = at >= 0 ? Number(buttons[at].dataset.index) : -1;
          if (key === 'Enter' || key === ' ') { event.stopPropagation(); return; } // the button's own click selects
          var next = menuIndex(items, current, key);
          if (next !== current || key.length === 1 || key === 'Home' || key === 'End' || key.indexOf('Arrow') === 0) {
            event.preventDefault(); event.stopPropagation();
            var target = next >= 0 ? self.querySelector('.t-menu-item[data-index="' + next + '"]') : null;
            if (target) target.focus();
          }
        });
        self._outside = function (event) { if (self._opened && !self.contains(event.target)) self.close(false); };
        self._away = function () { if (self._opened) self.close(false); };
      }
      self._draw();
    };
    TMenu.prototype.disconnectedCallback = function () { this._unlisten(); this._opened = false; };
    TMenu.prototype.attributeChangedCallback = function () { if (this.isConnected && this._bound) this._draw(); };
    TMenu.prototype._itemButtons = function () { return Array.prototype.slice.call(this.querySelectorAll('.t-menu-item')); };
    TMenu.prototype._unlisten = function () {
      if (!this._listening) return;
      this._listening = false;
      document.removeEventListener('pointerdown', this._outside, true);
      window.removeEventListener('resize', this._away);
      window.removeEventListener('scroll', this._away, true);
    };
    TMenu.prototype._select = function (id) {
      var self = this;
      self.close(true);
      emit(self, 't-select', { id: id });
    };
    TMenu.prototype._draw = function () {
      var self = this;
      if (!self.isConnected) return;
      var label = self.getAttribute('label') || t('actions');
      clear(self);
      self._button = h('button', { type: 'button', class: 't-icon-button t-menu-button', 'aria-label': label, 'aria-haspopup': 'menu', 'aria-expanded': self._opened ? 'true' : 'false' }, icon('more', 16));
      self.appendChild(self._button);
      self._pop = null;
      if (self._opened) self._drawPop(-1);
    };
    TMenu.prototype._drawPop = function (focusIndex) {
      var self = this, items = self._items || [], label = self.getAttribute('label') || t('actions');
      if (self._pop && self._pop.parentNode) self._pop.parentNode.removeChild(self._pop);
      var pop = h('div', { class: 't-menu-pop', role: 'menu', 'aria-label': label });
      items.forEach(function (item, index) {
        if (item === '-') { pop.appendChild(h('hr', { class: 't-menu-sep', role: 'separator' })); return; }
        if (!isPlain(item)) return;
        var row = h('button', { type: 'button', class: 't-menu-item' + (item.tone === 'danger' ? ' danger' : ''), role: 'menuitem', tabindex: '-1', disabled: !!item.disabled, dataset: { id: text(item.id), index: String(index) } },
          item.icon ? icon(item.icon, 14) : null, h('span', { text: text(item.label) }));
        pop.appendChild(row);
      });
      pop.style.visibility = 'hidden';
      self.appendChild(pop);
      self._pop = pop;
      self._place();
      pop.style.visibility = '';
      var target = focusIndex >= 0 ? self.querySelector('.t-menu-item[data-index="' + focusIndex + '"]') : null;
      if (target) target.focus();
    };
    /** Under the button (above it near the bottom), inside the app. Position is fixed; where the page makes <t-app> a containing block the
     *  first guess is corrected by measuring where it really landed. */
    TMenu.prototype._place = function () {
      var self = this, pop = self._pop, button = self._button;
      if (!pop || !button) return;
      var app = self.closest ? self.closest('t-app') : null, main = app ? app.querySelector('.t-app-main') : null;
      var area = (main || app || document.documentElement).getBoundingClientRect();
      var bound = main || app ? { left: area.left, top: area.top, right: area.right, bottom: area.bottom } : { left: 0, top: 0, right: window.innerWidth || area.right, bottom: window.innerHeight || area.bottom };
      var box = button.getBoundingClientRect(), size = { width: pop.offsetWidth, height: pop.offsetHeight };
      var spot = menuPosition({ left: box.left, top: box.top, right: box.right, bottom: box.bottom }, size, bound, 4);
      pop.style.left = spot.left + 'px'; pop.style.top = spot.top + 'px';
      var real = pop.getBoundingClientRect();
      if (Math.abs(real.left - spot.left) > 1) pop.style.left = (spot.left - (real.left - spot.left)) + 'px';
      if (Math.abs(real.top - spot.top) > 1) pop.style.top = (spot.top - (real.top - spot.top)) + 'px';
      pop.classList.toggle('flipped', spot.flipped);
    };
    /** Opens the menu and focuses its first item (its last one with lastFirst). */
    TMenu.prototype.open = function (lastFirst) {
      var self = this;
      if (self._opened || !self.isConnected) return;
      var items = self._items || [];
      self._opened = true;
      self._button.setAttribute('aria-expanded', 'true');
      self._drawPop(menuIndex(items, -1, lastFirst === true ? 'ArrowUp' : 'ArrowDown'));
      if (!self._listening) {
        self._listening = true;
        document.addEventListener('pointerdown', self._outside, true);
        window.addEventListener('resize', self._away);
        window.addEventListener('scroll', self._away, true);
      }
    };
    /** Closes it; with refocus the button gets focus back. */
    TMenu.prototype.close = function (refocus) {
      var self = this;
      if (!self._opened) return;
      self._opened = false;
      self._unlisten();
      if (self._pop && self._pop.parentNode) self._pop.parentNode.removeChild(self._pop);
      self._pop = null;
      if (self._button) { self._button.setAttribute('aria-expanded', 'false'); if (refocus) self._button.focus(); }
    };
    Object.defineProperty(TMenu.prototype, 'items', { get: function () { return copyList(this._items); }, set: function (v) {
      this._items = (Array.isArray(v) ? v : []).map(function (item) { return isPlain(item) ? Object.assign({}, item) : item; });
      if (this.isConnected && this._bound && this._opened) this._drawPop(-1);
    } });
    Object.defineProperty(TMenu.prototype, 'opened', { get: function () { return !!this._opened; } });
    define('t-menu', TMenu);

    // ---- <t-action-bar> -----------------------------------------------------------------------------------------------
    var TActionBar = makeElement();
    TActionBar.prototype.connectedCallback = function () { if (!this.getAttribute('role')) this.setAttribute('role', 'group'); };
    define('t-action-bar', TActionBar);
  }

  /** csv.download: the text as a UTF-8 .csv file. */
  function csvDownload(source, filename) { download(new Blob([source], { type: 'text/csv;charset=utf-8' }), filename); }

  window.tkit = {
    version: 2,
    minor: 2,
    elements: elements,
    icons: Object.keys(ICONS),
    h: h, icon: icon, clear: clear, toast: toast, confirm: confirm, live: live, form: form, fill: fill,
    date: date, ago: ago, money: money, number: number, uid: uid, today: today,
    filterRows: filterRows, sortRows: sortRows, groupBy: groupBy, monthGrid: monthGrid, matches: matches, t: t,
    // v2
    fold: normalize, download: download, daysFromToday: daysFromToday, parseNumber: parseNumber,
    parseRoute: parseRoute, route: { get: routeGet, open: routeOpen, close: routeClose, on: routeOn },
    context: setContext, mergeContext: mergeContext,
    settings: settings, mergeSettings: mergeSettings,
    fieldTypes: FIELD_TYPES.slice(), tones: TONES.slice(),
    slug: slug, fieldValue: fieldValue, fieldText: fieldText, validate: validate, compute: compute,
    formula: { compile: compileFormula, evaluate: evaluateFormula, functions: Object.keys(FORMULA_FUNCTIONS) },
    csv: { stringify: csvStringify, parse: csvParse, download: csvDownload, delimiter: csvDelimiter, columnsFor: csvColumnsFor, filename: csvFileName },
    samples: { load: samplesLoad, clear: samplesClear, count: samplesCount },
    parseMarkdown: parseMarkdown, markdown: markdown, markdownOutline: markdownOutline,
    // v2.1
    copy: copy, autosave: autosave, tableFooter: tableFooter, weekdayGrid: weekdayGrid,
    search: { match: searchMatch, highlight: searchHighlight, snippet: searchSnippet },
    textarea: { wrap: textareaWrap, prefixLines: textareaPrefixLines, wrapEdit: wrapEdit, prefixEdit: prefixEdit },
    // v2.2
    editCell: editCell, chooseMove: chooseMove, cellValue: cellValue, cellText: cellText,
    menuIndex: menuIndex, menuPosition: menuPosition, moveId: moveId, dropIndex: dropIndex, letterOf: letterOf
  };
})();
