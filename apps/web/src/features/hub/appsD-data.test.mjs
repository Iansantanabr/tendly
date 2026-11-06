// Apps, stage D: real data for apps. Collections of records with revisions,
// live updates between panes of the same app, files a person uploads, and a
// collection exported and imported from the "…" of the app's header. All of
// it through the bridge: the app's frame never makes a request of its own.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { createServer } from 'vite';
import vue from '@vitejs/plugin-vue';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { BridgeError, MAX_UPLOAD_BYTES, answerCall, ask, bridgeFailure, createLimiter, hostMessage } from './app-bridge.ts';
import { readAppMessage } from './app-errors.ts';
import { liveMessage, watchApp, watchRecords } from './app-live.ts';
import { changeFor, createSubscriptions, exportCollection, exportName, formatOf, importCollection, importSummary, listCollections, readRecord, validCollection } from './app-records.ts';
import { appConvention } from './apps.ts';

const here = new URL('./', import.meta.url);
const read = name => readFileSync(new URL(name, here), 'utf8');
const SDK = readFileSync(new URL('../../../../../crates/server/src/hub/apps/sdk.js', here), 'utf8');
const HOST = 'http://127.0.0.1:28789';
const RUN = '/apps-run/w1/pipeline/1800000000.abc/';
const BASE = '/api/hub/apps/w1/pipeline';
const APP = { workspace_id: 'w1', workspace_name: 'Site', slug: 'pipeline', name: 'Pipeline', letter: 'P', color: 'blue', description: 'Deals by stage', entry: 'index.html', permissions: [], url: `${BASE}/files/index.html`, code_path: 'apps/pipeline/', updated_at: '2026-11-06T10:00:00Z' };
const tick = () => new Promise(resolve => setImmediate(resolve));
const record = (id, rev, data) => ({ id, rev, created_at: '2026-11-06T10:00:00.000Z', updated_at: '2026-11-06T10:00:00.000Z', data });

// ---------------------------------------------------------------- the SDK, as a page in the sandbox runs it

/** The real sdk.js in a page served at the app's address. `onPost` plays the Tendly page that frames it. */
function runSdk({ framed = true, path = `${RUN}index.html`, onPost } = {}) {
  const posted = [], listeners = {}, timers = [], fetched = [];
  const win = { addEventListener: (type, handler) => { (listeners[type] ??= []).push(handler); }, innerWidth: 400, innerHeight: 300, open: () => null, matchMedia: () => ({ matches: false, addEventListener() {} }) };
  for (const name of ['localStorage', 'sessionStorage']) Object.defineProperty(win, name, { configurable: true, get() { throw new Error('SecurityError'); } });
  const page = { posted, listeners, timers, fetched, win, onPost };
  // Messages are kept as they were posted: a file's bytes must arrive as bytes.
  win.parent = framed ? { postMessage: (message, origin) => { posted.push({ message, origin }); page.onPost?.(message); } } : win;
  const document = { documentElement: { setAttribute() {} }, addEventListener() {} };
  const location = { pathname: path, search: '', hash: '', origin: 'null', protocol: 'http:', host: '127.0.0.1:28789', href: `${HOST}${path}` };
  const context = vm.createContext({
    window: win, document, location, URL, console: { error() {}, warn() {} }, encodeURIComponent,
    setTimeout: (run, ms) => { timers.push({ run, ms }); return timers.length; }, clearTimeout: id => { if (timers[id - 1]) timers[id - 1].cleared = true; },
    fetch: (...args) => { fetched.push(args); throw new Error('an app never fetches'); },
  });
  vm.runInContext(SDK, context);
  page.fire = (type, value) => { for (const handler of listeners[type] ?? []) handler(value); };
  /** Tendly's page says something, as the frame would hear it. */
  page.answer = (body, more = {}) => page.fire('message', { source: win.parent, origin: HOST, data: { source: 'tendly-host', v: 2, ...body }, ...more });
  page.calls = () => posted.filter(item => item.message.type === 'call').map(item => item.message);
  page.last = () => page.calls().at(-1);
  page.ok = value => page.answer({ type: 'result', id: page.last().id, ok: true, value });
  page.fail = error => page.answer({ type: 'result', id: page.last().id, ok: false, error });
  page.tendly = win.tendly;
  return page;
}
/** What a call carried, without what was left undefined. */
const sent = call => [call.method, JSON.parse(JSON.stringify(call.args))];

test('every collection call is a message to the Tendly page: list, count, get, insert, update, remove', async () => {
  const page = runSdk();
  const leads = page.tendly.db.collection('leads');
  assert.equal(leads.name, 'leads');

  const listed = leads.list({ where: { stage: 'new', owner: { in: ['ana', null] } }, order: '-created_at', limit: 50, offset: 10 });
  assert.deepEqual(sent(page.last()), ['db.list', { collection: 'leads', where: { stage: 'new', owner: { in: ['ana', null] } }, order: '-created_at', limit: 50, offset: 10 }]);
  assert.equal(page.posted.at(-1).origin, HOST, 'addressed to the origin the app was served from');
  page.ok({ records: [record('a', 1, { name: 'Ana' })], total: 7, truncated: false });
  const records = await listed;
  // A list is the records themselves, and says how many match in all.
  assert.deepEqual(JSON.parse(JSON.stringify(records)), [record('a', 1, { name: 'Ana' })]);
  assert.deepEqual([records.total, records.truncated, records.length], [7, false, 1]);
  const everything = leads.list();
  assert.deepEqual(sent(page.last()), ['db.list', { collection: 'leads' }]);
  page.ok({ records: [], total: 0 });
  assert.deepEqual([...(await everything)], []);

  const counted = leads.count({ stage: 'won' });
  assert.deepEqual(sent(page.last()), ['db.count', { collection: 'leads', where: { stage: 'won' } }]);
  page.ok(3);
  assert.equal(await counted, 3);

  const got = leads.get('a');
  await tick();
  assert.deepEqual(sent(page.last()), ['db.get', { collection: 'leads', id: 'a' }]);
  page.ok(record('a', 1, { name: 'Ana' }));
  assert.equal((await got).data.name, 'Ana');
  // A record that is not there is null, not an error; any other failure is thrown.
  const none = leads.get('nope');
  await tick();
  page.fail({ message: 'Record not found', status: 404 });
  assert.equal(await none, null);
  const broken = leads.get('a');
  await tick();
  page.fail({ message: 'Database is busy', status: 500 });
  await assert.rejects(broken, error => error.message === 'Database is busy' && error.status === 500);

  // A record goes as JSON text, so what is stored is what was given.
  const inserted = leads.insert({ name: 'Bia', tags: ['vip'], n: 1 });
  await tick();
  assert.deepEqual(sent(page.last()), ['db.insert', { collection: 'leads', json: '{"name":"Bia","tags":["vip"],"n":1}' }]);
  page.ok(record('made-up', 1, { name: 'Bia', tags: ['vip'], n: 1 }));
  assert.deepEqual([(await inserted).id, (await inserted).rev], ['made-up', 1]);
  leads.insert({ name: 'Caio' }, { id: 'caio' }).catch(() => {});
  await tick();
  assert.deepEqual(sent(page.last()), ['db.insert', { collection: 'leads', json: '{"name":"Caio"}', id: 'caio' }]);

  leads.update('a', { stage: 'won' }, { rev: 4 }).catch(() => {});
  await tick();
  assert.deepEqual(sent(page.last()), ['db.update', { collection: 'leads', id: 'a', json: '{"stage":"won"}', rev: 4, replace: false }]);
  leads.update('a', { name: 'Only this' }, { replace: true }).catch(() => {});
  await tick();
  assert.deepEqual(sent(page.last()), ['db.update', { collection: 'leads', id: 'a', json: '{"name":"Only this"}', replace: true }], 'without a revision the last write wins');

  const removed = leads.remove('a', { rev: 5 });
  await tick();
  assert.deepEqual(sent(page.last()), ['db.remove', { collection: 'leads', id: 'a', rev: 5 }]);
  page.ok(true);
  assert.equal(await removed, true);

  const names = page.tendly.db.collections();
  assert.deepEqual(sent(page.last()), ['db.collections', {}]);
  page.ok([{ name: 'leads', count: 2, updated_at: 'now' }]);
  assert.deepEqual(JSON.parse(JSON.stringify(await names)), [{ name: 'leads', count: 2, updated_at: 'now' }]);

  // Names that are not names, and records that are not objects, never leave the page.
  const before = page.calls().length;
  for (const bad of ['', '../leads', 'a b', 'a/b', 'ç', 'x'.repeat(65)]) assert.throws(() => page.tendly.db.collection(bad), /invalid key/, bad);
  await assert.rejects(leads.get('../x'), /invalid key/);
  await assert.rejects(leads.update('a b', {}), /invalid key/);
  await assert.rejects(leads.remove(''), /invalid key/);
  await assert.rejects(leads.insert({ a: 1 }, { id: 'no/slash' }), /invalid key/);
  for (const bad of [undefined, null, 'text', 3, [1, 2]]) {
    await assert.rejects(leads.insert(bad), /a record is an object/, String(bad));
    await assert.rejects(leads.update('a', bad), /a record is an object/, String(bad));
  }
  assert.equal(page.calls().length, before);
  assert.deepEqual(page.fetched, [], 'the app made no request of its own');
});

