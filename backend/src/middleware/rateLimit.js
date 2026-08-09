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
  windowMs: parseInt(process.env.STRICT_RATE_LIMIT_WINDOW_MS, 10) || 60000,
  max: parseInt(process.env.STRICT_RATE_LIMIT_MAX, 10) || 10,
  message: { error: 'Too many submissions, please slow down.' },
  standardHeaders: true,
  legacyHeaders: false
});

// Very strict limiter for sensitive operations (e.g. admin login)
const veryStrictLimiter = rateLimit({
  windowMs: parseInt(process.env.VERY_STRICT_RATE_LIMIT_WINDOW_MS, 10) || 3600000,
  max: parseInt(process.env.VERY_STRICT_RATE_LIMIT_MAX, 10) || 5,
  message: { error: 'Too many login attempts. Please try again in 1 hour.' },
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
    return req.ip;
  }
});

module.exports = {
  defaultLimiter,
  strictLimiter,
  veryStrictLimiter,
  searchLimiter,
  walletLimiter,
  apiKeyLimiter
};
