// The sidebar rendering of the folder data layer: folderGroups() splits the
// sorted map index into the unfiled group (first, the plain list the app has
// always shown) plus one group per folder name in registry order, each sorted
// exactly like the flat list always was. The rendering side is pinned by
// exact strings, like the delete menu is: the row template must stay escaped,
// rows must stay draggable, and the folder menu must drive renameFolder and
// deleteFolder.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadFns, extractFunction } from './helpers/load-app-fns.mjs';

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

// folderGroups reads the folder registry (through folderNames), nothing else.
function harness(registry) {
  const ls = storage(registry ? { 'mindspark:folders': JSON.stringify(registry) } : {});
  const fns = loadFns(['loadFolderPrefs', 'folderNames', 'folderGroups'], { localStorage: ls });
  return { ...fns, ls };
}

describe('folderGroups', () => {
  test('unfiled first, then one group per folder name in registry order', () => {
    const h = harness({ order: ['B', 'A'], collapsed: [] });
    const idx = [
      { id: '2' },
      { id: '1', folder: 'A' },
      { id: '3', folder: 'C' },   // discovered name, after the registry names
      { id: '4', folder: 'A' },
    ];
    const gs = h.folderGroups(idx);
    assert.deepEqual(gs.map(g => g.name), [null, 'B', 'A', 'C']);
    assert.deepEqual(gs[0].items.map(m => m.id), ['2']);
    assert.deepEqual(gs[2].items.map(m => m.id), ['1', '4'], 'members keep list order within a group');
    assert.deepEqual(gs[3].items.map(m => m.id), ['3']);
  });

  test('an empty folder still yields its group, with no members', () => {
    const h = harness({ order: ['Empty', 'Used'], collapsed: [] });
    const gs = h.folderGroups([{ id: '1', folder: 'Used' }]);
    assert.deepEqual(gs.map(g => g.name), [null, 'Empty', 'Used']);
    assert.deepEqual(gs[1].items, []);
    assert.deepEqual(gs[2].items.map(m => m.id), ['1']);
  });

  test('items are sorted inside every group: pinned first, then most recently updated', () => {
    const h = harness();
    const idx = [
      { id: 'old', folder: 'F', updated: 10 },
      { id: 'pin', folder: 'F', pinned: true, updated: 1 },
      { id: 'new', folder: 'F', updated: 30 },
      { id: 'loose', updated: 5 },
      { id: 'loose-pin', pinned: true, updated: 2 },
    ];
    const gs = h.folderGroups(idx);
    assert.deepEqual(gs[0].items.map(m => m.id), ['loose-pin', 'loose']);
    assert.deepEqual(gs[1].items.map(m => m.id), ['pin', 'new', 'old']);
  });

  test('grouping is independent of the collapsed registry', () => {
    // The collapse state lives in the registry but only the renderer reads it:
    // a folder collapsed in the sidebar still lists its members here.
    const idx = [{ id: '1', folder: 'F' }];
    const open = harness({ order: ['F'], collapsed: [] });
    const shut = harness({ order: ['F'], collapsed: ['F'] });
    assert.deepEqual(open.folderGroups(idx), shut.folderGroups(idx));
  });

  test('a whitespace folder value means unfiled', () => {
    const h = harness();
    const gs = h.folderGroups([{ id: '1', folder: '   ' }, { id: '2' }]);
    assert.deepEqual(gs.map(g => g.name), [null]);
    assert.deepEqual(gs[0].items.map(m => m.id), ['1', '2']);
  });

  test('an empty index still shows the registered folders, empty', () => {
    // The registry is the UI memory: a named folder exists even before any
    // map is filed into it, which is what makes the empty-header rule work.
    const h = harness({ order: ['Ghost'], collapsed: [] });
    assert.deepEqual(h.folderGroups([]), [{ name: null, items: [] }, { name: 'Ghost', items: [] }]);
  });
});

// Pinned by exact strings, the way delete-ui pins the row menu: the folder
// menu drives the same data layer the list does, and the renderer keeps the
// escaping and drag wiring it was pinned for.
describe('the folder UI is wired the way it renders', () => {
  test('openFolderMenu exists as a top-level function driving rename and delete', () => {
    const src = extractFunction('openFolderMenu');   // throws unless a top-level function declaration
    const rename = src.indexOf('renameFolder(name');
    const del = src.indexOf('deleteFolder(name');
    assert.ok(rename !== -1, 'the menu renames the folder through renameFolder');
    assert.ok(del !== -1, 'and deletes it through deleteFolder');
    assert.ok(rename < del, 'rename first, delete second, like the row menu');
  });

  test('refreshList renders the grouped index and keeps the pinned row template', () => {
    const src = extractFunction('refreshList');
    assert.ok(src.includes('folderGroups('), 'rendering walks the grouped index');
    assert.ok(src.includes('draggable=true'), 'map rows are drag sources');
    assert.match(src, /style="background:\$\{escapeHtml\(m\.color/, 'sidebar dot colour stays escaped');
    assert.match(src, /escapeHtml\(g\.name\)/, 'folder names are escaped into the header');
    assert.match(src, /escapeHtml\(m\.title\|\|'Untitled'\)/, 'map titles stay escaped');
  });

  test('the row template is byte-identical for unfiled and filed maps', () => {
    const src = extractFunction('refreshList');
    const rows = [...src.matchAll(/el\.innerHTML=`<span class="dot"[^`]*`/g)].map(m => m[0]);
    assert.ok(rows.length >= 1, 'the template is built in refreshList');
    const bare = rows[0].replace('sub','');   // the only difference is the sub class prefix
    for (const r of rows) assert.equal(r.replace('sub',''), bare, 'one shared template');
    assert.match(rows[0], /class="row-menu" title="More" aria-haspopup="true" aria-label="More actions"/);
  });

  test('positionRowPop aligns to folder rows as well as map rows', () => {
    const src = extractFunction('positionRowPop');
    assert.ok(src.includes("btn.closest('.map-item,.folder-row')"), 'the folder header menu has a row to align to');
  });
});
