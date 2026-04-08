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
// Uses the SAME holder-analytics cache and worker flow as the main token pages
// so cultify users see identical data (real holder count, LP/burn detection, etc.)
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

  // Use the SAME cache key as the main holders endpoint — data is shared
  const cacheKey = `holder-analytics:${mint}`;
  try {
    // Return enriched data if the worker has already processed this token
    if (req.query.fresh !== 'true') {
      const cached = await cache.get(cacheKey);
      if (cached) return res.json(cached);
    }

    // Phase 1: Fast inline — same as main /api/tokens/:mint/holders endpoint
    const [rpcAccounts, supplyResult] = await Promise.all([
      solanaService.getTokenLargestAccounts(mint),
      solanaService.getTokenSupply(mint).catch(() => null)
    ]);

    let largestAccounts = rpcAccounts;
    if (!largestAccounts && solanaService.isHeliusConfigured()) {
      const decimals = supplyResult?.value?.decimals || 0;
      largestAccounts = await solanaService.getTokenLargestAccountsDAS(mint, decimals);
    }

    if (!largestAccounts || largestAccounts.length === 0) {
      return res.json({ holders: [], totalSupply: null, metrics: null, supply: null, error: !rpcAccounts ? 'rpc_unavailable' : 'no_holders' });
    }

    const totalSupply = supplyResult?.value
      ? parseFloat(supplyResult.value.uiAmountString || supplyResult.value.uiAmount || 0)
      : null;

    // Build basic holders list (LP/burn flags come from worker enrichment)
    const holders = largestAccounts.slice(0, 20).map((a, i) => ({
      rank: i + 1,
      address: a.wallet || a.address,
      balance: a.uiAmount,
      percentage: totalSupply > 0 ? (a.uiAmount / totalSupply) * 100 : null,
      isLP: false,
      isBurnt: false
    })).filter(h => h.balance > 0);

    // Basic concentration metrics (refined by worker once LP/burn flags are set)
    let metrics = null;
    if (totalSupply > 0 && holders.length > 0) {
      const top5Pct = holders.slice(0, 5).reduce((s, h) => s + (h.percentage || 0), 0);
      const top10Pct = holders.slice(0, 10).reduce((s, h) => s + (h.percentage || 0), 0);
      const top20Pct = holders.slice(0, 20).reduce((s, h) => s + (h.percentage || 0), 0);
      const top1Pct = holders[0]?.percentage || 0;

      let riskLevel = 'low';
      if (top10Pct > 70 || top1Pct > 30) riskLevel = 'high';
      else if (top10Pct > 40 || top1Pct > 15) riskLevel = 'medium';

      metrics = {
        top5Pct: Math.round(top5Pct * 100) / 100,
        top10Pct: Math.round(top10Pct * 100) / 100,
        top20Pct: Math.round(top20Pct * 100) / 100,
        top1Pct: Math.round(top1Pct * 100) / 100,
        riskLevel,
        holderCount: null
      };

      // Use cached holder count (populated by worker or previous calls)
      try {
        const totalCount = await cache.get(`holder-total:${mint}`);
        if (totalCount && totalCount > 0) {
          metrics.holderCount = totalCount;
        } else if (solanaService.isHeliusConfigured()) {
          // Fire-and-forget: fetch real holder count in background
          solanaService.getTokenHolderCount(mint).then(count => {
            if (count && count > 0) {
              cache.set(`holder-total:${mint}`, count, TTL.DAY);
            }
          }).catch(() => {});
        }
      } catch (_) {}
    }

    const fastResult = { holders, totalSupply, metrics, supply: null, fetchedAt: Date.now() };

    // Phase 2: Queue the same worker job as the main endpoint for enrichment
    // (LP/burn detection, real holder count, 250-wallet sample pre-fetch)
    const pendingKey = `holder-classify-pending:${mint}`;
    const alreadyPending = await cache.get(pendingKey);
    if (!alreadyPending) {
      await cache.set(cacheKey, fastResult, 120000); // 2 min short TTL
      await cache.set(pendingKey, Date.now(), 120000);
      const rawAccounts = largestAccounts.slice(0, 20).map(a => ({
        address: a.address,
        wallet: a.wallet || null,
        uiAmount: a.uiAmount
      }));
      const jobQueue = require('../services/jobQueue');
      const job = await jobQueue.addAnalyticsJob('compute-holder-analytics', {
        mint,
        rawAccounts,
        totalSupply,
        usedDAS: !rpcAccounts,
        supplyDecimals: supplyResult?.value?.decimals || 0
      });
      if (!job) {
        await cache.delete(pendingKey);
      }
    }

    res.json(fastResult);
  } catch (error) {
    console.error('[Cultify] Analysis error:', error.message);
    res.status(500).json({ error: 'Analysis failed. Try again later.' });
  }
}));

// Diamond hands distribution buckets (same as main tokens endpoint)
const DIAMOND_HANDS_BUCKETS = [
  { key: '6h', ms: 6*3600000 }, { key: '24h', ms: 24*3600000 },
  { key: '3d', ms: 3*86400000 }, { key: '1w', ms: 7*86400000 },
  { key: '1m', ms: 30*86400000 }, { key: '3m', ms: 90*86400000 },
  { key: '6m', ms: 180*86400000 }, { key: '9m', ms: 270*86400000 },
];

