// public/image-store.js is a classic browser script: it defines one global and
// runs nothing at load. It is evaluated here in a bare VM context holding only
// the globals it touches, so the upload plumbing app.js leans on is exercised
// without a browser.
//
// The regression worth keeping: the encoded attachment used to become a Blob via
// fetch(dataUrl), and the page CSP lists no data: under connect-src, so EVERY
// server-side upload failed and the image was quietly embedded in the map JSON
// instead. Decoding the base64 here has no CSP to fight.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SRC = readFileSync(new URL('../public/image-store.js', import.meta.url), 'utf8');
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const B64 = Buffer.from(PNG).toString('base64');

// `document.baseURI` is a sub-path deployment on purpose: resolve() must keep
// the app's directory instead of escaping to the origin root.
function load(extra = {}) {
  const ctx = {
    window: {},
    document: { baseURI: 'https://app.example/sub/index.html' },
    atob, btoa, Blob, Uint8Array, URL, console,
    ...extra
  };
  vm.runInNewContext(SRC, ctx);
  return ctx.window.MSImageStore;
}

describe('a stored image value becomes something a page can load', () => {
  const store = load();

  test('an absolute or embedded URL passes through untouched', () => {
    for (const src of ['data:image/png;base64,AA', 'blob:https://app.example/1', 'https://cdn.example/a.png']) {
      assert.equal(store.resolve(src), src);
    }
  });

  test('a server path is joined to the app root, sub-path deployments included', () => {
    assert.equal(store.resolve('/files/a.png'), 'https://app.example/sub/files/a.png');
    assert.equal(store.resolve('files/a.png'), 'https://app.example/sub/files/a.png');
    assert.equal(store.isServerUrl('/files/a.png'), true);
    assert.equal(store.isServerUrl('data:image/png;base64,AA'), false);
  });
});

describe('the attachment is decoded locally, never fetched', () => {
  const store = load();

  test('base64 becomes the same bytes with the same type', async () => {
    const blob = store.blobFromDataUrl('data:image/png;base64,' + B64);
    assert.equal(blob.type, 'image/png');
    assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), PNG);
  });

  test('jpeg keeps its own type, so the server sniffs the same bytes it was told about', () => {
    assert.equal(store.blobFromDataUrl('data:image/jpeg;base64,' + B64).type, 'image/jpeg');
  });

  test('anything that is not base64 image data is refused, never guessed at', () => {
    for (const src of [
      'data:text/html;base64,PGI+eDwvYj4=',
      'data:image/png,not-base64',
      'data:image/png;base64,!!!',
      '/files/a.png',
      '',
      null
    ]) assert.equal(store.blobFromDataUrl(src), null, String(src));
  });
});

describe('upload goes to the app server as a raw body', () => {
  const name = 'a'.repeat(32) + '.png';

  test('it posts the blob with its own type and returns the stored path', async () => {
    const calls = [];
    const store = load({
      MODE: 'server',
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        return { status: 201, json: async () => ({ url: '/files/' + name }) };
      }
    });
    const blob = new Blob([PNG], { type: 'image/png' });
    assert.equal(await store.upload(blob), '/files/' + name);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://app.example/sub/api/files');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.body, blob);                    // no FormData, no base64
    assert.equal(calls[0].init.headers['Content-Type'], 'image/png');
    assert.equal(calls[0].init.credentials, 'same-origin');
  });

  test("the server's reason reaches the caller, which then falls back", async () => {
    const store = load({
      MODE: 'server',
      fetch: async () => ({ status: 415, json: async () => ({ error: 'unsupported image type' }) })
    });
    await assert.rejects(() => store.upload(new Blob([PNG], { type: 'image/png' })), /unsupported image type/);
  });

  test('a cloud or static build offers no upload at all', async () => {
    await assert.rejects(
      () => load().upload(new Blob([PNG], { type: 'image/png' })),
      /only available on the app server/
    );
    assert.equal(load().available(), false);
    assert.equal(load({ MODE: 'server' }).available(), true);
  });
});
