require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const crypto = require('crypto');

// ── Startup validation ───────────────────────────────────────────────────────

if (!process.env.ADMIN_PASSWORD) {
  console.error('[Startup] ADMIN_PASSWORD is not set — admin login will always fail');
  if (process.env.NODE_ENV === 'production') {
    throw new Error('ADMIN_PASSWORD environment variable is required');
  }
}

const COOKIE_SECRET = process.env.COOKIE_SECRET;
if (!COOKIE_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('COOKIE_SECRET environment variable is required in production');
  }
  console.warn('[Security] COOKIE_SECRET not set — using ephemeral secret (sessions will not persist across restarts)');
}
const effectiveCookieSecret = COOKIE_SECRET || crypto.randomBytes(32).toString('hex');

if (process.env.NODE_ENV !== 'production' && (process.env.DATABASE_URL || process.env.REDIS_URL)) {
  console.warn('[Startup] WARNING: DATABASE_URL or REDIS_URL is set but NODE_ENV is not "production". Security controls (CORS, HSTS, cookies) are in development mode. Set NODE_ENV=production for production deployments.');
}

// Import routes
const tokenRoutes = require('./routes/tokens');
const watchlistRoutes = require('./routes/watchlist');
const deviceRoutes = require('./routes/device');
const { validateDeviceSession } = require('./middleware/validation');
const healthRoutes = require('./routes/health');
const curatedRoutes = require('./routes/curated');
const adminRoutes = require('./routes/admin');
const sentimentRoutes = require('./routes/sentiment');
const shareRoutes = require('./routes/share');
const cultifyRoutes = require('./routes/cultify');
const apiKeyRoutes = require('./routes/apiKeys');
const publicApiRoutes = require('./routes/public');

// Import middleware
const { defaultLimiter, apiKeyLimiter } = require('./middleware/rateLimit');

// Import database for cleanup jobs
const db = require('./services/database');

// Import job queue for background processing
const jobQueue = require('./services/jobQueue');

const app = express();

// Initialize job queue and schedule background jobs
// Jobs are processed by a separate worker process (src/worker.js)
async function initializeJobQueue() {
  const initialized = jobQueue.initialize();

  if (initialized) {
    await jobQueue.scheduleSessionCleanup();
    // Conviction warming runs in the worker — no setInterval needed in API process
    await jobQueue.scheduleConvictionWarm();
    await jobQueue.scheduleCuratedConvictionWarm();
    await jobQueue.scheduleRefreshCuratedPrices();
    await jobQueue.scheduleRecordHolderCounts();
    console.log('[App] Job queue initialized - background jobs will be handled by worker');
  } else {
    // Fallback: run everything in-process when Redis is unavailable
    console.log('[App] Job queue not available - using in-process fallback');
    startFallbackCleanup();
    startFallbackConvictionWarmers();
  }
}

// Fallback cleanup for when Redis/worker is not available
let cleanupIntervalId = null;
let cleanupFailureCount = 0;
const MAX_CLEANUP_FAILURES = 10;

function startFallbackCleanup() {
  const CLEANUP_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes


  // Schedule periodic cleanup with failure limit
  cleanupIntervalId = setInterval(async () => {
    if (!db.isReady()) {
      cleanupFailureCount++;
      if (cleanupFailureCount >= MAX_CLEANUP_FAILURES) {
        console.error('[Cleanup] Max failures reached, stopping fallback cleanup');
        clearInterval(cleanupIntervalId);
        cleanupIntervalId = null;
      }
      return;
    }

    try {
      await db.cleanupExpiredAdminSessions();
      // Mobile Connect leaves a row behind for every QR that is generated and never scanned -
      // the pairing code lives two minutes, the row lived forever. Activated device sessions are
      // long-lived and are not touched by this; only rows past their own expires_at go.
      await db.cleanupExpiredDeviceSessions();
      cleanupFailureCount = 0; // Reset on success
    } catch (err) {
      cleanupFailureCount++;
      console.error(`[Cleanup] Failed (${cleanupFailureCount}/${MAX_CLEANUP_FAILURES}):`, err.message);
      if (cleanupFailureCount >= MAX_CLEANUP_FAILURES) {
        console.error('[Cleanup] Max failures reached, stopping fallback cleanup');
        clearInterval(cleanupIntervalId);
        cleanupIntervalId = null;
      }
    }
  }, CLEANUP_INTERVAL_MS);
}

// Track fallback interval IDs so they can be cleared on graceful shutdown
let _fallbackIntervalIds = [];

// Fallback conviction warmers for when Redis/worker is not available
function startFallbackConvictionWarmers() {
  // First run after 2 min, then every 10 min
  setTimeout(() => {
    warmConviction();
    const id1 = setInterval(warmConviction, 10 * 60 * 1000);
    _fallbackIntervalIds.push(id1);
  }, 2 * 60 * 1000);

  // First run after 30s, then every hour
  setTimeout(() => {
    warmCuratedConviction();
    const id2 = setInterval(warmCuratedConviction, 60 * 60 * 1000);
    _fallbackIntervalIds.push(id2);
  }, 30 * 1000);
}

