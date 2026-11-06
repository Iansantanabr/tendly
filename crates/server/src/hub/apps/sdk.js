/**
 * Tendly apps SDK, served at /api/hub/apps/sdk.js. Include it in an app page,
 * before the app's own scripts:
 *
 *   <script src="/api/hub/apps/sdk.js"></script>
 *
 * HOW AN APP RUNS. Tendly shows the app in a sandboxed frame with an origin of
 * its own: the app cannot call Tendly's API, read its cookies or touch its
 * page, and it has no localStorage of its own (the SDK puts a memory-only
 * stand-in there so old code does not crash; nothing in it survives a reload).
 * Everything below is a message to the Tendly page that frames the app, which
 * does the work with its own credentials and answers. Every call that returns
 * a Promise rejects with an Error carrying the message, `status` (the HTTP
 * status, when there is one) and `code` ("permission", "outside", "timeout").
 * In a browser tab of its own (`tendly.host.framed === false`) there is no
 * Tendly page to ask, and those calls reject with code "outside".
 *
 * THE APP ITSELF
 *   tendly.app                     { workspaceId, slug }
 *
 * ITS DATA (no permission needed; JSON kept in apps/<slug>/data/<key>.json)
 *   tendly.data.get(key, fallback) the stored value, or fallback (null) if none
 *   tendly.data.set(key, value)    stores any JSON value (up to 1 MB) -> { key, size, updated_at }
 *   tendly.data.list()             [{ key, size, updated_at }]
 *   tendly.data.remove(key)        deletes the value
 *   Keys are letters, digits, "_" and "-", up to 64 characters.
 *
 * THE TENDLY AROUND IT (no permission needed, except where said)
 *   tendly.host.framed             true inside Tendly, false in a tab of its own
 *   tendly.host.setContext({ view, selection, summary })
 *                                  what is on screen: the chat chip reads "App · view" and an agent
 *                                  the person talks to gets the three texts. setContext(null) clears it.
 *   tendly.host.openConversation(id)   opens that conversation on the Mesa
 *   tendly.host.openFile(path)         opens a file of the app's workspace on the Mesa
 *   tendly.host.openApp(slug)          opens another app on the Mesa
 *   tendly.host.openUrl(url)           opens an http(s) address in a new browser tab
 *                                  (links to other sites and window.open already go this way)
 *   tendly.host.toast(text)            a short message in Tendly's corner
 *   tendly.host.draftChat(text, { attach: [paths] })
 *                                  writes text in a chat composer beside the app. It is NEVER sent:
 *                                  the person reads it and presses send. Needs "agent:draft".
 *   tendly.host.notify(title, body)    the bell and a push to the person's devices. Needs "notify".
 *   tendly.host.theme                  "light" or "dark", as Tendly is showing
 *   tendly.host.onTheme(fn)            fn(theme) now and on every change; returns a function that stops it.
 *                                  The SDK also keeps <html data-tendly-theme="light|dark">.
 *   tendly.host.pane                   { width, height, mode }: the app's own size, and "pane" (a tab of
 *                                  the Mesa), "page" (full screen) or "tab" (outside Tendly)
 *   tendly.host.onResize(fn)           fn(pane) now and when the size or the mode changes; returns a stop function
 *   tendly.host.holdReload(true)       asks Tendly not to reload the app while there is unsaved input;
 *                                  holdReload(false) lets it reload again
 *
 * TENDLY'S DATA (read-only; each needs its permission)
 *   Ask in app.json: "permissions": ["sessions:read", "files:read", "automations:read", "notify", "agent:draft"].
 *   The person is asked once, when the app opens. Without the permission the call rejects (code "permission").
 *   tendly.permissions.get()           { requested, granted, refused, pending, status }
 *   tendly.sessions.list({ limit, archived })     "sessions:read"
 *       [{ id, title, state, workspace_id, workspace_name, provider, created_at, updated_at,
 *          age_seconds, archived, unread, last_turn_at, last_turn_status, summary }]  (never a transcript)
 *   tendly.workspace.files(path)                  "files:read": a folder of the app's workspace
 *       [{ name, path, kind: "file" | "directory" | "symlink", size }]
 *   tendly.workspace.read(path)                   "files:read": { path, content, size } (text, up to 1 MB)
 *   tendly.automations.list({ runs })             "automations:read"
 *       [{ id, name, description, kind, cron, timezone, enabled, next_run, running, runs: [...] }]
 *
 * Tendly reloads an open app by itself when its files change, and shows the
 * person the app's errors (uncaught errors, unhandled rejections,
 * console.error, files that failed to load) with "Ask for a fix".
 */