test('a stale revision rejects with the record as it is now, so the app can merge and try again', async () => {
  const page = runSdk();
  const cards = page.tendly.db.collection('cards');
  const moved = cards.update('c1', { column: 'done' }, { rev: 1 });
  await tick();
  const current = record('c1', 2, { title: 'Call Ana', column: 'doing' });
  page.fail({ message: 'This record changed since it was read: it is at revision 2 now.', status: 409, code: 'conflict', current });
  const refusal = await moved.catch(error => error);
  assert.match(refusal.message, /revision 2/);
  assert.deepEqual([refusal.status, refusal.code], [409, 'conflict']);
  assert.deepEqual(JSON.parse(JSON.stringify(refusal.current)), current);
  // The same for a removal; an ordinary failure carries no record.
  const removed = cards.remove('c1', { rev: 1 });
  await tick();
  page.fail({ message: 'changed', status: 409, code: 'conflict', current });
  assert.equal((await removed.catch(error => error)).current.rev, 2);
  const failed = cards.update('c1', { a: 1 });
  await tick();
  page.fail({ message: 'A record can be at most 5 MB', status: 413 });
  const plain = await failed.catch(error => error);
  assert.equal(plain.status, 413);
  assert.equal('current' in plain, false);
});

test('subscribers hear every change Tendly passes on, and only for the collections they asked', async () => {
  const page = runSdk();
  const cards = page.tendly.db.collection('cards'), leads = page.tendly.db.collection('leads');
  const first = [], second = [], other = [];
  const stopFirst = cards.subscribe(change => first.push(change));
  // The first subscriber of a collection tells Tendly; the next ones are already covered.
  assert.deepEqual(sent(page.last()), ['db.subscribe', { collection: 'cards' }]);
  const calls = page.calls().length;
  const stopSecond = cards.subscribe(change => second.push(change));
  // The same collection asked for again by name shares the subscription.
  page.tendly.db.collection('cards').subscribe(() => { throw new Error('a subscriber that throws'); });
  assert.equal(page.calls().length, calls);
  leads.subscribe(change => other.push(change));
  assert.deepEqual(sent(page.last()), ['db.subscribe', { collection: 'leads' }]);
  assert.throws(() => cards.subscribe('not a function'), /a function is needed/);

  const change = { type: 'update', id: 'c1', rev: 2, record: record('c1', 2, { column: 'doing' }) };
  page.answer({ type: 'records', collection: 'cards', change });
  assert.deepEqual(first, [change]);
  assert.deepEqual(second, [change], 'both subscribers hear it, though a third one threw');
  assert.deepEqual(other, [], 'another collection hears nothing');
  // Only Tendly's page, at Tendly's origin, in Tendly's envelope, is heard.
  page.answer({ type: 'records', collection: 'cards', change }, { source: { other: true } });
  page.answer({ type: 'records', collection: 'cards', change }, { origin: 'https://evil.example' });
  page.fire('message', { source: page.win.parent, origin: HOST, data: { source: 'tendly-host', v: 1, type: 'records', collection: 'cards', change } });
  page.answer({ type: 'records', collection: '__proto__', change });
  page.answer({ type: 'records', collection: 'nobody-asked', change });
  assert.equal(first.length, 1);

  page.answer({ type: 'records', collection: 'cards', change: { type: 'reset', id: null, rev: null, record: null } });
  assert.equal(first.at(-1).type, 'reset');
  // Stopping one leaves the other; stopping the last one tells Tendly.
  stopFirst();
  stopFirst();
  page.answer({ type: 'records', collection: 'cards', change: { type: 'remove', id: 'c1', rev: null, record: null } });
  assert.equal(first.length, 2);
  assert.equal(second.at(-1).type, 'remove');
  assert.notEqual(page.last().method, 'db.unsubscribe', 'others still listen');
  stopSecond();
  assert.notEqual(page.last().method, 'db.unsubscribe', 'the one that throws still listens');

  // Outside Tendly there is nothing live, and subscribing says nothing and breaks nothing.
  const alone = runSdk({ framed: false });
  const stop = alone.tendly.db.collection('cards').subscribe(() => {});
  await tick();
  stop();
  await assert.rejects(alone.tendly.db.collection('cards').list(), error => error.code === 'outside');
});

