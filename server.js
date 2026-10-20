/**
 * MindSpark - open-source mind mapping server.
 *
 * ZERO dependencies. Uses Node's built-in HTTP server and built-in SQLite.
 * No `npm install` required. Just:
 *
 * 
 *   node server.js
 *
 * Requires Node.js >= 22 (for the built-in node:sqlite module).
 *
 * Environment variables (all optional):
 *   PORT     – HTTP port            (default 3000)
 *   DB_PATH  – SQLite database file (default ./data/mindspark.db)
 *   PUBLIC   – static files dir     (default ./public)
 */

'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'mindspark.db');
// PUBLIC collides with a standard Windows env var of the same name
// (C:\Users\Public) that every Windows machine inherits - reading it blindly
// would send static requests to the wrong folder. MS_PUBLIC is the
// unambiguous override; the legacy PUBLIC name is still honoured when it is
// not just the OS default. (The pkg launcher sets PUBLIC to the snapshot
// path, which never matches the Windows default, so that flow is unaffected.)
const PUBLIC =
  process.env.MS_PUBLIC ||
  (process.env.PUBLIC && !(process.platform === 'win32' && /^[a-zA-Z]:[\\/]Users[\\/]Public$/i.test(process.env.PUBLIC)) ? process.env.PUBLIC : null) ||
  path.join(__dirname, 'public');

// ---- database ------------------------------------------------------------
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);

// Accounts + sessions. A self-hosted instance is no longer a single anonymous
// workspace: an administrator (seeded from the environment) creates users, and
// each user only ever sees their own maps.
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'user',
    created       INTEGER NOT NULL,
    disabled      INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token   TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    created INTEGER NOT NULL,
    expires INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);
`);

// ---- auth primitives -----------------------------------------------------
// Passwords: scrypt (built into node:crypto) with a per-user random salt, stored
// as `scrypt$<saltHex>$<hashHex>`. Sessions: an opaque random token in an
// HttpOnly cookie, with a row in `sessions` so it can be revoked by deleting it.
const COOKIE_NAME = 'ms_session';
const SCRYPT_KEYLEN = 64;
const SESSION_TTL_MS = Math.max(1, Number(process.env.SESSION_TTL_DAYS) || 30) * 24 * 60 * 60 * 1000;

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pw), salt, SCRYPT_KEYLEN).toString('hex');
  return `scrypt$${salt}$${hash}`;
}
function verifyPassword(pw, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  let got;
  try { got = crypto.scryptSync(String(pw), parts[1], SCRYPT_KEYLEN).toString('hex'); }
  catch (e) { return false; }
  const a = Buffer.from(got, 'hex'), b = Buffer.from(parts[2], 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function parseCookies(req) {
  const out = {};
  const raw = req.headers && req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
// `Secure` is added only when the request really arrived over TLS (a reverse
// proxy sets x-forwarded-proto), so the cookie still works on plain-http
// localhost during setup.
function cookieHeader(value, req, maxAgeSec) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Lax`
    + (proto === 'https' ? '; Secure' : '')
    + (maxAgeSec != null ? `; Max-Age=${maxAgeSec}` : '');
}

// ---- bootstrap administrator --------------------------------------------
// ADMIN_USER / ADMIN_PASSWORD seed one administrator on first run. The password
// is never overwritten on later starts (that would let an edited env file
// silently change a live password); set ADMIN_PASSWORD_RESET=1 to force it.
function ensureBootstrapAdmin() {
  const username = (process.env.ADMIN_USER || '').trim();
  const password = process.env.ADMIN_PASSWORD || '';
  if (!username || !password) {
    const n = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    if (!n) console.warn('\n  \u26a0  No users exist and ADMIN_USER/ADMIN_PASSWORD are not set - nobody can sign in yet.');
    return '';
  }
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) {
    if (process.env.ADMIN_PASSWORD_RESET === '1') {
      db.prepare("UPDATE users SET password_hash = ?, role = 'admin' WHERE id = ?").run(hashPassword(password), existing.id);
      console.log(`  Administrator password reset for "${username}".`);
    }
    return existing.id;
  }
  const id = crypto.randomUUID();
  db.prepare("INSERT INTO users (id,username,password_hash,role,created) VALUES (?,?,?,'admin',?)")
    .run(id, username, hashPassword(password), Date.now());
  console.log(`  Created administrator "${username}".`);
  return id;
}
const ADMIN_ID = ensureBootstrapAdmin();

