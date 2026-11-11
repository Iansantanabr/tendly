// Apps, stage E: the kit apps are built with (kit.css + kit.js) and the pages
// a new app starts with. There is no browser here: the kit's pure helpers run
// in Node, its colours are checked against the design tokens, and every
// template is parsed for what it uses of the kit (tags, classes, helpers) and
// compiled for syntax.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import vm from 'node:vm';

const here = new URL('./', import.meta.url);
const server = new URL('../../../../../crates/server/src/hub/apps/', here);
const KIT_JS = readFileSync(new URL('kit.js', server), 'utf8');
const KIT_CSS = readFileSync(new URL('kit.css', server), 'utf8');
const DEMO = readFileSync(new URL('kit-demo.html', server), 'utf8');
const templates = Object.fromEntries(readdirSync(new URL('templates/', server)).filter(name => name.endsWith('.html')).map(name => [name.replace('.html', ''), readFileSync(new URL(`templates/${name}`, server), 'utf8')]));
const tokens = JSON.parse(readFileSync(new URL('../../../../../replica/design/tokens.json', here), 'utf8'));
const dark = JSON.parse(readFileSync(new URL('../../../../../replica/design/tokens.dark.json', here), 'utf8'));

/** The kit in Node: no DOM, so the elements are skipped and the helpers are what is tested. */
function loadKit(lang = 'en') {
  const window = { document: { documentElement: { lang }, readyState: 'complete', addEventListener() {} }, navigator: { language: lang } };
  window.window = window;
  const context = vm.createContext({ ...window, Intl, Date, Math, JSON, Object, Array, String, Number, Promise, setTimeout, clearTimeout, console });
  context.window = context; context.document = window.document; context.navigator = window.navigator;
  new vm.Script(KIT_JS, { filename: 'kit.js' }).runInContext(context);
  return context.tkit;
}

test('kit: loads without a DOM and exposes the helpers the templates use', () => {
  const tkit = loadKit();
  assert.equal(tkit.version, 2);
  for (const name of ['h', 'icon', 'clear', 'toast', 'confirm', 'live', 'form', 'fill', 'date', 'ago', 'money', 'number', 'uid', 'today', 'filterRows', 'sortRows', 'groupBy', 'monthGrid', 'matches', 't',
    // version 2 (kit-v2.test.mjs covers what they do)
    'fold', 'download', 'daysFromToday', 'parseNumber', 'parseRoute', 'context', 'mergeContext', 'settings', 'mergeSettings', 'slug', 'fieldValue', 'fieldText', 'validate', 'compute', 'parseMarkdown', 'markdown', 'markdownOutline']) {
    assert.equal(typeof tkit[name], 'function', name);
  }
  assert.equal(tkit.elements.length, 0, 'no customElements here: nothing defined');
  assert.ok(tkit.icons.includes('board') && tkit.icons.includes('calendar') && tkit.icons.includes('trash'));
  assert.equal(tkit.t('filter'), 'Filter');
  assert.equal(loadKit('pt-BR').t('filter'), 'Filtrar');
  assert.equal(loadKit('pt-BR').t('nope'), 'nope', 'an unknown key is itself');
});

test('kit: filterRows ignores accents and case, every word must match', () => {
  const { filterRows } = loadKit();
  const rows = [{ id: 1, name: 'José Silva', city: 'São Paulo' }, { id: 2, name: 'Ana', city: 'Rio' }, { id: 3, name: 'Jose Lima', city: 'Recife', tags: ['vip'] }];
  assert.deepEqual(filterRows(rows, 'jose').map(r => r.id), [1, 3]);
  assert.deepEqual(filterRows(rows, 'JOSÉ silva').map(r => r.id), [1]);
  assert.deepEqual(filterRows(rows, 'sao').map(r => r.id), [1]);
  assert.deepEqual(filterRows(rows, 'vip').map(r => r.id), [3], 'lists are searched as text');
  assert.deepEqual(filterRows(rows, 'rio', ['name']).map(r => r.id), [], 'only the keys given');
  assert.deepEqual(filterRows(rows, '  ').map(r => r.id), [1, 2, 3]);
  assert.notEqual(filterRows(rows, ''), rows, 'a copy');
});

