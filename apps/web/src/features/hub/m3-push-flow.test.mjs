// Turning notifications on and off, against stand-ins for the browser's push
// API and for the server. In a file of its own: the worker registration is
// remembered for the life of the module.
import test from 'node:test';
import assert from 'node:assert/strict';

const KEY_A = 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8';
const KEY_B = 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4';
const ANDROID = 'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';

// ---- the server
const server = { key: KEY_A, calls: [] };
globalThis.fetch = async (url, init = {}) => {
  const method = init.method ?? 'GET';
  server.calls.push({ url, method, body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers });
  const answer = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if (url === '/api/hub/push/key') return answer(200, { key: server.key });
  if (url === '/api/hub/push/subscriptions' && method === 'POST') return answer(200, { id: 'device-1' });
  if (url.startsWith('/api/hub/push/subscriptions/') && method === 'DELETE') return answer(204);
  return answer(404, { error: 'not found' });
};

// ---- the browser
const browser = { subscription: null, subscribeCalls: [], unsubscribed: [], posted: [], failSubscribe: null, answer: 'granted', count: 0 };
const pushManager = {
  async getSubscription() { return browser.subscription; },
  async subscribe(options) {
    browser.subscribeCalls.push(options);
    if (browser.failSubscribe) throw new Error(browser.failSubscribe);
    const endpoint = `https://fcm.googleapis.com/fcm/send/device-${++browser.count}`;
    const subscription = {
      endpoint,
      // Browsers hand the key back as an ArrayBuffer.
      options: { userVisibleOnly: options.userVisibleOnly, applicationServerKey: options.applicationServerKey.buffer },
      toJSON: () => ({ endpoint, expirationTime: null, keys: { p256dh: 'device-public-key', auth: 'device-auth' } }),
      async unsubscribe() { browser.unsubscribed.push(endpoint); if (browser.subscription === subscription) browser.subscription = null; return true; },
    };
    browser.subscription = subscription;
    return subscription;
  },
};
const registration = { pushManager, active: { postMessage: message => browser.posted.push(message) } };
globalThis.Notification = {
  permission: 'default',
  async requestPermission() { if (browser.answer !== 'default') globalThis.Notification.permission = browser.answer; return browser.answer; },
};
globalThis.window = { isSecureContext: true, PushManager: class {}, Notification: globalThis.Notification, matchMedia: () => ({ matches: false }) };
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: {
    userAgent: ANDROID, platform: 'Linux armv81', maxTouchPoints: 5,
    serviceWorker: { register: async () => registration, ready: Promise.resolve(registration), addEventListener() {} },
  },
});

const { PushError, disablePush, enablePush, keyBytes, ownEndpointHash, pushSupport, readPushEnv, sha256Hex } = await import('./push.ts');
const posts = () => server.calls.filter(call => call.method === 'POST');
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

test('this stand-in browser can receive pushes', () => {
  assert.equal(pushSupport(readPushEnv()), 'ready');
});

test('nothing is sent anywhere until the person allows notifications', async () => {
  browser.answer = 'default';
  await assert.rejects(enablePush(), error => error instanceof PushError && error.reason === 'dismissed');
  browser.answer = 'denied';
  await assert.rejects(enablePush(), error => error instanceof PushError && error.reason === 'denied');
  assert.equal(pushSupport(readPushEnv()), 'denied');
  assert.equal(server.calls.length, 0);
  assert.equal(browser.subscribeCalls.length, 0);
  globalThis.Notification.permission = 'default';
});

test('turning it on subscribes with the server key and registers this device', async () => {
  browser.answer = 'granted';
  assert.equal(await ownEndpointHash(), null);
  assert.equal(await enablePush(), 'device-1');
  assert.equal(browser.subscribeCalls.length, 1);
  assert.equal(browser.subscribeCalls[0].userVisibleOnly, true);
  assert.deepEqual([...browser.subscribeCalls[0].applicationServerKey], [...keyBytes(KEY_A)]);
  const [post] = posts();
  assert.equal(post.url, '/api/hub/push/subscriptions');
  assert.equal(post.headers['X-Tendly-Client'], 'web');
  assert.deepEqual(post.body, {
    endpoint: 'https://fcm.googleapis.com/fcm/send/device-1',
    keys: { p256dh: 'device-public-key', auth: 'device-auth' },
    label: 'Android · Chrome',
  });
  await settle();
  assert.deepEqual(browser.posted.at(-1), { type: 'tendly:meta', label: 'Android · Chrome' }, 'the worker learns the name for a later renewal');
  assert.equal(await ownEndpointHash(), await sha256Hex('https://fcm.googleapis.com/fcm/send/device-1'));
});

test('turning it on again reuses the subscription and tells the server again', async () => {
  assert.equal(await enablePush(), 'device-1');
  assert.equal(browser.subscribeCalls.length, 1, 'no second subscription');
  assert.equal(posts().length, 2, 'the server may have forgotten it: it is told again');
  assert.equal(posts()[1].body.endpoint, 'https://fcm.googleapis.com/fcm/send/device-1');
});

test('a subscription made with an old server key is replaced', async () => {
  server.key = KEY_B;
  await enablePush();
  assert.deepEqual(browser.unsubscribed, ['https://fcm.googleapis.com/fcm/send/device-1']);
  assert.equal(browser.subscribeCalls.length, 2);
  assert.deepEqual([...browser.subscribeCalls[1].applicationServerKey], [...keyBytes(KEY_B)]);
  assert.equal(posts().at(-1).body.endpoint, 'https://fcm.googleapis.com/fcm/send/device-2');
});

test('turning it off removes this device from the server and from the browser', async () => {
  const hash = await sha256Hex('https://fcm.googleapis.com/fcm/send/device-2');
  const devices = [
    { id: 'someone-else', endpoint_sha256: await sha256Hex('https://web.push.apple.com/other') },
    { id: 'device-1', endpoint_sha256: hash },
  ];
  await disablePush(devices);
  const deleted = server.calls.filter(call => call.method === 'DELETE').map(call => call.url);
  assert.deepEqual(deleted, ['/api/hub/push/subscriptions/device-1'], 'only this device');
  assert.equal(browser.subscription, null);
  assert.equal(await ownEndpointHash(), null);
  // Off already: nothing more to do.
  const before = server.calls.length;
  await disablePush(devices);
  assert.equal(server.calls.length, before);
});

test('a browser that cannot subscribe says why, and nothing is registered', async () => {
  browser.failSubscribe = 'Registration failed - push service error';
  const before = posts().length;
  await assert.rejects(enablePush(), error => error instanceof PushError && error.reason === 'subscribe' && error.detail === 'Registration failed - push service error');
  assert.equal(posts().length, before);
  browser.failSubscribe = null;
});
