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
const HB_HISTORY_TXS          = 1000;          // raw transactions read per wallet (one 10-credit call)
const HB_ANALYSIS_CACHE_TTL   = 43200 * 1000; // 12 hours — holder behavior changes slowly
const HB_PENDING_TTL          = 1800 * 1000; // 30 min — auto-expire if analysis crashes

// ── fetchSwapHistory ─────────────────────────────────────────────────────────

// Fetch up to maxCount of a wallet's most recent swaps, newest first.
// Preferred source: one getTransactionsForAddress call (10 credits) for the
// wallet's last HB_HISTORY_TXS full transactions, read into swaps by
// swapFromRawTransaction. Fallback when Helius doesn't serve that method: the
// legacy Enhanced Transactions API (100 credits per page of 100 swaps).
// Results are cached per-wallet for 1 day — the same whale wallets appear as top
// holders across many different tokens, so the cache hit rate is high after the
// first analysis of any given token.
async function fetchSwapHistory(walletAddress, maxCount) {
  const swapCacheKey = `hb-swaps:${walletAddress}`;
  const cached = await cache.get(swapCacheKey);
  if (cached) return cached;

  if (solanaService.isTransactionHistoryAvailable()) {
    try {
      const { txs } = await solanaService.getAccountTransactionsPage(walletAddress, { limit: HB_HISTORY_TXS });
      const swaps = [];
      for (const tx of txs || []) {
        const swap = swapFromRawTransaction(tx, walletAddress);
        if (swap) swaps.push(swap);
        if (swaps.length >= maxCount) break;
      }
      if (swaps.length > 0) await cache.set(swapCacheKey, swaps, TTL.DAY);
      return swaps;
    } catch (err) {
      // -32601 latches the legacy path in solana.js; anything else is this wallet's failure
      if (solanaService.isTransactionHistoryAvailable()) throw err;
    }
  }

  const results = [];
  let before = null;

  while (results.length < maxCount) {
    const batchSize = Math.min(100, maxCount - results.length);
    const opts = { limit: batchSize, type: 'SWAP' };
    if (before) opts.before = before;

    const txns = await solanaService.getTransactionsForAddress(walletAddress, opts);
    if (!txns || txns.length === 0) break;

    results.push(...txns);
    if (txns.length < batchSize) break; // no more pages
    before = txns[txns.length - 1].signature;
  }

  if (results.length > 0) {
    await cache.set(swapCacheKey, results, TTL.DAY);
  }
  return results;
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

    const processHolder = async (holder) => {
      try {
        // 25s timeout per holder — prevents one slow/hung Helius call from stalling the entire analysis
        let timeoutId;
        const txns = await Promise.race([
          fetchSwapHistory(holder.address, HB_MAX_SWAPS_PER_HOLDER),
          new Promise((_, reject) => { timeoutId = setTimeout(() => reject(new Error('holder timeout')), 25000); })
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
        return { rank: holder.rank, address: holder.address, percentage: holder.percentage,
          swapsAnalyzed: 0, tokensTraded: 0, avgHoldTimeMs: null, pairs: [] };
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
      eligible.map(h => cache.get(`hb-swaps:${h.address}`).then(v => [h, v]))
    );
    const cachedHolders   = swapCacheEntries.filter(([, v]) => v != null).map(([h]) => h);
    const uncachedHolders = swapCacheEntries.filter(([, v]) => v == null).map(([h]) => h);
    console.log(`[HB] ${mint.slice(0, 8)}: ${cachedHolders.length} cached, ${uncachedHolders.length} need Helius`);

    for (const holder of cachedHolders) {
      accumulateResult(await processHolder(holder));
    }

    // BATCH=2: 2 wallets, one history call each (the legacy path may page twice).
    // At 40 req/sec that drains in ~100ms; 600ms inter-batch delay gives 6× headroom.
    const BATCH = 2;
    const BATCH_DELAY_MS = 600;
    for (let i = 0; i < uncachedHolders.length; i += BATCH) {
      if (i > 0) await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
      const batch = uncachedHolders.slice(i, i + BATCH);
      const batchRes = await Promise.all(batch.map(processHolder));
      for (const r of batchRes) accumulateResult(r);
    }

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

    const result = {
      status: 'done',
      analyzedAt: now,
      holderCount: eligible.length,
      analyzedCount: holderResults.filter(h => h.swapsAnalyzed > 0).length,
      totalSwapsAnalyzed: totalSwaps,
      overallAvgHoldTimeMs,
      holders: holderResults,
      tokenStats
    };

    await cache.set(resultKey, result, HB_ANALYSIS_CACHE_TTL);
    console.log(`[HB] Done for ${mint.slice(0, 8)}: ${result.analyzedCount}/${result.holderCount} holders, ${totalSwaps} swaps`);
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
  HB_EXCLUDED_MINTS,
  DIAMOND_HANDS_BUCKETS,
  fetchSwapHistory,
  computeHoldPairs,
  runHolderBehaviorAnalysis
};
