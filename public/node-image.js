/* public/node-image.js
 * Loaded as a CLASSIC script (no modules, no bundler) alongside app.js.
 *
 * Depends on:
 *   - window.MSImageStore (public/image-store.js) - OPTIONAL: resolve() is used
 *     when present, otherwise the stored src is used verbatim.
 *   - positionPopup(pop, anchor, opts) from app.js - OPTIONAL and looked up
 *     lazily; when absent (or if it throws) the preview falls back to
 *     getBoundingClientRect() + position:fixed clamped to the viewport.
 *   - document, window, matchMedia.
 *
 * Nothing runs at load time; it only defines window.MSNodeImage, so load order
 * relative to app.js and image-store.js does not matter.
 *
 * API (window.MSNodeImage):
 *   decorate(el, node, opts)   opts = { mode: 'icon' | 'inline' }
 *       mode 'icon'  -> adds/updates a 20x20 thumbnail button as the FIRST
 *                       child of the .node element (before marker/text).
 *       anything else -> no badge is created (caller renders the full image),
 *                       but a stale badge left on a reused element is removed.
 *   cleanup(el)                removes the badge + any hover state for `el`.
 *
 * The app reuses node elements between renders (app.js ~1731), so decorate()
 * is idempotent: it updates the existing badge in place instead of appending
 * a second one, and removes it when node.image is gone.
 */
