const axios = require('axios');
const { normalizeLogoUri } = require('./tokenImage');
const { rateLimitedRequest, sleep, useGeckoFreeTierLimits } = require('./rateLimiter');
const { circuitBreakers } = require('./circuitBreaker');
const { httpsAgent } = require('./httpAgent');
const { cache: redisCache, TTL } = require('./cache');
const {
  geckoPoolSide, geckoPoolView, pickGeckoPool, geckoBaseSideChange, geckoListedToken, geckoPoolTokens, poolNameSymbol
} = require('./poolPricing');

// GeckoTerminal / CoinGecko Onchain API
// Free tier: https://api.geckoterminal.com/api/v2 (30 req/min, no key)
// Basic plan: https://pro-api.coingecko.com/api/v3/onchain (300 req/min, key required)
const COINGECKO_API_KEY = process.env.COINGECKO_API_KEY || '';
const GECKO_API = COINGECKO_API_KEY
  ? 'https://pro-api.coingecko.com/api/v3/onchain'
  : 'https://api.geckoterminal.com/api/v2';
const NETWORK = 'solana';

// Per-call progress logs (entry, counts, samples) only when DEBUG_API_LOGS=1; warnings
// and errors are always logged.
const DEBUG_API_LOGS = process.env.DEBUG_API_LOGS === '1';
function debugLog(...args) {
  if (DEBUG_API_LOGS) console.log(...args);
}

/** Ensure no token leaves with null name/symbol — use truncated address as fallback */
function ensureTokenMetadata(tokens) {
  for (const t of tokens) {
    const addr = t.address || t.mintAddress || '';
    if (!t.name) t.name = addr ? `${addr.slice(0, 4)}...${addr.slice(-4)}` : null;
    if (!t.symbol) t.symbol = addr ? addr.slice(0, 5).toUpperCase() : null;
  }
  return tokens;
}

if (COINGECKO_API_KEY) {
  console.log('[GeckoTerminal] Using CoinGecko Pro API (paid tier)');
} else {
  console.log('[GeckoTerminal] Using free GeckoTerminal API (30 req/min) — set COINGECKO_API_KEY for Basic plan (300 req/min)');
}

// True while requests go to the free API (30 req/min): no key, or the key was rejected.
// The rate limiter and 429 retries are paced for the free tier then.
let geckoFreeTier = false;
function switchToFreeTier() {
  geckoFreeTier = true;
  useGeckoFreeTierLimits();
}
if (!COINGECKO_API_KEY) switchToFreeTier();

// Create axios instance with connection pooling for GeckoTerminal
const geckoHeaders = { 'Accept': 'application/json' };
if (COINGECKO_API_KEY) {
  geckoHeaders['x-cg-pro-api-key'] = COINGECKO_API_KEY;
}

const geckoAxios = axios.create({
  baseURL: GECKO_API,
  httpsAgent,
  timeout: 30000,
  headers: geckoHeaders
});

// If a Pro API key is configured, intercept the first 401 and automatically
// fall back to the free GeckoTerminal API rather than spamming 401 errors forever.
if (COINGECKO_API_KEY) {
  let authInterceptorId;
  authInterceptorId = geckoAxios.interceptors.response.use(
    response => response,
    error => {
      if (error.response?.status === 401) {
        console.warn('[GeckoTerminal] CoinGecko Pro API key rejected (401) — falling back to free GeckoTerminal API (30 req/min). Check COINGECKO_API_KEY env var.');
        geckoAxios.defaults.baseURL = 'https://api.geckoterminal.com/api/v2';
        delete geckoAxios.defaults.headers.common['x-cg-pro-api-key'];
        geckoAxios.interceptors.response.eject(authInterceptorId);
        switchToFreeTier();
      }
      return Promise.reject(error);
    }
  );
}

// Retry configuration for 429 errors
// CoinGecko Basic plan (300 req/min) resets quickly — shorter backoff is fine.
const RETRY_CONFIG = {
  maxRetries: 2,
  baseDelay: 1000,      // 1 second initial delay (rate window resets in ~200ms)
  maxDelay: 5000,       // 5 seconds max delay
  backoffMultiplier: 2  // Exponential backoff: 1s → 2s → give up
};
// The free API's window is a minute: wait at least this long before retrying a 429 there,
// and retry once.
const FREE_TIER_RETRY_FLOOR_MS = 15000;
const FREE_TIER_MAX_RETRIES = 1;
// Give up rather than sleep when the server asks for a longer wait than this
const RETRY_AFTER_MAX_MS = 30000;

/**
 * Milliseconds a 429 response asks us to wait (Retry-After as seconds or an HTTP date),
 * or null when it does not say.
 */
function retryAfterMs(error) {
  const headers = error?.response?.headers;
  const value = headers && (typeof headers.get === 'function' ? headers.get('retry-after') : headers['retry-after']);
  if (value == null || value === '') return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

/**
 * Execute request with retry logic for 429 (rate limit) errors
 * Uses exponential backoff with jitter
 */
async function withRetry(requestFn, context = 'request') {
  for (let attempt = 0; ; attempt++) {
    try {
      return await requestFn();
    } catch (error) {
      // Only retry on 429 (rate limit) errors
      if (error.response?.status !== 429) {
        throw error;
      }

      const maxRetries = geckoFreeTier ? FREE_TIER_MAX_RETRIES : RETRY_CONFIG.maxRetries;
      if (attempt >= maxRetries) {
        console.error(`[GeckoTerminal] ${context}: Max retries (${maxRetries}) exceeded for 429 error`);
        throw error;
      }

      // Calculate delay with exponential backoff and jitter, but never sooner than the
      // server's Retry-After or, on the free tier, the floor for its one-minute window
      const baseDelay = RETRY_CONFIG.baseDelay * Math.pow(RETRY_CONFIG.backoffMultiplier, attempt);
      const jitter = Math.random() * 1000; // 0-1s jitter
      const backoff = Math.min(baseDelay + jitter, RETRY_CONFIG.maxDelay);
      const delay = Math.max(backoff, retryAfterMs(error) ?? 0, geckoFreeTier ? FREE_TIER_RETRY_FLOOR_MS : 0);
      if (delay > RETRY_AFTER_MAX_MS) {
        console.error(`[GeckoTerminal] ${context}: 429 asks for a ${Math.round(delay / 1000)}s wait, not retrying`);
        throw error;
      }

      console.log(`[GeckoTerminal] ${context}: Rate limited (429), retry ${attempt + 1}/${maxRetries} after ${Math.round(delay)}ms`);
      await sleep(delay);
    }
  }
}

/**
 * In-flight request deduplication
 * Prevents multiple concurrent requests for the same resource.
 * Entries store { promise, createdAt } so stale entries can be swept.
 */
const inFlightRequests = new Map();
const IN_FLIGHT_MAX_AGE_MS = 30000; // 30s

const _inFlightSweepTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of inFlightRequests) {
    if (now - entry.createdAt > IN_FLIGHT_MAX_AGE_MS) {
      inFlightRequests.delete(key);
    }
  }
}, IN_FLIGHT_MAX_AGE_MS);
if (_inFlightSweepTimer.unref) _inFlightSweepTimer.unref();

