// M4: the settings a move to a VPS needs. The rules behind Settings →
// Addresses and time zone, what the panel draws, the dictation button obeying
// "off", and published links using the public address.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import vue from '@vitejs/plugin-vue';
import { createSSRApp, nextTick } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { linkLabel, publicLink, reachNote } from './publish.ts';
import { DEFAULT_SETTINGS, baseUrlProblem, filterZones, sampleLink, tidyBaseUrl, timeInZone, zoneLabel, zoneOffset } from './settings.ts';

const here = new URL('./', import.meta.url);
const repo = new URL('../../../../../', here);
const read = path => readFileSync(new URL(path, repo), 'utf8');
const same = (source, values = {}) => source.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? `{${key}}`));

const ZONES = ['Africa/Sao_Tome', 'America/Bahia', 'America/New_York', 'America/Sao_Paulo', 'Asia/Kolkata', 'Asia/Tokyo', 'Etc/GMT+3', 'Europe/Lisbon', 'UTC'];

// ---------------------------------------------------------------- time zones

test('the zone search ignores accents, case and the underscore, and needs every word', () => {
  assert.deepEqual(filterZones(ZONES, ''), ZONES);
  assert.deepEqual(filterZones(ZONES, '   '), ZONES);
  assert.deepEqual(filterZones(ZONES, 'sao paulo'), ['America/Sao_Paulo']);
  assert.deepEqual(filterZones(ZONES, 'São Paulo'), ['America/Sao_Paulo']);
  assert.deepEqual(filterZones(ZONES, 'SAO_PAULO'), ['America/Sao_Paulo']);
  assert.deepEqual(filterZones(ZONES, 'sao'), ['Africa/Sao_Tome', 'America/Sao_Paulo']);
  assert.deepEqual(filterZones(ZONES, 'america sao'), ['America/Sao_Paulo']);
  assert.deepEqual(filterZones(ZONES, 'paulo america'), ['America/Sao_Paulo'], 'in any order');
  assert.deepEqual(filterZones(ZONES, 'gmt+3'), ['Etc/GMT+3']);
  assert.deepEqual(filterZones(ZONES, 'atlantis'), []);
  // The zone in use never drops out of the list, so the select keeps showing it.
  assert.deepEqual(filterZones(ZONES, 'tokyo', 'America/Sao_Paulo'), ['America/Sao_Paulo', 'Asia/Tokyo']);
  assert.deepEqual(filterZones(ZONES, 'atlantis', 'UTC'), ['UTC']);
});

test('a zone shows its offset and the time on its clock', () => {
  const noon = new Date('2026-11-05T12:00:00Z');
  assert.equal(zoneOffset('America/Sao_Paulo', noon), 'UTC−03:00');
  assert.equal(zoneOffset('Asia/Tokyo', noon), 'UTC+09:00');
  assert.equal(zoneOffset('Asia/Kolkata', noon), 'UTC+05:30');
  assert.equal(zoneOffset('UTC', noon), 'UTC±00:00');
  // Daylight saving is the zone's business, not ours.
  assert.equal(zoneOffset('Europe/Lisbon', new Date('2026-07-01T12:00:00Z')), 'UTC+01:00');
  assert.equal(zoneOffset('Europe/Lisbon', noon), 'UTC±00:00');
  assert.equal(zoneOffset('Mars/Olympus', noon), '', 'a zone this browser does not know has no offset to show');
  assert.equal(zoneLabel('America/Sao_Paulo'), 'America / Sao Paulo');
  assert.equal(zoneLabel('UTC'), 'UTC');
  assert.match(timeInZone('America/Sao_Paulo', noon, 'pt-BR'), /09:00/);
  assert.match(timeInZone('Asia/Tokyo', noon, 'en'), /09:00\s?PM|21:00/);
  assert.equal(timeInZone('Mars/Olympus', noon), '');
});

// ---------------------------------------------------------------- the public address