// ---- maps + versions (owned by a user) ----------------------------------
// Owner-scoped with a COMPOSITE primary key, so two accounts can never collide
// on a map id and one account can never reach another's rows.
const MAP_TABLES = `
  CREATE TABLE IF NOT EXISTS maps (
    owner_id TEXT NOT NULL,
    id       TEXT NOT NULL,
    title    TEXT NOT NULL DEFAULT 'Untitled map',
    color    TEXT,
    data     TEXT NOT NULL,
    updated  INTEGER NOT NULL,
    PRIMARY KEY (owner_id, id)
  );
  CREATE TABLE IF NOT EXISTS map_versions (
    owner_id TEXT NOT NULL,
    id       TEXT NOT NULL,
    ts       INTEGER NOT NULL,
    data     TEXT NOT NULL,
    PRIMARY KEY (owner_id, id, ts)
  );
`;
// A database written before authentication existed has maps(id PRIMARY KEY) with
// no owner_id. Upgrade it in place and hand those maps to the bootstrap
// administrator so nothing is lost.
function migrateLegacyMaps(adminId) {
  let cols = [];
  try { cols = db.prepare('PRAGMA table_info(maps)').all().map(c => c.name); } catch (e) { cols = []; }
  if (!cols.length || cols.includes('owner_id')) return;   // fresh, or already migrated
  const owner = adminId || '';
  db.exec('ALTER TABLE maps RENAME TO maps_legacy');
  const hadVersions = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='map_versions'").get();
  if (hadVersions) db.exec('ALTER TABLE map_versions RENAME TO map_versions_legacy');
  db.exec(MAP_TABLES);
  db.prepare('INSERT INTO maps (owner_id,id,title,color,data,updated) SELECT ?,id,title,color,data,updated FROM maps_legacy').run(owner);
  if (hadVersions) {
    db.prepare('INSERT INTO map_versions (owner_id,id,ts,data) SELECT ?,id,ts,data FROM map_versions_legacy').run(owner);
    db.exec('DROP TABLE map_versions_legacy');
  }
  db.exec('DROP TABLE maps_legacy');
  console.log(owner
    ? '  Migrated existing maps to the administrator account.'
    : '  Migrated existing maps with no owner - set ADMIN_USER/ADMIN_PASSWORD to claim them.');
}
migrateLegacyMaps(ADMIN_ID);
db.exec(MAP_TABLES);
// Created after any migration so the name is free: renaming a table keeps its
// old index, and an IF NOT EXISTS index of the same name would then be a no-op.
db.exec('CREATE INDEX IF NOT EXISTS idx_versions_id ON map_versions (owner_id, id, ts DESC)');

// Published links: an unguessable GUID -> one owned map. No copy of the map is
// stored here - the public view reads the live `maps` row, so edits show up on
// the link immediately and unpublishing is a single DELETE.
db.exec(`
  CREATE TABLE IF NOT EXISTS publications (
    guid     TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    map_id   TEXT NOT NULL,
    created  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_publications_map ON publications (owner_id, map_id);
`);

// The anonymous public view gets the same fields a #view= link carries - never
// owner bookkeeping or internal scratch keys.
function publicMapPayload(dataStr) {
  let m; try { m = JSON.parse(dataStr); } catch (e) { return null; }
  if (!m || typeof m !== 'object') return null;
  const out = { v: 1, title: m.title, color: m.color, style: m.style, layout: m.layout,
                rootId: m.rootId, nodes: m.nodes || {}, links: m.links || [], vars: m.vars || {} };
  for (const k of ['themeSize', 'layoutConfig', 'styleConfig', 'lookConfig', 'themeConfig'])
    if (m[k] !== undefined) out[k] = m[k];
  return out;
}

const Q = {
  list:   db.prepare('SELECT id, title, color, updated FROM maps WHERE owner_id = ? ORDER BY updated DESC'),
  get:    db.prepare('SELECT data FROM maps WHERE owner_id = ? AND id = ?'),
  ownsMap: db.prepare('SELECT 1 AS ok FROM maps WHERE owner_id = ? AND id = ?'),
  insert: db.prepare('INSERT INTO maps (owner_id,id,title,color,data,updated) VALUES (?,?,?,?,?,?)'),
  update: db.prepare('UPDATE maps SET title=?, color=?, data=?, updated=? WHERE owner_id = ? AND id = ?'),
  del:    db.prepare('DELETE FROM maps WHERE owner_id = ? AND id = ?'),
  // version history
  vLatest: db.prepare('SELECT ts, data FROM map_versions WHERE owner_id = ? AND id = ? ORDER BY ts DESC LIMIT 1'),
  vUpdate: db.prepare('UPDATE map_versions SET data = ? WHERE owner_id = ? AND id = ? AND ts = ?'),
  vInsert: db.prepare('INSERT OR REPLACE INTO map_versions (owner_id,id,ts,data) VALUES (?,?,?,?)'),
  vList:   db.prepare('SELECT ts FROM map_versions WHERE owner_id = ? AND id = ? ORDER BY ts DESC LIMIT 100'),
  vGet:    db.prepare('SELECT data FROM map_versions WHERE owner_id = ? AND id = ? AND ts = ?'),
  vDelOld: db.prepare('DELETE FROM map_versions WHERE owner_id = ? AND id = ? AND ts NOT IN (SELECT ts FROM map_versions WHERE owner_id = ? AND id = ? ORDER BY ts DESC LIMIT 50)'),
  vDelAll: db.prepare('DELETE FROM map_versions WHERE owner_id = ? AND id = ?'),
  // publications (anonymous read-only links)
  pubByGuid:  db.prepare('SELECT owner_id AS ownerId, map_id AS mapId FROM publications WHERE guid = ?'),
  pubForMap:  db.prepare('SELECT guid FROM publications WHERE owner_id = ? AND map_id = ? ORDER BY created ASC LIMIT 1'),
  pubInsert:  db.prepare('INSERT INTO publications (guid, owner_id, map_id, created) VALUES (?,?,?,?)'),
  pubDelMap:  db.prepare('DELETE FROM publications WHERE owner_id = ? AND map_id = ?'),
  pubDelGuid: db.prepare('DELETE FROM publications WHERE guid = ? AND owner_id = ?'),
  // users / sessions
  userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
  userById:   db.prepare('SELECT id, username, role, disabled FROM users WHERE id = ?'),
  userList:   db.prepare('SELECT id, username, role, created, disabled FROM users ORDER BY created ASC'),
  userInsert: db.prepare('INSERT INTO users (id,username,password_hash,role,created) VALUES (?,?,?,?,?)'),
  userCount:  db.prepare('SELECT COUNT(*) AS n FROM users'),
  sessionInsert: db.prepare('INSERT INTO sessions (token,user_id,created,expires) VALUES (?,?,?,?)'),
  sessionGet:    db.prepare('SELECT token, user_id AS userId, expires FROM sessions WHERE token = ?'),
  sessionDel:    db.prepare('DELETE FROM sessions WHERE token = ?'),
  sessionDelUser: db.prepare('DELETE FROM sessions WHERE user_id = ?')
};

