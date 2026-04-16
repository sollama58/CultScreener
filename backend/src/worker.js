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
 * - warm-conviction: Refresh conviction scores for top-viewed tokens (every 10 min)
 * - warm-curated-conviction: Refresh conviction scores for all curated tokens (every hour)
 */

require('dotenv').config();
const { Worker } = require('bullmq');
const telegramBot = require('./telegram-bot');

// Import services for job processing
const db = require('./services/database');
const geckoService = require('./services/geckoTerminal');
const solanaService = require('./services/solana');
const { cache, TTL, keys } = require('./services/cache');

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

// Worker instances
const workers = [];

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
    console.log(`[Worker] Cleaned up ${count} expired sessions`);

    return { cleanedSessions: count };
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

    for (const mint of mints) {
      try {
        // Skip if already cached — solanaService.getTokenHolderCount checks Redis first
        const [countA, countB] = await Promise.all([
          cache.get(`holder-total:${mint}`),
          cache.get(keys.holderCount(mint))
        ]);
        if (countA > 0 || countB > 0) { skipped++; continue; }

        const count = await solanaService.getTokenHolderCount(mint);
        if (count && count > 0) {
          // solanaService already caches internally; belt-and-suspenders for both keys
          await Promise.all([
            cache.set(`holder-total:${mint}`, count, TTL.DAY),
            cache.set(keys.holderCount(mint), count, TTL.DAY)
          ]);
          fetched++;
        }
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
    if (!rawAccounts || rawAccounts.length === 0) return { status: 'empty' };

    console.log(`[Worker] Classifying ${rawAccounts.length} holder accounts for ${mint}`);

    const BURN_WALLETS = new Set([
      '1nc1nerator11111111111111111111111111111111',
      '1111111111111111111111111111111111111111111',
      'burnedFi11111111111111111111111111111111111',
    ]);
    const LP_PROGRAMS = new Set([
      '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
      'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
      'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',
      'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
      'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
      'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB',
      '2wT8Yq49kHgDzXuPxZSaeLaH1qbmGXtEyPy64bL7aD3c',
      '9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP',
      '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
      'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
    ]);

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

      // Check wallet on-chain owners to detect LP programs
      const wallets = [...walletToIndices.keys()];
      if (wallets.length > 0) {
        const walletAccounts = await solanaService.getMultipleAccounts(wallets);
        if (walletAccounts?.value) {
          walletAccounts.value.forEach((acct, wi) => {
            if (acct && LP_PROGRAMS.has(acct.owner)) {
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
        const top20Pct = realHolders.reduce((s, h) => s + (h.percentage || 0), 0);
        const top1Pct = realHolders[0]?.percentage || 0;
        let riskLevel = 'low';
        if (top10Pct > 70 || top1Pct > 30) riskLevel = 'high';
        else if (top10Pct > 40 || top1Pct > 15) riskLevel = 'medium';

        metrics = {
          top5Pct: Math.round(top5Pct * 100) / 100, top10Pct: Math.round(top10Pct * 100) / 100,
          top20Pct: Math.round(top20Pct * 100) / 100,
          herfindahl: Math.round(realHolders.reduce((s, h) => s + Math.pow(h.percentage || 0, 2), 0)),
          top1Pct: Math.round(top1Pct * 100) / 100,
          dominance: top20Pct > 0 ? Math.round((top1Pct / top20Pct) * 10000) / 100 : 0,
          avgBalance: realHolders.reduce((s, h) => s + h.balance, 0) / realHolders.length,
          avgPct: Math.round((top20Pct / realHolders.length) * 100) / 100,
          riskLevel, holderCount: null
        };

        // Fetch holder count
        try {
          let totalCount = await cache.get(`holder-total:${mint}`);
          if (!totalCount && solanaService.isHeliusConfigured()) {
            totalCount = await solanaService.getTokenHolderCount(mint).catch(() => null);
            if (totalCount && totalCount > 0) {
              await cache.set(`holder-total:${mint}`, totalCount, TTL.DAY);
            }
          }
          if (totalCount && totalCount > 0) metrics.holderCount = totalCount;
        } catch (_) {}
      }

      const result = { holders, totalSupply, metrics, supply, fetchedAt: Date.now() };
      await cache.set(`holder-analytics:${mint}`, result, TTL.HOUR);
      await cache.delete(`holder-classify-pending:${mint}`);

      // Pre-fetch 250-holder sample for hold-times and diamond-hands endpoints.
      // This avoids a blocking getTokenHolderSample call in the API process.
      try {
        const sampleCacheKey = `diamond-hands-wallets:${mint}`;
        const existingSample = await cache.get(sampleCacheKey);
        if (!existingSample && solanaService.isHeliusConfigured()) {
          const sampleResult = await solanaService.getTokenHolderSample(mint, 250, new Set([...BURN_WALLETS, ...LP_PROGRAMS]));
          if (sampleResult && sampleResult.holders && sampleResult.holders.length > 0) {
            await cache.set(sampleCacheKey, sampleResult.holders, TTL.HOUR);
            // Only cache totalHolders from sample if we don't already have a precise count.
            // getTokenHolderSample returns a lower-bound (1000) for large tokens;
            // the precise paginated count is fetched separately above.
            if (sampleResult.totalHolders && sampleResult.totalHolders > 1000) {
              await cache.set(`holder-total:${mint}`, sampleResult.totalHolders, TTL.DAY);
            }
            console.log(`[Worker] Pre-fetched ${sampleResult.holders.length} holder sample for ${mint}`);
          }
        }
      } catch (sampleErr) {
        console.warn(`[Worker] Holder sample pre-fetch failed for ${mint}:`, sampleErr.message);
      }

      console.log(`[Worker] Holder analytics done for ${mint}: ${holders.length} holders, ${lpIndices.size} LP, ${burntIndices.size} burnt`);
      return { holders: holders.length, lp: lpIndices.size, burnt: burntIndices.size };
    } catch (err) {
      await cache.delete(`holder-classify-pending:${mint}`);
      throw err;
    }
  },

  /**
   * Unified holder metrics computation — used by both hold-times and diamond-hands.
   * Previously these were two separate jobs that duplicated API calls when both
   * endpoints were hit simultaneously. Now a single job computes per-wallet metrics
   * and clears the shared pending flag.
   */
  'compute-holder-metrics': async (job) => {
    const { mint, wallets, ataMap: jobAtaMap } = job.data;
    if (!wallets || wallets.length === 0) return { computed: 0 };

    console.log(`[Worker] Computing holder metrics for ${wallets.length} wallets (token ${mint})`);

    // Build ATA lookup from job data or fall back to diamond-hands-wallets cache
    let ataMap = jobAtaMap || {};
    if (!jobAtaMap || Object.keys(ataMap).length === 0) {
      try {
        const sample = await cache.get(`diamond-hands-wallets:${mint}`);
        if (Array.isArray(sample)) {
          for (const e of sample) {
            if (typeof e === 'object' && e.wallet && e.ata) ataMap[e.wallet] = e.ata;
          }
        }
      } catch (_) {}
    }

    const BATCH_SIZE = 3; // Reduced from 5 to limit concurrent Helius load
    const BATCH_DELAY_MS = 500; // Breathing room between batches
    let computed = 0;
    let skipped = 0;

    // Pre-load full wallet sample and any already-cached hold times
    const allSample = await cache.get(`diamond-hands-wallets:${mint}`) || [];
    const allWallets = allSample.map(e => typeof e === 'object' ? e.wallet : e);
    const totalWallets = allWallets.length;

    // Snapshot of already-resolved hold times before this job (other wallets in the full sample)
    const liveHoldTimes = {};
    let liveAnalyzedCount = 0;
    if (totalWallets > 0) {
      const existingVals = await Promise.all(allWallets.map(w => cache.get(`wallet-token-hold:${w}:${mint}`)));
      allWallets.forEach((w, i) => {
        const val = existingVals[i];
        if (val != null) {
          liveAnalyzedCount++;
          if (val > 0) liveHoldTimes[w] = val;
        }
      });
    }

    const PARTIAL_WRITE_EVERY = 3; // Write partial results every N batches
    const BUCKETS = [
      { key: '6h', ms: 6 * 3600000 },
      { key: '24h', ms: 24 * 3600000 },
      { key: '3d', ms: 3 * 86400000 },
      { key: '1w', ms: 7 * 86400000 },
      { key: '1m', ms: 30 * 86400000 },
      { key: '3m', ms: 90 * 86400000 },
      { key: '6m', ms: 180 * 86400000 },
      { key: '9m', ms: 270 * 86400000 },
    ];

    let batchIndex = 0;
    for (let i = 0; i < wallets.length; i += BATCH_SIZE) {
      const batch = wallets.slice(i, i + BATCH_SIZE);

      // Add inter-batch delay to prevent queue flooding
      if (i > 0) {
        await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
      }

      const batchResults = await Promise.all(
        batch.map(async (wallet) => {
          try {
            // Pass pre-resolved ATA to skip the extra getTokenAccountsByOwner call
            const ata = ataMap[wallet] || null;
            const holdTime = await solanaService.getTokenHoldTime(wallet, mint, ata);
            return [wallet, holdTime];
          } catch (err) {
            console.warn(`[Worker] Hold time failed for ${wallet}:`, err.message);
            return [wallet, null];
          }
        })
      );

      for (const [wallet, holdTime] of batchResults) {
        const val = holdTime ?? -1;
        await cache.set(`wallet-hold-time:${wallet}`, val, 2 * TTL.DAY);
        await cache.set(`wallet-token-hold:${wallet}:${mint}`, val, 2 * TTL.DAY);
        liveAnalyzedCount++;
        if (val > 0) { liveHoldTimes[wallet] = val; computed++; } else { skipped++; }
      }

      batchIndex++;

      // Write partial distribution after every N batches so the API returns live progress
      if (batchIndex % PARTIAL_WRITE_EVERY === 0 && totalWallets > 0) {
        try {
          const partialValues = Object.values(liveHoldTimes);
          if (partialValues.length > 0) {
            const distribution = {};
            for (const b of BUCKETS) {
              distribution[b.key] = Math.round((partialValues.filter(ms => ms >= b.ms).length / partialValues.length) * 1000) / 10;
            }
            const partialResult = { distribution, sampleSize: totalWallets, analyzed: liveAnalyzedCount, computed: false };
            await cache.set(`diamond-hands:${mint}`, partialResult, 120000); // 120s — refreshed on next partial write or final
          }
        } catch (_) {}
      }
    }

    // Clear unified pending flag
    await cache.delete(`holder-metrics-pending:${mint}`);

    // Rebuild diamond hands distribution and persist to DB
    try {
      if (totalWallets > 0) {
        const holdTimes = {};
        let analyzedCount = 0;
        const vals = await Promise.all(allWallets.map(w => cache.get(`wallet-token-hold:${w}:${mint}`)));
        allWallets.forEach((w, i) => {
          const val = vals[i];
          if (val != null) {
            analyzedCount++;
            if (val > 0) holdTimes[w] = val;
          }
        });
        // Compute distribution even with partial data (some wallets may not have resolved yet).
        // Full completion (analyzedCount === allWallets.length) persists to DB;
        // partial results are cached with a shorter TTL so they can be refined.
        const values = Object.values(holdTimes);
        if (values.length > 0) {
          const distribution = {};
          for (const b of BUCKETS) {
            distribution[b.key] = Math.round((values.filter(ms => ms >= b.ms).length / values.length) * 1000) / 10;
          }
          const isComplete = analyzedCount === totalWallets;
          const finalResult = { distribution, sampleSize: totalWallets, analyzed: analyzedCount, computed: isComplete };
          const cacheTTL = isComplete ? 3 * TTL.HOUR : TTL.HOUR;
          await cache.set(`diamond-hands:${mint}`, finalResult, cacheTTL);
          if (isComplete) {
            await db.upsertConviction(mint, distribution, totalWallets, analyzedCount);
            console.log(`[Worker] Diamond hands persisted for ${mint}: ${distribution['1m']}% >1M`);
          } else {
            console.warn(`[Worker] Diamond hands partial for ${mint}: ${analyzedCount}/${totalWallets} analyzed, cached with short TTL`);
          }
        }
      }
    } catch (persistErr) {
      console.warn(`[Worker] Diamond hands persist failed for ${mint}:`, persistErr.message);
    }

    console.log(`[Worker] Holder metrics for ${mint}: ${computed} computed, ${skipped} no data`);
    return { computed, skipped };
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
  // Conviction Warming (moved from app.js setInterval)
  // ==========================================

  /**
   * Trigger diamond-hands computation for top-viewed tokens that have stale/missing conviction.
   * Runs every 10 minutes via BullMQ repeating job — replaces setInterval in app.js.
   */
  'warm-conviction': async (job) => {
    const STALE_MS    = 6 * 3600000; // 6 hours
    const MAX_PER_CYCLE = 3;

    const topTokens = await db.getMostViewedTokens(30).catch(() => []);
    if (!topTokens || topTokens.length === 0) return { triggered: 0 };

    const allMints = topTokens.map(t => t.token_mint);
    const dbRows   = await db.getTokensBatch(allMints).catch(() => []);
    const dbRowMap = {};
    for (const row of dbRows) dbRowMap[row.mint_address] = row;

    let triggered = 0;
    for (const token of topTokens) {
      if (triggered >= MAX_PER_CYCLE) break;
      const mint = token.token_mint;

      if (await cache.get(`diamond-hands:${mint}`)) continue;
      if (await cache.get(`holder-metrics-pending:${mint}`)) continue;

      const dbRow = dbRowMap[mint];
      if (dbRow && dbRow.conviction_computed_at) {
        const ts = new Date(dbRow.conviction_computed_at).getTime();
        if (!isNaN(ts) && Date.now() - ts < STALE_MS) continue;
      }

      // Trigger via compute-holder-analytics which will chain into compute-holder-metrics
      await require('./services/jobQueue').addAnalyticsJob(
        'compute-holder-analytics', { mint }, { priority: 10 }
      ).catch(() => {});
      triggered++;
    }

    if (triggered > 0) console.log(`[Worker] warm-conviction: triggered ${triggered} tokens`);
    return { triggered };
  },

  /**
   * Trigger diamond-hands computation for all curated tokens with stale/missing conviction.
   * Runs every hour via BullMQ repeating job — replaces setInterval in app.js.
   */
  'warm-curated-conviction': async (job) => {
    const STALE_MS = 60 * 60 * 1000; // 1 hour

    const curatedTokens = await db.getCuratedTokens().catch(() => []);
    if (!curatedTokens || curatedTokens.length === 0) return { triggered: 0 };

    const allMints = curatedTokens.map(t => t.mintAddress || t.mint_address).filter(Boolean);
    const dbRows   = await db.getTokensBatch(allMints).catch(() => []);
    const dbRowMap = {};
    for (const row of dbRows) dbRowMap[row.mint_address] = row;

    let triggered = 0;
    for (const token of curatedTokens) {
      const mint = token.mintAddress || token.mint_address;
      if (!mint) continue;

      if (await cache.get(`holder-metrics-pending:${mint}`)) continue;

      const dbRow = dbRowMap[mint];
      if (dbRow && dbRow.conviction_computed_at) {
        const ts = new Date(dbRow.conviction_computed_at).getTime();
        if (!isNaN(ts) && Date.now() - ts < STALE_MS) continue;
      }

      await require('./services/jobQueue').addAnalyticsJob(
        'compute-holder-analytics', { mint }, { priority: 10 }
      ).catch(() => {});
      triggered++;

      // Stagger every 3 triggers to avoid overloading Helius
      if (triggered % 3 === 0) await new Promise(r => setTimeout(r, 10000));
    }

    if (triggered > 0) console.log(`[Worker] warm-curated-conviction: triggered ${triggered}/${curatedTokens.length} curated tokens`);
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
        const result = await processor(job);
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
      lockDuration: 300000, // 5 min lock — compute-holder-metrics can take 150-200s for 250 wallets
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
  console.log(`
╔════════════════════════════════════════════╗
║     CultScreener Background Worker         ║
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

  // Start Telegram bot if token is configured
  telegramBot.startBot(process.env.TELEGRAM_BOT_TOKEN);
}

/**
 * Graceful shutdown
 */
async function shutdown(signal) {
  console.log(`\n[Worker] ${signal} received. Shutting down gracefully...`);

  // Close all workers
  for (const worker of workers) {
    await worker.close();
  }

  await telegramBot.stopBot();

  console.log('[Worker] All workers stopped');
  process.exit(0);
}

// Handle shutdown signals
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Handle uncaught errors
process.on('uncaughtException', (err) => {
  console.error('[Worker] Uncaught exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Worker] Unhandled rejection at:', promise, 'reason:', reason);
});

// Start the worker
start().catch((err) => {
  console.error('[Worker] Failed to start:', err);
  process.exit(1);
});
