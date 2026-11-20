// Image uploads live in a real directory next to the database and are served
// back byte for byte. These tests boot server.js like the other HTTP suite and
// cover the auth split: upload and delete need a signed-in user, while the
// /files/<name> URL is public because published maps and share links embed it.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
let proc, base, port, dir;
let adminCookie, otherCookie;

async function waitFor(url, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(url); if (r.ok) return; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server did not come up: ' + url);
}

async function login(username, password) {
  const r = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(r.status, 200, 'login ' + username);
  const raw = r.headers.getSetCookie ? r.headers.getSetCookie()[0] : r.headers.get('set-cookie');
  return raw.split(';')[0];
}

const upload = (body, type, cookie) => fetch(base + '/api/files', {
  method: 'POST',
  headers: { 'Content-Type': type, ...(cookie ? { cookie } : {}) },
  body,
});

// fetch() normalises dot segments away at the URL layer, so the raw path is
// sent through node:http to make sure the server itself rejects it.
const rawGet = (rawPath) => new Promise((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port, path: rawPath, method: 'GET' }, res => {
    const chunks = [];
    res.on('data', c => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
  });
  req.on('error', reject);
  req.end();
});

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mindspark-uploads-'));
  port = 30000 + Math.floor(Math.random() * 20000);
  base = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(port), DB_PATH: join(dir, 'test.db'),
      ADMIN_USER: 'admin', ADMIN_PASSWORD: 'admin-pass-123' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitFor(base + '/healthz');
  adminCookie = await login('admin', 'admin-pass-123');
  const made = await fetch(base + '/api/admin/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: adminCookie },
    body: JSON.stringify({ username: 'other', password: 'other-pass-123' }),
  });
  assert.equal(made.status, 201);
  otherCookie = await login('other', 'other-pass-123');
});

after(async () => {
  if (proc) { proc.kill(); await new Promise(r => proc.once('exit', r)); }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('image uploads', () => {
  test('an anonymous upload is refused', async () => {
    assert.equal((await upload(PNG, 'image/png', null)).status, 401);
  });

  test('a PNG uploads once and comes back byte for byte', async () => {
    const r = await upload(PNG, 'image/png', adminCookie);
    assert.equal(r.status, 201);
    const j = await r.json();
    assert.match(j.url, /^\/files\/[0-9a-f]{32}\.png$/);
    assert.equal(j.id, j.url.slice('/files/'.length));
    assert.equal(j.size, PNG.length);
    assert.equal(j.mime, 'image/png');

    const g = await fetch(base + j.url);
    assert.equal(g.status, 200);
    assert.equal(g.headers.get('content-type'), 'image/png');
    assert.match(g.headers.get('cache-control') || '', /^public, max-age=31536000, immutable$/);
    assert.equal(Number(g.headers.get('content-length')), PNG.length);
    assert.deepEqual(Buffer.from(await g.arrayBuffer()), PNG);
  });

  test('a matching If-None-Match answers 304 with the same ETag', async () => {
    const first = await upload(PNG, 'image/png', adminCookie);
    const { url } = await first.json();
    const g = await fetch(base + url);
    const etag = g.headers.get('etag');
    assert.ok(etag);
    const again = await fetch(base + url, { headers: { 'If-None-Match': etag } });
    assert.equal(again.status, 304);
    assert.equal(again.headers.get('etag'), etag);
    assert.equal((await again.arrayBuffer()).byteLength, 0);
  });

  test('path traversal attempts are 404 and never leak a source file', async () => {
    const paths = ['/files/../server.js', '/files/%2e%2e/server.js',
      '/files/%2e%2e%2fserver.js', '/files/..%2fserver.js'];
    for (const p of paths) {
      const r = await rawGet(p);
      assert.equal(r.status, 404, p);
      assert.doesNotMatch(r.body.toString('utf8'), /createServer/, p);
    }
  });

  test('SVG, HTML, text and a MIME that contradicts the bytes are 415', async () => {
    const cases = [
      [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), 'image/svg+xml'],
      [Buffer.from('<!doctype html><p>hi</p>'), 'text/html'],
      [Buffer.from('just text'), 'text/plain'],
      [PNG, 'image/gif'],
    ];
    for (const [body, type] of cases) {
      assert.equal((await upload(body, type, adminCookie)).status, 415, type);
    }
  });

  test('a body over the cap is 413, not a 500', async () => {
    const r = await upload(Buffer.alloc(8_000_001, 0x89), 'image/png', adminCookie);
    assert.equal(r.status, 413);
    assert.deepEqual(await r.json(), { error: 'payload too large' });
  });

  test('an unknown name is 404', async () => {
    for (const name of ['a'.repeat(32) + '.png', '../server.js', 'short.png']) {
      assert.equal((await fetch(base + '/files/' + name)).status, 404, name);
    }
  });
});

describe('image deletes are owner-scoped', () => {
  test('another user gets 404 and the file keeps serving', async () => {
    const created = await (await upload(PNG, 'image/png', adminCookie)).json();
    const denied = await fetch(base + '/api/files/' + created.id, { method: 'DELETE', headers: { cookie: otherCookie } });
    assert.equal(denied.status, 404);
    assert.equal((await fetch(base + created.url)).status, 200, 'a refused delete must not touch the file');

    const ok = await fetch(base + '/api/files/' + created.id, { method: 'DELETE', headers: { cookie: adminCookie } });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true });
    assert.equal((await fetch(base + created.url)).status, 404);
  });
});
