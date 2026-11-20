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
 * Interaction: hovering the badge shows a preview that follows the pointer and
 * goes away on its own; clicking it opens the SAME panel pinned, with a close
 * button and x1.5 / x2 zoom buttons, so it stays put no matter where the mouse
 * goes (and it is the only way to see an attachment on a touch screen). Escape,
 * a click outside it, or the close button dismiss it; ctrl/cmd-click keeps
 * opening the image in a new tab.
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
  var ZOOMS = [1.5, 2];     // pinned panel zoom steps (click the active one to reset)

  var _preview = null;      // singleton <div class="node-image-preview">
  var _previewImg = null;
  var _previewCap = null;
  var _closeBtn = null;     // only shown while the panel is pinned
  var _zoomBar = null;      // x1.5 / x2 controls, pinned panel only
  var _zoom = 1;            // current pinned zoom factor
  var _timer = 0;
  var _activeBtn = null;    // badge the current preview/timer belongs to
  var _hovered = false;
  var _pinned = false;      // opened by a click: stays until dismissed
  var _skipFocusPreview = false;   // one turn: closing must not re-open on the refocus
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
    document.addEventListener('scroll', onViewportChange, { capture: true, passive: true });
    // The canvas zooms on wheel without scrolling anything, which moves the node
    // out from under a pinned panel; re-place it there too.
    document.addEventListener('wheel', onViewportChange, { capture: true, passive: true });
    document.addEventListener('pointerdown', onDocPointerDown, { capture: true, passive: true });
    document.addEventListener('keydown', onKeyDown, false);
    window.addEventListener('resize', onViewportChange, false);
    window.addEventListener('blur', hidePreview, false);
  }

  // A pinned panel follows its badge; a hover preview just goes away.
  function onViewportChange() {
    if (_pinned) {
      applyZoomSize();
      if (_preview && _activeBtn) place(_preview, _activeBtn);
      return;
    }
    hidePreview();
  }

  function onDocPointerDown(ev) {
    if (!_pinned) { hidePreview(); return; }
    var t = ev.target;
    if ((_preview && _preview.contains(t)) || (_activeBtn && _activeBtn.contains(t))) return;
    hidePreview();
  }

  function onKeyDown(ev) {
    if (!ev || (ev.key !== 'Escape' && ev.key !== 'Esc')) return;
    if (_pinned) { closePinned(true); return; }
    hidePreview();
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

    _closeBtn = document.createElement('button');
    _closeBtn.type = 'button';
    _closeBtn.className = 'node-image-preview-close';
    _closeBtn.setAttribute('aria-label', '\u0417\u0430\u043A\u0440\u044B\u0442\u044C');
    _closeBtn.textContent = '\u00D7';
    _closeBtn.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      closePinned(true);
    });

    _zoomBar = document.createElement('div');
    _zoomBar.className = 'node-image-preview-zoom';
    ZOOMS.forEach(function (z) {
      var zb = document.createElement('button');
      zb.type = 'button';
      zb.className = 'node-image-zoom-btn';
      zb.dataset.zoom = String(z);
      zb.textContent = '\u00D7' + z;   // x1.5 / x2
      zb.setAttribute('aria-pressed', 'false');
      zb.setAttribute('aria-label', '\u0423\u0432\u0435\u043B\u0438\u0447\u0438\u0442\u044C \u0432 ' + z + ' \u0440\u0430\u0437\u0430');
      zb.addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        // Click the active step again to drop back to 1x.
        setZoom(_zoom === z ? 1 : z);
      });
      _zoomBar.appendChild(zb);
    });

    _preview.appendChild(_previewImg);
    _preview.appendChild(_previewCap);
    _preview.appendChild(_closeBtn);
    _preview.appendChild(_zoomBar);
    document.body.appendChild(_preview);

    // Clicking the panel (or its close button) must not reach the canvas, where
    // it would deselect the node or start a pan.
    _preview.addEventListener('mousedown', function (ev) { ev.stopPropagation(); });
    _preview.addEventListener('pointerdown', function (ev) { ev.stopPropagation(); });

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

  // Pinned zoom: x1.5 / x2 multiply the image's default (1x) display size, then
  // the result is kept inside the viewport. The stylesheet's caps are cleared
  // inline because the scaled size may exceed the 1x defaults.
  function applyZoomSize() {
    if (!_pinned || !_previewImg) return;
    var nw = _previewImg.naturalWidth || 0;
    var nh = _previewImg.naturalHeight || 0;
    if (!nw || !nh) return;
    var availW = Math.max(80, window.innerWidth - 28);
    var availH = Math.max(80, window.innerHeight - 92);
    // 1x: fit the natural size inside the default box (520px wide, 76vh tall).
    var baseK = Math.min(1, 520 / nw, (0.76 * window.innerHeight) / nh, availW / nw, availH / nh);
    var w = nw * baseK * _zoom;
    var h = nh * baseK * _zoom;
    var k = Math.min(1, availW / w, availH / h);
    _previewImg.style.width = Math.round(w * k) + 'px';
    _previewImg.style.height = Math.round(h * k) + 'px';
    _previewImg.style.maxWidth = 'none';
    _previewImg.style.maxHeight = 'none';
  }

  // Sets the zoom factor and repaints/re-places the pinned panel.
  function setZoom(z) {
    _zoom = (z === 1.5 || z === 2) ? z : 1;
    if (_zoomBar) {
      Array.prototype.forEach.call(_zoomBar.children, function (b) {
        b.setAttribute('aria-pressed', b.dataset.zoom === String(_zoom) ? 'true' : 'false');
      });
    }
    applyZoomSize();
    if (_preview && _activeBtn) place(_preview, _activeBtn);
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

    applyZoomSize();
    place(_preview, _activeBtn);
    _preview.style.visibility = '';
  }

  function showPreview(btn) {
    if (!_hovered || _activeBtn !== btn) return;
    if (!btn.isConnected) return;
    if (!canHover()) return;
    if (isEditing(btn.parentElement)) return;
    if (!btn._msImageState || !btn._msImageState.src) return;

    ensurePreview();
    renderImage(btn);
  }

  // Swap in the badge's current image; the panel stays hidden until it loads so
  // it is never placed at the previous image's size.
  function renderImage(btn) {
    if (!_preview || !_previewImg || !btn) return;
    var st = btn._msImageState || {};
    var token = ++_token;
    _preview.style.visibility = 'hidden';
    _preview.style.left = '0px';
    _preview.style.top = '0px';
    _previewCap.textContent = '';
    _previewCap.style.display = 'none';

    _previewImg.dataset.token = String(token);
    _previewImg.dataset.alt = st.alt || '';
    _previewImg.removeAttribute('src');
    _previewImg.src = st.src || '';

    // Cached/decoded images may never fire `load`; complete covers that.
    if (_previewImg.complete && _previewImg.naturalWidth) finishPreview();
  }

  // Opened by a click: the panel ignores the pointer from then on and only the
  // close button, Escape or a press outside it take it away.
  function openPinned(btn) {
    if (!btn || !btn.isConnected) return;
    var st = btn._msImageState;
    if (!st || !st.src) return;
    if (isEditing(btn.parentElement)) return;
    if (_timer) {
      clearTimeout(_timer);
      _timer = 0;
    }
    _hovered = false;
    _activeBtn = btn;
    _pinned = true;

    ensurePreview();
    _preview.classList.add('pinned');
    _preview.setAttribute('aria-hidden', 'false');
    _preview.setAttribute('role', 'dialog');
    _preview.setAttribute('aria-label', '\u0418\u0437\u043E\u0431\u0440\u0430\u0436\u0435\u043D\u0438\u0435');
    btn.setAttribute('aria-expanded', 'true');
    setZoom(1);
    renderImage(btn);

    try { _closeBtn.focus({ preventScroll: true }); }
    catch (_e) { try { _closeBtn.focus(); } catch (_e2) { /* not focusable */ } }
  }

  function closePinned(returnFocus) {
    if (!_pinned) return false;
    var btn = _activeBtn;
    // Returning focus to the badge fires its `focus` handler, which would open a
    // hover preview again 220ms later; skip that one turn.
    _skipFocusPreview = !!returnFocus;
    hidePreview();
    if (returnFocus && btn && btn.isConnected) {
      try { btn.focus({ preventScroll: true }); }
      catch (_e) { try { btn.focus(); } catch (_e2) { /* gone */ } }
    }
    setTimeout(function () { _skipFocusPreview = false; }, 0);
    return true;
  }

  function hidePreview() {
    var btn = _activeBtn;
    _hovered = false;
    _pinned = false;
    _activeBtn = null;
    _token++;
    if (_timer) {
      clearTimeout(_timer);
      _timer = 0;
    }
    if (btn && btn.isConnected) btn.setAttribute('aria-expanded', 'false');
    if (_preview && _preview.parentNode) _preview.parentNode.removeChild(_preview);
    _preview = null;
    _previewImg = null;
    _previewCap = null;
    _closeBtn = null;
    _zoomBar = null;
    _zoom = 1;
  }

  function onEnter(btn) {
    if (!canHover()) return;
    if (_pinned) return;         // a pinned panel owns the badge until dismissed
    if (_skipFocusPreview) return;
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
    if (_pinned && _activeBtn === btn) return;
    if (_activeBtn === btn) hidePreview();
  }

  /* ---------- badge ---------- */

  function makeBadge() {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'node-image-badge';
    btn.setAttribute('aria-label', '\u041F\u043E\u043A\u0430\u0437\u0430\u0442\u044C \u0438\u0437\u043E\u0431\u0440\u0430\u0436\u0435\u043D\u0438\u0435');
    btn.setAttribute('aria-haspopup', 'dialog');
    btn.setAttribute('aria-expanded', 'false');
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
      ev.preventDefault();
      var st = btn._msImageState;
      var href = st && st.src;
      if (!href) return;
      // Ctrl/cmd-click keeps the browser habit of opening the image in a tab.
      if (ev.ctrlKey || ev.metaKey || ev.shiftKey) {
        hidePreview();
        try { window.open(href, '_blank', 'noopener'); } catch (_e) { /* blocked */ }
        return;
      }
      if (_pinned && _activeBtn === btn) { closePinned(true); return; }
      openPinned(btn);
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
