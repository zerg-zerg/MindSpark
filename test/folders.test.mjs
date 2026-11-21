// The data layer behind the sidebar's folders. Membership lives on the map
// itself (`map.folder`, a plain name; absent or empty means unfiled) so it
// travels with every save, export and version. The registry of folder NAMES -
// display order, including empty folders, plus which are collapsed - lives in
// localStorage under mindspark:folders. These tests pin the helpers, the three
// mutations that file / rename / unfile, and the CloudStore index mirroring
// that keeps a folder visible in the map list without a full download.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadFns } from './helpers/load-app-fns.mjs';

// Normalize line endings: this file slices source around exact strings, and a
// Windows checkout hands us CRLF even though the committed file is LF.
const SRC = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function storage(initial) {
  const store = new Map(Object.entries(initial || {}));
  return {
    store,
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
  };
}

// console.warn is the app's required signal for a swallowed-but-real failure;
// the tests below assert it was said.
function captureWarn() {
  const warns = [];
  const original = console.warn;
  console.warn = (...a) => { warns.push(a.join(' ')); };
  return { warns, done() { console.warn = original; } };
}

// A Store, a registry and the open-map binding to drive the lifted mutations.
// `maps` doubles as the store contents: get finds among them, saves are
// recorded, and the objects themselves are what the mutations touch - like the
// store, which hands back whole map documents.
function harness(opts = {}) {
  const ls = opts.ls || storage();
  const maps = opts.maps || [];
  const saved = [];
  const removed = [];
  const toasts = [];
  const refreshes = { n: 0 };
  const Store = {
    list: async () => { if (opts.failList) throw opts.failList; return maps; },
    get: async id => maps.find(m => m.id === id) || null,
    save: async m => { if (opts.failSave) throw opts.failSave; saved.push(m); },
    remove: async id => { removed.push(id); },
  };
  const fns = loadFns(
    ['loadFolderPrefs', 'saveFolderPrefs', 'folderNames', 'setMapFolder', 'renameFolder', 'deleteFolder'],
    { localStorage: ls, Store, toast: t => toasts.push(t), refreshList: () => { refreshes.n++; }, map: opts.map || null, READONLY: !!opts.readonly });
  return { ...fns, ls, maps, saved, removed, toasts, refreshes };
}

describe('folder registry', () => {
  test('nothing stored reads as empty order and collapsed', () => {
    const h = harness();
    assert.deepEqual(h.loadFolderPrefs(), { order: [], collapsed: [] });
    assert.deepEqual(h.folderNames([]), []);
  });

  test('save then load round-trips order and collapsed', () => {
    const h = harness();
    h.saveFolderPrefs({ order: ['Work', 'Ideas'], collapsed: ['Ideas'] });
    assert.deepEqual(JSON.parse(h.ls.store.get('mindspark:folders')), { order: ['Work', 'Ideas'], collapsed: ['Ideas'] });
    assert.deepEqual(h.loadFolderPrefs(), { order: ['Work', 'Ideas'], collapsed: ['Ideas'] });
  });

  test('garbage JSON is tolerated: empty registry, a warning, no throw', () => {
    const cap = captureWarn();
    try {
      const h = harness({ ls: storage({ 'mindspark:folders': '{not json' }) });
      assert.deepEqual(h.loadFolderPrefs(), { order: [], collapsed: [] });
      assert.ok(cap.warns.length >= 1, 'a broken registry must be said, not swallowed');
    } finally { cap.done(); }
  });

  test('valid JSON of the wrong shape reads as an empty registry without fuss', () => {
    const cap = captureWarn();
    try {
      for (const junk of ['[1,2]', '"text"', '5', 'null']) {
        const h = harness({ ls: storage({ 'mindspark:folders': junk }) });
        assert.deepEqual(h.loadFolderPrefs(), { order: [], collapsed: [] }, junk);
      }
    } finally { cap.done(); }
  });

  test('non-string entries and duplicates are dropped, empty/whitespace names never survive', () => {
    const h = harness({ ls: storage({ 'mindspark:folders': JSON.stringify({ order: ['A', 7, null, 'A', ' ', 'B'], collapsed: ['B', 'B', 'x'] }) }) });
    assert.deepEqual(h.loadFolderPrefs(), { order: ['A', 'B'], collapsed: ['B', 'x'] });
  });
});