// Initialize job queue immediately (no artificial delay needed)
initializeJobQueue().catch(err => {
  console.error('[Startup] Job queue initialization failed:', err.message);
});
const PORT = process.env.PORT || 3000;

// Trust proxy (for Render and other PaaS)
app.set('trust proxy', 1);

// ── Admin route prefix constant ──────────────────────────────────────────────
const ADMIN_ROUTE_PREFIX = '/api/admin';

// CORS configuration
// SECURITY: Properly configure CORS to prevent credential leaks
// In production, only explicitly listed origins are allowed.
// In development/test, a safe localhost default is used.
const allowedOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map(o => o.trim().replace(/\/$/, '')).filter(Boolean)
  : ['http://localhost:3000', 'http://localhost:5173', 'http://127.0.0.1:3000'];

// Alias for backwards-compat references in the block below
const corsOrigins = allowedOrigins;

// Log configured origins at startup so mismatches are visible in Render logs
if (process.env.CORS_ORIGIN) {
  console.log('[CORS] Allowed origins:', corsOrigins);
} else if (process.env.NODE_ENV === 'production') {
  console.warn('[SECURITY WARNING] CORS_ORIGIN not configured in production. All cross-origin requests will be blocked.');
}

// Manual CORS middleware — first in chain, handles both preflight and regular requests.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const normalizedOrigin = origin ? origin.replace(/\/$/, '') : null;

  const allowed = !normalizedOrigin                                  // non-browser / server-to-server
    || corsOrigins.includes(normalizedOrigin);                       // exact match from allowedOrigins list

  if (allowed && normalizedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', normalizedOrigin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Expose-Headers', 'X-Admin-Token');
    res.setHeader('Vary', 'Origin');
  } else if (!allowed) {
    console.warn(`[CORS] Blocked origin: "${origin}" — not in allowed list: [${corsOrigins.join(', ')}]`);
  }

  // Respond to preflight immediately — no further middleware runs
  if (req.method === 'OPTIONS') {
    if (allowed && normalizedOrigin) {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
      // X-Device-Session is what a phone paired via Mobile Connect sends. Omitting it here does
      // not fail loudly: the browser blocks the request at preflight, so every call from a paired
      // phone simply never leaves it.
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Admin-Session, X-Admin-Password, X-API-Key, X-Device-Session');
      res.setHeader('Access-Control-Max-Age', '86400');
    }
    return res.status(204).end();
  }

  next();
});

// Server-Timing middleware: adds 'Server-Timing: proc;dur=X' to every response.
// Only enabled in non-production to avoid leaking processing duration info.
if (process.env.NODE_ENV !== 'production') {
  app.use((req, res, next) => {
    const startMs = Date.now();
    const origEnd = res.end;
    res.end = function (...args) {
      res.end = origEnd;
      try { res.setHeader('Server-Timing', `proc;dur=${Date.now() - startMs}`); } catch (_) {}
      return origEnd.apply(this, args);
    };
    next();
  });
}

// Security headers - protects against common web vulnerabilities
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "https://cdn.jsdelivr.net", "https://unpkg.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "https:", "blob:"],
      connectSrc: ["'self'", "https://api.mainnet-beta.solana.com", "https://*.helius-rpc.com", "https://api.dexscreener.com", "https://api.geckoterminal.com", "https://quote-api.jup.ag"],
      frameSrc: ["'none'"],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null
    }
  },
  frameguard: { action: 'deny' },
  noSniff: true,
  xssFilter: true,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  hsts: process.env.NODE_ENV === 'production' ? {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  } : false,
  hidePoweredBy: true
}));

// Response compression
// Note: Do NOT trust client-supplied X-No-Compression headers — that allows
// clients to force uncompressed responses and waste bandwidth.
app.use(compression({
  level: 6,
  threshold: 1024,
  filter: (req, res) => compression.filter(req, res)
}));

// Request timeout middleware - prevent hung requests
const REQUEST_TIMEOUT = parseInt(process.env.REQUEST_TIMEOUT_MS, 10) || 30000;
// Long-running admin operations (market cap refresh, holder backfills, etc.) need more time
const ADMIN_REQUEST_TIMEOUT = parseInt(process.env.ADMIN_REQUEST_TIMEOUT_MS, 10) || 120000;
app.use((req, res, next) => {
  const timeout = req.path.startsWith(ADMIN_ROUTE_PREFIX + '/') ? ADMIN_REQUEST_TIMEOUT : REQUEST_TIMEOUT;
  req.setTimeout(timeout);
  res.setTimeout(timeout, () => {
    if (!res.headersSent) {
      res.status(503).json({ error: 'Request timeout' });
    }
    req.destroy();
  });
  next();
});

