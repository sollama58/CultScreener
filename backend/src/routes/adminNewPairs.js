/**
 * /api/admin/new-pairs: the admin side of the Emerging Cults finder. Mounted by
 * routes/admin.js after validateAdminSession, so every route here needs an admin session.
 *
 *   GET  /            the ranked preview, counts, Helius credits against the cap, detectors
 *   GET  /settings    floors, shortlist size, daily credits and its ceiling
 *   PUT  /settings    change any of them (daily credits cannot go above the env ceiling)
 *   PATCH /:mint      { hidden: true | false }
 *   POST /:mint/promote   add the token to the curated list
 */
const express = require('express');
const router = express.Router();
const { asyncHandler, SOLANA_ADDRESS_REGEX } = require('../middleware/validation');
const { adminWriteLimiter } = require('../middleware/rateLimit');
const newPairAdmin = require('../services/newPairAdmin');
const newPairSettings = require('../services/newPairSettings');

// Admin data: never stored by a browser or a proxy
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

router.get('/', asyncHandler(async (req, res) => {
  res.json(await newPairAdmin.preview());
}));

router.get('/settings', asyncHandler(async (req, res) => {
  res.json({ settings: await newPairSettings.get(), bounds: newPairSettings.BOUNDS });
}));

router.put('/settings', adminWriteLimiter, asyncHandler(async (req, res) => {
  try {
    const settings = await newPairSettings.save(req.body);
    // The public list prints the floors
    await newPairAdmin.clearPublicCache();
    res.json({ success: true, settings });
  } catch (error) {
    if (error.status === 400) return res.status(400).json({ error: error.message });
    throw error;
  }
}));

router.patch('/:mint', adminWriteLimiter, asyncHandler(async (req, res) => {
  const { mint } = req.params;
  if (!SOLANA_ADDRESS_REGEX.test(mint)) return res.status(400).json({ error: 'Invalid mint address' });
  if (typeof req.body?.hidden !== 'boolean') return res.status(400).json({ error: 'hidden must be true or false' });
  const found = await newPairAdmin.setHidden(mint, req.body.hidden);
  if (!found) return res.status(404).json({ error: 'Token is not in New Pairs' });
  res.json({ success: true, hidden: req.body.hidden });
}));

router.post('/:mint/promote', adminWriteLimiter, asyncHandler(async (req, res) => {
  const { mint } = req.params;
  if (!SOLANA_ADDRESS_REGEX.test(mint)) return res.status(400).json({ error: 'Invalid mint address' });
  const result = await newPairAdmin.promote(mint);
  if (!result) return res.status(404).json({ error: 'Token is not in New Pairs' });
  res.status(result.alreadyCurated ? 200 : 201).json({ success: true, alreadyCurated: result.alreadyCurated, token: result.token });
}));

module.exports = router;
