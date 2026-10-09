// HolDEX Service Worker
// Provides offline support, smart caching, and app-like experience

// v56: two fixes from the Trenches/Curated audit. (1) Authenticated same-origin API responses
// (/api/admin/*, /api/device/*) are no longer written to Cache Storage - the privacy rationale
// NEVER_CACHE_HOSTS documents for the Trenches host applies just as hard to an admin session or
// a device-link identity left on disk of a shared machine, still served after sign-out whenever
// the network hiccups. (2) The whole /trenches/ path is handed back to the browser, not just
// /trenches/assets/: boot-prefetch.js lives at /trenches/boot-prefetch.js with no ?v= and no
// content hash, so the cache-first branch stored it forever and returning visitors kept running
// a script whose warm keys could no longer match what a redeployed client.ts asks for.
// v50: Mobile Connect ships js/deviceLink.js and bumps config.js / wallet.js / conviction.js /
// communityPage.js. A precache list that names stale ?v= URLs is worse than no precache: the SW
// downloads files no page will ever request, and the pages fetch their real versions from the
// network anyway.
// v49: two inline <script> blocks in index.html (the main-view tab switcher and the King of
// the Pill widget) never ran under this site's CSP - script-src has no 'unsafe-inline', so the
// browser silently drops inline scripts with no console error a user would notice. Moved to
// js/mainViewTabs.js and js/kotp.js, which script-src 'self' actually allows to execute.
// v48: the fetch handler no longer takes over cross-origin requests, so any third-party
// responses the previous version stored in DYNAMIC_CACHE need clearing - the activate handler
// below deletes every holdex-* cache that isn't the current version.
// v59: token page redesign - new css/token.css, tokenDetail.js v25, holderBehavior.js v6;
// sentiment.js dropped (no page loads it any more).
// v60: site-wide redesign - styles.css v18, communityPage.js v6, performance.js v25, versus.js v13,
// cultify.js v16, new app icons.
// v61: home token tables redesign - new js/tokenTable.js, styles.css v19, conviction.js v17,
// tech.js v6, emerging.js v6, performance.js v26, versus.js v14, mainViewTabs.js v2.
// v62: token images retry once before falling back - api.js v10, tokenTable.js v2, kotp.js v3,
// tokenDetail.js v26, performance.js v27, versus.js v15.
// v63: logos that are not loadable URLs (GeckoTerminal's "missing.png") fall back at once -
// api.js v11, performance.js v28, versus.js v16, tokenDetail.js v27.
// v64: API tab hidden from the nav (HTML only; api-keys.html still reachable directly).
// v65: conviction bars replaced by a "held 3mo+" cell with a fixed-scale hold-time bar; old scores
// fade after a day instead of carrying a STALE label - styles.css v20, tokenTable.js v3,
// conviction.js v18, versus.js v17.
// v66: token page chart modal - new js/tokenChart.js (loads js/vendor/lightweight-charts-5.2.1.js
// on first open, not precached), token.css v2.
// v67: chart modal gets trendline + Fibonacci tools (new js/chartDrawings.js), phone layout and
// a chart preview card on the token page - tokenChart.js v2, token.css v3.
// v69: in-site Trenches app removed; nav links to trenchscanner.app and Mobile Connect pairs
// HolDEX only - api.js v13, config.js v4, deviceLink.js v3, connectPhone.js v3, linkPage.js v3.
// v70: holder count overhaul - new js/holderChart.js (Holders panel on Lightweight Charts),
// Holders overlay in the chart modal - token.css v4, tokenDetail.js v29, tokenChart.js v3, admin.js v17.
// v71: copy/download chart image buttons (new js/chartShot.js) - token.css v5, tokenChart.js v4, holderChart.js v2.
// v72: holder line labelled on charts and in chart images - chartShot.js v2, tokenChart.js v5, holderChart.js v3, token.css v6.
// v73: diamond hands keeps polling while progress moves - tokenDetail.js v30.
// v74: Diamond Hands table swaps Price and ATH for 24h/7d/30d change, holder velocity arrows -
// styles.css v21, tokenTable.js v4, conviction.js v19.
// v75: token age chip next to token names in the home tables and token page header -
// styles.css v22, token.css v7, api.js v14, tokenTable.js v5, tokenDetail.js v31.
// v76: diamond hands audit fixes (hold-time floors, whole percents, partial render gating) - tokenDetail.js v32.
// v77: King of the Pill is scored daily (tooltip shows score, reign day and contenders) - kotp.js v4, admin.js v18.
// v78: King of the Pill badge on the King's token page and in shared chart images; service worker
// now lists tokenDetail.js v32+ (v77 still cached v31) - token.css v8, tokenDetail.js v33, chartShot.js v3.
// v79: King of the Pill chip beside the King's name in the home tables and community lists -
// styles.css v23, api.js v15, tokenTable.js v6, kotp.js v5, communityPage.js v7.
// v80: Diamond Hands table sorted by the daily score (new Score column); the score counts
// trading activity - styles.css v24, tokenTable.js v7, conviction.js v20, kotp.js v6.
// v81: the Score column is gone again (the order stays) - styles.css v25, tokenTable.js v8, conviction.js v21.
// v82: the King of the Pill tooltip mentions price momentum - kotp.js v7.
// v83: HTML pages are cached in the dynamic cache, and cache trimming never evicts the precached
// app shell (each page view used to trim the static cache to 50, deleting the shell). Bug-audit
// fixes: signed watchlist and sentiment calls, holder and view-count fixes, chart label carry,
// Cultify and Holder Behavior burn gate proof, API key lookup, admin submissions column - api.js v16, watchlist.js v3,
// tokenDetail.js v34, tokenChart.js v6, cultify.js v19, admin.js v20, apiKeys.js v4,
// communityPage.js v9, holderBehavior.js v9. A refused access signature offers "Sign again"
// instead of the burn gate - cultify.js v20, holderBehavior.js v10.
// v84: precache only what index.html and token.html load (no admin/cultify/apiKeys/
// communityPage, no OG banner, no duplicate icon); API responses go to the page before the cache
// write; polled endpoints are not stored. Token page: web3.js loads on the first burn, the holders
// chart builds when scrolled into view, chart refreshes fetch a 100-candle tail, polls pause in
// hidden tabs - api.js v17, conviction.js v22, styles.css v26, new css/home.css, tokenDetail.js v35,
// tokenChart.js v7, holderChart.js v4, holderBehavior.js v11, cultify.js v21, communityPage.js v10.
// v85: holders line color, opacity and own-pane option in the chart modal - token.css v9, tokenChart.js v8.
// v86: share link points at the API's /share, social links http(s) only, price freshness,
// hold-time and diamond-hands poll fixes, UTC date ticks, chart logo fallback without inline
// onerror, holder range revert on failure - tokenDetail.js v36, tokenChart.js v9, holderChart.js v5.
// v86: API fallback copies older than API_CACHE_TTL are no longer served as live data while the
// device is online (an API outage showed hours-old prices as current); offline API misses fail
// like a network error instead of a synthetic 503 that api.js read as "server busy" and backed off
// for a minute; wallet-keyed API reads and image-proxy logos are no longer stored. Cultify and
// wallet audit fixes - config.js v5, api.js v18, deviceLink.js v4, wallet.js v7, watchlist.js v4,
// holderBehavior.js v12, cultify.js v22, apiKeys.js v5, connectPhone.js v4, linkPage.js v4.
// v86: home tab fixes - Watchlist tab conviction, every curated token past the first 100, vs SOL
// podium order and keyboard sorting, retry after a failed tab load, phone ATH columns -
// tokenTable.js v9, conviction.js v23, tech.js v7, emerging.js v7, performance.js v29,
// versus.js v18, mainViewTabs.js v3, home.css v2.
// v88: API key Refresh details signs the 'view' action - apiKeys.js v6.
// v89: share link is https://holdex.live/share/<mint>, and watchlist add/remove no longer ask
// for a wallet signature - api.js v19, watchlist.js v5, tokenDetail.js v37.
const CACHE_VERSION = 'holdex-v89';
// v86: token page keeps '--' for market data a price-only retry can't fill, and Circulating
// subtracts locked and burn-wallet supply - tokenDetail.js v36.
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const DYNAMIC_CACHE = `${CACHE_VERSION}-dynamic`;
const API_CACHE = `${CACHE_VERSION}-api`;

