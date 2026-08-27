// ── Diamond Hands: main view tab switcher ──────────────────
// Was an inline <script> block - the site's CSP (script-src 'self' ...) has no
// 'unsafe-inline', so every inline script is silently dropped by the browser: no
// console error a user would notice, no exception, the click listeners this IIFE
// attaches simply never existed. That's why Performance/Tech/Emerging/vs SOL never
// responded to a click - moved to an external file so script-src 'self' actually
// allows it to run, same as every other page behaviour in this app.
(function () {
  var tabs = document.querySelectorAll('.main-view-tab');
  var panels = {
    diamond: document.getElementById('view-diamond'),
    performance: document.getElementById('view-performance'),
    tech: document.getElementById('view-tech'),
    emerging: document.getElementById('view-emerging'),
    versus: document.getElementById('view-versus')
  };
  var perfLoaded = false;
  var techLoaded = false;
  var emergingLoaded = false;
  var versusLoaded = false;

  tabs.forEach(function (tab) {
    tab.addEventListener('click', function () {
      var view = tab.dataset.view;
      tabs.forEach(function (t) {
        t.classList.remove('active');
        t.setAttribute('aria-selected', 'false');
      });
      tab.classList.add('active');
      tab.setAttribute('aria-selected', 'true');
      Object.keys(panels).forEach(function (k) {
        if (panels[k]) panels[k].style.display = k === view ? '' : 'none';
      });
      if (view === 'performance' && !perfLoaded) {
        perfLoaded = true;
        if (typeof performancePage !== 'undefined') performancePage.init();
      }
      if (view === 'tech' && !techLoaded) {
        techLoaded = true;
        if (typeof techPage !== 'undefined') techPage.init();
      }
      if (view === 'emerging' && !emergingLoaded) {
        emergingLoaded = true;
        if (typeof emergingPage !== 'undefined') emergingPage.init();
      }
      if (view === 'versus') {
        if (!versusLoaded) {
          versusLoaded = true;
          if (typeof versusPage !== 'undefined') versusPage.init();
        } else if (typeof versusPage !== 'undefined' && !versusPage._loading && versusPage.tokens.length === 0) {
          versusPage.loadData();
        }
      }
    });
  });
})();
