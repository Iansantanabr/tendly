import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { colorFor, createPrompt, freeSlug, slugify } from './apps.ts';
import { APP_COLORS, appLetter } from './app-tile.ts';
import { contextFromPanes } from './open-context.ts';
import { appPane, filePane } from '../pane-context.ts';
import { backLabel } from '../page-back.ts';

test('an app name becomes a folder name, free in its workspace', () => {
  assert.equal(slugify('Funil de Vendas!'), 'funil-de-vendas');
  assert.equal(slugify('Ação rápida'), 'acao-rapida');
  assert.equal(slugify('   '), 'app');
  const list = [{ workspace_id: 'w', slug: 'crm' }, { workspace_id: 'w', slug: 'crm-2' }, { workspace_id: 'other', slug: 'notes' }];
  assert.equal(freeSlug('CRM', 'w', list), 'crm-3');
  assert.equal(freeSlug('Notes', 'w', list), 'notes');
});

test('tiles take a known colour and one capital letter', () => {
  assert.ok(APP_COLORS.includes(colorFor('Pipeline')));
  assert.equal(colorFor('Pipeline'), colorFor('Pipeline'));
  assert.equal(appLetter('', 'émile'), 'É');
  assert.equal(appLetter('xy', 'Name'), 'X');
  assert.equal(appLetter(undefined, ''), '?');
});

test('the prompt states the convention so it works without the skill, with the request', () => {
  const prompt = createPrompt({ name: 'Pipeline', description: 'Deals by stage', slug: 'pipeline' });
  for (const part of ['apps/pipeline/app.json', 'apps/pipeline/index.html', '<script src="/api/hub/apps/sdk.js"></script>', 'tendly.data.get', 'tendly.data.set', 'tendly.data.list', 'tendly.data.remove', 'apps/pipeline/data/', '360px', 'prefers-color-scheme', 'Static files only', 'Deals by stage', '"amber"']) assert.ok(prompt.includes(part), part);
  assert.match(createPrompt({ name: 'X', description: ' ', slug: 'x' }), /ask me what it should do/);
});

test('an open app is offered to its workspace\'s conversations as its folder', () => {
  const panes = [appPane({ workspace_id: 'w', slug: 'crm', name: 'CRM' }), filePane('w', 'notes.md'), appPane({ workspace_id: 'w', slug: 'crm', name: 'CRM' })];
  assert.deepEqual(contextFromPanes(panes), [{ workspaceId: 'w', path: 'apps/crm/', name: 'CRM' }, { workspaceId: 'w', path: 'notes.md', name: 'notes.md' }]);
  assert.deepEqual(contextFromPanes([{ type: 'pane', id: 'x', kind: 'app', metadata: { workspace_id: 'w' } }]), []);
});

test('the Apps page has its own way back', () => {
  assert.equal(backLabel('apps'), 'Back to apps');
});

test('every new string has a Brazilian Portuguese translation with the same placeholders', () => {
  const dir = new URL('.', import.meta.url);
  const translations = JSON.parse(readFileSync(new URL('../../i18n/pt-BR.json', dir), 'utf8'));
  const sources = ['AppsPage.vue', 'AppPane.vue', 'AppTile.vue'].map(name => readFileSync(new URL(name, dir), 'utf8')).join('\n');
  const keys = new Set(['Apps', 'App', 'New app', 'New', 'No apps yet. Ask an agent to build one for you.', 'Back to apps']);
  for (const match of sources.matchAll(/\bt\(\s*(["'])((?:\\.|(?!\1).)*)\1/g)) keys.add(match[2].replace(/\\'/g, "'"));
  const placeholders = text => (text.match(/\{\w+\}/g) ?? []).sort();
  for (const key of keys) {
    assert.ok(key in translations, `missing pt-BR for ${JSON.stringify(key)}`);
    assert.deepEqual(placeholders(translations[key]), placeholders(key), key);
  }
});

test('app tile colours are tokens for light and dark, not literals in components', () => {
  const css = readFileSync(new URL('../../styles.css', import.meta.url), 'utf8');
  for (const color of APP_COLORS) {
    for (const token of [`--app-${color}:`, `--app-${color}-soft:`]) assert.equal(css.split(token).length - 1, 3, `${token} in light, dark (system) and dark (chosen)`);
  }
});
