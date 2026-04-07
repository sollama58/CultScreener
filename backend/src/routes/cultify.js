const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const solanaService = require('../services/solana');
const db = require('../services/database');
const { cache, TTL, keys } = require('../services/cache');
const { validateMint, asyncHandler, SOLANA_ADDRESS_REGEX } = require('../middleware/validation');
const { strictLimiter } = require('../middleware/rateLimit');

const BURN_MINT = '9zB5wRarXMj86MymwLumSKA1Dx35zPqqKfcZtK1Spump';
const BURN_AMOUNT = 10_000;
const BURN_DECIMALS = 6; // pump.fun tokens use 6 decimals
const BURN_RAW_AMOUNT = BigInt(BURN_AMOUNT) * BigInt(10 ** BURN_DECIMALS);
const MAX_TX_AGE_SECONDS = 600; // 10 minutes
const ACCESS_TOKEN_TTL = 43200; // 12 hours in seconds

// Generate a short-lived access token for a wallet+mint pair
function generateAccessToken(walletAddress, mint) {
  const token = crypto.randomBytes(32).toString('hex');
  return token;
}

// POST /api/cultify/verify-burn — verify a burn transaction on-chain
// Returns a short-lived access token on success (prevents wallet spoofing)
router.post('/verify-burn', strictLimiter, asyncHandler(async (req, res) => {
  const { signature, mint, wallet: walletAddress } = req.body;

  // Validate inputs
  if (!signature || typeof signature !== 'string' || signature.length < 80 || signature.length > 90) {
    return res.status(400).json({ error: 'Invalid transaction signature' });
  }
  if (!mint || !SOLANA_ADDRESS_REGEX.test(mint)) {
    return res.status(400).json({ error: 'Invalid token mint address' });
  }
  if (!walletAddress || !SOLANA_ADDRESS_REGEX.test(walletAddress)) {
    return res.status(400).json({ error: 'Invalid wallet address' });
  }

  // Check if signature already used (throws on DB failure — no permissive fallback)
  const alreadyUsed = await db.isCultifySignatureUsed(signature);
  if (alreadyUsed) {
    return res.status(409).json({ error: 'This burn transaction has already been claimed' });
  }

  // Fetch and verify the transaction on-chain
  let tx;
  try {
    tx = await solanaService.getTransaction(signature);
  } catch (err) {
    return res.status(502).json({ error: 'Failed to fetch transaction from Solana. Try again shortly.' });
  }

  if (!tx) {
    return res.status(404).json({ error: 'Transaction not found. It may still be confirming — wait a few seconds and retry.' });
  }

  // 1. Transaction must have succeeded
  if (tx.meta && tx.meta.err) {
    return res.status(400).json({ error: 'Transaction failed on-chain' });
  }

  // 2. Check recency
  if (tx.blockTime) {
    const ageSec = Math.floor(Date.now() / 1000) - tx.blockTime;
    if (ageSec > MAX_TX_AGE_SECONDS) {
      return res.status(400).json({ error: 'Transaction is too old. Please submit a new burn.' });
    }
  }

  // 3. Find burn instruction (check both outer and inner instructions)
  const allInstructions = [
    ...(tx.transaction?.message?.instructions || []),
    ...(tx.meta?.innerInstructions?.flatMap(ii => ii.instructions) || [])
  ];

  const burnIx = allInstructions.find(ix => {
    const t = ix.parsed?.type;
    return t === 'burn' || t === 'burnChecked';
  });

  if (!burnIx) {
    return res.status(400).json({ error: 'No burn instruction found in this transaction' });
  }

  // 4. Verify correct token was burned
  const burnedMint = burnIx.parsed?.info?.mint;
  if (burnedMint !== BURN_MINT) {
    return res.status(400).json({ error: 'Wrong token burned. Must burn $ASDFASDFA.' });
  }

  // 5. Verify burn amount
  const rawAmount = burnIx.parsed?.info?.amount
    || burnIx.parsed?.info?.tokenAmount?.amount
    || '0';
  if (BigInt(rawAmount) < BURN_RAW_AMOUNT) {
    return res.status(400).json({
      error: `Insufficient burn amount. Required: ${BURN_AMOUNT.toLocaleString()} ASDFASDFA.`
    });
  }

  // 6. Verify signer matches provided wallet
  const accountKeys = tx.transaction?.message?.accountKeys || [];
  const signerMatch = accountKeys.some(k =>
    (k.pubkey === walletAddress || k.pubkey?.toString() === walletAddress) && k.signer
  );
  if (!signerMatch) {
    return res.status(400).json({ error: 'Transaction signer does not match your wallet' });
  }

  // 7. Record the burn (UNIQUE constraint on burn_signature prevents replay)
  try {
    await db.recordCultifyBurn(walletAddress, mint, signature, rawAmount.toString());
  } catch (err) {
    // Handle duplicate signature — idempotent: still grant access so retries work
    if (err.code === '23505') { // PostgreSQL unique violation
      const accessToken = generateAccessToken(walletAddress, mint);
      await cache.set(`cultify:access:${accessToken}`, { wallet: walletAddress, mint }, ACCESS_TOKEN_TTL);
      return res.json({ success: true, accessToken, note: 'Burn already recorded' });
    }
    throw err;
  }

  // 8. Generate a short-lived access token so the frontend can call /analyze
  // without needing to prove wallet ownership again (prevents wallet spoofing)
  const accessToken = generateAccessToken(walletAddress, mint);
  const accessKey = `cultify:access:${accessToken}`;
  await cache.set(accessKey, { wallet: walletAddress, mint }, ACCESS_TOKEN_TTL);

  res.json({ success: true, accessToken });
}));

