const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const solanaService = require('../services/solana');
const db = require('../services/database');
const { cache, TTL, keys } = require('../services/cache');
const { validateMint, asyncHandler, SOLANA_ADDRESS_REGEX, canBypassCache } = require('../middleware/validation');
const { strictLimiter, walletLimiter, pollLimiter } = require('../middleware/rateLimit');
const jobQueue = require('../services/jobQueue');
const { checkBurnTransaction } = require('../services/burnTxPolicy');
const {
  HB_ANALYSIS_CACHE_TTL,
  HB_PENDING_TTL,
  runHolderBehaviorAnalysis
} = require('../services/holderBehaviorAnalysis');
const holderPipeline = require('../services/holderPipeline');

const BURN_MINT = '9zB5wRarXMj86MymwLumSKA1Dx35zPqqKfcZtK1Spump';
const BURN_AMOUNT = 5_000;
const BURN_DECIMALS = 6; // pump.fun tokens use 6 decimals
const BURN_RAW_AMOUNT = BigInt(BURN_AMOUNT) * BigInt(10 ** BURN_DECIMALS);
const ACCESS_TOKEN_TTL = 43200 * 1000; // 12 hours in milliseconds (cache.set takes ms)

/**
 * On-chain verification shared by both burn-gated features (Cultify at 5k, Holder Behavior at
 * 10k). One implementation on purpose: the two routes previously duplicated this logic, and the
 * copies had already started to drift.
 *
 * Returns { ok: true, rawAmount: bigint } or { ok: false, status, error }.
 *
 * Three deliberate properties:
 *  - No recency window. Replay is impossible regardless of age - the signature-used check plus
 *    the UNIQUE constraint on burn_signature mean each burn credits exactly once - so an age gate
 *    only ever produced "burned, verified late, tokens gone, access refused forever". An old
 *    unclaimed burn being claimable by the wallet that made it is recovery, not a vulnerability.
 *  - The burn's AUTHORITY must be the requesting wallet. The old check accepted any signer on
 *    the transaction, and a transaction can carry several signers (the fee payer need not own
 *    the tokens) - so a co-signer could claim access bought with another wallet's burn.
 *  - Burns of our mint are filtered and summed per wallet (not find-first): a transaction that
 *    also burns some other token can't shadow the real burn, and a balance split across two
 *    token accounts still qualifies in one transaction. Amounts stay BigInt - they're u64s.
 */
function verifyBurnTransaction(tx, walletAddress, requiredRaw, requiredLabel) {
  if (tx.meta && tx.meta.err) {
    return { ok: false, status: 400, error: 'Transaction failed on-chain' };
  }

  const allInstructions = [
    ...(tx.transaction?.message?.instructions || []),
    ...(tx.meta?.innerInstructions?.flatMap(ii => ii.instructions) || [])
  ];
  const burnIxs = allInstructions.filter(ix => {
    const t = ix.parsed?.type;
    return t === 'burn' || t === 'burnChecked';
  });
  if (burnIxs.length === 0) {
    return { ok: false, status: 400, error: 'No burn instruction found in this transaction' };
  }

  const ourBurns = burnIxs.filter(ix => ix.parsed?.info?.mint === BURN_MINT);
  if (ourBurns.length === 0) {
    return { ok: false, status: 400, error: 'Wrong token burned. Must burn $ASDFASDFA.' };
  }

  let burnedByWallet = 0n;
  for (const ix of ourBurns) {
    const info = ix.parsed?.info || {};
    const authority = info.authority || info.multisigAuthority;
    if (authority !== walletAddress) continue;
    const raw = info.amount || info.tokenAmount?.amount;
    if (typeof raw === 'string' && /^\d+$/.test(raw)) burnedByWallet += BigInt(raw);
  }
  if (burnedByWallet === 0n) {
    return { ok: false, status: 400, error: 'That burn was made by a different wallet.' };
  }
  if (burnedByWallet < requiredRaw) {
    return {
      ok: false,
      status: 400,
      error: `Insufficient burn amount. Required: ${requiredLabel} ASDFASDFA.`
    };
  }
  return { ok: true, rawAmount: burnedByWallet };
}