test('a file goes to Tendly as bytes with its name, and comes back with a path and an address for <img>', async () => {
  const page = runSdk();
  const { files } = page.tendly;
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).buffer;
  const file = { name: 'Foto da Ana.png', type: 'image/png', size: bytes.byteLength, arrayBuffer: async () => bytes };
  const uploaded = files.upload(file);
  await tick();
  const call = page.last();
  assert.equal(call.method, 'files.upload');
  assert.equal(call.args.name, 'Foto da Ana.png');
  assert.equal(call.args.bytes, bytes, 'the bytes themselves, not text');
  // A large file over a slow connection gets more time than an ordinary call.
  assert.deepEqual(page.timers.at(-1).ms, 300000);
  page.ok({ path: 'files/Foto-da-Ana.png', name: 'Foto-da-Ana.png', size: 7, type: 'image/png', updated_at: 'now' });
  const stored = await uploaded;
  assert.equal(stored.path, 'files/Foto-da-Ana.png', 'the name Tendly chose');
  assert.equal(stored.url, `${HOST}${RUN}files/Foto-da-Ana.png`, 'served with the app\'s own files, so <img src> works');
  // A name of the app's choosing instead of the file's.
  files.upload({ size: 3, arrayBuffer: async () => bytes }, { name: 'logo' }).catch(() => {});
  await tick();
  assert.equal(page.last().args.name, 'logo');

  assert.equal(files.url('files/a.png'), `${HOST}${RUN}files/a.png`);
  assert.equal(files.url('a.png'), `${HOST}${RUN}files/a.png`, 'with or without the folder');
  assert.equal(files.url('./files/Relatorio-2.pdf'), `${HOST}${RUN}files/Relatorio-2.pdf`);

  const listed = files.list();
  assert.deepEqual(sent(page.last()), ['files.list', {}]);
  page.ok([{ path: 'files/a.png', name: 'a.png', size: 1, type: 'image/png', updated_at: 'now' }]);
  assert.equal((await listed)[0].url, `${HOST}${RUN}files/a.png`);

  const removed = files.remove('files/a.png');
  await tick();
  assert.deepEqual(sent(page.last()), ['files.remove', { name: 'a.png' }]);
  page.ok(true);
  assert.equal(await removed, true);
  files.open('files/Relatorio-2.pdf').catch(() => {});
  await tick();
  assert.deepEqual(sent(page.last()), ['host.openFile', { path: 'apps/pipeline/files/Relatorio-2.pdf' }], 'a PDF opens on the Mesa as a file of the project');

  // What is not an uploaded file's path never becomes an address or a request.
  const before = page.calls().length;
  for (const bad of ['../app.json', 'files/../app.json', 'files/sub/a.png', '.env', 'files/.env', '/etc/passwd', 'data/leads.json', 'a b.png', 'a..png', '', 'files/']) {
    assert.throws(() => files.url(bad), /is not an uploaded file/, bad);
    await assert.rejects(files.remove(bad), /is not an uploaded file/, bad);
    await assert.rejects(files.open(bad), /is not an uploaded file/, bad);
  }
  // Too large, or not a file at all: said at once.
  await assert.rejects(files.upload({ name: 'big.png', size: 20 * 1024 * 1024 + 1, arrayBuffer: async () => { throw new Error('never read'); } }), error => /at most 20 MB/.test(error.message) && error.status === 413);
  await assert.rejects(files.upload('photo.png'), /takes a File or a Blob/);
  await assert.rejects(files.upload(null), /takes a File or a Blob/);
  assert.equal(page.calls().length, before);
  assert.deepEqual(page.fetched, []);
});

// ---------------------------------------------------------------- answering a call, as Tendly's page

/** Runs with `fetch` replaced: every request is recorded and answered from `routes` (404 otherwise). */
async function withFetch(routes, run) {
  const previous = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const call = { url: String(url), method: init.method ?? 'GET', body: init.body, client: init.headers?.['X-Tendly-Client'], type: init.headers?.['Content-Type'] };
    calls.push(call);
    const route = routes[`${call.method} ${call.url.split('?')[0]}`];
    const [status, body] = (typeof route === 'function' ? route(call) : route) ?? [404, { error: 'Not found' }];
    return new Response(status === 204 ? null : typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  try { return await run(calls); } finally { globalThis.fetch = previous; }
}
function hostFor(log = []) {
  return { app: APP, grants: () => undefined, openConversation() {}, draft() {}, toast() {}, openUrl() {}, subscribe: (collection, on) => log.push([collection, on]) };
}
const call = (method, args = {}, host = hostFor()) => answerCall({ method, args }, host, createLimiter());
const bodyOf = request => JSON.parse(request.body);

test('the page turns each collection call into one request about that app, and nothing else', async () => {
  const one = record('a', 2, { name: 'Ana', stage: 'won' });
  await withFetch({
    [`GET ${BASE}/db`]: [200, { collections: [{ name: 'leads', count: 1, updated_at: 'now' }] }],
    [`POST ${BASE}/db/leads/query`]: request => bodyOf(request).count ? [200, { total: 4 }] : [200, { records: [one], total: 1, truncated: false }],
    [`GET ${BASE}/db/leads/r/a`]: [200, one],
    [`POST ${BASE}/db/leads`]: [201, record('new', 1, { name: 'Bia' })],
    [`PATCH ${BASE}/db/leads/r/a`]: [200, one],
    [`PUT ${BASE}/db/leads/r/a`]: [200, one],
    [`DELETE ${BASE}/db/leads/r/a`]: [200, { removed: true }],
    [`DELETE ${BASE}/db/leads/r/gone`]: [200, { removed: false }],
  }, async calls => {
    assert.deepEqual(await call('db.collections'), [{ name: 'leads', count: 1, updated_at: 'now' }]);
    assert.deepEqual(await call('db.list', { collection: 'leads', where: { stage: 'won' }, order: '-name', limit: 20, offset: 40 }), { records: [one], total: 1, truncated: false });
    assert.deepEqual([calls.at(-1).method, calls.at(-1).url, bodyOf(calls.at(-1))], ['POST', `${BASE}/db/leads/query`, { where: { stage: 'won' }, order: '-name', limit: 20, offset: 40 }]);
    await call('db.list', { collection: 'leads', limit: 999999, offset: -3, order: 7 });
    assert.deepEqual(bodyOf(calls.at(-1)), { order: '', limit: 5000, offset: 0 }, 'bounded before it is sent; the server bounds again');
    assert.equal(await call('db.count', { collection: 'leads', where: { hot: true } }), 4);
    assert.deepEqual(bodyOf(calls.at(-1)), { where: { hot: true }, count: true });
    assert.deepEqual(await call('db.get', { collection: 'leads', id: 'a' }), one);

    assert.equal((await call('db.insert', { collection: 'leads', json: '{"name":"Bia"}' })).id, 'new');
    assert.deepEqual([calls.at(-1).method, calls.at(-1).url, bodyOf(calls.at(-1))], ['POST', `${BASE}/db/leads`, { data: { name: 'Bia' } }]);
    await call('db.insert', { collection: 'leads', json: '{"name":"Bia"}', id: 'bia' });
    assert.deepEqual(bodyOf(calls.at(-1)), { data: { name: 'Bia' }, id: 'bia' });

    await call('db.update', { collection: 'leads', id: 'a', json: '{"stage":"won"}', rev: 1 });
    assert.deepEqual([calls.at(-1).method, calls.at(-1).url, bodyOf(calls.at(-1))], ['PATCH', `${BASE}/db/leads/r/a`, { patch: { stage: 'won' }, rev: 1 }]);
    await call('db.update', { collection: 'leads', id: 'a', json: '{"name":"Only"}', replace: true, rev: 2 });
    assert.deepEqual([calls.at(-1).method, bodyOf(calls.at(-1))], ['PUT', { data: { name: 'Only' }, rev: 2 }]);
    await call('db.update', { collection: 'leads', id: 'a', json: '{"a":1}', rev: '3' });
    assert.deepEqual(bodyOf(calls.at(-1)), { patch: { a: 1 } }, 'a revision that is not a whole number is no revision');

    assert.equal(await call('db.remove', { collection: 'leads', id: 'a', rev: 2 }), true);
    assert.deepEqual([calls.at(-1).method, calls.at(-1).url], ['DELETE', `${BASE}/db/leads/r/a?rev=2`]);
    assert.equal(await call('db.remove', { collection: 'leads', id: 'gone' }), false);
    assert.equal(calls.at(-1).url, `${BASE}/db/leads/r/gone`);
    assert.ok(calls.every(request => request.client === 'web' && request.url.startsWith(`${BASE}/db`)), 'only this app, with the page\'s own header');

    // Names never become paths, and what is not a record or a filter is refused before any request.
    const before = calls.length;
    for (const [method, args] of [
      ['db.list', { collection: '../../settings' }], ['db.list', { collection: 'a/b' }], ['db.list', {}], ['db.count', { collection: 'leads?x=1' }],
      ['db.get', { collection: 'leads', id: '../x' }], ['db.get', { collection: 'leads' }], ['db.get', { collection: 'leads', id: 'a/query' }],
      ['db.insert', { collection: 'leads', json: '[1]' }], ['db.insert', { collection: 'leads', json: '{nope' }], ['db.insert', { collection: 'leads' }],
      ['db.insert', { collection: 'leads', json: '{}', id: 'a b' }], ['db.insert', { collection: 'leads', json: '"text"' }],
      ['db.update', { collection: 'leads', id: 'a', json: 'null' }], ['db.update', { collection: 'leads', id: '', json: '{}' }],
      ['db.remove', { collection: 'leads', id: 'x'.repeat(65) }], ['db.remove', { collection: '', id: 'a' }],
      ['db.list', { collection: 'leads', where: 'stage = 1' }], ['db.list', { collection: 'leads', where: ['stage'] }], ['db.count', { collection: 'leads', where: 3 }],
      ['db.subscribe', { collection: 'a/b' }], ['db.unsubscribe', {}],
    ]) {
      await assert.rejects(call(method, args), error => error instanceof BridgeError && error.code === 'invalid' && error.status === 400, `${method} ${JSON.stringify(args)}`);
    }
    assert.equal(calls.length, before);
  });
});

test('a conflict reaches the app with the current record; other refusals with their kind', async () => {
  const current = record('a', 3, { name: 'Ana', stage: 'doing' });
  await withFetch({
    [`PATCH ${BASE}/db/leads/r/a`]: [409, { error: 'This record changed since it was read: it is at revision 3 now. Read it again and repeat the change.', code: 'conflict', current }],
    [`DELETE ${BASE}/db/leads/r/a`]: [409, { error: 'changed', code: 'conflict', current }],
    [`POST ${BASE}/db/leads`]: request => bodyOf(request).id ? [409, { error: 'A record with this id already exists in the collection', code: 'exists', current }] : [413, { error: 'A collection holds at most 50000 records', code: 'full' }],
    [`GET ${BASE}/db/leads/r/a`]: [500, 'not json at all'],
  }, async () => {
    const stale = await call('db.update', { collection: 'leads', id: 'a', json: '{"stage":"won"}', rev: 1 }).catch(error => error);
    assert.ok(stale instanceof BridgeError);
    assert.deepEqual([stale.status, stale.code, stale.current], [409, 'conflict', current]);
    // As the app's page is told it.
    assert.deepEqual(bridgeFailure(stale), { message: stale.message, status: 409, code: 'conflict', current });
    assert.match(bridgeFailure(stale).message, /revision 3/);
    assert.deepEqual((await call('db.remove', { collection: 'leads', id: 'a', rev: 1 }).catch(error => error)).current, current);
    const taken = bridgeFailure(await call('db.insert', { collection: 'leads', json: '{}', id: 'a' }).catch(error => error));
    assert.deepEqual([taken.status, taken.code, taken.current], [409, 'exists', current]);
    const full = bridgeFailure(await call('db.insert', { collection: 'leads', json: '{}' }).catch(error => error));
    assert.deepEqual(full, { message: 'A collection holds at most 50000 records', status: 413, code: 'full' }, 'no record to hand back, so none is');
    const broken = bridgeFailure(await call('db.get', { collection: 'leads', id: 'a' }).catch(error => error));
    assert.deepEqual(broken, { message: 'Request failed (500)', status: 500, code: undefined });
  });
  // A request that never reached the server is said as that.
  const previous = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError('network down'); };
  try { await assert.rejects(ask(`${BASE.slice(4)}/db`), error => error.name === 'ApiConnectionError'); }
  finally { globalThis.fetch = previous; }
});