/**
 * Local cache for pool addresses (avoids repeated pool lookups for OHLCV)
 * TTL: 5 minutes
 */
const poolAddressCache = new Map();
// Pool addresses for established tokens are stable for hours; long TTL avoids the extra
// sequential API call before OHLCV can be fetched on every cache miss / server restart.
const POOL_CACHE_TTL = 2 * 60 * 60 * 1000; // 2 hours

/**
 * Local cache for error responses (prevents repeated failed API calls)
 * TTL: 1 minute
 */
const errorCache = new Map();
const ERROR_CACHE_TTL = 5 * 60 * 1000; // 5 minutes — avoid re-fetching known-missing tokens

// Periodic cache cleanup for all local caches
const MAX_POOL_ADDRESS_CACHE_SIZE = 2000;
const MAX_ERROR_CACHE_SIZE = 500;

const _cacheCleanupTimer = setInterval(() => {
  const now = Date.now();
  // Clean pool address cache
  for (const [key, entry] of poolAddressCache) {
    if (now > entry.expiry) {
      poolAddressCache.delete(key);
    }
  }
  if (poolAddressCache.size > MAX_POOL_ADDRESS_CACHE_SIZE) {
    const entries = [...poolAddressCache.entries()].sort((a, b) => a[1].expiry - b[1].expiry);
    for (const [key] of entries.slice(0, entries.length - MAX_POOL_ADDRESS_CACHE_SIZE)) {
      poolAddressCache.delete(key);
    }
  }
  // Clean error cache (entries stored with { expiry: Date.now() + TTL })
  for (const [key, entry] of errorCache) {
    if (now >= entry.expiry) {
      errorCache.delete(key);
    }
  }
  if (errorCache.size > MAX_ERROR_CACHE_SIZE) {
    errorCache.clear();
  }
}, 5 * 60 * 1000);
if (_cacheCleanupTimer.unref) _cacheCleanupTimer.unref();

/**
 * Execute a deduplicated request - if the same key is already in flight,
 * return the existing promise instead of making a new request
 * Includes 429 retry logic with exponential backoff
 */
async function deduplicatedRequest(key, requestFn) {
  // Check if request is already in flight
  if (inFlightRequests.has(key)) {
    return inFlightRequests.get(key).promise;
  }

  // Create the request promise with circuit breaker + retry + rate limiting
  const requestPromise = (async () => {
    try {
      return await circuitBreakers.geckoTerminal.execute(() =>
        withRetry(
          () => rateLimitedRequest('geckoTerminal', requestFn),
          key
        )
      );
    } finally {
      // Clean up after request completes (success or failure)
      inFlightRequests.delete(key);
    }
  })();

  // Store the promise for deduplication
  inFlightRequests.set(key, { promise: requestPromise, createdAt: Date.now() });
  return requestPromise;
}

/**
 * Make a rate-limited request to GeckoTerminal API
 * Basic plan: 300 requests/minute (free tier: 30 req/min)
 * Includes 429 retry logic with exponential backoff
 */
async function geckoRequest(requestFn, context = 'geckoRequest') {
  return circuitBreakers.geckoTerminal.execute(() =>
    withRetry(
      () => rateLimitedRequest('geckoTerminal', requestFn),
      context
    )
  );
}

// Pool records reduced to the fields the pool pricing helpers and getTokenPools read,
// so the shared pools page stays small in Redis.
function trimPool(pool) {
  const a = pool.attributes || {};
  const rel = pool.relationships || {};
  return {
    id: pool.id,
    type: pool.type,
    attributes: {
      address: a.address,
      name: a.name,
      pool_created_at: a.pool_created_at,
      base_token_price_usd: a.base_token_price_usd,
      quote_token_price_usd: a.quote_token_price_usd,
      price_change_percentage: a.price_change_percentage ? { h24: a.price_change_percentage.h24 } : undefined,
      market_cap_usd: a.market_cap_usd,
      fdv_usd: a.fdv_usd,
      reserve_in_usd: a.reserve_in_usd,
      volume_usd: a.volume_usd ? { h24: a.volume_usd.h24 } : undefined,
      transactions: a.transactions ? { h24: a.transactions.h24 } : undefined
    },
    relationships: {
      base_token: rel.base_token,
      quote_token: rel.quote_token,
      dex: rel.dex
    }
  };
}

/**
 * Page 1 of /networks/solana/tokens/{mint}/pools, shared by getTokenOverview,
 * getTokenPools and getOHLCV through one Redis entry so a token page asks
 * GeckoTerminal for it once rather than once per caller. Errors are not cached;
 * each caller keeps its own errorCache handling.
 */
const POOLS_PAGE_TTL = TTL.POOLS; // 3 minutes
async function getPoolsPage(mintAddress) {
  return redisCache.getOrSet(`gecko-pools-page:${mintAddress}`, async () => {
    const response = await deduplicatedRequest(`pools:${mintAddress}`, () =>
      geckoAxios.get(`/networks/${NETWORK}/tokens/${mintAddress}/pools`, {
        params: { page: 1 }
      })
    );
    return (response.data.data || []).map(trimPool);
  }, POOLS_PAGE_TTL);
}

/**
 * The pool OHLCV is charted from, per mint: the in-process Map is the first level and
 * Redis (shared by the API and worker, kept across restarts) the second. Pool choice is
 * stable, so the Redis entry lives well past the worker's 3h price-ref refresh cycle.
 */
const POOL_REDIS_TTL = 12 * 60 * 60 * 1000; // 12 hours
const poolRedisKey = (mintAddress) => `gecko-pool:${mintAddress}`;

function setLocalPool(mintAddress, address, side) {
  // Evict oldest entry if at capacity
  if (!poolAddressCache.has(mintAddress) && poolAddressCache.size >= MAX_POOL_ADDRESS_CACHE_SIZE) {
    poolAddressCache.delete(poolAddressCache.keys().next().value);
  }
  poolAddressCache.set(mintAddress, { address, side, expiry: Date.now() + POOL_CACHE_TTL });
}

function rememberPool(mintAddress, address, side) {
  if (!address) return;
  setLocalPool(mintAddress, address, side);
  Promise.resolve(redisCache.set(poolRedisKey(mintAddress), { address, side }, POOL_REDIS_TTL)).catch(() => {});
}

async function lookupPool(mintAddress) {
  const local = poolAddressCache.get(mintAddress);
  if (local && Date.now() < local.expiry) {
    return { address: local.address, side: local.side || 'base' };
  }
  const shared = await redisCache.get(poolRedisKey(mintAddress)).catch(() => undefined);
  if (shared?.address) {
    setLocalPool(mintAddress, shared.address, shared.side);
    return { address: shared.address, side: shared.side || 'base' };
  }
  return null;
}