// Request ID middleware - for tracing and debugging
app.use((req, res, next) => {
  req.requestId = crypto.randomBytes(8).toString('hex');
  res.setHeader('X-Request-ID', req.requestId);
  next();
});

// Parse JSON bodies
app.use(express.json({ limit: '100kb' }));

// Cookie parser for session management (signed cookies for tamper detection)
const cookieParser = require('cookie-parser');
app.use(cookieParser(effectiveCookieSecret));

// Request logging
app.use((req, res, next) => {
  if (process.env.NODE_ENV !== 'production') {
    console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  } else {
    // Production: log errors and slow requests only (via response finish)
    const start = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - start;
      if (res.statusCode >= 400 || duration > 5000) {
        console.log(`[${req.requestId}] ${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
      }
    });
  }
  next();
});

// Rate limiting for API routes
app.use('/api/', defaultLimiter);

// Prevent browser HTTP caching of API responses — caching is managed at the app layer via Redis.
// Without this, browsers apply heuristic caching and serve stale responses to fetch() calls.
app.use('/api/', (req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });


// Health check routes (no rate limiting)
app.use('/health', healthRoutes);

// Dedicated rate limiter for lightweight public endpoints (announcements, my-access)
// These hit DB/Redis on every call so deserve a tighter cap than the shared defaultLimiter.
const publicEndpointLimiter = require('express-rate-limit')({
  windowMs: 60000,
  max: 30,
  message: { error: 'Too many requests.' },
  standardHeaders: true,
  legacyHeaders: false
});

// Utility access summary for a wallet (Cultify + Holder Behavior)
// Used by the "My Utilities" modal in the wallet dropdown
app.get('/api/utilities/my-access', publicEndpointLimiter, async (req, res) => {
  const wallet = req.query.wallet;
  const SOLANA_ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  if (!wallet || !SOLANA_ADDR.test(wallet)) return res.json({ cultify: [], holderBehavior: [] });

  try {
    const { cache } = require('./services/cache');
    const CULTIFY_ACCESS_TTL_MS = 43200 * 1000; // 12 hours (matches ACCESS_TOKEN_TTL in cultify.js)

    // Cultify: look up recent burns from DB
    const burns = await db.getCultifyBurnsByWallet(wallet);
    const cultify = burns.map(b => ({
      mint: b.mint,
      expiresAt: new Date(new Date(b.createdAt).getTime() + CULTIFY_ACCESS_TTL_MS).toISOString(),
      type: 'cultify'
    }));

    // Holder Behavior: read wallet index from Redis
    const hbEntries = (await cache.get(`hb:wallet-idx:${wallet}`)) || [];
    const now = Date.now();
    const holderBehavior = hbEntries
      .filter(e => e.expiresAt > now)
      .map(e => ({ mint: e.mint, expiresAt: new Date(e.expiresAt).toISOString(), type: 'holderBehavior' }));

    res.json({ cultify, holderBehavior });
  } catch (err) {
    console.warn('[API] /api/utilities/my-access error:', err.message);
    res.json({ cultify: [], holderBehavior: [] });
  }
});

// Public announcements endpoint (no auth required)
app.get('/api/announcements', publicEndpointLimiter, async (req, res) => {
  try {
    const announcements = await db.getActiveAnnouncements();
    res.json({ announcements });
  } catch (err) {
    console.warn('[API] /api/announcements error:', err.message);
    res.json({ announcements: [] });
  }
});

// Image proxy — fetches token logo images server-side and re-serves them with
// Access-Control-Allow-Origin: * so the frontend can canvas-read cross-origin images, and
// Cross-Origin-Resource-Policy: cross-origin so plain <img src> tags (a no-cors load,
// governed by CORP rather than CORS) can embed it too. Without the latter, Helmet's
// default `Cross-Origin-Resource-Policy: same-origin` on every response blocks the
// frontend (a different origin) from loading it at all — surfacing in the browser as
// net::ERR_BLOCKED_BY_RESPONSE.NotSameOrigin on literally every proxied image, regardless
// of which third-party host it points at.
//
// There is deliberately NO host allowlist here any more.
//
// There used to be, and measured against this project's own Token table it was rejecting 51% of
// all token artwork across 59 distinct hosts - including axiomtrading-v2.axiom-cdn.io, the single
// most common source in the data. That is not a list anybody can keep current: a memecoin's
// metadata points wherever its deployer felt like hosting it that day, and the tail is one-off
// domains and bare IPs. Every miss rendered as a broken image, which reads to a user as "this
// site is broken", not as "that host isn't approved".
//
// What the allowlist was actually protecting was not "only reputable hosts" but "never fetch our
// own infrastructure" - and that is a property of the resolved ADDRESS, not of the name. So it is
// enforced there instead, by the agents in services/safeFetchAgent.js, which refuse to connect to
// private, loopback, link-local (cloud metadata!) or otherwise reserved space, on every
// connection including each redirect hop. Combined with https-only entry, a hard byte cap, an
// image-only content type and this route's rate limiter, that covers open-proxy abuse without
// pretending we can enumerate the internet's image hosts.
const { agentsFor, isBlockedHostLiteral } = require('./services/safeFetchAgent');
// Dedicated rate limiter for image proxy. Every table row's logo now routes through
// this endpoint (not just the old canvas share-image feature), so a single page load
// can legitimately request dozens of distinct images at once — 20/min was sized for
// the old usage and was rejecting normal page loads with 429s.
const imageProxyLimiter = require('express-rate-limit')({
  windowMs: 60000,
  max: 150,
  message: { error: 'Too many image proxy requests.' },
  standardHeaders: true,
  legacyHeaders: false
});
// Server-side cache TTLs — separate from the browser's Cache-Control so repeated
// requests *across all visitors* (not just one browser) reuse a single fetch. This is
// what actually protects against flaky/rate-limited gateways (ipfs.io, Irys, ...): once
// one request warms the cache, every other viewer's <img> is served from Redis instead
// of hammering the origin again.
const IMAGE_PROXY_TTL_MS = 24 * 60 * 60 * 1000;      // 24h — matches the Cache-Control max-age below
/**
 * How long a failure is remembered. Split, because the two kinds are not alike:
 *
 * A 404/410 is a settled fact - that URL has no image and will not grow one - so it is worth
 * remembering for a while to stop re-asking on every page view.
 *
 * Everything else (a 429 from a busy IPFS gateway, a timeout, a connection reset) is a moment in
 * time. The old single 5-minute TTL treated those the same, so one unlucky fetch blanked that
 * token's artwork for EVERY visitor for five minutes - which is a large part of why images looked
 * randomly broken rather than consistently broken.
 */
const IMAGE_PROXY_GONE_TTL_MS = 30 * 60 * 1000;      // 30m — the source really has no image
const IMAGE_PROXY_FAIL_TTL_MS = 45 * 1000;           // 45s — a blip; recover quickly
const IMAGE_PROXY_MAX_BYTES = 3 * 1024 * 1024;       // 3MB — logos/banners only, reject anything larger
const IMAGE_PROXY_CACHE_TIMEOUT_MS = 2000;           // Redis read budget — see withTimeout below

// Token artwork arrives at whatever size the creator uploaded - routinely a 1200px+ PNG of
// several megabytes, for something this UI renders into a 56px avatar or a heavily blurred card
// backdrop. Serving that untouched is the single largest cost of a feed page on a phone, so the
// proxy downsizes once, on the way into the cache, and every visitor thereafter gets the small
// version.
/**
 * The two sizes this proxy serves, and nothing in between.
 *
 * 512 is the list avatar: generous for a 56px tile at 3x. 1024 is the PumpScroll card backdrop,
 * which is full-bleed on a phone and then scaled up further by the card's own transform - at 512
 * that meant upscaling a small image across a whole screen, and the only way to hide it was to
 * blur it into abstraction. Serving a real 1024 is what lets that blur come down to something you
 * can actually recognise the token by.
 */
const IMAGE_PROXY_WIDTHS = new Set([512, 1024]);
const IMAGE_PROXY_DEFAULT_WIDTH = 512;
const IMAGE_PROXY_WEBP_QUALITY = 82;     // visually lossless at these sizes

// sharp is optional on purpose. It is a native module, and if a platform ever fails to build it
// the right outcome is full-size images - not a broken image route. Loaded once here so a missing
// install costs one warning rather than a try/catch per request.
let sharp = null;
try {
  sharp = require('sharp');
} catch {
  console.warn('[ImageProxy] sharp unavailable - serving artwork at original size');
}

// Formats that must pass through untouched: SVG is vector (rasterising it would make it WORSE,
// and larger), and an animated GIF would lose its animation on a naive resize.
const IMAGE_PROXY_PASSTHROUGH = /^image\/(svg\+xml|gif)/i;

/**
 * Downscales to at most `maxDimension` on the long edge and re-encodes as WebP,
 * which is universally supported by any browser able to run this app and typically an order of
 * magnitude smaller than the source PNG.
 *
 * Never enlarges: a 32px logo stays 32px rather than being blown up into a blurry 512.
 * Any failure - unsupported codec, corrupt bytes, sharp missing - returns the ORIGINAL buffer, so
 * the worst case is the behaviour we had before this existed.
 */
async function downscaleImage(buffer, contentType, maxDimension = IMAGE_PROXY_DEFAULT_WIDTH) {
  if (!sharp || IMAGE_PROXY_PASSTHROUGH.test(contentType)) return { buffer, contentType };
  try {
    const out = await sharp(buffer)
      .rotate() // honour EXIF orientation before resizing, or a phone photo comes out sideways
      .resize({
        width: maxDimension,
        height: maxDimension,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: IMAGE_PROXY_WEBP_QUALITY })
      .toBuffer();
    // Guard against the pathological case where re-encoding grows the file (already-tiny or
    // already-WebP sources): keep whichever is smaller.
    if (out.length >= buffer.length) return { buffer, contentType };
    return { buffer: out, contentType: 'image/webp' };
  } catch (err) {
    console.warn('[ImageProxy] resize failed, serving original -', err.message);
    return { buffer, contentType };
  }
}

// Races a promise against a timeout, resolving to `fallback` if the timeout wins.
// Used so a slow/unresponsive Redis can never stall this route long enough to trip
// the app's global request-timeout middleware (which would otherwise surface as a
// 503 from OUR OWN server, not the upstream image host) — worst case we just treat
// it as a cache miss and fetch live.
function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

// In-flight de-dup: many table rows (or many concurrent visitors) can request the
// same not-yet-cached image URL at once — e.g. right after a deploy when the cache is
// cold. Without this, each one triggers its own axios fetch; with it, they all share
// one upstream request instead of stampeding the origin (and each other, via Redis).
const imageProxyInFlight = new Map();

app.get('/api/image-proxy', imageProxyLimiter, async (req, res) => {
  // Set on every response from this route — including the validation/error paths below —
  // not just the successful-image ones. Helmet's default Cross-Origin-Resource-Policy:
  // same-origin otherwise applies to those too, and the browser reports a CORP block on an
  // error JSON response identically to a CORP block on a real image: net::ERR_BLOCKED_BY_
  // RESPONSE.NotSameOrigin either way. Without this, a host missing from the allowlist below
  // (or any other validation failure) looks indistinguishable from the bug this route exists
  // to prevent, instead of a plain, inspectable 403/400.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');

  const { url } = req.query;
  if (!url || typeof url !== 'string') return res.status(400).json({ error: 'url required' });
  let parsed;
  try { parsed = new URL(url); } catch { return res.status(400).json({ error: 'Invalid url' }); }
  if (parsed.protocol !== 'https:') return res.status(400).json({ error: 'https only' });
  // Refused before any fetch is attempted, and unlike the DNS guard this one still applies when
  // the request would leave through an egress proxy - see agentsFor.
  if (isBlockedHostLiteral(parsed.hostname)) return res.status(400).json({ error: 'Invalid url' });

  // Requested width, from a fixed set rather than any integer. Two reasons: an open size
  // parameter multiplies the cache into one entry per width anyone cares to ask for, and it turns
  // a cheap endpoint into a resize-on-demand service. The two sizes are the two real uses - a
  // list avatar and a full-bleed card backdrop.
  const width = IMAGE_PROXY_WIDTHS.has(Number(req.query.w))
    ? Number(req.query.w)
    : IMAGE_PROXY_DEFAULT_WIDTH;

  const { cache } = require('./services/cache');
  // v3: v2 entries are all 512px wide and carry no width in the key, so they would be served for
  // backdrop requests too. Bumping the prefix retires them rather than mixing the two.
  const cacheKey = `image-proxy:v3:${width}:${url}`;

  const cached = await withTimeout(cache.get(cacheKey).catch(() => null), IMAGE_PROXY_CACHE_TIMEOUT_MS, null);
  if (cached) {
    if (cached.notFound) return res.status(502).send('Bad Gateway');
    res.setHeader('Content-Type', cached.contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.send(Buffer.from(cached.data, 'base64'));
  }

  // Share one in-flight fetch across concurrent requests for the same URL AT THE SAME WIDTH -
  // keyed on the cache key rather than the URL, since the two widths produce different bytes.
  let fetchPromise = imageProxyInFlight.get(cacheKey);
  if (!fetchPromise) {
    fetchPromise = (async () => {
      const axios = require('axios');
      const response = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 8000,
        maxContentLength: IMAGE_PROXY_MAX_BYTES,
        maxBodyLength: IMAGE_PROXY_MAX_BYTES,
        // The address guard lives in these. Every hop of a redirect chain opens a new connection
        // through them, so a public URL that bounces to 169.254.169.254 is refused at the hop.
        // Empty where an egress proxy is configured, which axios must be left to handle itself.
        ...agentsFor(),
        maxRedirects: 3,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; HolDEX/1.0)',
          'Accept': 'image/webp,image/png,image/jpeg,image/*',
          'Referer': `https://${parsed.hostname}/`,
        },
      });
      const sourceType = response.headers['content-type'] || 'image/png';
      if (!sourceType.startsWith('image/')) throw new Error(`Non-image response: ${sourceType}`);
      // Downscaled BEFORE the cache write, so the expensive part happens once per image rather
      // than once per request, and every cache hit is already small.
      return downscaleImage(Buffer.from(response.data), sourceType, width);
    })();
    // then(fn, fn) rather than .finally(fn): `.finally` returns a NEW promise that rejects
    // whenever the original does, and nothing was awaiting that one. Every failed image fetch -
    // a dead IPFS link, a 429, a timeout - therefore surfaced as an unhandledRejection, which
    // this process treats as fatal and answers with a graceful shutdown. One bad token logo
    // could restart the entire API. Passing the same cleanup as both handlers settles the
    // derived promise either way.
    const forget = () => imageProxyInFlight.delete(cacheKey);
    fetchPromise.then(forget, forget);
    imageProxyInFlight.set(cacheKey, fetchPromise);
  }

  try {
    const { contentType, buffer } = await fetchPromise;
    // Fire-and-forget — the response doesn't need to wait on the cache write, and a
    // slow Redis write must never be able to stall (or fail) the response itself.
    cache.set(cacheKey, { contentType, data: buffer.toString('base64') }, IMAGE_PROXY_TTL_MS).catch(() => {});

    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(buffer);
  } catch (err) {
    const upstreamStatus = err.response?.status;
    const gone = upstreamStatus === 404 || upstreamStatus === 410;
    console.warn('[ImageProxy] fetch failed for', url, '-', err.message);
    cache
      .set(cacheKey, { notFound: true }, gone ? IMAGE_PROXY_GONE_TTL_MS : IMAGE_PROXY_FAIL_TTL_MS)
      .catch(() => {});
    res.status(502).send('Bad Gateway');
  }
});

