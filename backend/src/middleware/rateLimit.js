/**
 * Rate limiting middleware configurations
 */
const rateLimit = require('express-rate-limit');

// Default rate limiter
const defaultLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 60000,
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS, 10) || 100,
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false
});

// Strict limiter for write operations (submissions, votes)
const strictLimiter = rateLimit({
  windowMs: 60000, // 1 minute
  max: 10,         // 10 requests per minute
  message: { error: 'Too many submissions, please slow down.' },
  standardHeaders: true,
  legacyHeaders: false
});

// Very strict limiter for sensitive operations
const veryStrictLimiter = rateLimit({
  windowMs: 3600000, // 1 hour
  max: 50,           // 50 per hour
  message: { error: 'Rate limit exceeded. Please try again later.' },
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
    return req.ip;
  }
});

module.exports = {
  defaultLimiter,
  strictLimiter,
  veryStrictLimiter,
  searchLimiter,
  walletLimiter
};
