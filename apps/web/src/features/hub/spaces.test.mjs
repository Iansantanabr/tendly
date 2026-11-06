import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ref } from 'vue';
import { ApiError } from '../api.ts';
import {
  ACTIVE_SPACE_KEY, layoutDiffers, layoutSignature, readActiveSpace, spaceFromQuery, spaceLink, spaceNameError,
  useSpaces, withoutSpaceQuery, writeActiveSpace,
} from './spaces.ts';

const pane = (id, extra = {}) => ({ type: 'pane', id, kind: 'agent_chat', metadata: { workspace_id: 'w1', session_id: id + '-s' }, ...extra });
const doc = (root) => ({ version: 1, root });
const base = () => doc({
  type: 'split', id: 's1', direction: 'horizontal', ratio: 0.5,
  first: pane('a'),
  second: { type: 'stack', kind: 'stack', id: 'k1', panes: [pane('b'), pane('c')], activePaneId: 'b' },
});

test('dirty detection ignores what is not the layout itself', () => {
  const saved = base();
  const same = base();
  same.root.second.activePaneId = 'c';
  same.root.second.collapsedFrom = 's9';
  same.root.first.title = 'Renamed by its session';
  same.root.first.metadata = { session_id: 'a-s', workspace_id: 'w1', ephemeral: true };
  same.root.ratio = 0.501;
  same.collapsed = [];
  assert.equal(layoutDiffers(same, saved), false);
  assert.equal(layoutSignature(same), layoutSignature(saved));
});

test('dirty detection sees panes, order, kinds, bindings and real resizes', () => {
  const saved = base();
  const changes = [
    d => { d.root.ratio = 0.6; },
    d => { d.root.direction = 'vertical'; },
    d => { d.root.second.panes.reverse(); },
    d => { d.root.second.panes.pop(); },
    d => { d.root.first.kind = 'terminal'; },
    d => { d.root.first.metadata.path = 'README.md'; },
    d => { d.root.first.metadata.workspace_id = 'w2'; },
    d => { d.root = d.root.first; },
  ];
  for (const change of changes) {
    const current = base();
    change(current);
    assert.equal(layoutDiffers(current, saved), true, change.toString());
  }
});

test('space names follow the server rules', () => {
  const spaces = [{ id: '1', name: 'Ads report' }, { id: '2', name: 'Ação' }];
  assert.equal(spaceNameError('Weekly', spaces), '');
  assert.equal(spaceNameError('  ', spaces), 'A space needs a name');
  assert.equal(spaceNameError('x'.repeat(81), spaces), 'Space names are at most 80 characters');
  assert.equal(spaceNameError('é'.repeat(80), spaces), '', 'characters, not bytes');
  assert.equal(spaceNameError(' ads REPORT ', spaces), 'A space with this name already exists');
  assert.equal(spaceNameError('AÇÃO', spaces), 'A space with this name already exists');
  assert.equal(spaceNameError('ADS report', spaces, '1'), '', 'renaming a space to itself in another case');
});

test('the espaco query is read once and dropped', () => {
  assert.equal(spaceFromQuery({ espaco: '7b0c2d1e-0000-4000-8000-000000000000' }), '7b0c2d1e-0000-4000-8000-000000000000');
  assert.equal(spaceFromQuery({ espaco: ['abc', 'def'] }), 'abc');
  for (const bad of [{}, { espaco: '' }, { espaco: '../x' }, { espaco: 'a b' }, { espaco: 3 }, { espaco: 'x'.repeat(65) }]) {
    assert.equal(spaceFromQuery(bad), undefined, JSON.stringify(bad));
  }
  assert.deepEqual(withoutSpaceQuery({ espaco: 'abc', tab: 'x' }), { tab: 'x' });
  assert.deepEqual(withoutSpaceQuery({ espaco: 'abc' }), {});
  assert.equal(spaceLink('http://host:8787', 'a b'), 'http://host:8787/mesa?espaco=a%20b');
});

test('the active space is remembered per browser', () => {
  const store = new Map();
  const storage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  assert.equal(readActiveSpace(storage), undefined);
  writeActiveSpace(storage, 'abc');
  assert.equal(store.get(ACTIVE_SPACE_KEY), 'abc');
  assert.equal(readActiveSpace(storage), 'abc');
  writeActiveSpace(storage, undefined);
  assert.equal(readActiveSpace(storage), undefined);
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.equal(readActiveSpace(broken), undefined);
  assert.doesNotThrow(() => writeActiveSpace(broken, 'x'));
  assert.equal(readActiveSpace(undefined), undefined);
});

function canvas(revision = 3) {
  const adopted = [];
  return {
    adopted,
    layout: ref(base()), revision: ref(revision), conflict: ref(false),
    flush: async () => {},
    adopt: async (layout, rev) => { adopted.push(rev); },
  };
}
function serve(handler) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : undefined });
    const [status, body] = handler(url, init);
    return new Response(status === 204 ? null : JSON.stringify(body), { status });
  };
  return calls;
}

test('opening a space sends the canvas revision and adopts the answer', async () => {
  const c = canvas(3);
  const opened = doc(pane('z'));
  const calls = serve(url => url.endsWith('/open') ? [200, { revision: 4, layout: opened }] : [200, { spaces: [{ id: 'sp', name: 'One', position: 0 }] }]);
  const spaces = useSpaces(c);
  await spaces.refresh();
  assert.equal(await spaces.open('sp'), 'opened');
  const open = calls.find(call => call.url.endsWith('/open'));
  assert.equal(open.url, '/api/hub/spaces/sp/open');
  assert.deepEqual(open.body, { expected_revision: 3 });
  assert.deepEqual(c.adopted, [4]);
  assert.equal(spaces.state.activeId, 'sp');
  assert.equal(spaces.active.value.name, 'One');
  c.layout.value = opened;
  assert.equal(spaces.dirty.value, false);
  c.layout.value = base();
  assert.equal(spaces.dirty.value, true);
});

test('a stale revision raises the canvas conflict and changes nothing', async () => {
  const c = canvas(3);
  serve(() => [409, { error: 'Shared canvas changed' }]);
  const spaces = useSpaces(c);
  assert.equal(await spaces.open('sp'), 'conflict');
  assert.equal(c.conflict.value, true);
  assert.deepEqual(c.adopted, []);
  assert.equal(spaces.state.activeId, undefined);
  // While the conflict stands, nothing is sent.
  const calls = serve(() => [200, {}]);
  assert.equal(await spaces.open('sp'), 'conflict');
  assert.equal(calls.length, 0);
  assert.ok(new ApiError('x', 409) instanceof Error);
});

test('every space string has a pt-BR translation', () => {
  const dir = new URL('./', import.meta.url);
  const translations = {
    ...JSON.parse(readFileSync(new URL('../../i18n/pt-BR.json', dir), 'utf8')),
  };
  const source = readFileSync(new URL('SpaceMenu.vue', dir), 'utf8');
  const keys = new Set(['A space needs a name', 'Space names are at most 80 characters', 'A space with this name already exists']);
  for (const match of source.matchAll(/\bt\(\s*(["'])((?:\\.|(?!\1).)*)\1/g)) keys.add(match[2]);
  assert.ok(keys.size > 15, `found ${keys.size} strings`);
  const placeholders = text => (text.match(/\{\w+\}/g) ?? []).sort();
  for (const key of keys) {
    assert.ok(key in translations, `missing pt-BR for ${JSON.stringify(key)}`);
    assert.deepEqual(placeholders(translations[key]), placeholders(key), key);
  }
  assert.equal(translations.Mesa, 'Mesa');
});
