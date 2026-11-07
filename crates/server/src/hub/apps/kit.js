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
 *                                   keeps it; event "t-view" {view}. It tells Tendly the view's name
 *                                   (tendly.host.setContext) so the chat chip reads "App · Board".
 *   <t-nav label="Sections">        <button data-view="board" data-icon="board">Board</button> …
 *                                   (a button without data-view is an ordinary action). An optional
 *                                   <span class="t-nav-title"> on top shows the app's name.
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
 */
(function () {
  'use strict';
  if (window.tkit) return;

  // ---- Language ------------------------------------------------------------
  var STRINGS = {
    en: { filter: 'Filter', noResults: 'Nothing matches', of: 'of', close: 'Close', cancel: 'Cancel', ok: 'OK', today: 'Today', prev: 'Previous month', next: 'Next month', empty: 'Nothing here yet', loading: 'Loading…', error: 'Something went wrong', add: 'Add', more: 'more', moved: 'Moved to', items: 'items' },
    pt: { filter: 'Filtrar', noResults: 'Nada encontrado', of: 'de', close: 'Fechar', cancel: 'Cancelar', ok: 'OK', today: 'Hoje', prev: 'Mês anterior', next: 'Mês seguinte', empty: 'Nada por aqui ainda', loading: 'Carregando…', error: 'Algo deu errado', add: 'Adicionar', more: 'mais', moved: 'Movido para', items: 'itens' }
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

  // ---- DOM helpers -----------------------------------------------------------
  function h(tag, props) {
    var el = document.createElement(tag);
    props = props || {};
    Object.keys(props).forEach(function (key) {
      var value = props[key];
      if (value === undefined || value === null || value === false) return;
      if (key === 'class') el.className = value;
      else if (key === 'text') el.textContent = value;
      else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
      else if (key === 'dataset') Object.keys(value).forEach(function (k) { el.dataset[k] = value[k]; });
      else if (key.indexOf('on') === 0 && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
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
    money: 'M2 6h20v12H2zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6M6 12h.01M18 12h.01'
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
        self.addEventListener('click', function (event) {
          var button = event.target && event.target.closest ? event.target.closest('t-nav > button[data-view]') : null;
          if (button && self.contains(button)) self.view = button.dataset.view;
        });
        window.addEventListener('hashchange', function () {
          var wanted = location.hash.replace(/^#/, '');
          if (wanted && wanted !== self._view && self.querySelector('t-view[name="' + wanted + '"]')) self.view = wanted;
        });
        var start = location.hash.replace(/^#/, '') || self.getAttribute('view') || '';
        if (!start || !self.querySelector('t-view[name="' + start + '"]')) { var first = self.querySelector('t-view'); start = first ? first.getAttribute('name') || '' : ''; }
        self._show(start, true);
      });
    };
    TApp.prototype._show = function (name, silent) {
      var self = this, label = name;
      self._view = name;
      Array.prototype.forEach.call(self.querySelectorAll('t-view'), function (view) {
        if (view.getAttribute('name') === name) view.setAttribute('active', ''); else view.removeAttribute('active');
      });
      Array.prototype.forEach.call(self.querySelectorAll('t-nav > button[data-view]'), function (button) {
        if (button.dataset.view === name) { button.setAttribute('aria-current', 'page'); label = button.textContent.trim() || name; }
        else button.removeAttribute('aria-current');
      });
      self.setAttribute('view', name);
      if (!silent) { try { if (location.hash.replace(/^#/, '') !== name) location.hash = name; } catch (_) { /* a sandbox that refuses */ } }
      var main = self.querySelector('.t-app-main');
      if (main && !silent) main.scrollTop = 0;
      try { if (window.tendly && tendly.host && tendly.host.framed) tendly.host.setContext({ view: label }); } catch (_) { /* no SDK */ }
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
        Array.prototype.forEach.call(self.querySelectorAll(':scope > button'), function (button) {
          if (button.dataset.iconDone) return;
          button.dataset.iconDone = '1';
          button.type = 'button';
          var label = button.textContent.trim();
          clear(button);
          if (button.dataset.icon) button.appendChild(icon(button.dataset.icon, 18));
          button.appendChild(h('span', { text: label }));
        });
      });
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
      adopt(self, ['columns', 'rows', 'filter']);
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
      self.appendChild(h('div', { class: 't-table-scroll' }, h('table', { class: 't-table' }, h('thead', {}, head), self._body)));
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
    };
    Object.defineProperty(TTable.prototype, 'columns', { get: function () { return this._columns || []; }, set: function (v) { this._columns = Array.isArray(v) ? v : []; this._draw(); } });
    Object.defineProperty(TTable.prototype, 'rows', { get: function () { return this._rows || []; }, set: function (v) { this._rows = Array.isArray(v) ? v : []; this._drawBody(); if (!this._body) this._draw(); } });
    Object.defineProperty(TTable.prototype, 'filter', { get: function () { return this._filter; }, set: function (v) { this._filter = typeof v === 'function' ? v : null; this._drawBody(); } });
    define('t-table', TTable);

    // <t-kanban>
    var TKanban = function () { return Reflect.construct(HTMLElement, [], TKanban); };
    TKanban.prototype = Object.create(HTMLElement.prototype);
    TKanban.prototype.constructor = TKanban;
    Object.setPrototypeOf(TKanban, HTMLElement);
    TKanban.prototype.connectedCallback = function () {
      var self = this;
      adopt(self, ['columns', 'cards']);
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
    TCalendar.observedAttributes = ['month'];
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
      var cells = monthGrid(year, month, weekStart);
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
      var grid = h('div', { class: 't-cal-grid', role: 'grid' });
      for (var w = 0; w < 7; w++) {
        var name;
        try { name = new Intl.DateTimeFormat(locale(), { weekday: 'short' }).format(new Date(2024, 0, 7 + ((w + weekStart) % 7))); } catch (_) { name = String(w); }
        grid.appendChild(h('div', { class: 't-cal-weekday', role: 'columnheader', text: name.replace(/\.$/, '') }));
      }
      cells.forEach(function (cell) {
        var mine = byDay[cell.date] || [];
        var day = h('button', { type: 'button', class: 't-cal-day' + (cell.other ? ' other' : '') + (cell.today ? ' today' : ''), role: 'gridcell', dataset: { date: cell.date }, 'aria-label': date(cell.date, 'long') + (mine.length ? ', ' + mine.length : ''), 'aria-pressed': self._selected === cell.date ? 'true' : 'false' }, h('span', { class: 't-cal-num', text: String(cell.day) }));
        mine.slice(0, 3).forEach(function (ev) { day.appendChild(h('span', { class: 't-cal-event' + (ev.tone ? ' ' + ev.tone : ''), dataset: { id: text(ev.id) }, text: text(ev.title), title: text(ev.title) })); });
        if (mine.length > 3) day.appendChild(h('span', { class: 't-cal-more', text: '+' + (mine.length - 3) + ' ' + t('more') }));
        if (mine.length) day.appendChild(h('span', { class: 't-cal-dots' }, mine.slice(0, 3).map(function () { return h('i'); })));
        grid.appendChild(day);
      });
      self.appendChild(grid);
    };
    Object.defineProperty(TCalendar.prototype, 'month', { get: function () { var m = this.getAttribute('month') || ''; return /^\d{4}-\d{2}$/.test(m) ? m : today().slice(0, 7); }, set: function (v) { this.setAttribute('month', text(v)); } });
    Object.defineProperty(TCalendar.prototype, 'events', { get: function () { return this._events || []; }, set: function (v) { this._events = Array.isArray(v) ? v : []; this._draw(); } });
    Object.defineProperty(TCalendar.prototype, 'selected', { get: function () { return this._selected; }, set: function (v) { this._selected = v ? text(v) : undefined; this._draw(); } });
    define('t-calendar', TCalendar);
  }

  window.tkit = {
    version: 1,
    elements: elements,
    icons: Object.keys(ICONS),
    h: h, icon: icon, clear: clear, toast: toast, confirm: confirm, live: live, form: form, fill: fill,
    date: date, ago: ago, money: money, number: number, uid: uid, today: today,
    filterRows: filterRows, sortRows: sortRows, groupBy: groupBy, monthGrid: monthGrid, matches: matches, t: t
  };
})();