// The parsed burn transaction, kept for 5 minutes so a verify-burn retry (or the other
// verify route) does not fetch the same transaction again.
const BURN_TX_CACHE_TTL = 300000;
async function getBurnTransaction(signature) {
  const key = `cultify:tx:${signature}`;
  const cached = await cache.get(key);
  if (cached) return cached;
  const tx = await solanaService.getTransaction(signature);
  if (tx) await Promise.resolve(cache.set(key, tx, BURN_TX_CACHE_TTL)).catch(() => {});
  return tx;
}

// Generate a short-lived access token for a wallet+mint pair
function generateAccessToken(walletAddress, mint) {
  const token = crypto.randomBytes(32).toString('hex');
  return token;
}

// Access tokens issued from the wallet-based checks are remembered per wallet+mint
// (`<prefix>:access-by:<wallet>:<mint>`) so a repeat check returns the token that is still
// valid instead of writing a new Redis key every time. prefix is 'cultify' or 'hb'.
const accessByKey = (prefix, walletAddress, mint) => `${prefix}:access-by:${walletAddress}:${mint}`;

async function findIssuedToken(prefix, walletAddress, mint) {
  const token = await cache.get(accessByKey(prefix, walletAddress, mint));
  if (!token) return null;
  const data = await cache.get(`${prefix}:access:${token}`);
  return data && data.mint === mint && data.wallet === walletAddress ? token : null;
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
    tx = await getBurnTransaction(signature);
  } catch (err) {
    return res.status(502).json({ error: 'Failed to fetch transaction from Solana. Try again shortly.' });
  }

  if (!tx) {
    return res.status(404).json({ error: 'Transaction not found. It may still be confirming — wait a few seconds and retry.' });
  }

  // On-chain verification - see verifyBurnTransaction for what it enforces (authority match,
  // burns filtered+summed, no age gate) and why.
  const verdict = verifyBurnTransaction(tx, walletAddress, BURN_RAW_AMOUNT, BURN_AMOUNT.toLocaleString());
  if (!verdict.ok) {
    return res.status(verdict.status).json({ error: verdict.error });
  }
  const rawAmount = verdict.rawAmount;

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
router.get('/check-access/:mint', walletLimiter, validateMint, asyncHandler(async (req, res) => {
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
      // Hand back the token issued earlier while it is valid, else issue a fresh one so
      // subsequent analyze calls work
      const existing = await findIssuedToken('cultify', walletAddress, mint);
      if (existing) return res.json({ access: true, reason: 'burned', accessToken: existing });
      const newToken = generateAccessToken(walletAddress, mint);
      await cache.set(`cultify:access:${newToken}`, { wallet: walletAddress, mint }, ACCESS_TOKEN_TTL);
      await cache.set(accessByKey('cultify', walletAddress, mint), newToken, ACCESS_TOKEN_TTL);
      return res.json({ access: true, reason: 'burned', accessToken: newToken });
    }
  }

  res.json({ access: false, reason: 'none' });
}));

