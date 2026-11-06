// Apps, stage B: an app in full screen, "Chat" beside it, reloading on its
// own with Undo, and the errors an app reports with "Ask for a fix".
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { createServer } from 'vite';
import vue from '@vitejs/plugin-vue';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { NOTICE_MS, changeNotice, changedFiles, latestChange, liveMessage, onChange, onLiveReconnect, undoChange, watchApp } from './app-live.ts';
import { FIX_ERRORS, MAX_ERRORS, appFilePath, appFilesPrefix, appScreen, errorPlace, fixRequest, kindLabel, readAppMessage, stackLines, withError } from './app-errors.ts';
import { APP_MIN, CHAT_DEFAULT, CHAT_MIN, appAttachment, chatPaneFor, clampChatWidth, fillComposer, maxChatWidth, onAppChatRequest, readSideChats, requestAppChat, writeSideChats } from './app-chat.ts';
import { appPagePath } from './apps.ts';
import { contextFromPanes, openContext, setPageContext } from './open-context.ts';
import { sidebarLayout } from './rail.ts';
import { chatDrafts } from '../chat-model.ts';
import { appPane, sessionPane } from '../pane-context.ts';

const here = new URL('./', import.meta.url);
const read = name => readFileSync(new URL(name, here), 'utf8');
const SDK = readFileSync(new URL('../../../../../crates/server/src/hub/apps/sdk.js', here), 'utf8');
const NEW_COMPONENTS = ['AppView.vue', 'AppFullPage.vue'];
const COMPONENTS = [...NEW_COMPONENTS, 'AppPane.vue', 'AppsPage.vue'];

const APP = { workspace_id: 'w1', workspace_name: 'Site', slug: 'pipeline', name: 'Pipeline', letter: 'P', color: 'blue', description: 'Deals by stage', entry: 'index.html', url: '/api/hub/apps/w1/pipeline/files/index.html', code_path: 'apps/pipeline/', updated_at: '2026-11-06T10:00:00Z' };
const change = (id, more = {}) => ({ id, at: '2026-11-06T12:00:00.000Z', paths: ['apps/pipeline/index.html'], count: 1, undoable: true, undo_of: null, redo: false, ...more });
const event = (slug, value, workspace = 'w1') => ({ type: 'hub', event: 'app-changed', workspace_id: workspace, slug, change: value });

// ---------------------------------------------------------------- reload on its own

test('a change reaches the panes of that app, and only those', () => {
  const heard = [], other = [];
  const stop = watchApp(APP, value => heard.push(value.id));
  const stopOther = watchApp({ workspace_id: 'w1', slug: 'crm' }, value => other.push(value.id));
  // Two panes of the same app both hear it.
  const second = [];
  const stopSecond = watchApp(APP, value => second.push(value.id));
  liveMessage(event('pipeline', change('c1')));
  liveMessage(event('crm', change('c2')));
  liveMessage(event('pipeline', change('c3'), 'w2'));
  assert.deepEqual([heard, second, other], [['c1'], ['c1'], ['c2']]);
  // What the socket also carries, and anything malformed, is left alone.
  for (const message of [null, 'text', { type: 'notice', id: 'n' }, { type: 'hub', event: 'other', workspace_id: 'w1', slug: 'pipeline', change: change('x') }, event('pipeline', { at: 'no id' }), event('pipeline', null), { type: 'hub', event: 'app-changed', slug: 'pipeline', change: change('y') }]) liveMessage(message);
  assert.deepEqual(heard, ['c1']);
  // A pane that fails does not keep the next one from reloading.
  const stopBroken = watchApp(APP, () => { throw new Error('boom'); });
  stop(); stopBroken();
  const late = watchApp(APP, value => heard.push(`late:${value.id}`));
  const broken = watchApp(APP, () => { throw new Error('boom'); });
  liveMessage(event('pipeline', change('c4')));
  assert.deepEqual(heard, ['c1', 'late:c4']);
  assert.deepEqual(second, ['c1', 'c4']);
  stopSecond(); stopOther(); late(); broken();
  liveMessage(event('pipeline', change('c5')));
  assert.deepEqual(second, ['c1', 'c4'], 'a closed pane hears nothing');
  // A change is read defensively: missing fields get safe values.
  const seen = [];
  const stopLoose = watchApp(APP, value => seen.push(value));
  liveMessage(event('pipeline', { id: 'c6', paths: ['a', 3], undoable: 'yes' }));
  assert.deepEqual(seen, [{ id: 'c6', at: '', paths: ['a'], count: 0, undoable: false, undo_of: null, redo: false }]);
  stopLoose();
});

test('every (re)connection of the socket asks what was missed', () => {
  let asked = 0;
  const stop = onLiveReconnect(() => { asked++; });
  const stopBroken = onLiveReconnect(() => { throw new Error('boom'); });
  liveMessage({ type: 'snapshot', requests: [] });
  liveMessage({ type: 'snapshot', requests: [] });
  assert.equal(asked, 2);
  stop(); stopBroken();
  liveMessage({ type: 'snapshot', requests: [] });
  assert.equal(asked, 2);
});

test('a frame reloads for a change it does not show yet, and waits while the app holds reloads', () => {
  assert.equal(onChange({ seen: 'c1', held: false }, change('c1')), 'ignore');
  assert.equal(onChange({ seen: 'c1', held: true }, change('c1')), 'ignore');
  assert.equal(onChange({ seen: 'c1', held: false }, change('c2')), 'reload');
  assert.equal(onChange({ seen: undefined, held: false }, change('c2')), 'reload');
  assert.equal(onChange({ seen: 'c1', held: true }, change('c2')), 'wait', 'unsaved input is not thrown away');
  assert.equal(NOTICE_MS, 60_000);
});

