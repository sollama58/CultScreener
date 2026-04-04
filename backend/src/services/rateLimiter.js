/**
 * API Rate Limiter with Jitter
 * Prevents overloading external APIs by staggering requests
 */

// Track last request time per API
const lastRequestTime = new Map();

// Request queues per API
const requestQueues = new Map();

// Processing flags per API
const isProcessing = new Map();

// Queue size limits to prevent unbounded growth under high load
// Queue size limit to prevent unbounded growth under high load
const MAX_QUEUE_SIZE = parseInt(process.env.API_QUEUE_MAX_SIZE) || 500;
const QUEUE_TIMEOUT_MS = parseInt(process.env.API_QUEUE_TIMEOUT_MS) || 15000;

// Track queue metrics for monitoring and backpressure
const queueMetrics = {
  rejections: new Map(), // API name -> rejection count
  lastRejectionTime: new Map(), // API name -> timestamp
  totalRejections: 0,

  recordRejection(apiName) {
    const count = (this.rejections.get(apiName) || 0) + 1;
    this.rejections.set(apiName, count);
    this.lastRejectionTime.set(apiName, Date.now());
    this.totalRejections++;
  },

  getMetrics(apiName) {
    return {
      rejections: this.rejections.get(apiName) || 0,
      lastRejection: this.lastRejectionTime.get(apiName) || null,
      totalRejections: this.totalRejections
    };
  },

  // Check if API is under backpressure (rejecting requests)
  isUnderPressure(apiName) {
    const lastRejection = this.lastRejectionTime.get(apiName);
    if (!lastRejection) return false;
    // Under pressure if rejected in last 30 seconds
    return (Date.now() - lastRejection) < 30000;
  }
};

// Rate limit configurations per API (requests per second)
const RATE_LIMITS = {
  birdeye: {
    minInterval: 200,    // Minimum 200ms between requests (5 req/sec max)
    maxJitter: 100,      // Add up to 100ms random jitter
    burstLimit: 3,       // Allow up to 3 requests in quick succession
    burstWindow: 1000,   // Within 1 second
    useQueue: true,      // Queue-based processing for ordered rate limiting
    maxQueueSize: 500,   // Queue capacity
    queueTimeout: 15000  // 15s timeout
  },
  geckoTerminal: {
    // CoinGecko paid plan: 250 requests/minute ≈ 1 request every 240ms
    // Use 250ms minimum with modest safety margin
    minInterval: 250,    // Minimum 250ms between requests (~240/min max)
    maxJitter: 50,       // Add up to 50ms random jitter
    burstLimit: 10,      // Allow bursts for parallel enrichment
    burstWindow: 3000,   // 3 second window
    useQueue: true,      // Force queue-based processing
    maxQueueSize: 500,   // Queue for concurrency
    queueTimeout: 15000  // 15s timeout — requests should flow fast now
  },
  raydium: {
    minInterval: 334,    // ~3 requests/sec
    maxJitter: 100,
    burstLimit: 3,
    burstWindow: 1000,
    useQueue: true,
    maxQueueSize: 500,
    queueTimeout: 30000
  },
  jupiter: {
    minInterval: 100,    // Minimum 100ms between requests (10 req/sec max)
    maxJitter: 50,       // Add up to 50ms random jitter
    burstLimit: 5,       // Allow up to 5 requests in quick succession
    burstWindow: 1000
  },
  helius: {
    minInterval: 110,    // ~9 req/sec — conservative for Helius shared key
    maxJitter: 30,
    burstLimit: 8,
    burstWindow: 1000,
    useQueue: true,      // Queue-based to prevent burst overload from parallel DAS calls
    maxQueueSize: 500,
    queueTimeout: 20000
  },
  solana: {
    // NOTE: When using Helius as RPC, callers should use 'helius' key instead
    // to share the rate limiter. This config is only for public Solana RPC fallback.
    minInterval: 100,    // 10 req/sec — public Solana RPC is heavily rate-limited
    maxJitter: 50,
    burstLimit: 5,
    burstWindow: 1000,
    useQueue: true,
    maxQueueSize: 200,
    queueTimeout: 15000
  },
  default: {
    minInterval: 100,
    maxJitter: 50,
    burstLimit: 5,
    burstWindow: 1000
  }
};

