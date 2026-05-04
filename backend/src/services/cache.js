/**
 * Cache service with Redis support and in-memory fallback
 * Uses Redis when REDIS_URL is configured, otherwise falls back to in-memory cache
 */

const Redis = require('ioredis');

// Cache TTL presets (in milliseconds for in-memory, converted to seconds for Redis)
// Note: GeckoTerminal free tier allows 30 requests/minute - TTLs optimized to reduce API load
const TTL = {
  VERY_SHORT: 10000,    // 10 seconds - for real-time data
  SHORT: 30000,         // 30 seconds
  MEDIUM: 60000,        // 1 minute
  OHLCV: 300000,        // 5 minutes - chart/OHLCV data; candles form over minutes/hours
  POOLS: 180000,        // 3 minutes - for pool data (rarely changes)
  PRICE_DATA: 600000,   // 10 minutes - for price/volume data (rolling cache)
  PRICE_FRESH: 60000,   // 1 minute - freshness threshold for individual token views
  LONG: 300000,         // 5 minutes
  VERY_LONG: 900000,    // 15 minutes
  METADATA: 3600000,    // 1 hour - for stable token metadata (name, symbol, logo)
  HOUR: 3600000,        // 1 hour
  DAY: 86400000,        // 24 hours
  ERROR: 60000          // 1 minute - cache failed lookups to prevent repeated API calls
};

// Cache key generators
const keys = {
  tokenPrice: (mint) => `price:${mint}`,
  tokenInfo: (mint) => `token:${mint}`,
  tokenChart: (mint, interval) => `chart:${mint}:${interval}`,
  tokenList: (sort, page) => `list:${sort}:${page}`,
  tokenSearch: (query) => `search:${query}`,
  submissions: (mint) => `submissions:${mint}`,
  pools: (mint) => `pools:${mint}`,
  holderCount: (mint) => `holders:${mint}`
};

/**
 * In-memory cache implementation with LRU eviction (fallback)
 * Bounded to prevent unbounded memory growth
 */
class MemoryCache {
  constructor(maxSize = 10000) {
    this.cache = new Map();
    this.maxSize = maxSize;
    this.stats = { hits: 0, misses: 0, sets: 0, evictions: 0 };

    // Clean up expired entries every minute
    this.cleanupInterval = setInterval(() => this.cleanup(), 60000);
  }

  async get(key) {
    const entry = this.cache.get(key);

    if (!entry) {
      this.stats.misses++;
      return undefined;
    }

    if (Date.now() > entry.expiry) {
      this.cache.delete(key);
      this.stats.misses++;
      return undefined;
    }

    // LRU: Move accessed key to end of Map (most recently used)
    this.cache.delete(key);
    this.cache.set(key, entry);

    this.stats.hits++;
    return entry.value;
  }

  async set(key, value, ttlMs = 60000) {
    // If key exists, delete it first (to update position in LRU order)
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }

    // Evict oldest entries if at capacity
    while (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
      this.stats.evictions++;
    }

