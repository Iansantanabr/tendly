// What Settings → Notifications and the install hint actually draw in each
// situation, rendered on the server from the real components.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import vue from '@vitejs/plugin-vue';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

let server, Panel, List, Hint, i18n, capabilities, pwa;
before(async () => {
  server = await createServer({ configFile: false, root: fileURLToPath(new URL('../../../', import.meta.url)), plugins: [vue()], server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', optimizeDeps: { noDiscovery: true } });
  Panel = (await server.ssrLoadModule('/src/features/hub/NotificationsPanel.vue')).default;
  List = (await server.ssrLoadModule('/src/features/hub/PushDeviceList.vue')).default;
  Hint = (await server.ssrLoadModule('/src/features/hub/InstallHint.vue')).default;
  i18n = await server.ssrLoadModule('/src/i18n/index.ts');
  capabilities = (await server.ssrLoadModule('/src/features/backend-capabilities.ts')).backendCapabilities;
  pwa = await server.ssrLoadModule('/src/features/hub/pwa.ts');
});
after(async () => { await server?.close(); delete globalThis.window; delete globalThis.Notification; });

/** The browser the components find around them. */
function browser({ secure = true, push = true, permission = 'default', userAgent = MAC, coarse = false, standalone = false, touch = 0 } = {}) {
  const window = {
    isSecureContext: secure,
    matchMedia: query => ({ matches: query.includes('standalone') ? standalone : query.includes('coarse') ? coarse : false }),
  };
  if (push) { window.PushManager = class {}; window.Notification = { permission }; globalThis.Notification = window.Notification; }
  else delete globalThis.Notification;
  globalThis.window = window;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { userAgent, platform: /Mac/.test(userAgent) ? 'MacIntel' : '', maxTouchPoints: touch, ...(push ? { serviceWorker: {} } : {}) },
  });
}
const render = (component, props) => renderToString(createSSRApp(component, props));
const switchTag = html => /<input[^>]*role="switch"[^>]*>/.exec(html)?.[0] ?? '';

test('on plain http the panel explains HTTPS and points at Tailscale', async () => {
  i18n.useI18n().setLocale('en');
  browser({ secure: false, push: false, userAgent: ANDROID, coarse: true, touch: 5 });
  capabilities.tailnet = true;
  const html = await render(Panel);
  assert.match(html, /Receive notifications on this device/);
  assert.match(switchTag(html), /disabled/, 'the switch cannot be turned on here');
  assert.match(html, /This page is not on HTTPS/);
  assert.match(html, /tailscale serve/);
  assert.match(html, /On a VPS it will be HTTPS from the start/);
  assert.match(html, /Open Remote access/);
  assert.doesNotMatch(html, /Add Tendly to the Home Screen first|blocked for this site|cannot receive notifications/);

  // A server without Tailscale support offers no button that leads nowhere.
  capabilities.tailnet = false;
  assert.doesNotMatch(await render(Panel), /Open Remote access/);
});

test('an iPhone in a Safari tab is told to add the app to the Home Screen first', async () => {
  i18n.useI18n().setLocale('en');
  browser({ secure: true, push: false, userAgent: IPHONE, coarse: true, touch: 5 });
  const html = await render(Panel);
  assert.match(html, /Add GCore to the Home Screen first/);
  assert.match(html, /“Add to Home Screen”/);
  assert.match(switchTag(html), /disabled/);
  // And the install hint sits above it with the same steps.
  assert.match(html, /class="install-hint"/);
  assert.doesNotMatch(html, /This page is not on HTTPS/);
});

test('a browser without push, and a blocked permission, each say what to do', async () => {
  i18n.useI18n().setLocale('en');
  browser({ secure: true, push: false, userAgent: MAC });
  const unsupported = await render(Panel);
  assert.match(unsupported, /This browser cannot receive notifications/);
  assert.match(switchTag(unsupported), /disabled/);

  browser({ permission: 'denied' });
  const denied = await render(Panel);
  assert.match(denied, /Notifications are blocked for this site/);
  assert.match(denied, /site settings of the browser/);
  assert.match(switchTag(denied), /disabled/);
});

