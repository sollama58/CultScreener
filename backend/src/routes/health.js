const express = require('express');
const router = express.Router();
const db = require('../services/database');
const solanaService = require('../services/solana');
const jupiterService = require('../services/jupiter');
const { cache } = require('../services/cache');
const { getAllStatuses: getCircuitBreakerStatuses } = require('../services/circuitBreaker');
const { getQueueMetrics } = require('../services/rateLimiter');
const jobQueue = require('../services/jobQueue');
const { asyncHandler } = require('../middleware/validation');

// GET /health - Basic health check
router.get('/', async (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'cultscreener-api'
  });
});

// GET /health/detailed - Detailed health check with dependencies (admin-only)
router.get('/detailed', require('../middleware/validation').validateAdminSession, asyncHandler(async (req, res) => {
  const health = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'cultscreener-api',
    version: process.env.npm_package_version || '1.0.0',
    uptime: process.uptime(),
    checks: {}
  };

  // Run independent health checks in parallel (was sequential — could take 10-30s under load)
  const [dbResult, rpcResult, cacheResult, jupiterResult] = await Promise.allSettled([
    db.checkHealth(),
    solanaService.checkHealth(),
    cache.checkHealth(),
    jupiterService.checkHealth()
  ]);

  // Database
  if (dbResult.status === 'fulfilled') {
    health.checks.database = {
      status: dbResult.value.healthy ? 'ok' : 'error',
      ...dbResult.value
    };
    if (!dbResult.value.healthy) health.status = 'degraded';
  } else {
    health.checks.database = { status: 'error', error: 'Database check failed' };
    health.status = 'degraded';
  }

  // Solana RPC
  if (rpcResult.status === 'fulfilled') {
    health.checks.solana_rpc = {
      status: rpcResult.value.healthy ? 'ok' : 'error',
      ...rpcResult.value
    };
    if (!rpcResult.value.healthy) health.status = 'degraded';
  } else {
    health.checks.solana_rpc = { status: 'error', error: 'Solana RPC check failed' };
    health.status = 'degraded';
  }

  // Cache (errors don't degrade — falls back to memory)
  if (cacheResult.status === 'fulfilled') {
    health.checks.cache = {
      status: cacheResult.value.healthy ? 'ok' : 'error',
      ...cacheResult.value
    };
  } else {
    health.checks.cache = { status: 'error', error: 'Cache check failed' };
  }

  // Jupiter API
  if (jupiterResult.status === 'fulfilled') {
    health.checks.jupiter_api = {
      status: jupiterResult.value.healthy ? 'ok' : 'error',
      configured: jupiterResult.value.configured,
      ...jupiterResult.value
    };
    if (!jupiterResult.value.healthy && jupiterResult.value.configured) {
      health.status = 'degraded';
    }
  } else {
    health.checks.jupiter_api = { status: 'error', error: 'Jupiter API check failed' };
  }

  // Circuit breaker status - shows which external APIs are being protected
  try {
    const circuitBreakers = getCircuitBreakerStatuses();
    health.checks.circuit_breakers = {
      status: 'ok'
    };

    // Check if any breakers are open (indicating external API issues)
    let hasOpenBreaker = false;
    for (const [name, status] of Object.entries(circuitBreakers)) {
      health.checks.circuit_breakers[name] = status;
      if (status.state === 'OPEN') {
        hasOpenBreaker = true;
      }
    }

    if (hasOpenBreaker) {
      health.checks.circuit_breakers.status = 'degraded';
      health.status = 'degraded';
    }
  } catch (error) {
    health.checks.circuit_breakers = {
      status: 'error',
      error: 'Circuit breaker check failed'
    };
  }

  // Queue metrics - shows request backpressure status
  try {
    const queueMetrics = getQueueMetrics();
    health.checks.request_queues = {
      status: queueMetrics.underPressure ? 'degraded' : 'ok',
      totalQueued: queueMetrics.totalQueued,
      totalRejections: queueMetrics.totalRejections,
      underPressure: queueMetrics.underPressure,
      queues: queueMetrics.queues
    };

    if (queueMetrics.underPressure) {
      health.status = 'degraded';
    }
  } catch (error) {
    health.checks.request_queues = {
      status: 'error',
      error: 'Queue metrics check failed'
    };
  }

  // Memory usage
  const memUsage = process.memoryUsage();
  health.checks.memory = {
    status: 'ok',
    heapUsedMB: Math.round(memUsage.heapUsed / 1024 / 1024),
    heapTotalMB: Math.round(memUsage.heapTotal / 1024 / 1024),
    rssMB: Math.round(memUsage.rss / 1024 / 1024),
    externalMB: Math.round(memUsage.external / 1024 / 1024)
  };

  // Warn if heap usage is high (>85% of total)
  if (memUsage.heapUsed / memUsage.heapTotal > 0.85) {
    health.checks.memory.status = 'warning';
    health.checks.memory.warning = 'High heap usage';
  }

  // Job queue / worker status
  try {
    const jobQueueStats = await jobQueue.getQueueStats();
    const workerActive = await jobQueue.isWorkerActive();

    health.checks.job_queue = {
      status: jobQueueStats.initialized ? (jobQueueStats.healthy ? 'ok' : 'degraded') : 'disabled',
      initialized: jobQueueStats.initialized,
      workerActive,
      ...jobQueueStats.queues && { queues: jobQueueStats.queues },
      viewBufferSize: jobQueueStats.viewBufferSize || 0
    };

    // Warn if worker is not processing jobs (queues building up)
    if (jobQueueStats.initialized && !workerActive) {
      health.checks.job_queue.warning = 'No active worker processing jobs';
    }
  } catch (error) {
    health.checks.job_queue = {
      status: 'error',
      error: 'Job queue check failed'
    };
  }

  // Environment checks — do not expose which third-party API keys are configured
  health.checks.environment = {
    node_env: process.env.NODE_ENV || 'development',
    has_database_url: !!process.env.DATABASE_URL,
    has_redis_url: !!process.env.REDIS_URL
  };

  // Set status code based on health
  const statusCode = health.status === 'ok' ? 200 : 503;
  res.status(statusCode).json(health);
}));