test('kit: sortRows compares numbers as numbers and keeps empties last', () => {
  const { sortRows } = loadKit();
  const rows = [{ v: '10' }, { v: 9 }, { v: null }, { v: '' }, { v: 2 }];
  assert.deepEqual(sortRows(rows, 'v', 'asc').map(r => r.v), [2, 9, '10', null, '']);
  assert.deepEqual(sortRows(rows, 'v', 'desc').map(r => r.v), ['10', 9, 2, null, '']);
  const names = [{ n: 'Zoë' }, { n: 'ana' }, { n: 'Élan' }];
  assert.deepEqual(sortRows(names, 'n', 'asc').map(r => r.n), ['ana', 'Élan', 'Zoë']);
});

test('kit: monthGrid gives six weeks from the week start, marking other months and today', () => {
  const { monthGrid, today } = loadKit();
  const cells = monthGrid(2026, 11, 0);
  assert.equal(cells.length, 42);
  assert.equal(cells[0].date, '2026-11-01', 'November 2026 starts on a Sunday');
  assert.equal(cells[0].weekday, 0);
  assert.equal(cells.filter(c => !c.other).length, 30);
  assert.equal(cells[41].date, '2026-12-12');
  const monday = monthGrid(2026, 11, 1);
  assert.equal(monday[0].date, '2026-10-26');
  assert.equal(monday[0].weekday, 1);
  assert.equal(cells.filter(c => c.today).length, today().startsWith('2026-11') ? 1 : 0);
  assert.match(today(), /^\d{4}-\d{2}-\d{2}$/);
});

test('kit: groupBy, matches and the formatters', () => {
  const { groupBy, matches, number, date, ago } = loadKit();
  assert.deepEqual(Object.keys(groupBy([{ k: 'a' }, { k: 'b' }, { k: 'a' }, {}], 'k')), ['a', 'b', '']);
  assert.deepEqual(groupBy([{ d: '2026-11-03' }, { d: '2026-10-01' }], r => r.d.slice(0, 7))['2026-11'].length, 1);
  const record = { id: '1', data: { stage: 'new', n: 2, gone: null } };
  assert.equal(matches(record, { stage: 'new' }), true);
  assert.equal(matches(record, { stage: 'won' }), false);
  assert.equal(matches(record, { stage: { in: ['new', 'won'] } }), true);
  assert.equal(matches(record, { missing: null }), true, 'null finds records without the field');
  assert.equal(matches(record, { n: 2, stage: 'new' }), true);
  assert.equal(number(1234.5), '1,234.5');
  assert.equal(number(1234.5, 0), '1,235');
  assert.equal(loadKit('pt-BR').number(1234.5), '1.234,5');
  assert.equal(date('2026-11-03'), 'Nov 3, 2026');
  assert.equal(date('nonsense'), '');
  assert.equal(ago(new Date(Date.now() - 5 * 60000)), '5 minutes ago');
  assert.equal(ago(new Date(Date.now() - 3 * 86400000)), '3 days ago');
});

test('kit: live keeps the records in step with the collection and its subscription', async () => {
  const { live } = loadKit();
  let watcher;
  const records = [{ id: 'a', rev: 1, data: { stage: 'new' } }, { id: 'b', rev: 1, data: { stage: 'won' } }];
  const collection = { list: async () => records.slice(), subscribe: fn => { watcher = fn; return () => { watcher = undefined; }; } };
  const drawn = [];
  const store = live(collection, list => drawn.push(list.map(r => r.id + ':' + r.rev).join(',')));
  await store.ready;
  assert.deepEqual(drawn, ['a:1,b:1']);
  watcher({ type: 'update', id: 'a', rev: 2, record: { id: 'a', rev: 2, data: { stage: 'won' } } });
  watcher({ type: 'insert', id: 'c', rev: 1, record: { id: 'c', rev: 1, data: {} } });
  watcher({ type: 'remove', id: 'b', rev: null, record: null });
  assert.equal(drawn.at(-1), 'a:2,c:1');
  watcher({ type: 'reset' });
  await store.ready; await new Promise(r => setImmediate(r));
  assert.equal(drawn.at(-1), 'a:1,b:1', 'a reset lists again');
  store.stop();
  assert.equal(watcher, undefined, 'stop unsubscribes');
  // With a where, a record that stops matching leaves the list.
  let w2;
  const filtered = live({ list: async () => [{ id: 'a', rev: 1, data: { stage: 'new' } }], subscribe: fn => { w2 = fn; return () => {}; } }, () => {}, { where: { stage: 'new' } });
  await filtered.ready;
  w2({ type: 'update', id: 'a', rev: 2, record: { id: 'a', rev: 2, data: { stage: 'won' } } });
  assert.deepEqual(filtered.records, []);
  // A failing list calls onError and never throws out of ready.
  const errors = [];
  const broken = live({ list: async () => { throw new Error('outside'); }, subscribe: () => () => {} }, () => {}, { onError: e => errors.push(e.message) });
  await broken.ready;
  assert.deepEqual(errors, ['outside']);
});