test('a public address is an https domain and nothing more', () => {
  for (const good of ['', '   ', 'https://pub.example.com', 'https://pub.example.com/', ' https://Pub.Example.com ', 'https://pub.example.com:8443'])
    assert.equal(baseUrlProblem(good, same), '', good);
  assert.match(baseUrlProblem('http://pub.example.com', same), /has to start with https:\/\//);
  assert.match(baseUrlProblem('pub.example.com', same), /Start the address with https:\/\//);
  assert.match(baseUrlProblem('ftp://pub.example.com', same), /Start the address with https:\/\//);
  assert.match(baseUrlProblem('https://', same), /not a complete address/);
  assert.match(baseUrlProblem('https://user:secret@pub.example.com', same), /user name or password/);
  for (const withMore of ['https://pub.example.com/p', 'https://pub.example.com/?a=1', 'https://pub.example.com/#top', 'https://pub.example.com?', 'https://pub.example.com#'])
    assert.match(baseUrlProblem(withMore, same), /Use only the domain/, withMore);
  assert.equal(tidyBaseUrl('  https://pub.example.com/// '), 'https://pub.example.com');
  assert.equal(tidyBaseUrl(''), '');
  assert.equal(sampleLink('https://pub.example.com/', 'http://127.0.0.1:28789'), 'https://pub.example.com/p/report-k3f9');
  assert.equal(sampleLink('', 'http://127.0.0.1:28789/'), 'http://127.0.0.1:28789/p/report-k3f9', 'empty: this server\'s own address');
});

test('a published link uses the public address the server built, else this browser\'s own', () => {
  const local = { url: '/p/report-k3f9', public_url: null };
  const older = { url: '/p/report-k3f9' };
  const onVps = { url: '/p/report-k3f9', public_url: 'https://pub.example.com/p/report-k3f9' };
  assert.equal(publicLink(local, 'https://app.example.com'), 'https://app.example.com/p/report-k3f9');
  assert.equal(publicLink(older, 'http://127.0.0.1:28789/'), 'http://127.0.0.1:28789/p/report-k3f9', 'a server from before M4');
  assert.equal(publicLink(onVps, 'https://app.example.com'), 'https://pub.example.com/p/report-k3f9');
  assert.equal(linkLabel(local), '/p/report-k3f9');
  assert.equal(linkLabel(onVps), 'pub.example.com/p/report-k3f9');
  assert.match(reachNote('', same), /only on this machine or your Tailscale network/);
  const note = reachNote('https://pub.example.com', same);
  assert.match(note, /public address pub\.example\.com/);
  assert.match(note, /Only the team/);
  // Every place that shows or opens a link goes through publicLink.
  const list = read('apps/web/src/features/hub/PublicationsList.vue');
  assert.doesNotMatch(list, /:href="item\.url"/, 'the list opens the public link, not the relative one');
  assert.equal((list.match(/publicLink\(item, origin\)/g) ?? []).length, 4);
  const dialog = read('apps/web/src/features/hub/PublishDialog.vue');
  assert.match(dialog, /publicLink\(current\.value, origin\)/);
  assert.match(dialog, /reachNote\(publicBaseUrl, t\)/);
});

// ---------------------------------------------------------------- wiring

test('Settings has a routed section for addresses and the time zone', () => {
  // The router turns any section it does not list into "preferences".
  assert.match(read('apps/web/src/router.ts'), /SETTINGS_SECTIONS = \[[^\]]*"addresses"[^\]]*\] as const/);
  const page = read('apps/web/src/features/SettingsPage.vue');
  assert.match(page, /\{ id: 'addresses', icon: 'clock', label: 'Addresses and time zone' \}/);
  assert.match(page, /<AddressesPanel v-else-if="hubSection==='addresses'"\/>/);
  assert.deepEqual(DEFAULT_SETTINGS, { timezone: 'America/Sao_Paulo', public_base_url: '', dictation: 'browser' });
});

test('automations say which time zone their schedule is read in', async () => {
  const { editPrompt } = await import('./automations.ts');
  const automation = { id: 'a1', name: 'Morning report', description: '', kind: 'script', cron: '0 9 * * *', timezone: null, effective_timezone: 'America/Bahia', workspace_id: null, command: 'true', prompt: null, provider: null, endpoint_id: null, model: null, enabled: true };
  const prompt = editPrompt(automation, same);
  assert.match(prompt, /time zone of Tendly's settings \(America\/Bahia\)/);
  assert.doesNotMatch(prompt, /this machine/);
  assert.doesNotMatch(prompt, /effective_timezone/, 'a computed field is not something to send back');
  assert.match(editPrompt({ ...automation, effective_timezone: undefined }, same), /\(America\/Sao_Paulo\)/, 'a server from before M4');
  const page = read('apps/web/src/features/hub/AutomationsPage.vue');
  assert.match(page, /In the time zone \{zone\}, set in Settings → Addresses and time zone\./);
  assert.doesNotMatch(page, /this machine\\?'s time zone/);
});

// ---------------------------------------------------------------- what the components draw

let server, Panel, Button, i18n, settings;
before(async () => {
  server = await createServer({ configFile: false, root: fileURLToPath(new URL('../../../', import.meta.url)), plugins: [vue()], server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', optimizeDeps: { noDiscovery: true } });
  Panel = (await server.ssrLoadModule('/src/features/hub/AddressesPanel.vue')).default;
  Button = (await server.ssrLoadModule('/src/features/hub/DictationButton.vue')).default;
  i18n = await server.ssrLoadModule('/src/i18n/index.ts');
  settings = await server.ssrLoadModule('/src/features/hub/settings.ts');
});
after(async () => { await server?.close(); });

const render = (component, props) => renderToString(createSSRApp(component, props));
const tag = (html, pattern) => pattern.exec(html)?.[0] ?? '';

test('the panel shows the saved zone, the public address and the dictation switch', async () => {
  i18n.useI18n().setLocale('en');
  settings.resetHubSettings();
  settings.hubSettings.value = { timezone: 'America/Sao_Paulo', public_base_url: 'https://pub.example.com', dictation: 'browser' };
  settings.hubSettingsKnown.value = true;
  settings.zoneList.value = { zones: ZONES, server: 'Etc/UTC' };
  const html = await render(Panel);
  assert.match(html, /aria-label="Addresses and time zone"/);
  assert.match(html, /<h2[^>]*>Time zone<\/h2>/);
  assert.match(html, /<option[^>]*value="America\/Sao_Paulo"[^>]*selected[^>]*>America \/ Sao Paulo \(UTC−03:00\)<\/option>/);
  assert.equal((html.match(/<option/g) ?? []).length, ZONES.length);
  assert.match(html, /Chosen: America \/ Sao Paulo\./);
  assert.match(html, /It is [^<]+ there now \(UTC−03:00\)\./);
  assert.match(html, /The clock of the machine running Tendly is in Etc \/ UTC; automations ignore it\./);
  assert.match(tag(html, /<button[^>]*>Save time zone<\/button>/), /disabled/, 'nothing to save until the zone changes');
  assert.match(tag(html, /<input[^>]*type="url"[^>]*>/), /value="https:\/\/pub\.example\.com"/);
  assert.match(tag(html, /<input[^>]*type="url"[^>]*>/), /aria-invalid="false"/);
  assert.match(html, /A link will look like this:[^<]*<code[^>]*>https:\/\/pub\.example\.com\/p\/report-k3f9<\/code>/);
  assert.match(html, /TENDLY_ALLOWED_ORIGINS/);
  assert.match(tag(html, /<input[^>]*role="switch"[^>]*>/), /checked/);
  assert.match(html, /Chrome sends the audio to Google/);
  assert.doesNotMatch(html, /role="alert"/);
  assert.doesNotMatch(html, /window\.confirm/);

  settings.hubSettings.value = { timezone: 'Asia/Tokyo', public_base_url: '', dictation: 'off' };
  const off = await render(Panel);
  assert.match(off, /<option[^>]*value="Asia\/Tokyo"[^>]*selected/);
  assert.doesNotMatch(tag(off, /<input[^>]*role="switch"[^>]*>/), /checked/);
  assert.match(off, /Off\. The microphone button is hidden in every message box\./);
  assert.match(tag(off, /<input[^>]*type="url"[^>]*>/), /placeholder="https:\/\/pub\.example\.com"/);
});

test('before the settings arrive the panel says so and nothing can be changed', async () => {
  i18n.useI18n().setLocale('en');
  settings.resetHubSettings();
  settings.zoneList.value = undefined;
  const html = await render(Panel);
  assert.match(html, /Loading…/);
  assert.match(tag(html, /<select[^>]*>/), /disabled/);
  assert.match(tag(html, /<input[^>]*type="url"[^>]*>/), /disabled/);
  assert.match(tag(html, /<input[^>]*role="switch"[^>]*>/), /disabled/);
  assert.match(tag(html, /<button[^>]*>Save address<\/button>/), /disabled/);
});

test('the panel reads in Brazilian Portuguese', async () => {
  i18n.useI18n().setLocale('pt-BR');
  settings.resetHubSettings();
  settings.hubSettings.value = { timezone: 'America/Sao_Paulo', public_base_url: '', dictation: 'browser' };
  settings.hubSettingsKnown.value = true;
  settings.zoneList.value = { zones: ZONES, server: 'America/Sao_Paulo' };
  const html = await render(Panel);
  assert.match(html, /aria-label="Endereços e fuso horário"/);
  assert.match(html, /Fuso horário/);
  assert.match(html, /Endereço dos links publicados/);
  assert.match(html, /Salvar fuso horário/);
  assert.match(html, /Botão de microfone na caixa de mensagem/);
  assert.doesNotMatch(html, /O relógio da máquina/, 'the same zone as the machine needs no remark');
  i18n.useI18n().setLocale('en');
});

test('the microphone button is hidden when dictation is off, and until the setting is known', async () => {
  i18n.useI18n().setLocale('en');
  const dictation = { supported: true, listening: { value: false }, toggle() {}, stop() {} };
  settings.resetHubSettings();
  assert.equal(settings.dictationAllowed.value, false);
  assert.doesNotMatch(await render(Button, { dictation }), /<button/, 'not drawn before the setting is known');

  settings.hubSettings.value = { timezone: 'America/Sao_Paulo', public_base_url: '', dictation: 'browser' };
  settings.hubSettingsKnown.value = true;
  assert.equal(settings.dictationAllowed.value, true);
  assert.match(await render(Button, { dictation }), /<button[^>]*aria-label="Dictate"/);

  settings.hubSettings.value = { ...settings.hubSettings.value, dictation: 'off' };
  assert.equal(settings.dictationAllowed.value, false);
  assert.doesNotMatch(await render(Button, { dictation }), /<button/);

  // A browser without speech recognition never shows it, whatever the setting.
  settings.hubSettings.value = { ...settings.hubSettings.value, dictation: 'browser' };
  assert.doesNotMatch(await render(Button, { dictation: { ...dictation, supported: false } }), /<button/);
});

test('the settings are read once and a failed read falls back to the defaults', async () => {
  settings.resetHubSettings();
  let calls = 0;
  const answer = { timezone: 'Europe/Lisbon', public_base_url: 'https://pub.example.com', dictation: 'off' };
  await Promise.all([
    settings.loadHubSettings(async () => { calls++; return answer; }),
    settings.loadHubSettings(async () => { calls++; return answer; }),
  ]);
  await settings.loadHubSettings(async () => { calls++; return answer; });
  assert.equal(calls, 1, 'every component shares one request');
  assert.deepEqual(settings.hubSettings.value, answer);
  assert.equal(settings.publicBaseUrl.value, 'https://pub.example.com');
  assert.equal(settings.hubTimezone.value, 'Europe/Lisbon');
  assert.equal(settings.dictationAllowed.value, false);

  // A server from before M4 (404): dictation works as it did, links use the browser's address.
  settings.resetHubSettings();
  await settings.loadHubSettings(async () => { throw new Error('Request failed (404)'); });
  await nextTick();
  assert.equal(settings.hubSettings.value, undefined);
  assert.equal(settings.hubSettingsKnown.value, true);
  assert.equal(settings.dictationAllowed.value, true);
  assert.equal(settings.publicBaseUrl.value, '');
  assert.equal(settings.hubTimezone.value, 'America/Sao_Paulo');
  // And the next component to ask tries again.
  await settings.loadHubSettings(async () => answer);
  assert.deepEqual(settings.hubSettings.value, answer);
  settings.resetHubSettings();
});

// ---------------------------------------------------------------- translations and design rules

test('every M4 string has a Brazilian Portuguese translation with the same placeholders', () => {
  const translations = JSON.parse(read('apps/web/src/i18n/pt-BR.json'));
  // Strings chosen by a condition, which the scan below cannot see.
  const keys = new Set([
    'Addresses and time zone', 'Saving…', 'Save time zone', 'Save address',
    'Saved. Published links now use this address.', 'Saved. Published links use Tendly’s own address again.',
    'On this Mac the link opens only on this machine or your Tailscale network.',
    "Ask me what to change if I have not said it yet. Then save the change with the tendly_automation_update tool, using this id; do not create a new automation. The schedule is a five-field cron in the time zone of Tendly's settings ({zone}) unless timezone says otherwise.",
    'Five fields: minute, hour, day of month, month, day of week. In the time zone {zone}, set in Settings → Addresses and time zone.',
  ]);
  for (const file of ['AddressesPanel.vue', 'settings.ts']) {
    const source = readFileSync(new URL(file, here), 'utf8');
    for (const match of source.matchAll(/\bt\(\s*(["'])((?:\\.|(?!\1).)*)\1/g)) keys.add(match[2]);
  }
  const publish = readFileSync(new URL('publish.ts', here), 'utf8');
  keys.add(/t\("(Links use the public address[^"]+)"/.exec(publish)[1]);
  assert.ok(keys.size > 35, `found ${keys.size} strings`);
  const placeholders = text => (text.match(/\{\w+\}/g) ?? []).sort();
  for (const key of keys) {
    assert.ok(!key.includes('\\'), `write ${JSON.stringify(key)} without an escape`);
    assert.ok(key in translations, `missing pt-BR for ${JSON.stringify(key)}`);
    assert.deepEqual(placeholders(translations[key]), placeholders(key), key);
  }
  assert.equal(translations['Addresses and time zone'], 'Endereços e fuso horário');
  // The old wording, which promised the machine's zone, is gone from the code and the file.
  assert.ok(!Object.keys(translations).some(key => /this machine's time zone/.test(key)));
  // The file keeps its shape: one space of indentation, no trailing newline.
  const raw = read('apps/web/src/i18n/pt-BR.json');
  assert.equal(raw, JSON.stringify(translations, null, 1));
});

test('the panel follows the design rules: tokens, input borders, touch targets, inline feedback', () => {
  const panel = read('apps/web/src/features/hub/AddressesPanel.vue');
  const style = panel.slice(panel.indexOf('<style'));
  assert.doesNotMatch(style, /#[0-9a-fA-F]{3,8}\b/, 'no hex colours');
  assert.doesNotMatch(style, /font-size:\s*\d+px/, 'no px font sizes');
  assert.doesNotMatch(style, /border-radius:\s*\d+px/, 'radii come from tokens');
  assert.match(style, /border: 1px solid var\(--line-input\)/, 'field borders use --line-input');
  assert.match(style, /font-size: var\(--input-text\)/, '16px inputs: iOS does not zoom');
  assert.match(style, /@media \(pointer: coarse\)[^}]*\{[^}]*min-height: 44px/s);
  assert.doesNotMatch(style, /outline:\s*(none|0)/, 'the global focus ring stays');
  assert.doesNotMatch(panel, /confirm\(/);
  assert.match(panel, /role="switch"/);
  assert.match(panel, /role="alert"/);
  assert.match(panel, /role="status"/);
});