test('the notice says what happened and offers the way back', () => {
  assert.deepEqual(changeNotice(change('c1')), { text: 'Updated just now', action: 'Undo' });
  assert.deepEqual(changeNotice(change('c1', { undoable: false })), { text: 'Updated just now', action: undefined });
  // The undo is a change too: undoing it is the redo.
  assert.deepEqual(changeNotice(change('c2', { undo_of: 'c1' })), { text: 'Change undone', action: 'Redo' });
  assert.deepEqual(changeNotice(change('c2', { undo_of: 'c1', undoable: false })), { text: 'Change undone', action: undefined });
  // After a redo the files are as the change left them: it reads as an update again.
  assert.deepEqual(changeNotice(change('c3', { undo_of: 'c2', redo: true })), { text: 'Updated just now', action: 'Undo' });
  assert.equal(changedFiles(change('c1', { paths: ['apps/pipeline/index.html', 'apps/pipeline/js/app.js'], count: 2 }), 'pipeline'), 'index.html, js/app.js');
  assert.equal(changedFiles(change('c1', { paths: ['apps/pipeline/a', 'apps/pipeline/b', 'apps/pipeline/c'], count: 30 }), 'pipeline', 2), 'a, b +28');
  assert.equal(changedFiles(change('c1', { paths: [], count: 0 }), 'pipeline'), '');
});

test('the latest change is asked for, and undo is a POST for that change of that app', async () => {
  const calls = [];
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET', client: init.headers?.['X-Tendly-Client'] });
    if (String(url).endsWith('/undo')) return new Response(JSON.stringify({ undone: true, restored: ['apps/pipeline/index.html'], removed: [], skipped: [] }), { status: 200 });
    return new Response(JSON.stringify(String(url).includes('/crm/') ? { latest: null } : { latest: change('c9') }), { status: 200 });
  };
  try {
    assert.equal((await latestChange(APP)).id, 'c9');
    assert.equal(await latestChange({ workspace_id: 'w1', slug: 'crm' }), null);
    const result = await undoChange(APP, 'c9');
    assert.deepEqual(result.restored, ['apps/pipeline/index.html']);
    assert.deepEqual(calls.map(call => [call.method, call.url]), [
      ['GET', '/api/hub/apps/w1/pipeline/changes'], ['GET', '/api/hub/apps/w1/crm/changes'], ['POST', '/api/hub/apps/w1/pipeline/changes/c9/undo'],
    ]);
    assert.equal(calls[2].client, 'web');
  } finally { globalThis.fetch = previous; }
});

// ---------------------------------------------------------------- what an app reports

const FRAME = { frame: true };
const from = (data, more = {}) => ({ data, origin: 'http://127.0.0.1:28789', source: FRAME, ...more });
const EXPECTED = { origin: 'http://127.0.0.1:28789', frame: FRAME };
const report = (more = {}) => ({ source: 'tendly-app', v: 1, type: 'error', kind: 'error', message: 'x is not defined', file: 'http://127.0.0.1:28789/api/hub/apps/w1/pipeline/files/js/app.js', line: 12, column: 4, stack: '', page: '/api/hub/apps/w1/pipeline/files/index.html#/board', at: 1, ...more });

test('only the frame of the app, on this origin, is listened to', () => {
  const message = readAppMessage(from(report()), EXPECTED, APP);
  assert.equal(message.type, 'error');
  assert.deepEqual([message.error.file, message.error.line, message.error.column, message.error.page, message.error.count], ['apps/pipeline/js/app.js', 12, 4, 'index.html#/board', 1]);
  // Another origin, another window, no frame at all, or another shape: nothing.
  assert.equal(readAppMessage(from(report(), { origin: 'https://evil.example' }), EXPECTED, APP), undefined);
  assert.equal(readAppMessage(from(report(), { source: { other: true } }), EXPECTED, APP), undefined);
  assert.equal(readAppMessage(from(report()), { origin: EXPECTED.origin, frame: undefined }, APP), undefined);
  for (const data of [null, 'error', 42, { type: 'error' }, report({ source: 'someone-else' }), report({ v: 2 }), report({ kind: 'warning' }), report({ message: '   ' }), report({ type: 'navigate' }), { source: 'tendly-app', v: 1, type: 'location' }]) {
    assert.equal(readAppMessage(from(data), EXPECTED, APP), undefined, JSON.stringify(data));
  }
  // Odd values are made safe rather than trusted.
  const odd = readAppMessage(from(report({ line: 'twelve', column: -3, file: 7, stack: null, message: 'm'.repeat(5000) })), EXPECTED, APP).error;
  assert.deepEqual([odd.line, odd.column, odd.file, odd.stack, odd.message.length], [0, 0, '', '', 2000]);
  assert.deepEqual(readAppMessage(from({ source: 'tendly-app', v: 1, type: 'location', page: '/api/hub/apps/w1/pipeline/files/index.html', fresh: true }), EXPECTED, APP), { type: 'location', page: '/api/hub/apps/w1/pipeline/files/index.html', fresh: true });
  assert.equal(readAppMessage(from({ source: 'tendly-app', v: 1, type: 'location', page: '/x' }), EXPECTED, APP).fresh, false);
  assert.deepEqual(readAppMessage(from({ source: 'tendly-app', v: 1, type: 'hold-reload', on: true }), EXPECTED, APP), { type: 'hold-reload', on: true });
  assert.deepEqual(readAppMessage(from({ source: 'tendly-app', v: 1, type: 'hold-reload', on: 'yes' }), EXPECTED, APP), { type: 'hold-reload', on: false });
});

test('an address inside the app becomes the file an agent would open', () => {
  assert.equal(appFilesPrefix(APP), '/api/hub/apps/w1/pipeline/files/');
  assert.equal(appFilePath('http://127.0.0.1:28789/api/hub/apps/w1/pipeline/files/js/app.js?v=2', APP), 'apps/pipeline/js/app.js');
  assert.equal(appFilePath('/api/hub/apps/w1/pipeline/files/caf%C3%A9.js', APP), 'apps/pipeline/café.js');
  assert.equal(appFilePath('https://cdn.jsdelivr.net/npm/lit-html@3.2.1/+esm?x=1', APP), 'https://cdn.jsdelivr.net/npm/lit-html@3.2.1/+esm');
  assert.equal(appFilePath('/api/hub/apps/w1/other/files/app.js', APP), '/api/hub/apps/w1/other/files/app.js');
  assert.equal(appFilePath('', APP), '');
  assert.equal(appScreen('/api/hub/apps/w1/pipeline/files/pages/deal.html?id=3#notes', APP), 'pages/deal.html?id=3#notes');
  assert.equal(appScreen('/somewhere/else', APP), '');
  assert.equal(appScreen('', APP), '');
  assert.equal(errorPlace({ file: 'apps/pipeline/app.js', line: 12, column: 4 }), 'apps/pipeline/app.js:12:4');
  assert.equal(errorPlace({ file: 'apps/pipeline/app.js', line: 12, column: 0 }), 'apps/pipeline/app.js:12');
  assert.equal(errorPlace({ file: 'apps/pipeline/app.js', line: 0, column: 0 }), 'apps/pipeline/app.js');
  assert.equal(errorPlace({ file: '', line: 3, column: 1 }), '');
});

