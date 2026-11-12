/**
 * /api/new-pairs: the Emerging Cults finder's public, read-only routes.
 *
 * A separate router from /api/tokens on purpose. Finder tokens are not curated, and
 * every /api/tokens/:mint/* route keeps refusing them (requireAllowedToken), which is
 * what keeps the Helius-backed routes there closed. Nothing in this file, or in
 * services/newPairList.js behind it, calls an upstream: a request is a cache read, or
 * on a miss a few Postgres queries shared by everyone asking at once.
 *
 * NEWPAIRS_PUBLIC must be "true" for these to answer. Until then they return 404, the
 * tab hides itself, and only the admin preview shows the list.
 */
const express = require('express');
const router = express.Router();
const { cache } = require('../services/cache');
const { asyncHandler, requireDatabase, SOLANA_ADDRESS_REGEX } = require('../middleware/validation');
const newPairList = require('../services/newPairList');

const LIST_TTL_MS = 60_000;
const TOKEN_TTL_MS = 60_000;
// getOrSet does not store null: a mint the finder does not list is cached as this
const NOT_LISTED = { notListed: true };

router.use((req, res, next) => {
  if (process.env.NEWPAIRS_PUBLIC === 'true') return next();
  res.status(404).json({ error: 'New Pairs is not available yet', code: 'NEWPAIRS_DISABLED' });
});
router.use(requireDatabase);

// GET /api/new-pairs?window=3d|7d|14d
router.get('/', asyncHandler(async (req, res) => {
  const window = req.query.window === undefined ? newPairList.DEFAULT_WINDOW : req.query.window;
  if (typeof window !== 'string' || !Object.prototype.hasOwnProperty.call(newPairList.WINDOWS, window)) {
    return res.status(400).json({ error: 'window must be one of 3d, 7d, 14d' });
  }
  const list = await cache.getOrSet(`newpairs:list:${window}`, () => newPairList.buildList(window), LIST_TTL_MS);
  res.json(list);
}));

// GET /api/new-pairs/:mint
router.get('/:mint', asyncHandler(async (req, res) => {
  const { mint } = req.params;
  if (!SOLANA_ADDRESS_REGEX.test(mint)) return res.status(400).json({ error: 'Invalid mint address' });
  const payload = await cache.getOrSet(`newpairs:token:${mint}`, async () => (await newPairList.buildToken(mint)) || NOT_LISTED, TOKEN_TTL_MS);
  if (!payload || payload.notListed) return res.status(404).json({ error: 'Token is not listed in New Pairs', code: 'NOT_LISTED' });
  res.json(payload);
}));

module.exports = router;
