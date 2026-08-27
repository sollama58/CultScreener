// HolDEX Service Worker
// Provides offline support, smart caching, and app-like experience

// v48: the fetch handler no longer takes over cross-origin requests, so any third-party
// responses the previous version stored in DYNAMIC_CACHE need clearing - the activate handler
// below deletes every holdex-* cache that isn't the current version.
const CACHE_VERSION = 'holdex-v48';
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const DYNAMIC_CACHE = `${CACHE_VERSION}-dynamic`;
const API_CACHE = `${CACHE_VERSION}-api`;

// Core app shell — cached on install for instant loads
// HTML files are intentionally omitted here — they use network-first so users
// always get fresh markup (which references versioned ?v=N asset URLs).
const APP_SHELL = [
  '/css/styles.css?v=15',
  '/js/config.js?v=2',
  '/js/api.js?v=7',
  '/js/wallet.js?v=2',
  '/js/conviction.js?v=14',
  '/js/tech.js?v=5',
  '/js/emerging.js?v=5',
  '/js/versus.js?v=9',
  '/js/tokenDetail.js?v=21',
  '/js/watchlist.js?v=2',
  '/js/communityPage.js?v=3',
  '/js/sentiment.js?v=2',
  '/js/holderBehavior.js?v=4',
  '/js/announcements.js?v=2',
  '/js/pwa.js?v=3',
  '/js/performance.js?v=20',
  '/js/cultify.js?v=12',
  '/js/admin.js?v=15',
  '/js/apiKeys.js?v=2',
  '/icons/icon.svg',
  '/thisisfine8bit.jpg',
  '/CultScreenerBanner.jpg',
];

// API patterns that should use network-first strategy
const API_PATTERNS = [
  /\/api\//,
];

// Hosts whose responses must never be written to a cache.
//
// The Trenches app (/trenches/) talks to its own backend with cookie-authenticated,
// per-user endpoints — /auth/me, /filters, /matches — none of which carry the /api/ prefix
// API_PATTERNS matches on, and all of which are cross-origin. Without this they'd fall
// through to the catch-all network-first branch at the bottom of the fetch handler and be
// stored in DYNAMIC_CACHE: one user's filters and account details left on disk, still served
// after sign-out whenever the network hiccups. Fetched pass-through instead, never stored.
const NEVER_CACHE_HOSTS = [
  'api.holdex.live',
];

// Font CDN patterns — cache long-term
const FONT_PATTERNS = [
  /fonts\.googleapis\.com/,
  /fonts\.gstatic\.com/,
];

// Max entries in dynamic cache
const MAX_DYNAMIC_ENTRIES = 100;
const MAX_API_ENTRIES = 50;

// API cache TTL (5 minutes)
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

  // API requests â†’ Network First with cache fallback
  if (API_PATTERNS.some((p) => p.test(url.pathname))) {
    event.respondWith(networkFirstWithCache(request, API_CACHE, API_CACHE_TTL));
    return;
  }

  // Google Fonts â†’ Cache First (long-lived)
  if (FONT_PATTERNS.some((p) => p.test(url.href))) {
    event.respondWith(cacheFirstWithNetwork(request, DYNAMIC_CACHE));
    return;
  }

  // HTML documents â†’ Network First so users always get fresh markup.
  // Fresh HTML references versioned assets (?v=N), ensuring JS/CSS is also fresh
  // after a deployment. Falls back to cache when offline.
  if (request.destination === 'document') {
    event.respondWith(networkFirstWithCache(request, STATIC_CACHE));
    return;
  }

  // Same-origin static assets (JS, CSS, images) â†’ Cache First.
  // Assets use ?v=N versioning in their URLs, so cache-first is safe:
  // a new deployment bumps the version â†’ new URL â†’ fresh cache miss â†’ network fetch.
  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirstWithNetwork(request, STATIC_CACHE));
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

async function cacheFirstWithNetwork(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
      await trimCache(cacheName, MAX_DYNAMIC_ENTRIES);
    }
    return response;
  } catch {
    return offlineFallback(request);
  }
}

async function networkFirstWithCache(request, cacheName, ttl) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      // Store with timestamp for TTL checking
      const headers = new Headers(response.headers);
      headers.set('sw-cached-at', Date.now().toString());
      const timedResponse = new Response(await response.clone().blob(), {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
      cache.put(request, timedResponse);
      await trimCache(cacheName, MAX_API_ENTRIES);
    }
    return response;
  } catch {
    // Network failed — try cache
    const cached = await caches.match(request);
    if (cached) {
      // Check TTL if specified
      if (ttl) {
        const cachedAt = parseInt(cached.headers.get('sw-cached-at') || '0');
        if (Date.now() - cachedAt > ttl) {
          // Stale but better than nothing when offline
          return cached;
        }
      }
      // Trim cache even on fallback path to prevent unbounded growth
      trimCache(cacheName, MAX_API_ENTRIES).catch(() => {});
      return cached;
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

  return new Response('Offline', { status: 503 });
}

// ─── Cache Management ────────────────────────────────────

async function trimCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
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

