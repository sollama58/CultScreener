/**
 * Job Queue Service using BullMQ
 * Handles background job processing to keep the main server responsive
 *
 * Jobs are processed by a separate worker process (src/worker.js)
 */

const { Queue } = require('bullmq');

// Redis connection config (reuses existing REDIS_URL)
const REDIS_URL = process.env.REDIS_URL;

// Queue names
const QUEUE_NAMES = {
  MAINTENANCE: 'maintenance',    // Session cleanup, cache pruning
  ANALYTICS: 'analytics',        // View counting, stats aggregation
  NOTIFICATIONS: 'notifications', // Future: email, webhooks
  SEARCH: 'search'              // Similar-tokens computation
};

// Queues (initialized lazily)
let queues = {};
let isInitialized = false;

// Parse Redis URL for BullMQ connection
function getRedisConfig() {
  if (!REDIS_URL) return null;

  try {
    const url = new URL(REDIS_URL);
    return {
      host: url.hostname,
      port: parseInt(url.port) || 6379,
      password: url.password || undefined,
      username: url.username || undefined,
      // TLS for production Redis (Render, Railway, etc.)
      tls: url.protocol === 'rediss:' ? {} : undefined,
      maxRetriesPerRequest: null // Required for BullMQ
    };
  } catch (err) {
    console.error('[JobQueue] Failed to parse REDIS_URL:', err.message);
    return null;
  }
}

/**
 * Initialize job queues
 * Call this during app startup
 */
function initialize() {
  if (isInitialized) return true;

  const redisConfig = getRedisConfig();
  if (!redisConfig) {
    console.warn('[JobQueue] No REDIS_URL configured - job queue disabled');
    return false;
  }

  try {
    // Create queues
    for (const [key, name] of Object.entries(QUEUE_NAMES)) {
      queues[name] = new Queue(name, {
        connection: redisConfig,
        defaultJobOptions: {
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 1000
          },
          removeOnComplete: {
            count: 100,  // Keep last 100 completed jobs
            age: 3600    // Keep for 1 hour
          },
          removeOnFail: {
            count: 50,   // Keep last 50 failed jobs for debugging
            age: 86400   // Keep for 24 hours
          }
        }
      });
    }

    isInitialized = true;
    console.log('[JobQueue] Initialized with queues:', Object.keys(queues).join(', '));
    return true;
  } catch (err) {
    console.error('[JobQueue] Failed to initialize:', err.message);
    // Close any queues that were created before the failure to avoid orphaned connections
    for (const queue of Object.values(queues)) {
      try { queue.close(); } catch (_) {}
    }
    queues = {};
    return false;
  }
}

/**
 * Add a job to the maintenance queue
 */
async function addMaintenanceJob(jobName, data = {}, options = {}) {
  if (!isInitialized && !initialize()) {
    console.warn(`[JobQueue] Cannot add job ${jobName} - queue not initialized`);
    return null;
  }

  try {
    const job = await queues[QUEUE_NAMES.MAINTENANCE].add(jobName, data, options);
    return job;
  } catch (err) {
    console.error(`[JobQueue] Failed to add maintenance job ${jobName}:`, err.message);
    return null;
  }
}

/**
 * Add a job to the analytics queue
 */
async function addAnalyticsJob(jobName, data = {}, options = {}) {
  if (!isInitialized && !initialize()) {
    console.warn(`[JobQueue] Cannot add job ${jobName} - queue not initialized`);
    return null;
  }

  try {
    const job = await queues[QUEUE_NAMES.ANALYTICS].add(jobName, data, options);
    return job;
  } catch (err) {
    console.error(`[JobQueue] Failed to add analytics job ${jobName}:`, err.message);
    return null;
  }
}

/**
 * Add a job to the search queue
 */
async function addSearchJob(jobName, data = {}, options = {}) {
  if (!isInitialized && !initialize()) {
    console.warn(`[JobQueue] Cannot add job ${jobName} - queue not initialized`);
    return null;
  }

  try {
    const job = await queues[QUEUE_NAMES.SEARCH].add(jobName, data, options);
    return job;
  } catch (err) {
    console.error(`[JobQueue] Failed to add search job ${jobName}:`, err.message);
    return null;
  }
}

