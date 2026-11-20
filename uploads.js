/**
 * MindSpark - uploaded image files.
 *
 * Zero dependencies: node builtins only. Wired into server.js by injecting the
 * database, the response helper and the auth guard, so this module owns the
 * `uploads` table, the files on disk and the /api/files + /files routes.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_MAX_BYTES = 8e6;
const NAME_RE = /^[0-9a-f]{32}\.(png|jpg|webp|gif|avif)$/;
const IMAGE_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', avif: 'image/avif' };
const INCOMING = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif']);

let state = null;

// The extension always comes from the bytes, never from the client: the
// Content-Type header only has to agree with what the file really is.
function sniff(buf) {
  if (!buf || buf.length < 3) return null;
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
    && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) {
    return { mime: 'image/png', ext: 'png' };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buf.length >= 6) {
    const gif = buf.toString('latin1', 0, 6);
    if (gif === 'GIF87a' || gif === 'GIF89a') return { mime: 'image/gif', ext: 'gif' };
  }
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF'
    && buf.toString('latin1', 8, 12) === 'WEBP') {
    return { mime: 'image/webp', ext: 'webp' };
  }
  // AVIF is an ISO-BMFF file: an `ftyp` box whose major or compatible brand is
  // avif/avis (mif1 is also a common major brand for AVIF images).
  if (buf.length >= 16 && buf.toString('latin1', 4, 8) === 'ftyp') {
    const end = Math.min(buf.length - 3, 64);
    for (let i = 8; i < end; i += 4) {
      const brand = buf.toString('latin1', i, i + 4);
      if (brand === 'avif' || brand === 'avis') return { mime: 'image/avif', ext: 'avif' };
    }
  }
  return null;
}

function mimeForExt(ext) {
  return IMAGE_MIME[String(ext || '').toLowerCase().replace(/^\./, '')] || 'application/octet-stream';
}

// Raw binary body reader. Deliberately not readBody() from server.js: that one
// parses JSON and is capped at 8 MB. Once the cap is crossed the rest of the
// stream is drained so the 413 can actually leave the socket.
function readBinary(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', c => {
      if (tooLarge) return;
      size += c.length;
      if (size > limit) { tooLarge = true; chunks.length = 0; req.resume(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(tooLarge ? { tooLarge: true } : { buf: Buffer.concat(chunks) }));
    req.on('error', reject);
  });
}

function init({ db, dir, send, requireAuth, maxBytes }) {
  fs.mkdirSync(dir, { recursive: true });
  db.exec(`
    CREATE TABLE IF NOT EXISTS uploads (
      name     TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      mime     TEXT NOT NULL,
      size     INTEGER NOT NULL,
      sha256   TEXT,
      created  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_uploads_owner ON uploads(owner_id);
  `);
  state = {
    db, dir, send, requireAuth,
    maxBytes: Number(maxBytes) || DEFAULT_MAX_BYTES,
    insert: db.prepare('INSERT INTO uploads (name,owner_id,mime,size,sha256,created) VALUES (?,?,?,?,?,?)'),
    get: db.prepare('SELECT name, owner_id AS ownerId, mime, size FROM uploads WHERE name = ?'),
    delOwned: db.prepare('DELETE FROM uploads WHERE name = ? AND owner_id = ?')
  };
}

async function handle(req, res, pathname) {
  if (!state) return false;
  const s = state;

  // ----- upload (signed in only) -----
  if (pathname === '/api/files' && req.method === 'POST') {
    const u = s.requireAuth(req, res);
    if (!u) { req.resume(); return true; }
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!INCOMING.has(type)) {
      req.resume();
      s.send(res, 415, { error: 'unsupported image type' });
      return true;
    }
    const declared = Number(req.headers['content-length']);
    if (declared > s.maxBytes) {
      req.resume();
      s.send(res, 413, { error: 'payload too large' });
      return true;
    }
    const { buf, tooLarge } = await readBinary(req, s.maxBytes);
    if (tooLarge) { s.send(res, 413, { error: 'payload too large' }); return true; }
    const kind = sniff(buf);
    if (!kind || kind.mime !== type) { s.send(res, 415, { error: 'unsupported image type' }); return true; }
    const name = crypto.randomBytes(16).toString('hex') + '.' + kind.ext;
    const full = path.join(s.dir, name);
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    fs.writeFileSync(full, buf);
    try {
      s.insert.run(name, u.id, kind.mime, buf.length, sha256, Date.now());
    } catch (e) {
      try { fs.unlinkSync(full); } catch (_) { /* best effort */ }
      throw e;
    }
    s.send(res, 201, { url: '/files/' + name, id: name, size: buf.length, mime: kind.mime });
    return true;
  }

  // ----- serve (public: published maps and anonymous share links) -----
  const fm = pathname.match(/^\/files\/([^/]+)$/);
  if (fm && req.method === 'GET') {
    const name = fm[1];
    if (!NAME_RE.test(name)) { s.send(res, 404, { error: 'not found' }); return true; }
    const full = path.join(s.dir, name);
    let st;
    try { st = fs.statSync(full); } catch (e) { s.send(res, 404, { error: 'not found' }); return true; }
    if (!st.isFile()) { s.send(res, 404, { error: 'not found' }); return true; }
    const etag = '"' + st.size.toString(16) + '-' + Math.floor(st.mtimeMs).toString(16) + '"';
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('ETag', etag);
    const inm = req.headers['if-none-match'];
    if (inm && inm.split(',').some(t => t.trim() === etag)) { res.writeHead(304); res.end(); return true; }
    let data;
    try { data = fs.readFileSync(full); } catch (e) { s.send(res, 404, { error: 'not found' }); return true; }
    s.send(res, 200, data, mimeForExt(path.extname(name)), req);
    return true;
  }

  // ----- delete (owner only; anyone else gets the same 404 as a missing file) -----
  const dm = pathname.match(/^\/api\/files\/([^/]+)$/);
  if (dm && req.method === 'DELETE') {
    const u = s.requireAuth(req, res);
    if (!u) return true;
    const name = dm[1];
    if (!NAME_RE.test(name)) { s.send(res, 404, { error: 'not found' }); return true; }
    const row = s.get.get(name);
    if (!row || row.ownerId !== u.id) { s.send(res, 404, { error: 'not found' }); return true; }
    try { fs.unlinkSync(path.join(s.dir, name)); } catch (e) { /* row may outlive its file */ }
    s.delOwned.run(name, u.id);
    s.send(res, 200, { ok: true });
    return true;
  }

  return false;
}

module.exports = { init, handle, mimeForExt };