test('the same error is counted once more, and the list has a ceiling', () => {
  const first = readAppMessage(from(report()), EXPECTED, APP).error;
  let list = withError([], first);
  list = withError(list, { ...first, at: 9 });
  assert.deepEqual([list.length, list[0].count, list[0].at], [1, 2, 9]);
  list = withError(list, { ...first, line: 13 });
  list = withError(list, { ...first, kind: 'console' });
  assert.deepEqual(list.map(error => error.count), [2, 1, 1]);
  let many = [];
  for (let index = 0; index < MAX_ERRORS + 20; index++) many = withError(many, { ...first, message: `error ${index}` });
  assert.equal(many.length, MAX_ERRORS);
  // A repeat of one already listed still counts when the list is full.
  assert.equal(withError(many, { ...first, message: 'error 0' })[0].count, 2);
});

test('"Ask for a fix" writes the app, the screen, and each error with its file and line', () => {
  const t = (key, values = {}) => key.replace(/\{(\w+)\}/g, (_, name) => String(values[name]));
  const stack = 'ReferenceError: x is not defined\n    at draw (http://127.0.0.1:28789/api/hub/apps/w1/pipeline/files/js/app.js:12:4)\n    at http://127.0.0.1:28789/api/hub/apps/w1/pipeline/files/index.html:40:3\n    at more (http://127.0.0.1:28789/api/hub/apps/w1/pipeline/files/js/app.js:50:1)\n    at last (http://127.0.0.1:28789/api/hub/apps/w1/pipeline/files/js/app.js:60:1)';
  const error = { ...readAppMessage(from(report({ message: 'ReferenceError: x is not defined\nsecond line', stack })), EXPECTED, APP).error, count: 3 };
  assert.deepEqual(stackLines(error, APP), ['at draw (apps/pipeline/js/app.js:12:4)', 'at apps/pipeline/index.html:40:3', 'at more (apps/pipeline/js/app.js:50:1)']);
  const text = fixRequest(APP, [error], 'index.html#/board', t);
  const lines = text.split('\n');
  assert.equal(lines[0], 'The app "Pipeline" (in apps/pipeline/) is showing errors. Find the cause and fix it, please.');
  assert.ok(lines.includes('Screen open: apps/pipeline/index.html#/board'));
  assert.ok(lines.includes('1. [Error] ReferenceError: x is not defined — apps/pipeline/js/app.js:12:4 (×3)'), text);
  assert.ok(lines.includes('   at draw (apps/pipeline/js/app.js:12:4)'));
  assert.doesNotMatch(text, /127\.0\.0\.1|\/api\/hub/, 'no address of this machine goes to the agent');
  // Without a screen from the app, the page an error happened on is used.
  assert.match(fixRequest(APP, [error], '', t), /Screen open: apps\/pipeline\/index\.html#\/board/);
  assert.doesNotMatch(fixRequest(APP, [{ ...error, page: '' }], '', t), /Screen open/);
  // Many errors: the latest few are spelled out and the rest are counted.
  const many = Array.from({ length: FIX_ERRORS + 3 }, (_, index) => ({ ...error, message: `error ${index}`, stack: '', count: 1 }));
  const long = fixRequest(APP, many, '', t);
  assert.equal((long.match(/^\d+\. /gm) ?? []).length, FIX_ERRORS);
  assert.match(long, /error 7/);
  assert.doesNotMatch(long, /error 2\b/);
  assert.match(long, /\(3 earlier errors left out\.\)/);
  for (const kind of ['error', 'unhandledrejection', 'console', 'load']) assert.ok(kindLabel(kind));
});

// ---------------------------------------------------------------- the SDK, run as an app page would run it

function runSdk({ framed = true, path = '/api/hub/apps/w1/pipeline/files/index.html', hash = '' } = {}) {
  const posted = [], listeners = {}, logged = [];
  const win = { addEventListener: (type, handler) => { (listeners[type] ??= []).push(handler); } };
  win.parent = framed ? { postMessage: (message, origin) => posted.push({ message: JSON.parse(JSON.stringify(message)), origin }) } : win;
  const context = vm.createContext({ window: win, location: { pathname: path, search: '', hash, origin: 'http://127.0.0.1:28789' }, console: { error: (...args) => logged.push(args) }, fetch: async () => { throw new Error('offline'); } });
  vm.runInContext(SDK, context);
  const fire = (type, value) => { for (const handler of listeners[type] ?? []) handler(value); };
  return { posted, listeners, logged, win, context, fire, make: code => vm.runInContext(code, context) };
}

test('the SDK tells the Tendly page that frames the app, and nobody else', () => {
  const page = runSdk();
  // The first thing a page says: where it is, freshly loaded.
  assert.deepEqual(page.posted[0], { message: { type: 'location', page: '/api/hub/apps/w1/pipeline/files/index.html', fresh: true, source: 'tendly-app', v: 1 }, origin: 'http://127.0.0.1:28789' });
  page.fire('error', { message: 'Uncaught ReferenceError: x is not defined', filename: 'http://127.0.0.1:28789/api/hub/apps/w1/pipeline/files/app.js', lineno: 7, colno: 3, error: page.make('new ReferenceError("x is not defined")') });
  const sent = page.posted[1];
  assert.equal(sent.origin, 'http://127.0.0.1:28789', 'addressed to this origin only, never "*"');
  assert.deepEqual([sent.message.type, sent.message.kind, sent.message.message, sent.message.line, sent.message.column], ['error', 'error', 'Uncaught ReferenceError: x is not defined', 7, 3]);
  assert.match(sent.message.file, /\/files\/app\.js$/);
  assert.match(sent.message.stack, /ReferenceError: x is not defined/);
  assert.equal(sent.message.page, '/api/hub/apps/w1/pipeline/files/index.html');
  // A rejected promise nobody caught.
  page.fire('unhandledrejection', { reason: page.make('new Error("no network")') });
  assert.deepEqual([page.posted[2].message.kind, page.posted[2].message.message], ['unhandledrejection', 'Error: no network']);
  // console.error still prints, and is reported with what it was given.
  page.context.console.error('Could not save', page.make('({ status: 500 })'));
  assert.equal(page.logged.length, 1, 'the real console.error ran');
  assert.deepEqual([page.posted[3].message.kind, page.posted[3].message.message], ['console', 'Could not save {"status":500}']);
  // A script of the app that did not load.
  page.fire('error', { target: { nodeType: 1, src: 'http://127.0.0.1:28789/api/hub/apps/w1/pipeline/files/missing.js' } });
  assert.deepEqual([page.posted[4].message.kind, page.posted[4].message.message], ['load', 'Failed to load http://127.0.0.1:28789/api/hub/apps/w1/pipeline/files/missing.js']);
  // Moving inside the app says where it is now, not that it loaded again.
  page.context.location.hash = '#/board';
  page.fire('hashchange', {});
  assert.deepEqual([page.posted[5].message.type, page.posted[5].message.page, page.posted[5].message.fresh], ['location', '/api/hub/apps/w1/pipeline/files/index.html#/board', false]);
  // Holding and releasing reloads.
  assert.equal(page.win.tendly.host.framed, true);
  page.win.tendly.host.holdReload(true);
  page.win.tendly.host.holdReload(false);
  page.win.tendly.host.holdReload();
  assert.deepEqual(page.posted.slice(6).map(item => [item.message.type, item.message.on]), [['hold-reload', true], ['hold-reload', false], ['hold-reload', true]]);
  assert.ok(page.posted.every(item => item.origin === 'http://127.0.0.1:28789'));
  // The data API is where it always was.
  assert.deepEqual(JSON.parse(JSON.stringify(page.win.tendly.app)), { workspaceId: 'w1', slug: 'pipeline' });
  for (const name of ['get', 'set', 'list', 'remove']) assert.equal(typeof page.win.tendly.data[name], 'function');
});

test('the SDK stays quiet in a tab of its own, and cannot flood the page', () => {
  const alone = runSdk({ framed: false });
  assert.deepEqual(alone.listeners, {}, 'nothing is listened to');
  alone.context.console.error('still prints');
  assert.equal(alone.logged.length, 1);
  alone.win.tendly.host.holdReload(true);
  assert.deepEqual(alone.posted, []);
  assert.equal(alone.win.tendly.host.framed, false);
  // A page that is not a Tendly app (opened from disk, say) reports nothing either.
  const elsewhere = runSdk({ path: '/some/other/page.html' });
  assert.deepEqual(elsewhere.posted, []);
  assert.equal(elsewhere.win.tendly.app, null);

  const noisy = runSdk();
  for (let index = 0; index < 200; index++) noisy.context.console.error(`error ${index}`);
  assert.equal(noisy.posted.filter(item => item.message.type === 'error').length, 50);
  assert.equal(noisy.logged.length, 200);
  // The same error twice in a row is said once.
  const twice = runSdk();
  twice.context.console.error('same'); twice.context.console.error('same'); twice.context.console.error('other');
  assert.deepEqual(twice.posted.filter(item => item.message.type === 'error').map(item => item.message.message), ['same', 'other']);
  // Long messages are cut before they travel.
  const long = runSdk();
  long.context.console.error('m'.repeat(9000));
  assert.equal(long.posted.at(-1).message.message.length, 2001);
});

// ---------------------------------------------------------------- the chat beside the app

test('the chat column keeps a usable width and leaves room for the app', () => {
  assert.equal(clampChatWidth(420, 1400), 420);
  assert.equal(clampChatWidth(100, 1400), CHAT_MIN);
  assert.equal(clampChatWidth(5000, 1400), 1400 - APP_MIN);
  assert.equal(maxChatWidth(1400), 1400 - APP_MIN);
  assert.equal(clampChatWidth(NaN, 1400), CHAT_DEFAULT);
  // A page too narrow for both: the column takes its least, and the view stacks them.
  assert.equal(clampChatWidth(420, 500), CHAT_MIN);
  assert.equal(maxChatWidth(300), CHAT_MIN);
});

test('this browser remembers the column: its width, and each app\'s conversation', () => {
  const store = { values: {}, getItem(key) { return this.values[key] ?? null; }, setItem(key, value) { this.values[key] = value; } };
  assert.deepEqual(readSideChats(store), { width: CHAT_DEFAULT, chats: {}, open: {} });
  writeSideChats({ width: 512, chats: { 'w1/pipeline': 's1' }, open: { 'w1/pipeline': true } }, store);
  assert.deepEqual(readSideChats(store), { width: 512, chats: { 'w1/pipeline': 's1' }, open: { 'w1/pipeline': true } });
  // Whatever is found there is made safe.
  store.values['tendly.hub.app-chat.v1'] = JSON.stringify({ width: 'wide', chats: { a: 3, b: 's2', c: '' }, open: { a: 'yes', b: true }, extra: 1 });
  assert.deepEqual(readSideChats(store), { width: CHAT_DEFAULT, chats: { b: 's2' }, open: { b: true } });
  store.values['tendly.hub.app-chat.v1'] = '{not json';
  assert.deepEqual(readSideChats(store), { width: CHAT_DEFAULT, chats: {}, open: {} });
  store.values['tendly.hub.app-chat.v1'] = 'null';
  assert.deepEqual(readSideChats(store), { width: CHAT_DEFAULT, chats: {}, open: {} });
  // No storage at all (a private window): defaults, and saving is a no-op.
  assert.deepEqual(readSideChats(undefined), { width: CHAT_DEFAULT, chats: {}, open: {} });
  writeSideChats({ width: 1, chats: {}, open: {} }, { getItem: () => null, setItem: () => { throw new Error('full'); } });
});

test('a composer is filled, never sent: the app as a chip, the errors as text', () => {
  const chip = appAttachment(APP);
  assert.deepEqual(chip, { path: 'apps/pipeline/', name: 'Pipeline' });
  fillComposer('s-new', { attach: chip });
  assert.deepEqual(chatDrafts.get('s-new'), { text: '', attachments: [{ path: 'apps/pipeline/', name: 'Pipeline', bytes: 0 }] });
  // Asked again, the chip is not doubled; text goes after what is already written.
  fillComposer('s-new', { attach: chip, text: 'Fix the title.' });
  fillComposer('s-new', { attach: chip, text: '  Then the footer.  ' });
  const draft = chatDrafts.get('s-new');
  assert.equal(draft.attachments.length, 1);
  assert.equal(draft.text, 'Fix the title.\n\nThen the footer.');
  assert.equal(draft.pending, undefined, 'nothing was put on the wire');
  // What the person had typed stays, with the request below it.
  chatDrafts.get('s-typed').text = 'While you are there,\n';
  fillComposer('s-typed', { text: 'the app shows an error.' });
  assert.equal(chatDrafts.get('s-typed').text, 'While you are there,\n\nthe app shows an error.');
  fillComposer('s-empty', { text: '   ' });
  assert.deepEqual(chatDrafts.get('s-empty'), { text: '' });
  // The modules that fill a composer never call the routes that send or start.
  for (const file of ['app-chat.ts', 'app-errors.ts', 'app-live.ts', 'AppView.vue', 'AppFullPage.vue', 'AppPane.vue']) {
    assert.doesNotMatch(read(file), /\/hub\/start|startConversation|conversation\/message/, file);
  }
});

test('on the Mesa, "the conversation open beside" is a chat of the app\'s project', () => {
  const session = (id, more = {}) => ({ id, workspace_id: 'w1', provider: 'claude_code', title: id, updated_at: '2026-11-06T10:00:00Z', ...more });
  const sessions = [session('old'), session('recent', { updated_at: '2026-11-06T12:00:00Z' }), session('elsewhere', { workspace_id: 'w2', updated_at: '2026-11-06T13:00:00Z' }), session('term', { provider: 'terminal', updated_at: '2026-11-06T14:00:00Z' }), session('gone', { archived_at: '2026-11-06T15:00:00Z', updated_at: '2026-11-06T15:00:00Z' })];
  const panes = [appPane(APP), ...sessions.map(sessionPane)];
  assert.equal(chatPaneFor(panes, sessions, 'w1').session.id, 'recent');
  assert.equal(chatPaneFor(panes, sessions, 'w1', 'session-old').session.id, 'old', 'the one in focus wins');
  assert.equal(chatPaneFor(panes, sessions, 'w1', 'session-elsewhere').session.id, 'recent', 'a chat of another project is not it');
  assert.equal(chatPaneFor([appPane(APP), sessionPane(sessions[2]), sessionPane(sessions[3]), sessionPane(sessions[4])], sessions, 'w1'), undefined);
  assert.equal(chatPaneFor(panes, [], 'w1'), undefined, 'a tab whose session is gone is not it');
});

test('an app pane asks the Mesa for a conversation through one door', async () => {
  const asked = [];
  onAppChatRequest(async request => { asked.push(request); });
  await requestAppChat({ workspaceId: 'w1', slug: 'pipeline', name: 'Pipeline', paneId: 'app-w1:pipeline', text: 'fix it' });
  assert.deepEqual(asked, [{ workspaceId: 'w1', slug: 'pipeline', name: 'Pipeline', paneId: 'app-w1:pipeline', text: 'fix it' }]);
  onAppChatRequest(() => {});
});

test('the app on the page is offered as context before what is open on the Mesa', () => {
  openContext.items = contextFromPanes([appPane({ workspace_id: 'w1', slug: 'crm', name: 'CRM' })]);
  assert.deepEqual(openContext.items.map(item => item.path), ['apps/crm/']);
  setPageContext([{ workspaceId: 'w1', path: 'apps/pipeline/', name: 'Pipeline' }]);
  assert.deepEqual(openContext.items.map(item => item.path), ['apps/pipeline/', 'apps/crm/']);
  // The same app open in both places is offered once.
  setPageContext([{ workspaceId: 'w1', path: 'apps/crm/', name: 'CRM' }]);
  assert.deepEqual(openContext.items.map(item => item.path), ['apps/crm/']);
  setPageContext([]);
  openContext.items = [];
  assert.deepEqual(openContext.items, []);
});

test('an app has an address of its own, and its page keeps the rail alone', () => {
  assert.equal(appPagePath(APP), '/apps/w1/pipeline');
  assert.equal(appPagePath({ workspace_id: 'a b', slug: 'x' }), '/apps/a%20b/x');
  const wide = { wide: true, mobile: false, preference: 'icons' };
  assert.equal(sidebarLayout({ ...wide, page: 'app' }), 'app');
  assert.equal(sidebarLayout({ ...wide, page: 'app', preference: 'expanded' }), 'app');
  assert.equal(sidebarLayout({ ...wide, page: 'apps' }), 'expanded');
  assert.equal(sidebarLayout({ ...wide, page: undefined }), 'rail');
  assert.equal(sidebarLayout({ wide: false, mobile: true, preference: 'icons', page: 'app' }), 'expanded', 'a phone keeps its drawer');
});

// ---------------------------------------------------------------- what the components draw

let server, View, Rail, i18n, store;
before(async () => {
  server = await createServer({ configFile: false, root: fileURLToPath(new URL('../../../', import.meta.url)), plugins: [vue()], server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', optimizeDeps: { noDiscovery: true } });
  View = (await server.ssrLoadModule('/src/features/hub/AppView.vue')).default;
  Rail = (await server.ssrLoadModule('/src/features/hub/IconRail.vue')).default;
  i18n = await server.ssrLoadModule('/src/i18n/index.ts');
  store = await server.ssrLoadModule('/src/features/hub/apps.ts');
});
after(async () => { await server?.close(); });
const render = (component, props) => renderToString(createSSRApp(component, props));
const tags = (html, pattern) => html.match(pattern) ?? [];
function stage(list, locale = 'en', more = {}) {
  i18n.useI18n().setLocale(locale);
  Object.assign(store.apps, { list, loaded: true, loading: false, errors: [], error: '', ...more });
}
const PAGE = { mode: 'page', workspaceId: 'w1', workspaceName: 'Site', slug: 'pipeline' };

test('the full-screen header names every action, in the order of the plan', async () => {
  stage([APP]);
  const html = await render(View, PAGE);
  assert.match(html, /<section class="app-view is-page" aria-label="Pipeline"/);
  const bar = /<header class="app-view-bar"[\s\S]*?<\/header>/.exec(html)[0];
  const buttons = tags(bar, /<button[^>]*>/g);
  assert.deepEqual(buttons.map(button => /aria-label="([^"]*)"/.exec(button)?.[1]), ['Show apps/pipeline/ in the file panel', 'Chat', 'Open on the Mesa', 'Reload', 'Copy link', 'Open in new tab']);
  for (const button of buttons) { assert.match(button, /type="button"/); assert.match(button, /title="[^"]+"/); }
  assert.match(bar, /<strong class="app-view-name"[^>]*>Pipeline<\/strong>/);
  assert.match(bar, /code in apps\/pipeline\//);
  assert.match(bar, /<span class="app-tile"[^>]*>P<\/span>/);
  // Chat says whether its column is open.
  assert.match(buttons[1], /aria-pressed="false"/);
  const pressed = /<button[^>]*aria-label="Chat"[^>]*>/.exec(await render(View, { ...PAGE, chatOpen: true }))[0];
  assert.match(pressed, /aria-pressed="true"/);
  assert.match(pressed, /class="[^"]*\bprimary\b/);
  // No errors yet: no count, no list. No change yet: no notice.
  assert.doesNotMatch(html, /app-view-errors|app-view-notice/);
  // The app itself, framed as before.
  assert.match(html, /<div class="app-view-body"/);
});

test('a pane keeps its slim bar: Chat, reload, copy link and open outside', async () => {
  stage([APP]);
  const html = await render(View, { ...PAGE, mode: 'pane' });
  const bar = /<header class="app-view-bar"[\s\S]*?<\/header>/.exec(html)[0];
  assert.deepEqual(tags(bar, /<button[^>]*>/g).map(button => /aria-label="([^"]*)"/.exec(button)?.[1]), ['Chat', 'Reload', 'Copy link', 'Open in new tab']);
  assert.match(bar, /<code class="app-view-path"[^>]*>apps\/pipeline\/<\/code>/);
  assert.doesNotMatch(bar, /aria-pressed/);
  assert.doesNotMatch(bar, /Open on the Mesa/);
  // Before the list of apps is read, the tab's own name and tile are shown.
  stage([], 'en', { loaded: false });
  const early = await render(View, { ...PAGE, mode: 'pane', fallback: { name: 'Funil', letter: 'F', color: 'teal' } });
  assert.match(early, /<strong class="app-view-name"[^>]*>Funil<\/strong>/);
  assert.match(early, /data-app-color="teal"/);
  assert.match(early, /role="status"[^>]*>Loading…/);
});

test('an app that is gone says so, with a way out that fits where it is shown', async () => {
  stage([]);
  const page = await render(View, PAGE);
  assert.match(page, /This app is not here anymore/);
  assert.match(page, /No app was found in apps\/pipeline\/ of Site\./);
  assert.match(page, /See all apps/);
  assert.doesNotMatch(page, /Remove tab|<iframe/);
  const pane = await render(View, { ...PAGE, mode: 'pane' });
  assert.match(pane, /Remove tab/);
  assert.doesNotMatch(pane, /See all apps/);
  // A broken app.json is explained with the server's reason.
  stage([], 'en', { errors: [{ workspace_id: 'w1', slug: 'pipeline', message: 'app.json needs a "name"' }] });
  assert.match(await render(View, PAGE), /Tendly could not read apps\/pipeline\/: app\.json needs a &quot;name&quot;/);
  // A list that could not be read is not "gone".
  stage([], 'en', { error: 'Offline' });
  const offline = await render(View, PAGE);
  assert.match(offline, /Could not load the apps/);
  assert.doesNotMatch(offline, /not here anymore/);
});

test('the header speaks Portuguese', async () => {
  stage([APP], 'pt-BR');
  const html = await render(View, PAGE);
  for (const text of ['aria-label="Abrir na Mesa"', 'aria-label="Recarregar"', 'aria-label="Copiar link"', 'código em apps/pipeline/', 'title="Copiar o link deste app"']) assert.ok(html.includes(text), text);
  stage([APP]);
});

test('in full screen the rail stands alone: the app is current and the panel handle is gone', async () => {
  stage([APP]);
  const props = { currentPage: 'app', currentApp: 'w1/pipeline', inboxUnread: 0, panelOpen: false, workspaces: [] };
  const alone = await render(Rail, { ...props, panel: false });
  assert.doesNotMatch(alone, /rail-panel-toggle/);
  assert.match(/<button[^>]*data-rail-app="w1\/pipeline"[^>]*>/.exec(alone)[0], /aria-current="true"/);
  assert.doesNotMatch(alone, /aria-current="page"/, 'no page of the menu is the current one');
  assert.match(await render(Rail, props), /rail-panel-toggle/, 'on the Mesa the handle stays');
});

// ---------------------------------------------------------------- how it is wired

test('the app has a route, and the shell draws it with the rail alone', () => {
  assert.match(read('../../router.ts'), /\{ path: "\/apps\/:workspace\/:slug", name: "app", component: Page \}/);
  const shell = read('../../App.vue');
  assert.match(shell, /route\.name === "apps" \|\| route\.name === "app" \|\|/);
  assert.match(shell, /function openAppPage\(app: HubApp\) \{[\s\S]*?router\.push\(\{ name: "app", params: \{ workspace: app\.workspace_id, slug: app\.slug \} \}\)/);
  assert.match(shell, /'hub-app-focus': appFocus/);
  assert.match(shell, /<IconRail v-if="railMode" :current-page="page \?\? 'canvas'"[^>]*:panel="!appFocus"/);
  // The catalog, the rail tiles, the sidebar list and the Home card open the full-screen view.
  assert.match(shell, /<AppsPage[^>]*@open-app="openAppPage" @open-on-mesa="openApp"\/>/);
  assert.match(shell, /<HomePage[^>]*@open-app="openAppPage"/);
  assert.match(shell, /@open-app-page="openAppPage"/);
  const full = /<AppFullPage[^>]*\/>/.exec(shell)[0];
  for (const part of [':key="routeApp"', ':start-chat="appSideChat"', '@open-on-mesa="openApp"', '@reveal-code="revealAppCode"', '@open-session="openSession"', '@open-reference="openReferenceOnMesa"']) assert.ok(full.includes(part), part);
  assert.match(shell, /async function revealAppCode\(app: HubApp\) \{\s*openFiles\(app\.workspace_id, null\);[\s\S]*?explorer\.value\?\.reveal\(/);
  const css = read('../../styles.css');
  assert.match(css, /\.hub-app-focus \.app-body \{ grid-template-columns: var\(--hub-rail\) 0 minmax\(0, 1fr\) var\(--rail-right\); \}/);
  assert.match(css, /\.hub-app-focus \.sidebar \{ display: none; \}/);
  // The Apps page: the card opens the app, the button puts it on the Mesa.
  const page = read('AppsPage.vue');
  assert.match(page, /class="apps-app-main"[^>]*@click="emit\('openApp', app\)"/);
  assert.match(page, /@click="emit\('openOnMesa', app\)">\{\{ t\('Open on the Mesa'\) \}\}/);
  // "Report a problem" keeps opening its app beside what you were doing.
  assert.match(read('IconRail.vue'), /emit\("openOnMesa", await openReportApp\(/);
});

test('the chat beside a full-screen app is started like any quick session, and handed back', () => {
  const shell = read('../../App.vue');
  assert.match(shell, /function appSideChat\(workspaceId: string\) \{[\s\S]*?return quickSession\(workspaceId, [^;]*, false, undefined, false, true\);/);
  // Detached: created, never put on the Mesa.
  const quick = /async function quickSession\([\s\S]*?\n\}/.exec(shell)[0];
  assert.match(quick, /detached = false\): Promise<Session \| undefined>/);
  assert.ok(quick.indexOf('if (detached) return session;') < quick.indexOf('canvas.value?.openBeside'), 'handed back before the canvas is touched');
  assert.match(quick, /`\$\{workspacePath\(id\)\}\/sessions`/, 'the same route "+" uses: a session, no message');
  // On the Mesa, "Ask for a fix" fills the conversation beside the app, or a new one there.
  assert.match(shell, /onAppChatRequest\(async \(\{ workspaceId, slug, name, paneId, text \}\) => \{[\s\S]*?chatPaneFor\(openPanes\.value, sessions\.value, workspaceId, selectedPaneId\.value\)[\s\S]*?fillComposer\(session\.id, \{ attach: appAttachment\(\{ slug, name \}\), text \}\)/);
  const full = read('AppFullPage.vue');
  assert.match(full, /const session = await props\.startChat\(props\.workspaceId\);/);
  assert.match(full, /fillComposer\(session\.id, \{ attach: appAttachment\(app\.value\) \}\)/);
  assert.match(full, /fillComposer\(id, \{ attach: app\.value \? appAttachment\(app\.value\) : undefined, text \}\)/);
  // A conversation is made on a click, never because the page opened.
  assert.equal(full.match(/props\.startChat\(/g).length, 1);
  assert.match(full, /async function newChat\(\)/);
  assert.doesNotMatch(full, /onMounted\(\(\) => \{[^}]*newChat/);
  // Resizable with the pointer and the keyboard; Esc closes it and gives the focus back to Chat.
  assert.match(full, /role="separator" aria-orientation="vertical" tabindex="0"/);
  assert.match(full, /@pointerdown\.prevent="resize" @keydown="resizeKey"/);
  assert.match(full, /if \(event\.key !== "Escape" \|\| event\.defaultPrevented \|\| !chatOpen\.value\) return;/);
  assert.match(full, /querySelector<HTMLElement>\("\.app-view-chat"\)\?\.focus\(\)/);
  // The conversation is the ordinary one, with no tab to hang its menu on.
  assert.match(full, /<SessionPane v-if="chatSession" :key="chatSession\.id" :session="chatSession"/);
  assert.doesNotMatch(/<SessionPane[^>]*>/.exec(full)[0], /pane-id/);
});

test('the conversation in the chat column counts as the one in front of you', () => {
  const shell = read('../../App.vue');
  assert.match(shell, /const viewedSessionId = computed\(\(\) => page\.value === "app" \? sideChatSession\.value : page\.value \? undefined : selectedSessionId\.value\);/);
  // It is marked read, and the server is told it is on screen (so a phone does not ring for it).
  assert.match(shell, /function seeFocused\(\) \{ const id = viewedSessionId\.value;/);
  assert.match(shell, /refreshInbox\(presentSession\(viewedSessionId\.value, false\)\)\.then\(seeFocused\)/);
  const full = read('AppFullPage.vue');
  assert.match(full, /sideChatSession\.value = chatOpen\.value \? chatSession\.value\?\.id : undefined;/);
  assert.match(full, /onBeforeUnmount\(\(\) => \{ sideChatSession\.value = undefined; \}\);/);
});

test('the socket hands every message to the apps, and the frame follows them', () => {
  const activity = read('../AgentActivity.vue');
  assert.match(activity, /import \{ liveMessage \} from "\.\/hub\/app-live";/);
  assert.match(activity, /try \{ message = JSON\.parse\(String\(event\.data\)\); \} catch \{ return; \}\n  liveMessage\(message\);/);
  const view = read('AppView.vue');
  assert.match(view, /stopWatching = watchApp\(target, heard\);/);
  assert.match(view, /stopReconnect = onLiveReconnect\(\(\) => void resync\(\)\);/);
  assert.match(view, /window\.addEventListener\("message", onMessage\);/);
  assert.match(view, /window\.removeEventListener\("message", onMessage\);/);
  assert.match(view, /readAppMessage\(event, \{ origin: window\.location\.origin, frame: frame\.value\?\.contentWindow \}, current\)/);
  // A reload keeps the page of the app that was open, when it is still inside the app.
  assert.match(view, /frameSrc\.value = place\.value\.startsWith\(appFilesPrefix\(current\)\) \? place\.value : src\.value;/);
  // Held: the change waits; released: it is applied.
  assert.match(view, /if \(outcome === "wait"\) \{ pending\.value = change; show\(\{ kind: "waiting" \}\); return; \}/);
  assert.match(view, /if \(!message\.on && pending\.value\) apply\(pending\.value\);/);
  // Undo asks the server; it never edits files from the browser.
  assert.match(view, /await undoChange\(target, current\.change\.id\)/);
  // The frame keeps the sandbox it had.
  assert.match(view, /sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-downloads allow-popups"/);
  // A pane is the same view, and its "Ask for a fix" goes through the Mesa.
  const pane = read('AppPane.vue');
  assert.match(pane, /<AppView mode="pane"[^>]*@chat="emit\('chat'\)" @fix="fix" @remove="emit\('remove'\)" \/>/);
  assert.match(pane, /requestAppChat\(\{ workspaceId: props\.workspace\.id, slug: slug\.value,/);
});

// ---------------------------------------------------------------- translations and design rules

test('every string of this stage has a Brazilian Portuguese translation with the same placeholders', () => {
  const raw = readFileSync(new URL('../../i18n/pt-BR.json', here), 'utf8');
  const translations = JSON.parse(raw);
  // Strings chosen by a value, which the scan below can not see.
  const keys = new Set([
    'Updated just now', 'Change undone', 'Undo', 'Redo', 'Error', 'Unhandled promise rejection', 'console.error', 'File not loaded',
    '{count} error', '{count} errors', 'Link copied', 'Copy a link to this app',
    'The app "{app}" (in apps/{slug}/) is showing errors. Find the cause and fix it, please.', 'Screen open: {screen}', '({count} earlier errors left out.)',
    'Put the files of this app back as they were before this change', 'Apply the change again',
  ]);
  for (const file of [...COMPONENTS, 'app-errors.ts']) {
    for (const match of read(file).matchAll(/\bt\(\s*(["'])((?:\\.|(?!\1).)*)\1/g)) keys.add(match[2]);
  }
  assert.ok(keys.size >= 45, `found ${keys.size} strings`);
  const placeholders = text => (text.match(/\{\w+\}/g) ?? []).sort();
  for (const key of keys) {
    assert.ok(!key.includes('\\'), `write ${JSON.stringify(key)} without an escape`);
    assert.ok(key in translations, `missing pt-BR for ${JSON.stringify(key)}`);
    assert.deepEqual(placeholders(translations[key]), placeholders(key), key);
  }
  assert.equal(translations['Ask for a fix'], 'Pedir correção');
  assert.equal(translations['Updated just now'], 'Atualizado agora');
  assert.equal(translations['Open on the Mesa'], 'Abrir na Mesa');
  // The file keeps its shape: one space of indentation, no trailing newline.
  assert.equal(raw, JSON.stringify(translations, null, 1));
});

test('the new pieces keep the design rules: tokens, focus ring, touch targets, no native confirm', () => {
  for (const file of NEW_COMPONENTS) {
    const source = read(file);
    const css = [...source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(match => match[1]).join('\n');
    assert.ok(css.length > 100, file);
    assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/, `${file}: colours come from tokens`);
    assert.doesNotMatch(css, /font-size\s*:\s*[0-9.]+px/, `${file}: sizes come from --text-*`);
    assert.doesNotMatch(css, /border-radius\s*:\s*[0-9.]+px/, `${file}: radii come from --radius-*`);
    assert.doesNotMatch(css, /outline\s*:\s*(none|0)\b/, `${file}: the focus ring stays`);
    assert.match(css, /@media \(pointer: coarse\)[^{]*\{[^@]*44px/, `${file}: 44px targets on touch`);
    assert.doesNotMatch(source, /window\.confirm|\bconfirm\(|\balert\(/, file);
  }
  const view = read('AppView.vue');
  // Narrow, the labels go and the names stay on the buttons.
  assert.match(view, /@container app-view \(max-width: 620px\) \{ \.app-view-label, \.app-view-code > span \{ display: none; \} \}/);
  assert.match(view, /class="small-button app-view-mesa"[^>]*:aria-label="t\('Open on the Mesa'\)"/);
  assert.match(view, /\.app-view-bar \{[^}]*flex-wrap: wrap;/, 'at 360px the actions drop to a second row instead of being cut');
  // What changes is announced, and the notice does not animate for who asked for less motion.
  assert.match(view, /class="app-view-notice" role="status" aria-live="polite"/);
  assert.match(view, /@media \(prefers-reduced-motion: reduce\) \{ \.app-view-notice \{ animation: none; \} \}/);
  assert.match(view, /role="region" :aria-label="t\('Errors in this app'\)" @keydown\.esc="closeErrors"/);
  const full = read('AppFullPage.vue');
  // Too narrow for both, the conversation covers the app instead of squeezing it.
  assert.match(full, /const stacked = computed\(\(\) => pageWidth\.value > 0 && pageWidth\.value < CHAT_MIN \+ APP_MIN\);/);
  assert.match(full, /\.app-page\.stacked \.app-page-chat \{ position: absolute; inset: 0;/);
  // While the column is dragged, the app's frame does not swallow the pointer.
  assert.match(full, /\.app-page\.dragging \.app-page-main \{ pointer-events: none; \}/);
});