describe('folderNames', () => {
  test('registry order first, newly discovered names after, in list order', () => {
    const h = harness({ ls: storage({ 'mindspark:folders': JSON.stringify({ order: ['B', 'A'], collapsed: [] }) }) });
    const idx = [{ id: '1', folder: 'C' }, { id: '2', folder: 'A' }];
    assert.deepEqual(h.folderNames(idx), ['B', 'A', 'C']);
  });

  test('an empty folder survives: registered with no member map', () => {
    const h = harness({ ls: storage({ 'mindspark:folders': JSON.stringify({ order: ['Empty', 'Used'], collapsed: [] }) }) });
    const idx = [{ id: '1', folder: 'Used' }];
    assert.deepEqual(h.folderNames(idx), ['Empty', 'Used']);
  });

  test('names are deduped across registry and list', () => {
    const h = harness({ ls: storage({ 'mindspark:folders': JSON.stringify({ order: ['A'], collapsed: [] }) }) });
    const idx = [{ id: '1', folder: 'A' }, { id: '2', folder: 'A' }];
    assert.deepEqual(h.folderNames(idx), ['A']);
  });

  test('empty, whitespace-only and missing folder values are rejected', () => {
    const h = harness();
    const idx = [{ id: '1', folder: '' }, { id: '2', folder: '   ' }, { id: '3' }];
    assert.deepEqual(h.folderNames(idx), []);
  });
});

describe('setMapFolder', () => {
  test('files a closed map through the store and refreshes the list', async () => {
    const m = { id: 'm1', title: 'T' };
    const h = harness({ maps: [m] });
    await h.setMapFolder('m1', 'Work');
    assert.equal(m.folder, 'Work');
    assert.deepEqual(h.saved, [m]);
    assert.equal(h.refreshes.n, 1);
    assert.deepEqual(h.toasts, []);
  });

  test('filing where the map already is saves nothing and does not bump updated', async () => {
    const m = { id: 'm1', folder: 'Work' };
    const h = harness({ maps: [m] });
    await h.setMapFolder('m1', ' Work ');   // trimmed to the same name
    assert.deepEqual(h.saved, []);
    assert.equal(h.refreshes.n, 0);
    await h.setMapFolder('m1', 'Work');
    assert.deepEqual(h.saved, []);
  });

  test('unfiling deletes the key (absent, not an empty string)', async () => {
    const m = { id: 'm1', folder: 'Work' };
    const h = harness({ maps: [m] });
    await h.setMapFolder('m1', '');
    assert.ok(!('folder' in m), 'unfiled means the key is gone');
    assert.deepEqual(h.saved, [m]);
    await h.setMapFolder('m1', null);       // already unfiled: no save
    assert.deepEqual(h.saved, [m]);
  });

  test('the open map is mutated in place and saved by identity', async () => {
    const m = { id: 'm1' };
    const h = harness({ maps: [{ ...m }], map: m });
    await h.setMapFolder('m1', 'Work');
    assert.equal(m.folder, 'Work', 'the in-memory map carries the folder at once');
    assert.deepEqual(h.saved, [m]);
  });

  test('a save failure is toasted and skips the refresh, like togglePin', async () => {
    const h = harness({ maps: [{ id: 'm1' }], failSave: new Error('HTTP 502') });
    await h.setMapFolder('m1', 'Work');
    assert.equal(h.toasts.length, 1);
    assert.match(h.toasts[0], /Could not move the map/);
    assert.equal(h.refreshes.n, 0);
  });

  test('a map that cannot be found is a quiet no-op', async () => {
    const h = harness({ maps: [] });
    await h.setMapFolder('ghost', 'Work');
    assert.deepEqual(h.saved, []);
    assert.deepEqual(h.toasts, []);
    assert.equal(h.refreshes.n, 0);
  });

  test('READONLY gates the mutation', async () => {
    const m = { id: 'm1' };
    const h = harness({ maps: [m], map: m, readonly: true });
    await h.setMapFolder('m1', 'Work');
    assert.ok(!('folder' in m));
    assert.deepEqual(h.saved, []);
    assert.equal(h.refreshes.n, 0);
  });
});