// API Routes
app.use('/api/tokens', tokenRoutes);
app.use('/api/watchlist', watchlistRoutes);
// Mobile Connect. The resolver runs ahead of the router (and only for these routes) so
// /api/device/me can answer from the X-Device-Session header; it is deliberately non-blocking,
// so an absent or stale header just means "not linked" rather than an error.
app.use('/api/device', validateDeviceSession, deviceRoutes);
app.use('/api/curated', curatedRoutes);
app.use(ADMIN_ROUTE_PREFIX, adminRoutes);
app.use('/api/sentiment', sentimentRoutes);
app.use('/api/cultify', cultifyRoutes);
app.use('/api/keys', apiKeyRoutes);

// Public API Routes (protected by API key + rate limited)
app.use('/v1', apiKeyLimiter, publicApiRoutes);

// Social media share routes (OG meta tags + OG image)
app.use('/share', shareRoutes);

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    name: 'HolDEX API',
    version: '1.0.0',
    status: 'running',
    docs: '/health/detailed',
    endpoints: {
      tokens: '/api/tokens',
      watchlist: '/api/watchlist',
      sentiment: '/api/sentiment',
      curated: '/api/curated',
      health: '/health',
      share: '/share/:mint'
    }
  });
});

// 404 handler — don't reflect req.path to prevent info leakage
app.use((req, res) => {
  res.status(404).json({
    error: 'Endpoint not found'
  });
});