// ---------------------------------------------------------------- the stylesheet and the tokens

function flatColors(doc) {
  return Object.fromEntries(Object.entries(doc.color).map(([role, value]) => [role, String(value).toLowerCase()]));
}
const ROLE_TO_VAR = { bg: 'bg', surface: 'surface', elevated: 'elevated', fill: 'fill', 'fill-hover': 'fill-hover', border: 'line', 'border-input': 'line-input', text: 'ink', 'text-soft': 'ink-soft', 'text-muted': 'muted', 'text-faint': 'faint', accent: 'accent', 'on-accent': 'on-accent', 'accent-ink': 'accent-ink', 'accent-soft': 'accent-soft', focus: 'focus', danger: 'danger', 'danger-ink': 'danger-ink', 'danger-soft': 'danger-soft', success: 'ok', 'success-ink': 'ok-ink', 'success-soft': 'ok-soft', warning: 'warn', 'warning-ink': 'warn-ink', 'warning-soft': 'warn-soft' };

/** The `--t-*` values declared inside one block of the stylesheet. */
function block(css, selector) {
  const at = css.indexOf(selector);
  assert.ok(at >= 0, selector);
  const open = css.indexOf('{', at), close = css.indexOf('}', open);
  return Object.fromEntries([...css.slice(open, close).matchAll(/--t-([a-z0-9-]+):\s*([^;]+);/g)].map(m => [m[1], m[2].trim().toLowerCase()]));
}

