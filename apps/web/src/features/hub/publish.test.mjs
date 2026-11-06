import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { changes, problem, publicLink, tidySlug, validSlug } from './publish.ts';

const t = (source, values = {}) => source.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? `{${key}}`));
const published = { slug: 'relatorio-k3f9', workspace_id: 'w', path: 'docs/Relatório.html', visibility: 'team', mode: 'frozen', created_at: '', updated_at: '', frozen_at: '2026-11-05T12:00:00Z', has_password: false, url: '/p/relatorio-k3f9' };

test('link names are tidied the way the server accepts them', () => {
  assert.equal(tidySlug('Relatório Q3!'), 'relatorio-q3-');
  assert.equal(tidySlug('--Ação__final'), 'acao-final');
  assert.equal(tidySlug('x'.repeat(80)).length, 64);
  assert.ok(validSlug('relatorio-q3'));
  for (const bad of ['ab', 'Abc', 'a_b', 'a/b', 'x'.repeat(65)]) assert.ok(!validSlug(bad), bad);
});

test('the full link is this origin plus the publication path', () => {
  assert.equal(publicLink(published, 'http://127.0.0.1:8787'), 'http://127.0.0.1:8787/p/relatorio-k3f9');
  assert.equal(publicLink(published, 'https://mac.tail.ts.net/'), 'https://mac.tail.ts.net/p/relatorio-k3f9');
});

test('a password is needed only when there is none yet or a new one is typed', () => {
  const form = (visibility, password = '', slug = '') => ({ visibility, password, slug });
  assert.equal(problem(form('team'), false, t), '');
  assert.match(problem(form('password'), false, t), /at least 4/);
  assert.equal(problem(form('password'), true, t), '', 'keeps the current password');
  assert.match(problem(form('password', 'abc'), true, t), /at least 4/);
  assert.equal(problem(form('password', 'abcd'), false, t), '');
  assert.match(problem(form('public', '', 'ab'), false, t), /3 to 64/);
  assert.equal(problem(form('public', '', 'my-page-'), false, t), '', 'a trailing hyphen is dropped');
});

test('saving sends only what changed', () => {
  const form = { visibility: 'team', password: '', mode: 'frozen', slug: 'relatorio-k3f9' };
  assert.deepEqual(changes(published, form), {});
  assert.deepEqual(changes(published, { ...form, mode: 'live', slug: 'novo-nome-' }), { mode: 'live', slug: 'novo-nome' });
  assert.deepEqual(changes(published, { ...form, visibility: 'password', password: 'segredo' }), { visibility: 'password', password: 'segredo' });
  assert.deepEqual(changes({ ...published, visibility: 'password', has_password: true }, { ...form, visibility: 'password' }), {});
  assert.deepEqual(changes(published, { ...form, password: 'ignored' }), {}, 'a password only matters for password pages');
});

test('every publishing string has a Brazilian Portuguese translation with the same placeholders', () => {
  const dir = new URL('.', import.meta.url);
  const translations = {
    ...JSON.parse(readFileSync(new URL('../../i18n/pt-BR.json', dir), 'utf8')),
    ...JSON.parse(readFileSync(new URL('m1-files.pt-BR.json', dir), 'utf8')),
  };
  const sources = ['PublishDialog.vue', 'publish.ts'].map(name => readFileSync(new URL(name, dir), 'utf8')).join('\n');
  const keys = new Set();
  for (const match of sources.matchAll(/\bt\(\s*(["'])((?:\\.|(?!\1).)*)\1/g)) keys.add(match[2].replace(/\\'/g, "'"));
  for (const match of sources.matchAll(/\bt\([^()]*\?\s*'([^']+)'\s*:\s*'([^']+)'\s*\)/g)) { keys.add(match[1]); keys.add(match[2]); }
  for (const match of sources.matchAll(/label: "([^"]+)"/g)) keys.add(match[1]);
  assert.ok(keys.size > 20, `found ${keys.size} strings`);
  const placeholders = text => (text.match(/\{\w+\}/g) ?? []).sort();
  for (const key of keys) {
    assert.ok(key in translations, `missing pt-BR for ${JSON.stringify(key)}`);
    assert.deepEqual(placeholders(translations[key]), placeholders(key), key);
  }
});