// Core app shell — cached on install for instant loads
// HTML files are intentionally omitted here — they use network-first so users
// always get fresh markup (which references versioned ?v=N asset URLs).
const APP_SHELL = [
  '/css/styles.css?v=26',
  '/css/home.css?v=2',
  '/css/token.css?v=9',
  '/js/config.js?v=5',
  '/js/api.js?v=19',
  '/js/deviceLink.js?v=4',
  '/js/wallet.js?v=7',
  '/js/tokenTable.js?v=10',
  '/js/conviction.js?v=23',
  '/js/tech.js?v=7',
  '/js/emerging.js?v=7',
  '/js/versus.js?v=18',
  '/js/mainViewTabs.js?v=3',
  '/js/kotp.js?v=7',
  '/js/tokenDetail.js?v=37',
  '/js/chartDrawings.js?v=1',
  '/js/chartShot.js?v=3',
  '/js/tokenChart.js?v=9',
  '/js/holderChart.js?v=5',
  '/js/watchlist.js?v=5',
  '/js/holderBehavior.js?v=12',
  '/js/announcements.js?v=2',
  '/js/pwa.js?v=3',
  '/js/performance.js?v=29',
  '/icons/icon.svg',
];

// API patterns that should use network-first strategy
const API_PATTERNS = [
  /\/api\//,
];

