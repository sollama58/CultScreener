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

  function render(token) {
    if (!token) { wrap.innerHTML = ''; return; }
    var logo = token.logoUri || '';
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
      (logo ? '<img class="kotp-logo" src="' + esc(logo) + '" alt="" onerror="this.style.display=\'none\'">' : '') +
      '<span class="kotp-info">' +
        '<span class="kotp-name">' + name + '</span>' +
        (sym ? '<span class="kotp-symbol">$' + sym + '</span>' : '') +
      '</span>' +
      (chg.text ? '<span class="kotp-change ' + chg.cls + '">' + chg.text + '</span>' : '') +
      '<span class="kotp-tooltip-wrap">' +
        '<i class="kotp-tooltip-icon">?</i>' +
      '</span>' +
      '<span class="kotp-tooltip-box">King of the Pill is chosen by the most-raided community token, including their HolDEX link. Winner determined by ASDF CultRaid Tech.</span>';
    wrap.innerHTML = '';
    wrap.appendChild(el);

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

  fetch(apiBase + '/api/tokens/king-of-pill')
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) { if (d) render(d.token); })
    .catch(function () {});
})();