/**
 * Recurring jobs. The worker runs them; these schedules make them fire.
 * Each is a BullMQ job scheduler keyed by its id, so upserting one that already
 * exists keeps its next run time and only re-creates what is missing.
 */
const RECURRING_JOBS = [
  // Curated tokens: holder snapshots (every HOLDER_SNAPSHOT_REFRESH_HOURS) and stored diamond hands
  { id: 'warm-curated-conviction', queue: QUEUE_NAMES.ANALYTICS, repeat: { every: 60 * 60 * 1000 } },
  // Curated market cap and ATH from GeckoTerminal
  { id: 'refresh-curated-prices', queue: QUEUE_NAMES.ANALYTICS, repeat: { every: 10 * 60 * 1000 } },
  // Curated prices 1, 7 and 30 days ago, for the home table's 7d/30d change (a few tokens per run)
  { id: 'refresh-curated-price-refs', queue: QUEUE_NAMES.ANALYTICS, repeat: { every: 15 * 60 * 1000 } },
  // Daily holder counts, 00:05 UTC
  { id: 'record-holder-counts', queue: QUEUE_NAMES.ANALYTICS, repeat: { pattern: '5 0 * * *' } },
  // Daily Diamond Hands scores and the King of the Pill, 00:20 UTC
  { id: 'crown-king-of-pill', queue: QUEUE_NAMES.ANALYTICS, repeat: { pattern: '20 0 * * *' } },
  // Expired admin sessions, at :00 and :30
  { id: 'cleanup-sessions', queue: QUEUE_NAMES.MAINTENANCE, repeat: { pattern: '0,30 * * * *' } },
];

// Schedulers that used to exist and are removed if still found in Redis.
// warm-conviction only ever acted on curated tokens, which warm-curated-conviction covers.
const RETIRED_JOBS = [
  { id: 'warm-conviction', queue: QUEUE_NAMES.ANALYTICS },
];

/**
 * Make sure every recurring job is scheduled. Safe to call at any time and from
 * any process: the worker calls it at startup and then every few minutes, so the
 * schedules come back on their own if Redis restarts or evicts them (the free
 * Render Redis keeps no data across restarts). Returns how many are scheduled.
 */
async function ensureRecurringJobs() {
  if (!isInitialized && !initialize()) return 0;
  let scheduled = 0;
  for (const { id, queue: queueName } of RETIRED_JOBS) {
    try {
      const queue = queues[queueName];
      await queue.removeJobScheduler(id);
      for (const j of (await queue.getRepeatableJobs()).filter(j => j.name === id)) await queue.removeRepeatableByKey(j.key);
    } catch (_) { /* nothing to remove */ }
  }
  for (const { id, queue: queueName, repeat } of RECURRING_JOBS) {
    const queue = queues[queueName];
    try {
      // Drop schedules made by the older queue.add({ repeat }) API, which stored
      // them under a composite key instead of the scheduler id.
      const legacy = (await queue.getRepeatableJobs()).filter(j => j.name === id && j.key !== id);
      for (const j of legacy) await queue.removeRepeatableByKey(j.key);
      await queue.upsertJobScheduler(id, repeat, { name: id, data: {} });
      scheduled++;
    } catch (err) {
      console.error(`[JobQueue] Failed to schedule ${id}:`, err.message);
    }
  }
  return scheduled;
}

/**
 * Batch view count updates
 * Collects view increments and flushes them periodically
 * Buffer is capped to prevent unbounded memory growth
 */