// Hosts whose responses must never be written to a cache.
//
// Not the HolDEX API (cultscreener-api.onrender.com): its per-wallet paths are listed in
// PER_WALLET_API_PATTERNS below. TrenchScanner's API (once used by the in-site Trenches app, now moved to trenchscanner.app)
// serves cookie-authenticated, per-user endpoints — /auth/me, /filters, /matches — none of which carry the /api/ prefix
// API_PATTERNS matches on, and all of which are cross-origin. Without this they'd fall
// through to the catch-all network-first branch at the bottom of the fetch handler and be
// stored in DYNAMIC_CACHE: one user's filters and account details left on disk, still served
// after sign-out whenever the network hiccups. Fetched pass-through instead, never stored.
const NEVER_CACHE_HOSTS = [
  'api.holdex.live',
];

// Same-origin API prefixes whose responses are authenticated and must never be stored either.
// The server already sends Cache-Control: no-store on these, but the Cache API ignores HTTP
// caching headers - only this worker's own logic decides what cache.put() persists. An admin's
// stats/curated management data and a phone's device-link identity (/api/device/me returns the
// paired wallet) would otherwise sit in API_CACHE on disk, served after sign-out or revocation
// whenever the network hiccups.
const NEVER_CACHE_PATHS = [
  '/api/admin/',
  '/api/device/',
];

// API endpoints the pages poll. A stored copy is useless offline and every poll would cost a
// Cache Storage write, so they go straight to the network like NEVER_CACHE_PATHS.
const NO_STORE_API_PATTERNS = [
  /^\/api\/tokens\/[^/]+\/holders(\/|$)/,
  /^\/api\/tokens\/[^/]+\/ohlcv/,
  /^\/api\/tokens\/[^/]+\/price$/,
  /^\/api\/cultify\//,
  // Proxied logos: images (up to a few MB) that evicted cached JSON from the 50-entry API_CACHE.
  // The browser's HTTP cache already keeps them.
  /^\/api\/image-proxy/,
];

// API reads keyed by a wallet (watchlist, votes, holdings, paid-utility access, API keys).
// API_PATTERNS matches /api/ on any origin, so without this they were written to Cache Storage
// and left on disk of a shared machine after the wallet disconnected. Passed through, never stored.
const PER_WALLET_API_PATTERNS = [
  /^\/api\/watchlist(\/|$)/,
  /^\/api\/sentiment\//,
  /^\/api\/utilities\//,
  /^\/api\/tokens\/[^/]+\/holder\//,
  /^\/api\/keys(\/|$)/,
];

// Font CDN patterns — cache long-term
// Max entries in dynamic cache
const MAX_DYNAMIC_ENTRIES = 100;
const MAX_API_ENTRIES = 50;

// API cache TTL (5 minutes): how old a stored copy may be and still stand in for a failed
// fetch while the device is online. Offline, any stored copy is better than nothing.
const API_CACHE_TTL = 5 * 60 * 1000;

// ─── Install ─────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then((cache) => {
        // Cache app shell — don't fail install if some resources are missing
        return cache.addAll(APP_SHELL).catch((err) => {
          console.warn('[SW] Some app shell resources failed to cache:', err);
          // Try caching individually so one failure doesn't block all
          return Promise.allSettled(
            APP_SHELL.map((url) => cache.add(url).catch(() => {}))
          );
        });
      })
      .then(() => self.skipWaiting())
  );
});

// ─── Activate ────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith('holdex-') && key !== STATIC_CACHE && key !== DYNAMIC_CACHE && key !== API_CACHE)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
      .then(() => {
        // Notify all open tabs that a new version is active so they can reload
        // to pick up fresh HTML and any updated cached assets.
        return self.clients.matchAll({ type: 'window' }).then((clients) => {
          clients.forEach((client) => client.postMessage({ type: 'SW_UPDATED' }));
        });
      })
  );
});

