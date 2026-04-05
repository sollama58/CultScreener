/**
 * Job Queue Service using BullMQ
 * Handles background job processing to keep the main server responsive
 *
 * Jobs are processed by a separate worker process (src/worker.js)
 */

const { Queue, QueueEvents } = require('bullmq');

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
let queueEvents = {};
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

      // Optional: Queue events for monitoring
      queueEvents[name] = new QueueEvents(name, { connection: redisConfig });
    }

    isInitialized = true;
    console.log('[JobQueue] Initialized with queues:', Object.keys(queues).join(', '));
    return true;
  } catch (err) {
    console.error('[JobQueue] Failed to initialize:', err.message);
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
 * Schedule recurring session cleanup job
 * Runs every 30 minutes to clean up expired admin sessions
 */
async function scheduleSessionCleanup() {
  if (!isInitialized && !initialize()) return null;

  try {
    // Remove any existing scheduled job first
    const existingJobs = await queues[QUEUE_NAMES.MAINTENANCE].getRepeatableJobs();
    for (const job of existingJobs) {
      if (job.name === 'cleanup-sessions') {
        await queues[QUEUE_NAMES.MAINTENANCE].removeRepeatableByKey(job.key);
      }
    }

    // Schedule new recurring job (every 30 minutes for better storage hygiene)
    const job = await queues[QUEUE_NAMES.MAINTENANCE].add(
      'cleanup-sessions',
      {},
      {
        repeat: {
          pattern: '0,30 * * * *' // Every 30 minutes (at :00 and :30)
        },
        jobId: 'session-cleanup-recurring'
      }
    );

    console.log('[JobQueue] Scheduled recurring session cleanup job (every 30 min)');
    return job;
  } catch (err) {
    console.error('[JobQueue] Failed to schedule session cleanup:', err.message);
    return null;
  }
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
  if (!viewFlushScheduled) {
    viewFlushScheduled = true;

    // Flush after interval
    viewFlushTimer = setTimeout(async () => {
      await flushViewCounts();
      viewFlushScheduled = false;
      viewFlushTimer = null;
    }, VIEW_FLUSH_INTERVAL_MS);
  }

  return current + 1;
}

async function flushViewCounts() {
  if (viewCountBuffer.size === 0) return;
  if (isFlushing) {
    // A flush is already in progress — schedule a re-flush after it completes
    if (!viewFlushScheduled) {
      viewFlushScheduled = true;
      viewFlushTimer = setTimeout(async () => {
        await flushViewCounts();
        viewFlushScheduled = false;
        viewFlushTimer = null;
      }, VIEW_FLUSH_INTERVAL_MS);
    }
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
        const job = await addAnalyticsJob('batch-view-counts', { updates: viewUpdates });
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

  // Close queue events
  for (const events of Object.values(queueEvents)) {
    await events.close();
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
  scheduleSessionCleanup,
  incrementViewCount,
  getBufferedViewCounts,
  flushViewCounts,
  getQueueStats,
  isWorkerActive,
  shutdown,
  QUEUE_NAMES
};