const viewCountBuffer = new Map(); // tokenMint -> count
const VIEW_BUFFER_MAX_SIZE = parseInt(process.env.VIEW_BUFFER_MAX_SIZE) || 50000;
const VIEW_FLUSH_INTERVAL_MS = parseInt(process.env.VIEW_FLUSH_INTERVAL_MS) || 5000;
let viewFlushScheduled = false;
let viewFlushTimer = null;
// Once queued, the counts exist only in this job, and the worker throws while the
// DB is not ready (its recovery check runs every 30s). The default 3 attempts
// (1s, 2s) dropped them on any blip; this rides out ~20 minutes.
const VIEW_COUNT_JOB_OPTIONS = { attempts: 10, backoff: { type: 'exponential', delay: 5000 } };
let isFlushing = false; // Mutex to prevent concurrent flushes

// Import db lazily to avoid circular dependency
let db = null;
function getDb() {
  if (!db) {
    db = require('./database');
  }
  return db;
}

async function incrementViewCount(tokenMint) {
  // Check if buffer is at capacity - force immediate flush if so
  if (viewCountBuffer.size >= VIEW_BUFFER_MAX_SIZE && !viewCountBuffer.has(tokenMint)) {
    console.warn(`[JobQueue] View buffer at capacity (${VIEW_BUFFER_MAX_SIZE}), forcing flush`);
    await flushViewCounts();
  }

  // Buffer the view count locally
  const current = viewCountBuffer.get(tokenMint) || 0;
  viewCountBuffer.set(tokenMint, current + 1);

  // Schedule a flush if not already scheduled
  scheduleViewFlush();

  return current + 1;
}

/**
 * Arm the flush timer unless one is pending. The flag is cleared before the
 * flush runs, so views recorded during it arm a new timer; and anything still
 * buffered afterwards (e.g. entries put back after a failed DB write) re-arms
 * it too, instead of waiting for the next unrelated view.
 */
function scheduleViewFlush() {
  if (viewFlushScheduled) return;
  viewFlushScheduled = true;
  viewFlushTimer = setTimeout(async () => {
    viewFlushScheduled = false;
    viewFlushTimer = null;
    try {
      await flushViewCounts();
    } finally {
      if (viewCountBuffer.size > 0) scheduleViewFlush();
    }
  }, VIEW_FLUSH_INTERVAL_MS);
}

async function flushViewCounts() {
  if (viewCountBuffer.size === 0) return;
  if (isFlushing) {
    // A flush is already in progress — schedule a re-flush after it completes
    scheduleViewFlush();
    return;
  }
  isFlushing = true;

  try {
    // Atomic snapshot: swap buffer with a fresh Map so new writes don't collide
    const snapshot = new Map(viewCountBuffer);
    viewCountBuffer.clear();

    const viewUpdates = [];
    for (const [tokenMint, count] of snapshot) {
      viewUpdates.push({ tokenMint, count });
    }

    // Try job queue first if available
    if (isInitialized) {
      try {
        const job = await addAnalyticsJob('batch-view-counts', { updates: viewUpdates }, VIEW_COUNT_JOB_OPTIONS);
        if (job) {
          console.log(`[JobQueue] Queued ${viewUpdates.length} view count updates`);
          return;
        }
      } catch (err) {
        console.warn('[JobQueue] Failed to queue view counts, falling back to direct DB:', err.message);
      }
    }

    // Fallback: Write directly to database — re-add failed entries back to buffer
    const successfulMints = new Set(await flushViewCountsDirect(viewUpdates));
    for (const [tokenMint, count] of snapshot) {
      if (!successfulMints.has(tokenMint)) {
        // Re-add failed entries back to the live buffer
        const current = viewCountBuffer.get(tokenMint) || 0;
        viewCountBuffer.set(tokenMint, current + count);
      }
    }
  } finally {
    isFlushing = false;
  }
}

/**
 * Direct database write fallback for view counts
 * Used when Redis/job queue is unavailable
 */