// ─── Fetch Strategy ──────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests
  if (request.method !== 'GET') return;

  // Skip chrome-extension and other non-http(s) schemes
  if (!url.protocol.startsWith('http')) return;

  // Per-user API responses — straight to the network, never stored. See NEVER_CACHE_HOSTS.
  // Returning without calling respondWith() lets the browser handle the request normally,
  // which also keeps the request's credentials/CORS behaviour exactly as the page intended.
  if (NEVER_CACHE_HOSTS.includes(url.hostname)) return;

  // Authenticated same-origin API paths — same pass-through, for the same privacy reason.
  // Checked before API_PATTERNS, which would otherwise cache them. See NEVER_CACHE_PATHS.
  if (NEVER_CACHE_PATHS.some((prefix) => url.pathname.startsWith(prefix))) return;

  // Polled API endpoints — same pass-through, nothing worth keeping. See NO_STORE_API_PATTERNS.
  if (NO_STORE_API_PATTERNS.some((p) => p.test(url.pathname))) return;

  // Wallet-keyed API reads — same pass-through. See PER_WALLET_API_PATTERNS.
  if (PER_WALLET_API_PATTERNS.some((p) => p.test(url.pathname))) return;

  // API requests â†’ Network First with cache fallback
  if (API_PATTERNS.some((p) => p.test(url.pathname))) {
    event.respondWith(networkFirstWithCache(event, request, API_CACHE, API_CACHE_TTL));
    return;
  }

  // Google Fonts — deliberately NOT intercepted, despite the caching being nice to have.
  //
  // A stylesheet the page loads is checked against style-src, and the font files against
  // font-src; both have allowed the Google Fonts hosts in every version of this site's CSP. But
  // a fetch() issued from this worker is a connection, checked against connect-src - and
  // connect-src is part of the header configuration, which deploys on a different path from this
  // file (a Render Blueprint sync, not a code push). The one time the two drifted, every visitor
  // lost web fonts: this worker's fetch was refused, the request failed outright, and the page
  // fell back to system fonts - while a plain browser load would have worked the whole time.
  // Fonts are cheap, cacheable by the HTTP cache, and cosmetic offline; not worth the coupling.

  // HTML documents â†’ Network First so users always get fresh markup.
  // Fresh HTML references versioned assets (?v=N), ensuring JS/CSS is also fresh
  // after a deployment. Falls back to cache when offline.
  if (request.destination === 'document') {
    // Pages go in DYNAMIC_CACHE: trimming STATIC_CACHE would evict the precached app shell.
    event.respondWith(networkFirstWithCache(event, request, DYNAMIC_CACHE, null, MAX_DYNAMIC_ENTRIES));
    return;
  }

  // Same-origin static assets (JS, CSS, images) â†’ Cache First.
  // Assets use ?v=N versioning in their URLs, so cache-first is safe:
  // a new deployment bumps the version â†’ new URL â†’ fresh cache miss â†’ network fetch.
  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirstWithNetwork(event, request, STATIC_CACHE));
    return;
  }

  // Anything else cross-origin → leave it entirely alone.
  //
  // Not an optimisation; taking these over actively breaks them. A page's CSP checks a
  // subresource against the directive for its *type* - img-src for an image, script-src for a
  // script - but a fetch() issued from this worker is a connection, checked against connect-src
  // instead. Any host allowed to serve images or scripts but absent from connect-src therefore
  // loads fine normally and fails the moment this worker intercepts it.
  //
  // Both were happening: token logos on cdn.dexscreener.com (img-src allows it, connect-src does
  // not) and @solana/web3.js on unpkg.com (script-src allows it, connect-src does not). Neither
  // reports as a page CSP violation, because the refusal happens in this worker's context - the
  // only trace is a "Refused to connect" line attributed to this file.
  //
  // Everything cross-origin worth caching is already routed above (fonts, APIs), and per-user
  // API responses are passed through by NEVER_CACHE_HOSTS. What reached this point was
  // third-party assets that gained nothing from DYNAMIC_CACHE and lost correctness by being here.
  // Returning without respondWith() hands the request back to the browser, which loads it under
  // the directive the page actually intended.
});

// ─── Caching Strategies ──────────────────────────────────

