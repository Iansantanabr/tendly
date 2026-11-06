/**
 * Tendly apps SDK, served at /api/hub/apps/sdk.js. Include it in an app page,
 * before the app's own scripts:
 *
 *   <script src="/api/hub/apps/sdk.js"></script>
 *
 * The page must be served by Tendly at /api/hub/apps/<workspace>/<slug>/files/...
 * The SDK reads the workspace and slug from that address and exposes:
 *
 *   tendly.app                    { workspaceId, slug }
 *   tendly.data.get(key, fallback) the stored JSON value, or fallback (null) if none
 *   tendly.data.set(key, value)    stores any JSON value (up to 1 MB) -> { key, size, updated_at }
 *   tendly.data.list()             [{ key, size, updated_at }]
 *   tendly.data.remove(key)        deletes the value
 *   tendly.host.holdReload(true)   asks Tendly not to reload the app while there is unsaved input;
 *                                  holdReload(false) lets it reload again (and it reloads then, if it was waiting)
 *
 * Keys are letters, digits, "_" and "-", up to 64 characters. Every data call
 * returns a Promise; failures reject with an Error carrying the server message
 * (and `status`, the HTTP status).
 *
 * Tendly reloads an open app by itself when its files change. Inside Tendly
 * the SDK also tells the page that frames the app, and only that page, about
 * the app's errors (uncaught errors, unhandled rejections, console.error and
 * files that failed to load) and which of its pages is showing, so the header
 * can say "2 errors" and offer to ask an agent for a fix.
 */
(function () {
  'use strict';
  var match = /^\/api\/hub\/apps\/([^/]+)\/([^/]+)\/files(?:\/|$)/.exec(location.pathname);
  var base = match ? '/api/hub/apps/' + match[1] + '/' + match[2] + '/data' : null;

  function url(key) {
    if (!base) throw new Error('tendly: this page is not being served as a Tendly app');
    if (key === undefined) return base;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(key))) {
      throw new Error('tendly: invalid key "' + key + '" (letters, digits, _ and -, up to 64)');
    }
    return base + '/' + key;
  }

  async function call(method, path, body) {
    var headers = { Accept: 'application/json' };
    if (method !== 'GET') headers['X-Tendly-Client'] = 'web';
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    var response = await fetch(path, {
      method: method, headers: headers, body: body, credentials: 'same-origin', cache: 'no-store'
    });
    if (response.ok) return response.status === 204 ? undefined : response.json();
    var message = response.status + ' ' + response.statusText;
    try {
      var payload = await response.json();
      if (payload && payload.error) message = payload.error;
    } catch (_) { /* not JSON: keep the status line */ }
    var error = new Error(message);
    error.status = response.status;
    throw error;
  }

  // ---- The page that frames the app -------------------------------------
  // Messages go to the parent window only, and only when it is a Tendly page:
  // the target origin is this page's own (apps are served by Tendly itself),
  // so a page of any other origin that framed the app would receive nothing.
  var HOST_ORIGIN = location.origin;
  var framed = !!match && window.parent && window.parent !== window;
  var MAX_REPORTS = 50, reports = 0, lastReport = '';

  function post(message) {
    if (!framed) return;
    message.source = 'tendly-app';
    message.v = 1;
    try { window.parent.postMessage(message, HOST_ORIGIN); } catch (_) { /* the frame is going away */ }
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
    // `fresh` marks a page that has just loaded: its errors and its hold start from nothing.
    var where = function (fresh) {
      post({ type: 'location', page: location.pathname + location.search + location.hash, fresh: fresh === true });
    };
    window.addEventListener('hashchange', function () { where(false); });
    window.addEventListener('popstate', function () { where(false); });
    where(true);
  }

  window.tendly = {
    app: match ? { workspaceId: decodeURIComponent(match[1]), slug: decodeURIComponent(match[2]) } : null,
    data: {
      get: async function (key, fallback) {
        try {
          return await call('GET', url(key));
        } catch (error) {
          if (error.status === 404) return fallback === undefined ? null : fallback;
          throw error;
        }
      },
      set: async function (key, value) {
        if (value === undefined) throw new Error('tendly: set() needs a value (use remove() to delete)');
        return call('PUT', url(key), JSON.stringify(value));
      },
      list: async function () {
        return (await call('GET', url())).keys;
      },
      remove: async function (key) {
        await call('DELETE', url(key));
      }
    },
    host: {
      /** True while the app is shown inside Tendly (a pane or the full-screen view), false in a tab of its own. */
      framed: framed,
      holdReload: function (on) {
        post({ type: 'hold-reload', on: on !== false });
      }
    }
  };
})();
