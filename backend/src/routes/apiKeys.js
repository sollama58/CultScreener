const express = require('express');
const router = express.Router();
const db = require('../services/database');
const {
  asyncHandler, requireDatabase, validateApiKeySignature,
  generateApiKey, hashApiKey, SOLANA_ADDRESS_REGEX
} = require('../middleware/validation');
const { strictLimiter, veryStrictLimiter } = require('../middleware/rateLimit');

router.use(requireDatabase);

// ==========================================
// Logging helper
// ==========================================

function logApiKeyOperation(operation, wallet, result, details = {}) {
  const timestamp = new Date().toISOString();
  console.log(
    `[API Keys] ${operation.toUpperCase()} wallet=${wallet.slice(0, 8)}... result=${result} timestamp=${timestamp}`,
    details
  );
}

// ==========================================
// API Key Registration (via wallet signature)
// ==========================================

// POST /api/keys — Generate a new API key
// Requires wallet signature to prove wallet ownership (one key per wallet)
// Uses veryStrictLimiter to prevent key farming
router.post('/', veryStrictLimiter, validateApiKeySignature, asyncHandler(async (req, res) => {
  const { wallet } = req.body;

  // Defensive: Validate wallet was verified by middleware
  if (!wallet || !SOLANA_ADDRESS_REGEX.test(wallet)) {
    logApiKeyOperation('post_register', wallet || 'invalid', 'rejected', { reason: 'invalid_wallet' });
    return res.status(400).json({ error: 'Invalid wallet address' });
  }

  // Check if key already exists to prevent race condition
  const existingKey = await db.getApiKeyByWallet(wallet);
  if (existingKey) {
    logApiKeyOperation('post_register', wallet, 'conflict', { reason: 'key_exists' });
    // Don't leak that wallet has key - use generic error message
    return res.status(409).json({
      error: 'Failed to create API key',
      message: 'Unable to create a new API key at this time. Please try again later.',
      code: 'KEY_CREATE_FAILED'
    });
  }

  // Generate new key
  const { key, prefix, hash } = generateApiKey();

  // Store in database (one per wallet — ON CONFLICT DO NOTHING)
  const apiKey = await db.createApiKey(wallet, hash, prefix);

  if (!apiKey) {
    logApiKeyOperation('post_register', wallet, 'conflict', { reason: 'on_conflict_do_nothing' });
    // Race condition occurred - another request created key between our check and insert
    return res.status(409).json({
      error: 'Failed to create API key',
      message: 'Unable to create a new API key at this time. Please try again later.',
      code: 'KEY_CREATE_FAILED'
    });
  }

  // Validate created_at was returned from database
  if (!apiKey.created_at) {
    logApiKeyOperation('post_register', wallet, 'error', { reason: 'missing_created_at' });
    return res.status(500).json({ error: 'Internal server error' });
  }

  logApiKeyOperation('post_register', wallet, 'success', { key_prefix: prefix });

  // Return plaintext key ONCE (not stored, can't be recovered)
  res.status(201).json({
    success: true,
    key: key,
    prefix: prefix,
    created_at: apiKey.created_at,
    message: 'Save your API key now — it will not be shown again!'
  });
}));

// ==========================================
// API Key Management
// ==========================================

// GET /api/keys/me — Get current API key info for a wallet
// SECURITY: Requires wallet signature to prevent enumeration attacks
// This prevents attackers from discovering which wallets have registered API keys
router.get('/me', validateApiKeySignature, asyncHandler(async (req, res) => {
  const wallet = req.body.wallet; // From validated signature, not query param

  // Double-check wallet format (defense in depth)
  if (!wallet || !SOLANA_ADDRESS_REGEX.test(wallet)) {
    return res.status(400).json({ error: 'Invalid wallet address' });
  }

  const apiKey = await db.getApiKeyByWallet(wallet);

  if (!apiKey) {
    // Return 200 even if no key exists - don't confirm/deny key existence
    return res.json({
      found: false,
      message: 'No API key found for this wallet'
    });
  }

  // Validate database returned valid data
  if (!apiKey.key_prefix) {
    return res.status(500).json({ error: 'Internal server error' });
  }

  res.json({
    found: true,
    prefix: apiKey.key_prefix,
    name: apiKey.name || null,
    created_at: apiKey.created_at,
    last_used_at: apiKey.last_used_at,
    request_count: apiKey.request_count || 0,
    is_active: apiKey.is_active
  });
}));