// GET /health/ready - Readiness probe (for k8s/render)
// Returns ready if core services work, even if database is still connecting
router.get('/ready', asyncHandler(async (req, res) => {
  try {
    // Check if database is configured but not ready yet (still connecting)
    if (process.env.DATABASE_URL && !db.isReady()) {
      // Return 503 only if database is required and not ready
      // This gives Render time to wait for the database
      const dbHealth = await db.checkHealth();
      if (!dbHealth.healthy) {
        return res.status(503).json({
          ready: false,
          reason: 'Database connecting...',
          dbStatus: dbHealth
        });
      }
    }

    // If we get here, either:
    // 1. No database configured (database features disabled)
    // 2. Database is healthy
    res.json({ ready: true, databaseConfigured: !!process.env.DATABASE_URL });
  } catch (error) {
    res.status(503).json({ ready: false, reason: error.message });
  }
}));

// GET /health/live - Liveness probe (for k8s/render)
router.get('/live', (req, res) => {
  res.json({ alive: true });
});

// GET /api/stats - Public API statistics (stripped of internal pool details)
router.get('/stats', asyncHandler(async (req, res) => {
  try {
    const dbHealth = await db.checkHealth();
    const cacheStats = await cache.getStats();

    res.json({
      timestamp: new Date().toISOString(),
      cache: {
        type: cacheStats.type,
        connected: cacheStats.connected
      },
      database: {
        connected: dbHealth.healthy
      },
      features: {
        communitySubmissions: true,
        watchlist: true,
        sentimentVoting: true
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
}));

module.exports = router;