// GET /api/cultify/check-access/:mint — check if a wallet/token pair has access
// For curated tokens this is unauthenticated (free). For burned tokens, the
// frontend passes the access token it received from verify-burn.
router.get('/check-access/:mint', validateMint, asyncHandler(async (req, res) => {
  const { mint } = req.params;

  // Curated tokens are free for everyone
  const curated = await db.isTokenAllowed(mint);
  if (curated) {
    return res.json({ access: true, reason: 'curated' });
  }

  // Check cache token first (fast path)
  const accessToken = req.query.token;
  if (accessToken) {
    const accessData = await cache.get(`cultify:access:${accessToken}`);
    if (accessData && accessData.mint === mint) {
      return res.json({ access: true, reason: 'burned' });
    }
  }

  // Check DB for a burn within the last 12 hours (returning users / expired cache tokens)
  const walletAddress = req.query.wallet;
  if (walletAddress && SOLANA_ADDRESS_REGEX.test(walletAddress)) {
    const hasBurn = await db.hasCultifyAccess(walletAddress, mint);
    if (hasBurn) {
      // Issue a fresh access token so subsequent analyze calls work
      const newToken = generateAccessToken(walletAddress, mint);
      await cache.set(`cultify:access:${newToken}`, { wallet: walletAddress, mint }, ACCESS_TOKEN_TTL);
      return res.json({ access: true, reason: 'burned', accessToken: newToken });
    }
  }

  res.json({ access: false, reason: 'none' });
}));

// GET /api/cultify/analyze/:mint — run holder analytics for a cultified token
// Access is verified either by curated status or by a valid access token
router.get('/analyze/:mint', validateMint, asyncHandler(async (req, res) => {
  const { mint } = req.params;

  // Verify access: curated (free) or valid access token (from verify-burn)
  const curated = await db.isTokenAllowed(mint);
  if (!curated) {
    const accessToken = req.query.token;
    if (!accessToken) {
      return res.status(403).json({ error: 'Access token required for non-curated tokens' });
    }
    const accessData = await cache.get(`cultify:access:${accessToken}`);
    if (!accessData || accessData.mint !== mint) {
      return res.status(403).json({ error: 'Invalid or expired access token. Please burn again.' });
    }
  }

  // Run holder analytics
  const cacheKey = `cultify:holders:${mint}`;
  try {
    const cached = await cache.get(cacheKey);
    if (cached) return res.json(cached);

    if (!solanaService.isHeliusConfigured()) {
      return res.json({ error: 'rpc_unavailable', holders: [], metrics: null });
    }

    // Fetch largest token accounts
    const accounts = await solanaService.getTokenLargestAccounts(mint);
    if (!accounts || accounts.length === 0) {
      return res.json({ error: 'no_holders', holders: [], metrics: null });
    }

    // Get supply for percentage calculations
    const supplyData = await solanaService.getTokenSupply(mint);
    const totalSupply = supplyData?.value?.uiAmount || 0;

    // Build holder list
    const holders = accounts.slice(0, 20).map((acc, i) => ({
      rank: i + 1,
      address: acc.address,
      balance: acc.uiAmount || 0,
      percentage: totalSupply > 0 ? ((acc.uiAmount || 0) / totalSupply * 100) : 0,
      isLP: false,
      isBurnt: false
    }));

    // Calculate concentration metrics
    const top5Pct = holders.slice(0, 5).reduce((s, h) => s + h.percentage, 0);
    const top10Pct = holders.slice(0, 10).reduce((s, h) => s + h.percentage, 0);
    const top20Pct = holders.reduce((s, h) => s + h.percentage, 0);

    const result = {
      metrics: {
        top5Pct,
        top10Pct,
        top20Pct,
        holderCount: accounts.length,
        riskLevel: top10Pct > 80 ? 'high' : top10Pct > 50 ? 'medium' : 'low'
      },
      holders,
      fetchedAt: Date.now()
    };

    await cache.set(cacheKey, result, TTL.FIVE_MIN);
    res.json(result);
  } catch (error) {
    console.error('[Cultify] Analysis error:', error.message);
    res.status(500).json({ error: 'Analysis failed. Try again later.' });
  }
}));