test('kit.css: the light and dark colours are the design tokens, and the dark ones are declared twice', () => {
  const light = block(KIT_CSS, ':root {');
  const darkAuto = block(KIT_CSS, ':root:not([data-tendly-theme="light"])');
  const darkForced = block(KIT_CSS, ':root[data-tendly-theme="dark"]');
  for (const [role, value] of Object.entries(flatColors(tokens))) {
    const name = role.startsWith('app-') ? role : ROLE_TO_VAR[role];
    assert.ok(name, `token ${role} has a kit variable`);
    assert.equal(light[name], value, `light --t-${name}`);
  }
  for (const [role, value] of Object.entries(flatColors(dark))) {
    const name = role.startsWith('app-') ? role : ROLE_TO_VAR[role];
    assert.equal(darkAuto[name], value, `dark (system) --t-${name}`);
    assert.equal(darkForced[name], value, `dark (forced) --t-${name}`);
  }
  assert.deepEqual(darkAuto, darkForced, 'the two dark blocks are the same');
  // Field borders use the input line, the focus ring is kept, touch targets grow.
  assert.match(KIT_CSS, /\.t-input[^{]*\{[^}]*border: 1px solid var\(--t-line-input\)/);
  assert.match(KIT_CSS, /:focus-visible \{ outline: 2px solid var\(--t-focus\)/);
  assert.match(KIT_CSS, /@media \(pointer: coarse\)[\s\S]*min-height: 44px/);
  assert.match(KIT_CSS, /@container t-app \(max-width: 640px\)/, 'the sidebar turns into a bottom bar by the app\'s own width');
  assert.match(KIT_CSS, /prefers-reduced-motion/);
});

// ---------------------------------------------------------------- the templates and the demo

const definedTags = [...KIT_JS.matchAll(/define\('(t-[a-z-]+)'/g)].map(m => m[1]);
const cssClasses = new Set([...KIT_CSS.matchAll(/\.(t-[a-z0-9-]+)/g)].map(m => m[1]));
const kitMembers = new Set(Object.keys(loadKit()));

function inlineScripts(html) {
  return [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
}

test('kit.js defines every element the stylesheet and the templates expect', () => {
  assert.deepEqual(definedTags, ['t-app', 't-nav', 't-view', 't-state', 't-pills', 't-modal', 't-table', 't-kanban', 't-chart', 't-calendar',
    't-sample-banner', 't-progress', 't-steps', 't-gallery', 't-checklist', 't-record-form', 't-list-editor', 't-fields-editor', 't-detail', 't-import']);
  for (const tag of definedTags) assert.ok(KIT_CSS.includes(tag), `kit.css styles ${tag}`);
  for (const tag of definedTags) if (tag !== 't-view') assert.ok(DEMO.includes(`<${tag}`) || DEMO.includes(`'${tag}'`), `kit-demo.html shows ${tag}`);
  for (const cls of ['t-nav-end', 't-drawer', 't-switch', 't-card-head', 't-kv', 't-segment', 't-md', 't-badge', 't-wikilink']) assert.ok(cssClasses.has(cls), `.${cls} is styled`);
  assert.match(KIT_CSS, /\.t-badge\.info/);
  assert.match(KIT_CSS, /\.t-badge\.violet/);
});

for (const [name, html] of [...Object.entries(templates), ['kit-demo', DEMO]]) {
  test(`template ${name}: uses only what the kit has, and its scripts compile`, () => {
    if (name !== 'issues') {
      assert.ok(html.includes('/api/hub/apps/kit.css') && html.includes('/api/hub/apps/kit.js'), 'uses the kit');
      if (name !== 'kit-demo') {
        assert.ok(html.includes('/api/hub/apps/sdk.js'), 'uses the SDK');
        assert.ok(html.indexOf('sdk.js') < html.indexOf('kit.js'), 'the SDK first');
        assert.ok(html.includes('tendly.db.collection('), 'keeps its records in a collection');
        assert.ok(html.includes('data-app-color="{{COLOR}}"'), 'takes the app colour');
        assert.ok(/\{\{NAME\}\}/.test(html) && /\{\{LETTER\}\}/.test(html) && /\{\{DESCRIPTION\}\}/.test(html));
        if (html.includes('<form')) assert.ok(html.includes('holdReload(true)') && html.includes('holdReload(false)'), 'a form holds reloads while typing');
      }
      for (const tag of new Set([...html.matchAll(/<(t-[a-z-]+)/g)].map(m => m[1]))) assert.ok(definedTags.includes(tag), `<${tag}> is defined`);
      for (const member of new Set([...html.matchAll(/tkit\.([a-zA-Z]+)/g)].map(m => m[1]))) assert.ok(kitMembers.has(member), `tkit.${member} exists`);
      for (const cls of new Set([...html.matchAll(/class="([^"]*)"/g)].flatMap(m => m[1].split(/\s+/)).filter(c => c.startsWith('t-')))) {
        assert.ok(cssClasses.has(cls), `.${cls} is styled by kit.css`);
      }
      for (const cls of new Set([...html.matchAll(/tkit\.h\('[a-z0-9]+', \{ class: '([^']*)'/g)].flatMap(m => m[1].split(/\s+/)).filter(c => c.startsWith('t-') && !c.includes('+')))) {
        assert.ok(cssClasses.has(cls), `.${cls} (made in script) is styled by kit.css`);
      }
    }
    assert.ok(!html.includes('innerHTML') && !html.includes('window.confirm(') && !/\blocalStorage\b/.test(html), 'no raw HTML, no native confirm, no localStorage');
    const scripts = inlineScripts(html);
    assert.ok(scripts.length >= 1);
    for (const script of scripts) assert.doesNotThrow(() => new vm.Script(script, { filename: `${name}.html` }));
  });
}

test('templates: the seven the builder offers exist, plus the issues list', () => {
  assert.deepEqual(Object.keys(templates).sort(), ['blank', 'calendar', 'dashboard', 'document', 'form', 'issues', 'kanban', 'table']);
});
