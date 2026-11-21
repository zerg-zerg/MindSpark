// Boots the real server.js (zero dependencies: node:http + node:sqlite) on a
// free port with a throwaway database and talks to it over HTTP. Covers what
// CI asserts by curl - the shell, app code and API all answer 200 - plus the
// map API round trip and the body check: a PUT whose body was not a JSON
// object used to be stored as the literal, which broke the next list load.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let proc, base, dir;

async function waitFor(url, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(url); if (r.ok) return; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server did not come up: ' + url);
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mindspark-test-'));
  const port = 30000 + Math.floor(Math.random() * 20000);
  base = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(port), DB_PATH: join(dir, 'test.db') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitFor(base + '/healthz');
});

after(async () => {
  if (proc) { proc.kill(); await new Promise(r => proc.once('exit', r)); }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
});

const json = (method, path, body) => fetch(base + path, {
  method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
});

describe('self-hosted server', () => {
  test('serves the shell, the app code and the API (what CI checks with curl)', async () => {
    for (const p of ['/', '/app.js', '/styles.css', '/api/maps']) {
      const r = await fetch(base + p);
      assert.equal(r.status, 200, p);
    }
    assert.equal((await fetch(base + '/healthz')).status, 200);
  });

  // Static assets used to go out as `no-store`, which forbade the browser from
  // keeping the bytes at all, so every load re-downloaded ~360 KB gzipped. The
  // freshness rule sw.js depends on is only that a client must never SERVE an
  // old build without asking - app.js and styles.css keep their URLs forever -
  // and `no-cache` plus a validator keeps exactly that while making the ask
  // cost nothing.
  describe('static assets revalidate instead of re-downloading', () => {
    test('every asset carries a validator and is never stored blind', async () => {
      for (const p of ['/', '/app.js', '/styles.css', '/sw.js']) {
        const r = await fetch(base + p);
        assert.equal(r.status, 200, p);
        const cc = r.headers.get('cache-control') || '';
        assert.match(cc, /no-cache/, `${p} must still force a round trip`);
        assert.doesNotMatch(cc, /no-store/, `${p} must be allowed to keep the bytes between round trips`);
        assert.ok(r.headers.get('etag'), `${p} has no ETag, so the round trip cannot answer 304`);
      }
    });

    test('a matching If-None-Match answers 304 with no body', async () => {
      const first = await fetch(base + '/app.js');
      const etag = first.headers.get('etag');
      const again = await fetch(base + '/app.js', { headers: { 'If-None-Match': etag } });
      assert.equal(again.status, 304);
      assert.equal(again.headers.get('etag'), etag, 'the 304 must re-state the validator');
      assert.equal((await again.text()).length, 0, 'a 304 must not carry a body');
    });

    test('a stale validator is answered with the new bytes', async () => {
      const r = await fetch(base + '/app.js', { headers: { 'If-None-Match': 'W/"not-the-current-build"' } });
      assert.equal(r.status, 200);
      assert.ok((await r.text()).length > 1000, 'a miss must send the file');
    });

    test('two different files never share a validator', async () => {
      const [a, b] = await Promise.all([fetch(base + '/app.js'), fetch(base + '/styles.css')]);
      assert.notEqual(a.headers.get('etag'), b.headers.get('etag'));
    });
  });

  test('a map round-trips through PUT, GET, list and DELETE', async () => {
    const m = { title: 'Round trip', color: '#3a6ea5', rootId: 'r', nodes: { r: { id: 'r', text: 'R', parent: null } }, links: [] };
    assert.equal((await json('PUT', '/api/maps/t1', m)).status, 200);
    const got = await (await fetch(base + '/api/maps/t1')).json();
    assert.equal(got.title, 'Round trip');
    assert.equal(got.id, 't1', 'the URL id wins');
    const list = await (await fetch(base + '/api/maps')).json();
    assert.ok(list.some(x => x.id === 't1' && x.color === '#3a6ea5'));
    assert.equal((await fetch(base + '/api/maps/t1', { method: 'DELETE' })).status, 204);
    assert.equal((await fetch(base + '/api/maps/t1')).status, 404);
  });

  test('a body that is not a JSON object is rejected instead of stored', async () => {
    for (const body of [5, null, 'text', [1, 2]]) {
      const r = await json('PUT', '/api/maps/bad', body);
      assert.equal(r.status, 400, JSON.stringify(body));
    }
    assert.equal((await json('POST', '/api/maps', 7)).status, 400);
    assert.equal((await fetch(base + '/api/maps/bad')).status, 404, 'nothing was stored');
  });

  test('POST without an id is still a 400', async () => {
    assert.equal((await json('POST', '/api/maps', { title: 'no id' })).status, 400);
  });

  test('static files never escape the public folder', async () => {
    const r = await fetch(base + '/../server.js');
    assert.notEqual(r.status, 200);
    assert.notEqual((await fetch(base + '/%2e%2e/server.js')).status, 200);
  });
});