function forgetPool(mintAddress) {
  poolAddressCache.delete(mintAddress);
  Promise.resolve(redisCache.delete(poolRedisKey(mintAddress))).catch(() => {});
}

// Get API headers (includes API key when configured)
function getHeaders() {
  const headers = { 'Accept': 'application/json' };
  if (COINGECKO_API_KEY) {
    headers['x-cg-pro-api-key'] = COINGECKO_API_KEY;
  }
  return headers;
}

/**
 * Get token info by address
 * Endpoint: /networks/{network}/tokens/{address}
 * Uses request deduplication to prevent concurrent calls for same token
 * Caches null responses for 1 minute to prevent repeated failed lookups
 */
async function getTokenInfo(mintAddress) {
  debugLog(`[GeckoTerminal] getTokenInfo: ${mintAddress}`);

  // Check error cache first
  const errorCacheKey = `token:${mintAddress}`;
  const cachedError = errorCache.get(errorCacheKey);
  if (cachedError && Date.now() < cachedError.expiry) {
    debugLog(`[GeckoTerminal] Returning cached null for ${mintAddress} (error cached)`);
    return null;
  }

  try {
    const response = await deduplicatedRequest(`token:${mintAddress}`, () =>
      geckoAxios.get(`/networks/${NETWORK}/tokens/${mintAddress}`)
    );

    const token = response.data.data;
    if (!token) {
      debugLog('[GeckoTerminal] No token data returned');
      // Cache the null response
      errorCache.set(errorCacheKey, { expiry: Date.now() + ERROR_CACHE_TTL });
      return null;
    }

    const attrs = token.attributes || {};

    return {
      mintAddress: attrs.address,
      address: attrs.address,
      name: attrs.name || null,
      symbol: attrs.symbol || null,
      decimals: attrs.decimals || 9,
      logoUri: normalizeLogoUri(attrs.image_url),
      logoURI: normalizeLogoUri(attrs.image_url),
      price: parseFloat(attrs.price_usd) || 0,
      volume24h: parseFloat(attrs.volume_usd?.h24) || 0,
      marketCap: parseFloat(attrs.market_cap_usd) || 0,
      fdv: parseFloat(attrs.fdv_usd) || 0,
      totalSupply: attrs.total_supply,
      coingeckoId: attrs.coingecko_coin_id
    };
  } catch (error) {
    console.error('[GeckoTerminal] getTokenInfo error:', error.message);
    // Cache the error (but not 429 errors - those should retry)
    if (error.response?.status !== 429) {
      errorCache.set(errorCacheKey, { expiry: Date.now() + ERROR_CACHE_TTL });
    }
    return null;
  }
}

/**
 * Get multiple token prices in one request
 * Endpoint: /networks/{network}/tokens/multi/{addresses}
 * Max 30 addresses per request
 */
// Session flag: set to false if the free API rejects include=top_pools, so we stop
// doubling every request with a doomed first attempt.
let _multiTokenIncludeSupported = true;

async function getMultiTokenInfo(addresses) {
  if (!addresses || addresses.length === 0) {
    return {};
  }

  debugLog(`[GeckoTerminal] getMultiTokenInfo: fetching ${addresses.length} tokens`);

  // GeckoTerminal accepts comma-separated addresses (max ~30 per request)
  const addressList = addresses.slice(0, 30).join(',');
  const safeFloat = (v) => { const n = parseFloat(v); return isNaN(n) ? null : n; };

  const parseResponse = (responseData) => {
    const tokens = responseData.data || [];
    const included = responseData.included || [];

    // Pool records come back via `include=top_pools`; pools reliably expose
    // price_change_percentage while the token endpoint does not. That change belongs to the
    // pool's base token, so it is only used for a token that is the base of the pool.
    const includedPools = {};
    for (const item of included) {
      if (item.type === 'pool') includedPools[item.id] = item;
    }

    const result = {};
    for (const token of tokens) {
      const attrs = token.attributes || {};
      const address = attrs.address;
      if (!address) continue;

      // Prefer token-level price change if present; fall back to the first top pool
      // where this token is the base.
      let priceChange24h = attrs.price_change_percentage?.h24 != null
        ? safeFloat(attrs.price_change_percentage.h24)
        : null;

      if (priceChange24h == null) {
        for (const ref of token.relationships?.top_pools?.data || []) {
          const pool = includedPools[ref.id];
          if (!pool || geckoPoolSide(pool, address) !== 'base') continue;
          const pc = safeFloat(pool.attributes?.price_change_percentage?.h24);
          if (pc != null) { priceChange24h = pc; break; }
        }
      }

      result[address] = {
        price:        attrs.price_usd        != null ? safeFloat(attrs.price_usd)        : null,
        volume24h:    attrs.volume_usd?.h24  != null ? safeFloat(attrs.volume_usd.h24)   : null,
        priceChange24h,
        marketCap:    attrs.market_cap_usd   != null ? safeFloat(attrs.market_cap_usd)   : null,
        fdv:          attrs.fdv_usd          != null ? safeFloat(attrs.fdv_usd)          : null,
        name:         attrs.name,
        symbol:       attrs.symbol,
        decimals:     attrs.decimals,
        logoUri:      normalizeLogoUri(attrs.image_url)
      };
    }
    return result;
  };

  // Attempt with include=top_pools so pool records (which carry
  // price_change_percentage.h24) are returned in the same response.
  // If the API rejects the parameter (400/422) we fall back to the plain token request
  // and skip the include attempt for the rest of this process lifetime to avoid
  // double-calling. Other failures fall back for this call only.
  if (_multiTokenIncludeSupported) {
    try {
      const response = await geckoRequest(() =>
        geckoAxios.get(`/networks/${NETWORK}/tokens/multi/${addressList}`, {
          params: { include: 'top_pools' }
        }),
        'getMultiTokenInfo'
      );
      const result = parseResponse(response.data);
      const withChange = Object.values(result).filter(r => r.priceChange24h != null).length;
      debugLog(`[GeckoTerminal] multi token response: ${Object.keys(result).length} tokens, ${withChange} with price change`);
      return result;
    } catch (includeErr) {
      // Only a 400/422 means the API rejects the parameter; stop sending it for this
      // session then. A 429, timeout, 5xx or open breaker is transient: fall back to the
      // plain request for this call only and try include again next time.
      const status = includeErr.response?.status;
      if (status === 400 || status === 422) {
        _multiTokenIncludeSupported = false;
        console.warn('[GeckoTerminal] include=top_pools unsupported, disabling for this session:', includeErr.message);
      } else {
        console.warn('[GeckoTerminal] include=top_pools request failed, using plain request this time:', includeErr.message);
      }
    }
  }

  // Plain token request (no include) — used when include=top_pools is not supported
  try {
    const response = await geckoRequest(() =>
      geckoAxios.get(`/networks/${NETWORK}/tokens/multi/${addressList}`),
      'getMultiTokenInfo'
    );
    const result = parseResponse(response.data);
    debugLog(`[GeckoTerminal] multi token response: ${Object.keys(result).length} tokens`);
    return result;
  } catch (error) {
    console.error('[GeckoTerminal] getMultiTokenInfo error:', error.message);
    return {};
  }
}