describe('renameFolder', () => {
  test('re-files every member and moves the registry entry in place', async () => {
    const a = { id: 'a', folder: 'A' }, b = { id: 'b', folder: 'A' }, c = { id: 'c', folder: 'Z' };
    const h = harness({ maps: [a, b, c], ls: storage({ 'mindspark:folders': JSON.stringify({ order: ['A', 'Z'], collapsed: ['A'] }) }) });
    await h.renameFolder('A', 'B');
    assert.equal(a.folder, 'B');
    assert.equal(b.folder, 'B');
    assert.equal(c.folder, 'Z', 'other folders are untouched');
    assert.deepEqual(JSON.parse(h.ls.store.get('mindspark:folders')), { order: ['B', 'Z'], collapsed: ['B'] });
    assert.equal(h.refreshes.n, 1);
  });

  test('renaming into an existing name leaves one entry, wherever the old one sat', async () => {
    const load = (order, collapsed) => harness({
      maps: [{ id: 'a', folder: 'A' }],
      ls: storage({ 'mindspark:folders': JSON.stringify({ order, collapsed }) }),
    });
    const h1 = load(['A', 'B'], []);
    await h1.renameFolder('A', 'B');
    assert.deepEqual(JSON.parse(h1.ls.store.get('mindspark:folders')), { order: ['B'], collapsed: [] });
    const h2 = load(['B', 'A'], []);
    await h2.renameFolder('A', 'B');
    assert.deepEqual(JSON.parse(h2.ls.store.get('mindspark:folders')), { order: ['B'], collapsed: [] }, 'no duplicate, no stray index write');
    const h3 = load(['A', 'B'], ['A']);
    await h3.renameFolder('A', 'B');
    assert.deepEqual(JSON.parse(h3.ls.store.get('mindspark:folders')), { order: ['B'], collapsed: ['B'] }, 'collapsed if either was');
  });

  test('the open map is re-filed from memory, not from a store copy', async () => {
    const m = { id: 'm1', folder: 'A' };
    const h = harness({ maps: [{ ...m }], map: m });
    await h.renameFolder('A', 'B');
    assert.equal(m.folder, 'B');
    assert.deepEqual(h.saved, [m], 'the in-memory map object was saved');
  });

  test('one failed save does not abort the batch; the failure is toasted and the registry still moves', async () => {
    const a = { id: 'a', folder: 'A' }, b = { id: 'b', folder: 'A' };
    const ls = storage({ 'mindspark:folders': JSON.stringify({ order: ['A'], collapsed: [] }) });
    const saved = [];
    const toasts = [];
    let refreshes = 0, n = 0;
    const Store = {
      list: async () => [a, b],
      get: async id => [a, b].find(m => m.id === id) || null,
      save: async m => { if (++n === 1) throw new Error('HTTP 502'); saved.push(m); },
    };
    const { renameFolder } = loadFns(['loadFolderPrefs', 'saveFolderPrefs', 'renameFolder'],
      { localStorage: ls, Store, toast: t => toasts.push(t), refreshList: () => { refreshes++; }, map: null, READONLY: false });
    await renameFolder('A', 'B');
    assert.deepEqual(saved, [b], 'only the map that saved cleanly was written');
    assert.equal(b.folder, 'B', 'the second map still went through');
    assert.equal(toasts.length, 1);
    assert.match(toasts[0], /could not be updated/);
    assert.deepEqual(JSON.parse(ls.store.get('mindspark:folders')), { order: ['B'], collapsed: [] });
    assert.equal(refreshes, 1);
  });

  test('empty, untrimmed-equal or missing names are no-ops', async () => {
    const m = { id: 'm1', folder: 'A' };
    const h = harness({ maps: [m] });
    await h.renameFolder('', 'B');
    await h.renameFolder('A', ' A ');
    await h.renameFolder('A', '');
    await h.renameFolder(undefined, 'B');
    assert.deepEqual(h.saved, []);
    assert.equal(m.folder, 'A');
    assert.equal(h.refreshes.n, 0);
  });

  test('READONLY gates the mutation', async () => {
    const m = { id: 'm1', folder: 'A' };
    const h = harness({ maps: [m], readonly: true });
    await h.renameFolder('A', 'B');
    assert.equal(m.folder, 'A');
    assert.deepEqual(h.saved, []);
    assert.equal(h.refreshes.n, 0);
  });

  test('a failed list read says so and changes nothing', async () => {
    const m = { id: 'm1', folder: 'A' };
    const cap = captureWarn();
    try {
      const h = harness({ maps: [m], failList: new Error('offline'),
        ls: storage({ 'mindspark:folders': JSON.stringify({ order: ['A'], collapsed: [] }) }) });
      await h.renameFolder('A', 'B');
      assert.equal(m.folder, 'A');
      assert.deepEqual(JSON.parse(h.ls.store.get('mindspark:folders')), { order: ['A'], collapsed: [] }, 'the registry is untouched');
      assert.ok(cap.warns.length >= 1);
      assert.equal(h.toasts.length, 1);
    } finally { cap.done(); }
  });
});