// Global error handler with request ID tracking and circuit breaker support
app.use((err, req, res, next) => {
  const requestId = req.requestId || 'unknown';
  const timestamp = new Date().toISOString();

  // Log full error details server-side for debugging (with request ID for correlation)
  console.error(`[${timestamp}] [${requestId}] Error:`, err.stack || err.message);

  // Prevent double-response if headers already sent
  if (res.headersSent) {
    return next(err);
  }

  // Categorize errors with safe user-facing messages
  let statusCode = err.status || 500;
  let userMessage = 'Internal server error';
  let errorCode = 'INTERNAL_ERROR';
  let retryAfter = null;

  // Handle circuit breaker errors specially
  if (err.isCircuitBreakerError) {
    statusCode = 503;
    userMessage = 'Service temporarily unavailable';
    errorCode = 'SERVICE_UNAVAILABLE';
    retryAfter = Math.ceil(err.retryAfter / 1000);
  } else if (err.isOverloaded) {
    statusCode = 429;
    userMessage = 'Too many requests - please try again later';
    errorCode = 'RATE_LIMITED';
    retryAfter = err.retryAfter || 30;
  } else if (process.env.NODE_ENV !== 'production') {
    userMessage = err.message;
  } else {
    if (err.message?.includes('not found')) {
      statusCode = 404;
      userMessage = 'Resource not found';
      errorCode = 'NOT_FOUND';
    } else if (err.message?.includes('validation') || err.message?.includes('invalid')) {
      statusCode = 400;
      userMessage = 'Invalid request';
      errorCode = 'VALIDATION_ERROR';
    } else if (err.message?.includes('rate limit') || err.message?.includes('too many') || err.message?.includes('queue full') || err.message?.includes('overloaded')) {
      statusCode = 429;
      userMessage = 'Too many requests - please try again later';
      errorCode = 'RATE_LIMITED';
      retryAfter = err.retryAfter || 30;
    } else if (err.message?.includes('timeout') || err.message?.includes('timed out')) {
      statusCode = 504;
      userMessage = 'Request timed out';
      errorCode = 'TIMEOUT';
    } else if (err.message?.includes('unauthorized') || err.message?.includes('permission')) {
      statusCode = 403;
      userMessage = 'Access denied';
      errorCode = 'FORBIDDEN';
    }
  }

  if (retryAfter) {
    res.setHeader('Retry-After', retryAfter);
  }

  res.status(statusCode).json({
    error: userMessage,
    code: errorCode,
    requestId: requestId,
    timestamp: timestamp,
    ...(retryAfter && { retryAfter }),
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack })
  });
});

