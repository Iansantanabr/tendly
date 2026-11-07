/*
 * Tendly's service worker (served at /sw.js by hub/pwa.rs, which fills in the
 * build id below so each build gets a cache of its own).
 *
 * It does three things and nothing else:
 *  - keeps the app shell (hashed assets, icons) so the app opens fast;
 *    API answers are never cached, and without the server there is no app:
 *    a page asked for while offline says so instead of pretending;
 *  - shows the notifications the server pushes;
 *  - opens the right place when one is tapped.
 */
const BUILD = "__BUILD__";
const SHELL = `tendly-shell-${BUILD}`;
const META = "tendly-meta";
const META_KEY = "/__tendly-meta";
const ICON = "/icons/icon-192.png";
const BADGE = "/icons/badge-96.png";
const FALLBACK_URL = "/notificacoes";

/** The inbox texts by kind; the server's English text is used for any other language. */
const TEXTS = {
  "pt-BR": {
    turn_completed: "Terminou de responder",
    turn_failed: "Parou com erro",
    waiting: "Está esperando você",
    automation_done: "Rotina terminou",
    automation_failed: "Rotina falhou",
    app: "Aviso de um app",
    test: "As notificações estão funcionando neste aparelho.",
    offlineTitle: "Sem conexão",
    offlineBody: "Não deu para falar com o GCore. Confira a internet (ou o Tailscale) e se o servidor está ligado.",
    retry: "Tentar de novo",
  },
  en: {
    offlineTitle: "No connection",
    offlineBody: "GCore could not be reached. Check your connection (or Tailscale) and that the server is running.",
    retry: "Try again",
  },
};

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // Best effort: a missing icon must not keep the worker from installing.
    await Promise.all([ICON, BADGE, "/favicon.svg"].map(path => cache.add(path).catch(() => undefined)));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith("tendly-shell-") && name !== SHELL).map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

/** Files that make up the shell: named by their content hash, or fixed icons. */
function isShell(pathname) {
  return pathname.startsWith("/assets/") || pathname.startsWith("/icons/") || pathname === "/favicon.svg";
}

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // The API, published pages and the files of custom apps always go to the server untouched.
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/p/") || url.pathname.startsWith("/apps-run/")) return;
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => offlinePage()));
    return;
  }
  if (isShell(url.pathname)) event.respondWith(cacheFirst(request));
});

async function cacheFirst(request) {
  const cache = await caches.open(SHELL);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  // An unknown path answers with the app's page: that is not the asset.
  const type = response.headers.get("content-type") || "";
  if (response.ok && response.type === "basic" && !type.startsWith("text/html")) {
    cache.put(request, response.clone()).catch(() => undefined);
  }
  return response;
}

async function readMeta() {
  try {
    const hit = await (await caches.open(META)).match(META_KEY);
    return hit ? await hit.json() : {};
  } catch {
    return {};
  }
}

/** The language the app was last shown in; the browser's own before that is known. */
async function language() {
  const meta = await readMeta();
  const wanted = String(meta.lang || self.navigator.language || "en");
  return wanted.toLowerCase().startsWith("pt") ? "pt-BR" : wanted;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`);
}

async function offlinePage() {
  const lang = await language();
  const text = { ...TEXTS.en, ...(TEXTS[lang] || {}) };
  const html = `<!doctype html>
<html lang="${escapeHtml(lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GCore · ${escapeHtml(text.offlineTitle)}</title>
<style>
:root{color-scheme:light dark;--bg:#f1eee8;--ink:#221f1b;--muted:#6e6961;--accent:#0f7f70;--on-accent:#ffffff;--focus:#2fa08f}
@media(prefers-color-scheme:dark){:root{--bg:#0f1113;--ink:#ecebe8;--muted:#8e8d89;--accent:#3fc4b0;--on-accent:#06211d;--focus:#3fc4b0}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;min-height:100dvh;display:grid;place-items:center;padding:24px;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:420px;text-align:center}
h1{font-size:1.375rem;margin:0 0 8px}
p{margin:0 0 24px;color:var(--muted)}
button{min-height:44px;padding:0 20px;border:0;border-radius:10px;background:var(--accent);color:var(--on-accent);font:inherit;font-weight:600;cursor:pointer}
button:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
</style>
</head>
<body>
<main>
<h1>${escapeHtml(text.offlineTitle)}</h1>
<p>${escapeHtml(text.offlineBody)}</p>
<button type="button" onclick="location.reload()">${escapeHtml(text.retry)}</button>
</main>
</body>
</html>`;
  return new Response(html, { status: 503, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

/** Only a place inside this app is ever opened from a notification. */
function safePath(value) {
  const path = typeof value === "string" ? value : "";
  return path.startsWith("/") && !path.startsWith("//") && !path.startsWith("/\\") ? path : FALLBACK_URL;
}

self.addEventListener("push", event => {
  event.waitUntil((async () => {
    let data = {};
    try { data = event.data ? event.data.json() : {}; }
    catch { data = { body: event.data ? event.data.text() : "" }; }
    if (!data || typeof data !== "object") data = {};
    const lang = await language();
    const translated = TEXTS[lang] && typeof data.kind === "string" ? TEXTS[lang][data.kind] : undefined;
    const detail = typeof data.detail === "string" ? data.detail : "";
    const body = translated ? (detail ? `${translated}\n${detail}` : translated) : String(data.body || "");
    const tag = typeof data.tag === "string" && data.tag ? data.tag : undefined;
    await self.registration.showNotification(String(data.title || "GCore"), {
      body,
      icon: ICON,
      badge: BADGE,
      lang,
      tag,
      renotify: Boolean(tag),
      data: { url: safePath(data.url) },
    });
  })());
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const path = safePath(event.notification.data && event.notification.data.url);
  event.waitUntil((async () => {
    const windows = (await self.clients.matchAll({ type: "window", includeUncontrolled: true }))
      .filter(client => new URL(client.url).origin === self.location.origin);
    const open = windows.find(client => client.focused) || windows.find(client => client.visibilityState === "visible") || windows[0];
    if (open) {
      // The app routes itself; loading the address would restart it and its running panes.
      open.postMessage({ type: "tendly:navigate", url: path });
      try { await open.focus(); } catch { /* The message alone still takes it there. */ }
      return;
    }
    await self.clients.openWindow(path);
  })());
});

/** The page says which language it is in and what this device is called. */
self.addEventListener("message", event => {
  const data = event.data;
  if (!data || data.type !== "tendly:meta") return;
  event.waitUntil((async () => {
    const meta = { ...(await readMeta()) };
    if (typeof data.lang === "string") meta.lang = data.lang.slice(0, 20);
    if (typeof data.label === "string") meta.label = data.label.slice(0, 80);
    const cache = await caches.open(META);
    await cache.put(META_KEY, new Response(JSON.stringify(meta), { headers: { "Content-Type": "application/json" } }));
  })());
});

/** The browser replaced this device's subscription: tell the server its new address. */
self.addEventListener("pushsubscriptionchange", event => {
  event.waitUntil((async () => {
    const options = event.oldSubscription && event.oldSubscription.options;
    const fresh = event.newSubscription || (options ? await self.registration.pushManager.subscribe(options) : undefined);
    if (!fresh) return;
    const subscription = fresh.toJSON();
    const meta = await readMeta();
    await fetch("/api/hub/push/subscriptions", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-Tendly-Client": "web" },
      body: JSON.stringify({ endpoint: subscription.endpoint, keys: subscription.keys, label: meta.label || "" }),
    });
  })());
});
