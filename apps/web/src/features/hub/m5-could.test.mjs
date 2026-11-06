// M5: the "could" items that need no outside account.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { envKeyCount, splitEnvNames } from './catalog.ts';

const here = new URL('.', import.meta.url);
const read = name => readFileSync(new URL(name, here), 'utf8');

/** The components and modules M5 added, whose strings and styles are checked below. */
const COMPONENTS = ['EnvKeysSection.vue'];
const MODULES = ['catalog.ts'];

// ---------------------------------------------------------------- keys found in .env files

const FOUND = [
  { workspace_id: 'w1', workspace_name: 'Site', truncated: false, files: [
    { path: '.env', names: [{ name: 'STRIPE_SECRET_KEY', secret: true }, { name: 'PORT', secret: false }, { name: 'GITHUB_TOKEN', secret: true }] },
    { path: 'api/.env.local', names: [{ name: 'DATABASE_URL', secret: false }] },
  ] },
  { workspace_id: 'w2', workspace_name: 'Bot', truncated: true, files: [
    { path: '.env', names: [{ name: 'OPENAI_API_KEY', secret: true }] },
  ] },
];

test('env names are counted and split into keys and other variables', () => {
  assert.equal(envKeyCount(FOUND), 3);
  assert.equal(envKeyCount([]), 0);
  assert.deepEqual(splitEnvNames(FOUND[0].files[0]), { keys: ['STRIPE_SECRET_KEY', 'GITHUB_TOKEN'], others: ['PORT'] });
  assert.deepEqual(splitEnvNames(FOUND[0].files[1]), { keys: [], others: ['DATABASE_URL'] });
});

test('the keys section shows names only and says so', () => {
  const section = read('EnvKeysSection.vue');
  const page = read('IntegrationsPage.vue');
  assert.match(page, /<EnvKeysSection :workspaces="workspaces" \/>/);
  assert.match(section, /Tendly reads only their names, never their values/);
  // Nothing in the type or the template has a place for a value.
  const types = read('catalog.ts');
  const envName = /export interface EnvName \{([^}]*)\}/.exec(types)[1];
  assert.doesNotMatch(envName, /value/);
  assert.doesNotMatch(section, /\.value\b(?!\s*(=|\?\?|\)|;|\.))/, 'no field named value is drawn');
  // It never starts a conversation: this section only shows what was found.
  assert.doesNotMatch(section, /startConversation|\/hub\/start/);
  // Keys and other variables are told apart by a label, not only by weight or colour.
  assert.match(section, /t\('Keys'\)/);
  assert.match(section, /t\('Other variables'\)/);
});

// ---------------------------------------------------------------- translations and design rules

test('every M5 string has a Brazilian Portuguese translation with the same placeholders', () => {
  const raw = readFileSync(new URL('../../i18n/pt-BR.json', here), 'utf8');
  const translations = JSON.parse(raw);
  const keys = new Set();
  for (const file of COMPONENTS) {
    for (const match of read(file).matchAll(/\bt\(\s*(["'])((?:\\.|(?!\1).)*)\1/g)) keys.add(match[2]);
  }
  assert.ok(keys.size >= 7, `found ${keys.size} strings`);
  const placeholders = text => (text.match(/\{\w+\}/g) ?? []).sort();
  for (const key of keys) {
    assert.ok(!key.includes('\\'), `write ${JSON.stringify(key)} without an escape`);
    assert.ok(key in translations, `missing pt-BR for ${JSON.stringify(key)}`);
    assert.deepEqual(placeholders(translations[key]), placeholders(key), key);
  }
  assert.equal(translations['Keys found without a registration'], 'Chaves encontradas sem registro');
  // The file keeps its shape: one space of indentation, no trailing newline.
  assert.equal(raw, JSON.stringify(translations, null, 1));
});

test('M5 components follow the design rules: tokens, no native confirm, the focus ring stays', () => {
  for (const file of COMPONENTS) {
    const source = read(file);
    const style = source.slice(source.indexOf('<style'));
    assert.doesNotMatch(style, /#[0-9a-fA-F]{3,8}\b/, `${file}: no hex colours`);
    assert.doesNotMatch(style, /font-size:\s*\d+px/, `${file}: no px font sizes`);
    assert.doesNotMatch(style, /border-radius:\s*\d+px/, `${file}: radii come from tokens`);
    assert.doesNotMatch(style, /outline:\s*(none|0)/, `${file}: the global focus ring stays`);
    assert.doesNotMatch(source, /confirm\(/, `${file}: confirmations are inline`);
    // A sentence to read is never the faint colour.
    assert.doesNotMatch(style, /-(hint|label|note)\s*\{[^}]*var\(--faint\)/, `${file}: hints use --muted`);
  }
  for (const file of MODULES) assert.doesNotMatch(read(file), /window\.confirm/);
});
