import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ago, authorLabel, lineOps, size, unifiedDiff } from './history.ts';
import { parseUnifiedDiff } from '../git-model.ts';

const t = (source, values = {}) => source.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? `{${key}}`));
const NOW = Date.parse('2026-11-05T12:00:00Z');

test('versions name who made them', () => {
  assert.equal(authorLabel({ author_kind: 'you' }, t), 'You');
  assert.equal(authorLabel({ author_kind: 'agent', session_title: 'Fix login' }, t), 'Agent · Fix login');
  assert.equal(authorLabel({ author_kind: 'agent', session_title: null }, t), 'Agent');
  assert.equal(authorLabel({ author_kind: 'unknown' }, t), 'Outside Tendly');
  assert.equal(ago('2026-11-05T11:59:30Z', t, NOW), 'just now');
  assert.equal(ago('2026-11-05T09:00:00Z', t, NOW), '3 h ago');
  assert.equal(size(512), '512 B');
  assert.equal(size(2048), '2.0 KB');
});

test('a line diff keeps what both sides share', () => {
  assert.equal(unifiedDiff('a\nb\nc', 'a\nb\nc'), '');
  const ops = lineOps('a\nb\nc\nd', 'a\nx\nc\nd\ne');
  assert.deepEqual(ops.map(op => op.kind + op.text), [' a', '-b', '+x', ' c', ' d', '+e']);
  assert.deepEqual(lineOps('', 'one').map(op => op.kind + op.text), ['+one']);
});

test('the unified diff has real hunk headers and drops far context', () => {
  const before = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n');
  const after = before.replace('line 2\n', 'line two\n').replace('line 18\n', '');
  const diff = unifiedDiff(before, after);
  const headers = diff.split('\n').filter(line => line.startsWith('@@'));
  assert.deepEqual(headers, ['@@ -1,5 +1,5 @@', '@@ -15,6 +15,5 @@']);
  const rows = parseUnifiedDiff(diff);
  assert.deepEqual(rows.filter(r => r.kind === 'removed').map(r => r.before), [2, 18]);
  assert.deepEqual(rows.filter(r => r.kind === 'added').map(r => r.after), [2]);
  assert.equal(unifiedDiff('', 'new'), '@@ -0,0 +1,1 @@\n+new');
});

test('every new string has a Brazilian Portuguese translation with the same placeholders', () => {
  const dir = new URL('.', import.meta.url);
  const translations = {
    ...JSON.parse(readFileSync(new URL('../../i18n/pt-BR.json', dir), 'utf8')),
    ...JSON.parse(readFileSync(new URL('history.pt-BR.json', dir), 'utf8')),
  };
  const sources = ['FileHistoryPanel.vue', 'history.ts'].map(name => readFileSync(new URL(name, dir), 'utf8')).join('\n');
  const keys = new Set();
  for (const match of sources.matchAll(/\bt\(\s*(["'])((?:\\.|(?!\1).)*)\1/g)) keys.add(match[2].replace(/\\'/g, "'"));
  const placeholders = text => (text.match(/\{\w+\}/g) ?? []).sort();
  assert.ok(keys.size > 10);
  for (const key of keys) {
    assert.ok(key in translations, `missing pt-BR for ${JSON.stringify(key)}`);
    assert.deepEqual(placeholders(translations[key]), placeholders(key), key);
  }
});
