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
 * - Session cleanup (hourly)
 * - View count batching
 * - Stats aggregation
 */

require('dotenv').config();
const { Worker } = require('bullmq');

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

    let successCount = 0;
    let errorCount = 0;

    // Process in batches to avoid overwhelming database
    const BATCH_SIZE = 50;
    for (let i = 0; i < updates.length; i += BATCH_SIZE) {
      const batch = updates.slice(i, i + BATCH_SIZE);

      // Use a transaction for each batch
      const client = await db.pool.connect();
      try {
        await client.query('BEGIN');

        for (const { tokenMint, count } of batch) {
          await client.query(`
            INSERT INTO token_views (token_mint, view_count, last_viewed_at)
            VALUES ($1, $2, NOW())
            ON CONFLICT (token_mint) DO UPDATE SET
              view_count = token_views.view_count + $2,
              last_viewed_at = NOW()
          `, [tokenMint, count]);
          successCount++;
        }

        await client.query('COMMIT');
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch (rollbackErr) {
          console.error('[Worker] Rollback failed:', rollbackErr.message);
        }
        console.error('[Worker] Batch view update failed:', err.message);
        errorCount += batch.length;
      } finally {
        client.release();
      }
    }

    console.log(`[Worker] View counts updated: ${successCount} success, ${errorCount} errors`);
    return { updated: successCount, errors: errorCount };
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
  // Holder Analytics Jobs
  // ==========================================

  /**
   * Unified holder metrics computation — used by both hold-times and diamond-hands.
   * Previously these were two separate jobs that duplicated API calls when both
   * endpoints were hit simultaneously. Now a single job computes per-wallet metrics
   * and clears the shared pending flag.
   */
  'compute-holder-metrics': async (job) => {
    const { mint, wallets } = job.data;
    if (!wallets || wallets.length === 0) return { computed: 0 };

    console.log(`[Worker] Computing holder metrics for ${wallets.length} wallets (token ${mint})`);

    const BATCH_SIZE = 5;
    let computed = 0;
    let skipped = 0;

    for (let i = 0; i < wallets.length; i += BATCH_SIZE) {
      const batch = wallets.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map(async (wallet) => {
          try {
            const holdTime = await solanaService.getTokenHoldTime(wallet, mint);
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
        if (val > 0) computed++; else skipped++;
      }
    }

    // Clear unified pending flag
    await cache.delete(`holder-metrics-pending:${mint}`);

    // Rebuild diamond hands distribution and persist to DB
    try {
      const allSample = await cache.get(`diamond-hands-wallets:${mint}`) || [];
      const allWallets = allSample.map(e => typeof e === 'object' ? e.wallet : e);
      if (allWallets.length > 0) {
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
        const values = Object.values(holdTimes);
        if (values.length > 0) {
          const distribution = {};
          for (const b of BUCKETS) {
            distribution[b.key] = Math.round((values.filter(ms => ms >= b.ms).length / values.length) * 1000) / 10;
          }
          const isComplete = analyzedCount === allWallets.length;
          const finalResult = { distribution, sampleSize: allWallets.length, analyzed: analyzedCount, computed: isComplete };
          const cacheTTL = isComplete ? 3 * TTL.HOUR : TTL.HOUR;
          await cache.set(`diamond-hands:${mint}`, finalResult, cacheTTL);
          if (isComplete) {
            await db.upsertConviction(mint, distribution, allWallets.length, analyzedCount);
            console.log(`[Worker] Diamond hands persisted for ${mint}: ${distribution['1m']}% >1M`);
          } else {
            console.warn(`[Worker] Diamond hands partial for ${mint}: ${analyzedCount}/${allWallets.length} analyzed, cached with short TTL`);
          }
        }
      }
    } catch (persistErr) {
      console.warn(`[Worker] Diamond hands persist failed for ${mint}:`, persistErr.message);
    }

    console.log(`[Worker] Holder metrics for ${mint}: ${computed} computed, ${skipped} no data`);
    return { computed, skipped };
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
      concurrency: parseInt(process.env.WORKER_CONCURRENCY) || 10, // Default to modest concurrency to avoid overwhelming APIs
      lockDuration: 60000, // 60s lock — prevents stalled job false positives on slow jobs
      stalledInterval: 30000, // Check for stalled jobs every 30s
      limiter: {
        max: parseInt(process.env.WORKER_LIMITER_MAX) || 10, // Max jobs per second (matched to concurrency)
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
