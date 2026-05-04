const express = require('express');
const router = express.Router();
const db = require('../services/database');
const { cache, keys, TTL } = require('../services/cache');
const { asyncHandler, requireDatabase, validateApiKey, sanitizeString } = require('../middleware/validation');

router.use(requireDatabase);

// ==========================================
// Public API Routes (Protected by API Key)
// ==========================================

// Middleware to require API key for all routes in this router
router.use(validateApiKey);

// GET /v1/leaderboard — Conviction token leaderboard
// Query params: limit, offset, minConviction, minMcap, maxMcap, minSample, search
router.get('/leaderboard', asyncHandler(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 25, 100);
  const offset = Math.max(parseInt(req.query.offset) || 0, 0);
  const minConviction = req.query.minConviction ? parseFloat(req.query.minConviction) : null;
  const minMcap = req.query.minMcap ? parseFloat(req.query.minMcap) : null;
  const maxMcap = req.query.maxMcap ? parseFloat(req.query.maxMcap) : null;
  const minSample = req.query.minSample ? parseInt(req.query.minSample) : null;
  const search = req.query.search ? sanitizeString(req.query.search, 100) : null;

  // Build cache key from query params
  const filterObj = {
    minConviction, minMcap, maxMcap, minSample, search
  };
  const filterKey = JSON.stringify(filterObj);
  const cacheKey = `leaderboard:conviction:${limit}:${offset}:${filterKey}`;

  // Try cache first
  const cached = await cache.get(cacheKey);
  if (cached) {
    return res.json({
      success: true,
      data: cached.data,
      limit,
      offset,
      total: cached.total,
      cached: true
    });
  }

  // Query database
  const filters = {};
  if (minConviction !== null) filters.minConviction = minConviction;
  if (minMcap !== null) filters.minMcap = minMcap;
  if (maxMcap !== null) filters.maxMcap = maxMcap;
  if (minSample !== null) filters.minSample = minSample;
  if (search) filters.search = search;

  const result = await db.getTopConvictionTokens(limit, offset, filters);

  // Cache for 2 minutes
  await cache.set(cacheKey, { data: result.tokens, total: result.total }, TTL.LONG);

  res.json({
    success: true,
    data: result.tokens,
    limit,
    offset,
    total: result.total,
    cached: false
  });
}));

// GET /v1/leaderboard/:mint — Get specific token's conviction data with rank
router.get('/leaderboard/:mint', asyncHandler(async (req, res) => {
  const mint = req.params.mint.trim();

  // Validate mint format (Solana address)
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) {
    return res.status(400).json({ error: 'Invalid token mint address' });
  }

  // Try cache first
  const cacheKey = `api:token:${mint}`;
  let tokenData = await cache.get(cacheKey);

  if (!tokenData) {
    // Fetch from database
    tokenData = await db.getToken(mint);
    if (!tokenData) {
      return res.status(404).json({ error: 'Token not found' });
    }
    // Cache for 5 minutes
    await cache.set(cacheKey, tokenData, TTL.PRICE_DATA);
  }

  // Compute rank via indexed COUNT query — O(log n) vs O(n) JS findIndex on 10k rows
  const rankCacheKey = `api:token:rank:${mint}`;
  let rank = null;

  const cachedRank = await cache.get(rankCacheKey);
  if (cachedRank !== null) {
    rank = cachedRank;
  } else {
    rank = await db.getTokenConvictionRank(mint);
    if (rank !== null) {
      // Cache rank for 30 minutes (conviction scores are stable)
      await cache.set(rankCacheKey, rank, TTL.LONG * 15);
    }
  }

  res.json({
    success: true,
    data: {
      ...tokenData,
      rank: rank // null if not in top 10000, or the 1-indexed position
    }
  });
}));

module.exports = router;
