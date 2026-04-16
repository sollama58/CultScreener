const express = require('express');
const router = express.Router();
const axios = require('axios');
const db = require('../services/database');
const { cache } = require('../services/cache');
const { asyncHandler, requireDatabase, SOLANA_ADDRESS_REGEX } = require('../middleware/validation');
const { strictLimiter } = require('../middleware/rateLimit');

// All routes require database access
router.use(requireDatabase);

const isValidMint = (mint) => mint && SOLANA_ADDRESS_REGEX.test(mint);

// Admin auth middleware — uses session-based auth (consistent with admin.js)
const { validateAdminSession } = require('../middleware/validation');
const requireAdmin = validateAdminSession;

/**
 * Fetch banner image and social links from DexScreener for a given mint.
 * Returns null if the API call fails or no data is found.
 */
async function fetchDexScreenerData(mint) {
  try {
    const response = await axios.get(
      `https://api.dexscreener.com/tokens/v1/solana/${encodeURIComponent(mint)}`,
      { timeout: 10000 }
    );

    const pairs = response.data;
    if (!Array.isArray(pairs) || pairs.length === 0) {
      return null;
    }

    const info = pairs[0].info || {};
    const socials = Array.isArray(info.socials) ? info.socials : [];
    const websites = Array.isArray(info.websites) ? info.websites : [];

    const findSocial = (type) => {
      const entry = socials.find(s => s.type === type);
      return entry ? entry.url : null;
    };

    return {
      name: pairs[0].baseToken?.name || null,
      symbol: pairs[0].baseToken?.symbol || null,
      logoUri: info.imageUrl || null,
      bannerUrl: info.header || null,
      socials: {
        twitter: findSocial('twitter'),
        telegram: findSocial('telegram'),
        discord: findSocial('discord'),
        tiktok: findSocial('tiktok'),
        website: websites.length > 0 ? websites[0].url : null
      }
    };
  } catch (error) {
    console.error(`[Curated] DexScreener fetch failed for ${mint}:`, error.message);
    return null;
  }
}

/**
 * Refresh DexScreener data for all curated tokens.
 * Delays 1 second between calls to avoid rate limiting.
 */
async function refreshAllDexScreener() {
  const tokens = await db.getCuratedTokens();
  const results = { updated: 0, failed: 0, total: tokens.length };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    try {
      const data = await fetchDexScreenerData(token.mintAddress || token.mint_address);
      if (data) {
        await db.updateCuratedTokenDexScreener(token.mintAddress || token.mint_address, data);
        results.updated++;
      } else {
        results.failed++;
      }
    } catch (error) {
      console.error(`[Curated] Refresh failed for ${token.mintAddress || token.mint_address}:`, error.message);
      results.failed++;
    }

    // Wait 1 second between calls to respect rate limits (skip after last)
    if (i < tokens.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  return results;
}

// GET /api/curated - Get all curated tokens with DexScreener data
router.get('/', asyncHandler(async (req, res) => {
  const tokens = await db.getCuratedTokens();
  res.json({ tokens });
}));

// GET /api/curated/:mint - Get a single curated token
router.get('/:mint', asyncHandler(async (req, res) => {
  const { mint } = req.params;

  if (!isValidMint(mint)) {
    return res.status(400).json({ error: 'Invalid mint address' });
  }

  const token = await db.getCuratedToken(mint);
  if (!token) {
    return res.status(404).json({ error: 'Token not found in curated list' });
  }

  res.json({ token });
}));

// POST /api/curated - Add a token to the curated list (admin-only)
router.post('/', strictLimiter, requireAdmin, asyncHandler(async (req, res) => {
  const { mintAddress } = req.body;

  if (!isValidMint(mintAddress)) {
    return res.status(400).json({ error: 'Invalid mint address' });
  }

  // Add to database
  const token = await db.addCuratedToken(mintAddress);

  // Invalidate the 'not allowed' cache entry so token is immediately accessible
  await cache.delete(`curated-allowed:${mintAddress}`).catch(() => {});

  // Fetch DexScreener data and enrich
  const dexData = await fetchDexScreenerData(mintAddress);
  if (dexData) {
    await db.updateCuratedTokenDexScreener(mintAddress, dexData);
  }

  // Return the enriched token
  const enrichedToken = await db.getCuratedToken(mintAddress);

  res.status(201).json({
    success: true,
    message: 'Token added to curated list',
    token: enrichedToken,
    dexScreenerEnriched: !!dexData
  });
}));

// DELETE /api/curated/:mint - Remove a token from curated list (admin-only)
router.delete('/:mint', strictLimiter, requireAdmin, asyncHandler(async (req, res) => {
  const { mint } = req.params;

  if (!isValidMint(mint)) {
    return res.status(400).json({ error: 'Invalid mint address' });
  }

  const result = await db.removeCuratedToken(mint);
  if (!result) {
    return res.status(404).json({ error: 'Token not found in curated list' });
  }

  // Invalidate all caches that could contain this token
  try {
    await cache.clearPattern('list:*');
    await cache.clearPattern('search:*');
    await cache.delete(`token:${mint}`);
    await cache.delete(`price:${mint}`);
    await cache.delete(`pools:${mint}`);
    await cache.delete(`holders:${mint}`);
    await cache.delete(`batch:${mint}`);
    await cache.clearPattern(`*${mint}*`);
    console.log(`[Curated] Cache cleared for ${mint.slice(0, 8)}...`);
  } catch (cacheErr) {
    console.error(`[Curated] Cache clear failed:`, cacheErr.message);
  }

  res.json({
    success: true,
    message: 'Token removed from curated list',
    mintAddress: mint
  });
}));

// POST /api/curated/refresh - Refresh DexScreener data for all curated tokens (admin-only)
router.post('/refresh', strictLimiter, requireAdmin, asyncHandler(async (req, res) => {
  const results = await refreshAllDexScreener();

  res.json({
    success: true,
    message: 'DexScreener refresh complete',
    ...results
  });
}));

// POST /api/curated/:mint/refresh - Refresh DexScreener data for one token (admin-only)
router.post('/:mint/refresh', strictLimiter, requireAdmin, asyncHandler(async (req, res) => {
  const { mint } = req.params;

  if (!isValidMint(mint)) {
    return res.status(400).json({ error: 'Invalid mint address' });
  }

  const token = await db.getCuratedToken(mint);
  if (!token) {
    return res.status(404).json({ error: 'Token not found in curated list' });
  }

  const dexData = await fetchDexScreenerData(mint);
  if (!dexData) {
    return res.status(502).json({ error: 'Failed to fetch DexScreener data' });
  }

  await db.updateCuratedTokenDexScreener(mint, dexData);
  const updatedToken = await db.getCuratedToken(mint);

  res.json({
    success: true,
    message: 'DexScreener data refreshed',
    token: updatedToken
  });
}));

module.exports = router;