// GET /api/cultify/diamond-hands/:mint — diamond hands distribution
// For non-curated tokens the main worker never runs, so this endpoint
// computes hold times inline for the top holders.
router.get('/diamond-hands/:mint', validateMint, asyncHandler(async (req, res) => {
  const { mint } = req.params;

  // Verify access
  const curated = await db.isTokenAllowed(mint);
  if (!curated) {
    const accessToken = req.query.token;
    if (!accessToken) return res.status(403).json({ error: 'Access token required' });
    const accessData = await cache.get(`cultify:access:${accessToken}`);
    if (!accessData || accessData.mint !== mint) {
      return res.status(403).json({ error: 'Invalid or expired access token' });
    }
  }

  const BUCKETS = [
    { key: '6h', ms: 6*3600000 }, { key: '24h', ms: 24*3600000 },
    { key: '3d', ms: 3*86400000 }, { key: '1w', ms: 7*86400000 },
    { key: '1m', ms: 30*86400000 }, { key: '3m', ms: 90*86400000 },
    { key: '6m', ms: 180*86400000 }, { key: '9m', ms: 270*86400000 },
  ];

  try {
    // Check for cached final result
    const resultCacheKey = `cultify:diamond-hands:${mint}`;
    const cached = await cache.get(resultCacheKey);
    if (cached) return res.json(cached);

    // For curated tokens, check if the main worker already computed it
    if (curated) {
      const mainCached = await cache.get(`diamond-hands:${mint}`);
      if (mainCached) return res.json(mainCached);
    }

    if (!solanaService.isHeliusConfigured()) {
      return res.json({ distribution: null, sampleSize: 0, analyzed: 0, computed: true });
    }

    // Check partial progress from a previous request
    const progressKey = `cultify:dh-progress:${mint}`;
    let progress = await cache.get(progressKey) || { holdTimes: {}, wallets: null };

    // Get holder wallets if we don't have them yet
    if (!progress.wallets) {
      const accounts = await solanaService.getTokenLargestAccounts(mint);
      if (!accounts || accounts.length === 0) {
        return res.json({ distribution: null, sampleSize: 0, analyzed: 0, computed: true });
      }
      progress.wallets = accounts.slice(0, 20).map(a => a.address);
      progress.holdTimes = {};
    }

    // Compute hold times for unanalyzed wallets (batch of 5 per request to stay fast)
    const unanalyzed = progress.wallets.filter(w => !(w in progress.holdTimes));
    const batch = unanalyzed.slice(0, 5);

    await Promise.all(batch.map(async (walletAddr) => {
      try {
        const metrics = await solanaService.getWalletHoldMetrics(walletAddr, mint);
        progress.holdTimes[walletAddr] = metrics.tokenHoldTime || 0;
      } catch {
        progress.holdTimes[walletAddr] = 0;
      }
    }));

    // Save progress for next poll
    await cache.set(progressKey, progress, 600); // 10 min TTL

    // Derive analyzed count from actual holdTimes entries (not a separate counter)
    const analyzedCount = Object.keys(progress.holdTimes).length;
    const totalWallets = progress.wallets.length;

    // Build distribution from current data
    const now = Date.now();
    const holdTimeValues = Object.values(progress.holdTimes).filter(t => t > 0);
    const distribution = {};
    for (const b of BUCKETS) {
      const count = holdTimeValues.filter(t => (now - t) >= b.ms).length;
      distribution[b.key] = holdTimeValues.length > 0
        ? Math.round(count / holdTimeValues.length * 100) : 0;
    }

    const allDone = analyzedCount >= totalWallets;
    const result = {
      distribution,
      sampleSize: totalWallets,
      analyzed: analyzedCount,
      computed: allDone
    };

    if (allDone) {
      await cache.set(resultCacheKey, result, 3 * 3600); // cache 3 hours
      await cache.delete(progressKey);
    }

    res.json(result);
  } catch (err) {
    console.error('[Cultify] Diamond hands error:', err.message);
    res.json({ distribution: null, sampleSize: 0, analyzed: 0, computed: false });
  }
}));