/**
 * Get multiple pool details in one request
 * Endpoint: /networks/{network}/pools/multi/{pool_addresses}
 * Returns pool_created_at and market data for each pool.
 * Max 30 pool addresses per request.
 * @param {string[]} poolAddresses - Array of pool addresses
 * @returns {Object} Map of pool address -> { poolCreatedAt, price, volume24h, ... }
 */
async function getMultiPoolInfo(poolAddresses) {
  if (!poolAddresses || poolAddresses.length === 0) return {};

  debugLog(`[GeckoTerminal] getMultiPoolInfo: fetching ${poolAddresses.length} pools`);

  try {
    const addressList = poolAddresses.slice(0, 30).join(',');

    const response = await geckoRequest(() =>
      geckoAxios.get(`/networks/${NETWORK}/pools/multi/${addressList}`),
      'getMultiPoolInfo'
    );

    const pools = response.data.data || [];
    const result = {};
    const safeFloat = (v) => { const n = parseFloat(v); return isNaN(n) ? null : n; };

    for (const pool of pools) {
      const attrs = pool.attributes || {};
      const poolAddr = attrs.address;
      if (!poolAddr) continue;

      // The pool's memecoin side (the quote when the base is SOL/USDC/USDT)
      const listed = geckoListedToken(pool);
      if (!listed) continue;

      result[poolAddr] = {
        tokenAddress: listed.address,
        poolCreatedAt: attrs.pool_created_at || null,
        price: listed.price,
        priceChange24h: listed.priceChange24h,
        volume24h: listed.volume24h,
        liquidity: listed.liquidity,
        fdv: listed.fdv,
        marketCap: listed.marketCap
      };
    }

    debugLog(`[GeckoTerminal] multi pool response: ${Object.keys(result).length} pools`);
    return result;
  } catch (error) {
    console.error('[GeckoTerminal] getMultiPoolInfo error:', error.message);
    return {};
  }
}

/**
 * Get token overview with price and market data
 * Optimized: Only fetches pools endpoint which includes price data
 * Metadata comes from Helius, so we only need market data from GeckoTerminal
 * Caches null responses for 1 minute to prevent repeated failed lookups
 */
async function getTokenOverview(mintAddress) {
  // Check Redis cache first (2 min TTL — price data needs freshness)
  const overviewCacheKey = `gecko-overview:${mintAddress}`;
  const redisCached = await redisCache.get(overviewCacheKey);
  if (redisCached) return redisCached;

  // Check error cache (avoid re-fetching known failures)
  const errorCacheKey = `overview:${mintAddress}`;
  const cachedError = errorCache.get(errorCacheKey);
  if (cachedError && Date.now() < cachedError.expiry) {
    return null;
  }

  try {
    // Only fetch pools - it includes price and market data we need
    // Metadata (name, symbol, decimals) now comes from Helius
    const pools = await getPoolsPage(mintAddress);

    if (pools.length === 0) {
      // No pools found - try token endpoint as fallback
      debugLog(`[GeckoTerminal] No pools found for ${mintAddress}, trying token endpoint`);
      const tokenInfo = await getTokenInfo(mintAddress);
      if (!tokenInfo) {
        // Cache the null response
        errorCache.set(errorCacheKey, { expiry: Date.now() + ERROR_CACHE_TTL });
      }
      return tokenInfo;
    }

    // Read the token's figures from its deepest pool, on whichever side of the pair the
    // token sits. pools[0] is GeckoTerminal's volume-weighted pick and can be a pool where
    // the token is the quote (e.g. ZEC / TOKEN), whose headline fields describe ZEC.
    const picked = pickGeckoPool(pools, mintAddress);
    if (!picked) {
      debugLog(`[GeckoTerminal] No pool on page 1 names ${mintAddress.slice(0, 8)}..., trying token endpoint`);
      return await getTokenInfo(mintAddress);
    }
    const view = geckoPoolView(picked.pool, picked.side);
    const ownPools = pools.filter(p => geckoPoolSide(p, mintAddress));

    let price = view.price || 0;
    let fdv = view.fdv || 0;
    let marketCap = view.marketCap || fdv;
    // The provider only publishes 24h change for a pool's base token
    const priceChange24h = view.priceChange24h ?? geckoBaseSideChange(ownPools, mintAddress) ?? 0;
    const liquidity = view.liquidity || 0;
    // Token volume is every pool it trades in, not just the one we priced from
    const volume24h = ownPools.reduce((sum, p) => sum + (parseFloat(p.attributes?.volume_usd?.h24) || 0), 0);

    if (picked.side === 'quote') {
      // Pools publish FDV / market cap for their base only. Use the token-level USD figures.
      const info = await getTokenInfo(mintAddress).catch(() => null);
      if (info) {
        fdv = info.fdv || 0;
        marketCap = info.marketCap || fdv;
        if (!price && info.price) price = info.price;
      } else {
        fdv = 0;
        marketCap = 0;
      }
    }

    const tokenAddress = mintAddress;
    const symbol = view.symbol;

    // Token age: the oldest pool it trades in
    const createdTimes = ownPools.map(p => p.attributes?.pool_created_at).filter(Boolean)
      .sort((a, b) => new Date(a) - new Date(b));
    const pairCreatedAt = createdTimes[0] || null;

    // Collect DEX IDs from all pools for filtering
    const dexIds = [...new Set(pools.map(p =>
      (p.relationships?.dex?.data?.id || '').toLowerCase()
    ).filter(Boolean))];

    const overviewResult = {
      mintAddress: tokenAddress,
      address: tokenAddress,
      name: symbol, // Basic name from pool, Helius provides better metadata
      symbol: symbol,
      decimals: 9, // Default, Helius provides accurate decimals
      logoUri: null, // Helius provides logos
      logoURI: null,
      price,
      volume24h,
      marketCap,
      fdv,
      priceChange24h,
      liquidity,
      totalSupply: null, // Helius provides supply
      holder: null,
      pairCreatedAt,
      poolAddress: view.poolAddress,
      poolSide: picked.side,
      dexIds
    };
    // getOHLCV charts the same pool; save it the lookup
    rememberPool(mintAddress, view.poolAddress, picked.side);
    // Cache for 2 minutes (price data needs reasonable freshness)
    await redisCache.set(overviewCacheKey, overviewResult, TTL.OHLCV || 120000);
    return overviewResult;
  } catch (error) {
    // 404 = token not indexed on GeckoTerminal — expected, not a real error
    if (error.response?.status === 404) {
      console.warn(`[GeckoTerminal] getTokenOverview: token not found on GeckoTerminal (${mintAddress.slice(0, 8)}...)`);
    } else {
      console.error('[GeckoTerminal] getTokenOverview error:', error.message);
    }
    // Cache the error (but not 429 errors - those should retry)
    if (error.response?.status !== 429) {
      errorCache.set(errorCacheKey, { expiry: Date.now() + ERROR_CACHE_TTL });
    }
    return null;
  }
}

