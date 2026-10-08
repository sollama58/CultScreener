/**
 * Background Worker Process
 *
 * This is a separate Node.js process that handles background jobs
 * to keep the main API server responsive.
 *
 * Run with: node src/worker.js
 * Or in production: npm run worker
 *
 * Jobs handled:
 * - Session cleanup (every 30 min)
 * - View count batching
 * - Stats aggregation
 * - compute-holder-behavior: Holder behavior analysis (HB) for a token
 * - warm-curated-conviction: Refresh conviction scores for all curated tokens (every hour)
 * - crown-king-of-pill: Daily Diamond Hands scores and the King of the Pill (00:20 UTC)
 *
 * Recurring schedules are listed in services/jobQueue.js (RECURRING_JOBS); this
 * process re-checks them every few minutes.
 */

require('dotenv').config();
const { Worker } = require('bullmq');
const telegramBot = require('./telegram-bot');

// Import services for job processing
const db = require('./services/database');
const geckoService = require('./services/geckoTerminal');
const solanaService = require('./services/solana');
const heliusCredits = require('./services/heliusCredits');
const { cache, TTL, keys } = require('./services/cache');
const { BURN_WALLETS, LP_AUTHORITIES, SYSTEM_PROGRAM_ID } = require('./constants');

// Allowed DEXes for similar-tokens anti-spoofing filter
const SIMILAR_TOKEN_DEX_PREFIXES = ['raydium', 'pump', 'bonk'];

// Redis connection config
const REDIS_URL = process.env.REDIS_URL;

function getRedisConfig() {
  if (!REDIS_URL) return null;

  try {
    const url = new URL(REDIS_URL);
    return {
      host: url.hostname,
      port: parseInt(url.port) || 6379,
      password: url.password || undefined,
      username: url.username || undefined,
      tls: url.protocol === 'rediss:' ? {} : undefined,
      maxRetriesPerRequest: null
    };
  } catch (err) {
    console.error('[Worker] Failed to parse REDIS_URL:', err.message);
    return null;
  }
}

// Most mints fetch-holder-counts-batch pages DAS for in one job
const HOLDER_COUNT_SCANS_PER_JOB = 20;

// Worker instances
const workers = [];

// How often the worker re-checks that the recurring job schedules exist
const SCHEDULE_CHECK_MS = 5 * 60 * 1000;
let scheduleCheckTimer = null;