async function flushViewCountsDirect(viewUpdates) {
  const database = getDb();
  if (!database.isReady()) {
    console.warn('[JobQueue] Database not ready, view counts will be retained in buffer');
    return [];
  }

  console.log(`[JobQueue] Writing ${viewUpdates.length} view counts directly to DB...`);

  const successfulMints = [];
  let errorCount = 0;

  // Process in smaller batches to avoid overwhelming DB
  const BATCH_SIZE = 25;
  for (let i = 0; i < viewUpdates.length; i += BATCH_SIZE) {
    const batch = viewUpdates.slice(i, i + BATCH_SIZE);

    try {
      const mints = batch.map(u => u.tokenMint);
      const counts = batch.map(u => u.count);

      await database.pool.query(`
        INSERT INTO token_views (token_mint, view_count, last_viewed_at)
        SELECT unnest($1::text[]), unnest($2::int[]), NOW()
        ON CONFLICT (token_mint) DO UPDATE SET
          view_count = token_views.view_count + EXCLUDED.view_count,
          last_viewed_at = NOW()
      `, [mints, counts]);

      successfulMints.push(...mints);
    } catch (err) {
      console.error('[JobQueue] Direct view count batch failed:', err.message);
      errorCount += batch.length;
    }
  }

  console.log(`[JobQueue] Direct DB write complete: ${successfulMints.length} success, ${errorCount} errors`);
  return successfulMints;
}

/**
 * Get queue statistics for health monitoring
 */
async function getQueueStats() {
  if (!isInitialized) {
    return { initialized: false };
  }

  const stats = {
    initialized: true,
    queues: {}
  };

  try {
    for (const [name, queue] of Object.entries(queues)) {
      const [waiting, active, completed, failed, delayed] = await Promise.all([
        queue.getWaitingCount(),
        queue.getActiveCount(),
        queue.getCompletedCount(),
        queue.getFailedCount(),
        queue.getDelayedCount()
      ]);

      stats.queues[name] = {
        waiting,
        active,
        completed,
        failed,
        delayed,
        total: waiting + active + delayed
      };
    }

    stats.viewBufferSize = viewCountBuffer.size;
    stats.healthy = true;
  } catch (err) {
    stats.healthy = false;
    stats.error = err.message;
  }

  return stats;
}

/**
 * Check if a worker is processing jobs
 */
async function isWorkerActive() {
  if (!isInitialized) return false;

  try {
    // Check if any queue has active workers
    for (const queue of Object.values(queues)) {
      const workers = await queue.getWorkers();
      if (workers.length > 0) return true;
    }
    return false;
  } catch (err) {
    return false;
  }
}

/**
 * Graceful shutdown - close all queue connections
 */
async function shutdown() {
  console.log('[JobQueue] Shutting down...');

  // Cancel pending flush timer
  if (viewFlushTimer) {
    clearTimeout(viewFlushTimer);
    viewFlushTimer = null;
  }

  // Flush any pending view counts directly to database
  // (Don't use job queue since we're shutting down)
  if (viewCountBuffer.size > 0) {
    console.log(`[JobQueue] Flushing ${viewCountBuffer.size} buffered view counts on shutdown...`);
    const viewUpdates = [];
    for (const [tokenMint, count] of viewCountBuffer) {
      viewUpdates.push({ tokenMint, count });
    }
    await flushViewCountsDirect(viewUpdates);
    viewCountBuffer.clear();
  }

  // Close queues
  for (const queue of Object.values(queues)) {
    await queue.close();
  }

  isInitialized = false;
  console.log('[JobQueue] Shutdown complete');
}

/**
 * Get buffered (unflushed) view counts for a list of token mints.
 * Used by the token list endpoint to include views not yet written to DB.
 */
function getBufferedViewCounts(tokenMints) {
  const result = {};
  for (const mint of tokenMints) {
    const count = viewCountBuffer.get(mint);
    if (count) result[mint] = count;
  }
  return result;
}

module.exports = {
  initialize,
  addMaintenanceJob,
  addAnalyticsJob,
  addSearchJob,
  ensureRecurringJobs,
  RECURRING_JOBS,
  incrementViewCount,
  getBufferedViewCounts,
  flushViewCounts,
  getQueueStats,
  isWorkerActive,
  shutdown,
  QUEUE_NAMES
};