// Cache writes run in event.waitUntil() after the response is handed to the page, so the
// page never waits on Cache Storage. trimCache (a full cache.keys() listing) runs only when
// the put added a new key; overwriting an existing entry cannot grow the cache.
async function cacheFirstWithNetwork(event, request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      const copy = response.clone();
      event.waitUntil((async () => {
        const cache = await caches.open(cacheName);
        await cache.put(request, copy);
        await trimCache(cacheName, MAX_DYNAMIC_ENTRIES);
      })().catch(() => {}));
    }
    return response;
  } catch {
    return offlineFallback(request);
  }
}

async function networkFirstWithCache(event, request, cacheName, ttl, maxEntries = MAX_API_ENTRIES) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const copy = response.clone();
      event.waitUntil((async () => {
        const cache = await caches.open(cacheName);
        const isNew = !(await cache.match(request));
        // Store with timestamp for TTL checking
        const headers = new Headers(copy.headers);
        headers.set('sw-cached-at', Date.now().toString());
        const timedResponse = new Response(await copy.blob(), {
          status: copy.status,
          statusText: copy.statusText,
          headers,
        });
        await cache.put(request, timedResponse);
        if (isNew) await trimCache(cacheName, maxEntries);
      })().catch(() => {}));
    }
    return response;
  } catch {
    // Network failed — try cache
    const cached = await caches.match(request);
    if (cached) {
      // A fetch also throws while the device is online: an API outage whose error page carries
      // no CORS headers, DNS or TLS trouble. A copy past its TTL would then be shown as current
      // data with nothing marking it stale, so it is only served when the device is offline.
      const cachedAt = parseInt(cached.headers.get('sw-cached-at') || '0', 10);
      const offline = !!self.navigator && self.navigator.onLine === false;
      if (!ttl || offline || Date.now() - cachedAt <= ttl) {
        // Trim cache even on fallback path to prevent unbounded growth
        trimCache(cacheName, maxEntries).catch(() => {});
        return cached;
      }
    }
    return offlineFallback(request);
  }
}

// ─── Offline Fallback ────────────────────────────────────

function offlineFallback(request) {
  if (request.destination === 'document') {
    return new Response(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Offline - HolDEX</title>
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body {
            background: #09090b;
            color: #f0f0f2;
            font-family: Inter, system-ui, sans-serif;
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            text-align: center;
            padding: 2rem;
          }
          .offline-container { max-width: 420px; }
          .offline-icon {
            font-size: 4rem;
            margin-bottom: 1.5rem;
            animation: flicker 2s ease-in-out infinite;
          }
          @keyframes flicker {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
          }
          h1 {
            font-size: 1.5rem;
            font-weight: 700;
            margin-bottom: 0.75rem;
            background: linear-gradient(135deg, #e64a19, #ff5722);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
          }
          p {
            color: #a0a0a8;
            line-height: 1.6;
            margin-bottom: 1.5rem;
          }
          button {
            background: linear-gradient(135deg, #e64a19, #ff5722);
            color: white;
            border: none;
            padding: 12px 32px;
            border-radius: 10px;
            font-size: 0.95rem;
            font-weight: 600;
            cursor: pointer;
            transition: transform 0.15s ease, box-shadow 0.15s ease;
          }
          button:hover {
            transform: translateY(-1px);
            box-shadow: 0 8px 24px rgba(255, 87, 34, 0.3);
          }
        </style>
      </head>
      <body>
        <div class="offline-container">
          <div class="offline-icon">💎</div>
          <h1>You're Offline</h1>
          <p>HolDEX needs an internet connection to fetch live Solana data. Check your connection and try again.</p>
          <button onclick="window.location.reload()">Try Again</button>
        </div>
      </body>
      </html>
    `, {
      status: 503,
      headers: { 'Content-Type': 'text/html' },
    });
  }

  // Anything else fails as a network error, which is what the page would have seen with no
  // worker. A synthetic 503 read to api.js as an overloaded server: it started the site-wide
  // 60-second backoff and a 'Server is busy' toast over a few seconds without signal.
  return Response.error();
}

// ─── Cache Management ────────────────────────────────────

const APP_SHELL_PATHS = new Set(APP_SHELL);

async function trimCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  // The precached app shell is never trimmed: offline pages need it.
  const keys = (await cache.keys()).filter((key) => {
    const url = new URL(key.url);
    return !APP_SHELL_PATHS.has(url.pathname + url.search);
  });
  if (keys.length > maxEntries) {
    // Remove oldest entries
    const toDelete = keys.slice(0, keys.length - maxEntries);
    await Promise.all(toDelete.map((key) => cache.delete(key)));
  }
}

// ─── Background Sync (future) ────────────────────────────
// Placeholder for background sync support when watchlist changes are made offline
self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') {
    self.skipWaiting();
  }
});