(function () {
  'use strict';

  var HOVER_DELAY = 220;

  var _preview = null;      // singleton <div class="node-image-preview">
  var _previewImg = null;
  var _previewCap = null;
  var _timer = 0;
  var _activeBtn = null;    // badge the current preview/timer belongs to
  var _hovered = false;
  var _token = 0;           // guards async image load callbacks
  var _docBound = false;

  function store() {
    var s = window.MSImageStore;
    return (s && typeof s === 'object') ? s : null;
  }

  function resolveSrc(src) {
    var s = store();
    if (s && typeof s.resolve === 'function') {
      try { return s.resolve(src); } catch (_e) { /* fall through */ }
    }
    return src;
  }

  function canHover() {
    try {
      return typeof window.matchMedia === 'function'
        ? window.matchMedia('(hover: hover)').matches
        : true;
    } catch (_e) {
      return true;
    }
  }

  // Never preview while the node is being edited (double-click to edit swaps in
  // a contenteditable / adds .editing, app.js).
  function isEditing(el) {
    if (!el) return false;
    if (el.isContentEditable) return true;
    if (el.classList && el.classList.contains('editing')) return true;
    try {
      if (el.closest && el.closest('.node.editing')) return true;
      if (el.closest && el.closest('[contenteditable="true"]')) return true;
    } catch (_e) { /* not an Element */ }
    return false;
  }

  function findBadge(el) {
    if (!el) return null;
    for (var c = el.firstElementChild; c; c = c.nextElementSibling) {
      if (c.classList && c.classList.contains('node-image-badge')) return c;
    }
    return null;
  }

  function removeBadge(el) {
    var b = findBadge(el);
    if (!b) return;
    if (_activeBtn === b) hidePreview();
    if (b.parentNode) b.parentNode.removeChild(b);
  }

  /* ---------- preview singleton ---------- */

  function bindDocument() {
    if (_docBound) return;
    _docBound = true;
    // capture: also catches scrolling inside the canvas/panels, not just the page
    document.addEventListener('scroll', hidePreview, { capture: true, passive: true });
    document.addEventListener('pointerdown', hidePreview, { capture: true, passive: true });
    document.addEventListener('keydown', onKeyDown, false);
    window.addEventListener('blur', hidePreview, false);
  }

  function onKeyDown(ev) {
    if (ev && (ev.key === 'Escape' || ev.key === 'Esc')) hidePreview();
  }

  function ensurePreview() {
    if (_preview && _preview.isConnected) return _preview;

    _preview = document.createElement('div');
    _preview.className = 'node-image-preview';
    _preview.setAttribute('aria-hidden', 'true');

    _previewImg = document.createElement('img');
    _previewImg.alt = '';
    _previewImg.decoding = 'async';

    _previewCap = document.createElement('div');
    _previewCap.className = 'node-image-preview-cap';

    _preview.appendChild(_previewImg);
    _preview.appendChild(_previewCap);
    document.body.appendChild(_preview);

    _previewImg.addEventListener('load', function () {
      if (!_preview || !_previewImg) return;
      if (_previewImg.dataset.token !== String(_token)) return;
      finishPreview();
    });
    _previewImg.addEventListener('error', hidePreview);

    bindDocument();
    return _preview;
  }

  // Position with the app's own helper when it exists (it handles UI zoom and
  // clamps to the viewport); otherwise a minimal equivalent in fixed coords.
  function place(pop, anchor) {
    var fn = null;
    try {
      if (typeof positionPopup === 'function') fn = positionPopup;
    } catch (_e) { /* app.js not loaded yet, or positionPopup in its TDZ */ }

    if (fn) {
      try { fn(pop, anchor, {}); return; } catch (_e) { /* fall back below */ }
    }

    try {
      pop.style.position = 'fixed';
      var r = anchor.getBoundingClientRect();
      var pw = pop.offsetWidth || 0;
      var ph = pop.offsetHeight || 0;
      var margin = 8;
      var gap = 6;
      var left = r.left;
      if (left + pw > window.innerWidth - margin) left = window.innerWidth - pw - margin;
      if (left < margin) left = margin;
      var top = r.bottom + gap;
      if (top + ph > window.innerHeight - margin) {
        top = Math.max(margin, r.top - gap - ph);
      }
      pop.style.left = Math.max(0, left) + 'px';
      pop.style.top = Math.max(0, top) + 'px';
    } catch (_e) { /* nothing more we can do */ }
  }

  function finishPreview() {
    if (!_preview || !_previewImg || !_activeBtn) return;
    var alt = _previewImg.dataset.alt || '';
    var w = _previewImg.naturalWidth || 0;
    var h = _previewImg.naturalHeight || 0;
    var dims = w && h ? (w + '\u00D7' + h) : '';
    var cap = alt && dims ? (alt + ' \u00B7 ' + dims) : (alt || dims);

    // textContent only - alt text is user data.
    _previewCap.textContent = cap;
    _previewCap.style.display = cap ? '' : 'none';

    place(_preview, _activeBtn);
    _preview.style.visibility = '';
  }

  function showPreview(btn) {
    if (!_hovered || _activeBtn !== btn) return;
    if (!btn.isConnected) return;
    if (!canHover()) return;
    if (isEditing(btn.parentElement)) return;

    var st = btn._msImageState;
    if (!st || !st.src) return;

    ensurePreview();
    var token = ++_token;
    _preview.style.visibility = 'hidden';
    _preview.style.left = '0px';
    _preview.style.top = '0px';
    _previewCap.textContent = '';
    _previewCap.style.display = 'none';

    _previewImg.dataset.token = String(token);
    _previewImg.dataset.alt = st.alt || '';
    _previewImg.removeAttribute('src');
    _previewImg.src = st.src;

    // Cached/decoded images may never fire `load`; complete covers that.
    if (_previewImg.complete && _previewImg.naturalWidth) finishPreview();
  }

  function hidePreview() {
    _hovered = false;
    _activeBtn = null;
    _token++;
    if (_timer) {
      clearTimeout(_timer);
      _timer = 0;
    }
    if (_preview && _preview.parentNode) _preview.parentNode.removeChild(_preview);
    _preview = null;
    _previewImg = null;
    _previewCap = null;
  }

  function onEnter(btn) {
    if (!canHover()) return;
    if (isEditing(btn.parentElement)) return;
    hidePreview();               // only ever one preview/timer
    _hovered = true;
    _activeBtn = btn;
    _timer = setTimeout(function () {
      _timer = 0;
      showPreview(btn);
    }, HOVER_DELAY);
  }

  function onLeave(btn) {
    if (_activeBtn === btn) hidePreview();
  }

  /* ---------- badge ---------- */

  function makeBadge() {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'node-image-badge';
    btn.setAttribute('aria-label', '\u041F\u043E\u043A\u0430\u0437\u0430\u0442\u044C \u0438\u0437\u043E\u0431\u0440\u0430\u0436\u0435\u043D\u0438\u0435');
    btn.title = '';

    var img = document.createElement('img');
    img.alt = '';
    btn.appendChild(img);

    btn._msImageState = { src: '', alt: '' };

    // Keep node dragging/selection untouched: the app starts drags on mousedown
    // (and interactive badges stop propagation the same way, see app.js ~1806).
    btn.addEventListener('mousedown', function (ev) { ev.stopPropagation(); });
    btn.addEventListener('pointerdown', function (ev) { ev.stopPropagation(); });

    btn.addEventListener('mouseenter', function () { onEnter(btn); });
    btn.addEventListener('mouseleave', function () { onLeave(btn); });
    btn.addEventListener('focus', function () { onEnter(btn); });
    btn.addEventListener('blur', function () { onLeave(btn); });

    btn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      hidePreview();
      var st = btn._msImageState;
      var href = st && st.src;
      if (!href) return;
      try { window.open(href, '_blank', 'noopener'); } catch (_e) { /* blocked */ }
    });

    return btn;
  }

  function decorate(el, node, opts) {
    if (!el || !node) return;
    opts = opts || {};

    // Only the compact "icon" display is created here. In 'inline' mode the
    // caller renders the full image itself; still drop a badge left over from a
    // previous icon-mode render of this reused element.
    if (opts.mode !== 'icon') {
      removeBadge(el);
      return;
    }

    var raw = node.image;
    if (!raw) {
      removeBadge(el);
      return;
    }
    // Never hand a javascript:/vbscript: URL to an <img> or window.open.
    if (/^\s*(javascript|vbscript):/i.test(String(raw))) {
      removeBadge(el);
      return;
    }

    var src = resolveSrc(raw);
    var alt = node.imageAlt ? String(node.imageAlt) : '';

    var btn = findBadge(el);
    if (!btn) {
      btn = makeBadge();
      // FIRST child: .node is display:flex (row), so this sits before the
      // marker/text exactly like .node-marker does.
      el.insertBefore(btn, el.firstChild);
    }

    var img = btn.firstElementChild;
    if (img && img.getAttribute('src') !== src) img.src = src;
    if (img && img.alt !== alt) img.alt = alt;

    btn._msImageState = { src: src, alt: alt };
    if (_activeBtn === btn && _previewImg) {
      // Live update if the preview is currently showing this badge.
      _previewImg.dataset.alt = alt;
      if (_previewImg.getAttribute('src') !== src) _previewImg.src = src;
    }
  }

  function cleanup(el) {
    if (!el) return;
    removeBadge(el);
    if (_timer) {
      clearTimeout(_timer);
      _timer = 0;
    }
    hidePreview();
  }

  window.MSNodeImage = {
    decorate: decorate,
    cleanup: cleanup
  };
})();