// Graceful shutdown — drains HTTP connections before cleanup
let httpServer = null;

async function gracefulShutdown(signal) {
  console.log(`${signal} received. Shutting down gracefully...`);

  const isError = signal === 'uncaughtException' || signal === 'unhandledRejection';
  const exitCode = isError ? 1 : 0;

  // Stop accepting new connections and await in-flight request drain
  if (httpServer) {
    await new Promise(resolve => {
      httpServer.close(() => {
        console.log('[Shutdown] HTTP server closed');
        resolve();
      });
    }).catch(() => {});
  }

  // Force exit after 35 seconds if cleanup takes too long
  const forceTimer = setTimeout(() => {
    console.error('[Shutdown] Forced exit after timeout');
    process.exit(exitCode);
  }, 35000);
  forceTimer.unref();

  // Clear cleanup interval (fallback mode)
  if (cleanupIntervalId) {
    clearInterval(cleanupIntervalId);
    cleanupIntervalId = null;
  }

  // Clear fallback conviction warmer intervals (fallback mode)
  _fallbackIntervalIds.forEach(id => clearInterval(id));
  _fallbackIntervalIds = [];

  // Clear signature replay protection timer
  try {
    const { stopSignatureCleanup } = require('./middleware/validation');
    stopSignatureCleanup();
  } catch (_) {}

  // Shutdown job queue (handles view count flushing internally)
  try {
    await jobQueue.shutdown();
  } catch (err) {
    console.error('[Shutdown] Job queue shutdown error:', err.message);
  }

  // Close database pool
  try {
    const dbPool = db.pool;
    if (dbPool) {
      await dbPool.end();
      console.log('[Shutdown] Database pool closed');
    }
  } catch (err) {
    console.error('[Shutdown] Database pool close error:', err.message);
  }

  // Clear service cache cleanup timers
  try {
    require('./services/jupiter').stopCleanup();
    require('./services/geckoTerminal').stopCleanup();
    require('./services/rateLimiter').stopCleanup();
  } catch (_) {}

  // Destroy HTTP agents
  try {
    const { destroy } = require('./services/httpAgent');
    destroy();
    console.log('[Shutdown] HTTP agents destroyed');
  } catch (err) {
    console.error('[Shutdown] HTTP agent cleanup error:', err.message);
  }

  process.exit(exitCode);
}