test('subscribing is noted by the page that frames the app, per collection', async () => {
  const log = [];
  const host = hostFor(log);
  assert.equal(await call('db.subscribe', { collection: 'cards' }, host), undefined);
  await call('db.subscribe', { collection: 'leads' }, host);
  await call('db.unsubscribe', { collection: 'cards' }, host);
  assert.deepEqual(log, [['cards', true], ['leads', true], ['cards', false]]);

  const subscriptions = createSubscriptions();
  for (const [collection, on] of log) subscriptions.set(collection, on);
  assert.deepEqual([subscriptions.has('cards'), subscriptions.has('leads'), subscriptions.size, subscriptions.list()], [false, true, 1, ['leads']]);
  subscriptions.set('leads', true);
  assert.equal(subscriptions.size, 1, 'asked twice is still once');
  // A new page in the frame starts with none.
  subscriptions.clear();
  assert.deepEqual([subscriptions.size, subscriptions.list()], [0, []]);
});

test('an upload is sent as bytes to the app\'s uploads, bounded here and again on the server', async () => {
  const stored = { path: 'files/photo.png', name: 'photo.png', size: 4, type: 'image/png', updated_at: 'now' };
  await withFetch({
    [`POST ${BASE}/uploads`]: [201, stored],
    [`GET ${BASE}/uploads`]: [200, { files: [stored] }],
    [`DELETE ${BASE}/uploads/photo.png`]: [200, { removed: true }],
  }, async calls => {
    const bytes = new Uint8Array([1, 2, 3, 4]).buffer;
    assert.deepEqual(await call('files.upload', { name: '../../Foto da Ana.png', bytes }), stored);
    const request = calls.at(-1);
    assert.deepEqual([request.method, request.url, request.type, request.client], ['POST', `${BASE}/uploads?name=..%2F..%2FFoto%20da%20Ana.png`, 'application/octet-stream', 'web']);
    assert.equal(request.body, bytes, 'the bytes as they came; the name is only a hint the server makes safe');
    await call('files.upload', { bytes });
    assert.equal(calls.at(-1).url, `${BASE}/uploads`, 'a file with no name still goes');
    // Bytes made in another realm (the frame's) are bytes too.
    const foreign = vm.runInNewContext('new Uint8Array([9, 9]).buffer');
    assert.equal(foreign instanceof ArrayBuffer, false);
    await call('files.upload', { name: 'x.png', bytes: foreign });
    assert.equal(calls.at(-1).body, foreign);

    assert.deepEqual(await call('files.list'), [stored]);
    assert.equal(await call('files.remove', { name: 'photo.png' }), true);
    assert.deepEqual([calls.at(-1).method, calls.at(-1).url], ['DELETE', `${BASE}/uploads/photo.png`]);

    const before = calls.length;
    for (const bytes of [undefined, null, 'text', [1, 2], { byteLength: 3 }, new Uint8Array([1])]) {
      await assert.rejects(call('files.upload', { name: 'a.png', bytes }), error => error.code === 'invalid', String(bytes));
    }
    await assert.rejects(call('files.upload', { name: 'empty.png', bytes: new ArrayBuffer(0) }), /empty/);
    await assert.rejects(call('files.upload', { name: 'big.png', bytes: new ArrayBuffer(MAX_UPLOAD_BYTES + 1) }), error => error.status === 413 && /20 MB/.test(error.message));
    for (const name of ['../app.json', '..', '.env', 'a/b.png', 'a b.png', 'a..png', '', 'files/photo.png', undefined]) {
      await assert.rejects(call('files.remove', { name }), error => error.code === 'invalid', String(name));
    }
    assert.equal(calls.length, before, 'none of those became a request');
  });
});

