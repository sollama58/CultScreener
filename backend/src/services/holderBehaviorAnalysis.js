/**
 * Holder Behavior Analysis Service
 *
 * Extracted from routes/cultify.js so the analysis can be run by the
 * BullMQ worker process instead of the API process.  The cultify route
 * still imports constants and the run function for the endpoint handler.
 */

const solanaService = require('./solana');
const { cache, TTL } = require('./cache');
const { DIAMOND_HANDS_BUCKETS, BURN_WALLETS } = require('../constants');
const { HB_EXCLUDED_MINTS, computeHoldPairs, swapFromRawTransaction } = require('./holderMetrics');

// ── Constants ────────────────────────────────────────────────────────────────

const HB_MAX_HOLDERS          = 50;
const HB_MAX_SWAPS_PER_HOLDER = 200;           // newest swaps kept per wallet
const HB_HISTORY_TXS          = 1000;          // raw transactions read per wallet at most
const HB_HISTORY_PAGE         = 250;           // per call; Helius bills 10 credits per 100 returned, so ≤4 round trips
const HB_ANALYSIS_CACHE_TTL   = 43200 * 1000; // 12 hours — holder behavior changes slowly
const HB_PENDING_TTL          = 1800 * 1000; // 30 min — auto-expire if analysis crashes
// A run where more than this share of wallets could not be read (Helius errors or
// timeouts) is cached only briefly, so the next request re-reads the missing wallets
// instead of every buyer getting the gutted result for 12 hours.
const HB_MAX_FAILED_FRACTION  = 0.1;
const HB_PARTIAL_CACHE_TTL    = 600 * 1000;   // 10 min
// Pauses within a run (tests shorten them)
const HB_RUN_CONFIG = {
  batchDelayMs: 200,   // between batches of uncached wallets
  retryDelayMs: 5000   // before the one retry of failed wallets
};

// ── fetchSwapHistory ─────────────────────────────────────────────────────────

// Swaps are cached in a compact form: one array per swap, [timestamp, mint,
// signedAmount, mint, signedAmount, ...], with only this wallet's legs (positive =
// received, negative = sent) and the cash mints computeHoldPairs ignores left out.
// About a fifth of the full swap objects, which held signatures and both sides of
// every transfer. The key prefix carries the format version.
const HB_SWAPS_KEY_PREFIX = 'hb-swaps:v2:';

function compactSwap(tx, walletAddress) {
  const out = [tx.timestamp ?? null];
  for (const t of (tx.tokenTransfers || [])) {
    const { mint: tm, fromUserAccount, toUserAccount, tokenAmount } = t || {};
    if (!tm || HB_EXCLUDED_MINTS.has(tm)) continue;
    const amount = Number(tokenAmount);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    // Same precedence as computeHoldPairs: received first, then sent
    if (toUserAccount === walletAddress) out.push(tm, amount);
    else if (fromUserAccount === walletAddress) out.push(tm, -amount);
  }
  return out;
}

// Back to the shape computeHoldPairs consumes
function expandSwap(c, walletAddress) {
  const tokenTransfers = [];
  for (let i = 1; i + 1 < c.length; i += 2) {
    const amount = c[i + 1];
    tokenTransfers.push(amount > 0
      ? { mint: c[i], fromUserAccount: null, toUserAccount: walletAddress, tokenAmount: amount }
      : { mint: c[i], fromUserAccount: walletAddress, toUserAccount: null, tokenAmount: -amount });
  }
  return { timestamp: c[0] == null ? undefined : c[0], tokenTransfers };
}

