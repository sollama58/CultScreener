const express = require('express');
const router = express.Router();
const db = require('../services/database');
const { asyncHandler, requireDatabase, validateMint, validateSentimentSignature, SOLANA_ADDRESS_REGEX } = require('../middleware/validation');
const { defaultLimiter, walletLimiter } = require('../middleware/rateLimit');

router.use(requireDatabase);

// POST /api/sentiment/bulk
// Must be defined BEFORE /:mint so Express doesn't treat "bulk" as a mint address
// Body: { mints: string[] }
// Returns: { [mint]: { bullish, bearish, score } }
router.post('/bulk', defaultLimiter, asyncHandler(async (req, res) => {
  const { mints } = req.body;
  if (!Array.isArray(mints) || mints.length === 0) return res.json({});
  // Validate each mint against Solana address format before querying
  const validMints = mints.slice(0, 100).filter(m => typeof m === 'string' && SOLANA_ADDRESS_REGEX.test(m));
  if (validMints.length === 0) return res.json({});
  const tallies = await db.getSentimentBatch(validMints);
  res.json(tallies);
}));

// GET /api/sentiment/:mint?wallet=xxx
// Returns tally + optional user's current vote
router.get('/:mint', defaultLimiter, validateMint, asyncHandler(async (req, res) => {
  const { mint } = req.params;
  const { wallet } = req.query;
  const validWallet = wallet && SOLANA_ADDRESS_REGEX.test(wallet) ? wallet : null;
  const [tally, userVote] = await Promise.all([
    db.getSentimentTally(mint),
    validWallet ? db.getSentimentVote(mint, validWallet) : Promise.resolve(null)
  ]);
  res.json({ tally, userVote });
}));

// POST /api/sentiment/:mint
// Body: { voterWallet, sentiment: 'bullish'|'bearish' }
// Requires wallet connection; no holder check
router.post('/:mint', walletLimiter, validateMint, validateSentimentSignature, asyncHandler(async (req, res) => {
  const { mint } = req.params;
  const { sentiment } = req.body;
  // Fall back to device session wallet if not provided in body
  const voterWallet = req.body.voterWallet || req.deviceWallet;

  if (!voterWallet) {
    return res.status(400).json({ error: 'voterWallet required' });
  }
  if (!SOLANA_ADDRESS_REGEX.test(voterWallet)) {
    return res.status(400).json({ error: 'Invalid wallet address format' });
  }
  if (!['bullish', 'bearish'].includes(sentiment)) {
    return res.status(400).json({ error: 'sentiment must be bullish or bearish' });
  }

  const { action, tally } = await db.castSentimentVote(mint, voterWallet, sentiment);
  res.json({ action, tally });
}));

module.exports = router;