// ---------------------------------------------------------------- live: from the server to the panes

test('every view of an app hears a write to its collections; other apps and other messages do not', () => {
  const one = [], two = [], elsewhere = [], files = [];
  const stops = [watchRecords(APP, event => one.push(event)), watchRecords(APP, event => two.push(event)), watchRecords({ workspace_id: 'w1', slug: 'other' }, event => elsewhere.push(event)), watchApp(APP, change => files.push(change))];
  const written = record('c1', 2, { column: 'doing' });
  const message = (change, more = {}) => ({ type: 'hub', event: 'app-records', workspace_id: 'w1', slug: 'pipeline', collection: 'cards', change, ...more });
  liveMessage(message({ op: 'update', id: 'c1', rev: 2, record: written, large: false }));
  assert.deepEqual(one, [{ collection: 'cards', op: 'update', id: 'c1', rev: 2, record: written, large: false }]);
  assert.deepEqual(two, one, 'two panes of the same app');
  assert.deepEqual([elsewhere, files], [[], []], 'not another app, and not a reload');

  liveMessage(message({ op: 'remove', id: 'c1', rev: null, record: null, large: false }));
  liveMessage(message({ op: 'insert', id: 'big', rev: 1, record: null, large: true }));
  liveMessage(message({ op: 'reset', id: null, rev: null, record: null }));
  assert.deepEqual(one.slice(1).map(event => [event.op, event.id, event.record, event.large]), [['remove', 'c1', null, false], ['insert', 'big', null, true], ['reset', null, null, false]]);
  // Anything shaped otherwise is not news.
  for (const bad of [message({ op: 'drop', id: 'c1' }), message(null), message('text'), message({ op: 'update', id: 'c1', record: written }, { collection: '' }), message({ op: 'update' }, { collection: 7 }), message({ op: 'update', id: 'x' }, { slug: 5 }), { type: 'hub', event: 'app-records' }, null]) liveMessage(bad);
  assert.equal(one.length, 4);
  // A record that is not whole is dropped rather than passed on as if it were.
  liveMessage(message({ op: 'update', id: 'c1', rev: 3, record: { id: 'c1' }, large: false }));
  assert.equal(one.at(-1).record, null);
  // A listener that throws does not stop the next one, and files changing is still its own news.
  const stopThrower = watchRecords(APP, () => { throw new Error('a pane that broke'); });
  liveMessage(message({ op: 'insert', id: 'c2', rev: 1, record: record('c2', 1, {}), large: false }));
  assert.equal(two.at(-1).id, 'c2');
  liveMessage({ type: 'hub', event: 'app-changed', workspace_id: 'w1', slug: 'pipeline', change: { id: 'x', at: 'now', paths: [], count: 0, undoable: false, undo_of: null } });
  assert.equal(files.length, 1);
  const heard = one.length;
  for (const stop of [...stops, stopThrower]) stop();
  liveMessage(message({ op: 'insert', id: 'c3', rev: 1, record: record('c3', 1, {}), large: false }));
  assert.equal(one.length, heard, 'a view that went away hears nothing');
});

test('an app is told of a change only for a collection it subscribed to, and a large record is read first', async () => {
  const subscriptions = createSubscriptions();
  const reads = [];
  const reader = result => async (collection, id) => { reads.push([collection, id]); if (result instanceof Error) throw result; return result; };
  const written = record('c1', 2, { column: 'doing' });
  const event = (more = {}) => ({ collection: 'cards', op: 'update', id: 'c1', rev: 2, record: written, large: false, ...more });

  assert.equal(await changeFor(event(), subscriptions, reader(written)), undefined, 'nobody asked');
  subscriptions.set('cards', true);
  assert.deepEqual(await changeFor(event(), subscriptions, reader(written)), { type: 'update', id: 'c1', rev: 2, record: written });
  assert.deepEqual(await changeFor(event({ op: 'insert' }), subscriptions, reader(written)), { type: 'insert', id: 'c1', rev: 2, record: written });
  assert.deepEqual(await changeFor(event({ op: 'remove', record: null, rev: null }), subscriptions, reader(written)), { type: 'remove', id: 'c1', rev: null, record: null });
  assert.deepEqual(await changeFor(event({ op: 'reset', id: null, record: null }), subscriptions, reader(written)), { type: 'reset', id: null, rev: null, record: null });
  assert.equal(await changeFor(event({ collection: 'leads' }), subscriptions, reader(written)), undefined);
  assert.deepEqual(reads, [], 'what came with the news is not read again');

  // Too large to travel with the news: read it, then tell.
  const large = record('big', 5, { text: 'x'.repeat(10) });
  assert.deepEqual(await changeFor(event({ id: 'big', record: null, large: true }), subscriptions, reader(large)), { type: 'update', id: 'big', rev: 5, record: large });
  assert.deepEqual(reads, [['cards', 'big']]);
  // It could not be read (removed meanwhile, connection lost): "read the list again" is always true.
  assert.deepEqual(await changeFor(event({ id: 'big', record: null, large: true }), subscriptions, reader(new Error('gone'))), { type: 'reset', id: null, rev: null, record: null });
  assert.deepEqual(await changeFor(event({ record: null }), subscriptions, reader(written)), { type: 'reset', id: null, rev: null, record: null }, 'news without its record and not marked large');
  // The app stopped listening while the record was being read.
  const slow = changeFor(event({ id: 'big', record: null, large: true }), subscriptions, async () => { subscriptions.set('cards', false); return large; });
  assert.equal(await slow, undefined);

  await withFetch({ [`GET ${BASE}/db/cards/r/big`]: [200, large] }, async calls => {
    assert.deepEqual(await readRecord(APP, 'cards', 'big'), large);
    assert.equal(calls[0].url, `${BASE}/db/cards/r/big`);
  });
});

/**
 * A server kept in memory, for two panes: the routes a kanban uses, with the
 * revision rule of `records.rs`, announcing each write to every open window
 * the way the real one does over the socket.
 */
