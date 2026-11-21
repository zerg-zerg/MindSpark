// The notes editor has an MD toggle in its toolbar and an expand button in the
// header. MD swaps in a Markdown source view inside the popup: the rich note is
// converted out with notesHtmlToMd() and back with notesMdToHtml() (mdToHtml
// behind the notes sanitizer), so what is saved still goes through npSerialize.
// The expand button takes the popup full window via the .np-max class. This
// file exercises the conversions as a round trip and pins the popup wiring the
// same way notes-math-inplace does.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { extractFunction, loadFns, extractConst } from './helpers/load-app-fns.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CSS = readFileSync(join(ROOT, 'public', 'styles.css'), 'utf8');
const editor = extractFunction('showNotesEditor');

// A <template> / <div> stand-in that parses a small, well-formed subset of
// HTML: nested elements, quoted attributes, text nodes. Enough for the notes
// fixture and mdToHtml's output; the code under test only walks childNodes and
// reads nodeValue/tagName/innerHTML/textContent/attributes. It exists because
// the suite has no DOM emulator and these conversions need an inert parse
// (notesHtmlToMd, htmlToInlineMd) plus one to sanitize against
// (sanitizeInlineHTML).
const fakeDoc = (() => {
  const decode = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const VOID = /^(br|img|hr|input|meta|link|area|base|col|embed|source|track|wbr)$/i;

  function serialize(nodes) {
    return nodes.map(n => {
      if (n.nodeType === 3) return esc(n.nodeValue);
      if (n.nodeType !== 1) return '';
      const attrs = n.attributes.map(a => a.value != null ? ' ' + a.name + '="' + String(a.value).replace(/"/g, '&quot;') + '"' : ' ' + a.name).join('');
      return '<' + n.tagName.toLowerCase() + attrs + '>' + serialize(n.childNodes) + '</' + n.tagName.toLowerCase() + '>';
    }).join('');
  }
  function el(tag) {
    return {
      nodeType: 1, tagName: tag.toUpperCase(), childNodes: [], attributes: [], parentNode: null,
      get children() { return this.childNodes.filter(n => n.nodeType === 1); },
      get firstChild() { return this.childNodes[0] || null; },
      get textContent() { return this.childNodes.map(n => n.nodeType === 3 ? n.nodeValue : n.textContent).join(''); },
      get innerHTML() { return serialize(this.childNodes); },
      set innerHTML(v) { this.childNodes.slice().forEach(n => { n.parentNode = null; }); this.childNodes = parse(v).childNodes.slice(); this.childNodes.forEach(n => { n.parentNode = this; }); },
      getAttribute(n) { const a = this.attributes.find(a => a.name === n.toLowerCase()); return a ? a.value : null; },
      setAttribute(n, v) { const a = this.attributes.find(a => a.name === n.toLowerCase()); if (a) a.value = String(v); else this.attributes.push({ name: n.toLowerCase(), value: String(v) }); },
      removeAttribute(n) { this.attributes = this.attributes.filter(a => a.name !== n.toLowerCase()); },
      appendChild(n) {
        if (n.nodeType === 11) { const kids = n.childNodes.slice(); n.childNodes = []; kids.forEach(k => { k.parentNode = this; this.childNodes.push(k); }); return n; }
        if (n.parentNode) { const i = n.parentNode.childNodes.indexOf(n); if (i >= 0) n.parentNode.childNodes.splice(i, 1); }
        n.parentNode = this; this.childNodes.push(n); return n;
      },
      removeChild(n) { const i = this.childNodes.indexOf(n); if (i >= 0) this.childNodes.splice(i, 1); n.parentNode = null; return n; },
      insertBefore(n, ref) {
        if (n.parentNode) { const i = n.parentNode.childNodes.indexOf(n); if (i >= 0) n.parentNode.childNodes.splice(i, 1); }
        let at = ref ? this.childNodes.indexOf(ref) : this.childNodes.length;
        if (at < 0) at = this.childNodes.length;
        n.parentNode = this; this.childNodes.splice(at, 0, n); return n;
      },
      querySelectorAll(sel) {
        const tag = sel.toLowerCase(); const out = [];
        const walk = n => n.childNodes.forEach(c => { if (c.nodeType === 1) { if (c.tagName.toLowerCase() === tag) out.push(c); walk(c); } });
        walk(this); return out;
      },
    };
  }
  function parse(html) {
    const root = el('#fragment'); root.nodeType = 11;
    const stack = [root];
    const re = /(<\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[a-zA-Z-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(\/?)>|([^<]+)/g;
    let m;
    while ((m = re.exec(html))) {
      if (m[5] != null) { const n = { nodeType: 3, nodeValue: decode(m[5]), parentNode: stack[stack.length - 1] }; stack[stack.length - 1].childNodes.push(n); continue; }
      if (m[1] === '</') {
        for (let i = stack.length - 1; i > 0; i--) if (stack[i].tagName.toLowerCase() === m[2].toLowerCase()) { stack.length = i; break; }
        continue;
      }
      const node = el(m[2]);
      const ar = /([a-zA-Z-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g; let a;
      while ((a = ar.exec(m[3] || ''))) node.attributes.push({ name: a[1].toLowerCase(), value: decode(a[2] != null ? a[2] : (a[3] != null ? a[3] : (a[4] || ''))) });
      node.parentNode = stack[stack.length - 1];
      stack[stack.length - 1].childNodes.push(node);
      if (!m[4] && !VOID.test(m[2])) stack.push(node);
    }
    return root;
  }
  return {
    createElement: tag => {
      if (tag === 'template') {
        const t = el('template');
        t.content = el('#fragment'); t.content.nodeType = 11;
        Object.defineProperty(t, 'innerHTML', { get() { return this.content.innerHTML; }, set(v) { this.content.innerHTML = v; } });
        return t;
      }
      return el(tag);
    },
  };
})();

const RE = {
  INLINE_HTML_RE: extractConst('INLINE_HTML_RE'),
  ENTITY_RE: extractConst('ENTITY_RE'),
  MATH_DELIM_RE: extractConst('MATH_DELIM_RE'),
};
// The real pipeline, end to end. sanitizeNotes runs for real too (unlike the
// identity stubs elsewhere) so the whitelist the round trip depends on is
// exercised; latexToMathML is stubbed because masked math never reaches it.
const { notesHtmlToMd, notesMdToHtml } = loadFns(
  ['notesHtmlToMd', 'notesMdToHtml', 'htmlToInlineMd', '_htmlTableToMdRows',
   'mdToHtml', 'mdInlineToHtmlWithMath', 'mdInlineToHtml', 'renderMdList',
   'parseFrontmatterFields', 'frontmatterFieldsToHtml', 'scrubRawHtmlBlock',
   'safeLinkHref', 'escapeHtml', 'sanitizeInlineHTML', 'sanitizeNotes'],
  {
    document: fakeDoc,
    hasInlineMarkup: t => RE.INLINE_HTML_RE.test(t || '') || RE.ENTITY_RE.test(t || ''),
    INLINE_HTML_RE: RE.INLINE_HTML_RE, ENTITY_RE: RE.ENTITY_RE, MATH_DELIM_RE: RE.MATH_DELIM_RE,
    SAFE_TAGS: extractConst('SAFE_TAGS'),
    DROP_TAGS: extractConst('DROP_TAGS'),
    _sanCache: extractConst('_sanCache'),
    NOTES_TAGS: extractConst('NOTES_TAGS'),
    latexToMathML: () => null,
  });

const NOTE = '<h2>Plan</h2><p><b>Important</b> and <i>urgent</i> and <a href="https://example.com">a link</a> and $E=mc^2$.</p><ul><li>one</li><li>two</li></ul>';
const MD = '## Plan\n\n**Important** and *urgent* and [a link](https://example.com) and $E=mc^2$.\n\n- one\n- two';

describe('notesHtmlToMd: rich notes become editable Markdown', () => {
  test('the markdown keeps heading, bold, italic, link, list and math', () => {
    assert.equal(notesHtmlToMd(NOTE), MD);
  });

  test('display math keeps its $$ source, and an empty note is empty', () => {
    assert.equal(notesHtmlToMd('<p>$$\\frac{a}{b}$$</p>'), '$$\\frac{a}{b}$$');
    assert.equal(notesHtmlToMd(''), '');
  });
});

describe('notesMdToHtml: Markdown becomes sanitized rich notes', () => {
  test('the round trip preserves heading/bold/italic/list/link/math in the HTML', () => {
    const out = notesMdToHtml(MD);
    assert.match(out, /<h2>Plan<\/h2>/);
    assert.doesNotMatch(out, /<p>Plan<\/p>/, 'the heading is not demoted to text');
    assert.match(out, /<b>Important<\/b>/);
    assert.match(out, /<i>urgent<\/i>/);
    assert.match(out, /<a href="https:\/\/example\.com"[^>]*>a link<\/a>/);
    assert.match(out, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
    assert.match(out, /\$E=mc\^2\$/, 'the formula survives as $ source text');
    assert.ok(!/<math/i.test(out), 'mdToHtml MathML never reaches the notes - it would be stripped');
  });

  test('converting the result back gives the same markdown again', () => {
    assert.equal(notesHtmlToMd(notesMdToHtml(MD)), MD);
  });

  test('display math round trips through $$', () => {
    const out = notesMdToHtml('$$\\frac{a}{b}$$');
    assert.ok(out.includes('<p>$$\\frac{a}{b}$$</p>'), 'got ' + out);
    assert.ok(!/<math/i.test(out));
  });

  test('money text is not mistaken for math', () => {
    assert.match(notesMdToHtml('costs $5 and $10 today'), /costs \$5 and \$10 today/);
  });

  test('the notes sanitizer is really applied: outside the whitelist unwraps, handlers strip', () => {
    assert.equal(notesMdToHtml('#### Deep'), 'Deep', 'h4 is not in NOTES_TAGS and unwraps to text');
    assert.equal(notesMdToHtml('## Hi <span onclick="alert(1)">y</span>'), '<h2>Hi <span>y</span></h2>');
  });
});

describe('the popup wiring', () => {
  test('head order is title, expand, close; the MD toggle moved to the toolbar', () => {
    const head = editor.match(/<div class="np-head">[\s\S]*?<\/div>/)[0];
    const at = s => head.indexOf(s);
    assert.ok(at('np-title') < at('np-expand') && at('np-expand') < at('np-x'));
    assert.doesNotMatch(head, /np-md/, 'the MD toggle is no longer in the header');
    assert.match(head, /<button class="np-expand" title="Expand to full window" aria-label="Expand to full window">⛶<\/button>/);
    const toolbar = editor.match(/<div class="np-toolbar">([\s\S]*?)<div class="np-editor"/)[1];
    assert.match(toolbar, /<button class="np-md" title="Toggle Markdown source editing" aria-label="Toggle Markdown source editing">MD<\/button>/);
    assert.ok(toolbar.indexOf('removeFormat') < toolbar.indexOf('np-md'), 'MD sits after the formatting commands');
  });

  test('source mode keeps the MD toggle reachable by hiding only the formatting buttons', () => {
    assert.match(editor, /const npFmtEls=Array\.from\(popup\.querySelectorAll\('\.np-toolbar > \*'\)\)\.filter\(el=>!el\.classList\.contains\('np-md'\)\);/);
    const mdShow = editor.slice(editor.indexOf('const npMdShow=on=>{'), editor.indexOf('if(mdBtn) mdBtn.addEventListener'));
    assert.doesNotMatch(mdShow, /\.np-toolbar'\)\.style\.display/, 'the whole toolbar is never hidden in source mode');
    assert.match(mdShow, /npFmtShow\(false\);/);
    assert.match(mdShow, /npFmtShow\(true\);/);
  });

  test('the source textarea shares the editor slot and starts hidden', () => {
    assert.match(editor, /<textarea class="np-mdsrc" placeholder="Markdown source - \*\*bold\*\*, # headings, - lists, \$x\^2\$ math" style="display:none"><\/textarea>/);
  });

  test('MD toggle: in serializes the editor, out re-renders math through npRenderAll', () => {
    assert.match(editor, /ta\.value=notesHtmlToMd\(npSerialize\(editor\)\);/);
    assert.match(editor, /mdBtn\.classList\.add\('on'\)/);
    assert.match(editor, /editor\.innerHTML=sanitizeNotes\(notesMdToHtml\(ta\.value\)\);\s*\n\s*npRenderAll\(editor\);\s*\n\s*ta\.style\.display='none';/);
    assert.match(editor, /mdBtn\.classList\.remove\('on'\)/);
  });

  test('save reads the active source, and the stored form is still npSerialize', () => {
    assert.match(editor, /if\(mdMode\)\{ editor\.innerHTML=sanitizeNotes\(notesMdToHtml\(ta\.value\)\); npRenderAll\(editor\); \}/);
    assert.match(editor, /const html=npSerialize\(editor\);/, 'the pinned save line stays byte-identical');
  });

  test('the textarea exits source mode on Escape and saves on Ctrl/Cmd+Enter', () => {
    assert.match(editor, /ta\.addEventListener\('keydown',e=>\{\s*e\.stopPropagation\(\);\s*if\(isComposingKey\(e\)\) return;\s*if\(e\.key==='Escape'\)\{ e\.preventDefault\(\); npMdShow\(false\); return; \}\s*if\(e\.key==='Enter' && \(e\.ctrlKey\|\|e\.metaKey\)\)\{ e\.preventDefault\(\); save\(\); \}/);
  });

  test('read-only hides the MD button; expand stays available', () => {
    assert.match(editor, /const mb=popup\.querySelector\('\.np-md'\); if\(mb\) mb\.style\.display='none';/);
  });

  test('expand toggles np-max, swaps its label, and the header drag is inert while maximized', () => {
    assert.match(editor, /popup\.classList\.toggle\('np-max',!!on\);/);
    assert.match(editor, /const t=on\?'Restore size':'Expand to full window';/);
    assert.match(editor, /exBtn\.title=t; exBtn\.setAttribute\('aria-label',t\);/);
    assert.match(editor, /if\(e\.target\.closest\('\.np-x'\)\) return;\s*\n\s*if\(popup\.classList\.contains\('np-max'\)\) return;/);
  });

  test('Escape restores a maximized popup before closing it', () => {
    assert.match(editor, /if\(popup\.classList\.contains\('np-max'\)\)\{ npMaxSet\(false\); return; \}\s*\n\s*close\(\);/);
  });
});

describe('converter source', () => {
  const toMd = extractFunction('notesHtmlToMd');
  const toHtml = extractFunction('notesMdToHtml');

  test('notesHtmlToMd reuses the shared inline/table converters', () => {
    assert.match(toMd, /htmlToInlineMd\(/);
    assert.match(toMd, /_htmlTableToMdRows\(/);
    assert.ok(toMd.includes("'```\\n'"), 'pre blocks come back as fenced code');
  });

  test('notesMdToHtml delegates to mdToHtml behind sanitizeNotes and masks math', () => {
    assert.match(toHtml, /MATH_DELIM_RE\.source/);
    assert.match(toHtml, /sanitizeNotes\(mdToHtml\(/);
  });
});

describe('styles', () => {
  test('.np-max covers the window and hides the resize grip', () => {
    assert.match(CSS, /\.notes-popup\.np-max\{[^}]*left:0!important[^}]*top:0!important[^}]*\}/);
    assert.match(CSS, /\.notes-popup\.np-max\{[^}]*width:auto!important[^}]*height:auto!important[^}]*\}/);
    assert.match(CSS, /\.notes-popup\.np-max\{[^}]*max-width:none!important/);
    assert.match(CSS, /\.notes-popup\.np-max \.np-resize\{display:none\}/);
  });

  test('.np-mdsrc is styled for the editor slot', () => {
    assert.match(CSS, /\.notes-popup \.np-mdsrc\{[^}]*flex:1 1 auto/);
    assert.match(CSS, /\.notes-popup \.np-mdsrc\{[^}]*resize:none/);
    assert.match(CSS, /\.notes-popup \.np-mdsrc\{[^}]*background:transparent/);
    assert.match(CSS, /\.notes-popup \.np-mdsrc\{[^}]*color:var\(--sticky-ink\)/);
    assert.match(CSS, /\.notes-popup \.np-mdsrc\{[^}]*font-family:ui-monospace/);
  });

  test('.np-expand matches .np-x; the toolbar MD toggle keeps the .on accent', () => {
    assert.match(CSS, /\.notes-popup \.np-head \.np-expand\{[^}]*width:22px; height:22px;/);
    assert.match(CSS, /\.notes-popup \.np-head \.np-expand:hover\{background:color-mix\(in srgb, var\(--sticky-ink\) 16%, transparent\)\}/);
    assert.match(CSS, /\.notes-popup \.np-toolbar \.np-md\{margin-left:auto; font-size:10px; font-weight:700; letter-spacing:\.02em\}/);
    assert.match(CSS, /\.notes-popup \.np-toolbar \.np-md\.on\{background:var\(--sticky-ink\); color:var\(--sticky\); border-color:var\(--sticky-ink\)\}/);
  });
});