    this.cache.set(key, {
      value,
      expiry: Date.now() + ttlMs,
      createdAt: Date.now()
    });
    this.stats.sets++;
  }

  /**
   * Set-if-not-exists. Returns true if the key was set (did not exist), false otherwise.
   */
  async setNX(key, value, ttlMs = 60000) {
    const entry = this.cache.get(key);
    if (entry && Date.now() <= entry.expiry) return false; // Already exists
    await this.set(key, value, ttlMs);
    return true;
  }

  async delete(key) {
    this.cache.delete(key);
  }

  async has(key) {
    const entry = this.cache.get(key);
    if (!entry) return false;
    if (Date.now() > entry.expiry) {
      this.cache.delete(key);
      return false;
    }
    return true;
  }

  async clear() {
    this.cache.clear();
  }

  async clearPattern(pattern) {
    // Escape regex special chars, then convert glob * to .*
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    const regex = new RegExp('^' + escaped + '$');
    const toDelete = [];
    for (const key of this.cache.keys()) {
      if (regex.test(key)) {
        toDelete.push(key);
      }
    }
    for (const key of toDelete) {
      this.cache.delete(key);
    }
  }

  cleanup() {
    const now = Date.now();
    const toDelete = [];

    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiry) {
        toDelete.push(key);
      }
    }
    for (const key of toDelete) {
      this.cache.delete(key);
    }
    const removed = toDelete.length;

    if (removed > 0) {
      console.log(`[MemoryCache] Cleanup: removed ${removed} expired entries`);
    }
  }

  getStats() {
    const total = this.stats.hits + this.stats.misses;
    return {
      type: 'memory',
      size: this.cache.size,
      maxSize: this.maxSize,
      hits: this.stats.hits,
      misses: this.stats.misses,
      sets: this.stats.sets,
      evictions: this.stats.evictions,
      hitRate: total > 0 ? (this.stats.hits / total * 100).toFixed(2) + '%' : '0%'
    };
  }

  async checkHealth() {
    return { healthy: true, type: 'memory', size: this.cache.size };
  }

  destroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }
}

/**
 * Redis cache implementation
 */
class RedisCache {
  constructor(redisUrl) {
    this.stats = { hits: 0, misses: 0, sets: 0 };
    this.isConnected = false;
    this.keyPrefix = 'cultscreener:';
    this._reconnectAttempts = 0;
    this._maxReconnectAttempts = 20;

    // Parse Redis URL and configure
    this.client = new Redis(redisUrl, {
      // Fail fast per-command — cache is non-critical, no point retrying a down server
      maxRetriesPerRequest: 1,
      reconnectOnError: (err) => {
        const targetErrors = ['READONLY', 'ECONNRESET', 'ETIMEDOUT'];
        return targetErrors.some(e => err.message.includes(e));
      },
      // Cap reconnection attempts to prevent infinite log spam
      retryStrategy: (times) => {
        this._reconnectAttempts = times;
        if (times > this._maxReconnectAttempts) {
          console.error(`[Redis] Giving up after ${times} reconnection attempts`);
          return null; // Stop retrying
        }
        // Exponential backoff capped at 30s
        return Math.min(times * 500, 30000);
      },
      lazyConnect: false
    });

    this.client.on('connect', () => {
      console.log('[Redis] Connected to Redis server');
      this._reconnectAttempts = 0;
      this.isConnected = true;
    });

    this.client.on('ready', () => {
      console.log('[Redis] Ready to accept commands');
    });

    this.client.on('error', (err) => {
      // Only log the first error and then every 10th to avoid flooding
      if (this._reconnectAttempts <= 1 || this._reconnectAttempts % 10 === 0) {
        console.error('[Redis] Error:', err.message);
      }
      this.isConnected = false;
    });

    this.client.on('close', () => {
      this.isConnected = false;
    });
  }

  _prefixKey(key) {
    return this.keyPrefix + key;
  }

  async get(key) {
    if (!this.isConnected) {
      this.stats.misses++;
      return undefined;
    }
    try {
      const data = await this.client.get(this._prefixKey(key));

      if (data === null) {
        this.stats.misses++;
        return undefined;
      }

      this.stats.hits++;
      return JSON.parse(data);
    } catch (err) {
      console.error('[Redis] Get error:', err.message);
      this.stats.misses++;
      return undefined;
    }
  }

  async set(key, value, ttlMs = 60000) {
    if (!this.isConnected) return;
    try {
      const ttlSeconds = Math.ceil(ttlMs / 1000);
      await this.client.setex(
        this._prefixKey(key),
        ttlSeconds,
        JSON.stringify(value)
      );
      this.stats.sets++;
    } catch (err) {
      console.error('[Redis] Set error:', err.message);
    }
  }

