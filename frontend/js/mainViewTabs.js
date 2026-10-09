// ── Diamond Hands: main view tab switcher ──────────────────
// External file, not an inline <script>: the site's CSP (script-src 'self' ...) has no
// 'unsafe-inline', so an inline block is silently dropped and the tabs never respond.
//
// Each view loads its data the first time it is wanted. "Wanted" starts at hover or focus, not
// click, so the table is usually filled by the time the click lands. The open view is kept in the
// URL hash (#performance, #tech ...) so a reload or a shared link opens the same view.
(function () {
  var bar = document.querySelector('.main-view-tabs');
  var tabs = Array.prototype.slice.call(document.querySelectorAll('.main-view-tab'));
  if (!bar || !tabs.length) return;

  var panels = {
    diamond: document.getElementById('view-diamond'),
    performance: document.getElementById('view-performance'),
    tech: document.getElementById('view-tech'),
    emerging: document.getElementById('view-emerging'),
    versus: document.getElementById('view-versus')
  };
  var loaded = { diamond: true };

  function pageFor(view) {
    if (view === 'performance' && typeof performancePage !== 'undefined') return performancePage;
    if (view === 'tech' && typeof techPage !== 'undefined') return techPage;
    if (view === 'emerging' && typeof emergingPage !== 'undefined') return emergingPage;
    return null;
  }

  function warm(view) {
    if (loaded[view]) return;
    loaded[view] = true;
    if (view === 'performance' && typeof performancePage !== 'undefined') performancePage.init();
    if (view === 'tech' && typeof techPage !== 'undefined') techPage.init();
    if (view === 'emerging' && typeof emergingPage !== 'undefined') emergingPage.init();
    if (view === 'versus' && typeof versusPage !== 'undefined') versusPage.init();
  }

  // Sliding highlight behind the active tab. Only transform and width change, so it animates on
  // the compositor; without JS the .active tab draws its own background instead.
  var indicator = document.createElement('span');
  indicator.className = 'main-view-indicator';
  indicator.setAttribute('aria-hidden', 'true');
  bar.insertBefore(indicator, bar.firstChild);
  bar.classList.add('has-indicator');

  function placeIndicator(tab, animate) {
    if (!tab) return;
    if (!animate) indicator.style.transition = 'none';
    indicator.style.width = tab.offsetWidth + 'px';
    indicator.style.transform = 'translateX(' + tab.offsetLeft + 'px)';
    if (!animate) {
      void indicator.offsetWidth;
      indicator.style.transition = '';
    }
  }

  function activeTab() {
    for (var i = 0; i < tabs.length; i++) if (tabs[i].classList.contains('active')) return tabs[i];
    return tabs[0];
  }

  function show(view, opts) {
    opts = opts || {};
    var tab = null;
    tabs.forEach(function (t) {
      var on = t.dataset.view === view;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      t.tabIndex = on ? 0 : -1;
      if (on) tab = t;
    });
    if (!tab) return;
    Object.keys(panels).forEach(function (k) {
      if (panels[k]) panels[k].style.display = k === view ? '' : 'none';
    });
    warm(view);
    // vs SOL can come back empty when its first load failed; try again on revisit.
    if (view === 'versus' && typeof versusPage !== 'undefined' && !versusPage._loading &&
        versusPage.tokens && versusPage.tokens.length === 0 && opts.fromUser) {
      versusPage.loadData();
    }
    // The other lazy views load once; after a failed load, a click on the tab tries again
    // (their error messages say so) instead of leaving the error up until a page reload.
    var page = opts.fromUser ? pageFor(view) : null;
    if (page && page._loadFailed && !page._loading) page.loadData();
    placeIndicator(tab, opts.animate !== false);
    if (tab.scrollIntoView && bar.scrollWidth > bar.clientWidth) {
      tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    if (opts.updateHash) {
      var hash = view === 'diamond' ? '' : '#' + view;
      if (location.hash !== hash) history.replaceState(null, '', location.pathname + location.search + hash);
    }
  }

  tabs.forEach(function (tab, i) {
    tab.addEventListener('click', function () {
      show(tab.dataset.view, { fromUser: true, updateHash: true });
    });
    tab.addEventListener('pointerenter', function () { warm(tab.dataset.view); });
    tab.addEventListener('focus', function () { warm(tab.dataset.view); });
    tab.addEventListener('keydown', function (e) {
      var next = null;
      if (e.key === 'ArrowRight') next = tabs[(i + 1) % tabs.length];
      else if (e.key === 'ArrowLeft') next = tabs[(i - 1 + tabs.length) % tabs.length];
      else if (e.key === 'Home') next = tabs[0];
      else if (e.key === 'End') next = tabs[tabs.length - 1];
      if (!next) return;
      e.preventDefault();
      next.focus();
      show(next.dataset.view, { fromUser: true, updateHash: true });
    });
  });

  // Own keys only: a hash like #constructor or #toString would otherwise find an inherited
  // Object.prototype member, match no tab, and leave every tab deselected.
  var fromHash = location.hash.replace('#', '');
  var hashOk = Object.prototype.hasOwnProperty.call(panels, fromHash) && panels[fromHash];
  show(hashOk ? fromHash : 'diamond', { animate: false });

  // Tab widths change when the web font arrives and when the window resizes.
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(function () { placeIndicator(activeTab(), false); });
  }
  var resizeTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { placeIndicator(activeTab(), false); }, 100);
  });
})();