test('where it can work the panel shows the switch, the devices and the test button', async () => {
  i18n.useI18n().setLocale('en');
  browser({ permission: 'default' });
  const html = await render(Panel);
  assert.match(html, /<h2[^>]*>This device<\/h2>/);
  assert.match(html, /<h2[^>]*>Devices<\/h2>/);
  assert.match(html, /Send a test/);
  assert.match(html, /Off\. Turning it on asks the browser for permission\./);
  assert.doesNotMatch(html, /inline-notice/, 'nothing to explain');
  // Until the list arrived the switch waits, and the test has nobody to go to.
  assert.match(html, /Loading…/);
  assert.match(switchTag(html), /disabled/);
  assert.match(/<button[^>]*>Send a test<\/button>/.exec(html)[0], /disabled/);

  i18n.useI18n().setLocale('pt-BR');
  const portuguese = await render(Panel);
  assert.match(portuguese, /Receber notificações neste aparelho/);
  assert.match(portuguese, /Enviar teste/);
  assert.match(portuguese, /Este aparelho/);
  i18n.useI18n().setLocale('en');
});

test('the device list names each device, marks this one and flags failures', async () => {
  i18n.useI18n().setLocale('en');
  const devices = [
    { id: 'a', label: 'iPhone', service: 'web.push.apple.com', endpoint_sha256: 'h1', created_at: '2026-11-05T12:00:00Z', last_ok_at: '2026-11-05T13:00:00Z', failures: 0 },
    { id: 'b', label: '', service: 'fcm.googleapis.com', endpoint_sha256: 'h2', created_at: '2026-11-04T12:00:00Z', last_ok_at: null, failures: 3 },
  ];
  const html = await render(List, { devices, ownId: 'a' });
  const [first, second] = html.split('</li>');
  assert.match(first, /<strong[^>]*>iPhone<\/strong>/);
  assert.match(first, /This device/);
  assert.match(first, /Through Apple/);
  assert.match(first, /Last delivered/);
  assert.doesNotMatch(first, /failed attempt/);
  assert.match(second, /Unnamed device/);
  assert.doesNotMatch(second, /This device/);
  assert.match(second, /Through Google/);
  assert.match(second, /Nothing delivered yet/);
  assert.match(second, /3 failed attempt\(s\) in a row/);
  // One Remove per device, named for a screen reader; nothing is armed at first.
  assert.equal(html.match(/>Remove<\/button>/g).length, 2);
  assert.match(html, /aria-label="Remove iPhone"/);
  assert.doesNotMatch(html, /Confirm removal|role="alert"/);
  // While one is being removed every Remove waits.
  const busy = await render(List, { devices, ownId: 'a', busyId: 'b' });
  assert.match(busy, /Removing…/);
  assert.equal(busy.match(/<button[^>]*disabled[^>]*>/g).length, 2);

  i18n.useI18n().setLocale('pt-BR');
  const portuguese = await render(List, { devices, ownId: 'a' });
  assert.match(portuguese, /Este aparelho/);
  assert.match(portuguese, /Aparelho sem nome/);
  assert.match(portuguese, /Remover/);
  i18n.useI18n().setLocale('en');
});

test('the install hint is for phones in a browser tab, each in its own way', async () => {
  i18n.useI18n().setLocale('en');
  pwa.install.prompt = undefined; pwa.install.done = false;
  browser({ userAgent: MAC, coarse: false });
  assert.doesNotMatch(await render(Hint), /install-hint/, 'not on a desktop');

  browser({ userAgent: IPHONE, coarse: true, touch: 5, push: false });
  const iphone = await render(Hint, { dismissible: true });
  assert.match(iphone, /Install app/);
  assert.match(iphone, /tap Share and then “Add to Home Screen”/);
  assert.match(iphone, /Not now/);
  assert.doesNotMatch(iphone, />Install<\/button>/, 'Safari has no dialog to open');

  browser({ userAgent: ANDROID, coarse: true, touch: 5 });
  const menu = await render(Hint);
  assert.match(menu, /Open the browser menu/);
  assert.doesNotMatch(menu, /Not now/, 'in Settings it is not dismissible');
  pwa.install.prompt = { prompt: async () => {}, userChoice: Promise.resolve({ outcome: 'dismissed' }) };
  const prompt = await render(Hint);
  assert.match(prompt, />Install<\/button>/);
  pwa.install.prompt = undefined;

  browser({ userAgent: ANDROID, coarse: true, touch: 5, standalone: true });
  assert.doesNotMatch(await render(Hint), /install-hint/, 'already installed');
  browser({ userAgent: ANDROID, coarse: true, touch: 5, secure: false, push: false });
  assert.doesNotMatch(await render(Hint), /install-hint/, 'Android needs https before it can install');
});
