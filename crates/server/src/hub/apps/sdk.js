/**
 * Tendly apps SDK, served at /api/hub/apps/sdk.js. Include it in an app page:
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
 *
 * Keys are letters, digits, "_" and "-", up to 64 characters. Every call
 * returns a Promise; failures reject with an Error carrying the server message
 * (and `status`, the HTTP status).
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
    }
  };
})();
