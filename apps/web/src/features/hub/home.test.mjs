import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  continueTarget, effortOptions, groupConversations, keepOffered, modelOptions, permissionOptions,
  readHomeMemory, routineBySession, usageText,
} from './home.ts';

const t = (text, values = {}) => text.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''));
const session = (id, extra = {}) => ({ id, title: id, status: 'stopped', workspace_id: 'conv', provider: 'claude_code', updated_at: '2026-11-01T10:00:00Z', archived_at: null, ...extra });

test('Continue picks the conversation active most recently, skipping archived ones and terminals', () => {
  const sessions = [
    session('old', { updated_at: '2026-11-01T08:00:00Z' }),
    session('turned', { updated_at: '2026-10-01T08:00:00Z' }),
    session('archived', { updated_at: '2026-11-05T08:00:00Z', archived_at: '2026-11-05T09:00:00Z' }),
    session('shell', { updated_at: '2026-11-05T08:00:00Z', provider: 'terminal' }),
  ];
  // A last turn counts over the session's own update time, whatever the offset format.
  const activity = { turned: { last_turn_at: '2026-11-02T08:00:00.123+00:00' } };
  assert.equal(continueTarget(sessions, activity)?.id, 'turned');
  assert.equal(continueTarget(sessions, {})?.id, 'old');
  assert.equal(continueTarget([sessions[2], sessions[3]], {}), undefined);
  assert.equal(continueTarget([], {}), undefined);
});

test('routines group the conversations they opened, after Running now, without repeating them', () => {
  const routines = routineBySession([
    { session_id: 'r1', automation_id: 'a', automation_name: 'Morning brief', started_at: '2026-11-04T08:00:00Z', status: 'ok' },
    { session_id: 'r2', automation_id: 'a', automation_name: 'Morning brief', started_at: '2026-11-03T08:00:00Z', status: 'ok' },
    { session_id: 'r1', automation_id: 'b', automation_name: 'Older', started_at: '2026-11-01T08:00:00Z', status: 'ok' },
    { session_id: 'gone', automation_id: 'a', automation_name: 'Morning brief', started_at: '2026-11-02T08:00:00Z', status: 'ok' },
  ]);
  assert.equal(routines.get('r1').automation_name, 'Morning brief');
  const sessions = [
    session('mine', { updated_at: '2026-11-05T08:00:00Z' }),
    session('waiting', { status: 'waiting' }),
    session('busy', { status: 'running' }),
    // A routine's conversation may run in a project.
    session('r1', { workspace_id: 'project', updated_at: '2026-11-04T08:00:00Z' }),
    session('r2', { status: 'waiting' }),
    session('project-only', { workspace_id: 'project' }),
    session('hidden', { archived_at: '2026-11-01T00:00:00Z' }),
  ];
  const groups = groupConversations({ sessions, workspaceId: 'conv', routines, activity: {}, isUnread: id => id === 'mine' });
  assert.deepEqual(groups.map(g => [g.key, g.items.map(s => s.id)]), [
    ['unread', ['mine']],
    ['waiting', ['waiting', 'r2']],
    ['running', ['busy']],
    ['routines', ['r1']],
  ]);
  const found = groupConversations({ sessions, workspaceId: 'conv', routines, activity: {}, isUnread: () => false, query: 'morning' });
  assert.deepEqual(found.map(g => [g.key, g.items.map(s => s.id)]), [['waiting', ['r2']], ['routines', ['r1']]]);
});

test('the composer offers what New session would: the account models, its depths and the client permissions', () => {
  const profile = { id: 'p', provider: 'claude_code', name: 'Gateway', model: 'm-main', model_aliases: { fast: 'm-small' }, models: ['m-main', 'm-large'], native_config: null, effort: null };
  assert.deepEqual(modelOptions(profile).map(m => m.id), ['fast', 'm-main', 'm-large']);
  assert.deepEqual(modelOptions({ ...profile, native_config: { source_id: 'x' } }), []);
  assert.deepEqual(modelOptions(undefined), []);
  assert.deepEqual(effortOptions('claude_code', undefined, ''), ['low', 'medium', 'high', 'xhigh', 'max']);
  // Codex lists depths per model, and nothing was loaded: none are guessed.
  assert.deepEqual(effortOptions('codex', undefined, ''), []);
  assert.deepEqual(permissionOptions('claude_code'), ['ask', 'plan', 'accept_edits', 'danger']);
  assert.deepEqual(permissionOptions('codex'), ['ask', 'danger']);
  assert.equal(keepOffered('plan', ['ask', 'danger'], 'ask'), 'ask');
  assert.equal(keepOffered('danger', ['ask', 'danger'], 'ask'), 'danger');
  assert.equal(keepOffered('', ['ask'], 'ask'), '');
  assert.equal(keepOffered(undefined, ['ask'], ''), '');
});

test('the remembered choices survive bad storage', () => {
  assert.deepEqual(readHomeMemory('nope'), {});
  assert.deepEqual(readHomeMemory(null), {});
  assert.deepEqual(readHomeMemory('{"provider":"pi","workspace":3}'), {});
  const memory = readHomeMemory(JSON.stringify({ provider: 'codex', workspace: 'w', agents: { codex: { endpoint: '', model: 7, effort: 'high', permission: 'danger' }, bad: 1 } }));
  assert.equal(memory.provider, 'codex');
  assert.equal(memory.workspace, 'w');
  assert.deepEqual(memory.agents.codex, { endpoint: '', model: undefined, effort: 'high', permission: 'danger' });
  assert.equal(memory.agents.bad, undefined);
});

test('an account shows how much of its 5-hour and weekly windows it used', () => {
  const now = Date.parse('2026-11-05T10:00:00Z');
  const account = { limits: {
    primary: { used_percent: 18.4, window_minutes: 300, resets_at: '2026-11-05T12:00:00Z' },
    secondary: { used_percent: 37, window_kind: 'weekly', resets_at: '2026-11-09T12:00:00Z' },
  } };
  assert.equal(usageText(account, t, now), '5h 18% · Week 37%');
  assert.equal(usageText({ limits: { secondary: account.limits.secondary } }, t, now), 'Week 37%');
  assert.equal(usageText({}, t, now), '');
  assert.equal(usageText(undefined, t, now), '');
});

test('every new string has a Brazilian Portuguese translation with the same placeholders', () => {
  const dir = new URL('.', import.meta.url);
  const translations = {
    ...JSON.parse(readFileSync(new URL('../../i18n/pt-BR.json', dir), 'utf8')),
    ...JSON.parse(readFileSync(new URL('m1-home.pt-BR.json', dir), 'utf8')),
  };
  const sources = ['HomePage.vue', 'ConversationsBar.vue', 'home.ts'].map(name => readFileSync(new URL(name, dir), 'utf8')).join('\n');
  const keys = new Set();
  for (const match of sources.matchAll(/\bt\(\s*(["'])((?:\\.|(?!\1).)*)\1/g)) keys.add(match[2].replace(/\\'/g, "'"));
  for (const match of sources.matchAll(/(?:unread|waiting|running|routines|rest): "([^"]+)"/g)) keys.add(match[1]);
  const placeholders = text => (text.match(/\{\w+\}/g) ?? []).sort();
  for (const key of keys) {
    assert.ok(key in translations, `missing pt-BR for ${JSON.stringify(key)}`);
    assert.deepEqual(placeholders(translations[key]), placeholders(key), key);
  }
});
