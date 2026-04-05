const express = require('express');
const router = express.Router();
const db = require('../services/database');
const { asyncHandler, requireDatabase, validateWalletSignature, validateWatchlistSignature, SOLANA_ADDRESS_REGEX } = require('../middleware/validation');
const { walletLimiter, strictLimiter } = require('../middleware/rateLimit');

// All routes in this file require database access
router.use(requireDatabase);

// Use shared Solana address regex for consistency
const isValidWallet = (address) => {
  return address && SOLANA_ADDRESS_REGEX.test(address);
};
const isValidMint = (mint) => {
  return mint && SOLANA_ADDRESS_REGEX.test(mint);
};

// GET /api/watchlist/:wallet/count - Get watchlist count
// NOTE: Must be registered BEFORE /:wallet to avoid being shadowed by the parametric route
router.get('/:wallet/count', asyncHandler(async (req, res) => {
  const { wallet } = req.params;

  if (!isValidWallet(wallet)) {
    return res.status(400).json({ error: 'Invalid wallet address' });
  }

  const count = await db.getWatchlistCount(wallet);

  res.json({
    wallet,
    count
  });
}));

// GET /api/watchlist/:wallet - Get user's watchlist
router.get('/:wallet', asyncHandler(async (req, res) => {
  const { wallet } = req.params;

  if (!isValidWallet(wallet)) {
    return res.status(400).json({ error: 'Invalid wallet address' });
  }

  const watchlist = await db.getWatchlist(wallet);
  const count = watchlist.length;

  res.json({
    wallet,
    count,
    tokens: watchlist
  });
}));

// POST /api/watchlist - Add token to watchlist
router.post('/', walletLimiter, validateWatchlistSignature, asyncHandler(async (req, res) => {
  const wallet = req.body?.wallet;
  const tokenMint = req.body?.tokenMint;

  if (!isValidWallet(wallet)) {
    return res.status(400).json({ error: 'Invalid wallet address' });
  }

  if (!isValidMint(tokenMint)) {
    return res.status(400).json({ error: 'Invalid token mint address' });
  }

  try {
    const result = await db.addToWatchlistAtomic(wallet, tokenMint, 100);
    if (result.limitReached) {
      return res.status(400).json({
        error: 'Watchlist limit reached (max 100 tokens)',
        code: 'WATCHLIST_LIMIT'
      });
    }

    res.json({
      success: true,
      message: result.exists ? 'Token already in watchlist' : 'Token added to watchlist',
      alreadyExists: !!result.exists,
      tokenMint,
      wallet
    });
  } catch (err) {
    console.error('[Watchlist] Add error:', err.message);
    res.status(500).json({ error: 'Failed to add to watchlist' });
  }
}));

// DELETE /api/watchlist - Remove token from watchlist
router.delete('/', walletLimiter, validateWatchlistSignature, asyncHandler(async (req, res) => {
  const wallet = req.body?.wallet;
  const tokenMint = req.body?.tokenMint;

  if (!isValidWallet(wallet)) {
    return res.status(400).json({ error: 'Invalid wallet address' });
  }

  if (!isValidMint(tokenMint)) {
    return res.status(400).json({ error: 'Invalid token mint address' });
  }

  try {
    const result = await db.removeFromWatchlist(wallet, tokenMint);

    if (!result) {
      return res.status(404).json({
        error: 'Token not found in watchlist',
        tokenMint,
        wallet
      });
    }

    res.json({
      success: true,
      message: 'Token removed from watchlist',
      tokenMint,
      wallet
    });
  } catch (err) {
    console.error('[Watchlist] Remove error:', err.message);
    res.status(500).json({ error: 'Failed to remove from watchlist' });
  }
}));

// POST /api/watchlist/check - Check if token is in watchlist
router.post('/check', walletLimiter, asyncHandler(async (req, res) => {
  const { wallet, tokenMint } = req.body;

  if (!isValidWallet(wallet)) {
    return res.status(400).json({ error: 'Invalid wallet address' });
  }

  if (!isValidMint(tokenMint)) {
    return res.status(400).json({ error: 'Invalid token mint address' });
  }

  const inWatchlist = await db.isInWatchlist(wallet, tokenMint);

  res.json({
    tokenMint,
    wallet,
    inWatchlist
  });
}));

// POST /api/watchlist/check-batch - Check multiple tokens against watchlist
router.post('/check-batch', walletLimiter, asyncHandler(async (req, res) => {
  const { wallet, tokenMints } = req.body;

  if (!isValidWallet(wallet)) {
    return res.status(400).json({ error: 'Invalid wallet address' });
  }

  if (!Array.isArray(tokenMints) || tokenMints.length === 0) {
    return res.status(400).json({ error: 'tokenMints must be a non-empty array' });
  }

  // Limit batch size
  if (tokenMints.length > 100) {
    return res.status(400).json({ error: 'Maximum 100 tokens per batch' });
  }

  // Validate all mints
  const validMints = tokenMints.filter(isValidMint);
  if (validMints.length !== tokenMints.length) {
    return res.status(400).json({ error: 'One or more invalid token mint addresses' });
  }

  const watchlistMap = await db.checkWatchlistBatch(wallet, validMints);

  res.json({
    wallet,
    watchlist: watchlistMap
  });
}));

// ==========================================
// GDPR Data Deletion (Right to Erasure)
// ==========================================

/**
 * DELETE /api/watchlist/user-data
 * Delete all user data associated with a wallet (GDPR compliance)
 * Requires wallet signature for security
 *
 * This endpoint deletes:
 * - Watchlist entries
 * - Votes (and updates affected tallies)
 * - API keys
 * - Anonymizes submissions (removes wallet association but keeps content)
 */
router.delete('/user-data',
  strictLimiter,
  validateWalletSignature,
  asyncHandler(async (req, res) => {
    const { wallet } = req.body;

    if (!isValidWallet(wallet)) {
      return res.status(400).json({ error: 'Invalid wallet address' });
    }

    try {
      const result = await db.deleteUserData(wallet);

      if (!result) {
        return res.status(500).json({ error: 'Failed to delete user data' });
      }

      res.json({
        success: true,
        message: 'Your data has been deleted or anonymized',
        deleted: result.deleted,
        note: 'Submissions have been anonymized (wallet association removed) but content preserved for community benefit'
      });
    } catch (error) {
      // Privacy: Don't log error details
      res.status(500).json({ error: 'Failed to delete user data' });
    }
  })
);

module.exports = router;