// Burst tracking with periodic cleanup
const burstCounters = new Map();
const BURST_CLEANUP_INTERVAL_MS = 60000; // Clean up old burst counters every minute
const BURST_MAX_AGE_MS = 10000; // Remove burst counters older than 10 seconds

// Periodic cleanup to prevent burst counter accumulation
const _burstCleanupTimer = setInterval(() => {
  const now = Date.now();
  let removed = 0;
  for (const [key] of burstCounters) {
    // Extract API name and window number from key format "apiName:windowNumber"
    const colonIdx = key.indexOf(':');
    const apiName = colonIdx > 0 ? key.slice(0, colonIdx) : 'default';
    const windowStr = colonIdx > 0 ? key.slice(colonIdx + 1) : key;
    const windowTime = parseInt(windowStr) || 0;
    // Use the actual burst window for the specific API instead of hardcoding
    const apiConfig = RATE_LIMITS[apiName] || RATE_LIMITS.default;
    if (!apiConfig.burstWindow || apiConfig.burstWindow <= 0) { burstCounters.delete(key); removed++; continue; }
    const estimatedKeyTime = windowTime * apiConfig.burstWindow;
    if (now - estimatedKeyTime > BURST_MAX_AGE_MS) {
      burstCounters.delete(key);
      removed++;
    }
  }
  if (removed > 0 && burstCounters.size > 100) {
    console.log(`[RateLimiter] Cleanup: removed ${removed} old burst counters, ${burstCounters.size} remaining`);
  }
}, BURST_CLEANUP_INTERVAL_MS);

/**
 * Add random jitter to prevent thundering herd
 * @param {number} maxJitter - Maximum jitter in milliseconds
 * @returns {number} Random jitter value
 */
function getJitter(maxJitter) {
  return Math.floor(Math.random() * maxJitter);
}

/**
 * Get delay needed before next request
 * @param {string} apiName - Name of the API (birdeye, jupiter, helius)
 * @returns {number} Delay in milliseconds
 */
function getRequiredDelay(apiName) {
  const config = RATE_LIMITS[apiName] || RATE_LIMITS.default;
  const now = Date.now();
  const lastTime = lastRequestTime.get(apiName) || 0;
  const elapsed = now - lastTime;

  // Check burst limit
  const burstKey = `${apiName}:${Math.floor(now / config.burstWindow)}`;
  const burstCount = burstCounters.get(burstKey) || 0;

  if (burstCount >= config.burstLimit) {
    // Exceeded burst limit, need to wait for next window
    const windowEnd = (Math.floor(now / config.burstWindow) + 1) * config.burstWindow;
    return windowEnd - now + getJitter(config.maxJitter);
  }

  if (elapsed < config.minInterval) {
    return config.minInterval - elapsed + getJitter(config.maxJitter);
  }

  return getJitter(config.maxJitter);
}

/**
 * Record a request for rate limiting
 * @param {string} apiName - Name of the API
 */
function recordRequest(apiName) {
  const config = RATE_LIMITS[apiName] || RATE_LIMITS.default;
  const now = Date.now();
  lastRequestTime.set(apiName, now);

  // Update burst counter
  const burstKey = `${apiName}:${Math.floor(now / config.burstWindow)}`;
  const currentCount = burstCounters.get(burstKey) || 0;
  burstCounters.set(burstKey, currentCount + 1);

  // Clean up old burst counters (keep last 2 windows for safety margin)
  const currentWindow = Math.floor(now / config.burstWindow);
  for (const [key] of burstCounters) {
    const [keyApi, windowStr] = key.split(':');
    // Only clean up counters for the same API to avoid config mismatch
    if (keyApi === apiName) {
      const window = parseInt(windowStr);
      if (window < currentWindow - 2) {
        burstCounters.delete(key);
      }
    }
  }
}