// A custom LLM provider lives on an origin the shipped Content-Security-Policy
// does not list. A self-hoster allows it with EXTRA_CONNECT_SRC, and it has to
// reach BOTH policies the browser enforces: the response header and the <meta>
// tag inside index.html (the browser applies the intersection, so a header
// alone would leave the meta blocking the request). Appended, never replaced.
describe('EXTRA_CONNECT_SRC', () => {
  let p2, base2, dir2;
  before(async () => {
    dir2 = mkdtempSync(join(tmpdir(), 'mindspark-csp-'));
    const port = 30000 + Math.floor(Math.random() * 20000);
    base2 = `http://127.0.0.1:${port}`;
    p2 = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(ROOT, 'server.js')], {
      env: { ...process.env, PORT: String(port), DB_PATH: join(dir2, 'test.db'), EXTRA_CONNECT_SRC: 'http://localhost:11434 https://api.mistral.ai junk-not-an-origin' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitFor(base2 + '/healthz');
  });
  after(async () => {
    if (p2) { p2.kill(); await new Promise(r => p2.once('exit', r)); }
    try { rmSync(dir2, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  test('the header and the served meta tag both gain the origins; malformed entries are ignored', async () => {
    const r = await fetch(base2 + '/');
    const header = r.headers.get('content-security-policy');
    const html = await r.text();
    const meta = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
    for (const policy of [header, meta]) {
      const connect = policy.match(/connect-src ([^;]+)/)[1];
      assert.match(connect, /https:\/\/api\.github\.com/, 'the shipped list is still there');
      assert.match(connect, /http:\/\/localhost:11434/);
      assert.match(connect, /https:\/\/api\.mistral\.ai/);
      assert.doesNotMatch(connect, /junk/);
    }
    assert.equal((header.match(/connect-src/g) || []).length, 1);
    const js = await (await fetch(base2 + '/app.js')).text();
    assert.equal(js, readFileSync(join(ROOT, 'public', 'app.js'), 'utf8'), 'only the HTML is rewritten; scripts are served byte for byte');
  });
});

// readBody() used to build the body with `str += chunk`, decoding each network
// chunk on its own, so a multi-byte character split across a chunk boundary
// came back as two U+FFFD. Every map over one chunk (~64 KB) with emoji or
// non-Latin text was silently corrupted on save.
describe('self-hosted server - request bodies', () => {
  test('a large non-ASCII map round-trips byte for byte', async () => {
    const text = '😀 नमस्ते 你好 '.repeat(12000);   // ~250 KB, many chunk boundaries
    const put = await json('PUT', '/api/maps/utf8big', { title: 'Ünïcödé ✓', nodes: { r: { id: 'r', text } } });
    assert.equal(put.status, 200);
    const got = await (await fetch(base + '/api/maps/utf8big')).json();
    assert.equal(got.nodes.r.text.includes('�'), false, 'replacement characters crept in');
    assert.equal(got.nodes.r.text, text);
    assert.equal(got.title, 'Ünïcödé ✓');
  });

  test('malformed JSON is the client\'s error (400), not a server error', async () => {
    const r = await fetch(base + '/api/maps/badjson', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"id":' });
    assert.equal(r.status, 400);
  });

  test('an oversized body is still refused', async () => {
    const r = await fetch(base + '/api/maps/huge', { method: 'PUT', body: 'x'.repeat(8e6 + 10) }).catch(e => e);
    assert.ok(r instanceof Error || r.status >= 400, 'an 8 MB+ body must not be accepted');
  });
});

// server.js carries its own buildMapFromSpec (it is CommonJS and ships inside
// the pkg binary; the Worker's copy is ESM). The server's copy had fallen
// behind: imports through a self-hosted server dropped list/format/task/marker
// fields, citation.source, root-branch balancing and layoutConfig. Pin the two
// to the same output.
describe('self-hosted server - /api/import matches the Worker', () => {
  test('the same spec produces the same nodes, links and layout knobs', async () => {
    const { buildMapFromSpec } = await import('../worker/import-core.js');
    const spec = {
      title: 'Parity', color: '#3a6ea5',
      nodes: [
        { id: 'r', text: 'Root', parent: null },
        { id: 'a', text: 'A', parent: 'r', listType: 'ul', bold: true, italic: true, highlight: true },
        { id: 'b', text: 'B', parent: 'r', align: 'right', task: 'done', marker: '  ⭐  ', tag: 7 },
        { id: 'c', text: 'C', parent: 'r', collapsed: true, notes: 'n',
          citation: { authors: ['X', 'Y'], year: 2020, title: 'T', source: 'Nature', doi: '10.1/x' } },
        { id: 'd', text: 'D', parent: 'b', citation: { arxiv: '2101.00001' } },
        { id: 'e', text: 'E', parent: 'r', task: 'nope', marker: 'too long', listType: 'x' },
      ],
      links: [{ from: 'a', to: 'd', label: 'rel' }, { from: 'a', to: 'missing' }],
      layoutConfig: { timeline: { gap: 9999, stem: -5, indent: 12.4, alternate: true, start: 'below' } },
    };
    const r = await json('POST', '/api/import', spec);
    assert.equal(r.status, 201);
    const { id } = await r.json();
    const saved = await (await fetch(base + '/api/maps/' + id)).json();
    const worker = buildMapFromSpec(spec);
    assert.deepEqual(saved.nodes, worker.nodes);
    assert.deepEqual(saved.links, worker.links);
    assert.deepEqual(saved.layoutConfig, worker.layoutConfig);
    assert.equal(saved.rootId, worker.rootId);
    assert.equal(saved.title, worker.title);
    assert.equal(saved.color, worker.color);
    // server-only bookkeeping is unchanged
    assert.equal(saved._import, true);
    assert.equal(saved.titleAuto, false);
    assert.equal(typeof saved.updated, 'number');
  });
});

// A port already in use used to crash with a raw stack trace. It now exits 1 and
// says what happened.
describe('self-hosted server - startup', () => {
  test('a busy port gives a readable error and exit code 1', async () => {
    const port = new URL(base).port;
    const second = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(ROOT, 'server.js')], {
      env: { ...process.env, PORT: port, DB_PATH: join(dir, 'second.db') }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let err = ''; second.stderr.on('data', d => { err += d; });
    const code = await new Promise(r => second.once('exit', r));
    assert.equal(code, 1);
    assert.match(err, /already in use/);
  });
});

// Autosave runs after every short pause in editing, and a version per save let the
// 50-version cap cover only the last few minutes. Saves within a minute of the
// newest version now refine it; a later save starts a new one.
describe('self-hosted server - version history', () => {
  const put = (id, updated, text) => json('PUT', '/api/maps/' + id, { title: 'V', updated, nodes: { r: { id: 'r', text } } });
  const versions = async id => (await (await fetch(base + '/api/maps/' + id + '/versions')).json()).length;
  test('saves inside a minute share one version, holding the latest content', async () => {
    const t0 = 1_700_000_000_000;
    await put('vh1', t0, 'one');
    await put('vh1', t0 + 10_000, 'two');
    await put('vh1', t0 + 20_000, 'three');
    assert.equal(await versions('vh1'), 1);
    const list = await (await fetch(base + '/api/maps/vh1/versions')).json();
    const v = await (await fetch(base + '/api/maps/vh1/versions/' + list[0].ts)).json();
    assert.equal(v.nodes.r.text, 'three');
  });
  test('a save a minute or more later starts a new version', async () => {
    const t0 = 1_700_000_000_000;
    await put('vh2', t0, 'one');
    await put('vh2', t0 + 61_000, 'two');
    await put('vh2', t0 + 125_000, 'three');
    assert.equal(await versions('vh2'), 3);
  });
});

// The sidebar's folders. A map's folder is stored twice by design: inside the
// map JSON (so it travels with exports and versions) and in a `maps.folder`
// column (so the list can group without downloading every map). These tests
// spawn their own server with a seeded administrator, because the maps API is
// owner-scoped and answers only to a signed-in user.
describe('self-hosted server - folders', () => {
  let p3, base3, dir3, cookie;
  before(async () => {
    dir3 = mkdtempSync(join(tmpdir(), 'mindspark-folders-'));
    const port = 30000 + Math.floor(Math.random() * 20000);
    base3 = `http://127.0.0.1:${port}`;
    p3 = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(ROOT, 'server.js')], {
      env: { ...process.env, PORT: String(port), DB_PATH: join(dir3, 'test.db'), ADMIN_USER: 'admin', ADMIN_PASSWORD: 'folders-test-123' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitFor(base3 + '/healthz');
    const r = await fetch(base3 + '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'folders-test-123' }),
    });
    assert.equal(r.status, 200, 'the seeded administrator signs in');
    cookie = r.headers.get('set-cookie').split(';')[0];
  });
  after(async () => {
    if (p3) { p3.kill(); await new Promise(r => p3.once('exit', r)); }
    try { rmSync(dir3, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  test('a map filed into a folder lists and reads back with it', async () => {
    const m = { title: 'Filed', color: '#3a6ea5', folder: 'Work', rootId: 'r', nodes: { r: { id: 'r', text: 'R', parent: null } }, links: [] };
    assert.equal((await fetch(base3 + '/api/maps/f1', { method: 'PUT', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify(m) })).status, 200);
    const list = await (await fetch(base3 + '/api/maps', { headers: { cookie } })).json();
    const row = list.find(x => x.id === 'f1');
    assert.ok(row, 'the map is listed');
    assert.equal(row.folder, 'Work');
    const got = await (await fetch(base3 + '/api/maps/f1', { headers: { cookie } })).json();
    assert.equal(got.folder, 'Work', 'GET returns folder inside the map data');
  });

  test('PUT without a folder takes the column back to NULL and drops the key', async () => {
    const m = { title: 'Unfiled', color: '#3a6ea5', rootId: 'r', nodes: { r: { id: 'r', text: 'R', parent: null } }, links: [] };
    assert.equal((await fetch(base3 + '/api/maps/f1', { method: 'PUT', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify(m) })).status, 200);
    const list = await (await fetch(base3 + '/api/maps', { headers: { cookie } })).json();
    assert.equal(list.find(x => x.id === 'f1').folder, null, 'no empty string lingers in the column');
    const got = await (await fetch(base3 + '/api/maps/f1', { headers: { cookie } })).json();
    assert.ok(!('folder' in got), 'unfiling deleted the key from the data, it did not write ""');
  });
});

// A database written before the folder column existed must keep serving: boot
// adds the column and backfills it from map JSON that already carried a folder
// (a newer client once saved against an older server), and the old rows read
// exactly as before. The pre-folder database is built in-process with the same
// node:sqlite the server itself uses, then the server is booted on top of it.
describe('self-hosted server - folder column migration', () => {
  let p4, base4, dir4, cookie;
  before(async () => {
    dir4 = mkdtempSync(join(tmpdir(), 'mindspark-migrate-'));
    const { DatabaseSync } = await import('node:sqlite');
    const crypto = await import('node:crypto');
    const legacy = new DatabaseSync(join(dir4, 'test.db'));
    // Same scrypt format the server stores, so the seeded user can sign in.
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync('folders-test-123', salt, 64).toString('hex');
    const uid = crypto.randomUUID();
    legacy.exec(`CREATE TABLE users (
      id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user', created INTEGER NOT NULL, disabled INTEGER NOT NULL DEFAULT 0)`);
    legacy.prepare('INSERT INTO users (id,username,password_hash,role,created) VALUES (?,?,?,\'admin\',?)')
      .run(uid, 'admin', `scrypt$${salt}$${hash}`, Date.now());
    legacy.exec(`CREATE TABLE maps (
      owner_id TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL DEFAULT 'Untitled map',
      color TEXT, data TEXT NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY (owner_id, id))`);
    // One row with a folder only inside its JSON (the backfill case), one plain.
    legacy.prepare('INSERT INTO maps (owner_id,id,title,color,data,updated) VALUES (?,?,?,?,?,?)').run(
      uid, 'old1', 'Legacy map', '#3a6ea5',
      JSON.stringify({ id: 'old1', title: 'Legacy map', color: '#3a6ea5', rootId: 'r', nodes: { r: { id: 'r', text: 'R', parent: null } }, links: [], folder: 'Legacy' }),
      Date.now());
    legacy.prepare('INSERT INTO maps (owner_id,id,title,color,data,updated) VALUES (?,?,?,?,?,?)').run(
      uid, 'old2', 'Plain legacy', null,
      JSON.stringify({ id: 'old2', title: 'Plain legacy', rootId: 'r', nodes: { r: { id: 'r', text: 'R', parent: null } }, links: [] }),
      Date.now());
    legacy.close();
    const port = 30000 + Math.floor(Math.random() * 20000);
    base4 = `http://127.0.0.1:${port}`;
    p4 = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(ROOT, 'server.js')], {
      env: { ...process.env, PORT: String(port), DB_PATH: join(dir4, 'test.db'), ADMIN_USER: 'admin', ADMIN_PASSWORD: 'folders-test-123' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitFor(base4 + '/healthz');
    const r = await fetch(base4 + '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'folders-test-123' }),
    });
    assert.equal(r.status, 200, 'the seeded legacy user still signs in');
    cookie = r.headers.get('set-cookie').split(';')[0];
  });
  after(async () => {
    if (p4) { p4.kill(); await new Promise(r => p4.once('exit', r)); }
    try { rmSync(dir4, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  test('boot adds the column and backfills it from the map JSON', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(join(dir4, 'test.db'));
    try {
      const cols = db.prepare('PRAGMA table_info(maps)').all().map(c => c.name);
      assert.ok(cols.includes('folder'), 'the folder column exists after boot');
      assert.equal(db.prepare('SELECT folder FROM maps WHERE id = ?').get('old1').folder, 'Legacy', 'the folder in the JSON was backfilled');
      assert.equal(db.prepare('SELECT folder FROM maps WHERE id = ?').get('old2').folder, null, 'a plain row stays unfiled');
    } finally { db.close(); }
  });

  test('old rows keep serving, over GET and in the list', async () => {
    const got = await (await fetch(base4 + '/api/maps/old1', { headers: { cookie } })).json();
    assert.equal(got.title, 'Legacy map');
    assert.equal(got.folder, 'Legacy');
    const list = await (await fetch(base4 + '/api/maps', { headers: { cookie } })).json();
    assert.equal(list.find(x => x.id === 'old1').folder, 'Legacy');
    assert.equal(list.find(x => x.id === 'old2').folder, null);
  });
});
