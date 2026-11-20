/* public/image-store.js
 * Loaded as a CLASSIC script (no modules, no bundler) alongside app.js.
 *
 * Depends on:
 *   - document.baseURI                     (always available)
 *   - OPTIONAL, looked up lazily at call time only:
 *       appUrl(path)  - app.js declares this as `const appUrl` at the top of the
 *                       classic script, so it lives in the global lexical scope
 *                       and may sit in its TDZ while this file loads. Every read
 *                       is guarded and falls back to the exact same expression
 *                       appUrl itself uses.
 *       MODE          - app.js's `let MODE = 'unknown' | 'server' | 'cloud'`,
 *                       also a global lexical binding (TDZ until app.js reaches
 *                       line ~1100), so it is only ever read through try/catch.
 *
 * Nothing here touches the DOM or runs any logic at load time; it only defines
 * window.MSImageStore. Load order relative to app.js is therefore irrelevant.
 *
 * API (window.MSImageStore):
 *   available()            -> boolean, true only against the Node server
 *   upload(blob, opts)     -> Promise<string>  ('/files/<name>')
 *   resolve(src)           -> string, absolute/same-origin URL for a stored value
 *   isServerUrl(src)       -> boolean, true for '/files/...' (or 'files/...')
 *   blobFromDataUrl(src)   -> Blob|null, the decoded image an upload sends
 */
(function () {
  'use strict';

  function baseURL() {
    try {
      return document.baseURI || window.location.href;
    } catch (_e) {
      return window.location.href;
    }
  }

  // Canonical app URL builder. `typeof appUrl` on a const/let global binding in
  // its TDZ throws, hence the guard; the fallback mirrors app.js:46 verbatim.
  function url(path) {
    try {
      if (typeof appUrl === 'function') return appUrl(path);
    } catch (_e) { /* app.js not loaded yet, or appUrl is still in its TDZ */ }
    return new URL(path, baseURL()).href;
  }

  // Server-only capability. window.MINDSPARK_HOST (a companion/cloud host that
  // injects a Store) deliberately does NOT imply an upload endpoint - only a
  // real Node server (MODE === 'server') does, because only it owns /files/.
  function available() {
    try {
      return typeof MODE === 'string' && MODE === 'server';
    } catch (_e) {
      return false;   // MODE still in its TDZ (or missing): treat as unavailable
    }
  }

  var FILES_PREFIX = /^\/?files\//;

  function isServerUrl(src) {
    return typeof src === 'string' && FILES_PREFIX.test(src.replace(/^\s+/, ''));
  }

  // Stored values can be data:, blob:, http(s):, or a server-relative
  // '/files/<32hex>.<ext>'. Data/blob/remote URLs are already usable as-is.
  // A relative server path is joined to the app root via appUrl() so sub-path
  // deployments keep working; the leading slash is stripped first because a
  // literal '/files/x' would otherwise resolve against the origin root and
  // escape the app's sub-directory.
  function resolve(src) {
    if (typeof src !== 'string') return src;
    var s = src.trim();
    if (!s) return src;
    if (/^(data:|blob:|https?:)/i.test(s)) return src;
    if (FILES_PREFIX.test(s)) return url(s.replace(/^\/+/, ''));
    return src;
  }

  // A data: URL as a Blob, decoded here rather than through fetch(): a data URL
  // is a connect-src target and the page CSP lists no data:, so fetching one is
  // refused outright ("TypeError: Failed to fetch"). The bytes are identical.
  // Returns null for anything that is not an image, which the caller treats as
  // "upload impossible" and stores the attachment inside the map instead.
  function blobFromDataUrl(src) {
    var s = String(src == null ? '' : src);
    var comma = s.indexOf(',');
    if (s.slice(0, 5) !== 'data:' || comma < 0) return null;
    var meta = s.slice(5, comma);
    var mime = (/^([^;]+)/.exec(meta) || [])[1] || '';
    if (!/^image\//i.test(mime)) return null;
    if (!/;base64/i.test(meta)) return null;   // a canvas always emits base64
    var bin;
    try {
      bin = atob(s.slice(comma + 1));
    } catch (_e) {
      return null;
    }
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return new Blob([out], { type: mime });
  }

  // Raw-body upload: no FormData, no base64. server.js (or the endpoint added by
  // the wiring step) answers 201 with { url: '/files/<name>' }.
  async function upload(blob, opts) {
    opts = opts || {};
    if (!available()) {
      throw new Error('Image upload is only available on the app server');
    }
    if (!blob) throw new Error('No image data to upload');

    var type = (blob && blob.type) || 'application/octet-stream';
    var res;
    try {
      res = await fetch(url('api/files'), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': type },
        body: blob,
        signal: opts.signal
      });
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
      throw new Error('Upload failed: ' + ((e && e.message) || 'network error'));
    }

    var data = null;
    try {
      data = await res.json();
    } catch (_e) {
      data = null;
    }

    if (res.status === 201) {
      if (data && typeof data.url === 'string' && data.url) return data.url;
      // Tolerate a server that only reports the stored file name.
      if (data && typeof data.name === 'string' && data.name) return '/files/' + data.name;
    }

    var msg = (data && (data.error || data.message)) || ('Upload failed (HTTP ' + res.status + ')');
    throw new Error(String(msg));
  }

  window.MSImageStore = {
    available: available,
    upload: upload,
    resolve: resolve,
    isServerUrl: isServerUrl,
    blobFromDataUrl: blobFromDataUrl
  };
})();