  /**
   * Set-if-not-exists (atomic). Returns true if the key was set, false if it already existed.
   */
  async setNX(key, value, ttlMs = 60000) {
    if (!this.isConnected) return false;
    try {
      const ttlSeconds = Math.ceil(ttlMs / 1000);
      // SET key value EX ttl NX — atomic set-if-not-exists with expiry
      const result = await this.client.set(
        this._prefixKey(key),
        JSON.stringify(value),
        'EX', ttlSeconds,
        'NX'
      );
      return result === 'OK';
    } catch (err) {
      console.error('[Redis] SetNX error:', err.message);
      return false;
    }
  }

  async delete(key) {
    if (!this.isConnected) return;
    try {
      await this.client.del(this._prefixKey(key));
    } catch (err) {
      console.error('[Redis] Delete error:', err.message);
    }
  }

  async has(key) {
    if (!this.isConnected) return false;
    try {
      const exists = await this.client.exists(this._prefixKey(key));
      return exists === 1;
    } catch (err) {
      console.error('[Redis] Has error:', err.message);
      return false;
    }
  }

  // Cursor-based SCAN to avoid blocking Redis with KEYS
  async _scanKeys(pattern) {
    const keys = [];
    let cursor = '0';
    do {
      const [nextCursor, batch] = await this.client.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = nextCursor;
      keys.push(...batch);
    } while (cursor !== '0');
    return keys;
  }

  async clear() {
    if (!this.isConnected) return;
    try {
      const keys = await this._scanKeys(this._prefixKey('*'));
      if (keys.length > 0) {
        // Delete in batches to avoid overwhelming Redis
        for (let i = 0; i < keys.length; i += 1000) {
          await this.client.del(...keys.slice(i, i + 1000));
        }
      }
      console.log(`[Redis] Cleared ${keys.length} keys`);
    } catch (err) {
      console.error('[Redis] Clear error:', err.message);
    }
  }

  async clearPattern(pattern) {
    if (!this.isConnected) return;
    try {
      const keys = await this._scanKeys(this._prefixKey(pattern));
      if (keys.length > 0) {
        for (let i = 0; i < keys.length; i += 1000) {
          await this.client.del(...keys.slice(i, i + 1000));
        }
        console.log(`[Redis] Cleared ${keys.length} keys matching pattern: ${pattern}`);
      }
    } catch (err) {
      console.error('[Redis] ClearPattern error:', err.message);
    }
  }

  async getStats() {
    const total = this.stats.hits + this.stats.misses;
    let size = 0;

    try {
      // Count only keys with our cache prefix to exclude non-cache keys (e.g. BullMQ)
      const cacheKeys = await this._scanKeys(this._prefixKey('*'));
      size = cacheKeys.length;
    } catch (err) {
      console.error('[Redis] Stats error:', err.message);
    }

    return {
      type: 'redis',
      connected: this.isConnected,
      size,
      hits: this.stats.hits,
      misses: this.stats.misses,
      sets: this.stats.sets,
      hitRate: total > 0 ? (this.stats.hits / total * 100).toFixed(2) + '%' : '0%'
    };
  }

  async checkHealth() {
    try {
      const start = Date.now();
      await this.client.ping();
      const latency = Date.now() - start;

      const info = await this.client.info('memory');
      const usedMemory = info.match(/used_memory_human:(\S+)/)?.[1] || 'unknown';

      return {
        healthy: true,
        type: 'redis',
        connected: this.isConnected,
        latencyMs: latency,
        usedMemory
      };
    } catch (err) {
      return {
        healthy: false,
        type: 'redis',
        connected: false,
        error: err.message
      };
    }
  }

  async destroy() {
    try {
      await this.client.quit();
      console.log('[Redis] Disconnected');
    } catch (err) {
      console.error('[Redis] Disconnect error:', err.message);
    }
  }
}

/**
 * Cache service wrapper with automatic backend selection
 * Includes stampede prevention for high-concurrency scenarios
 */