/**
 * Get market data only (price, volume, price change, liquidity)
 * Optimized version when metadata is fetched from Helius
 * Makes only 1 GeckoTerminal call instead of 2
 */
async function getMarketData(mintAddress) {
  debugLog(`[GeckoTerminal] getMarketData: ${mintAddress}`);

  try {
    // Only fetch single-token info (price change comes from getTokenInfo's pool lookup)
    const tokenInfo = await getTokenInfo(mintAddress);

    if (!tokenInfo) {
      return null;
    }

    return {
      price: tokenInfo.price || 0,
      volume24h: tokenInfo.volume24h || 0,
      marketCap: tokenInfo.marketCap || 0,
      fdv: tokenInfo.fdv || 0,
      priceChange24h: 0, // Not available from token endpoint alone
      liquidity: 0,       // Not available from token endpoint alone
      totalSupply: tokenInfo.totalSupply
    };
  } catch (error) {
    console.error('[GeckoTerminal] getMarketData error:', error.message);
    return null;
  }
}

/**
 * Get trending tokens/pools
 * Endpoint: /networks/{network}/trending_pools
 * Optimized: Returns tokens without enrichment (caller can enrich via Helius batch)
 * Set skipEnrichment=true to skip GeckoTerminal enrichment call
 */
async function getTrendingTokens(options = {}) {
  const { limit = 20, skipEnrichment = false, page = 1 } = options;

  debugLog(`[GeckoTerminal] getTrendingTokens: limit=${limit}, page=${page}, skipEnrichment=${skipEnrichment}`);

  try {
    const response = await geckoRequest(() =>
      geckoAxios.get(`/networks/${NETWORK}/trending_pools`, {
        params: { page }
      }),
      'getTrendingTokens'
    );

    const pools = response.data.data || [];
    debugLog(`[GeckoTerminal] Trending pools returned: ${pools.length}`);

    if (pools.length === 0) {
      return [];
    }

    // Extract unique base tokens from pools
    const seenAddresses = new Set();
    const tokens = [];

    for (const pool of pools) {
      if (tokens.length >= limit) break;

      const attrs = pool.attributes || {};
      // The pool's memecoin side, priced from that side: a SOL / TOKEN pool lists TOKEN
      const listed = geckoListedToken(pool);
      if (!listed || seenAddresses.has(listed.address)) continue;
      seenAddresses.add(listed.address);

      tokens.push({
        mintAddress: listed.address,
        address: listed.address,
        name: listed.symbol, // Will be enriched by caller via Helius
        symbol: listed.symbol,
        decimals: 9,
        logoUri: null, // Will be enriched by caller via Helius
        logoURI: null,
        price: listed.price || 0,
        priceChange24h: listed.priceChange24h || 0,
        volume24h: listed.volume24h || 0,
        liquidity: listed.liquidity || 0,
        marketCap: listed.marketCap || listed.fdv || 0,
        fdv: listed.fdv || 0,
        poolAddress: attrs.address,
        transactions24h: (attrs.transactions?.h24?.buys || 0) + (attrs.transactions?.h24?.sells || 0)
      });
    }

    // Only enrich via GeckoTerminal if explicitly requested (skipEnrichment=false)
    // Otherwise, caller should use Helius batch API for better efficiency
    if (!skipEnrichment && tokens.length > 0) {
      const addresses = tokens.map(t => t.address);
      const tokenInfoMap = await getMultiTokenInfo(addresses);

      for (const token of tokens) {
        const info = tokenInfoMap[token.address];
        if (info) {
          token.name = info.name || token.name;
          token.symbol = info.symbol || token.symbol;
          token.decimals = info.decimals || token.decimals;
          token.logoUri = info.logoUri || token.logoUri;
          token.logoURI = info.logoUri || token.logoURI;
          // Use token-level market cap if available (a quote-side pool publishes none)
          if (info.marketCap) token.marketCap = info.marketCap;
          else if (!token.marketCap && info.fdv) { token.marketCap = info.fdv; token.fdv = token.fdv || info.fdv; }
        }
      }
    }

    debugLog(`[GeckoTerminal] Returning ${tokens.length} trending tokens`);

    // Log sample token
    if (DEBUG_API_LOGS && tokens.length > 0) {
      console.log('[GeckoTerminal] Sample trending token:', JSON.stringify(tokens[0], null, 2));
    }

    return ensureTokenMetadata(tokens);
  } catch (error) {
    console.error('[GeckoTerminal] getTrendingTokens error:', error.message);
    if (error.response) {
      console.error('[GeckoTerminal] Response status:', error.response.status);
    }
    return [];
  }
}

/**
 * Get new tokens/pools
 * Endpoint: /networks/{network}/new_pools
 * Optimized: Set skipEnrichment=true to skip GeckoTerminal enrichment (use Helius batch instead)
 */
async function getNewTokens(limit = 20, skipEnrichment = false, page = 1) {
  debugLog(`[GeckoTerminal] getNewTokens: limit=${limit}, page=${page}, skipEnrichment=${skipEnrichment}`);

  try {
    const response = await geckoRequest(() =>
      geckoAxios.get(`/networks/${NETWORK}/new_pools`, {
        params: { page }
      }),
      'getNewTokens'
    );

    const pools = response.data.data || [];
    debugLog(`[GeckoTerminal] New pools returned: ${pools.length}`);

    if (pools.length === 0) {
      return [];
    }

    // Extract unique base tokens from pools
    const seenAddresses = new Set();
    const tokens = [];

    for (const pool of pools) {
      if (tokens.length >= limit) break;

      const attrs = pool.attributes || {};
      const listed = geckoListedToken(pool);
      if (!listed || seenAddresses.has(listed.address)) continue;
      seenAddresses.add(listed.address);

      tokens.push({
        mintAddress: listed.address,
        address: listed.address,
        name: listed.symbol,
        symbol: listed.symbol,
        decimals: 9,
        logoUri: null,
        logoURI: null,
        price: listed.price || 0,
        priceChange24h: listed.priceChange24h || 0,
        volume24h: listed.volume24h || 0,
        liquidity: listed.liquidity || 0,
        marketCap: listed.marketCap || listed.fdv || 0,
        fdv: listed.fdv || 0,
        createdAt: attrs.pool_created_at,
        poolAddress: attrs.address
      });
    }

    // Only enrich via GeckoTerminal if explicitly requested
    // Otherwise, caller should use Helius batch API for better efficiency
    if (!skipEnrichment && tokens.length > 0) {
      const addresses = tokens.map(t => t.address);
      const tokenInfoMap = await getMultiTokenInfo(addresses);

      for (const token of tokens) {
        const info = tokenInfoMap[token.address];
        if (info) {
          token.name = info.name || token.name;
          token.symbol = info.symbol || token.symbol;
          token.decimals = info.decimals || token.decimals;
          token.logoUri = info.logoUri || token.logoUri;
          token.logoURI = info.logoUri || token.logoURI;
          if (info.marketCap) token.marketCap = info.marketCap;
          else if (!token.marketCap && info.fdv) { token.marketCap = info.fdv; token.fdv = token.fdv || info.fdv; }
        }
      }
    }

    debugLog(`[GeckoTerminal] Returning ${tokens.length} new tokens`);
    return ensureTokenMetadata(tokens);
  } catch (error) {
    console.error('[GeckoTerminal] getNewTokens error:', error.message);
    return [];
  }
}