(function () {
  'use strict';
  // Served as /apps-run/<workspace>/<slug>/<token>/<path inside the app>.
  var match = /^\/apps-run\/([^/]+)\/([^/]+)\/[^/]+(?:\/|$)/.exec(location.pathname);
  var app = match ? { workspaceId: decodeURIComponent(match[1]), slug: decodeURIComponent(match[2]) } : null;

  // ---- The page that frames the app -------------------------------------
  // Messages go to the parent window only, addressed to the origin this file
  // was served from: only a Tendly page may frame an app (frame-ancestors), and
  // a page of any other origin would receive nothing. The app's own origin is
  // opaque ("null"), so it is the address, not location.origin, that names Tendly.
  var HOST_ORIGIN = location.protocol + '//' + location.host;
  var framed = !!match && !!window.parent && window.parent !== window;
  var MAX_REPORTS = 50, reports = 0, lastReport = '';
  var CALL_TIMEOUT = 30000, calls = {}, nextCall = 0;

  function post(message) {
    if (!framed) return;
    message.source = 'tendly-app';
    message.v = 2;
    try { window.parent.postMessage(message, HOST_ORIGIN); } catch (_) { /* the frame is going away */ }
  }
  function fail(message, code, status) {
    var error = new Error(message);
    error.code = code;
    if (status) error.status = status;
    return error;
  }
  /** Asks the Tendly page to do something and resolves with its answer. */
  function call(method, args) {
    if (!match) return Promise.reject(fail('tendly: this page is not being served as a Tendly app', 'outside'));
    if (!framed) {
      return Promise.reject(fail('tendly: this app is open outside Tendly, so it cannot reach Tendly or its own data. Open it from the Apps page.', 'outside'));
    }
    return new Promise(function (resolve, reject) {
      var id = ++nextCall;
      var timer = setTimeout(function () {
        delete calls[id];
        reject(fail('tendly: Tendly did not answer "' + method + '"', 'timeout'));
      }, CALL_TIMEOUT);
      calls[id] = { resolve: resolve, reject: reject, timer: timer };
      post({ type: 'call', id: id, method: method, args: args === undefined ? {} : args });
    });
  }
  function clip(value, limit) {
    var text = value === undefined || value === null ? '' : String(value);
    return text.length > limit ? text.slice(0, limit) + '…' : text;
  }
  function describe(value) {
    if (value instanceof Error) return value.name + ': ' + value.message;
    if (typeof value === 'string') return value;
    try { var text = JSON.stringify(value); if (text !== undefined) return text; } catch (_) { /* circular */ }
    return String(value);
  }
  function checkedKey(key) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(key))) {
      throw new Error('tendly: invalid key "' + key + '" (letters, digits, _ and -, up to 64)');
    }
    return String(key);
  }
  function report(kind, message, detail) {
    detail = detail || {};
    var key = kind + '\n' + message + '\n' + (detail.file || '') + ':' + (detail.line || 0);
    if (key === lastReport || reports >= MAX_REPORTS) return;
    lastReport = key; reports += 1;
    post({
      type: 'error', kind: kind, message: clip(message, 2000), file: clip(detail.file, 500),
      line: Number(detail.line) || 0, column: Number(detail.column) || 0, stack: clip(detail.stack, 4000),
      page: location.pathname + location.search + location.hash, at: Date.now()
    });
  }

  // ---- What Tendly tells the app: answers, its theme, how it is shown ----
  var themeQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  var theme = themeQuery && themeQuery.matches ? 'dark' : 'light';
  var mode = framed ? 'pane' : 'tab';
  var themeWatchers = [], sizeWatchers = [];
  function pane() { return { width: window.innerWidth || 0, height: window.innerHeight || 0, mode: mode }; }
  function tell(watchers, value) {
    watchers.slice().forEach(function (watcher) {
      try { watcher(value); } catch (error) { setTimeout(function () { throw error; }, 0); }
    });
  }
  function watch(watchers, watcher, value) {
    if (typeof watcher !== 'function') throw new Error('tendly: a function is needed');
    watchers.push(watcher);
    tell([watcher], value);
    return function () { var at = watchers.indexOf(watcher); if (at >= 0) watchers.splice(at, 1); };
  }
  function showTheme() {
    try { document.documentElement.setAttribute('data-tendly-theme', theme); } catch (_) { /* no document yet */ }
  }
  showTheme();
  if (framed) {
    window.addEventListener('message', function (event) {
      if (event.source !== window.parent || event.origin !== HOST_ORIGIN) return;
      var data = event.data;
      if (!data || typeof data !== 'object' || data.source !== 'tendly-host' || data.v !== 2) return;
      if (data.type === 'result') {
        var waiting = calls[data.id];
        if (!waiting) return;
        delete calls[data.id];
        clearTimeout(waiting.timer);
        if (data.ok) waiting.resolve(data.value);
        else {
          var problem = data.error || {};
          waiting.reject(fail(String(problem.message || 'Tendly refused this'), problem.code, problem.status));
        }
      } else if (data.type === 'host') {
        if ((data.theme === 'light' || data.theme === 'dark') && data.theme !== theme) {
          theme = data.theme; showTheme(); tell(themeWatchers, theme);
        }
        if ((data.mode === 'pane' || data.mode === 'page') && data.mode !== mode) {
          mode = data.mode; tell(sizeWatchers, pane());
        }
      }
    });
  } else if (themeQuery && themeQuery.addEventListener) {
    themeQuery.addEventListener('change', function (event) {
      theme = event.matches ? 'dark' : 'light'; showTheme(); tell(themeWatchers, theme);
    });
  }
  window.addEventListener('resize', function () { tell(sizeWatchers, pane()); });

  // ---- What the app loses by having an origin of its own -----------------
  // localStorage and sessionStorage throw there. A stand-in kept in memory lets
  // code written before run; what matters belongs in tendly.data.
  function memoryStorage() {
    var items = {};
    return {
      getItem: function (key) { key = String(key); return Object.prototype.hasOwnProperty.call(items, key) ? items[key] : null; },
      setItem: function (key, value) { items[String(key)] = String(value); },
      removeItem: function (key) { delete items[String(key)]; },
      clear: function () { items = {}; },
      key: function (index) { var keys = Object.keys(items); return index < keys.length ? keys[index] : null; },
      get length() { return Object.keys(items).length; }
    };
  }
  ['localStorage', 'sessionStorage'].forEach(function (name) {
    try { void window[name].length; } catch (_) {
      try { Object.defineProperty(window, name, { value: memoryStorage(), configurable: true }); } catch (__) { /* left as it is */ }
    }
  });
  // A page of another site opened from the sandbox would be sandboxed too, and
  // most sites break that way. Tendly opens it instead, in an ordinary tab.
  function outside(address) {
    try {
      var url = new URL(String(address), location.href);
      return (url.protocol === 'http:' || url.protocol === 'https:') && url.host !== location.host ? url.href : '';
    } catch (_) { return ''; }
  }

  if (framed) {
    window.addEventListener('error', function (event) {
      var target = event.target;
      if (target && target !== window && target.nodeType === 1) {
        // A script, stylesheet or image of the app that did not load.
        var address = target.src || target.href;
        if (address) report('load', 'Failed to load ' + address, { file: address });
        return;
      }
      var error = event.error;
      report('error', event.message || describe(error), {
        file: event.filename, line: event.lineno, column: event.colno, stack: error && error.stack
      });
    }, true);
    window.addEventListener('unhandledrejection', function (event) {
      var reason = event.reason;
      report('unhandledrejection', describe(reason), { stack: reason && reason.stack });
    });
    var consoleError = console.error;
    console.error = function () {
      try {
        var parts = [], stack;
        for (var i = 0; i < arguments.length; i++) {
          parts.push(describe(arguments[i]));
          if (!stack && arguments[i] instanceof Error) stack = arguments[i].stack;
        }
        report('console', parts.join(' '), { stack: stack });
      } catch (_) { /* reporting never breaks the app */ }
      return consoleError.apply(console, arguments);
    };
    // `fresh` marks a page that has just loaded: its errors, its hold and its context start from nothing.
    var where = function (fresh) {
      post({ type: 'location', page: location.pathname + location.search + location.hash, fresh: fresh === true });
    };
    window.addEventListener('hashchange', function () { where(false); });
    window.addEventListener('popstate', function () { where(false); });
    where(true);

    document.addEventListener('click', function (event) {
      if (event.defaultPrevented || event.button) return;
      var link = event.target && event.target.closest ? event.target.closest('a[href]') : null;
      var address = link ? outside(link.href) : '';
      if (!address) return;
      event.preventDefault();
      call('host.openUrl', { url: address }).catch(function () { /* said by Tendly */ });
    });
    var openWindow = window.open;
    window.open = function (address) {
      var external = address ? outside(address) : '';
      if (!external) return openWindow.apply(window, arguments);
      call('host.openUrl', { url: external }).catch(function () { /* said by Tendly */ });
      return null;
    };
  }

  window.tendly = {
    app: app,
    data: {
      get: async function (key, fallback) {
        try {
          return await call('data.get', { key: checkedKey(key) });
        } catch (error) {
          if (error.status === 404) return fallback === undefined ? null : fallback;
          throw error;
        }
      },
      set: async function (key, value) {
        if (value === undefined) throw new Error('tendly: set() needs a value (use remove() to delete)');
        return call('data.set', { key: checkedKey(key), json: JSON.stringify(value) });
      },
      list: function () { return call('data.list'); },
      remove: async function (key) { await call('data.remove', { key: checkedKey(key) }); }
    },
    host: {
      /** True while the app is shown inside Tendly (a pane or the full-screen view), false in a tab of its own. */
      framed: framed,
      holdReload: function (on) { post({ type: 'hold-reload', on: on !== false }); },
      setContext: function (context) {
        context = context || {};
        var selection = context.selection;
        post({
          type: 'context', view: clip(context.view, 80),
          selection: clip(selection === undefined || selection === null ? '' : describe(selection), 500),
          summary: clip(context.summary, 2000)
        });
      },
      openConversation: function (id) { return call('host.openConversation', { id: String(id) }); },
      openFile: function (path) { return call('host.openFile', { path: String(path) }); },
      openApp: function (slug) { return call('host.openApp', { slug: String(slug) }); },
      openUrl: function (address) { return call('host.openUrl', { url: String(address) }); },
      draftChat: function (text, options) {
        return call('host.draftChat', { text: String(text === undefined || text === null ? '' : text), attach: options && options.attach });
      },
      notify: function (title, body) {
        return call('host.notify', { title: String(title === undefined || title === null ? '' : title), body: body === undefined || body === null ? '' : String(body) });
      },
      toast: function (text) { return call('host.toast', { text: String(text === undefined || text === null ? '' : text) }); },
      get theme() { return theme; },
      onTheme: function (watcher) { return watch(themeWatchers, watcher, theme); },
      get pane() { return pane(); },
      onResize: function (watcher) { return watch(sizeWatchers, watcher, pane()); }
    },
    permissions: { get: function () { return call('permissions.get'); } },
    sessions: { list: function (options) { return call('sessions.list', options || {}); } },
    workspace: {
      files: function (path) { return call('workspace.files', { path: path === undefined || path === null ? '' : String(path) }); },
      read: function (path) { return call('workspace.read', { path: String(path) }); }
    },
    automations: { list: function (options) { return call('automations.list', options || {}); } }
  };
})();
