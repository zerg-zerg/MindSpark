// The fold badge on a node toggles `collapsed`. render() reuses a node's element
// whenever its signature is unchanged, so the element outlives the node object
// it was built from: undo/redo (restore), Markdown-mode sync (applyMdToMap), a
// collab snapshot and a cloud merge all swap map.nodes for fresh objects. A
// handler that captured the original object then toggled a detached copy and
// the map showed nothing - "sometimes the fold button does nothing". The
// handler has to look the node up by id at click time.
//
// render() needs the whole DOM, so the handler line is lifted out of its real
// source and driven directly; the CSS sweep below covers the "any look, style or
// layout" half of the question.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { extractFunction } from './helpers/load-app-fns.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CSS = readFileSync(join(ROOT, 'public', 'styles.css'), 'utf8');

/** The fold badge's toggle handler, as written in render(). */
function handlerSource() {
  const render = extractFunction('render');
  const m = render.match(/^\s*(\(\)=>\{[^\n]*collapsed=![^\n]*\})\s*$/m);
  assert.ok(m, 'fold badge handler not found in render()');
  return m[1];
}

function harness() {
  const calls = [];
  const map = { id: 'm', rootId: 'r', nodes: {
    r: { id: 'r', text: 'Root', parent: null },
    a: { id: 'a', text: 'A', parent: 'r' },
    b: { id: 'b', text: 'B', parent: 'a' },
  } };
  const n = map.nodes.a;   // what render() had in hand when it built the element
  // `n` is passed too so the pre-fix handler (which closed over it) compiles as
  // well - that is what lets this test demonstrate the old failure.
  const click = new Function('map', 'id', 'n', 'pushHistory', 'autoLayout', 'return ' + handlerSource())(
    map, 'a', n, () => calls.push('pushHistory'), () => calls.push('autoLayout'));
  return { map, n, click, calls };
}

describe('fold badge - toggles the live node', () => {
  test('toggles and re-lays out on a plain click', () => {
    const h = harness();
    h.click();
    assert.equal(h.map.nodes.a.collapsed, true);
    assert.deepEqual(h.calls, ['pushHistory', 'autoLayout']);
    h.click();
    assert.equal(h.map.nodes.a.collapsed, false);
  });

  test('still works after map.nodes was replaced under a reused element (undo/redo, md sync, merge)', () => {
    const h = harness();
    // Exactly what restore() does: new objects, same ids, same content.
    h.map.nodes = JSON.parse(JSON.stringify(h.map.nodes));
    h.click();
    assert.equal(h.map.nodes.a.collapsed, true, 'the node on the map must change');
    assert.equal(h.n.collapsed, undefined, 'the detached object the element was built from is not the target');
    assert.deepEqual(h.calls, ['pushHistory', 'autoLayout']);
  });

  test('does nothing, and records no history, if the node is gone', () => {
    const h = harness();
    delete h.map.nodes.a;
    assert.doesNotThrow(() => h.click());
    assert.deepEqual(h.calls, []);
  });
});

describe('fold badge - reachable in every look, map style and UI layout', () => {
  // Every rule whose selector mentions the badge. Only the fold/count layer swap
  // and edit mode may touch its visibility; nothing keyed on a look, a map style
  // or a UI layout is allowed to hide it, make it non-interactive or shrink it.
  const plain = CSS.replace(/\/\*[\s\S]*?\*\//g, '');   // comments would bleed into selectors
  const rules = [...plain.matchAll(/([^{}]*?(?:\.fold-btn)[^{}]*)\{([^}]*)\}/g)]
    .map(m => ({ sel: m[1].trim().replace(/\s+/g, ' '), body: m[2] }));

  test('the fold badge rules exist', () => {
    assert.ok(rules.some(r => r.sel === '.node .fold-btn'), 'base .node .fold-btn rule');
    assert.ok(rules.length >= 5);
  });

  test('no look, map style or UI layout hides or disables the badge', () => {
    const disabling = /display\s*:\s*none|visibility\s*:\s*hidden|pointer-events\s*:\s*none|width\s*:\s*0|height\s*:\s*0|opacity\s*:\s*0(?![.\d])/;
    const allowed = /\.node\.editing|body\.presenting|\.node:hover[^{]*\.fold-(count|icon)|\.node \.fold-btn \.fold-(count|icon)$/;
    for (const r of rules) {
      if (!disabling.test(r.body)) continue;
      // `.fold-count{opacity:0}` on hover / `.fold-icon{opacity:0}` at rest are
      // the two halves of the count-to-glyph swap, not hidden functionality.
      assert.match(r.sel, allowed, `"${r.sel}" hides or disables the badge`);
      assert.doesNotMatch(r.sel, /data-look|data-style|ui-[a-z]+|data-theme/, `"${r.sel}" is keyed on a look/style/layout/theme`);
    }
  });

  test('the badge is visible at rest (it carries the child count), not only on hover', () => {
    const base = rules.find(r => r.sel === '.node .fold-btn');
    assert.doesNotMatch(base.body, /opacity\s*:\s*0(?![.\d])|display\s*:\s*none/, 'base state must keep the count visible');
    assert.match(base.body, /z-index\s*:\s*[1-9]/, 'badge sits above the card and any ::after decoration');
  });
});