/**
 * Search for tokens/pools
 * Endpoint: /search/pools?query={query}&network={network}
 */
async function searchTokens(query, limit = 20, allowedDexPrefixes = null) {
  debugLog(`[GeckoTerminal] searchTokens: query="${query}", limit=${limit}, dexFilter=${allowedDexPrefixes ? allowedDexPrefixes.join(',') : 'none'}`);

  try {
    const response = await geckoRequest(() =>
      geckoAxios.get(`/search/pools`, {
        params: {
          query: query,
          network: NETWORK,
          page: 1
        }
      }),
      'searchTokens'
    );

    const pools = response.data.data || [];
    debugLog(`[GeckoTerminal] Search returned ${pools.length} pools`);

    if (pools.length === 0) {
      return [];
    }

    // Extract unique tokens from search results
    const seenAddresses = new Set();
    const tokens = [];

    for (const pool of pools) {
      if (tokens.length >= limit) break;

      const attrs = pool.attributes || {};
      // The side of the pool the query is about (or its memecoin side)
      const listed = geckoListedToken(pool, query);
      if (!listed || seenAddresses.has(listed.address)) continue;

      // Filter by DEX if allowedDexPrefixes is provided
      if (allowedDexPrefixes) {
        const dexId = (pool.relationships?.dex?.data?.id || '').toLowerCase();
        const matchesDex = allowedDexPrefixes.some(prefix => dexId.startsWith(prefix));
        if (!matchesDex) continue;
      }

      seenAddresses.add(listed.address);

      tokens.push({
        mintAddress: listed.address,
        address: listed.address,
        name: listed.symbol,
        symbol: listed.symbol,
        decimals: 9,
        logoUri: null,
        logoURI: null,
        price: listed.price || 0,
        priceChange24h: listed.priceChange24h || 0,
        volume24h: listed.volume24h || 0,
        liquidity: listed.liquidity || 0,
        marketCap: listed.marketCap || listed.fdv || 0,
        pairCreatedAt: attrs.pool_created_at || null
      });
    }

    // Enrich with full token info (name, symbol, logo, and fill missing market data)
    if (tokens.length > 0) {
      const addresses = tokens.map(t => t.address);
      const tokenInfoMap = await getMultiTokenInfo(addresses);

      for (const token of tokens) {
        const info = tokenInfoMap[token.address];
        if (info) {
          token.name = info.name || token.name;
          token.symbol = info.symbol || token.symbol;
          token.decimals = info.decimals || token.decimals;
          token.logoUri = info.logoUri || token.logoUri;
          token.logoURI = info.logoUri || token.logoURI;
          // Use token-level market cap if available (more accurate than pool-level)
          if (info.marketCap) token.marketCap = info.marketCap;
          else if (!token.marketCap && info.fdv) token.marketCap = info.fdv;
          // Back-fill volume if pool search didn't have it
          if (!token.volume24h && info.volume24h) token.volume24h = info.volume24h;
          // Back-fill price if pool search didn't have it
          if (!token.price && info.price) token.price = info.price;
        }
      }
    }

    return ensureTokenMetadata(tokens);
  } catch (error) {
    console.error('[GeckoTerminal] searchTokens error:', error.message);
    return [];
  }
}

// GeckoTerminal only serves these candle sizes:
// minute (1, 5, 15), hour (1, 4, 12) and day (1). Anything else returns an error.
const OHLCV_TIMEFRAMES = {
  '1m': { timeframe: 'minute', aggregate: 1 },
  '5m': { timeframe: 'minute', aggregate: 5 },
  '15m': { timeframe: 'minute', aggregate: 15 },
  '1h': { timeframe: 'hour', aggregate: 1 },
  '4h': { timeframe: 'hour', aggregate: 4 },
  '12h': { timeframe: 'hour', aggregate: 12 },
  '1d': { timeframe: 'day', aggregate: 1 }
};
const OHLCV_MAX_LIMIT = 1000; // GeckoTerminal's per-request cap

/**
 * Map an interval like '15m' or '4h' to GeckoTerminal's timeframe + aggregate.
 * Unsupported sizes fall back to the nearest supported one at or below them
 * ('30m' -> 15m, '1w' -> 1d) so older callers keep working.
 */
function ohlcvTimeframe(interval) {
  const key = String(interval || '1h').toLowerCase();
  if (OHLCV_TIMEFRAMES[key]) return OHLCV_TIMEFRAMES[key];
  if (key.endsWith('m')) return OHLCV_TIMEFRAMES['15m'];
  if (key.endsWith('h')) return OHLCV_TIMEFRAMES['12h'];
  return OHLCV_TIMEFRAMES['1d'];
}

/**
 * Which side of a GeckoTerminal pool the token sits on. OHLCV must be asked for
 * that side, or a pool listed as SOL / TOKEN would chart SOL's price instead.
 */
function poolSideForMint(pool, mintAddress) {
  const quoteId = pool?.relationships?.quote_token?.data?.id || '';
  return quoteId === `${NETWORK}_${mintAddress}` ? 'quote' : 'base';
}

/**
 * Get OHLCV data for a token
 * First finds the top pool for the token, then fetches OHLCV
 * Endpoint: /networks/{network}/pools/{pool}/ohlcv/{timeframe}
 * Optimized: caches pool address to avoid repeated pool lookups
 * @param {Object} options - { interval = '1h', limit = 100 (max 1000) }
 */