function memoryServer() {
  const cards = new Map();
  let made = 0;
  const announce = change => liveMessage({ type: 'hub', event: 'app-records', workspace_id: 'w1', slug: 'pipeline', collection: 'cards', change });
  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const conflict = current => reply(409, { error: `This record changed since it was read: it is at revision ${current.rev} now.`, code: 'conflict', current });
  return async (url, init = {}) => {
    const method = init.method ?? 'GET', [path, search = ''] = String(url).split('?');
    const body = init.body ? JSON.parse(init.body) : {};
    if (method === 'POST' && path === `${BASE}/db/cards/query`) return reply(200, { records: [...cards.values()], total: cards.size, truncated: false });
    if (method === 'POST' && path === `${BASE}/db/cards`) {
      const created = record(`c${++made}`, 1, body.data);
      cards.set(created.id, created);
      announce({ op: 'insert', id: created.id, rev: 1, record: created, large: false });
      return reply(201, created);
    }
    const id = new RegExp(`^${BASE}/db/cards/r/([\\w-]+)$`).exec(path)?.[1], current = id && cards.get(id);
    if (!id) return reply(404, { error: 'Not found' });
    if (method === 'GET') return current ? reply(200, current) : reply(404, { error: 'Record not found' });
    const rev = method === 'DELETE' ? Number(new URLSearchParams(search).get('rev')) || undefined : body.rev;
    if (!current) return method === 'DELETE' ? reply(200, { removed: false }) : reply(404, { error: 'Record not found' });
    if (rev !== undefined && rev !== current.rev) return conflict(current);
    if (method === 'DELETE') { cards.delete(id); announce({ op: 'remove', id, rev: null, record: null, large: false }); return reply(200, { removed: true }); }
    const next = { ...current, rev: current.rev + 1, data: method === 'PUT' ? body.data : { ...current.data, ...body.patch } };
    cards.set(id, next);
    announce({ op: 'update', id, rev: next.rev, record: next, large: false });
    return reply(200, next);
  };
}

/** One pane: the app's page (the real SDK) and what `AppView.vue` does around it, with the same functions. */
function pane() {
  const subscriptions = createSubscriptions(), limiter = createLimiter();
  const page = runSdk();
  const tell = body => page.fire('message', { source: page.win.parent, origin: HOST, data: hostMessage(body) });
  page.onPost = posted => {
    // The message as the page that frames the app receives it: from that frame, with no origin of its own.
    const message = readAppMessage({ data: posted, origin: 'null', source: page.win }, { frame: page.win }, APP);
    if (message?.type !== 'call') return;
    answerCall(message, { ...hostFor(), subscribe: (collection, on) => subscriptions.set(collection, on) }, limiter)
      .then(value => tell({ type: 'result', id: message.id, ok: true, value }), cause => tell({ type: 'result', id: message.id, ok: false, error: bridgeFailure(cause) }));
  };
  const stop = watchRecords(APP, async event => {
    const change = await changeFor(event, subscriptions, (collection, id) => readRecord(APP, collection, id));
    if (change) tell({ type: 'records', collection: event.collection, change });
  });
  return { page, cards: page.tendly.db.collection('cards'), subscriptions, close: stop };
}

test('two panes of the same kanban move the same card: each sees the other, and the conflict loses nothing', async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = memoryServer();
  const left = pane(), right = pane();
  try {
    const seenLeft = [], seenRight = [];
    left.cards.subscribe(change => seenLeft.push(change));
    const stopRight = right.cards.subscribe(change => seenRight.push(change));
    await tick();
    assert.deepEqual([left.subscriptions.list(), right.subscriptions.list()], [['cards'], ['cards']]);

    // The left pane adds a card: both panes hear it, the one that wrote it included.
    const card = await left.cards.insert({ title: 'Call Ana', column: 'todo' });
    await tick();
    assert.deepEqual([card.id, card.rev], ['c1', 1]);
    for (const seen of [seenLeft, seenRight]) {
      assert.deepEqual(seen.map(change => [change.type, change.id, change.rev]), [['insert', 'c1', 1]]);
      assert.deepEqual(JSON.parse(JSON.stringify(seen[0].record.data)), { title: 'Call Ana', column: 'todo' });
    }
    assert.equal((await right.cards.list()).length, 1);

    // Both drag the card at revision 1. The left pane lands first.
    const first = await left.cards.update('c1', { column: 'doing' }, { rev: 1 });
    assert.equal(first.rev, 2);
    const refusal = await right.cards.update('c1', { column: 'done', note: 'she asked for a quote' }, { rev: 1 }).catch(error => error);
    assert.deepEqual([refusal.code, refusal.status, refusal.current.rev, refusal.current.data.column], ['conflict', 409, 2, 'doing']);
    await tick();
    // The right pane already heard of the move; with the record it was handed, it keeps its own note and repeats.
    assert.deepEqual(seenRight.map(change => [change.type, change.rev]), [['insert', 1], ['update', 2]]);
    const merged = await right.cards.update('c1', { note: 'she asked for a quote' }, { rev: refusal.current.rev });
    await tick();
    assert.equal(merged.rev, 3);
    assert.deepEqual(JSON.parse(JSON.stringify((await left.cards.get('c1')).data)), { title: 'Call Ana', column: 'doing', note: 'she asked for a quote' }, 'the move and the note are both there');
    for (const seen of [seenLeft, seenRight]) assert.deepEqual(seen.map(change => [change.type, change.rev]), [['insert', 1], ['update', 2], ['update', 3]]);
    assert.equal(seenLeft.at(-1).record.data.note, 'she asked for a quote');

    // A removal with a stale revision is refused the same way; with the current one it goes, and both hear.
    assert.equal((await left.cards.remove('c1', { rev: 2 }).catch(error => error)).code, 'conflict');
    // The right pane stops listening: what follows reaches only the left one.
    stopRight();
    await tick();
    assert.deepEqual(right.subscriptions.list(), []);
    assert.equal(await right.cards.remove('c1', { rev: 3 }), true);
    await tick();
    assert.deepEqual([seenLeft.at(-1).type, seenLeft.at(-1).id, seenLeft.length], ['remove', 'c1', 4]);
    assert.equal(seenRight.length, 3);
    assert.equal(await left.cards.get('c1'), null);
    assert.equal(await right.cards.remove('c1'), false, 'gone is gone, not an error');
    assert.deepEqual([...left.page.fetched, ...right.page.fetched], [], 'neither app made a request of its own');
  } finally { left.close(); right.close(); globalThis.fetch = previous; }
});

// ---------------------------------------------------------------- export and import