// Same distribution calculation as the main tokens endpoint (buildDiamondHandsResult)
function buildDistribution(holdTimes, sampleSize, analyzed) {
  const values = Object.values(holdTimes).filter(t => t > 0);
  if (values.length === 0) {
    return { distribution: null, sampleSize, analyzed: 0, computed: true };
  }
  const distribution = {};
  for (const b of DIAMOND_HANDS_BUCKETS) {
    const count = values.filter(ms => ms >= b.ms).length;
    distribution[b.key] = Math.round((count / values.length) * 1000) / 10;
  }
  return { distribution, sampleSize, analyzed, computed: true };
}

// GET /api/cultify/diamond-hands/:mint — diamond hands distribution
// Uses the SAME cache keys and worker flow as the main tokens endpoint.
// No more inferior inline fallback — all tokens go through the proper
// 250-wallet DAS sample + worker-based computation path.
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

  try {
    if (!solanaService.isHeliusConfigured()) {
      return res.json({ distribution: null, sampleSize: 0, analyzed: 0, computed: true });
    }

    const resultCacheKey = `diamond-hands:${mint}`;
    const fresh = req.query.fresh === 'true';

    if (fresh) {
      await cache.delete(resultCacheKey);
    }

    // Check for cached final result (shared with main endpoint)
    if (!fresh) {
      const cached = await cache.get(resultCacheKey);
      if (cached) return res.json(cached);
    }

    // Get holder sample from cache — pre-fetched by compute-holder-analytics worker.
    // If not cached, trigger the sample fetch so subsequent polls find it.
    const walletsCacheKey = `diamond-hands-wallets:${mint}`;
    let wallets = await cache.get(walletsCacheKey);

    if (!wallets || !Array.isArray(wallets) || wallets.length === 0) {
      // No sample yet — trigger DAS sample fetch if not already pending
      const samplePendingKey = `cultify:sample-pending:${mint}`;
      const samplePending = await cache.get(samplePendingKey);
      if (!samplePending) {
        await cache.set(samplePendingKey, Date.now(), 60000); // 1 min dedup
        // Fire-and-forget: fetch 250-wallet sample via Helius DAS
        solanaService.getTokenHolderSample(mint, 250).then(async (sampleResult) => {
          if (sampleResult && sampleResult.holders && sampleResult.holders.length > 0) {
            await cache.set(walletsCacheKey, sampleResult.holders, TTL.HOUR);
            if (sampleResult.totalHolders && sampleResult.totalHolders > 0) {
              await cache.set(`holder-total:${mint}`, sampleResult.totalHolders, TTL.DAY);
            }
            console.log(`[Cultify] Fetched ${sampleResult.holders.length} holder sample for ${mint.slice(0, 8)}...`);
          }
          await cache.delete(samplePendingKey);
        }).catch(async (err) => {
          console.warn(`[Cultify] Holder sample fetch failed for ${mint.slice(0, 8)}:`, err.message);
          await cache.delete(samplePendingKey);
        });
      }
      return res.json({ distribution: null, sampleSize: 0, analyzed: 0, computed: false });
    }

    // Extract wallet addresses and ATA map
    const walletList = wallets.map(e => typeof e === 'object' ? e.wallet : e);
    const ataMap = {};
    for (const e of wallets) {
      if (typeof e === 'object' && e.wallet && e.ata) ataMap[e.wallet] = e.ata;
    }

    // Check per-wallet token hold time caches
    const holdTimes = {};
    const uncached = [];
    let analyzedCount = 0;

    await Promise.all(walletList.map(async (wallet) => {
      const val = await cache.get(`wallet-token-hold:${wallet}:${mint}`);
      if (val != null) {
        analyzedCount++;
        if (val > 0) holdTimes[wallet] = val;
      } else {
        uncached.push(wallet);
      }
    }));

    // If all wallets are cached, compute final distribution
    if (uncached.length === 0) {
      const result = buildDistribution(holdTimes, walletList.length, analyzedCount);
      await cache.set(resultCacheKey, result, 3 * TTL.HOUR);
      // Persist to DB for conviction leaderboard
      db.upsertConviction(mint, result.distribution, result.sampleSize, result.analyzed).catch(err => {
        console.error(`[Cultify] DB persist failed for ${mint.slice(0, 8)}:`, err.message);
      });
      return res.json(result);
    }

    // Dispatch background computation for uncached wallets (same worker as main endpoint)
    const pendingKey = `holder-metrics-pending:${mint}`;
    const pending = await cache.get(pendingKey);
    const isStillPending = pending && (typeof pending !== 'number' || (Date.now() - pending) < 180000);

    if (!isStillPending) {
      if (pending) await cache.delete(pendingKey);
      await cache.set(pendingKey, Date.now(), 180000); // 3 min dedup
      const jobQueue = require('../services/jobQueue');
      const job = await jobQueue.addAnalyticsJob('compute-holder-metrics', {
        mint,
        wallets: uncached,
        ataMap
      });
      if (!job) {
        await cache.delete(pendingKey);
      }
    }

    // Return partial distribution from cached data
    const partial = buildDistribution(holdTimes, walletList.length, analyzedCount);
    partial.computed = false;
    partial.totalCount = walletList.length;
    res.json(partial);
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
