require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const crypto = require('crypto');

// Import routes
const tokenRoutes = require('./routes/tokens');
const watchlistRoutes = require('./routes/watchlist');
const healthRoutes = require('./routes/health');
const curatedRoutes = require('./routes/curated');
const adminRoutes = require('./routes/admin');
const sentimentRoutes = require('./routes/sentiment');
const shareRoutes = require('./routes/share');
const cultifyRoutes = require('./routes/cultify');

// Import middleware
const { defaultLimiter } = require('./middleware/rateLimit');

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
    // Schedule recurring session cleanup (runs every hour via worker)
    await jobQueue.scheduleSessionCleanup();
    console.log('[App] Job queue initialized - background jobs will be handled by worker');
  } else {
    // Fallback: Run cleanup in main process if Redis not available
    console.log('[App] Job queue not available - using in-process cleanup');
    startFallbackCleanup();
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

// Initialize job queue after a short delay (allow DB/Redis to connect)
setTimeout(() => initializeJobQueue().catch(err => console.error('[App] Job queue init failed:', err.message)), 5000);
const PORT = process.env.PORT || 3000;

// Trust proxy (for Render and other PaaS)
app.set('trust proxy', 1);

// CORS configuration
// SECURITY: Properly configure CORS to prevent credential leaks
const corsOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map(o => o.trim().replace(/\/$/, '')).filter(Boolean)
  : [];

// Log configured origins at startup so mismatches are visible in Render logs
if (corsOrigins.length > 0) {
  console.log('[CORS] Allowed origins:', corsOrigins);
} else if (process.env.NODE_ENV === 'production') {
  console.warn('[SECURITY WARNING] CORS_ORIGIN not configured in production. All cross-origin requests will be blocked.');
}

// Manual CORS middleware — first in chain, handles both preflight and regular requests.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const normalizedOrigin = origin ? origin.replace(/\/$/, '') : null;

  const allowed = !normalizedOrigin                                  // non-browser / server-to-server
    || process.env.NODE_ENV !== 'production'                         // development: allow all
    || corsOrigins.includes(normalizedOrigin);                       // production: exact match

  if (allowed && normalizedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', normalizedOrigin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  } else if (!allowed) {
    console.warn(`[CORS] Blocked origin: "${origin}" — not in allowed list: [${corsOrigins.join(', ')}]`);
  }

  // Respond to preflight immediately — no further middleware runs
  if (req.method === 'OPTIONS') {
    console.log(`[CORS] Preflight: origin="${origin}" allowed=${allowed} corsOrigins=${JSON.stringify(corsOrigins)}`);
    if (allowed && normalizedOrigin) {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Admin-Session, X-Admin-Password');
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
app.use(compression({
  level: 6,
  threshold: 1024,
  filter: (req, res) => {
    if (req.headers['x-no-compression']) return false;
    return compression.filter(req, res);
  }
}));

// Request timeout middleware - prevent hung requests
const REQUEST_TIMEOUT = parseInt(process.env.REQUEST_TIMEOUT_MS, 10) || 30000;
app.use((req, res, next) => {
  req.setTimeout(REQUEST_TIMEOUT);
  res.setTimeout(REQUEST_TIMEOUT, () => {
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
if (!process.env.COOKIE_SECRET) {
  console.warn('[SECURITY] COOKIE_SECRET is not set — sessions will not persist across restarts');
}
app.use(cookieParser(process.env.COOKIE_SECRET || crypto.randomBytes(32).toString('hex')));

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


// Health check routes (no rate limiting)
app.use('/health', healthRoutes);

// API Routes
app.use('/api/tokens', tokenRoutes);
app.use('/api/watchlist', watchlistRoutes);
app.use('/api/curated', curatedRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/sentiment', sentimentRoutes);
app.use('/api/cultify', cultifyRoutes);

// Social media share routes (OG meta tags + OG image)
app.use('/share', shareRoutes);

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    name: 'CultScreener API',
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
async function warmConviction() {
  try {
    const { cache } = require('./services/cache');
    const topTokens = await db.getMostViewedTokens(30);
    if (!topTokens || topTokens.length === 0) return;

    let triggered = 0;
    const MAX_PER_CYCLE = 3;
    const STALE_MS = 6 * 3600000; // 6 hours

    for (const token of topTokens) {
      if (triggered >= MAX_PER_CYCLE) break;
      const mint = token.token_mint;

      // Skip if already cached (fresh)
      const existing = await cache.get(`diamond-hands:${mint}`);
      if (existing) continue;

      // Skip if already pending
      const pending = await cache.get(`holder-metrics-pending:${mint}`);
      if (pending) continue;

      // Check DB — skip if computed recently
      const dbRow = await db.getToken(mint).catch(() => null);
      if (dbRow && dbRow.conviction_computed_at) {
        const age = Date.now() - new Date(dbRow.conviction_computed_at).getTime();
        if (age < STALE_MS) continue;
      }

      // Trigger by making an internal request to the diamond-hands endpoint
      try {
        const http = require('http');
        const url = `http://127.0.0.1:${PORT}/api/tokens/${encodeURIComponent(mint)}/holders/diamond-hands`;
        const req = http.get(url, (res) => { res.resume(); });
        req.on('error', () => {}); // suppress socket errors (non-critical)
        req.setTimeout(15000, () => req.destroy());
        triggered++;
      } catch { /* non-critical */ }
    }

    if (triggered > 0) {
      console.log(`[ConvictionWarm] Triggered diamond-hands for ${triggered} tokens`);
    }
  } catch (err) {
    console.error('[ConvictionWarm] Failed (non-critical):', err.message);
  }
}

// Trigger conviction analysis for all curated tokens.
// Runs on startup (after delay) and every hour.
// Processes tokens that have no conviction data or stale data (>1 hour).
async function warmCuratedConviction() {
  try {
    const { cache } = require('./services/cache');
    const curatedTokens = await db.getCuratedTokens();
    if (!curatedTokens || curatedTokens.length === 0) return;

    let triggered = 0;
    const STALE_MS = 60 * 60 * 1000; // 1 hour

    for (const token of curatedTokens) {
      const mint = token.mintAddress || token.mint_address;
      if (!mint) continue;

      // Skip if already pending
      const pending = await cache.get(`holder-metrics-pending:${mint}`);
      if (pending) continue;

      // Skip if conviction was computed recently
      const dbRow = await db.getToken(mint).catch(() => null);
      if (dbRow && dbRow.conviction_computed_at) {
        const age = Date.now() - new Date(dbRow.conviction_computed_at).getTime();
        if (age < STALE_MS) continue;
      }

      // Trigger diamond-hands computation via internal request
      try {
        const http = require('http');
        const url = `http://127.0.0.1:${PORT}/api/tokens/${encodeURIComponent(mint)}/holders/diamond-hands`;
        const req = http.get(url, (res) => { res.resume(); });
        req.on('error', () => {});
        req.setTimeout(15000, () => req.destroy());
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
  }
}

// Start server
httpServer = app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════╗
║        CultScreener API Server            ║
╠════════════════════════════════════════════╣
║  Port: ${PORT.toString().padEnd(36)}║
║  Mode: ${(process.env.NODE_ENV || 'development').padEnd(36)}║
║  Status: ${'Ready'.padEnd(34)}║
╚════════════════════════════════════════════╝
  `);

  // Warm cache after server is ready (non-blocking)
  warmCache().catch(err => console.error('[CacheWarm] Startup error:', err.message));

  // Start conviction warmer — first run after 2 min, then every 10 min
  setTimeout(() => {
    warmConviction();
    setInterval(warmConviction, 10 * 60 * 1000);
  }, 2 * 60 * 1000);

  // Start curated token conviction warmer — first run after 30s, then every hour
  setTimeout(() => {
    warmCuratedConviction();
    setInterval(warmCuratedConviction, 60 * 60 * 1000);
  }, 30 * 1000);
});

module.exports = app;
