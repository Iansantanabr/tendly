import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GENERATED_LENGTH, PASSWORD_ALPHABET, generatePassword } from './password.ts';
import { authorizeInClaudeAi, filterSkills, skillChatPrompt, skillOrigins, sortSkills, stripFrontMatter } from './catalog.ts';
import { conversationOf } from './history.ts';
import { MODE_SHORT, VISIBILITY_SHORT, fileName, publishAgentPrompt } from './publish.ts';

const t = (source, values = {}) => source.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? `{${key}}`));

test('generated passwords have 12 unambiguous characters from a cryptographic source', () => {
  for (const ambiguous of '0Oo1lI') assert.ok(!PASSWORD_ALPHABET.includes(ambiguous), ambiguous);
  assert.equal(new Set(PASSWORD_ALPHABET).size, PASSWORD_ALPHABET.length, 'no repeated characters');
  for (let i = 0; i < 200; i++) {
    const password = generatePassword();
    assert.equal(password.length, GENERATED_LENGTH);
    assert.equal(GENERATED_LENGTH, 12);
    for (const c of password) assert.ok(PASSWORD_ALPHABET.includes(c), c);
  }
  assert.notEqual(generatePassword(), generatePassword());
});

test('bytes past the last whole multiple of the alphabet are thrown away', () => {
  const size = PASSWORD_ALPHABET.length;
  const limit = 256 - (256 % size);
  // First call: only bytes that must be rejected; then a fixed byte.
  let calls = 0;
  const random = bytes => { calls++; bytes.fill(calls === 1 ? limit : 1); return bytes; };
  assert.equal(generatePassword(4, random), PASSWORD_ALPHABET[1].repeat(4));
  assert.equal(calls, 2);
  const sequence = bytes => { bytes.forEach((_, i) => { bytes[i] = i; }); return bytes; };
  assert.equal(generatePassword(3, sequence), PASSWORD_ALPHABET.slice(0, 3));
});

const skill = (name, source, extra = {}) => ({ id: name, name, description: '', source, path: `/x/${name}/SKILL.md`, ...extra });
const skills = [
  skill('pdf', 'claude_plugin', { plugin: 'docs', description: 'Read PDFs' }),
  skill('mine', 'claude_user', { description: 'My own' }),
  skill('local', 'workspace', { workspace_id: 'w1', workspace_name: 'Site' }),
  skill('xlsx', 'claude_plugin', { plugin: 'docs' }),
  skill('cx', 'codex'),
  skill('lint', 'claude_plugin', { plugin: 'eng' }),
];

test('the folder filter lists each origin once, in page order, with its count', () => {
  assert.deepEqual(skillOrigins(skills).map(o => [o.key, o.count]), [
    ['workspace:w1', 1], ['user', 1], ['plugin:docs', 2], ['plugin:eng', 1], ['codex', 1],
  ]);
  assert.deepEqual(skillOrigins(skills)[0].values, { name: 'Site' });
  assert.deepEqual(sortSkills(skills).map(s => s.name), ['local', 'mine', 'pdf', 'xlsx', 'lint', 'cx']);
});

test('the folder filter and the search combine', () => {
  assert.equal(filterSkills(skills, '', '').length, skills.length);
  assert.deepEqual(filterSkills(skills, '', 'plugin:docs').map(s => s.name), ['pdf', 'xlsx']);
  assert.deepEqual(filterSkills(skills, 'pdf', 'plugin:docs').map(s => s.name), ['pdf']);
  assert.deepEqual(filterSkills(skills, 'pdf', 'user'), []);
  assert.deepEqual(filterSkills(skills, 'site', '').map(s => s.name), ['local']);
  assert.deepEqual(filterSkills(skills, '', 'codex').map(s => s.name), ['cx']);
});

test('a SKILL.md is shown without its YAML header', () => {
  assert.equal(stripFrontMatter('---\nname: a\ndescription: b\n---\n\n# Title\nBody'), '# Title\nBody');
  assert.equal(stripFrontMatter('---\n---\n# T'), '# T');
  assert.equal(stripFrontMatter('﻿---\r\nname: a\r\n---\r\n# T'), '# T');
  assert.equal(stripFrontMatter('# No header\n---\nname: x\n---'), '# No header\n---\nname: x\n---');
});

test('"Use in chat" names the skill and carries the note', () => {
  assert.match(skillChatPrompt({ name: 'pdf' }, '  ', t), /^Use the skill pdf\. Start by/);
  assert.equal(skillChatPrompt({ name: 'pdf' }, ' summarise report.pdf ', t), 'Use the skill pdf for this:\n\nsummarise report.pdf');
});

test('"Ask the agent" names the file and what to check', () => {
  const prompt = publishAgentPrompt('docs/report.html', t);
  assert.ok(prompt.includes('docs/report.html'));
  assert.match(prompt, /relative path/);
  assert.equal(fileName('docs/report.html'), 'report.html');
  assert.deepEqual(Object.keys(VISIBILITY_SHORT).sort(), ['password', 'public', 'team']);
  assert.deepEqual(Object.keys(MODE_SHORT).sort(), ['frozen', 'live']);
});

test('only Claude account and plugin servers waiting for sign-in link to claude.ai', () => {
  assert.ok(authorizeInClaudeAi({ status: 'needs_auth', source: 'claude_account' }));
  assert.ok(authorizeInClaudeAi({ status: 'needs_auth', source: 'claude_user', plugin: 'figma' }));
  assert.ok(!authorizeInClaudeAi({ status: 'needs_auth', source: 'claude_user' }));
  assert.ok(!authorizeInClaudeAi({ status: 'needs_auth', source: 'codex' }));
  assert.ok(!authorizeInClaudeAi({ status: 'connected', source: 'claude_account' }));
});

test('an agent version links to its conversation only when it has one', () => {
  assert.equal(conversationOf({ author_kind: 'agent', session_id: 's1' }), 's1');
  assert.equal(conversationOf({ author_kind: 'agent', session_id: null }), null);
  assert.equal(conversationOf({ author_kind: 'you', session_id: 's1' }), null);
});

test('every new M1 string has a Brazilian Portuguese translation with the same placeholders', () => {
  const dir = new URL('.', import.meta.url);
  const translations = {
    ...JSON.parse(readFileSync(new URL('../../i18n/pt-BR.json', dir), 'utf8')),
  };
  const sources = [
    'PublishDialog.vue', 'publish.ts', 'PublicationsList.vue', 'PublishedPanel.vue', 'SkillsPage.vue', 'catalog.ts',
    'FileHistoryPanel.vue', 'history.ts', 'IntegrationsPage.vue', '../SettingsPage.vue',
  ].map(name => readFileSync(new URL(name, dir), 'utf8')).join('\n');
  const keys = new Set(['Unpublishing…', 'Starting…', 'Start chat', ...Object.values(VISIBILITY_SHORT), ...Object.values(MODE_SHORT)]);
  for (const match of sources.matchAll(/\bt\(\s*(["'])((?:\\.|(?!\1).)*)\1/g)) keys.add(match[2].replace(/\\'/g, "'"));
  for (const match of sources.matchAll(/\bt\([^()]*\?\s*'([^']+)'\s*:\s*'([^']+)'\s*\)/g)) { keys.add(match[1]); keys.add(match[2]); }
  assert.ok(keys.size > 60, `found ${keys.size} strings`);
  const placeholders = text => (text.match(/\{\w+\}/g) ?? []).sort();
  for (const key of keys) {
    assert.ok(key in translations, `missing pt-BR for ${JSON.stringify(key)}`);
    assert.deepEqual(placeholders(translations[key]), placeholders(key), key);
  }
});
