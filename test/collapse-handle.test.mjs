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
  // Every rule whose selector mentions the badge. The badge's own visibility
  // contract is: hidden at rest on an expanded node, restored whenever the
  // node is hovered or the node is collapsed, and gone in edit/present modes.
  // The count-to-glyph swap is two opacity flips on the inner faces. Beyond
  // those cases, nothing keyed on a look, a map style, a UI layout or a theme
  // is allowed to hide it, make it non-interactive, or resize it to nothing.
  const plain = CSS.replace(/\/\*[\s\S]*?\*\//g, '');   // comments would bleed into selectors
  const rules = [...plain.matchAll(/([^{}]*?(?:\.fold-btn)[^{}]*)\{([^}]*)\}/g)]
    .map(m => ({ sel: m[1].trim().replace(/\s+/g, ' '), body: m[2] }));

  test('the fold badge rules exist', () => {
    assert.ok(rules.some(r => r.sel === '.node .fold-btn'), 'base .node .fold-btn rule');
    assert.ok(rules.length >= 5);
  });

  test('no look, map style or UI layout hides or disables the badge', () => {
    const disabling = /display\s*:\s*none|visibility\s*:\s*hidden|pointer-events\s*:\s*none|width\s*:\s*0|height\s*:\s*0|opacity\s*:\s*0(?![.\d])/;
    const allowed = /^\.node \.fold-btn$|\.node\.editing|body\.presenting|\.node:hover[^{]*\.fold-(btn|count|icon)|\.node \.fold-btn \.fold-(count|icon)$/;
    for (const r of rules) {
      if (!disabling.test(r.body)) continue;
      // `.fold-count{opacity:0}` on hover / `.fold-icon{opacity:0}` at rest are
      // the two halves of the count-to-glyph swap, not hidden functionality.
      // The base rule's opacity:0 + pointer-events:none is the "expanded nodes
      // keep the badge out of sight until hovered" contract.
      assert.match(r.sel, allowed, `"${r.sel}" hides or disables the badge`);
      assert.doesNotMatch(r.sel, /data-look|data-style|ui-[a-z]+|data-theme/, `"${r.sel}" is keyed on a look/style/layout/theme`);
    }
  });

  test('the badge surfaces on node hover and stays up on a collapsed branch', () => {
    const restore = rules.find(r => r.sel === '.node:hover .fold-btn, .node.collapsed .fold-btn');
    assert.ok(restore, 'one rule restores the badge for hovered and collapsed nodes');
    assert.match(restore.body, /opacity\s*:\s*1/, 'restores visibility');
    assert.match(restore.body, /pointer-events\s*:\s*auto/, 'restores interactivity');
    const base = rules.find(r => r.sel === '.node .fold-btn');
    assert.match(base.body, /opacity\s*:\s*0/, 'base state keeps an expanded node badge hidden');
    assert.doesNotMatch(base.body, /display\s*:\s*none/, 'the rest state hides via opacity so hover can fade it in');
    assert.match(base.body, /z-index\s*:\s*[1-9]/, 'badge sits above the card and its stem');
  });

  test('the badge hangs off the card edge with a stem back to the card', () => {
    const base = rules.find(r => r.sel === '.node .fold-btn');
    assert.match(base.body, /width\s*:\s*20px/, 'badge is the small 20px circle');
    assert.match(base.body, /right\s*:\s*-30px/, 'badge floats 10px clear of the card edge');
    const stemBase = rules.find(r => r.sel === '.node .fold-btn::before');
    assert.ok(stemBase, 'the stem element exists');
    assert.match(stemBase.body, /var\(--edge-color/, 'stem uses the branch-line colour');
    const sides = rules.filter(r => /::before/.test(r.sel) && /data-side/.test(r.sel));
    assert.equal(sides.length, 4, 'each of the four data-sides draws a stem');
    assert.ok(sides.every(s => /width/.test(s.body)), 'stems have geometry');
  });
});