// Resolve the signed-in user from the request cookie, or null. A disabled user
// or an expired session is treated as signed out (and the row is dropped).
function authUser(req) {
  const token = parseCookies(req)[COOKIE_NAME];
  if (!token) return null;
  const row = Q.sessionGet.get(token);
  if (!row) return null;
  if (row.expires && row.expires < Date.now()) { Q.sessionDel.run(token); return null; }
  const u = Q.userById.get(row.userId);
  if (!u || u.disabled) { Q.sessionDel.run(token); return null; }
  return { id: u.id, username: u.username, role: u.role };
}
// These answer the response themselves (401/403) and return null, so a route is
// `const u = requireAuth(req, res); if (!u) return;`.
function requireAuth(req, res) {
  const u = authUser(req);
  if (!u) { send(res, 401, { error: 'unauthorized' }); return null; }
  return u;
}
function requireAdmin(req, res) {
  const u = requireAuth(req, res);
  if (!u) return null;
  if (u.role !== 'admin') { send(res, 403, { error: 'forbidden' }); return null; }
  return u;
}

const upsert = (m, ownerId) => {
  const data = JSON.stringify(m);
  const updated = m.updated || Date.now();
  const r = Q.update.run(m.title || 'Untitled map', m.color || null, data, updated, ownerId, m.id);
  if (r.changes === 0) Q.insert.run(ownerId, m.id, m.title || 'Untitled map', m.color || null, data, updated);
  // Snapshot a version only when the content actually changed (skips no-op autosaves),
  // then prune to the most recent 50 per map. Saves within a minute of the newest
  // version refine that version instead of adding one: autosave runs after every
  // 0.6s pause in editing, so a version per save let the 50-version cap cover only
  // the last few minutes - and wrote a full copy of the map (images included) each time.
  const last = Q.vLatest.get(ownerId, m.id);
  if (!last || last.data !== data) {
    if (last && updated - last.ts < VERSION_WINDOW_MS) {
      Q.vUpdate.run(data, ownerId, m.id, last.ts);
    } else {
      Q.vInsert.run(ownerId, m.id, updated, data);
      Q.vDelOld.run(ownerId, m.id, ownerId, m.id);
    }
  }
};
const VERSION_WINDOW_MS = 60 * 1000;

// ---- map import (GPT integration) ---------------------------------------
const uid = () => Math.random().toString(36).slice(2, 9);