// Job processors
const jobProcessors = {
  // ==========================================
  // Maintenance Jobs
  // ==========================================

  /**
   * Clean up expired admin sessions
   */
  'cleanup-sessions': async (job) => {
    console.log('[Worker] Running session cleanup...');

    if (!db.isReady()) {
      throw new Error('Database not ready');
    }

    const count = await db.cleanupExpiredAdminSessions();
    // Unscanned pairing codes from Mobile Connect. Each is one row with a two-minute life, so
    // they are individually trivial and collectively unbounded - a QR regenerated a few times a
    // day by every user adds up to a table nobody ever looks at.
    const devices = await db.cleanupExpiredDeviceSessions();
    console.log(`[Worker] Cleaned up ${count} expired sessions, ${devices} expired device sessions`);

    return { cleanedSessions: count, cleanedDeviceSessions: devices };
  },

  /**
   * Invalidate stale cache entries
   */
  'cleanup-cache': async (job) => {
    console.log('[Worker] Running cache cleanup...');
    // Cache cleanup is handled automatically by TTL
    // This job can be used for forced cleanup if needed
    return { status: 'completed' };
  },

  // ==========================================
  // Analytics Jobs
  // ==========================================

  /**
   * Batch update view counts
   * Receives buffered view increments and writes to database in one transaction
   */
  'batch-view-counts': async (job) => {
    const { updates } = job.data;

    if (!updates || updates.length === 0) {
      return { updated: 0 };
    }

    if (!db.isReady()) {
      throw new Error('Database not ready');
    }

    console.log(`[Worker] Processing ${updates.length} view count updates...`);

    // Single UNNEST INSERT replaces N individual round-trips — dramatically faster
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');

      const mints = updates.map(u => u.tokenMint);
      const counts = updates.map(u => u.count);

      await client.query(`
        INSERT INTO token_views (token_mint, view_count, last_viewed_at)
        SELECT unnest($1::text[]), unnest($2::int[]), NOW()
        ON CONFLICT (token_mint) DO UPDATE SET
          view_count = token_views.view_count + EXCLUDED.view_count,
          last_viewed_at = NOW()
      `, [mints, counts]);

      await client.query('COMMIT');
      console.log(`[Worker] View counts updated: ${updates.length} tokens`);
      return { updated: updates.length, errors: 0 };
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      console.error('[Worker] Batch view update failed:', err.message);
      throw err;
    } finally {
      client.release();
    }
  },

  /**
   * Aggregate admin statistics
   * Pre-computes expensive stats queries and caches results
   */
  'aggregate-stats': async (job) => {
    console.log('[Worker] Aggregating admin statistics...');

    if (!db.isReady()) {
      throw new Error('Database not ready');
    }

    // Force refresh of admin stats cache
    db.invalidateAdminStatsCache();
    const stats = await db.getAdminStats();

    console.log('[Worker] Stats aggregation complete');
    return { stats };
  },

  // ==========================================
  // Search Jobs
  // ==========================================

  /**
   * Compute similar tokens for anti-spoofing
   * Heavy work: DB similarity query + multiple GeckoTerminal API calls
   */
  'compute-similar-tokens': async (job) => {
    const { mint } = job.data;
    console.log(`[Worker] Computing similar tokens for ${mint}...`);

    if (!db.isReady()) {
      throw new Error('Database not ready');
    }

    // Resolve the current token's name and symbol
    let tokenName = null;
    let tokenSymbol = null;

    // Check token info cache first (detail cache, then batch cache)
    const cachedMeta = await cache.getWithMeta(keys.tokenInfo(mint))
      || await cache.getWithMeta(`batch:${mint}`);
    if (cachedMeta && cachedMeta.value) {
      tokenName = cachedMeta.value.name;
      tokenSymbol = cachedMeta.value.symbol;
    }

    // Fallback to local database
    if (!tokenName) {
      const localToken = await db.getToken(mint);
      if (localToken) {
        tokenName = localToken.name;
        tokenSymbol = localToken.symbol;
      }
    }

    // Fallback to GeckoTerminal
    if (!tokenName) {
      try {
        const geckoInfo = await geckoService.getTokenInfo(mint);
        if (geckoInfo) {
          tokenName = geckoInfo.name;
          tokenSymbol = geckoInfo.symbol;
        }
      } catch (err) {
        // Non-critical
      }
    }

    if (!tokenName && !tokenSymbol) {
      await cache.set(`similar:${mint}`, { results: [], enriched: true }, TTL.PRICE_DATA);
      return { count: 0 };
    }

    // Step 1: Query local database using pg_trgm similarity
    let results = await db.findSimilarTokens(mint, tokenName, tokenSymbol, 15);

    // Step 2: If fewer than 5 results, supplement with GeckoTerminal search
    // Parallelize name + symbol searches when both are available
    if (results.length < 5 && (tokenName || tokenSymbol)) {
      const searches = [];
      if (tokenName) {
        searches.push(geckoService.searchTokens(tokenName, 10, SIMILAR_TOKEN_DEX_PREFIXES).catch(() => []));
      }
      if (tokenSymbol && tokenSymbol !== tokenName) {
        searches.push(geckoService.searchTokens(tokenSymbol, 10, SIMILAR_TOKEN_DEX_PREFIXES).catch(() => []));
      }

      const searchResults = await Promise.all(searches);
      const existingAddresses = new Set(results.map(r => r.address));
      existingAddresses.add(mint);

      for (const geckoResults of searchResults) {
        for (const token of geckoResults) {
          if (results.length >= 5) break;
          const addr = token.address || token.mintAddress;
          if (!addr || existingAddresses.has(addr)) continue;
          existingAddresses.add(addr);

          results.push({
            address: addr,
            name: token.name,
            symbol: token.symbol,
            decimals: token.decimals || 9,
            logoURI: token.logoUri || token.logoURI || null,
            pairCreatedAt: token.pairCreatedAt || null,
            price: token.price || null,
            marketCap: token.marketCap || null,
            volume24h: token.volume24h || null,
            similarityScore: null,
            nameSimilarity: null,
            symbolSimilarity: null,
            source: 'external'
          });
        }
      }
    }

    // Step 4: Batch-enrich all results with getMultiTokenInfo (1 call per 30 tokens)
    // Then DEX-filter local results using individual pool lookups only for top candidates
    const allAddresses = results.map(t => t.address);
    if (allAddresses.length > 0) {
      try {
        const batchInfo = await geckoService.getMultiTokenInfo(allAddresses);
        for (const token of results) {
          const data = batchInfo[token.address];
          if (data) {
            if (!token.name && data.name) token.name = data.name;
            if (!token.symbol && data.symbol) token.symbol = data.symbol;
            if (!token.price && data.price) token.price = data.price;
            if (!token.marketCap) token.marketCap = data.marketCap || data.fdv || null;
            if (!token.volume24h && data.volume24h) token.volume24h = data.volume24h;
            if (!token.logoURI && data.logoUri) token.logoURI = data.logoUri;
            token._enriched = true;
          }
        }
      } catch (_) { /* non-critical */ }
    }

    // DEX filtering: only check local results that need dexId verification
    // Limit to top 8 local results to cap API calls (only 5 needed in final)
    const localResults = results.filter(t => t.source === 'local').slice(0, 8);
    if (localResults.length > 0) {
      try {
        const overviewResults = await Promise.allSettled(
          localResults.map(t => geckoService.getTokenOverview(t.address))
        );
        for (let i = 0; i < localResults.length; i++) {
          const result = overviewResults[i];
          if (result.status === 'fulfilled' && result.value) {
            localResults[i]._dexIds = result.value.dexIds || [];
            if (!localResults[i].pairCreatedAt && result.value.pairCreatedAt) {
              localResults[i].pairCreatedAt = result.value.pairCreatedAt;
            }
          } else {
            localResults[i]._dexIds = [];
          }
        }
      } catch (err) {
        for (const t of localResults) t._dexIds = [];
      }

      results = results.filter(t => {
        if (t.source !== 'local') return true;
        if (!t._dexIds || t._dexIds.length === 0) return false;
        return t._dexIds.some(dex =>
          SIMILAR_TOKEN_DEX_PREFIXES.some(prefix => dex.startsWith(prefix))
        );
      });
    }

    const final = results.slice(0, 5);

    // Clean up internal fields
    for (const t of final) { delete t._dexIds; delete t._enriched; }

    // Store enriched result in cache and clear pending flag
    const cacheTTL = final.length > 0 ? TTL.HOUR : TTL.PRICE_DATA;
    await cache.set(`similar:${mint}`, { results: final, enriched: true }, cacheTTL);
    await cache.delete(`similar-pending:${mint}`);
    console.log(`[Worker] Similar tokens for ${mint}: found ${final.length} results`);

    return { count: final.length };
  },

  // ==========================================
  // Holder Count Fetching Jobs
  // ==========================================

  /**
   * Fetch and cache holder counts for a batch of mints.
   * Replaces fire-and-forget calls in the API routes so the API process stays
   * free to serve requests while Helius DAS pagination happens here.
   */
  'fetch-holder-counts-batch': async (job) => {
    const { mints } = job.data;
    if (!mints || mints.length === 0) return { processed: 0 };

    console.log(`[Worker] Fetching holder counts for ${mints.length} token(s)`);
    let fetched = 0;
    let skipped = 0;

    // Redis or the latest holder snapshot's count first; DAS pagination only for the rest
    const known = await require('./services/holderCounts').getDisplayCounts(mints).catch(() => ({}));
    let scanned = 0;
    for (const mint of mints) {
      try {
        if (known[mint] > 0) { skipped++; continue; }
        // Each scan pages DAS; cap them per job so a long list doesn't hold a
        // worker slot for minutes. The rest are re-queued on their next cache miss.
        if (scanned >= HOLDER_COUNT_SCANS_PER_JOB) break;
        scanned++;

        const count = await solanaService.getTokenHolderCount(mint);
        // getTokenHolderCount caches exact counts internally (TTL.HOLDER_COUNT)
        if (count && count > 0) fetched++;
      } catch (err) {
        console.warn(`[Worker] Holder count failed for ${mint.slice(0, 8)}:`, err.message);
      }
    }

    console.log(`[Worker] Holder counts — fetched: ${fetched}, skipped (cached): ${skipped}`);
    return { processed: mints.length, fetched, skipped };
  },

  // ==========================================
  // Holder Analytics Jobs
  // ==========================================

  /**
   * Classify holder accounts — resolve wallet owners, detect LP/burn/lock.
   * This is the heavy work that was previously done inline in the holders endpoint.
   * Triggered by GET /api/tokens/:mint/holders when cache is cold.
   */
  'compute-holder-analytics': async (job) => {
    const { mint, rawAccounts, totalSupply, usedDAS, supplyDecimals } = job.data;
    if (!rawAccounts || rawAccounts.length === 0) {
      await cache.delete(`holder-classify-pending:${mint}`).catch(() => {});
      return { status: 'empty' };
    }

    console.log(`[Worker] Classifying ${rawAccounts.length} holder accounts for ${mint}`);

    try {
      // Fetch mint account info + token authorities + Streamflow locks in parallel
      const [mintAccount, tokenAuth, lockedAmount] = await Promise.all([
        solanaService.getAccountInfo(mint).catch(() => null),
        solanaService.getTokenAuthorities(mint).catch(() => null),
        solanaService.getStreamflowLockedAmount(mint, supplyDecimals).catch(err => {
          console.warn('[Worker] Streamflow check failed:', err.message);
          return 0;
        })
      ]);

      const mintData = mintAccount?.value?.data?.parsed?.info;
      const decimals = mintData?.decimals || supplyDecimals || 0;
      const currentSupply = mintData
        ? parseFloat(mintData.supply) / Math.pow(10, decimals)
        : totalSupply;

      let deadWalletBurnt = 0;
      const lpIndices = new Set();
      const burntIndices = new Set();
      const walletToIndices = new Map();

      if (usedDAS) {
        rawAccounts.forEach((a, i) => {
          if (!a.wallet) return;
          if (BURN_WALLETS.has(a.wallet)) { deadWalletBurnt += a.uiAmount; burntIndices.add(i); return; }
          if (!walletToIndices.has(a.wallet)) walletToIndices.set(a.wallet, []);
          walletToIndices.get(a.wallet).push(i);
        });
      } else {
        // Resolve token account addresses → wallet owners
        const accts = await solanaService.getMultipleAccounts(rawAccounts.map(a => a.address));
        if (accts?.value) {
          accts.value.forEach((acct, i) => {
            const wallet = acct?.data?.parsed?.info?.owner;
            if (!wallet) return;
            rawAccounts[i].wallet = wallet;
            if (BURN_WALLETS.has(wallet)) { deadWalletBurnt += rawAccounts[i].uiAmount; burntIndices.add(i); return; }
            if (!walletToIndices.has(wallet)) walletToIndices.set(wallet, []);
            walletToIndices.get(wallet).push(i);
          });
        }
      }

      // Check wallet on-chain owners: anything not owned by the System Program is a
      // program-derived vault (AMM pool, locker, staking contract), not a person
      const wallets = [...walletToIndices.keys()];
      if (wallets.length > 0) {
        const walletAccounts = await solanaService.getMultipleAccounts(wallets);
        if (walletAccounts?.value) {
          walletAccounts.value.forEach((acct, wi) => {
            if ((acct && acct.owner && acct.owner !== SYSTEM_PROGRAM_ID) || LP_AUTHORITIES.has(wallets[wi])) {
              const indices = walletToIndices.get(wallets[wi]);
              if (indices) for (const idx of indices) lpIndices.add(idx);
            }
          });
        }
      }

      // Build full result with SPL burn detection
      const PUMP_FUN_AUTHORITIES = new Set([
        'TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM',
        '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
        '39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg',
      ]);
      let splBurnt = 0;
      let isPumpFun = false;
      if (currentSupply && currentSupply > 0) {
        const isPumpFunAuth = tokenAuth?.authorities?.some(a => PUMP_FUN_AUTHORITIES.has(a.address));
        const isPumpFunMint = !isPumpFunAuth && decimals === 6 && mintData
          && mintData.mintAuthority === null && mintData.freezeAuthority === null
          && currentSupply > 0 && currentSupply <= 1000000000;
        isPumpFun = !!(isPumpFunAuth || isPumpFunMint);
        if (isPumpFun && decimals === 6) {
          const diff = 1000000000 - currentSupply;
          if (diff > 0) splBurnt = diff;
        }
      }

      const burntAmount = splBurnt + deadWalletBurnt;
      const supplyDenominator = isPumpFun ? 1000000000 : currentSupply;
      const supply = {
        total: currentSupply, burnt: burntAmount,
        burntPct: supplyDenominator > 0 && burntAmount > 0 ? (burntAmount / supplyDenominator) * 100 : 0,
        locked: lockedAmount, lockedPct: currentSupply > 0 && lockedAmount > 0 ? (lockedAmount / currentSupply) * 100 : 0,
        splBurnt, deadWalletBurnt, isPumpFun
      };

      const holders = rawAccounts.map((a, i) => ({
        rank: i + 1, address: a.wallet || a.address, balance: a.uiAmount,
        percentage: (totalSupply || currentSupply) > 0 ? (a.uiAmount / (totalSupply || currentSupply)) * 100 : null,
        isLP: lpIndices.has(i), isBurnt: burntIndices.has(i)
      })).filter(h => h.balance > 0);

      // Recompute metrics excluding LP/burn
      const realHolders = holders.filter(h => !h.isLP && !h.isBurnt);
      let metrics = null;
      if ((totalSupply || currentSupply) > 0 && realHolders.length > 0) {
        const top5Pct = realHolders.slice(0, 5).reduce((s, h) => s + (h.percentage || 0), 0);
        const top10Pct = realHolders.slice(0, 10).reduce((s, h) => s + (h.percentage || 0), 0);
        const top20Pct = realHolders.slice(0, 20).reduce((s, h) => s + (h.percentage || 0), 0);
        const top1Pct = realHolders[0]?.percentage || 0;

        metrics = {
          top5Pct: Math.round(top5Pct * 100) / 100, top10Pct: Math.round(top10Pct * 100) / 100,
          top20Pct: Math.round(top20Pct * 100) / 100,
          herfindahl: Math.round(realHolders.reduce((s, h) => s + Math.pow(h.percentage || 0, 2), 0)),
          top1Pct: Math.round(top1Pct * 100) / 100,
          dominance: top20Pct > 0 ? Math.round((top1Pct / top20Pct) * 10000) / 100 : 0,
          avgBalance: realHolders.reduce((s, h) => s + h.balance, 0) / realHolders.length,
          avgPct: Math.round((top20Pct / realHolders.length) * 100) / 100,
          holderCount: null
        };

        // Fetch holder count
        try {
          // Redis, then the latest holder snapshot's count, then a DAS count.
          // History points come only from snapshots (services/holderCounts.js).
          let totalCount = (await require('./services/holderCounts').getDisplayCounts([mint]))[mint];
          if (!totalCount && solanaService.isHeliusConfigured()) {
            // getTokenHolderCount caches results internally (TTL.HOLDER_COUNT)
            totalCount = await solanaService.getTokenHolderCount(mint).catch(() => null);
          }
          if (totalCount && totalCount > 0) metrics.holderCount = totalCount;
        } catch (_) {}
      }

      const result = { holders, totalSupply, metrics, supply, fetchedAt: Date.now() };
      // Outlives the next curated snapshot (every refreshMs), which re-runs this job;
      // a shorter TTL left a gap where page views re-queued it for the same list
      await cache.set(`holder-analytics:${mint}`, result, require('./services/holderPipeline').CONFIG.refreshMs + 2 * TTL.HOUR);
      await cache.delete(`holder-classify-pending:${mint}`);

      console.log(`[Worker] Holder analytics done for ${mint}: ${holders.length} holders, ${lpIndices.size} LP, ${burntIndices.size} burnt`);
      return { holders: holders.length, lp: lpIndices.size, burnt: burntIndices.size };
    } catch (err) {
      await cache.delete(`holder-classify-pending:${mint}`);
      throw err;
    }
  },

  /**
   * Full holder snapshot (services/holderPipeline.js): every token account, stored
   * in Postgres with the conviction sample, then the hold-time backfill is queued.
   * Also refreshes the holder list from the snapshot's top holders.
   */
  'snapshot-holders': async (job) => {
    const { mint } = job.data;
    if (!mint) return { error: 'No mint provided' };
    const holderPipeline = require('./services/holderPipeline');
    const result = await holderPipeline.takeSnapshot(mint);

    // An unchanged holder list whose classification is still cached needs no re-run
    const classified = result.status === 'unchanged' && !!(await cache.get(`holder-analytics:${mint}`).catch(() => null));
    if ((result.status === 'ok' || result.status === 'unchanged') && !classified && !(await cache.get(`holder-classify-pending:${mint}`))) {
      const list = await holderPipeline.getSnapshotHolderList(mint).catch(() => null);
      if (list) {
        await cache.set(`holder-classify-pending:${mint}`, Date.now(), 120000);
        await require('./services/jobQueue').addAnalyticsJob('compute-holder-analytics', {
          mint, rawAccounts: list.rawAccounts, totalSupply: list.totalSupply, usedDAS: true, supplyDecimals: list.decimals,
        }).catch(() => cache.delete(`holder-classify-pending:${mint}`));
      }
    }
    return result;
  },

  /**
   * Hold-time backfill for sampled and listed wallets whose streak start is unknown.
   * Bounded per run; re-queues itself until done, then stores diamond hands.
   */
  'backfill-holder-acquisitions': async (job) => {
    const { mint } = job.data;
    if (!mint) return { error: 'No mint provided' };
    return require('./services/holderPipeline').runBackfill(mint);
  },

  // ==========================================
  // Holder Behavior Analysis
  // ==========================================

  /**
   * Run full holder behavior analysis for a token.
   * Moved from API process (setImmediate + spin-wait semaphore) to worker.
   * BullMQ concurrency setting caps simultaneous analyses instead of the old semaphore.
   */
  'compute-holder-behavior': async (job) => {
    const { mint } = job.data;
    if (!mint) return { error: 'No mint provided' };
    const { runHolderBehaviorAnalysis } = require('./services/holderBehaviorAnalysis');
    await runHolderBehaviorAnalysis(mint);
    return { mint };
  },

  // ==========================================
  // Curated Price Refresh
  // ==========================================

  /**
   * Score every curated token's diamond hands for today and settle the King of the
   * Pill (services/kingOfPill.js). Reads stored data only; idempotent within a day.
   */
  'crown-king-of-pill': async () => {
    const kingOfPill = require('./services/kingOfPill');
    return kingOfPill.runDailyCrowning();
  },

  /**
   * Daily safety net for holder count history. Points are written by holder
   * snapshots (every HOLDER_SNAPSHOT_REFRESH_HOURS for curated tokens); any curated
   * token with no point at all in the last day gets a snapshot queued. A capped
   * token's points are never "complete", so they are not re-snapshotted for that
   * alone. No counting here, so every point in the history means the same thing.
   */
  'record-holder-counts': async (job) => {
    const holderPipeline = require('./services/holderPipeline');
    const holderCounts = require('./services/holderCounts');
    const curatedTokens = await db.getCuratedTokens().catch(() => []);
    const mints = (curatedTokens || []).map(t => t.mintAddress || t.mint_address).filter(Boolean);
    const latest = await holderCounts.getLatestPoints(mints).catch(() => ({}));

    let recorded = 0;
    let skipped  = 0;
    for (const mint of mints) {
      const p = latest[mint];
      if (p && Date.now() - p.takenAt < 24 * 3600000) { skipped++; continue; }
      if (await holderPipeline.ensureSnapshot(mint).catch(() => false)) recorded++;
    }

    // Daily housekeeping: drop holder snapshots/positions of mints no longer snapshotted
    const pruned = await require('./services/holderStore').pruneAbandonedMints().catch(err => {
      console.warn('[Worker] Holder snapshot prune failed:', err.message);
      return 0;
    });

    console.log(`[Worker] record-holder-counts: ${recorded} snapshots queued, ${skipped} already current, ${pruned} stale positions pruned`);
    return { queued: recorded, skipped };
  },

  /**
   * Refresh market cap and price data for all curated tokens every 10 minutes.
   * Uses GeckoTerminal batch API (getMultiTokenInfo) — no extra API calls beyond
   * what the leaderboard already uses. Updates tokens table and ATH tracking.
   */
  'refresh-curated-prices': async (job) => {
    const curatedTokens = await db.getCuratedTokens().catch(() => []);
    if (!curatedTokens || curatedTokens.length === 0) return { updated: 0, athUpdated: 0 };

    const allMints = curatedTokens.map(t => t.mintAddress || t.mint_address).filter(Boolean);
    // GeckoTerminal multi-token endpoint supports up to 30 addresses per call.
    const CHUNK_SIZE = 30;
    let updated = 0;
    let athUpdated = 0;

    for (let i = 0; i < allMints.length; i += CHUNK_SIZE) {
      const chunk = allMints.slice(i, i + CHUNK_SIZE);

      let batchInfo = {};
      try {
        batchInfo = await geckoService.getMultiTokenInfo(chunk);
      } catch (err) {
        console.warn(`[Worker] refresh-curated-prices batch ${Math.floor(i / CHUNK_SIZE) + 1} failed:`, err.message);
        continue;
      }

      for (const mint of chunk) {
        const data = batchInfo[mint];
        if (!data) continue; // GeckoTerminal has no record of this token

        const marketCap = data.marketCap || data.fdv || null;

        // Always write fresh market data — use updateTokenMarketData (not upsertToken)
        // so price_change_24h is overwritten with the latest value rather than
        // COALESCE-d, preventing stale 24h% from lingering indefinitely.
        try {
          await db.updateTokenMarketData({
            mintAddress: mint,
            price: data.price ?? null,
            marketCap,
            volume24h: data.volume24h ?? null,
            priceChange24h: data.priceChange24h ?? null,
            logoUri: data.logoUri ?? null,
            name: data.name ?? null,
            symbol: data.symbol ?? null,
            decimals: data.decimals ?? null,
          });
          updated++;
        } catch (err) {
          console.warn(`[Worker] refresh-curated-prices update failed for ${mint.slice(0, 8)}:`, err.message);
        }

        if (marketCap > 0) {
          // Backfill mcap_at_added for tokens listed before this feature shipped
          const curatedToken = curatedTokens.find(t => (t.mintAddress || t.mint_address) === mint);
          if (curatedToken?.mcapAtAdded == null) {
            await db.updateCuratedTokenMcapAtAdded(mint, marketCap).catch(() => {});
          }

          // Update ATH (upward-only guard is inside updateCuratedTokenATH)
          const athResult = await db.updateCuratedTokenATH(mint, marketCap).catch(() => null);
          if (athResult) athUpdated++;
        }
      }

      // Pause between chunks to stay within GeckoTerminal free-tier rate limit (30 req/min)
      if (i + CHUNK_SIZE < allMints.length) {
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    // Fill in logos that are still missing. GeckoTerminal has no art for many small tokens (it
    // answers "missing.png", which is now stored as no logo), and DexScreener is only asked once,
    // when a token is curated - so without this a token could keep the fallback logo forever.
    // One Helius getAssetBatch covers every missing token, at most once an hour.
    let logosFilled = 0;
    try {
      const missing = await db.getMintsMissingLogo(allMints);
      if (missing.length > 0 && solanaService.isHeliusConfigured()
          && !(await cache.get('logo-backfill:recent').catch(() => null))) {
        await cache.set('logo-backfill:recent', true, 60 * 60 * 1000).catch(() => {});
        const meta = await solanaService.getTokenMetadataBatch(missing);
        for (const mint of missing) {
          if (meta[mint]?.logoUri && await db.setTokenLogoIfMissing(mint, meta[mint].logoUri).catch(() => false)) {
            logosFilled++;
          }
        }
        console.log(`[Worker] refresh-curated-prices: ${missing.length} tokens missing a logo, filled ${logosFilled} from Helius`);
      }
    } catch (logoErr) {
      console.warn('[Worker] refresh-curated-prices: logo backfill failed:', logoErr.message);
    }

    // Bust conviction leaderboard cache so fresh prices are served immediately
    try {
      await cache.clearPattern('leaderboard:conviction:*');
    } catch (cacheErr) {
      console.warn('[Worker] refresh-curated-prices: failed to bust leaderboard cache:', cacheErr.message);
    }

    console.log(`[Worker] refresh-curated-prices: updated ${updated} prices, ${athUpdated} ATH records`);
    return { updated, athUpdated, logosFilled };
  },

  /**
   * Store each curated token's price 1, 7 and 30 days ago (services/priceChanges.js) so the
   * home table can show 24h/7d/30d changes without calling upstream on page load. One 4h-candle
   * OHLCV request per token; at most PRICE_REFS_PER_RUN tokens per run, oldest refs first, so
   * every token is refreshed about every REFRESH_AFTER_MS without bursting GeckoTerminal.
   */
  'refresh-curated-price-refs': async (job) => {
    const priceChanges = require('./services/priceChanges');
    const PRICE_REFS_PER_RUN = 15;
    const mints = await db.getCuratedMintsNeedingPriceRefs(PRICE_REFS_PER_RUN, priceChanges.REFRESH_AFTER_MS).catch(() => []);
    let stored = 0;
    let empty = 0;
    for (let i = 0; i < mints.length; i++) {
      if (i > 0) await new Promise(r => setTimeout(r, 2000));
      const mint = mints[i];
      try {
        // null: no pool or no candles, so there is nothing to compare against
        const refs = await priceChanges.fetchReferencePrices(mint);
        await db.setCuratedPriceRefs(mint, refs || {});
        if (refs) stored++; else empty++;
      } catch (err) {
        // Upstream failed: keep the old references (they expire after a day on their own)
        // and move the token to the back of the queue.
        console.warn(`[Worker] refresh-curated-price-refs failed for ${mint.slice(0, 8)}:`, err.message);
        await db.setCuratedPriceRefs(mint, null).catch(() => {});
      }
    }
    if (stored > 0) await cache.clearPattern('leaderboard:conviction:*').catch(() => {});
    if (mints.length > 0) console.log(`[Worker] refresh-curated-price-refs: ${stored} stored, ${empty} without candles`);
    return { stored, empty };
  },

  // ==========================================
  // Conviction Warming (moved from app.js setInterval)
  // ==========================================

  /**
   * Trigger diamond-hands computation for all curated tokens with stale/missing conviction.
   * Runs every hour via BullMQ repeating job — replaces setInterval in app.js.
   */
  'warm-curated-conviction': async (job) => {
    // Holder distributions move slowly, so curated tokens are re-snapshotted every
    // HOLDER_SNAPSHOT_REFRESH_HOURS (default 4h; the job itself ticks hourly), each
    // on its own schedule (holderPipeline.isRefreshDue) so they don't all come due
    // in the same tick. Under 6h, new holders' hold times still come straight from
    // consecutive snapshots. A snapshot whose cheap pre-check found nothing changed
    // counts as fresh too.
    const holderPipeline = require('./services/holderPipeline');

    const curatedTokens = await db.getCuratedTokens().catch(() => []);
    if (!curatedTokens || curatedTokens.length === 0) return { triggered: 0 };

    const allMints = curatedTokens.map(t => t.mintAddress || t.mint_address).filter(Boolean);
    const snapshotTimes = await holderPipeline.getFreshnessTimes(allMints).catch(() => ({}));
    const dbRows   = await db.getTokensBatch(allMints).catch(() => []);
    const dbRowMap = {};
    for (const row of dbRows) dbRowMap[row.mint_address] = row;

    let triggered = 0;
    let refreshed = 0;
    for (const mint of allMints) {
      if (!holderPipeline.isRefreshDue(mint, snapshotTimes[mint])) {
        // Fresh snapshot: run the backfill pass anyway. It finishes any hold-time
        // backfill that stopped (failed job, Redis restart, a snapshot landing
        // mid-run) and, with nothing left to backfill, re-stores diamond hands so
        // the home tables keep up as hold times grow. Database only, no RPC.
        if (await holderPipeline.ensureBackfill(mint)) refreshed++;
        continue;
      }
      if (await holderPipeline.ensureSnapshot(mint)) triggered++;
    }

    if (triggered > 0 || refreshed > 0) {
      console.log(`[Worker] warm-curated-conviction: ${triggered} snapshots, ${refreshed} diamond hands refreshes, ${curatedTokens.length} curated tokens`);
    }

    // Update ATH market cap for curated tokens using current market cap from the tokens table.
    // This requires no extra API calls — the tokens table is kept fresh by price refresh jobs.
    let athUpdated = 0;
    for (const token of curatedTokens) {
      const mint = token.mintAddress || token.mint_address;
      if (!mint) continue;
      const dbRow = dbRowMap[mint];
      const currentMcap = dbRow?.market_cap != null ? parseFloat(dbRow.market_cap) : null;
      if (currentMcap == null || currentMcap <= 0) continue;

      // Also backfill mcap_at_added for tokens that were listed before this feature shipped
      if (token.mcapAtAdded == null) {
        await db.updateCuratedTokenMcapAtAdded(mint, currentMcap).catch(() => {});
      }

      const updated = await db.updateCuratedTokenATH(mint, currentMcap).catch(() => null);
      if (updated) athUpdated++;
    }
    if (athUpdated > 0) console.log(`[Worker] warm-curated-conviction: updated ATH for ${athUpdated} curated tokens`);

    return { triggered };
  }
};

/**
 * Create a worker for a specific queue
 */
function createWorker(queueName, redisConfig) {
  const worker = new Worker(
    queueName,
    async (job) => {
      const processor = jobProcessors[job.name];

      if (!processor) {
        console.warn(`[Worker] Unknown job type: ${job.name}`);
        return { error: 'Unknown job type' };
      }

      const startTime = Date.now();
      try {
        // Helius calls made by the job are credited to it (admin Helius Credits tab)
        const result = await heliusCredits.withSource(`job:${job.name}`, () => processor(job));
        const duration = Date.now() - startTime;
        console.log(`[Worker] Job ${job.name} completed in ${duration}ms`);
        return result;
      } catch (err) {
        const duration = Date.now() - startTime;
        console.error(`[Worker] Job ${job.name} failed after ${duration}ms:`, err.message);
        throw err;
      }
    },
    {
      connection: redisConfig,
      concurrency: parseInt(process.env.WORKER_CONCURRENCY) || 2, // Limit concurrency — holder-metrics/behavior jobs are Helius-heavy
      lockDuration: 300000, // 5 min lock (BullMQ renews it while a job runs; a backfill run is up to 4 min plus its slowest wallet)
      stalledInterval: 120000, // Check for stalled jobs every 2 min (must be < lockDuration)
      limiter: {
        max: parseInt(process.env.WORKER_LIMITER_MAX) || 3, // Max 3 jobs/sec — prevents multiple Helius-heavy jobs overlapping
        duration: 1000 // Per second
      }
    }
  );

  // Event handlers
  worker.on('completed', (job, result) => {
    // Logged in processor
  });

  worker.on('failed', (job, err) => {
    console.error(`[Worker] Job ${job?.name} (${job?.id}) failed:`, err.message);
  });

  worker.on('error', (err) => {
    console.error('[Worker] Worker error:', err.message);
  });

  return worker;
}

/**
 * Start the worker process
 */
async function start() {
  heliusCredits.setProcessRole('worker');
  console.log(`
╔════════════════════════════════════════════╗
║     HolDEX Background Worker         ║
╠════════════════════════════════════════════╣
║  Starting worker process...                ║
╚════════════════════════════════════════════╝
  `);

  // Log API key availability so missing keys are immediately obvious
  console.log(`[Worker] API keys: HELIUS=${process.env.HELIUS_API_KEY ? 'configured' : 'MISSING'}, COINGECKO=${process.env.COINGECKO_API_KEY ? 'configured' : 'MISSING'}`);

  const redisConfig = getRedisConfig();
  if (!redisConfig) {
    console.error('[Worker] REDIS_URL not configured. Worker cannot start.');
    process.exit(1);
  }

  // Wait for database to be ready
  console.log('[Worker] Waiting for database connection...');
  let dbRetries = 0;
  const maxDbRetries = 10;

  while (!db.isReady() && dbRetries < maxDbRetries) {
    await new Promise(r => setTimeout(r, 2000));
    dbRetries++;
    console.log(`[Worker] Database check ${dbRetries}/${maxDbRetries}...`);
  }

  if (!db.isReady()) {
    console.warn('[Worker] Database not ready - some jobs may fail');
  } else {
    console.log('[Worker] Database connected');
  }

  // Create workers for each queue
  const queueNames = ['maintenance', 'analytics', 'notifications', 'search'];

  for (const queueName of queueNames) {
    const worker = createWorker(queueName, redisConfig);
    workers.push(worker);
    console.log(`[Worker] Started worker for queue: ${queueName}`);
  }

  console.log(`[Worker] All workers started. Processing jobs...`);

  // The recurring jobs only run while their schedules exist in Redis. Re-check
  // them now and every few minutes, so a Redis restart or eviction doesn't
  // stop background updates until the next API deploy.
  const jobQueue = require('./services/jobQueue');
  let checking = false; // while Redis is down a check can hang; don't stack them
  const checkSchedules = async () => {
    if (checking) return;
    checking = true;
    try {
      const n = await jobQueue.ensureRecurringJobs();
      if (n < jobQueue.RECURRING_JOBS.length) console.warn(`[Worker] Only ${n}/${jobQueue.RECURRING_JOBS.length} recurring jobs scheduled`);
    } catch (err) {
      console.error('[Worker] Recurring job check failed:', err.message);
    } finally {
      checking = false;
    }
  };
  await checkSchedules();
  scheduleCheckTimer = setInterval(checkSchedules, SCHEDULE_CHECK_MS);

  // Start Telegram bot if token is configured
  telegramBot.startBot(process.env.TELEGRAM_BOT_TOKEN);
}

/**
 * Graceful shutdown
 *
 * All queue workers stop taking jobs at once and get `deadlineMs` to finish the
 * active ones. Past the deadline they are force-closed (their jobs are re-run by
 * BullMQ's stalled check). A hard timer exits the process if closing hangs.
 * Render waits maxShutdownDelaySeconds (render.yaml) before SIGKILL, so the
 * signal deadline stays under it.
 */
const SIGNAL_SHUTDOWN_MS = parseInt(process.env.WORKER_SHUTDOWN_DEADLINE_MS) || 270000;
const CRASH_SHUTDOWN_MS = 10000;
let shuttingDown = false;

async function shutdown(signal, { deadlineMs = SIGNAL_SHUTDOWN_MS, exitCode = 0 } = {}) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[Worker] ${signal} received. Shutting down gracefully (deadline ${Math.round(deadlineMs / 1000)}s)...`);
  if (scheduleCheckTimer) clearInterval(scheduleCheckTimer);

  // Exits even if a close below never settles
  const forceExit = setTimeout(() => {
    console.error('[Worker] Shutdown timed out, forcing exit');
    process.exit(exitCode || 1);
  }, deadlineMs + 10000);
  if (forceExit.unref) forceExit.unref();

  try {
    // Close all workers in parallel: none keeps picking up jobs while another drains
    let deadlineTimer;
    const drained = await Promise.race([
      Promise.all(workers.map(w => w.close().catch(err => console.error('[Worker] Close error:', err.message)))).then(() => true),
      new Promise(r => { deadlineTimer = setTimeout(() => r(false), deadlineMs); }),
    ]);
    clearTimeout(deadlineTimer);
    if (!drained) {
      console.warn('[Worker] Active jobs still running at the shutdown deadline; force-closing workers');
      await Promise.all(workers.map(w => w.close(true).catch(() => {})));
    }
  } catch (err) {
    console.error('[Worker] Error closing workers:', err.message);
  }

  await telegramBot.stopBot().catch(() => {});

  // Only now: in-flight jobs used these sockets until their workers closed
  try { require('./services/httpAgent').destroy(); } catch (_) {}

  console.log('[Worker] All workers stopped');
  process.exit(exitCode);
}

// Handle shutdown signals
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Handle uncaught errors: close the workers (short deadline) so finished jobs
// don't stay locked, then exit non-zero
process.on('uncaughtException', (err) => {
  console.error('[Worker] Uncaught exception:', err);
  shutdown('uncaughtException', { deadlineMs: CRASH_SHUTDOWN_MS, exitCode: 1 });
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Worker] Unhandled rejection at:', promise, 'reason:', reason);
  shutdown('unhandledRejection', { deadlineMs: CRASH_SHUTDOWN_MS, exitCode: 1 });
});

// Start the worker
start().catch((err) => {
  console.error('[Worker] Failed to start:', err);
  process.exit(1);
});