class CacheService {
  constructor() {
    this.backend = null;
    this.backendType = 'none';
    // In-flight fetch promises for stampede prevention
    this.inFlightFetches = new Map();
    this.initialize();
  }

  initialize() {
    const redisUrl = process.env.REDIS_URL;

    if (redisUrl) {
      console.log('[Cache] Initializing Redis cache...');
      try {
        this.backend = new RedisCache(redisUrl);
        this.backendType = 'redis';
      } catch (err) {
        console.error('[Cache] Failed to initialize Redis, falling back to memory:', err.message);
        this.backend = new MemoryCache();
        this.backendType = 'memory';
      }
    } else {
      console.log('[Cache] No REDIS_URL configured, using in-memory cache');
      this.backend = new MemoryCache();
      this.backendType = 'memory';
    }
  }

  // Proxy all methods to the backend
  get(key) {
    return this.backend.get(key);
  }

  set(key, value, ttlMs = 60000) {
    return this.backend.set(key, value, ttlMs);
  }

  setNX(key, value, ttlMs = 60000) {
    return this.backend.setNX(key, value, ttlMs);
  }

  delete(key) {
    return this.backend.delete(key);
  }

  has(key) {
    return this.backend.has(key);
  }

  clear() {
    return this.backend.clear();
  }

  clearPattern(pattern) {
    return this.backend.clearPattern(pattern);
  }

  /**
   * List cache keys matching a glob pattern.
   * Returns unprefixed keys (what callers use with get/set/delete).
   */
  async scanKeys(pattern) {
    if (this.backendType === 'redis') {
      const prefixed = await this.backend._scanKeys(this.backend._prefixKey(pattern));
      // Strip prefix from returned keys
      const prefix = this.backend._prefixKey('');
      return prefixed.map(k => k.startsWith(prefix) ? k.slice(prefix.length) : k);
    }
    // In-memory: iterate the Map
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    const regex = new RegExp('^' + escaped + '$');
    const result = [];
    for (const key of this.backend.cache.keys()) {
      if (regex.test(key)) result.push(key);
    }
    return result;
  }

