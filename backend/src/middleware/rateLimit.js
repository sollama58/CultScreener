/**
 * Rate limiting middleware configurations
 */
const net = require('net');
const expressRateLimit = require('express-rate-limit');

// The key every limiter counts against: the client IP, with an IPv6 address cut to its /64.
// One IPv6 subscriber or VM normally holds a whole /64, so keying on the full address would hand
// it 2^64 separate budgets (including the admin login one) just by changing source address.
// IPv4-mapped IPv6 (::ffff:1.2.3.4) is counted as the IPv4 address it carries.
function clientKey(req) {
  const ip = req.ip || req.socket?.remoteAddress || '';
  if (!net.isIPv6(ip)) return ip;
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return mapped[1];
  const [head, tail = ''] = ip.split('%')[0].split('::');
  const headParts = head ? head.split(':') : [];
  const tailParts = ip.includes('::') ? (tail ? tail.split(':') : []) : [];
  // A dotted IPv4 tail fills two groups (and only ever the low 64 bits)
  const tailGroups = tailParts.length + (tailParts.some(g => g.includes('.')) ? 1 : 0);
  const groups = ip.includes('::')
    ? [...headParts, ...Array(Math.max(0, 8 - headParts.length - tailGroups)).fill('0'), ...tailParts]
    : headParts;
  return groups.slice(0, 4).map(g => (parseInt(g, 16) || 0).toString(16)).join(':') + '::/64';
}

// express-rate-limit with clientKey as the default key. Every limiter in the app is built here.
function rateLimit(options) {
  return expressRateLimit({ keyGenerator: clientKey, ...options });
}

// Default rate limiter
const baseDefaultLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 60000,
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS, 10) || 100,
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false
});

// app.js already runs defaultLimiter on every /api request, and some routes mount it again.
// Count each request once, so those routes don't spend two units of the shared IP budget.
function defaultLimiter(req, res, next) {
  if (req._defaultLimiterCounted) return next();
  req._defaultLimiterCounted = true;
  return baseDefaultLimiter(req, res, next);
}

// Strict limiter for write operations (submissions, votes)
const strictLimiter = rateLimit({
  windowMs: parseInt(process.env.STRICT_RATE_LIMIT_WINDOW_MS, 10) || 60000,
  max: parseInt(process.env.STRICT_RATE_LIMIT_MAX, 10) || 10,
  message: { error: 'Too many submissions, please slow down.' },
  standardHeaders: true,
  legacyHeaders: false
});

// Page-view recording (POST /api/tokens/:mint/view), fired on every token page load.
// Its own budget per IP and token, so browsing doesn't eat the write-action limit. Over the
// limit the view is simply not counted: answering 200 without a `views` field keeps the
// client from treating it as a site-wide 429 and from redrawing the count.
const viewLimiter = rateLimit({
  windowMs: 60000, // 1 minute
  max: 10,         // 10 counted views per minute per IP per token
  standardHeaders: false,
  legacyHeaders: false,
  keyGenerator: (req) => `${clientKey(req)}:${req.params.mint}`,
  handler: (req, res) => res.json({ recorded: false })
});

// Very strict limiter for sensitive operations (API key registration)
const veryStrictLimiter = rateLimit({
  windowMs: parseInt(process.env.VERY_STRICT_RATE_LIMIT_WINDOW_MS, 10) || 3600000,
  max: parseInt(process.env.VERY_STRICT_RATE_LIMIT_MAX, 10) || 5,
  message: { error: 'Too many requests. Please try again in 1 hour.' },
  standardHeaders: true,
  legacyHeaders: false
});

// Admin login: same budget, but only failed attempts count. The admin token lives in per-tab
// sessionStorage (the SameSite=strict cookie is never sent cross-site to the API host), so every
// new tab logs in again; counting those successes locked the admin out after the fifth tab.
const adminLoginLimiter = rateLimit({
  windowMs: parseInt(process.env.VERY_STRICT_RATE_LIMIT_WINDOW_MS, 10) || 3600000,
  max: parseInt(process.env.VERY_STRICT_RATE_LIMIT_MAX, 10) || 5,
  skipSuccessfulRequests: true,
  message: { error: 'Too many login attempts. Please try again in 1 hour.' },
  standardHeaders: true,
  legacyHeaders: false
});

// Admin panel writes (label toggles, approvals, announcements). Mounted after validateAdminSession,
// with its own budget: sharing the public strictLimiter (10/min, same per-IP counter as votes and
// watchlist writes) stopped an admin at the 11th click in a minute.
const adminWriteLimiter = rateLimit({
  windowMs: 60000,
  max: parseInt(process.env.ADMIN_WRITE_RATE_LIMIT_MAX, 10) || 120,
  message: { error: 'Too many admin actions, please slow down.' },
  standardHeaders: true,
  legacyHeaders: false
});

// Search-specific limiter (prevent abuse)
const searchLimiter = rateLimit({
  windowMs: 60000, // 1 minute
  max: 30,         // 30 searches per minute
  message: { error: 'Too many search requests.' },
  standardHeaders: true,
  legacyHeaders: false
});

// Limiter by IP for voting operations
// SECURITY: Always use IP as key - wallet address is user-controlled and could be spoofed
const walletLimiter = rateLimit({
  windowMs: 60000, // 1 minute
  max: 30,         // 30 vote operations per minute per IP
  message: { error: 'Voting too fast. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    // Always use IP to prevent spoofing attacks where attacker uses victim's wallet address
    return clientKey(req);
  }
});

// Looser per-IP limiter for read-only status polls (Cultify diamond-hands, tx-status), kept
// apart from walletLimiter so a running poll cannot use up the budget the burn flow's
// balance / blockhash / check-access calls need
const pollLimiter = rateLimit({
  windowMs: 60000, // 1 minute
  max: 90,         // a 3s and a 2s poll together are 50/min; leaves room for a second tab
  message: { error: 'Too many requests, please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => clientKey(req)
});

// Single-wallet balance lookups (GET /api/tokens/:mint/holder/:wallet). Each new wallet is an
// uncached Helius call, so naming random wallets under the 100/min default budget spent
// credits for nothing; no page calls this route.
const holderLookupLimiter = rateLimit({
  windowMs: 60000, // 1 minute
  max: 10,         // 10 lookups per minute per IP
  message: { error: 'Too many balance lookups, please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => clientKey(req) // IPv6 cut to its /64, like every other limiter
});

// Limiter for API key requests (higher limits than default)
// Uses IP as key to prevent per-key rate limit circumvention
const apiKeyLimiter = rateLimit({
  windowMs: 60000, // 1 minute
  max: 300,        // 300 requests per minute per IP
  message: { error: 'Too many requests with this API key. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    // Use IP as key to prevent circumvention
    return clientKey(req);
  }
});

module.exports = {
  rateLimit,
  clientKey,
  defaultLimiter,
  strictLimiter,
  viewLimiter,
  veryStrictLimiter,
  adminLoginLimiter,
  adminWriteLimiter,
  searchLimiter,
  walletLimiter,
  pollLimiter,
  holderLookupLimiter,
  apiKeyLimiter
};