test('a collection is exported as a file and imported from one, as JSON or CSV', async () => {
  assert.deepEqual(['leads.csv', 'Leads.CSV ', 'sheet.tsv', 'leads.json', 'backup', 'data.csv.json'].map(formatOf), ['csv', 'csv', 'csv', 'json', 'json', 'json']);
  assert.equal(exportName(APP, 'leads', 'csv'), 'pipeline-leads.csv');
  assert.deepEqual(['leads', 'a_b-9', 'x'.repeat(64)].map(validCollection), [true, true, true]);
  assert.deepEqual(['', 'a b', 'a/b', '../x', 'ç', 'x'.repeat(65)].map(validCollection), [false, false, false, false, false, false]);
  // What an import did, in a sentence.
  assert.deepEqual(importSummary({ inserted: 3, updated: 0, removed: 0, total: 3 }), { text: 'Added {inserted} records.', values: { inserted: 3, updated: 0, removed: 0, total: 3 } });
  assert.equal(importSummary({ inserted: 0, updated: 2, removed: 0, total: 2 }).text, 'Updated {updated} records.');
  assert.equal(importSummary({ inserted: 1, updated: 2, removed: 0, total: 3 }).text, 'Added {inserted} records and updated {updated}.');
  assert.equal(importSummary({ inserted: 4, updated: 0, removed: 9, total: 4 }).text, 'Replaced {removed} records with {inserted}.');

  await withFetch({
    [`GET ${BASE}/db`]: [200, { collections: [{ name: 'leads', count: 2, updated_at: 'now' }] }],
    [`GET ${BASE}/db/leads/export`]: [200, 'id,name\r\na,Ana\r\n'],
    [`GET ${BASE}/db/none/export`]: [413, { error: 'This collection is too large to export in one file' }],
    [`POST ${BASE}/db/leads/import`]: [200, { inserted: 1, updated: 1, removed: 0, total: 2 }],
    [`POST ${BASE}/db/bad/import`]: [400, { error: 'Record 2: each record must be a JSON object' }],
  }, async calls => {
    assert.deepEqual(await listCollections(APP), [{ name: 'leads', count: 2, updated_at: 'now' }]);
    const saved = await exportCollection(APP, 'leads', 'csv');
    assert.deepEqual([calls.at(-1).url, calls.at(-1).client, saved.filename], [`${BASE}/db/leads/export?format=csv`, 'web', 'pipeline-leads.csv']);
    assert.equal(await saved.blob.text(), 'id,name\r\na,Ana\r\n');
    await assert.rejects(exportCollection(APP, 'none', 'json'), /too large to export/);

    const file = new Blob(['[{"name":"Ana"}]']);
    assert.deepEqual(await importCollection(APP, 'leads', file, { format: 'json', mode: 'merge' }), { inserted: 1, updated: 1, removed: 0, total: 2 });
    const request = calls.at(-1);
    assert.deepEqual([request.method, request.url, request.type, request.client], ['POST', `${BASE}/db/leads/import?format=json&mode=merge`, 'application/json', 'web']);
    assert.equal(request.body, file, 'the file as the person chose it');
    await importCollection(APP, 'leads', file, { format: 'csv', mode: 'replace' });
    assert.deepEqual([calls.at(-1).url, calls.at(-1).type], [`${BASE}/db/leads/import?format=csv&mode=replace`, 'text/csv']);
    // What the server could not read is said in its words, with the row.
    await assert.rejects(importCollection(APP, 'bad', file, { format: 'json', mode: 'merge' }), /Record 2: each record must be a JSON object/);
  });
});

// ---------------------------------------------------------------- what the components draw