/**
 * Sleep for specified milliseconds
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Execute a rate-limited API request
 * Uses queue-based processing for APIs with useQueue=true (like GeckoTerminal)
 * @param {string} apiName - Name of the API
 * @param {Function} requestFn - Async function that makes the request
 * @returns {Promise<any>} Result of the request
 */
async function rateLimitedRequest(apiName, requestFn) {
  const config = RATE_LIMITS[apiName] || RATE_LIMITS.default;

  // Use queue-based processing for strict rate limiting (GeckoTerminal)
  if (config.useQueue) {
    return queueRequest(apiName, requestFn);
  }

  const delay = getRequiredDelay(apiName);

  if (delay > 0) {
    await sleep(delay);
  }

  recordRequest(apiName);
  return requestFn();
}

/**
 * Queue a request to be executed with rate limiting
 * Requests are processed in order with proper delays
 * Includes queue size limits and adaptive request timeouts
 * @param {string} apiName - Name of the API
 * @param {Function} requestFn - Async function that makes the request
 * @returns {Promise<any>} Result of the request
 */
async function queueRequest(apiName, requestFn) {
  const config = RATE_LIMITS[apiName] || RATE_LIMITS.default;
  const maxQueueSize = config.maxQueueSize || MAX_QUEUE_SIZE;
  const baseTimeout = config.queueTimeout || QUEUE_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    // Get or create queue for this API
    if (!requestQueues.has(apiName)) {
      requestQueues.set(apiName, []);
    }

    const queue = requestQueues.get(apiName);

    // Reject if queue is full to prevent unbounded growth
    if (queue.length >= maxQueueSize) {
      queueMetrics.recordRejection(apiName);
      // Estimate retry time based on drain rate
      const estimatedDrainMs = queue.length * (config.minInterval + (config.maxJitter / 2));
      const retryAfterSecs = Math.min(Math.ceil(estimatedDrainMs / 1000), 60);
      console.warn(`[RateLimiter] ${apiName} queue full (${queue.length}/${maxQueueSize}), rejecting request (total rejections: ${queueMetrics.totalRejections})`);
      const error = new Error(`API queue full - server overloaded. Try again later.`);
      error.retryAfter = retryAfterSecs;
      error.isOverloaded = true;
      reject(error);
      return;
    }

    // Adaptive timeout: scale based on queue position
    // Position 0 gets base timeout; position N gets base + N * minInterval
    const positionDelay = queue.length * config.minInterval;
    const queueTimeout = baseTimeout + positionDelay;

    // Set up timeout for this request
    const item = { requestFn, resolve, reject, timeoutId: null, timedOut: false, queuedAt: Date.now() };
    const timeoutId = setTimeout(() => {
      // Mark as timed out so processQueue skips it
      item.timedOut = true;
      console.warn(`[RateLimiter] ${apiName} request timed out after ${queueTimeout}ms in queue (position was ~${queue.length})`);
      const err = new Error(`Request timed out waiting in queue`);
      err.isOverloaded = true;
      reject(err);
      // Note: timed-out items are skipped by processQueue when dequeued, no need to splice
    }, queueTimeout);
    item.timeoutId = timeoutId;

    queue.push(item);

    // Log queue stats periodically
    if (queue.length % 50 === 0) {
      console.log(`[RateLimiter] ${apiName} queue size: ${queue.length}`);
    }

    // Start processing if not already
    processQueue(apiName);
  });
}

/**
 * Process the request queue for an API
 * Uses a drain-safe loop: re-checks for new items after setting isProcessing=false
 * to prevent items from getting stranded by a race between push and loop exit
 * @param {string} apiName - Name of the API
 */