// Process error handlers (prevent unhandled crashes)
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err.stack || err.message);
  gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL] Unhandled rejection at:', promise, 'reason:', reason);
  gracefulShutdown('unhandledRejection');
});

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Warm caches for popular tokens after startup to prevent thundering herd on cold restart.
async function warmCache() {
  try {
    const { cache, keys, TTL } = require('./services/cache');
    const geckoService = require('./services/geckoTerminal');
    const topTokens = await db.getMostViewedTokens(20);
    if (!topTokens || topTokens.length === 0) return;

    const needsWarm = [];
    let alreadyCached = 0;
    for (const token of topTokens) {
      const mint = token.token_mint;
      const existing = await cache.get(keys.tokenInfo(mint)) || await cache.get(`batch:${mint}`);
      if (existing) { alreadyCached++; } else { needsWarm.push(mint); }
    }

    let warmed = alreadyCached;
    if (needsWarm.length > 0) {
      try {
        const batchInfo = await geckoService.getMultiTokenInfo(needsWarm);
        for (const mint of needsWarm) {
          if (batchInfo[mint]) {
            await cache.set(`batch:${mint}`, batchInfo[mint], TTL.PRICE_DATA);
            warmed++;
          }
        }
      } catch (_) {
        // Non-critical — tokens will be fetched on first request
      }
    }
    console.log(`[CacheWarm] Warmed ${warmed}/${topTokens.length} top tokens`);
  } catch (err) {
    console.error('[CacheWarm] Failed (non-critical):', err.message);
  }
}

