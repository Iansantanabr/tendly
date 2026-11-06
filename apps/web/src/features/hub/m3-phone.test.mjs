import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import vm from 'node:vm';
import { PRESENCE_INPUT_WINDOW_MS, isPresent } from './presence.ts';
import { canRegisterWorker, installHint, isIos, navigationTarget } from './pwa.ts';
import { PUSH_ERROR_TEXT, PushError, deviceLabel, keyBytes, pushSupport, sameKey, serviceName, sha256Hex } from './push.ts';

const here = new URL('./', import.meta.url);
const repo = new URL('../../../../../', here);
const read = path => readFileSync(new URL(path, repo), 'utf8');

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
const ANDROID_CHROME = 'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const MAC_CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const MAC_SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15';

// ---------------------------------------------------------------- what this device can do

test('push support names the reason it cannot be turned on', () => {
  const capable = { secure: true, serviceWorker: true, pushManager: true, notification: true, permission: 'default', ios: false, standalone: false };
  assert.equal(pushSupport(capable), 'ready');
  assert.equal(pushSupport({ ...capable, permission: 'granted' }), 'ready');
  assert.equal(pushSupport({ ...capable, permission: 'denied' }), 'denied');
  // http on the local network: nothing else matters until the page is secure.
  assert.equal(pushSupport({ ...capable, secure: false }), 'insecure');
  assert.equal(pushSupport({ ...capable, secure: false, ios: true, pushManager: false }), 'insecure');
  // Safari on an iPhone has no push in a tab; the installed app has.
  const iphoneTab = { ...capable, ios: true, pushManager: false, notification: false, permission: undefined };
  assert.equal(pushSupport(iphoneTab), 'needs-install');
  assert.equal(pushSupport({ ...iphoneTab, standalone: true }), 'unsupported', 'installed and still without push: an old iOS');
  assert.equal(pushSupport({ ...capable, ios: true, standalone: true }), 'ready');
  assert.equal(pushSupport({ ...capable, pushManager: false }), 'unsupported');
  assert.equal(pushSupport({ ...capable, serviceWorker: false }), 'unsupported');
});