async function processQueue(apiName) {
  // Atomic check-and-set: if already processing, the active loop will pick up new items
  if (isProcessing.get(apiName)) return;
  isProcessing.set(apiName, true);

  const queue = requestQueues.get(apiName);

  try {
    while (queue && queue.length > 0) {
      const item = queue.shift();

      // Skip if the request was already rejected by the timeout handler
      if (item.timedOut) {
        if (item.timeoutId) clearTimeout(item.timeoutId);
        continue;
      }

      try {
        // Clear the timeout since we're processing this request now
        if (item.timeoutId) {
          clearTimeout(item.timeoutId);
        }

        // Log queue wait time for monitoring
        if (item.queuedAt) {
          const waitTime = Date.now() - item.queuedAt;
          if (waitTime > 5000) {
            console.log(`[RateLimiter] ${apiName} request waited ${Math.round(waitTime / 1000)}s in queue`);
          }
        }

        // Apply rate limiting delay directly (not through rateLimitedRequest to avoid recursion)
        const delay = getRequiredDelay(apiName);
        if (delay > 0) {
          await sleep(delay);
        }
        recordRequest(apiName);

        // Execute the actual request
        const result = await item.requestFn();
        item.resolve(result);
      } catch (error) {
        item.reject(error);
      }
    }
  } finally {
    isProcessing.set(apiName, false);
  }

  // Drain safety net: items may have been pushed between the while-loop exit
  // and isProcessing=false. Re-check and restart if needed.
  if (queue && queue.length > 0) {
    processQueue(apiName);
  }
}

/**
 * Batch multiple requests with staggered timing
 * @param {string} apiName - Name of the API
 * @param {Array<Function>} requestFns - Array of async request functions
 * @returns {Promise<Array>} Results of all requests
 */
async function batchRequests(apiName, requestFns) {
  const config = RATE_LIMITS[apiName] || RATE_LIMITS.default;
  const results = [];

  for (let i = 0; i < requestFns.length; i++) {
    // Add staggered delay between batch requests
    if (i > 0) {
      await sleep(config.minInterval + getJitter(config.maxJitter));
    }

    try {
      recordRequest(apiName);
      const result = await requestFns[i]();
      results.push({ success: true, data: result });
    } catch (error) {
      results.push({ success: false, error: error.message });
    }
  }

  return results;
}

/**
 * Get current rate limit status for monitoring
 * @param {string} apiName - Name of the API
 * @returns {Object} Rate limit status
 */
function getStatus(apiName) {
  const config = RATE_LIMITS[apiName] || RATE_LIMITS.default;
  const now = Date.now();
  const burstKey = `${apiName}:${Math.floor(now / config.burstWindow)}`;

  return {
    api: apiName,
    lastRequest: lastRequestTime.get(apiName) || null,
    timeSinceLastRequest: lastRequestTime.has(apiName)
      ? now - lastRequestTime.get(apiName)
      : null,
    currentBurstCount: burstCounters.get(burstKey) || 0,
    burstLimit: config.burstLimit,
    queueLength: (requestQueues.get(apiName) || []).length,
    config
  };
}

/**
 * Get all queue statuses for monitoring
 * @returns {Object} Status of all API queues
 */
function getAllQueueStatuses() {
  const statuses = {};
  for (const apiName of Object.keys(RATE_LIMITS)) {
    statuses[apiName] = {
      ...getStatus(apiName),
      ...queueMetrics.getMetrics(apiName),
      underPressure: queueMetrics.isUnderPressure(apiName)
    };
  }
  return statuses;
}

/**
 * Get queue metrics for health monitoring
 * @returns {Object} Queue metrics summary
 */
function getQueueMetrics() {
  const queues = {};
  let totalQueued = 0;
  let underPressure = false;

  for (const apiName of Object.keys(RATE_LIMITS)) {
    const queueLength = (requestQueues.get(apiName) || []).length;
    const isUnderPressure = queueMetrics.isUnderPressure(apiName);

    queues[apiName] = {
      queueLength,
      rejections: queueMetrics.rejections.get(apiName) || 0,
      underPressure: isUnderPressure
    };

    totalQueued += queueLength;
    if (isUnderPressure) underPressure = true;
  }

  return {
    queues,
    totalQueued,
    totalRejections: queueMetrics.totalRejections,
    underPressure
  };
}

function stopCleanup() { clearInterval(_burstCleanupTimer); }

module.exports = {
  rateLimitedRequest,
  queueRequest,
  batchRequests,
  getRequiredDelay,
  getStatus,
  getAllQueueStatuses,
  getQueueMetrics,
  queueMetrics,
  sleep,
  RATE_LIMITS,
  stopCleanup
};
