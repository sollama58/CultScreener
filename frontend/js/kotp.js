// ── King of the Pill widget ─────────────────────────────────
// Same CSP bug as mainViewTabs.js: an inline <script> block, silently never
// executed under this site's script-src 'self' policy. Moved out for the same
// reason - this file loading is now what actually populates #kotp-wrap.
(function () {
  var wrap = document.getElementById('kotp-wrap');
  if (!wrap) return;

  var apiBase = (typeof API_BASE_URL !== 'undefined') ? API_BASE_URL : '';

  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function fmtChange(v) {
    if (v == null) return { text: '', cls: 'na' };
    var sign = v >= 0 ? '+' : '';
    return { text: sign + v.toFixed(2) + '% 24h', cls: v >= 0 ? 'pos' : 'neg' };
  }

  // The automatic King is the top daily Diamond Hands score (services/kingOfPill.js);
  // a hand-picked override keeps the original wording.
  function tooltipText(token) {
    var k = token.kotp;
    if (!k || k.mode !== 'auto') {
      return 'King of the Pill is chosen by the most-raided community token, including their HolDEX link. Winner determined by ASDF CultRaid Tech.';
    }
    var parts = ['King of the Pill goes to the curated token with the strongest Diamond Hands score: how long its holders have held, judged against what its age makes possible, with a bonus for holders sticking around, for trading activity (24h volume, and volume against market cap) and for price momentum over 24h, 7d and 30d.'];
    var reign = [];
    if (k.score != null) reign.push('Score ' + Number(k.score).toFixed(1));
    if (k.reignDay) reign.push('day ' + k.reignDay + ' of its reign');
    if (reign.length) parts.push(esc(reign.join(', ')) + '.');
    if (k.contenders && k.contenders.length) {
      parts.push('Next in line: ' + k.contenders.map(function (c) {
        var label = c.symbol ? '$' + c.symbol : (c.name || '?');
        return esc(label) + (c.score != null ? ' (' + Number(c.score).toFixed(1) + ')' : '');
      }).join(', ') + '.');
    }
    parts.push('Scores update once a day and the crown moves every few days.');
    return parts.join(' ');
  }

  function render(token) {
    if (!token) { wrap.innerHTML = ''; return; }
    // Through the image proxy, like every other logo on the site. Hotlinked straight from the
    // source this 403s on ipfs.io and other hotlink-blocking gateways, and cross-origin
    // resource policies block what does come back - the proxy fetches and re-serves it from our
    // own domain once, so only the first request after the cache expires touches the origin.
    var raw = token.logoUri || '';
    var logo = (typeof utils !== 'undefined' && utils.proxyImageUrl) ? utils.proxyImageUrl(raw) : raw;
    var chg  = fmtChange(token.priceChange24h);
    var mint = token.mintAddress || '';
    var name = esc(token.name || token.symbol || '');
    var sym  = esc(token.symbol || '');
    var el   = document.createElement('a');
    el.className  = 'kotp-widget';
    el.href       = 'token.html?mint=' + encodeURIComponent(mint);
    el.innerHTML  =
      '<span class="kotp-badge">💊 King of the Pill</span>' +
      '<span class="kotp-divider"></span>' +
      (logo ? '<img class="kotp-logo" src="' + esc(logo) + '" alt="">' : '') +
      '<span class="kotp-info">' +
        '<span class="kotp-name">' + name + '</span>' +
        (sym ? '<span class="kotp-symbol">$' + sym + '</span>' : '') +
      '</span>' +
      (chg.text ? '<span class="kotp-change ' + chg.cls + '">' + chg.text + '</span>' : '') +
      '<span class="kotp-tooltip-wrap">' +
        '<i class="kotp-tooltip-icon">?</i>' +
      '</span>' +
      '<span class="kotp-tooltip-box">' + tooltipText(token) + '</span>';
    wrap.innerHTML = '';
    var row = document.createElement('div');
    row.className = 'kotp-row';
    row.appendChild(el);
    // Share image of the King (js/kotpShot.js), beside the banner rather than inside the link
    if (typeof kotpShot !== 'undefined' && typeof chartShot !== 'undefined') {
      var shareBtn = document.createElement('button');
      shareBtn.type = 'button';
      shareBtn.className = 'kotp-share-btn';
      shareBtn.title = 'Share the King of the Pill';
      shareBtn.setAttribute('aria-label', 'Share the King of the Pill');
      shareBtn.setAttribute('aria-haspopup', 'dialog');
      shareBtn.innerHTML = SHARE_ICON + '<span>Share</span>';
      shareBtn.addEventListener('click', function () { openShare(token, shareBtn); });
      row.appendChild(shareBtn);
    }
    wrap.appendChild(row);

    // Attached rather than written as an onerror="" attribute. The page's CSP has no
    // 'unsafe-inline' or 'unsafe-hashes' in script-src, so an inline event handler is refused
    // outright - the widget logged a violation on every render and, when a logo really did fail,
    // kept the browser's broken-image icon instead of hiding it.
    var logoEl = el.querySelector('.kotp-logo');
    if (logoEl) {
      logoEl.addEventListener('error', function () {
        // One retry first (see utils.handleImageError), with the default logo shown while it waits.
        if (typeof utils !== 'undefined' && utils.retryProxiedImage &&
            utils.retryProxiedImage(this, utils.getDefaultLogo())) return;
        this.style.display = 'none';
      });
    }

    var box  = el.querySelector('.kotp-tooltip-box');
    var icon = el.querySelector('.kotp-tooltip-icon');

    function positionTooltip() {
      var r = el.getBoundingClientRect();
      box.style.top  = (r.bottom + 8) + 'px';
      var rightEdge = window.innerWidth - r.right;
      if (rightEdge + 240 > window.innerWidth - 8) {
        box.style.left  = '8px';
        box.style.right = 'auto';
      } else {
        box.style.right = Math.max(8, rightEdge) + 'px';
        box.style.left  = 'auto';
      }
    }

    el.addEventListener('mouseenter', positionTooltip);

    icon.addEventListener('touchstart', function (e) {
      e.preventDefault();
      e.stopPropagation();
      var isOpen = el.classList.toggle('kotp-tt-open');
      if (isOpen) positionTooltip();
    }, { passive: false });

    document.addEventListener('touchstart', function (e) {
      if (!el.contains(e.target)) el.classList.remove('kotp-tt-open');
    }, { passive: true });
  }

  var SHARE_ICON = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>';
  var MODE_KEY = 'holdex.kotpShareMode';

  function savedMode() {
    try { return localStorage.getItem(MODE_KEY) === 'podium' ? 'podium' : 'king'; } catch (e) { return 'king'; }
  }

  // holdex.live/share/<mint> unfurls with the token's preview card and sends people on to its
  // page (see tokenDetail.js). Local dev has no /share rewrite, so it links the API directly.
  function shareLink(mint) {
    var isLocal = /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname);
    return (isLocal ? apiBase : 'https://holdex.live') + '/share/' + encodeURIComponent(mint);
  }

  // The share dialog: a preview of the image, King only or King + runners-up, and copy,
  // download, native share (phones) and copy link.
  function openShare(token, opener) {
    var withRunners = kotpShot.hasRunners(token);
    var mode = withRunners ? savedMode() : 'king';
    var sym = token.symbol ? '$' + token.symbol : (token.name || 'the King');
    var who = { name: token.name, symbol: token.symbol };
    var canFiles = false;
    try {
      canFiles = !!(navigator.canShare && typeof File !== 'undefined' &&
        navigator.canShare({ files: [new File([''], 'k.png', { type: 'image/png' })] }));
    } catch (e) { canFiles = false; }

    var overlay = document.createElement('div');
    overlay.className = 'kotp-share-overlay';
    overlay.innerHTML =
      '<div class="kotp-share-panel" role="dialog" aria-modal="true" aria-labelledby="kotp-share-title">' +
        '<div class="kotp-share-head">' +
          '<h2 id="kotp-share-title">Share the King of the Pill</h2>' +
          '<button type="button" class="kotp-share-close" aria-label="Close">&times;</button>' +
        '</div>' +
        (withRunners
          ? '<div class="kotp-share-toggle" role="group" aria-label="What the image shows">' +
              '<button type="button" data-mode="king">King only</button>' +
              '<button type="button" data-mode="podium">King + runners-up</button>' +
            '</div>'
          : '') +
        '<div class="kotp-share-preview" aria-live="polite"><span class="kotp-share-loading">Drawing the image…</span></div>' +
        '<div class="kotp-share-actions">' +
          '<button type="button" class="kotp-share-action primary" data-act="copy">' + chartShot.ICONS.copy + '<span>Copy image</span></button>' +
          '<button type="button" class="kotp-share-action" data-act="download">' + chartShot.ICONS.download + '<span>Download</span></button>' +
          (canFiles ? '<button type="button" class="kotp-share-action" data-act="native">' + SHARE_ICON + '<span>Share…</span></button>' : '') +
          '<button type="button" class="kotp-share-action" data-act="link">' + LINK_ICON + '<span>Copy link</span></button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);
    document.body.classList.add('kotp-share-open');

    var preview = overlay.querySelector('.kotp-share-preview');
    var canvas = null;
    var drawing = null;
    var seq = 0;

    function draw() {
      var mine = ++seq;
      overlay.querySelectorAll('[data-mode]').forEach(function (b) {
        b.setAttribute('aria-pressed', b.dataset.mode === mode ? 'true' : 'false');
      });
      drawing = kotpShot.render(token, mode).then(function (c) {
        if (mine !== seq) return c;
        canvas = c;
        c.className = 'kotp-share-canvas';
        c.setAttribute('role', 'img');
        c.setAttribute('aria-label', mode === 'podium'
          ? 'King of the Pill image: ' + sym + ' with the two runners-up'
          : 'King of the Pill image: ' + sym);
        preview.innerHTML = '';
        preview.appendChild(c);
        return c;
      });
      return drawing;
    }

    // The blob for the image on screen (the drawing in flight when the toggle just moved)
    function make() {
      return drawing.then(function (c) { return kotpShot.toBlob(c || canvas); });
    }

    function kind() { return mode === 'podium' ? 'king-of-the-pill-top3' : 'king-of-the-pill'; }

    function close() {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      document.body.classList.remove('kotp-share-open');
      if (opener) opener.focus();
    }

    function onKey(e) {
      if (e.key === 'Escape') close();
    }

    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) return close();
      var t = e.target.closest('button');
      if (!t) return;
      if (t.classList.contains('kotp-share-close')) return close();
      if (t.dataset.mode && t.dataset.mode !== mode) {
        mode = t.dataset.mode;
        try { localStorage.setItem(MODE_KEY, mode); } catch (err) { /* private mode */ }
        draw();
        return;
      }
      var act = t.dataset.act;
      if (act === 'copy') chartShot.copy(make, kind(), { what: 'King of the Pill image', token: who });
      else if (act === 'download') chartShot.download(make, kind(), { what: 'King of the Pill image', token: who });
      else if (act === 'link') utils.copyToClipboard(shareLink(token.mintAddress || ''), false).then(function (ok) {
        if (ok && typeof toast !== 'undefined') toast.success('Share link copied');
      });
      else if (act === 'native') {
        make().then(function (blob) {
          var file = new File([blob], chartShot.filename(kind(), who), { type: 'image/png' });
          return navigator.share({ files: [file], title: 'King of the Pill: ' + sym, text: sym + ' is King of the Pill on HolDEX', url: shareLink(token.mintAddress || '') });
        }).catch(function (err) {
          if (err && err.name === 'AbortError') return;
          console.warn('[kotp] share failed:', err && err.message);
          if (typeof toast !== 'undefined') toast.error('Could not share the image');
        });
      }
    });
    document.addEventListener('keydown', onKey);

    draw().catch(function (err) {
      console.warn('[kotp] share image failed:', err);
      preview.innerHTML = '<span class="kotp-share-loading">Could not draw the image</span>';
    });
    var first = overlay.querySelector('[data-mode="' + mode + '"]') || overlay.querySelector('[data-act="copy"]');
    if (first) first.focus();
  }

  var LINK_ICON = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>';

  // One request shared with the table chips (tokenTable.js) when api.js is loaded
  var pending = (typeof api !== 'undefined' && api.kingOfPill)
    ? api.kingOfPill()
    : fetch(apiBase + '/api/tokens/king-of-pill')
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) { return d ? d.token : null; });
  pending.then(function (token) { if (token) render(token); }).catch(function () {});
})();