// Fetch up to maxCount of a wallet's most recent swaps, newest first.
// Preferred source: getTransactionsForAddress pages of 250 full transactions
// (10 credits per 100), newest first, read into swaps by swapFromRawTransaction until
// maxCount swaps or HB_HISTORY_TXS transactions. Fallback when Helius doesn't serve that method: the
// legacy Enhanced Transactions API (100 credits per page of 100 swaps).
// Results are cached per-wallet for 1 day — the same whale wallets appear as top
// holders across many different tokens, so the cache hit rate is high after the
// first analysis of any given token.
// `cached`: the wallet's cache entry when the caller already read it (undefined: read it here).
async function fetchSwapHistory(walletAddress, maxCount, cached) {
  const swapCacheKey = `${HB_SWAPS_KEY_PREFIX}${walletAddress}`;
  if (cached === undefined) cached = await cache.get(swapCacheKey);
  if (cached) return cached.map(c => expandSwap(c, walletAddress));

  if (solanaService.isTransactionHistoryAvailable()) {
    try {
      const swaps = [];
      let paginationToken;
      let read = 0;
      while (swaps.length < maxCount && read < HB_HISTORY_TXS) {
        const page = await solanaService.getAccountTransactionsPage(walletAddress, { limit: HB_HISTORY_PAGE, paginationToken });
        const txs = page.txs || [];
        read += txs.length;
        for (const tx of txs) {
          const swap = swapFromRawTransaction(tx, walletAddress);
          if (swap) swaps.push(swap);
          if (swaps.length >= maxCount) break;
        }
        if (!page.paginationToken || txs.length < HB_HISTORY_PAGE) break;
        paginationToken = page.paginationToken;
      }
      const compact = swaps.map(tx => compactSwap(tx, walletAddress));
      // Cache empty answers too, or a wallet with no swaps is re-read on every run
      await cache.set(swapCacheKey, compact, TTL.DAY);
      return compact.map(c => expandSwap(c, walletAddress));
    } catch (err) {
      // -32601 latches the legacy path in solana.js; anything else is this wallet's failure
      if (solanaService.isTransactionHistoryAvailable()) throw err;
    }
  }

  const results = [];
  let before = null;
  // getTransactionsForAddress answers null on an error or a 404, and an array (maybe empty)
  // when Helius answered. Only a read that ended on a real answer is cached.
  let answered = false;

  while (results.length < maxCount) {
    const batchSize = Math.min(100, maxCount - results.length);
    const opts = { limit: batchSize, type: 'SWAP' };
    if (before) opts.before = before;

    const txns = await solanaService.getTransactionsForAddress(walletAddress, opts);
    if (!txns) { answered = false; break; }
    answered = true;
    if (txns.length === 0) break;

    results.push(...txns);
    if (txns.length < batchSize) break; // no more pages
    before = txns[txns.length - 1].signature;
  }

  const compact = results.map(tx => compactSwap(tx, walletAddress));
  // Cache empty answers too (as the path above does), or a wallet with no swaps costs
  // a 100-credit Enhanced call on every run. A null answer is not "no swaps": not cached.
  if (answered || compact.length > 0) {
    await cache.set(swapCacheKey, compact, TTL.DAY);
  }
  return compact.map(c => expandSwap(c, walletAddress));
}

// ── runHolderBehaviorAnalysis ────────────────────────────────────────────────