async function getOHLCV(mintAddress, options = {}) {
  const { interval = '1h' } = options;
  const limit = Math.min(Math.max(1, parseInt(options.limit) || 100), OHLCV_MAX_LIMIT);

  debugLog(`[GeckoTerminal] getOHLCV: ${mintAddress}, interval=${interval}, limit=${limit}`);

  try {
    // Check pool address cache first (in-process, then Redis)
    let poolAddress = null;
    let side = 'base';
    const cached = await lookupPool(mintAddress);
    if (cached) {
      poolAddress = cached.address;
      side = cached.side;
    }
    const poolFromCache = !!poolAddress;

    // If not cached, fetch pools
    if (!poolAddress) {
      const pools = await getPoolsPage(mintAddress);
      if (pools.length === 0) {
        debugLog('[GeckoTerminal] No pools found for token');
        return { mintAddress, interval, data: [] };
      }

      // Chart the deepest pool the token trades in, from the token's side of it
      const picked = pickGeckoPool(pools, mintAddress);
      poolAddress = picked?.pool.attributes?.address;
      if (!poolAddress) {
        return { mintAddress, interval, data: [] };
      }
      side = picked.side;

      rememberPool(mintAddress, poolAddress, side);
    }

    const { timeframe, aggregate } = ohlcvTimeframe(interval);

    const ohlcvResponse = await geckoRequest(() =>
      geckoAxios.get(`/networks/${NETWORK}/pools/${poolAddress}/ohlcv/${timeframe}`, {
        params: {
          aggregate,
          limit,
          currency: 'usd',
          token: side
        }
      }),
      'getOHLCV'
    ).catch(err => {
      // A remembered pool that GeckoTerminal no longer knows: pick again next time
      if (poolFromCache && err.response?.status === 404) forgetPool(mintAddress);
      throw err;
    });

    const ohlcvList = ohlcvResponse.data.data?.attributes?.ohlcv_list || [];

    // Transform to standard format
    // GeckoTerminal format: [timestamp, open, high, low, close, volume], newest first
    const data = ohlcvList.map(candle => ({
      timestamp: candle[0] * 1000, // Convert to milliseconds
      open: candle[1],
      high: candle[2],
      low: candle[3],
      close: candle[4],
      volume: candle[5]
    }));

    return {
      mintAddress,
      interval,
      poolAddress,
      data
    };
  } catch (error) {
    console.error('[GeckoTerminal] getOHLCV error:', error.message);
    return { mintAddress, interval, data: [], error: error.message };
  }
}

/**
 * Get price history for charts
 * Uses OHLCV endpoint and returns full OHLCV data
 */
async function getPriceHistory(mintAddress, options = {}) {
  const { interval = '1h' } = options;

  debugLog(`[GeckoTerminal] getPriceHistory: ${mintAddress}, interval=${interval}`);

  try {
    const ohlcv = await getOHLCV(mintAddress, { interval });

    // Return full OHLCV data (includes timestamp, open, high, low, close, volume)
    return {
      mintAddress,
      interval,
      data: ohlcv.data
    };
  } catch (error) {
    console.error('[GeckoTerminal] getPriceHistory error:', error.message);
    return { mintAddress, interval, data: [] };
  }
}

/**
 * Get token price (simple wrapper)
 */
async function getTokenPrice(mintAddress) {
  const info = await getTokenInfo(mintAddress);
  if (!info) {
    return null;
  }

  return {
    price: info.price,
    updateTime: Date.now() / 1000
  };
}

/**
 * Get liquidity pools for a token
 * Endpoint: /networks/{network}/tokens/{address}/pools
 */
async function getTokenPools(mintAddress, options = {}) {
  const { limit = 10 } = options;

  // Check error cache to avoid re-fetching known-missing tokens
  const errorCacheKey = `pools:${mintAddress}`;
  const cachedError = errorCache.get(errorCacheKey);
  if (cachedError && Date.now() < cachedError.expiry) {
    return [];
  }

  debugLog(`[GeckoTerminal] getTokenPools: ${mintAddress}, limit=${limit}`);

  try {
    const pools = await getPoolsPage(mintAddress);
    debugLog(`[GeckoTerminal] Found ${pools.length} pools for token`);

    // Deepest pools first, each priced from the token's own side of the pair
    const ownPools = pools
      .map(pool => ({ pool, side: geckoPoolSide(pool, mintAddress) }))
      .filter(p => p.side)
      .sort((a, b) => (parseFloat(b.pool.attributes?.reserve_in_usd) || 0) - (parseFloat(a.pool.attributes?.reserve_in_usd) || 0));

    return ownPools.slice(0, limit).map(({ pool, side }) => {
      const attrs = pool.attributes || {};
      const { base, quote } = geckoPoolTokens(pool);
      const view = geckoPoolView(pool, side);
      const dexId = pool.relationships?.dex?.data?.id || '';

      // Pool name is "BASE / QUOTE", sometimes with a fee tier ("A / B 0.25%")
      const symbolA = poolNameSymbol(attrs.name, 'base');
      const symbolB = poolNameSymbol(attrs.name, 'quote');

      // Format DEX name nicely
      const dexName = dexId.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

      return {
        address: attrs.address,
        name: attrs.name,
        // Frontend-expected fields
        symbolA: symbolA || '?',
        symbolB: symbolB || '?',
        type: dexName || 'AMM',
        tvl: view.liquidity || 0,
        apr24h: null, // GeckoTerminal doesn't provide APR
        // Additional data
        dex: dexId,
        baseToken: base || '',
        quoteToken: quote || '',
        side,
        priceUsd: view.price || 0,
        priceChange24h: view.priceChange24h ?? null,
        volume24h: view.volume24h || 0,
        liquidity: view.liquidity || 0,
        txns24h: {
          buys: attrs.transactions?.h24?.buys || 0,
          sells: attrs.transactions?.h24?.sells || 0
        },
        createdAt: attrs.pool_created_at
      };
    });
  } catch (error) {
    // 404 = token not indexed on GeckoTerminal — expected, not a real error
    if (error.response?.status === 404) {
      console.warn(`[GeckoTerminal] getTokenPools: token not found on GeckoTerminal (${mintAddress.slice(0, 8)}...)`);
      errorCache.set(errorCacheKey, { expiry: Date.now() + ERROR_CACHE_TTL });
    } else {
      console.error('[GeckoTerminal] getTokenPools error:', error.message);
    }
    return [];
  }
}

/**
 * Get pools for a specific DEX.
 * Endpoint: /networks/{network}/dexes/{dex}/pools
 * Returns pools sorted by volume desc. Each pool includes pool_created_at.
 * Paginate and check pool_created_at to find recently created pools.
 */
async function getDexPools(dexId, page = 1) {
  try {
    const response = await geckoRequest(() =>
      geckoAxios.get(`/networks/${NETWORK}/dexes/${dexId}/pools`, {
        params: { page }
      }),
      'getDexPools'
    );

    const pools = response.data.data || [];
    return pools.map(pool => {
      const attrs = pool.attributes || {};
      // The pool's memecoin side (the quote when the base is SOL/USDC/USDT)
      const listed = geckoListedToken(pool) || {};

      return {
        baseAddress: listed.address || null,
        poolAddress: attrs.address || null,
        name: attrs.name || '',
        createdAt: attrs.pool_created_at || null,
        price: listed.price || 0,
        priceChange24h: listed.priceChange24h || 0,
        volume24h: listed.volume24h || 0,
        liquidity: listed.liquidity || 0,
        marketCap: listed.marketCap || listed.fdv || 0,
        fdv: listed.fdv || 0
      };
    });
  } catch (error) {
    console.error('[GeckoTerminal] getDexPools error:', error.message);
    return [];
  }
}

/**
 * Get new pools filtered by DEX, sorted by creation time (newest first).
 * Uses /networks/{network}/new_pools which returns ALL DEXes' new pools
 * in chronological order, then filters client-side to the target DEX.
 *
 * Uses CoinGecko Pro API when COINGECKO_API_KEY is configured,
 * otherwise falls back to free GeckoTerminal API.
 */