let server, DataPanel, i18n;
before(async () => {
  server = await createServer({ configFile: false, root: fileURLToPath(new URL('../../../', import.meta.url)), plugins: [vue()], server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', optimizeDeps: { noDiscovery: true } });
  DataPanel = (await server.ssrLoadModule('/src/features/hub/AppDataPanel.vue')).default;
  i18n = await server.ssrLoadModule('/src/i18n/index.ts');
});
after(async () => { await server?.close(); });
const render = (component, props) => renderToString(createSSRApp(component, props));
const KNOWN = [{ name: 'leads', count: 2, updated_at: 'now' }, { name: 'notes', count: 1, updated_at: 'now' }];

test('"Export data…" offers the app\'s collections, as JSON or CSV', async () => {
  i18n.useI18n().setLocale('en');
  const html = await render(DataPanel, { app: APP, mode: 'export', known: KNOWN });
  assert.match(html, /<section class="app-data" role="region" aria-label="Export data from Pipeline"/);
  assert.match(html, /<h3[^>]*>Export data from Pipeline<\/h3>/);
  assert.deepEqual([...html.matchAll(/<option value="([^"]+)"[^>]*>([^<]+)<\/option>/g)].map(match => [match[1], match[2]]), [['leads', 'leads · 2 records'], ['notes', 'notes · 1 record']]);
  assert.deepEqual([...html.matchAll(/<input[^>]*type="radio"[^>]*value="(\w+)"/g)].map(match => match[1]), ['json', 'csv']);
  assert.match(html, /Everything, as it is stored\./);
  assert.match(html, /One column per field, for a spreadsheet\./);
  assert.match(html, /<button type="submit" class="small-button primary"[^>]*>Export<\/button>/);
  assert.match(html, /aria-label="Close"/);
  assert.doesNotMatch(html, /type="file"/);
  // Before the list arrives, and for an app that keeps nothing in collections.
  assert.match(await render(DataPanel, { app: APP, mode: 'export' }), /<p class="app-data-note" role="status"[^>]*>Loading…<\/p>/);
  const empty = await render(DataPanel, { app: APP, mode: 'export', known: [] });
  assert.match(empty, /This app keeps no records in collections yet, so there is nothing to export\./);
  assert.doesNotMatch(empty, /<form/);
});

test('"Import data…" takes a file and a collection, and says what happens to what is there', async () => {
  i18n.useI18n().setLocale('en');
  const html = await render(DataPanel, { app: APP, mode: 'import', known: KNOWN });
  assert.match(html, /aria-label="Import data into Pipeline"/);
  assert.match(html, /<input type="file" accept="\.json,\.csv,application\/json,text\/csv"/);
  assert.match(html, /<input[^>]*type="text"[^>]*maxlength="64"[^>]*list="app-data-collections-/);
  assert.deepEqual([...html.matchAll(/<datalist[^>]*>(.*?)<\/datalist>/gs)].flatMap(match => [...match[1].matchAll(/value="([^"]+)"/g)].map(option => option[1])), ['leads', 'notes']);
  assert.deepEqual([...html.matchAll(/<input[^>]*type="radio"[^>]*value="(\w+)"/g)].map(match => match[1]), ['merge', 'replace']);
  assert.match(html, /<strong[^>]*>Keep them<\/strong>/);
  assert.match(html, /<strong[^>]*>Remove them first<\/strong>/);
  // Nothing to import yet: the button waits for a file and a collection.
  assert.match(html, /<button type="submit" class="small-button primary" disabled[^>]*>Import<\/button>/);
  assert.doesNotMatch(html, /app-data-confirm/, 'the confirmation appears only when records would be removed');

  i18n.useI18n().setLocale('pt-BR');
  const pt = await render(DataPanel, { app: { ...APP, name: 'Funil' }, mode: 'import', known: KNOWN });
  assert.match(pt, /Importar dados para Funil/);
  assert.match(pt, /Arquivo \(JSON ou CSV\)/);
  assert.match(pt, /Registros que já estão lá/);
  assert.match(pt, />Importar<\/button>/);
  const ptExport = await render(DataPanel, { app: { ...APP, name: 'Funil' }, mode: 'export', known: KNOWN });
  assert.match(ptExport, /Exportar dados de Funil/);
  assert.match(ptExport, /leads · 2 registros/);
  assert.match(ptExport, /notes · 1 registro</);
  i18n.useI18n().setLocale('en');
});

test('the app view passes changes on to the frame, forgets subscriptions with the page, and has the "…" menu', () => {
  const view = read('AppView.vue');
  // What the app asked to hear is noted when it asks, and forgotten when a new page loads in the frame or another app takes the view.
  assert.match(view, /subscribe: \(collection, on\) => subscriptions\.set\(collection, on\),/);
  assert.match(view, /errors\.value = \[\]; held\.value = false; subscriptions\.clear\(\);\n    clearAppContext\(liveKey\.value, owner\);/);
  assert.match(view, /place\.value = ""; errors\.value = \[\]; held\.value = false; subscriptions\.clear\(\);/);
  // Every write the server announces for this app goes through `changeFor`, to this view's own frame.
  assert.match(view, /stopRecords = watchRecords\(target, event => \{ void relay\(event\); \}\);/);
  assert.match(view, /const change = await changeFor\(event, subscriptions, \(collection, id\) => readRecord\(current, collection, id\)\);/);
  assert.match(view, /if \(change && frame\.value\?\.contentWindow === target\) tell\(target, \{ type: "records", collection: event\.collection, change \}\);/);
  // A socket that came back missed what was said meanwhile: whoever listens reads again.
  assert.match(view, /stopReconnect = onLiveReconnect\(\(\) => \{ void resync\(\); void renew\(\); resyncRecords\(\); \}\);/);
  assert.match(view, /for \(const collection of subscriptions\.list\(\)\) tell\(frame\.value\?\.contentWindow, \{ type: "records", collection, change: \{ type: "reset"/);
  assert.match(view, /stopWatching\?\.\(\); stopRecords\?\.\(\); stopReconnect\?\.\(\);/);

  // The "…" of the header: a menu with the two things, reachable by keyboard, closed by Esc with the focus back on the button.
  assert.match(view, /<button ref="moreButton" type="button" class="icon-button" aria-haspopup="menu" :aria-expanded="moreOpen" :aria-label="t\('More'\)"/);
  assert.match(view, /<div v-if="moreOpen" ref="moreMenu" class="app-view-more" role="menu"/);
  assert.deepEqual([...view.matchAll(/<button type="button" role="menuitem" @click="openData\('(\w+)'\)">.*?\{\{ t\('([^']+)'\) \}\}/g)].map(match => [match[1], match[2]]), [['export', 'Export data…'], ['import', 'Import data…']]);
  assert.match(view, /if \(event\.key === "Escape"\) \{ event\.preventDefault\(\); event\.stopPropagation\(\); closeMore\(true\); return; \}/);
  assert.match(view, /<AppDataPanel v-if="app && dataMode" :app="app" :mode="dataMode" @close="closeData" @imported="imported" @keydown\.esc\.stop="closeData" \/>/);
  // After an import an app that does not listen is loaded again, unless it holds unsaved input.
  assert.match(view, /if \(subscriptions\.size \|\| !frameSrc\.value\) return;\n  if \(held\.value\) show\(\{ kind: "waiting" \}\); else reload\(\);/);
  // The frame is still a page of its own: nothing here gave it Tendly's origin.
  assert.doesNotMatch(/<iframe[^>]*>/.exec(view)[0], /allow-same-origin/);
});

test('an agent without the skill is told about collections, revisions and files', () => {
  const text = appConvention('crm');
  assert.match(text, /tendly\.db\.collection\('leads'\)/);
  assert.match(text, /leads\.update\(id, patch, \{ rev \}\)/);
  assert.match(text, /error\.code === 'conflict'` and `error\.current`/);
  assert.match(text, /leads\.subscribe\(/);
  assert.match(text, /tendly\.files\.upload\(/);
  assert.match(text, /tendly\.files\.url\(path\)/);
  // What was there before is still said.
  assert.match(text, /tendly\.data\.get\(key, fallback\)/);
  assert.match(text, /sandboxed frame/);
});

// ---------------------------------------------------------------- translations and design rules

test('every string of this stage has a Brazilian Portuguese translation with the same placeholders', () => {
  const raw = readFileSync(new URL('../../i18n/pt-BR.json', here), 'utf8');
  const translations = JSON.parse(raw);
  // Strings chosen by a value, which the scan below can not see.
  const keys = new Set([
    'Added {inserted} records.', 'Updated {updated} records.', 'Added {inserted} records and updated {updated}.', 'Replaced {removed} records with {inserted}.',
    'More', 'Export data…', 'Import data…', 'Export data from {app}', 'Import data into {app}',
    // The "one or many" pairs.
    '{name} · {count} record', '{name} · {count} records', 'It has {count} record now.', 'It has {count} records now.',
    'This removes the {count} record in {collection} before importing. It cannot be undone.', 'This removes the {count} records in {collection} before importing. It cannot be undone.',
  ]);
  for (const match of read('AppDataPanel.vue').matchAll(/\bt\(\s*(["'])((?:\\.|(?!\1).)*)\1/g)) keys.add(match[2].replace(/\\'/g, "'"));
  assert.ok(keys.size >= 30, `found ${keys.size} strings`);
  // Each of the pairs above is really what the panel hands to t().
  for (const key of keys) if (/\{count\}|\{app\}/.test(key)) assert.ok(read('AppDataPanel.vue').includes(`'${key}'`), key);
  const placeholders = text => (text.match(/\{\w+\}/g) ?? []).sort();
  for (const key of keys) {
    assert.ok(key in translations, `missing pt-BR for ${JSON.stringify(key)}`);
    assert.deepEqual(placeholders(translations[key]), placeholders(key), key);
  }
  assert.equal(translations['Export data…'], 'Exportar dados…');
  assert.equal(translations['Import data…'], 'Importar dados…');
  assert.equal(translations['Remove and import'], 'Remover e importar');
  // The file keeps its shape: one space of indentation, no trailing newline.
  assert.equal(JSON.stringify(translations, null, 1), raw);
});

test('the new pieces follow the design rules: tokens, field borders, touch targets, no native confirm', () => {
  const panel = read('AppDataPanel.vue'), view = read('AppView.vue');
  const style = text => /<style scoped>([\s\S]*)<\/style>/.exec(text)[1];
  for (const css of [style(panel), style(view)]) {
    assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/, 'colours come from tokens');
    assert.doesNotMatch(css, /font-size:\s*\d/, 'type sizes come from tokens');
    assert.doesNotMatch(css, /border-radius:\s*\d+px/, 'radii come from tokens');
    assert.doesNotMatch(css, /outline:\s*(none|0)/, 'the focus ring stays');
  }
  assert.match(style(panel), /\.app-data-field :is\(input, select\) \{[^}]*border: 1px solid var\(--line-input\)/);
  assert.match(style(panel), /@media \(pointer: coarse\) \{[\s\S]*\.app-data \.small-button \{ min-height: 44px; min-width: 44px; \}[\s\S]*\.app-data-field :is\(input, select\) \{ min-height: 44px; \}/);
  assert.match(style(view), /@media \(pointer: coarse\) \{[\s\S]*\.app-view-more > button \{ min-height: 44px; \}/);
  // Replacing what is there is confirmed in place, never with the browser's own dialog.
  for (const text of [panel, view, read('app-records.ts')]) assert.doesNotMatch(text, /window\.confirm|\bconfirm\(|\balert\(/);
  assert.match(panel, /<div v-if="confirming" class="app-data-confirm" role="alert">/);
  assert.match(panel, /if \(importMode\.value === "replace" && there\.value > 0 && !confirming\.value\)/);
  // The panel fits a narrow pane: nothing in it has a fixed width.
  assert.doesNotMatch(style(panel), /[^-]width:\s*\d{3,}px/);
  assert.match(style(panel), /\.app-data-card \{[^}]*width: 100%; max-width: 520px; min-width: 0;/);
});