// Run the full holder behavior analysis.
// Called by the BullMQ worker via the compute-holder-behavior job.
// Takes the top 50 holders, analyzes each wallet's last 100 swaps, then caches result.
async function runHolderBehaviorAnalysis(mint) {
  const pendingKey = `hb-pending:${mint}`;
  const resultKey  = `hb-analysis:${mint}`;

  try {
    // Largest holders from the latest full snapshot (LP and burn wallets dropped);
    // before the first snapshot exists, fall back to one DAS page.
    let topWallets = null;
    const snapList = await require('./holderPipeline')
      .getSnapshotHolderList(mint, { maxAgeMs: 24 * 3_600_000, limit: HB_MAX_HOLDERS * 2 })
      .catch(() => null);
    if (snapList) {
      const lp = new Set(snapList.snapshot.sample_meta?.lpWallets || []);
      topWallets = snapList.rawAccounts
        .filter(a => a.wallet && !lp.has(a.wallet) && !BURN_WALLETS.has(a.wallet))
        .slice(0, HB_MAX_HOLDERS)
        .map(a => ({ wallet: a.wallet }));
    }
    if (!topWallets || topWallets.length === 0) {
      const sampleResult = await solanaService.getTokenHolderSample(mint, HB_MAX_HOLDERS);
      topWallets = sampleResult?.holders || [];
    }
    if (topWallets.length === 0) {
      throw new Error('No holders found');
    }
    let holderList = topWallets.map((h, i) => ({
      rank: i + 1,
      address: h.wallet,
      percentage: null,
      isLP: false,
      isBurnt: false
    }));

    try {
      const cachedAnalytics = await cache.get(`holder-analytics:${mint}`);
      if (cachedAnalytics && cachedAnalytics.holders && cachedAnalytics.holders.length > 0) {
        const flagMap = new Map(cachedAnalytics.holders.map(h => [h.address, { isLP: h.isLP, isBurnt: h.isBurnt }]));
        holderList = holderList.map(h => ({ ...h, ...(flagMap.get(h.address) || {}) }));
      }
    } catch (_) {}

    const eligible = holderList
      .filter(h => !h.isLP && !h.isBurnt && h.address)
      .slice(0, HB_MAX_HOLDERS);
    console.log(`[HB] ${mint.slice(0, 8)}: ${eligible.length} eligible holders for swap analysis`);

    const now = Date.now();
    const holderResults = [];
    const tokenAgg = {};
    let totalSwaps = 0;

    const processHolder = async (holder, cachedSwaps) => {
      try {
        // 45s timeout per holder — prevents one slow/hung Helius call from stalling the entire analysis
        let timeoutId;
        const txns = await Promise.race([
          fetchSwapHistory(holder.address, HB_MAX_SWAPS_PER_HOLDER, cachedSwaps),
          new Promise((_, reject) => { timeoutId = setTimeout(() => reject(new Error('holder timeout')), 45000); })
        ]);
        clearTimeout(timeoutId);
        if (!txns || txns.length === 0) {
          return { rank: holder.rank, address: holder.address, percentage: holder.percentage,
            swapsAnalyzed: 0, tokensTraded: 0, avgHoldTimeMs: null, pairs: [] };
        }
        const pairsMap = computeHoldPairs(holder.address, txns);
        const allTimes = Object.values(pairsMap).flatMap(p => p.map(e => e.holdTime)).filter(t => t != null);
        const avgHoldTimeMs = allTimes.length > 0
          ? Math.round(allTimes.reduce((a, b) => a + b, 0) / allTimes.length)
          : null;
        const pairsArr = Object.entries(pairsMap)
          .flatMap(([tm, list]) => list.map(p => ({ mint: tm, ...p })))
          .sort((a, b) => (a.buyTime ?? a.sellTime) - (b.buyTime ?? b.sellTime));
        return {
          rank: holder.rank, address: holder.address, percentage: holder.percentage,
          swapsAnalyzed: txns.length, tokensTraded: Object.keys(pairsMap).length,
          avgHoldTimeMs, pairs: pairsArr
        };
      } catch (err) {
        console.warn(`[HB] Holder ${holder.address.slice(0, 8)} failed:`, err.message);
        // `failed`: the history could not be read, which is not the same as no swaps
        return { rank: holder.rank, address: holder.address, percentage: holder.percentage,
          swapsAnalyzed: 0, tokensTraded: 0, avgHoldTimeMs: null, pairs: [], failed: true };
      }
    };

    const accumulateResult = (r) => {
      holderResults.push(r);
      totalSwaps += r.swapsAnalyzed || 0;
      for (const pair of r.pairs) {
        if (!tokenAgg[pair.mint]) tokenAgg[pair.mint] = { holdTimes: [] };
        if (pair.holdTime != null) tokenAgg[pair.mint].holdTimes.push(pair.holdTime);
      }
    };

    // Pre-check swap cache to split into cached (immediate) vs uncached (needs Helius)
    const swapCacheEntries = await Promise.all(
      eligible.map(h => cache.get(`${HB_SWAPS_KEY_PREFIX}${h.address}`).then(v => [h, v]))
    );
    const cachedEntries   = swapCacheEntries.filter(([, v]) => v != null);
    const uncachedHolders = swapCacheEntries.filter(([, v]) => v == null).map(([h]) => h);
    console.log(`[HB] ${mint.slice(0, 8)}: ${cachedEntries.length} cached, ${uncachedHolders.length} need Helius`);

    // The values just read are handed over, so nothing is fetched or parsed twice
    const results = await Promise.all(cachedEntries.map(([h, v]) => processHolder(h, v)));

    // BATCH=6: 6 wallets at once, up to 4 history calls each. The Helius queue
    // (rateLimiter.js) still caps the request rate and the calls in flight.
    const BATCH = 6;
    const runBatches = async (holders) => {
      const out = [];
      for (let i = 0; i < holders.length; i += BATCH) {
        if (i > 0) await new Promise(r => setTimeout(r, HB_RUN_CONFIG.batchDelayMs));
        const batch = holders.slice(i, i + BATCH);
        out.push(...await Promise.all(batch.map(h => processHolder(h))));
      }
      return out;
    };
    results.push(...await runBatches(uncachedHolders));

    // One more try for the wallets whose read failed (a Helius blip or a backed-up queue);
    // a timed-out read that finished late has cached its swaps by now
    const failedIdx = results.map((r, i) => (r.failed ? i : -1)).filter(i => i >= 0);
    if (failedIdx.length > 0) {
      console.warn(`[HB] ${mint.slice(0, 8)}: retrying ${failedIdx.length} failed holder(s)`);
      await new Promise(r => setTimeout(r, HB_RUN_CONFIG.retryDelayMs));
      const byAddress = new Map(eligible.map(h => [h.address, h]));
      const retried = await runBatches(failedIdx.map(i => byAddress.get(results[i].address)));
      failedIdx.forEach((idx, j) => { results[idx] = retried[j]; });
    }
    for (const r of results) accumulateResult(r);

    for (const [tm, agg] of Object.entries(tokenAgg)) {
      agg.holderCount = holderResults.filter(h => h.pairs.some(p => p.mint === tm)).length;
    }

    const validAvgs = holderResults.map(h => h.avgHoldTimeMs).filter(v => v != null);
    const overallAvgHoldTimeMs = validAvgs.length > 0
      ? Math.round(validAvgs.reduce((a, b) => a + b, 0) / validAvgs.length)
      : null;

    const tokenStats = Object.entries(tokenAgg)
      .filter(([, agg]) => agg.holdTimes.length > 0)  // skip mints with no resolved hold times
      .map(([tm, agg]) => {
        const times = agg.holdTimes;
        const sum  = times.reduce((a, b) => a + b, 0);
        const min  = times.reduce((a, b) => (b < a ? b : a), times[0]);
        const max  = times.reduce((a, b) => (b > a ? b : a), times[0]);
        return {
          mint: tm,
          holderCount: agg.holderCount,
          pairCount: times.length,
          avgHoldTimeMs: Math.round(sum / times.length),
          minHoldTimeMs: min,
          maxHoldTimeMs: max
        };
      })
      .sort((a, b) => b.holderCount - a.holderCount)
      .slice(0, 200);

    const failedCount = holderResults.filter(h => h.failed).length;
    const result = {
      status: 'done',
      analyzedAt: now,
      holderCount: eligible.length,
      analyzedCount: holderResults.filter(h => h.swapsAnalyzed > 0).length,
      failedCount,
      totalSwapsAnalyzed: totalSwaps,
      overallAvgHoldTimeMs,
      holders: holderResults,
      tokenStats
    };

    const degraded = failedCount > eligible.length * HB_MAX_FAILED_FRACTION;
    await cache.set(resultKey, result, degraded ? HB_PARTIAL_CACHE_TTL : HB_ANALYSIS_CACHE_TTL);
    console.log(`[HB] Done for ${mint.slice(0, 8)}: ${result.analyzedCount}/${result.holderCount} holders, ${totalSwaps} swaps`
      + (failedCount ? `, ${failedCount} failed${degraded ? ' (cached briefly)' : ''}` : ''));
  } catch (err) {
    console.error(`[HB] Analysis failed for ${mint.slice(0, 8)}:`, err.message);
    await cache.set(resultKey, { status: 'failed', error: err.message }, 300000).catch(() => {});
  } finally {
    await cache.delete(pendingKey).catch(() => {});
  }
}

module.exports = {
  HB_MAX_HOLDERS,
  HB_MAX_SWAPS_PER_HOLDER,
  HB_ANALYSIS_CACHE_TTL,
  HB_PENDING_TTL,
  HB_PARTIAL_CACHE_TTL,
  HB_RUN_CONFIG,
  HB_EXCLUDED_MINTS,
  DIAMOND_HANDS_BUCKETS,
  fetchSwapHistory,
  computeHoldPairs,
  runHolderBehaviorAnalysis
};