// GET /api/cultify/analyze/:mint — run holder analytics for a cultified token
// Uses the SAME holder-analytics cache and worker flow as the main token pages
// so cultify users see identical data (real holder count, LP/burn detection, etc.)
router.get('/analyze/:mint', walletLimiter, validateMint, asyncHandler(async (req, res) => {
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
    // Return enriched data if the worker has already processed this token.
    // ?fresh=true bypasses the cache only for admin sessions and API-key callers;
    // anyone with a burn token could otherwise force RPC calls on every request.
    if (req.query.fresh !== 'true' || !(await canBypassCache(req))) {
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
    // Percentages set to null in fast path since LP status unknown — worker will compute actual percentages excluding LPs
    const holders = largestAccounts.slice(0, 20).map((a, i) => ({
      rank: i + 1,
      address: a.wallet || a.address,
      balance: a.uiAmount,
      percentage: null,  // Will be computed by worker after LP detection
      isLP: false,
      isBurnt: false
    })).filter(h => h.balance > 0);

    // Basic concentration metrics (refined by worker once LP/burn flags are set)
    let metrics = null;
    if (totalSupply > 0 && holders.length > 0) {
      // In fast path, percentages are null (set by worker after LP detection)
      // So we don't compute concentration metrics yet
      metrics = {
        top5Pct: null,
        top10Pct: null,
        top20Pct: null,
        top1Pct: null,
        holderCount: null
      };

      // Use cached holder count (populated by worker or previous calls)
      try {
        const totalCount = await cache.get(`holder-total:${mint}`);
        if (totalCount && totalCount > 0) {
          metrics.holderCount = totalCount;
        } else if (solanaService.isHeliusConfigured()) {
          // Count in the worker (deduped there), not inside the API process
          require('../services/jobQueue').addAnalyticsJob('fetch-holder-counts-batch', { mints: [mint] }).catch(() => {});
        }
      } catch (_) {}
    }

    const fastResult = { holders, totalSupply, metrics, supply: null, fetchedAt: Date.now() };

    // Phase 2: Queue the same worker job as the main endpoint for enrichment
    // (LP/burn detection, real holder count)
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
    } else {
      // Enrichment is already queued (by the worker or another request): cache the fast
      // result too, so polls in that window are served from cache instead of repeating the
      // RPCs. setNX never replaces a result the worker has written.
      await cache.setNX(cacheKey, fastResult, 120000);
    }

    res.json(fastResult);
  } catch (error) {
    console.error('[Cultify] Analysis error:', error.message);
    res.status(500).json({ error: 'Analysis failed. Try again later.' });
  }
}));

// GET /api/cultify/diamond-hands/:mint — diamond hands distribution
// Uses the SAME cache keys and worker flow as the main tokens endpoint.
// Includes queue position info so the frontend can show "You are #N in queue".
router.get('/diamond-hands/:mint', pollLimiter, validateMint, asyncHandler(async (req, res) => {
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
    // ?fresh=true evicts the result the token page also reads, so like /analyze it is
    // honoured only for admin sessions and API-key callers
    const fresh = req.query.fresh === 'true' && await canBypassCache(req);

    if (fresh) {
      await cache.delete(resultCacheKey);
    }

    // ── Fast path: cached final result ──
    if (!fresh) {
      const cached = await cache.get(resultCacheKey);
      if (cached) {
        dequeueMint(mint).catch(() => {});
        return res.json(cached);
      }
    }

    // ── Enqueue early: every token that doesn't have a final result gets a slot ──
    // ensureEnqueued is idempotent — safe to call on every poll.
    const queueInfo = await ensureEnqueued(mint);

    // ── Snapshot → sample → hold times, same pipeline as the tokens endpoint ──
    const result = await holderPipeline.getDiamondHands(mint);
    if (result.computed) {
      dequeueMint(mint).catch(() => {});
      return res.json(result);
    }
    res.json({ ...result, queue: queueInfo });
  } catch (err) {
    console.error('[Cultify] Diamond hands error:', err.message);
    res.json({ distribution: null, sampleSize: 0, analyzed: 0, computed: false });
  }
}));