// GET /api/cultify/my-tokens/:wallet — list tokens the wallet has active access to
router.get('/my-tokens/:wallet', asyncHandler(async (req, res) => {
  const { wallet: walletAddress } = req.params;
  if (!SOLANA_ADDRESS_REGEX.test(walletAddress)) {
    return res.status(400).json({ error: 'Invalid wallet address' });
  }

  try {
    const burns = await db.getCultifyBurnsByWallet(walletAddress);
    res.json({ tokens: burns });
  } catch (err) {
    console.error('[Cultify] My tokens error:', err.message);
    res.status(500).json({ error: 'Failed to fetch tokens' });
  }
}));

// ── RPC proxy endpoints (keeps Helius API key on the server) ──────────

// GET /api/cultify/balance/:wallet — get ASDFASDFA balance for a wallet
router.get('/balance/:wallet', asyncHandler(async (req, res) => {
  const { wallet: walletAddress } = req.params;
  if (!SOLANA_ADDRESS_REGEX.test(walletAddress)) {
    return res.status(400).json({ error: 'Invalid wallet address' });
  }

  try {
    const result = await solanaService.getTokenAccountsByOwner(walletAddress, BURN_MINT);
    if (!result || !result.value || result.value.length === 0) {
      return res.json({ balance: 0, uiBalance: 0, tokenAccount: null });
    }

    let bestAccount = null;
    let bestBalance = 0;
    let bestUiBalance = 0;

    for (const item of result.value) {
      const tokenAmount = item.account?.data?.parsed?.info?.tokenAmount;
      if (tokenAmount) {
        const amt = Number(tokenAmount.amount || '0');
        if (amt > bestBalance) {
          bestBalance = amt;
          bestUiBalance = Number(tokenAmount.uiAmountString || tokenAmount.uiAmount || 0);
          bestAccount = item.pubkey;
        }
      }
    }

    res.json({ balance: bestBalance, uiBalance: bestUiBalance, tokenAccount: bestAccount });
  } catch (err) {
    console.error('[Cultify] Balance check error:', err.message);
    res.status(502).json({ error: 'Failed to check balance' });
  }
}));

// GET /api/cultify/blockhash — get a recent blockhash for building transactions
router.get('/blockhash', asyncHandler(async (req, res) => {
  try {
    const result = await solanaService.getRecentBlockhash();
    if (!result || !result.value) {
      return res.status(502).json({ error: 'Failed to get blockhash' });
    }
    res.json({ blockhash: result.value.blockhash });
  } catch (err) {
    console.error('[Cultify] Blockhash error:', err.message);
    res.status(502).json({ error: 'Failed to get blockhash' });
  }
}));

// POST /api/cultify/send-tx — send a signed transaction via Helius RPC
router.post('/send-tx', strictLimiter, asyncHandler(async (req, res) => {
  const { transaction } = req.body;
  if (!transaction || typeof transaction !== 'string') {
    return res.status(400).json({ error: 'Missing transaction data' });
  }

  try {
    const signature = await solanaService.sendRawTransaction(transaction);
    res.json({ signature });
  } catch (err) {
    console.error('[Cultify] Send transaction error:', err.message);
    res.status(502).json({ error: 'Failed to send transaction: ' + (err.message || 'RPC error') });
  }
}));

// GET /api/cultify/tx-status/:signature — check transaction confirmation status
router.get('/tx-status/:signature', asyncHandler(async (req, res) => {
  const { signature } = req.params;
  if (!signature || signature.length < 80 || signature.length > 90) {
    return res.status(400).json({ error: 'Invalid signature' });
  }

  try {
    const tx = await solanaService.getTransaction(signature);
    if (!tx) {
      return res.json({ confirmed: false });
    }
    const failed = tx.meta && tx.meta.err;
    res.json({ confirmed: true, failed: !!failed });
  } catch (err) {
    res.json({ confirmed: false });
  }
}));

module.exports = router;