// Periodically trigger diamond-hands computation for popular tokens
// that don't have conviction data yet (or have stale data > 6 hours).
// Runs every 10 minutes, processes up to 3 tokens per cycle to avoid API overload.
let _warmConvictionRunning = false;
async function warmConviction() {
  if (_warmConvictionRunning) return; // Prevent overlap if previous run takes > 10 min
  _warmConvictionRunning = true;
  try {
    const { cache } = require('./services/cache');
    const topTokens = await db.getMostViewedTokens(30);
    if (!topTokens || topTokens.length === 0) return;

    let triggered = 0;
    const MAX_PER_CYCLE = 3;
    const STALE_MS = 6 * 3600000; // 6 hours

    // Batch-fetch DB rows upfront — avoids N sequential getToken queries in the loop
    const allMints = topTokens.map(t => t.token_mint);
    const dbRows = await db.getTokensBatch(allMints).catch(() => []);
    const dbRowMap = {};
    for (const row of dbRows) dbRowMap[row.mint_address] = row;

    // Batch-fetch all cache flags in parallel — avoids N sequential Redis round-trips
    const cacheChecks = await Promise.all(
      allMints.map(async mint => ({
        mint,
        existing: await cache.get(`diamond-hands:${mint}`).catch(() => null),
        pending: await cache.get(`holder-metrics-pending:${mint}`).catch(() => null)
      }))
    );

    for (const { mint, existing, pending } of cacheChecks) {
      if (triggered >= MAX_PER_CYCLE) break;

      // Skip if already cached (fresh)
      if (existing) continue;

      // Skip if already pending
      if (pending) continue;

      // Check DB — skip if computed recently
      const dbRow = dbRowMap[mint];
      if (dbRow && dbRow.conviction_computed_at) {
        const timestamp = new Date(dbRow.conviction_computed_at).getTime();
        if (!isNaN(timestamp) && Date.now() - timestamp < STALE_MS) continue;
      }

      // Trigger directly via job queue — avoids HTTP round-trip through middleware
      try {
        await jobQueue.addAnalyticsJob('compute-holder-analytics', { mint }, { priority: 10 });
        triggered++;
      } catch { /* non-critical */ }
    }

    if (triggered > 0) {
      console.log(`[ConvictionWarm] Triggered diamond-hands for ${triggered} tokens`);
    }
  } catch (err) {
    console.error('[ConvictionWarm] Failed (non-critical):', err.message);
  } finally {
    _warmConvictionRunning = false;
  }
}

// Trigger conviction analysis for all curated tokens.
// Runs on startup (after delay) and every hour.
// Processes tokens that have no conviction data or stale data (>1 hour).
let _warmCuratedRunning = false;
async function warmCuratedConviction() {
  if (_warmCuratedRunning) return; // Prevent overlap if previous run takes > 1 hour
  _warmCuratedRunning = true;
  try {
    const { cache } = require('./services/cache');
    const curatedTokens = await db.getCuratedTokens();
    if (!curatedTokens || curatedTokens.length === 0) return;

    let triggered = 0;
    const STALE_MS = 60 * 60 * 1000; // 1 hour

    // Batch-fetch DB rows upfront — avoids N sequential getToken queries in the loop
    const allMints = curatedTokens.map(t => t.mintAddress || t.mint_address).filter(Boolean);
    const dbRows = await db.getTokensBatch(allMints).catch(() => []);
    const dbRowMap = {};
    for (const row of dbRows) dbRowMap[row.mint_address] = row;

    // Batch-fetch all pending flags in parallel — avoids N sequential Redis round-trips
    const pendingFlags = await Promise.all(
      allMints.map(async mint => ({
        mint,
        pending: await cache.get(`holder-metrics-pending:${mint}`).catch(() => null)
      }))
    );
    const pendingSet = new Set(pendingFlags.filter(e => e.pending).map(e => e.mint));

    for (const token of curatedTokens) {
      const mint = token.mintAddress || token.mint_address;
      if (!mint) continue;

      // Skip if already pending
      if (pendingSet.has(mint)) continue;

      // Skip if conviction was computed recently
      const dbRow = dbRowMap[mint];
      if (dbRow && dbRow.conviction_computed_at) {
        const timestamp = new Date(dbRow.conviction_computed_at).getTime();
        if (!isNaN(timestamp) && Date.now() - timestamp < STALE_MS) continue;
      }

      // Trigger directly via job queue — avoids HTTP round-trip through middleware
      try {
        await jobQueue.addAnalyticsJob('compute-holder-analytics', { mint }, { priority: 10 });
        triggered++;
      } catch { /* non-critical */ }

      // Stagger requests to avoid overloading Helius API
      if (triggered > 0 && triggered % 3 === 0) {
        await new Promise(r => setTimeout(r, 10000));
      }
    }

    if (triggered > 0) {
      console.log(`[CuratedConviction] Triggered diamond-hands for ${triggered}/${curatedTokens.length} curated tokens`);
    }
  } catch (err) {
    console.error('[CuratedConviction] Failed (non-critical):', err.message);
  } finally {
    _warmCuratedRunning = false;
  }
}

// Start server
httpServer = app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════╗
║        HolDEX API Server            ║
╠════════════════════════════════════════════╣
║  Port: ${PORT.toString().padEnd(36)}║
║  Mode: ${(process.env.NODE_ENV || 'development').padEnd(36)}║
║  Status: ${'Ready'.padEnd(34)}║
╚════════════════════════════════════════════╝
  `);

  // Warm cache after server is ready (non-blocking)
  warmCache().catch(err => console.error('[CacheWarm] Startup error:', err.message));
});

module.exports = app;