async function getNewPoolsByDex(dexId, page = 1) {
  try {
    const response = await geckoRequest(() =>
      geckoAxios.get(`/networks/${NETWORK}/new_pools`, {
        params: { page }
      }),
      'getNewPoolsByDex'
    );

    const pools = response.data.data || [];
    const filtered = [];
    let oldestOnPageMs = Infinity;

    for (const pool of pools) {
      const attrs = pool.attributes || {};

      // Track the oldest pool on the entire page (any DEX) for stop condition
      const poolCreatedAt = attrs.pool_created_at;
      if (poolCreatedAt) {
        const ts = new Date(poolCreatedAt).getTime();
        if (!isNaN(ts) && ts < oldestOnPageMs) oldestOnPageMs = ts;
      }

      // Filter to target DEX — relationship ID may be plain or namespaced
      const poolDexId = pool.relationships?.dex?.data?.id || '';
      if (poolDexId !== dexId && poolDexId !== `${NETWORK}_${dexId}`) continue;

      // The pool's memecoin side (the quote when the base is SOL/USDC/USDT)
      const listed = geckoListedToken(pool) || {};

      filtered.push({
        baseAddress: listed.address || null,
        poolAddress: attrs.address || null,
        name: attrs.name || '',
        createdAt: poolCreatedAt || null,
        price: listed.price || 0,
        priceChange24h: listed.priceChange24h || 0,
        volume24h: listed.volume24h || 0,
        liquidity: listed.liquidity || 0,
        marketCap: listed.marketCap || listed.fdv || 0,
        fdv: listed.fdv || 0
      });
    }

    return {
      filtered,
      totalOnPage: pools.length,
      oldestOnPageMs: oldestOnPageMs === Infinity ? 0 : oldestOnPageMs
    };
  } catch (error) {
    console.error('[GeckoTerminal] getNewPoolsByDex error:', error.message);
    return { filtered: [], totalOnPage: 0 };
  }
}

/**
 * Get social links for a token from CoinGecko Coin API (not the onchain/DEX API).
 * Requires coingeckoId (e.g. "bitcoin", "solana").
 * The onchain endpoints (/networks/solana/tokens/...) do NOT return social data —
 * only the coin endpoint (/coins/{id}) does.
 */
const coinSocialCache = new Map();
const COIN_SOCIAL_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours — social links rarely change

async function getCoinSocialLinks(coingeckoId) {
  if (!coingeckoId) return null;

  // Check local cache first (24h TTL)
  const cached = coinSocialCache.get(coingeckoId);
  if (cached && Date.now() < cached.expiry) {
    return cached.data;
  }

  // CoinGecko Coin API — different base URL from the onchain/DEX API
  const coinBaseUrl = COINGECKO_API_KEY
    ? 'https://pro-api.coingecko.com/api/v3'
    : 'https://api.coingecko.com/api/v3';

  try {
    const headers = { 'Accept': 'application/json' };
    if (COINGECKO_API_KEY) {
      headers['x-cg-pro-api-key'] = COINGECKO_API_KEY;
    }

    const response = await rateLimitedRequest('geckoTerminal', () =>
      axios.get(`${coinBaseUrl}/coins/${encodeURIComponent(coingeckoId)}`, {
        params: {
          localization: false,
          tickers: false,
          market_data: false,
          community_data: false,
          developer_data: false,
          sparkline: false
        },
        headers,
        httpsAgent,
        timeout: 10000
      })
    );

    const links = response.data?.links;
    if (!links) {
      coinSocialCache.set(coingeckoId, { data: null, expiry: Date.now() + COIN_SOCIAL_CACHE_TTL });
      return null;
    }

    const result = {};

    // Website — homepage is an array, take first non-empty
    if (Array.isArray(links.homepage)) {
      const site = links.homepage.find(u => typeof u === 'string' && u.length > 0);
      if (site) result.website = site;
    }

    // Twitter (validate identifier to prevent URL injection)
    if (typeof links.twitter_screen_name === 'string' && links.twitter_screen_name
        && /^[a-zA-Z0-9_]{1,50}$/.test(links.twitter_screen_name)) {
      result.twitter = `https://x.com/${links.twitter_screen_name}`;
    }

    // Telegram (validate identifier to prevent URL injection)
    if (typeof links.telegram_channel_identifier === 'string' && links.telegram_channel_identifier
        && /^[a-zA-Z0-9_]{1,100}$/.test(links.telegram_channel_identifier)) {
      result.telegram = `https://t.me/${links.telegram_channel_identifier}`;
    }

    // Discord — check chat_url array for discord links
    if (Array.isArray(links.chat_url)) {
      const discord = links.chat_url.find(u => typeof u === 'string' && (u.includes('discord.gg') || u.includes('discord.com')));
      if (discord) result.discord = discord;
    }

    const data = Object.keys(result).length > 0 ? result : null;
    coinSocialCache.set(coingeckoId, { data, expiry: Date.now() + COIN_SOCIAL_CACHE_TTL });
    return data;
  } catch (error) {
    console.error('[GeckoTerminal] getCoinSocialLinks error:', error.message);
    // Cache errors for 1 hour to avoid hammering the API
    coinSocialCache.set(coingeckoId, { data: null, expiry: Date.now() + 60 * 60 * 1000 });
    return null;
  }
}

/**
 * Fetch historical holder count chart for a token.
 * Requires CoinGecko paid plan (Analyst or above).
 * @param {string} mintAddress - Solana token mint address
 * @param {'7'|'30'|'max'} days - Timeframe: '30' = daily for 30d, 'max' = weekly going further back
 * @returns {Promise<Array<[number, number]>>} Array of [timestamp_ms, holder_count] pairs, oldest first
 */
async function getTokenHoldersChart(mintAddress, days = '30') {
  if (!COINGECKO_API_KEY) {
    throw new Error('getTokenHoldersChart requires a CoinGecko Pro API key');
  }
  return geckoRequest(
    () => geckoAxios.get(`/networks/${NETWORK}/tokens/${mintAddress}/holders_chart`, {
      params: { days }
    }).then(res => {
      const list = res.data?.data?.attributes?.token_holders_list;
      if (!Array.isArray(list)) return [];
      return list; // [[timestamp_ms, holder_count], ...]
    }),
    `getTokenHoldersChart(${mintAddress}, days=${days})`
  );
}

function stopCleanup() { clearInterval(_cacheCleanupTimer); clearInterval(_inFlightSweepTimer); }

module.exports = {
  getTokenInfo,
  getTokenPrice,
  getMultiTokenInfo,
  getMultiPoolInfo,
  getTokenOverview,
  getMarketData,
  getTrendingTokens,
  getNewTokens,
  getDexPools,
  getNewPoolsByDex,
  searchTokens,
  getOHLCV,
  ohlcvTimeframe,
  poolSideForMint,
  OHLCV_TIMEFRAMES,
  getPriceHistory,
  getTokenPools,
  getCoinSocialLinks,
  getTokenHoldersChart,
  retryAfterMs,
  stopCleanup
};