function buildMapFromSpec(spec) {
  if (!spec || typeof spec !== 'object') throw new Error('body must be a JSON object');
  const title = (typeof spec.title === 'string' && spec.title.trim()) ? spec.title.trim() : 'Imported map';
  const inNodes = Array.isArray(spec.nodes) ? spec.nodes : null;
  if (!inNodes || !inNodes.length) throw new Error('nodes[] is required and must be non-empty');
  const byId = new Map();
  for (const n of inNodes) {
    if (!n || typeof n.id !== 'string' || !n.id) throw new Error('every node needs a non-empty string id');
    if (byId.has(n.id)) throw new Error('duplicate node id: ' + n.id);
    if (typeof n.text !== 'string') throw new Error('node ' + n.id + ' is missing text');
    byId.set(n.id, n);
  }
  let rootId = (typeof spec.rootId === 'string' && spec.rootId) ? spec.rootId : null;
  if (rootId && !byId.has(rootId)) throw new Error('rootId does not match any node');
  if (!rootId) {
    const roots = inNodes.filter(n => n.parent == null);
    if (roots.length !== 1) throw new Error('exactly one root node (parent=null) required, found ' + roots.length);
    rootId = roots[0].id;
  }
  for (const n of inNodes) {
    if (n.id === rootId) continue;
    if (n.parent == null) throw new Error('node ' + n.id + ' has no parent (only the root may be parent-less)');
    if (!byId.has(n.parent)) throw new Error('node ' + n.id + ' references missing parent ' + n.parent);
    if (n.parent === n.id) throw new Error('node ' + n.id + ' is its own parent');
  }
  const N = byId.size;
  for (const n of inNodes) { let cur = n, hops = 0; while (cur && cur.id !== rootId) { cur = byId.get(cur.parent); if (++hops > N) throw new Error('cycle detected near node ' + n.id); } }
  const nodes = {};
  for (const n of inNodes) {
    const node = { id: n.id, text: String(n.text), parent: n.id === rootId ? null : n.parent,
      x: 0, y: 0, side: n.id === rootId ? 'root' : null, color: (typeof n.color === 'string' && n.color) ? n.color : '#fff' };
    if (typeof n.notes === 'string' && n.notes.trim()) node.notes = n.notes;
    if (n.collapsed === true) node.collapsed = true;
    if (n.tag != null && n.tag !== '') node.tag = String(n.tag);
    // Everything from here to the layoutConfig block mirrors
    // worker/import-core.js buildMapFromSpec() field for field - a spec must
    // import the same through the self-hosted server as through the Worker
    // (test/server-http.test.mjs compares the two).
    if (n.listType === 'ul' || n.listType === 'ol') { node.listType = n.listType; node.align = node.align || 'left'; }
    if (n.bold === true) node.bold = true;
    if (n.italic === true) node.italic = true;
    if (n.highlight === true) node.highlight = true;
    if (n.align === 'left' || n.align === 'center' || n.align === 'right') node.align = n.align;
    if (n.task === 'done' || n.task === 'todo') node.task = n.task;
    if (typeof n.marker === 'string') {
      const mk = n.marker.trim();
      if (mk && [...mk].length <= 2) node.marker = mk;
    }
    if (n.citation && typeof n.citation === 'object') {
      const c = n.citation, cit = {};
      if (Array.isArray(c.authors) && c.authors.length) cit.authors = c.authors.join(', ');
      else if (typeof c.authors === 'string' && c.authors.trim()) cit.authors = c.authors.trim();
      if (c.year != null) cit.year = c.year;
      if (typeof c.title === 'string' && c.title.trim()) cit.title = c.title.trim();
      if (typeof c.source === 'string' && c.source.trim()) cit.source = c.source.trim();
      if (typeof c.doi === 'string' && c.doi.trim()) cit.doi = c.doi.trim();
      else if (typeof c.arxiv === 'string' && c.arxiv.trim()) { cit.doi = 'arXiv:' + c.arxiv.trim(); if (!cit.source) cit.source = 'arXiv'; }
      if (Object.keys(cit).length) { node.citation = cit; node.ref = true; }
    }
    nodes[n.id] = node;
  }
  // Balance root branches like balanceRootSides(): first half right, second half left.
  const rootKids = inNodes.filter(n => n.id !== rootId && n.parent === rootId).map(n => n.id);
  const half = Math.ceil(rootKids.length / 2);
  rootKids.forEach((id, i) => { nodes[id].side = (i < half) ? 'right' : 'left'; });
  const links = Array.isArray(spec.links)
    ? spec.links.filter(l => l && byId.has(l.from) && byId.has(l.to))
                .map(l => { const o = { from: l.from, to: l.to }; if (l.label != null && l.label !== '') o.label = String(l.label); return o; })
    : [];
  const out = { id: uid(), title, titleAuto: false, color: (typeof spec.color === 'string' && spec.color) ? spec.color : '#e0613a',
           layout: 'balanced', rootId, nodes, links, _import: true, updated: Date.now() };
  // Layout knobs, bounded rather than trusted (same rules as the Worker).
  if (spec.layoutConfig && typeof spec.layoutConfig === 'object' && !Array.isArray(spec.layoutConfig)) {
    const t = spec.layoutConfig.timeline;
    if (t && typeof t === 'object' && !Array.isArray(t)) {
      const tl = {}, bounds = { gap: [8, 400], stem: [0, 300], indent: [0, 300] };
      for (const k of ['gap', 'stem', 'indent']) {
        if (typeof t[k] === 'number' && isFinite(t[k])) tl[k] = Math.min(bounds[k][1], Math.max(bounds[k][0], Math.round(t[k])));
      }
      if (typeof t.alternate === 'boolean') tl.alternate = t.alternate;
      if (t.start === 'above' || t.start === 'below') tl.start = t.start;
      if (Object.keys(tl).length) out.layoutConfig = { timeline: tl };
    }
  }
  return out;
}