test('devices get a short name people recognise', () => {
  assert.equal(deviceLabel(IPHONE), 'iPhone');
  assert.equal(deviceLabel(MAC_SAFARI, 'MacIntel', 5), 'iPad', 'an iPad says it is a Mac');
  assert.equal(deviceLabel(ANDROID_CHROME), 'Android · Chrome');
  assert.equal(deviceLabel(MAC_CHROME, 'MacIntel', 0), 'Mac · Chrome');
  assert.equal(deviceLabel(MAC_SAFARI, 'MacIntel', 0), 'Mac · Safari');
  assert.equal(deviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0'), 'Windows · Edge');
  assert.equal(deviceLabel('Mozilla/5.0 (Android 15; Mobile; rv:132.0) Gecko/132.0 Firefox/132.0'), 'Android · Firefox');
  assert.equal(deviceLabel('Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36'), 'Android · Samsung Internet');
  assert.equal(deviceLabel('curl/8'), '');
  assert.equal(serviceName('fcm.googleapis.com'), 'Google');
  assert.equal(serviceName('web.push.apple.com'), 'Apple');
  assert.equal(serviceName('updates.push.services.mozilla.com'), 'Mozilla');
  assert.equal(serviceName('wns2-by3p.notify.windows.com'), 'Microsoft');
  assert.equal(serviceName('127.0.0.1'), '127.0.0.1');
});

test('the server key becomes the bytes the browser subscribes with', async () => {
  // An uncompressed P-256 point: 65 bytes starting with 4 (RFC 8291, appendix A).
  const key = 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8';
  const bytes = keyBytes(key);
  assert.equal(bytes.length, 65);
  assert.equal(bytes[0], 4);
  assert.equal(Buffer.from(bytes).toString('base64url'), key);
  assert.equal(sameKey(bytes.buffer, key), true);
  assert.equal(sameKey(keyBytes('BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4').buffer, key), false);
  assert.equal(sameKey(null, key), false);
  assert.equal(sameKey(new ArrayBuffer(3), key), false);
  // The same hash the server computes for `endpoint_sha256`.
  assert.equal(await sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('errors keep a translatable reason and what the browser said', () => {
  const error = new PushError('subscribe', 'Registration failed - push service error');
  assert.equal(error.message, PUSH_ERROR_TEXT.subscribe);
  assert.equal(error.detail, 'Registration failed - push service error');
  assert.equal(new PushError('denied').detail, '');
});

// ---------------------------------------------------------------- who is looking

test('present means visible, focused and recently touched', () => {
  const now = 1_000_000_000;
  const here = { hidden: false, focused: true, lastInputAt: now - 5_000, now };
  assert.equal(isPresent(here), true);
  assert.equal(isPresent({ ...here, hidden: true }), false, 'another tab is in front');
  assert.equal(isPresent({ ...here, focused: false }), false, 'another window has the keyboard');
  assert.equal(isPresent({ ...here, lastInputAt: now - PRESENCE_INPUT_WINDOW_MS - 1 }), false, 'left the desk with the window open');
  assert.equal(isPresent({ ...here, lastInputAt: now - PRESENCE_INPUT_WINDOW_MS }), true);
  assert.equal(isPresent({ ...here, lastInputAt: 0 }), false, 'never touched');
});

// ---------------------------------------------------------------- installing

test('the worker is registered only where browsers allow one', () => {
  assert.equal(canRegisterWorker({ secure: true, serviceWorker: true, dev: false }), true);
  assert.equal(canRegisterWorker({ secure: false, serviceWorker: true, dev: false }), false, 'http on the local network');
  assert.equal(canRegisterWorker({ secure: true, serviceWorker: false, dev: false }), false);
  assert.equal(canRegisterWorker({ secure: true, serviceWorker: true, dev: true }), false, 'the dev server has no /sw.js');
});

test('a tapped notification can only lead inside the app', () => {
  assert.equal(navigationTarget({ type: 'tendly:navigate', url: '/session/abc' }), '/session/abc');
  assert.equal(navigationTarget({ type: 'tendly:navigate', url: '/notificacoes' }), '/notificacoes');
  for (const bad of [
    { type: 'tendly:navigate', url: 'https://evil.example/' },
    { type: 'tendly:navigate', url: '//evil.example/' },
    { type: 'tendly:navigate', url: '/\\evil.example/' },
    { type: 'tendly:navigate', url: 42 },
    { type: 'something-else', url: '/session/abc' },
    null, 'text', undefined,
  ]) assert.equal(navigationTarget(bad), undefined, JSON.stringify(bad));
});

test('the install hint shows on phones that have not installed, in the way each can', () => {
  const phone = { secure: true, standalone: false, coarse: true, ios: false, canPrompt: false };
  assert.equal(installHint({ ...phone, canPrompt: true }), 'prompt', 'Chrome on Android offers its dialog');
  assert.equal(installHint(phone), 'menu', 'no dialog offered: the browser menu');
  assert.equal(installHint({ ...phone, ios: true }), 'ios');
  assert.equal(installHint({ ...phone, ios: true, secure: false }), 'ios', 'an iPhone adds to the Home Screen from any page');
  assert.equal(installHint({ ...phone, secure: false }), 'none', 'elsewhere it needs https first');
  assert.equal(installHint({ ...phone, standalone: true, canPrompt: true }), 'none', 'already installed');
  assert.equal(installHint({ ...phone, coarse: false, canPrompt: true }), 'none', 'a desktop is not nagged');
  assert.equal(isIos(IPHONE), true);
  assert.equal(isIos(MAC_SAFARI, 'MacIntel', 5), true);
  assert.equal(isIos(MAC_SAFARI, 'MacIntel', 0), false);
  assert.equal(isIos(ANDROID_CHROME), false);
});

// ---------------------------------------------------------------- the service worker

const ORIGIN = 'https://tendly.test';

/** Runs the real sw.js in a sandbox with stand-ins for the browser around it. */
function worker({ language = 'en-US', windows = [], online = true } = {}) {
  const listeners = {};
  const stores = new Map();
  const key = request => typeof request === 'string' ? new URL(request, ORIGIN).href : request.url;
  const fetched = [];
  const answer = url => {
    const path = new URL(url).pathname;
    const type = path.endsWith('.js') ? 'text/javascript' : path.endsWith('.png') ? 'image/png' : path.endsWith('.svg') ? 'image/svg+xml' : 'text/html';
    return { ok: true, type: 'basic', url, headers: new Headers({ 'content-type': type }), clone() { return this; } };
  };
  const fetch = async (request, init) => {
    const url = key(request);
    fetched.push({ url, init });
    if (!online) throw new TypeError('Failed to fetch');
    return answer(url);
  };
  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name);
      return {
        async match(request) { const hit = store.get(key(request)); return hit ? hit.clone() : undefined; },
        async put(request, response) { store.set(key(request), response); },
        async add(request) { store.set(key(request), await fetch(request)); },
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
  };
  const shown = [], opened = [];
  let subscribed;
  const self = {
    location: { origin: ORIGIN },
    navigator: { language },
    registration: {
      async showNotification(title, options) { shown.push({ title, options }); },
      pushManager: { async subscribe(options) { subscribed = options; return { toJSON: () => ({ endpoint: 'https://push.example/new', keys: { p256dh: 'P', auth: 'A' } }) }; } },
    },
    clients: { async matchAll() { return windows; }, async openWindow(url) { opened.push(url); }, async claim() {} },
    async skipWaiting() {},
    addEventListener(type, listener) { listeners[type] = listener; },
  };
  const source = read('crates/server/src/hub/pwa/sw.js').replace('__BUILD__', 'build1');
  vm.runInContext(source, vm.createContext({ self, caches, fetch, URL, Response, Headers, console }));
  async function dispatch(type, properties = {}) {
    const waits = [];
    const event = { waitUntil(promise) { waits.push(promise); }, respondWith(promise) { event.response = promise; }, ...properties };
    listeners[type](event);
    await Promise.all(waits);
    return event;
  }
  const pushed = data => dispatch('push', { data: { json: () => data, text: () => JSON.stringify(data) } });
  const get = (path, mode = 'no-cors') => dispatch('fetch', { request: { method: 'GET', url: ORIGIN + path, mode } });
  return { listeners, stores, fetched, shown, opened, dispatch, pushed, get, subscription: () => subscribed };
}

test('the worker shows what the server pushed, in the language of the app', async () => {
  const english = worker({ language: 'en-US' });
  await english.pushed({ title: 'Fix the login bug', body: 'Finished replying', kind: 'turn_completed', detail: '', url: '/session/abc', tag: 'tendly-abc' });
  assert.equal(english.shown.length, 1);
  assert.equal(english.shown[0].title, 'Fix the login bug');
  const options = english.shown[0].options;
  assert.equal(options.body, 'Finished replying');
  assert.equal(options.icon, '/icons/icon-192.png');
  assert.equal(options.badge, '/icons/badge-96.png');
  assert.equal(options.tag, 'tendly-abc');
  assert.equal(options.renotify, true);
  assert.deepEqual({ ...options.data }, { url: '/session/abc' });

  // A phone in Portuguese, before the app ever told the worker its language.
  const phone = worker({ language: 'pt-BR' });
  await phone.pushed({ title: 'Relatório', body: 'Routine failed: exit code 2', kind: 'automation_failed', detail: 'exit code 2', url: '/notificacoes', tag: 't' });
  assert.equal(phone.shown[0].options.body, 'Rotina falhou\nexit code 2');
  await phone.pushed({ title: 'Tendly', body: 'Notifications are working on this device.', kind: 'test', url: '/settings/notifications' });
  assert.equal(phone.shown[1].options.body, 'As notificações estão funcionando neste aparelho.');

  // The app's own choice wins over the browser's language, both ways.
  await english.dispatch('message', { data: { type: 'tendly:meta', lang: 'pt-BR' } });
  await english.pushed({ title: 'T', body: 'Is waiting for you', kind: 'waiting', url: '/session/x' });
  assert.equal(english.shown[1].options.body, 'Está esperando você');
  await phone.dispatch('message', { data: { type: 'tendly:meta', lang: 'en' } });
  await phone.pushed({ title: 'T', body: 'Is waiting for you', kind: 'waiting', url: '/session/x' });
  assert.equal(phone.shown[2].options.body, 'Is waiting for you');
});

test('the worker always shows something and never opens an outside address', async () => {
  const sw = worker();
  await sw.pushed({});
  assert.equal(sw.shown[0].title, 'Tendly');
  assert.equal(sw.shown[0].options.data.url, '/notificacoes');
  assert.equal(sw.shown[0].options.tag, undefined);
  assert.equal(sw.shown[0].options.renotify, false);
  await sw.dispatch('push', { data: { json() { throw new SyntaxError('not json'); }, text: () => 'plain text' } });
  assert.equal(sw.shown[1].options.body, 'plain text');
  await sw.dispatch('push', { data: null });
  assert.equal(sw.shown.length, 3);
  for (const url of ['https://evil.example/', '//evil.example/x', '/\\evil.example', 7, undefined]) {
    await sw.pushed({ title: 'x', url });
    assert.equal(sw.shown.at(-1).options.data.url, '/notificacoes', String(url));
  }
});

test('tapping a notification focuses an open Tendly and takes it there, else opens one', async () => {
  const tapped = (sw, url) => {
    let closed = false;
    return sw.dispatch('notificationclick', { notification: { data: { url }, close() { closed = true; } } }).then(() => closed);
  };
  const windowAt = (url, extra = {}) => {
    const client = { url, focused: false, visibilityState: 'hidden', messages: [], focusedNow: 0, ...extra };
    client.postMessage = message => client.messages.push(message);
    client.focus = async () => { client.focusedNow += 1; };
    return client;
  };
  // No window: a new one opens at the conversation.
  const empty = worker();
  assert.equal(await tapped(empty, '/session/abc'), true, 'the notification is dismissed');
  assert.deepEqual(empty.opened, ['/session/abc']);

  // A window is open: it is focused and told where to go, without reloading it.
  const background = windowAt(`${ORIGIN}/mesa`);
  const visible = windowAt(`${ORIGIN}/`, { visibilityState: 'visible' });
  const stranger = windowAt('https://other.example/', { focused: true });
  const sw = worker({ windows: [stranger, background, visible] });
  await tapped(sw, '/session/abc');
  assert.deepEqual(sw.opened, []);
  assert.deepEqual(visible.messages.map(message => ({ ...message })), [{ type: 'tendly:navigate', url: '/session/abc' }]);
  assert.equal(visible.focusedNow, 1);
  assert.equal(background.messages.length + stranger.messages.length, 0);

  // A notification with a bad address still lands in the bell.
  await tapped(sw, 'https://evil.example/');
  assert.equal(visible.messages[1].url, '/notificacoes');
  // A window that cannot be focused is still told where to go.
  const stubborn = windowAt(`${ORIGIN}/mesa`);
  stubborn.focus = async () => { throw new Error('not allowed'); };
  await tapped(worker({ windows: [stubborn] }), '/session/z');
  assert.equal(stubborn.messages[0].url, '/session/z');
});

test('the worker keeps the shell, never the API, and says so when offline', async () => {
  const sw = worker();
  await sw.dispatch('install');
  assert.deepEqual([...sw.stores.get('tendly-shell-build1').keys()].sort(), [`${ORIGIN}/favicon.svg`, `${ORIGIN}/icons/badge-96.png`, `${ORIGIN}/icons/icon-192.png`]);

  // The API, published pages, other origins and writes are not touched at all.
  for (const path of ['/api/hub/inbox', '/api/sessions/1', '/p/report-1234/']) {
    assert.equal((await sw.get(path)).response, undefined, path);
    assert.equal((await sw.get(path, 'navigate')).response, undefined, path);
  }
  assert.equal((await sw.dispatch('fetch', { request: { method: 'POST', url: `${ORIGIN}/assets/app.js`, mode: 'cors' } })).response, undefined);
  assert.equal((await sw.dispatch('fetch', { request: { method: 'GET', url: 'https://fonts.example/a.woff2', mode: 'cors' } })).response, undefined);
  assert.equal((await sw.get('/some/other/file.json')).response, undefined, 'only the shell is cached');

  // A hashed asset is fetched once, then served from the cache.
  const before = sw.fetched.length;
  const first = await (await sw.get('/assets/app-abc123.js')).response;
  const second = await (await sw.get('/assets/app-abc123.js')).response;
  assert.equal(first.ok && second.ok, true);
  assert.equal(sw.fetched.length, before + 1);
  // A path that answers with the app's page is not kept as if it were the asset.
  await (await sw.get('/assets/missing')).response;
  assert.equal(sw.stores.get('tendly-shell-build1').has(`${ORIGIN}/assets/missing`), false);

  // Pages always come from the server while there is one.
  const page = await (await sw.get('/mesa', 'navigate')).response;
  assert.equal(page.ok, true);
  assert.equal(sw.stores.get('tendly-shell-build1').has(`${ORIGIN}/mesa`), false);
  for (const name of sw.stores.keys()) for (const url of sw.stores.get(name).keys()) assert.ok(!url.includes('/api/'), url);
});

test('offline, a page says there is no connection instead of pretending', async () => {
  const english = worker({ online: false, language: 'en-GB' });
  const page = await (await english.get('/session/abc', 'navigate')).response;
  assert.equal(page.status, 503);
  assert.match(page.headers.get('content-type'), /text\/html/);
  const html = await page.text();
  assert.match(html, /<h1>No connection<\/h1>/);
  assert.match(html, /Try again/);
  assert.match(html, /prefers-color-scheme:dark/);

  const portuguese = worker({ online: false, language: 'pt-BR' });
  assert.match(await (await (await portuguese.get('/', 'navigate')).response).text(), /<h1>Sem conexão<\/h1>/);
  // An asset that is not cached simply fails, as it would without a worker.
  await assert.rejects(async () => (await portuguese.get('/assets/app-abc123.js')).response);
});

test('a new build drops the cache of the old one', async () => {
  const sw = worker();
  sw.stores.set('tendly-shell-old', new Map());
  sw.stores.set('tendly-meta', new Map());
  sw.stores.set('someone-elses', new Map());
  await sw.dispatch('install');
  await sw.dispatch('activate');
  assert.deepEqual([...sw.stores.keys()].sort(), ['someone-elses', 'tendly-meta', 'tendly-shell-build1']);
});

test('a replaced subscription is reported to the server with the device name', async () => {
  const sw = worker();
  await sw.dispatch('message', { data: { type: 'tendly:meta', label: 'Android · Chrome' } });
  await sw.dispatch('message', { data: { type: 'unrelated', label: 'ignored' } });
  await sw.dispatch('pushsubscriptionchange', { oldSubscription: { options: { userVisibleOnly: true, applicationServerKey: 'K' } } });
  assert.deepEqual({ ...sw.subscription() }, { userVisibleOnly: true, applicationServerKey: 'K' });
  const call = sw.fetched.at(-1);
  assert.equal(call.url, `${ORIGIN}/api/hub/push/subscriptions`);
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers['X-Tendly-Client'], 'web');
  assert.deepEqual(JSON.parse(call.init.body), { endpoint: 'https://push.example/new', keys: { p256dh: 'P', auth: 'A' }, label: 'Android · Chrome' });
});

// ---------------------------------------------------------------- wiring

test('the page links what makes it installable, and the icons exist', () => {
  const html = read('apps/web/index.html');
  assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest"/);
  assert.match(html, /<link rel="apple-touch-icon" href="\/icons\/apple-touch-icon\.png"/);
  assert.match(html, /<meta name="theme-color" content="#[0-9a-f]{6}"/);
  for (const name of ['icon-192.png', 'icon-512.png', 'icon-maskable-192.png', 'icon-maskable-512.png', 'apple-touch-icon.png', 'badge-96.png']) {
    const file = new URL(`apps/web/public/icons/${name}`, repo);
    assert.ok(existsSync(file), name);
    assert.equal(readFileSync(file).subarray(1, 4).toString(), 'PNG', name);
  }
  // The worker itself is the server's (so it works from the binary and from ~/.tendly/web alike), not a file of the build.
  assert.equal(existsSync(new URL('apps/web/public/sw.js', repo)), false);
  assert.match(read('apps/web/src/main.ts'), /installPhoneSupport\(router\)/);
});

test('notifications are a section of Settings with an address', () => {
  // router.ts reads Vite's environment, so it is read here as text.
  assert.match(read('apps/web/src/router.ts'), /SETTINGS_SECTIONS = \[[^\]]*"notifications"[^\]]*\] as const/);
  const settings = readFileSync(new URL('../SettingsPage.vue', here), 'utf8');
  assert.match(settings, /id: 'notifications', icon: 'bell', label: 'Notifications'/);
  assert.match(settings, /<NotificationsPanel v-if="hubSection==='notifications'"/);
  // The push for a test lands back on this section.
  assert.match(read('crates/server/src/hub/push.rs'), /"\/settings\/notifications"/);
});