// DELETE /api/keys/me — Delete/revoke API key
// Requires wallet signature (wallet must own the key)
router.delete('/me', strictLimiter, validateApiKeySignature, asyncHandler(async (req, res) => {
  const { wallet } = req.body;

  // Defensive: Validate wallet was verified by middleware
  if (!wallet || !SOLANA_ADDRESS_REGEX.test(wallet)) {
    logApiKeyOperation('delete', wallet || 'invalid', 'rejected', { reason: 'invalid_wallet' });
    return res.status(400).json({ error: 'Invalid wallet address' });
  }

  const deleted = await db.deleteApiKey(wallet);

  if (!deleted) {
    logApiKeyOperation('delete', wallet, 'not_found');
    // Return 404 but don't confirm whether key existed
    return res.status(404).json({
      error: 'Not found',
      message: 'The requested API key could not be found.',
      code: 'NOT_FOUND'
    });
  }

  logApiKeyOperation('delete', wallet, 'success');

  res.json({
    success: true,
    message: 'API key deleted successfully'
  });
}));

// POST /api/keys/rotate — Rotate API key (delete old, create new)
// Requires wallet signature (wallet must own the key)
// Returns new plaintext key
// SECURITY: Uses strict rate limiting to prevent abuse
router.post('/rotate', strictLimiter, validateApiKeySignature, asyncHandler(async (req, res) => {
  const { wallet } = req.body;

  // Defensive: Validate wallet was verified by middleware
  if (!wallet || !SOLANA_ADDRESS_REGEX.test(wallet)) {
    logApiKeyOperation('rotate', wallet || 'invalid', 'rejected', { reason: 'invalid_wallet' });
    return res.status(400).json({ error: 'Invalid wallet address' });
  }

  // Check that key exists before attempting delete
  const existingKey = await db.getApiKeyByWallet(wallet);
  if (!existingKey) {
    logApiKeyOperation('rotate', wallet, 'not_found');
    return res.status(404).json({
      error: 'Not found',
      message: 'The requested API key could not be found.',
      code: 'NOT_FOUND'
    });
  }

  // Delete old key
  const deleted = await db.deleteApiKey(wallet);

  if (!deleted) {
    // This shouldn't happen after we confirmed it exists, but handle it gracefully
    logApiKeyOperation('rotate', wallet, 'error', { reason: 'delete_failed_after_existence_check' });
    return res.status(500).json({ error: 'Internal server error' });
  }

  // Generate new key
  const { key, prefix, hash } = generateApiKey();

  // Store new key - if this fails, old key is already deleted
  let apiKey;
  try {
    apiKey = await db.createApiKey(wallet, hash, prefix);
  } catch (err) {
    logApiKeyOperation('rotate', wallet, 'error', { reason: 'create_failed_after_delete', error: err.message });
    // Critical: key was deleted but new one couldn't be created
    // Return 500 to indicate failure - user needs to create new key
    return res.status(500).json({
      error: 'Rotation failed',
      message: 'Failed to create new API key. Please try generating a new key.',
      code: 'ROTATION_FAILED'
    });
  }

  // Validate returned data
  if (!apiKey || !apiKey.created_at) {
    logApiKeyOperation('rotate', wallet, 'error', { reason: 'missing_returned_data' });
    return res.status(500).json({ error: 'Internal server error' });
  }

  logApiKeyOperation('rotate', wallet, 'success', { key_prefix: prefix });

  res.json({
    success: true,
    key: key,
    prefix: prefix,
    created_at: apiKey.created_at,
    message: 'API key rotated successfully. Save the new key — it will not be shown again!'
  });
}));

module.exports = router;
