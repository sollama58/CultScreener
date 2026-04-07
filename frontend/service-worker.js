// CultScreener Service Worker
// Provides offline support, smart caching, and app-like experience

const CACHE_VERSION = 'cultscreener-v1';
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const DYNAMIC_CACHE = `${CACHE_VERSION}-dynamic`;
const API_CACHE = `${CACHE_VERSION}-api`;

// Core app shell — cached on install for instant loads
const APP_SHELL = [
  '/',
  '/index.html',
  '/token.html',
  '/community.html',
  '/about.html',
  '/css/styles.css',
  '/js/config.js',
  '/js/api.js',
  '/js/wallet.js',
  '/js/conviction.js',
  '/js/tokenDetail.js',
  '/js/watchlist.js',
  '/js/communityPage.js',
  '/js/sentiment.js',
  '/icons/icon.svg',
  '/thisisfine8bit.jpg',
  '/CultScreenerBanner.jpg',
];

// API patterns that should use network-first strategy
const API_PATTERNS = [
  /\/api\//,
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
          .filter((key) => key.startsWith('cultscreener-') && key !== STATIC_CACHE && key !== DYNAMIC_CACHE && key !== API_CACHE)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
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

  // API requests → Network First with cache fallback
  if (API_PATTERNS.some((p) => p.test(url.pathname))) {
    event.respondWith(networkFirstWithCache(request, API_CACHE, API_CACHE_TTL));
    return;
  }

  // Google Fonts → Cache First (long-lived)
  if (FONT_PATTERNS.some((p) => p.test(url.href))) {
    event.respondWith(cacheFirstWithNetwork(request, DYNAMIC_CACHE));
    return;
  }

  // Same-origin static assets → Cache First
  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirstWithNetwork(request, STATIC_CACHE));
    return;
  }

  // Everything else → Network First
  event.respondWith(networkFirstWithCache(request, DYNAMIC_CACHE));
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
        <title>Offline - CultScreener</title>
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
            background: linear-gradient(135deg, #ff5722, #ff9100);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
          }
          p {
            color: #a0a0a8;
            line-height: 1.6;
            margin-bottom: 1.5rem;
          }
          button {
            background: linear-gradient(135deg, #ff5722, #ff3d00);
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
          <div class="offline-icon">🔥</div>
          <h1>You're Offline</h1>
          <p>CultScreener needs an internet connection to fetch live Solana data. Check your connection and try again.</p>
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