describe('deleteFolder', () => {
  test('unfiles every member, keeps the maps, forgets the name', async () => {
    const a = { id: 'a', folder: 'A' }, b = { id: 'b', folder: 'A' }, c = { id: 'c', folder: 'Z' };
    const h = harness({ maps: [a, b, c], ls: storage({ 'mindspark:folders': JSON.stringify({ order: ['A', 'Z'], collapsed: ['A'] }) }) });
    await h.deleteFolder('A');
    assert.equal(h.maps.length, 3, 'maps are never deleted');
    assert.deepEqual(h.removed, [], 'deleteFolder must never call Store.remove');
    assert.ok(!('folder' in a) && !('folder' in b));
    assert.equal(c.folder, 'Z');
    assert.deepEqual(JSON.parse(h.ls.store.get('mindspark:folders')), { order: ['Z'], collapsed: [] });
    assert.equal(h.refreshes.n, 1);
  });

  test('the open map is unfiled in memory too', async () => {
    const m = { id: 'm1', folder: 'A' };
    const h = harness({ maps: [m], map: m });
    await h.deleteFolder('A');
    assert.ok(!('folder' in m));
    assert.deepEqual(h.saved, [m]);
  });

  test('READONLY gates the mutation', async () => {
    const m = { id: 'm1', folder: 'A' };
    const h = harness({ maps: [m], map: m, readonly: true });
    await h.deleteFolder('A');
    assert.equal(m.folder, 'A');
    assert.deepEqual(h.saved, []);
  });

  test('a failed list read says so, files nothing, registry untouched', async () => {
    const m = { id: 'm1', folder: 'A' };
    const cap = captureWarn();
    try {
      const h = harness({ maps: [m], failList: new Error('offline'),
        ls: storage({ 'mindspark:folders': JSON.stringify({ order: ['A'], collapsed: [] }) }) });
      await h.deleteFolder('A');
      assert.equal(m.folder, 'A');
      assert.deepEqual(JSON.parse(h.ls.store.get('mindspark:folders')), { order: ['A'], collapsed: [] });
      assert.ok(cap.warns.length >= 1);
      assert.equal(h.toasts.length, 1);
    } finally { cap.done(); }
  });
});

// The pin is the precedent the folder follows into the CloudStore index: the
// index entry carries it, a change to it forces the index write, and orphan
// recovery keeps it. Pinned here by exact strings, like the other registries.
describe('CloudStore index mirrors folder', () => {
  test('the index entry, the indexDue condition and orphan recovery all carry folder', () => {
    assert.ok(SRC.includes('if(map.folder) entry.folder=map.folder;'), 'index entry gains folder');
    assert.match(SRC, /prev\.folder!==entry\.folder/, 'a folder change forces the index write');
    assert.ok(SRC.includes('if(m.folder) e.folder=m.folder;'), 'orphan recovery keeps the folder');
  });

  test('the version restore and load paths keep the folder', () => {
    assert.match(SRC, /\['pinned','folder','_shareRoom','_editToken'\]/, 'restoreVersion preserves it');
    assert.match(SRC, /'frontmatter','folder'\]/, 'normalizeLoadedMap copies it');
  });
});