// ---- extra Content-Security-Policy origins --------------------------------
// EXTRA_CONNECT_SRC="http://localhost:11434 https://api.mistral.ai" lets a
// self-hoster allow the origins of custom LLM providers (added in Preferences)
// without editing this file. It is appended to connect-src in BOTH places the
// browser reads a policy from: the response header below and the <meta> tag
// inside index.html, because the browser enforces the intersection of the two
// and a header alone would leave the meta blocking the request. Appending only
// (never replacing) keeps the allowlist an allowlist.
const EXTRA_CONNECT = (process.env.EXTRA_CONNECT_SRC || '').trim().split(/\s+/).filter(o => /^https?:\/\/[^\s'"<>]+$/.test(o)).join(' ');
const withExtraConnect = (policy) => EXTRA_CONNECT ? policy.replace(/(connect-src [^;"]+)/, '$1 ' + EXTRA_CONNECT) : policy;
// The page version targets the <meta> tag itself: index.html also mentions
// connect-src in the comment that explains the policy, and that must stay.
const withExtraConnectHtml = (html) => EXTRA_CONNECT
  ? html.replace(/(<meta http-equiv="Content-Security-Policy" content="[^"]*?connect-src [^;"]+)/, '$1 ' + EXTRA_CONNECT)
  : html;
// A published map lives at /public/<guid>, one level below the app root.
// Without a base the browser resolves ./styles.css, ./templates.js and ./app.js
// under /public/ and the static handler answers 404. Inject the base into the
// document itself rather than from JS: the preload scanner has to see it before
// it resolves those URLs. Static deployments at a sub-path never take this route.
const withPublicBase = (html) => html.replace(/<head[^>]*>/i, m => m + '<base href="/">');

// ---- tiny helpers --------------------------------------------------------
const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css',
  '.json':'application/json', '.svg':'image/svg+xml', '.png':'image/png', '.ico':'image/x-icon',
  '.webmanifest':'application/manifest+json' };
// Response types worth gzipping - every text-ish MIME above, and nothing that
// is already compressed (png/ico). This Set is the decision: it used to sit here
// as a list of file EXTENSIONS that nothing read, beside a hand-rolled MIME
// substring match that made the real call, so editing it did nothing.
const COMPRESSIBLE = new Set([
  'text/html', 'text/javascript', 'text/css',
  'application/json', 'image/svg+xml', 'application/manifest+json',
]);
const GZIP_MIN = 1024;   // below this, the gzip header costs more than it saves
// `entry` is an optional file-cache row; when present its gzip is computed once
// and reused, instead of re-running gzipSync on every request for bytes that
// have not changed. API responses pass nothing and still compress per response,
// which is correct - they are generated fresh each time.
const send = (res, code, body, type='application/json', req, entry) => {
  const raw = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  const accept = req && req.headers && req.headers['accept-encoding'] || '';
  if(buf.length>GZIP_MIN && accept.includes('gzip') && COMPRESSIBLE.has(type)){
    try{
      const gz = entry
        ? (entry.gz !== undefined ? entry.gz : (entry.gz = zlib.gzipSync(buf)))
        : zlib.gzipSync(buf);
      if(gz.length < buf.length){
        res.writeHead(code, { 'Content-Type': type, 'Content-Encoding': 'gzip', 'Vary': 'Accept-Encoding', 'Content-Length': gz.length });
        return res.end(gz);
      }
    }catch(e){}
  }
  res.writeHead(code, { 'Content-Type': type, 'Content-Length': buf.length });
  res.end(buf);
};
// A map body has to be a JSON object. `m.id = id` on a number or null is
// silently ignored (or throws), and upsert() would then store the literal,
// which breaks the next list load on the client.
const isMapBody = (m) => !!m && typeof m === 'object' && !Array.isArray(m);
// Chunks are kept as bytes and decoded once at the end: `str += chunk` decodes
// each chunk on its own, so any multi-byte character (emoji, Devanagari, CJK)
// that straddles a chunk boundary came out as two U+FFFD - silent corruption
// of every non-ASCII map bigger than one ~64 KB chunk.
const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = []; let size = 0;
  req.on('data', c => {
    size += c.length;
    if (size > 8e6) { req.destroy(); reject(new Error('payload too large')); return; }
    chunks.push(c);
  });
  req.on('end', () => {
    const d = Buffer.concat(chunks).toString('utf8');
    try { resolve(d ? JSON.parse(d) : {}); }
    catch (e) { e.status = 400; reject(e); }   // the client's mistake, not a server error
  });
  req.on('error', reject);
});

// ---- static file cache ----------------------------------------------------
// app.js is ~670 KB and every page load re-reads it from disk. Keep file bytes
// in memory, invalidated by mtime so live edits during `node --watch` dev are
// still picked up. Client-facing Cache-Control headers are untouched, so the
// freshness semantics the service worker depends on don't change.
//
// The row also carries the gzipped bytes, filled in by send() the first time a
// client asks for them. Compressing on every request cost ~16 ms of blocking CPU
// per cold page load (app.js 11.9, styles.css 3.2, templates.js 0.6, index 0.2)
// - and gzipSync is synchronous, so on one thread that stalls every other
// request in flight. An mtime change replaces the row, so `gz` can never go
// stale against `data`.
const fileCache = new Map();
function fileEntry(full, stat) {
  const hit = fileCache.get(full);
  if (hit && hit.mtimeMs === stat.mtimeMs) return hit;
  if (fileCache.size >= 256) fileCache.clear();
  const row = { mtimeMs: stat.mtimeMs, data: fs.readFileSync(full), gz: undefined };
  fileCache.set(full, row);
  return row;
}

// ---- server --------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  // Baseline security headers on every response.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  // Defense-in-depth CSP. Permits everything the app actually uses (self,
  // inline styles/script for the bootstrap, Google Fonts, data:/blob: images,
  // and the GitHub API for cloud mode) while blocking external script/exfil
  // origins, framing, and plugins. Relax if you self-host extra integrations.
  //
  // This header only covers server mode. The static deployments can't send
  // headers, so the same policy is duplicated in public/index.html (<meta>) and
  // public/_headers - and test/csp.test.mjs fails if the three drift apart.
  // The only sanctioned difference: the static copies also allow the OAuth /
  // collab Worker origin, which server mode never contacts.
  res.setHeader('Content-Security-Policy', withExtraConnect([
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob: https://avatars.githubusercontent.com https://icons.duckduckgo.com",
    "connect-src 'self' https://api.github.com https://codeberg.org https://gitea.com https://gitlab.com https://api.crossref.org https://api.anthropic.com https://api.openai.com https://openrouter.ai https://api.groq.com https://api.quotable.io https://zenquotes.io https://favqs.com https://dummyjson.com https://quoteslate.vercel.app https://stoic.tekloon.net https://type.fit https://api.freeapi.app https://words.dev-apis.com https://random-word-api.herokuapp.com https://random-words-api.vercel.app https://api.datamuse.com https://api.urbandictionary.com https://wordoftheday.freeapi.me https://api.wotd.site",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ].join('; ')));

  try {
    // ----- auth -----
    if (p === '/api/auth/me' && req.method === 'GET') {
      const u = authUser(req);
      return u ? send(res, 200, { user: u }) : send(res, 401, { error: 'unauthorized' });
    }

    if (p === '/api/auth/login' && req.method === 'POST') {
      const body = await readBody(req);
      const username = (typeof body.username === 'string') ? body.username.trim() : '';
      const password = (typeof body.password === 'string') ? body.password : '';
      const row = username ? Q.userByName.get(username) : null;
      // Verify against a dummy hash when the user is unknown, so a wrong username
      // and a wrong password take the same time (no account enumeration).
      const ok = row && !row.disabled
        ? verifyPassword(password, row.password_hash)
        : (verifyPassword(password, 'scrypt$00$00'), false);
      if (!ok) return send(res, 401, { error: 'invalid username or password' });
      const token = crypto.randomBytes(32).toString('base64url');
      const now = Date.now();
      Q.sessionInsert.run(token, row.id, now, now + SESSION_TTL_MS);
      res.setHeader('Set-Cookie', cookieHeader(token, req, Math.floor(SESSION_TTL_MS / 1000)));
      return send(res, 200, { user: { id: row.id, username: row.username, role: row.role } });
    }

    if (p === '/api/auth/logout' && req.method === 'POST') {
      const token = parseCookies(req)[COOKIE_NAME];
      if (token) Q.sessionDel.run(token);
      res.setHeader('Set-Cookie', cookieHeader('', req, 0));
      res.writeHead(204); return res.end();
    }

    // ----- admin: user management -----
    if (p === '/api/admin/users' && req.method === 'GET') {
      const admin = requireAdmin(req, res); if (!admin) return;
      return send(res, 200, Q.userList.all());
    }
    if (p === '/api/admin/users' && req.method === 'POST') {
      const admin = requireAdmin(req, res); if (!admin) return;
      const body = await readBody(req);
      const username = (typeof body.username === 'string') ? body.username.trim() : '';
      const password = (typeof body.password === 'string') ? body.password : '';
      const role = body.role === 'admin' ? 'admin' : 'user';
      if (!/^[A-Za-z0-9._@-]{3,32}$/.test(username))
        return send(res, 400, { error: 'username must be 3-32 characters (letters, digits, . _ @ -)' });
      if (password.length < 8) return send(res, 400, { error: 'password must be at least 8 characters' });
      if (Q.userByName.get(username)) return send(res, 409, { error: 'that username is already taken' });
      const id = crypto.randomUUID();
      Q.userInsert.run(id, username, hashPassword(password), role, Date.now());
      return send(res, 201, { id, username, role });
    }

    // ----- maps (owner-scoped: every route answers for the signed-in user only) -----
    if (p === '/api/maps' && req.method === 'GET') {
      const u = requireAuth(req, res); if (!u) return;
      return send(res, 200, Q.list.all(u.id));
    }

    if (p === '/api/maps' && req.method === 'POST') {
      const u = requireAuth(req, res); if (!u) return;
      const m = await readBody(req);
      if (!isMapBody(m)) return send(res, 400, { error: 'body must be a JSON object' });
      if (!m.id) return send(res, 400, { error: 'missing map id' });
      upsert(m, u.id); return send(res, 201, { ok: true, id: m.id });
    }

    if (p === '/api/import' && req.method === 'POST') {
      // Accepts the machine IMPORT_TOKEN (GPT integration) OR a signed-in user.
      // A token import has no user, so the map is filed under the administrator.
      const bearerOk = !!process.env.IMPORT_TOKEN && req.headers.authorization === 'Bearer ' + process.env.IMPORT_TOKEN;
      const u = bearerOk ? null : authUser(req);
      if (!bearerOk && !u) return send(res, 401, { error: 'unauthorized' });
      const owner = u ? u.id : ADMIN_ID;
      if (!owner) return send(res, 501, { error: 'no owner available for the import - set ADMIN_USER/ADMIN_PASSWORD' });
      const spec = await readBody(req);
      let m;
      try { m = buildMapFromSpec(spec); }
      catch (e) { return send(res, 400, { error: String(e && e.message || e) }); }
      upsert(m, owner);
      const proto = req.headers['x-forwarded-proto'] || 'http';
      const host = req.headers['x-forwarded-host'] || req.headers.host || ('localhost:' + PORT);
      return send(res, 201, { id: m.id, url: `${proto}://${host}/?map=${m.id}` });
    }

    const idMatch = p.match(/^\/api\/maps\/([\w-]+)$/);
    if (idMatch) {
      const u = requireAuth(req, res); if (!u) return;
      const id = idMatch[1];
      if (req.method === 'GET') {
        const row = Q.get.get(u.id, id);
        return row ? send(res, 200, row.data, 'application/json') : send(res, 404, { error: 'not found' });
      }
      if (req.method === 'PUT') {
        const m = await readBody(req);
        if (!isMapBody(m)) return send(res, 400, { error: 'body must be a JSON object' });
        m.id = id; upsert(m, u.id);
        return send(res, 200, { ok: true, id });
      }
      if (req.method === 'DELETE') { Q.del.run(u.id, id); Q.vDelAll.run(u.id, id); Q.pubDelMap.run(u.id, id); res.writeHead(204); return res.end(); }
    }

    // ----- version history -----
    const vListMatch = p.match(/^\/api\/maps\/([\w-]+)\/versions$/);
    if (vListMatch && req.method === 'GET') {
      const u = requireAuth(req, res); if (!u) return;
      if (!Q.ownsMap.get(u.id, vListMatch[1])) return send(res, 404, { error: 'not found' });
      return send(res, 200, Q.vList.all(u.id, vListMatch[1]).map(r => ({ ts: r.ts })));
    }
    const vGetMatch = p.match(/^\/api\/maps\/([\w-]+)\/versions\/(\d+)$/);
    if (vGetMatch && req.method === 'GET') {
      const u = requireAuth(req, res); if (!u) return;
      const row = Q.vGet.get(u.id, vGetMatch[1], Number(vGetMatch[2]));
      return row ? send(res, 200, row.data, 'application/json') : send(res, 404, { error: 'not found' });
    }

    // ----- published (anonymous read-only) links -----
    // Publishing is idempotent: a map keeps the same GUID until it is unpublished,
    // so re-opening the dialog never mints a second link.
    const pubMatch = p.match(/^\/api\/maps\/([\w-]+)\/publish$/);
    if (pubMatch) {
      const u = requireAuth(req, res); if (!u) return;
      const id = pubMatch[1];
      if (!Q.ownsMap.get(u.id, id)) return send(res, 404, { error: 'not found' });
      // Return a path, not an absolute URL: behind a reverse proxy the server
      // may only see an upstream IP, while the browser knows the public domain.
      // The client resolves this against the origin the user actually visited.
      const urlOf = (guid) => `/public/${guid}`;
      if (req.method === 'GET') {
        const row = Q.pubForMap.get(u.id, id);
        return send(res, 200, row
          ? { published: true, guid: row.guid, url: urlOf(row.guid) }
          : { published: false });
      }
      if (req.method === 'POST') {
        let row = Q.pubForMap.get(u.id, id);
        if (!row) { const guid = crypto.randomUUID(); Q.pubInsert.run(guid, u.id, id, Date.now()); row = { guid }; }
        return send(res, 200, { guid: row.guid, url: urlOf(row.guid) });
      }
      if (req.method === 'DELETE') {
        const row = Q.pubForMap.get(u.id, id);
        if (row) Q.pubDelGuid.run(row.guid, u.id);
        res.writeHead(204); return res.end();
      }
    }

    // The published map itself: no auth. The unguessable GUID is the capability,
    // and the row is resolved against the live map on every request.
    const pubGet = p.match(/^\/api\/public\/([\w-]+)$/);
    if (pubGet && req.method === 'GET') {
      const row = Q.pubByGuid.get(pubGet[1]);
      const m = row && Q.get.get(row.ownerId, row.mapId);
      const payload = m ? publicMapPayload(m.data) : null;
      if (!payload) return send(res, 404, { error: 'not found' });
      res.setHeader('Cache-Control', 'no-cache');
      return send(res, 200, payload, 'application/json');
    }

    // Public: the deployment-mode probe the client uses before it knows anything.
    if (p === '/healthz') return send(res, 200, { ok: true });

    // ----- static files -----
    // A published link (/public/<guid>) is an SPA page: serve the app shell, which
    // reads the GUID from location.pathname and fetches /api/public/<guid>.
    const pubPage = p.match(/^\/public\/[\w-]+\/?$/);
    let file = (p === '/' || (pubPage && req.method === 'GET')) ? '/index.html' : p;
    const full = path.join(PUBLIC, path.normalize(file).replace(/^(\.\.[/\\])+/, ''));
    // Prefix check with a trailing separator so a sibling directory like
    // "<PUBLIC>-evil" can never satisfy the check (defense in depth).
    if (full === PUBLIC || full.startsWith(PUBLIC + path.sep)) {
      let st = null;
      try { st = fs.statSync(full); } catch (e) { /* falls through to 404 */ }
      if (st && st.isFile()) {
        const entry = fileEntry(full, st);
        const isHtml = path.extname(full) === '.html';
        // The page's own <meta> policy gets the same extra origins as the
        // header, and a published page also gets a <base> so its relative asset
        // and API URLs resolve at the app root. Keep the public variant separate
        // from the root page's cached HTML.
        const publicShell = isHtml && !!pubPage;
        const rewritten = isHtml && (publicShell || !!EXTRA_CONNECT);
        const variant = publicShell ? 'publicHtml' : 'html';
        if (rewritten && entry[variant] === undefined) {
          let html = entry.data.toString('utf8');
          if (publicShell) html = withPublicBase(html);
          if (EXTRA_CONNECT) html = withExtraConnectHtml(html);
          entry[variant] = Buffer.from(html);
        }
        const body = rewritten ? entry[variant] : entry.data;
        // `no-cache` still forces a round trip before anything is reused, which
        // is the invariant sw.js is built around: app.js and styles.css keep
        // their URLs forever, so a client must never serve an old build off its
        // own shelf. `no-store` went further and forbade keeping the bytes at
        // all, which made that round trip a full re-download of ~360 KB
        // gzipped on every single load. With a validator the same round trip
        // answers 304 and sends nothing, so freshness is unchanged and only
        // the bytes go away. Weak, because the gzipped and identity encodings
        // of one file are the same thing semantically and share the tag.
        const key = rewritten ? variant + 'Etag' : 'etag';
        if (entry[key] === undefined) {
          entry[key] = 'W/"' + crypto.createHash('sha1').update(body).digest('base64url') + '"';
        }
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('ETag', entry[key]);
        if (req.headers['if-none-match'] === entry[key]) {
          res.writeHead(304);
          return res.end();
        }
        if (rewritten) return send(res, 200, body, MIME['.html'], req);
        return send(res, 200, body, MIME[path.extname(full)] || 'application/octet-stream', req, entry);
      }
    }

    // If the frontend itself is missing, explain it instead of a cryptic 404.
    if (!fs.existsSync(path.join(PUBLIC, 'index.html'))) {
      return send(res, 500, `<!doctype html><meta charset=utf-8>
        <style>body{font-family:system-ui;max-width:640px;margin:60px auto;padding:0 24px;line-height:1.6;color:#23201b}
        code{background:#f0ece3;padding:2px 6px;border-radius:5px}h1{color:#b8451f}</style>
        <h1>Frontend files not found</h1>
        <p>The server is running, but it can't find the <code>public/</code> folder with the app's files.</p>
        <p>It looked here:<br><code>${PUBLIC}</code></p>
        <p><b>Fix:</b> make sure a <code>public</code> folder (containing <code>index.html</code>,
        <code>app.js</code>, <code>styles.css</code>) sits right next to <code>server.js</code>,
        then run <code>node server.js</code> again from that folder. Re-extracting the zip usually resolves it.</p>`,
        'text/html');
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, (e && e.status) || 500, { error: String(e && e.message || e) });
  }
});

// A port already in use used to crash with a raw stack trace (and the desktop
// launcher had already told the browser to open). Say what happened instead.
server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use - is MindSpark already running?`);
    console.error(`  Open http://localhost:${PORT}, or start on another port: PORT=3001 node server.js\n`);
    process.exit(1);
  }
  throw e;
});
// The launcher waits for 'listening' before it opens a browser.
module.exports = server;

server.listen(PORT, () => {
  console.log(`\n  MindSpark running → http://localhost:${PORT}`);
  console.log(`  Database          → ${DB_PATH}`);
  const ok = fs.existsSync(path.join(PUBLIC, 'index.html'));
  console.log(`  Frontend          → ${PUBLIC}  ${ok ? '✓ found' : '✗ NOT FOUND'}`);
  if (!ok) {
    console.log(`\n  ⚠  public/index.html was not found at the path above.`);
    console.log(`     Make sure the "public" folder is next to server.js, then restart.`);
  }
  console.log(`  (zero dependencies - Node built-in HTTP + SQLite)\n`);
});
