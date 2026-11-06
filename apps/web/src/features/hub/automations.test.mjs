import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ago, duration, editPrompt, lastResult, presetLabel } from './automations.ts';

const t = (source, values = {}) => source.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? `{${key}}`));
const NOW = Date.parse('2026-11-05T12:00:00Z');

test('presets are recognised whatever the spacing', () => {
  assert.equal(presetLabel('0 9 * * 1-5'), 'Weekdays at 9:00');
  assert.equal(presetLabel(' 0  *  * * * '), 'Every hour');
  assert.equal(presetLabel('5 4 * * *'), undefined);
});

test('the last result says what happened and when', () => {
  const run = status => ({ id: 1, status, started_at: '2026-11-05T11:50:00Z', finished_at: '2026-11-05T11:55:00Z', exit_code: 0, session_id: null, trigger: 'schedule' });
  assert.deepEqual(lastResult({ running: false, last_run: null }, t, NOW), { text: "Didn't run yet", tone: 'none' });
  assert.deepEqual(lastResult({ running: false, last_run: run('ok') }, t, NOW), { text: 'Succeeded 5 min ago', tone: 'ok' });
  assert.equal(lastResult({ running: false, last_run: run('failed') }, t, NOW).tone, 'failed');
  assert.equal(lastResult({ running: false, last_run: run('timeout') }, t, NOW).text, 'Timed out 5 min ago');
  assert.equal(lastResult({ running: true, last_run: run('ok') }, t, NOW).tone, 'running');
  assert.equal(ago('2026-11-05T11:59:30Z', t, NOW), 'just now');
  assert.equal(ago('2026-11-03T12:00:00Z', t, NOW), '2 d ago');
  assert.equal(duration({ started_at: '2026-11-05T11:00:00Z', finished_at: '2026-11-05T11:00:12Z' }, t), '12 s');
  assert.equal(duration({ started_at: '2026-11-05T11:00:00Z', finished_at: null }, t), '');
});

test('edit with chat hands the agent the automation and the tool to save it', () => {
  const prompt = editPrompt({ id: 'a1', name: 'Backup', description: '', kind: 'script', cron: '0 3 * * *', timezone: null, workspace_id: null, command: 'echo hi', prompt: null, provider: null, endpoint_id: null, model: null, enabled: true, created_at: '', updated_at: '', next_run: null, last_run: null, running: false }, t);
  assert.match(prompt, /tendly_automation_update/);
  const body = JSON.parse(prompt.split('```json\n')[1].split('\n```')[0]);
  assert.equal(body.id, 'a1');
  assert.equal(body.command, 'echo hi');
  assert.equal(body.next_run, undefined);
});

test('every new string has a Brazilian Portuguese translation with the same placeholders', () => {
  const dir = new URL('.', import.meta.url);
  const translations = JSON.parse(readFileSync(new URL('automations.pt-BR.json', dir), 'utf8'));
  const shared = JSON.parse(readFileSync(new URL('../../i18n/pt-BR.json', dir), 'utf8'));
  const sources = ['AutomationsPage.vue', 'automations.ts'].map(name => readFileSync(new URL(name, dir), 'utf8')).join('\n');
  const keys = new Set();
  for (const match of sources.matchAll(/\bt\(\s*(["'])((?:\\.|(?!\1).)*)\1/g)) keys.add(match[2].replace(/\\'/g, "'"));
  for (const match of sources.matchAll(/label: "([^"]+)"/g)) keys.add(match[1]);
  const placeholders = text => (text.match(/\{\w+\}/g) ?? []).sort();
  for (const key of keys) {
    if (!(key in translations) && key in shared) continue; // Tendly translates it already.
    assert.ok(key in translations, `missing pt-BR for ${JSON.stringify(key)}`);
    assert.deepEqual(placeholders(translations[key]), placeholders(key), key);
  }
});