  /**
   * Get or set - returns cached value or fetches and caches
   * Includes stampede prevention: if multiple requests come in while fetching,
   * they all wait for the same fetch instead of triggering multiple API calls
   * @param {string} key - Cache key
   * @param {Function} fetchFn - Async function to fetch value if not cached
   * @param {number} ttlMs - Time to live in milliseconds
   * @returns {Promise<any>}
   */
  async getOrSet(key, fetchFn, ttlMs = 60000) {
    const cached = await this.get(key);
    if (cached !== undefined) {
      return cached;
    }

    // Stampede prevention: check if fetch is already in progress
    if (this.inFlightFetches.has(key)) {
      return this.inFlightFetches.get(key);
    }

    // Create fetch promise and store it for deduplication.
    // 30s timeout ensures the in-flight map entry is always cleaned up even if fetchFn hangs.
    const INFLIGHT_TIMEOUT_MS = 30000;
    const fetchPromise = (async () => {
      try {
        const value = await Promise.race([
          fetchFn(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('getOrSet timeout')), INFLIGHT_TIMEOUT_MS)
          )
        ]);
        if (value != null) {
          await this.set(key, value, ttlMs);
        }
        return value;
      } finally {
        // Clean up in-flight tracking
        this.inFlightFetches.delete(key);
      }
    })();

    this.inFlightFetches.set(key, fetchPromise);
    return fetchPromise;
  }

  /**
   * Get cached value with metadata (for freshness checking)
   * @param {string} key - Cache key
   * @returns {Promise<{value: any, age: number, fresh: boolean} | undefined>}
   */
  async getWithMeta(key) {
    if (this.backendType === 'memory') {
      const entry = this.backend.cache.get(key);
      if (!entry || Date.now() > entry.expiry) {
        return undefined;
      }
      const age = Date.now() - entry.createdAt;
      // Check if value was stored with setWithTimestamp (has _data wrapper)
      const actualValue = entry.value && entry.value._data !== undefined
        ? entry.value._data
        : entry.value;
      const cachedAt = entry.value && entry.value._cachedAt
        ? entry.value._cachedAt
        : entry.createdAt;
      const actualAge = Date.now() - cachedAt;
      return {
        value: actualValue,
        age: actualAge,
        fresh: actualAge < TTL.PRICE_FRESH
      };
    }
    // For Redis, we store timestamp in the value
    const data = await this.get(key);
    if (data === undefined) return undefined;

    // If data has _cachedAt, use it for freshness (from setWithTimestamp)
    if (data && data._cachedAt !== undefined) {
      const age = Date.now() - data._cachedAt;
      // Extract actual value from _data wrapper
      const actualValue = data._data !== undefined ? data._data : data;
      return {
        value: actualValue,
        age,
        fresh: age < TTL.PRICE_FRESH
      };
    }
    return { value: data, age: 0, fresh: true };
  }

  /**
   * Set value with timestamp for freshness tracking
   * @param {string} key - Cache key
   * @param {any} value - Value to cache
   * @param {number} ttlMs - Time to live in milliseconds
   */
  async setWithTimestamp(key, value, ttlMs = TTL.PRICE_DATA) {
    // Wrap value with metadata - handle arrays and objects differently
    const valueWithMeta = {
      _data: value,
      _cachedAt: Date.now()
    };
    return this.set(key, valueWithMeta, ttlMs);
  }

  /**
   * Get cached value if fresh enough, otherwise fetch new data
   * Used for price data with 5-minute cache but 1-minute freshness for token pages
   * Includes stampede prevention for concurrent requests
   * @param {string} key - Cache key
   * @param {Function} fetchFn - Async function to fetch value
   * @param {boolean} requireFresh - If true, requires data to be < 1 minute old
   * @returns {Promise<any>}
   */
  async getOrSetWithFreshness(key, fetchFn, requireFresh = false) {
    const cached = await this.getWithMeta(key);

    // If cached and either we don't require fresh data or it is fresh
    if (cached && (!requireFresh || cached.fresh)) {
      return cached.value;
    }

    // Stampede prevention: check if fetch is already in progress
    const freshnessKey = `fresh:${key}`;
    if (this.inFlightFetches.has(freshnessKey)) {
      // Wait for in-flight fetch, but return stale cached data if available and fetch fails
      try {
        return await this.inFlightFetches.get(freshnessKey);
      } catch (error) {
        // Always propagate overload errors — don't mask systemic issues with stale data
        if (error.isOverloaded || error.isCircuitBreakerError) throw error;
        if (cached) return cached.value;
        throw error;
      }
    }

    // Create fetch promise with stampede prevention
    const fetchPromise = (async () => {
      try {
        const value = await fetchFn();
        // Don't cache null/undefined results -- they likely indicate transient API failures
        if (value != null) {
          await this.setWithTimestamp(key, value, TTL.PRICE_DATA);
        }
        return value;
      } finally {
        this.inFlightFetches.delete(freshnessKey);
      }
    })();

    this.inFlightFetches.set(freshnessKey, fetchPromise);

    try {
      return await fetchPromise;
    } catch (error) {
      // Always propagate overload errors — don't mask systemic issues with stale data
      if (error.isOverloaded || error.isCircuitBreakerError) throw error;
      // Return stale data as fallback if fetch fails
      if (cached) return cached.value;
      throw error;
    }
  }

  async getStats() {
    return this.backend.getStats();
  }

  checkHealth() {
    return this.backend.checkHealth();
  }

  getBackendType() {
    return this.backendType;
  }

  destroy() {
    return this.backend.destroy();
  }
}

// Singleton instance
const cache = new CacheService();

module.exports = {
  cache,
  CacheService,
  TTL,
  keys
};