test('the panel has every state the spec asks for', () => {
  const panel = readFileSync(new URL('NotificationsPanel.vue', here), 'utf8');
  for (const state of ["support === 'insecure'", "support === 'needs-install'", "support === 'unsupported'", "support === 'denied'", 'switchError']) {
    assert.ok(panel.includes(state), state);
  }
  assert.match(panel, /role="switch"/);
  assert.match(panel, /tailscale serve/);
  const list = readFileSync(new URL('PushDeviceList.vue', here), 'utf8');
  for (const source of [panel, list, readFileSync(new URL('InstallHint.vue', here), 'utf8')]) {
    assert.match(source, /@media \(pointer: coarse\) \{[^@]*min-height: 44px/, 'touch targets');
    assert.doesNotMatch(source, /outline:\s*(none|0)/, 'the focus ring stays');
    assert.doesNotMatch(source, /window\.confirm|\bconfirm\(/, 'confirmation is inline');
  }
  assert.match(list, /Confirm removal/);
});

test('every phone string has a pt-BR translation', () => {
  const translations = JSON.parse(readFileSync(new URL('../../i18n/pt-BR.json', here), 'utf8'));
  const keys = new Set([
    ...Object.values(PUSH_ERROR_TEXT),
    // Chosen by a condition inside t(…), so the pattern below does not see them.
    'Sending…', 'Send a test', 'Removing…', 'Confirm removal', 'Remove', 'Notifications', 'Published files',
  ]);
  for (const file of ['NotificationsPanel.vue', 'PushDeviceList.vue', 'InstallHint.vue']) {
    const source = readFileSync(new URL(file, here), 'utf8');
    for (const match of source.matchAll(/\bt\(\s*(["'])((?:\\.|(?!\1).)*)\1/g)) keys.add(match[2]);
  }
  assert.ok(keys.size > 45, `found ${keys.size} strings`);
  const placeholders = text => (text.match(/\{\w+\}/g) ?? []).sort();
  for (const key of keys) {
    assert.ok(!key.includes('\\'), `write ${JSON.stringify(key)} without an escape`);
    assert.ok(key in translations, `missing pt-BR for ${JSON.stringify(key)}`);
    assert.deepEqual(placeholders(translations[key]), placeholders(key), key);
  }
  assert.equal(translations['Receive notifications on this device'], 'Receber notificações neste aparelho');
  // The worker's own texts follow the inbox's wording.
  const sw = read('crates/server/src/hub/pwa/sw.js');
  for (const kind of ['Finished replying', 'Stopped with an error', 'Is waiting for you', 'Routine finished', 'Routine failed']) {
    assert.ok(sw.includes(`"${translations[kind]}"`), `${kind} → ${translations[kind]}`);
  }
});