// GET /api/cultify/my-tokens/:wallet — list tokens the wallet has active access to
router.get('/my-tokens/:wallet', walletLimiter, asyncHandler(async (req, res) => {
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
router.get('/balance/:wallet', walletLimiter, asyncHandler(async (req, res) => {
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
router.get('/blockhash', walletLimiter, asyncHandler(async (req, res) => {
  const cached = await cache.get('cultify:blockhash');
  if (cached) return res.json(cached);

  try {
    const result = await solanaService.getRecentBlockhash();
    if (!result || !result.value) {
      return res.status(502).json({ error: 'Failed to get blockhash' });
    }
    const payload = { blockhash: result.value.blockhash };
    await cache.set('cultify:blockhash', payload, 15000); // 15-second TTL
    res.json(payload);
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
  // Validate base64 format and size (max ~2KB for a Solana tx)
  if (!/^[A-Za-z0-9+/=]+$/.test(transaction) || transaction.length > 1700) {
    return res.status(400).json({ error: 'Invalid transaction format' });
  }
  // Only relay burns of the burn mint; this endpoint is not a general-purpose RPC relay.
  const policy = checkBurnTransaction(transaction, [BURN_MINT]);
  if (!policy.ok) {
    return res.status(400).json({ error: 'Only burn transactions can be sent through this endpoint', reason: policy.reason });
  }

  try {
    const signature = await solanaService.sendRawTransaction(transaction);
    res.json({ signature });
  } catch (err) {
    console.error('[Cultify] Send transaction error:', err.message);
    res.status(502).json({ error: 'Failed to send transaction. Please try again.' });
  }
}));

// GET /api/cultify/tx-status/:signature — check transaction confirmation status
router.get('/tx-status/:signature', pollLimiter, asyncHandler(async (req, res) => {
  const { signature } = req.params;
  if (!signature || signature.length < 80 || signature.length > 90) {
    return res.status(400).json({ error: 'Invalid signature' });
  }

  // Return confirmed status from cache (avoids repeated RPC calls while frontend polls)
  const cacheKey = `cultify:tx-confirmed:${signature}`;
  const confirmed = await cache.get(cacheKey);
  if (confirmed != null) return res.json(confirmed);

  try {
    // Only the status is needed here, not the full parsed transaction
    const result = await solanaService.rpcCall('getSignatureStatuses', [[signature], { searchTransactionHistory: true }]);
    const status = result?.value?.[0];
    // No confirmationStatus on old nodes: confirmations === null means finalized
    const level = status && (status.confirmationStatus || (status.confirmations === null ? 'finalized' : 'processed'));
    if (level !== 'confirmed' && level !== 'finalized') {
      return res.json({ confirmed: false });
    }
    const payload = { confirmed: true, failed: !!status.err };
    // Cache confirmed results for 5 minutes so repeated polls are cheap
    await cache.set(cacheKey, payload, 300000);
    res.json(payload);
  } catch (err) {
    res.json({ confirmed: false });
  }
}));

// ── Holder Behavior Analysis ──────────────────────────────────────────
// Burns 10,000 ASDFASDFA to analyze top 50 holders' last 150 swap
// transactions across all tokens (excluding SOL + stablecoins).

const HB_BURN_AMOUNT = 10_000;
const HB_BURN_RAW_AMOUNT = BigInt(HB_BURN_AMOUNT) * BigInt(10 ** BURN_DECIMALS);
const HB_ACCESS_TTL = 259200 * 1000;  // 3 days (72 hours)
// HB_ANALYSIS_CACHE_TTL and HB_PENDING_TTL imported from services/holderBehaviorAnalysis

// Store an HB access token and update the per-wallet index for "My Utilities".
// reuse: return the token already issued for this wallet+mint while it is valid (repeat
// access checks); a new burn always gets a fresh token with the full TTL.
async function storeHBAccess(walletAddress, mint, { reuse = false } = {}) {
  if (reuse) {
    const existing = await findIssuedToken('hb', walletAddress, mint);
    if (existing) return existing;
  }
  const accessToken = generateAccessToken(walletAddress, mint);
  const expiresAt = Date.now() + HB_ACCESS_TTL;
  await cache.set(`hb:access:${accessToken}`, { wallet: walletAddress, mint, expiresAt }, HB_ACCESS_TTL);
  await cache.set(accessByKey('hb', walletAddress, mint), accessToken, HB_ACCESS_TTL);

  // Maintain a per-wallet index so "My Utilities" can enumerate active accesses
  const idxKey = `hb:wallet-idx:${walletAddress}`;
  const existing = (await cache.get(idxKey)) || [];
  const now = Date.now();
  const filtered = existing.filter(e => e.mint !== mint && e.expiresAt > now);
  filtered.push({ mint, expiresAt });
  await cache.set(idxKey, filtered, HB_ACCESS_TTL);
  return accessToken;
}
// runHolderBehaviorAnalysis imported from services/holderBehaviorAnalysis.js
// and executed by the BullMQ worker process.

// POST /api/cultify/holder-behavior/verify-burn
// Same on-chain verification pattern as /verify-burn but requires 10,000 ASDFASDFA.
router.post('/holder-behavior/verify-burn', strictLimiter, asyncHandler(async (req, res) => {
  const { signature, mint, wallet: walletAddress } = req.body;

  if (!signature || typeof signature !== 'string' || signature.length < 80 || signature.length > 90) {
    return res.status(400).json({ error: 'Invalid transaction signature' });
  }
  if (!mint || !SOLANA_ADDRESS_REGEX.test(mint)) {
    return res.status(400).json({ error: 'Invalid token mint address' });
  }
  if (!walletAddress || !SOLANA_ADDRESS_REGEX.test(walletAddress)) {
    return res.status(400).json({ error: 'Invalid wallet address' });
  }

  const alreadyUsed = await db.isCultifySignatureUsed(signature);
  if (alreadyUsed) {
    return res.status(409).json({ error: 'This burn transaction has already been claimed' });
  }

  let tx;
  try {
    tx = await getBurnTransaction(signature);
  } catch (err) {
    return res.status(502).json({ error: 'Failed to fetch transaction. Try again shortly.' });
  }
  if (!tx) {
    return res.status(404).json({ error: 'Transaction not found. It may still be confirming.' });
  }
  // Same shared verification as the Cultify burn above - authority match, burns
  // filtered+summed, no age gate. See verifyBurnTransaction.
  const verdict = verifyBurnTransaction(tx, walletAddress, HB_BURN_RAW_AMOUNT, HB_BURN_AMOUNT.toLocaleString());
  if (!verdict.ok) {
    return res.status(verdict.status).json({ error: verdict.error });
  }
  const rawAmount = verdict.rawAmount;

  try {
    await db.recordCultifyBurn(walletAddress, mint, signature, rawAmount.toString(), 'holder_behavior');
  } catch (err) {
    if (err.code === '23505') {
      const accessToken = await storeHBAccess(walletAddress, mint);
      return res.json({ success: true, accessToken, note: 'Burn already recorded' });
    }
    throw err;
  }

  const accessToken = await storeHBAccess(walletAddress, mint);
  res.json({ success: true, accessToken });
}));

// GET /api/cultify/holder-behavior/check-access/:mint
router.get('/holder-behavior/check-access/:mint', walletLimiter, validateMint, asyncHandler(async (req, res) => {
  const { mint } = req.params;

  // Whitelisted wallets get free access — no burn needed
  const walletAddress = req.query.wallet;
  if (walletAddress && SOLANA_ADDRESS_REGEX.test(walletAddress)) {
    const isWhitelisted = await db.isWalletWhitelisted(walletAddress);
    if (isWhitelisted) {
      // Issue a temporary access token so the analyze route can validate normally
      const accessToken = await storeHBAccess(walletAddress, mint, { reuse: true });
      return res.json({ access: true, reason: 'whitelisted', accessToken });
    }
  }

  const accessToken = req.query.token;
  if (accessToken) {
    const accessData = await cache.get(`hb:access:${accessToken}`);
    if (accessData && accessData.mint === mint) return res.json({ access: true, reason: 'burned' });
  }

  // Cache miss (e.g. server restart) — fall back to DB
  const walletForCheck = req.query.wallet;
  if (walletForCheck && SOLANA_ADDRESS_REGEX.test(walletForCheck)) {
    const hasBurn = await db.hasHBAccess(walletForCheck, mint);
    if (hasBurn) {
      const newToken = await storeHBAccess(walletForCheck, mint, { reuse: true });
      return res.json({ access: true, reason: 'burned', accessToken: newToken });
    }
  }

  res.json({ access: false, reason: accessToken ? 'expired' : 'none' });
}));

// GET /api/cultify/holder-behavior/analyze/:mint
// Returns { status: 'computing' } immediately; caches final result for polling.
router.get('/holder-behavior/analyze/:mint', walletLimiter, validateMint, asyncHandler(async (req, res) => {
  const { mint } = req.params;

  // Whitelisted wallets bypass the burn gate entirely
  const walletAddress = req.query.wallet;
  let isWhitelisted = false;
  if (walletAddress && SOLANA_ADDRESS_REGEX.test(walletAddress)) {
    isWhitelisted = await db.isWalletWhitelisted(walletAddress);
  }

  if (!isWhitelisted) {
    const accessToken = req.query.token;
    if (!accessToken) return res.status(403).json({ error: 'Access token required' });
    const accessData = await cache.get(`hb:access:${accessToken}`);
    if (!accessData || accessData.mint !== mint) {
      return res.status(403).json({ error: 'Invalid or expired access token. Please burn again.' });
    }
  }

  if (!solanaService.isHeliusConfigured()) {
    return res.status(503).json({ error: 'Analysis unavailable: Helius not configured' });
  }

  const resultKey  = `hb-analysis:${mint}`;
  const pendingKey = `hb-pending:${mint}`;

  // Return cached result if available (includes failed results cached for 5 min)
  const cached = await cache.get(resultKey);
  if (cached) return res.json(cached);

  // Return pending status if already running
  const pending = await cache.get(pendingKey);
  if (pending) return res.json({ status: 'computing' });

  // Enqueue analysis in worker process (replaces setImmediate + in-process semaphore).
  // jobId deduplicates at the BullMQ level — prevents duplicate jobs when concurrent
  // requests race past the pending-flag check above.
  await cache.set(pendingKey, Date.now(), HB_PENDING_TTL);
  const queued = await jobQueue.addAnalyticsJob('compute-holder-behavior', { mint }, { jobId: `hb:${mint}` });
  if (!queued) {
    // Queue unavailable — fall back to in-process execution so the feature still works
    setImmediate(() => runHolderBehaviorAnalysis(mint));
  }

  res.json({ status: 'computing' });
}));

// GET /api/cultify/holder-behavior/my-access?wallet=...
// Returns all active HB accesses for a wallet (used by "My Utilities" modal)
router.get('/holder-behavior/my-access', walletLimiter, asyncHandler(async (req, res) => {
  const { wallet: walletAddress } = req.query;
  if (!walletAddress || !SOLANA_ADDRESS_REGEX.test(walletAddress)) {
    return res.json({ items: [] });
  }
  const idxKey = `hb:wallet-idx:${walletAddress}`;
  let entries = (await cache.get(idxKey)) || [];
  const now = Date.now();
  let active = entries.filter(e => e.expiresAt > now);

  // If cache is cold (server restart / TTL expired), rebuild from DB
  if (active.length === 0) {
    const dbEntries = await db.getHBAccessByWallet(walletAddress);
    if (dbEntries.length > 0) {
      active = dbEntries.filter(e => e.expiresAt > now);
      // Repopulate the Redis index so subsequent calls are fast
      if (active.length > 0) {
        await cache.set(idxKey, active, HB_ACCESS_TTL).catch(() => {});
      }
    }
  }

  res.json({ items: active.map(e => ({ mint: e.mint, expiresAt: new Date(e.expiresAt).toISOString(), type: 'holderBehavior' })) });
}));

module.exports = router;
// Exposed for tests only - lets the burn verification be exercised against captured transaction
// fixtures without standing up the whole route (and its DB/cache/RPC dependencies).
module.exports._verifyBurnTransaction = verifyBurnTransaction;
