const axios = require('axios');
const { rateLimitedRequest, sleep } = require('./rateLimiter');
const { circuitBreakers } = require('./circuitBreaker');
const { httpsAgent } = require('./httpAgent');
const { cache: redisCache, TTL } = require('./cache');

// GeckoTerminal / CoinGecko Onchain API
// Free tier: https://api.geckoterminal.com/api/v2 (30 req/min, no key)
// Paid tier: https://pro-api.coingecko.com/api/v3/onchain (higher limits, key required)
const COINGECKO_API_KEY = process.env.COINGECKO_API_KEY || '';
const GECKO_API = COINGECKO_API_KEY
  ? 'https://pro-api.coingecko.com/api/v3/onchain'
  : 'https://api.geckoterminal.com/api/v2';
const NETWORK = 'solana';

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
  console.log('[GeckoTerminal] Using free GeckoTerminal API (30 req/min)');
}

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

// Retry configuration for 429 errors
const RETRY_CONFIG = {
  maxRetries: 3,
  baseDelay: 5000,      // 5 seconds initial delay
  maxDelay: 30000,      // 30 seconds max delay
  backoffMultiplier: 2  // Exponential backoff
};

/**
 * Execute request with retry logic for 429 (rate limit) errors
 * Uses exponential backoff with jitter
 */
async function withRetry(requestFn, context = 'request') {
  let lastError;

  for (let attempt = 0; attempt <= RETRY_CONFIG.maxRetries; attempt++) {
    try {
      return await requestFn();
    } catch (error) {
      lastError = error;

      // Only retry on 429 (rate limit) errors
      if (error.response?.status !== 429) {
        throw error;
      }

      if (attempt === RETRY_CONFIG.maxRetries) {
        console.error(`[GeckoTerminal] ${context}: Max retries (${RETRY_CONFIG.maxRetries}) exceeded for 429 error`);
        throw error;
      }

      // Calculate delay with exponential backoff and jitter
      const baseDelay = RETRY_CONFIG.baseDelay * Math.pow(RETRY_CONFIG.backoffMultiplier, attempt);
      const jitter = Math.random() * 1000; // 0-1s jitter
      const delay = Math.min(baseDelay + jitter, RETRY_CONFIG.maxDelay);

      console.log(`[GeckoTerminal] ${context}: Rate limited (429), retry ${attempt + 1}/${RETRY_CONFIG.maxRetries} after ${Math.round(delay)}ms`);
      await sleep(delay);
    }
  }

  throw lastError;
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
 * Free tier: 30 requests/minute
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
  console.log(`[GeckoTerminal] getTokenInfo: ${mintAddress}`);

  // Check error cache first
  const errorCacheKey = `token:${mintAddress}`;
  const cachedError = errorCache.get(errorCacheKey);
  if (cachedError && Date.now() < cachedError.expiry) {
    console.log(`[GeckoTerminal] Returning cached null for ${mintAddress} (error cached)`);
    return null;
  }

  try {
    const response = await deduplicatedRequest(`token:${mintAddress}`, () =>
      geckoAxios.get(`/networks/${NETWORK}/tokens/${mintAddress}`)
    );

    const token = response.data.data;
    if (!token) {
      console.log('[GeckoTerminal] No token data returned');
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
      logoUri: attrs.image_url || null,
      logoURI: attrs.image_url || null,
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
async function getMultiTokenInfo(addresses) {
  if (!addresses || addresses.length === 0) {
    return {};
  }

  console.log(`[GeckoTerminal] getMultiTokenInfo: fetching ${addresses.length} tokens`);

  try {
    // GeckoTerminal accepts comma-separated addresses (max ~30 per request)
    const addressList = addresses.slice(0, 30).join(',');

    const response = await geckoRequest(() =>
      geckoAxios.get(`/networks/${NETWORK}/tokens/multi/${addressList}`),
      'getMultiTokenInfo'
    );

    const tokens = response.data.data || [];
    console.log(`[GeckoTerminal] multi token response: ${tokens.length} tokens`);

    const result = {};
    for (const token of tokens) {
      const attrs = token.attributes || {};
      const address = attrs.address;
      if (address) {
        const safeFloat = (v) => { const n = parseFloat(v); return isNaN(n) ? null : n; };
        result[address] = {
          price: attrs.price_usd != null ? safeFloat(attrs.price_usd) : null,
          volume24h: attrs.volume_usd?.h24 != null ? safeFloat(attrs.volume_usd.h24) : null,
          priceChange24h: attrs.price_change_percentage?.h24 != null ? safeFloat(attrs.price_change_percentage.h24) : null,
          marketCap: attrs.market_cap_usd != null ? safeFloat(attrs.market_cap_usd) : null,
          fdv: attrs.fdv_usd != null ? safeFloat(attrs.fdv_usd) : null,
          name: attrs.name,
          symbol: attrs.symbol,
          decimals: attrs.decimals,
          logoUri: attrs.image_url
        };
      }
    }

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

  console.log(`[GeckoTerminal] getMultiPoolInfo: fetching ${poolAddresses.length} pools`);

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

      // Extract the base token address from relationships
      const baseTokenId = pool.relationships?.base_token?.data?.id || '';
      const tokenAddress = baseTokenId.replace('solana_', '');
      if (!tokenAddress) continue;

      result[poolAddr] = {
        tokenAddress,
        poolCreatedAt: attrs.pool_created_at || null,
        price: safeFloat(attrs.base_token_price_usd),
        priceChange24h: safeFloat(attrs.price_change_percentage?.h24),
        volume24h: safeFloat(attrs.volume_usd?.h24),
        liquidity: safeFloat(attrs.reserve_in_usd),
        fdv: safeFloat(attrs.fdv_usd),
        marketCap: safeFloat(attrs.market_cap_usd)
      };
    }

    console.log(`[GeckoTerminal] multi pool response: ${Object.keys(result).length} pools`);
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
    const poolsResponse = await deduplicatedRequest(`pools:${mintAddress}`, () =>
      geckoAxios.get(`/networks/${NETWORK}/tokens/${mintAddress}/pools`, {
        params: { page: 1 }
      })
    );

    const pools = poolsResponse.data.data || [];

    if (pools.length === 0) {
      // No pools found - try token endpoint as fallback
      console.log(`[GeckoTerminal] No pools found for ${mintAddress}, trying token endpoint`);
      const tokenInfo = await getTokenInfo(mintAddress);
      if (!tokenInfo) {
        // Cache the null response
        errorCache.set(errorCacheKey, { expiry: Date.now() + ERROR_CACHE_TTL });
      }
      return tokenInfo;
    }

    // Extract data from the top pool (most liquid)
    const topPool = pools[0].attributes || {};
    const priceChange24h = parseFloat(topPool.price_change_percentage?.h24) || 0;
    const liquidity = parseFloat(topPool.reserve_in_usd) || 0;
    const volume24h = parseFloat(topPool.volume_usd?.h24) || 0;
    const price = parseFloat(topPool.base_token_price_usd) || 0;
    const fdv = parseFloat(topPool.fdv_usd) || 0;
    const marketCap = parseFloat(topPool.market_cap_usd) || fdv;

    // Extract token info from pool relationships
    const baseTokenId = pools[0].relationships?.base_token?.data?.id || '';
    const tokenAddress = baseTokenId.replace('solana_', '') || mintAddress;

    // Parse pool name for symbol (format: "TOKEN / SOL")
    const poolName = topPool.name || '';
    const symbol = poolName.split(' / ')[0] || null;

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
      pairCreatedAt: topPool.pool_created_at || null,
      dexIds
    };
    // Cache for 2 minutes (price data needs reasonable freshness)
    await redisCache.set(overviewCacheKey, overviewResult, TTL.OHLCV || 120000);
    return overviewResult;
  } catch (error) {
    console.error('[GeckoTerminal] getTokenOverview error:', error.message);
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
  console.log(`[GeckoTerminal] getMarketData: ${mintAddress}`);

  try {
    // Only fetch token info - pools data is included in price change from token endpoint
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

  console.log(`[GeckoTerminal] getTrendingTokens: limit=${limit}, page=${page}, skipEnrichment=${skipEnrichment}`);

  try {
    const response = await geckoRequest(() =>
      geckoAxios.get(`/networks/${NETWORK}/trending_pools`, {
        params: { page }
      }),
      'getTrendingTokens'
    );

    const pools = response.data.data || [];
    console.log(`[GeckoTerminal] Trending pools returned: ${pools.length}`);

    if (pools.length === 0) {
      return [];
    }

    // Extract unique base tokens from pools
    const seenAddresses = new Set();
    const tokens = [];

    for (const pool of pools) {
      if (tokens.length >= limit) break;

      const attrs = pool.attributes || {};
      const baseTokenId = pool.relationships?.base_token?.data?.id;

      // Extract address from ID (format: "solana_ADDRESS")
      const baseAddress = baseTokenId ? baseTokenId.replace('solana_', '') : null;

      if (!baseAddress || seenAddresses.has(baseAddress)) continue;

      // Skip if base token is SOL or USDC (we want the other token in the pair)
      if (baseAddress === 'So11111111111111111111111111111111111111112' ||
          baseAddress === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') {
        continue;
      }

      seenAddresses.add(baseAddress);

      // Parse pool name to get token info (format: "TOKEN / SOL")
      const poolName = attrs.name || '';
      const tokenSymbol = poolName.split(' / ')[0] || null;

      tokens.push({
        mintAddress: baseAddress,
        address: baseAddress,
        name: tokenSymbol, // Will be enriched by caller via Helius
        symbol: tokenSymbol,
        decimals: 9,
        logoUri: null, // Will be enriched by caller via Helius
        logoURI: null,
        price: parseFloat(attrs.base_token_price_usd) || 0,
        priceChange24h: parseFloat(attrs.price_change_percentage?.h24) || 0,
        volume24h: parseFloat(attrs.volume_usd?.h24) || 0,
        liquidity: parseFloat(attrs.reserve_in_usd) || 0,
        marketCap: parseFloat(attrs.market_cap_usd) || parseFloat(attrs.fdv_usd) || 0,
        fdv: parseFloat(attrs.fdv_usd) || 0,
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
          // Use token-level market cap if available
          if (info.marketCap) token.marketCap = info.marketCap;
        }
      }
    }

    console.log(`[GeckoTerminal] Returning ${tokens.length} trending tokens`);

    // Log sample token
    if (tokens.length > 0) {
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
  console.log(`[GeckoTerminal] getNewTokens: limit=${limit}, page=${page}, skipEnrichment=${skipEnrichment}`);

  try {
    const response = await geckoRequest(() =>
      geckoAxios.get(`/networks/${NETWORK}/new_pools`, {
        params: { page }
      }),
      'getNewTokens'
    );

    const pools = response.data.data || [];
    console.log(`[GeckoTerminal] New pools returned: ${pools.length}`);

    if (pools.length === 0) {
      return [];
    }

    // Extract unique base tokens from pools
    const seenAddresses = new Set();
    const tokens = [];

    for (const pool of pools) {
      if (tokens.length >= limit) break;

      const attrs = pool.attributes || {};
      const baseTokenId = pool.relationships?.base_token?.data?.id;
      const baseAddress = baseTokenId ? baseTokenId.replace('solana_', '') : null;

      if (!baseAddress || seenAddresses.has(baseAddress)) continue;

      // Skip SOL and USDC
      if (baseAddress === 'So11111111111111111111111111111111111111112' ||
          baseAddress === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') {
        continue;
      }

      seenAddresses.add(baseAddress);

      const poolName = attrs.name || '';
      const tokenSymbol = poolName.split(' / ')[0] || null;

      tokens.push({
        mintAddress: baseAddress,
        address: baseAddress,
        name: tokenSymbol,
        symbol: tokenSymbol,
        decimals: 9,
        logoUri: null,
        logoURI: null,
        price: parseFloat(attrs.base_token_price_usd) || 0,
        priceChange24h: parseFloat(attrs.price_change_percentage?.h24) || 0,
        volume24h: parseFloat(attrs.volume_usd?.h24) || 0,
        liquidity: parseFloat(attrs.reserve_in_usd) || 0,
        marketCap: parseFloat(attrs.market_cap_usd) || parseFloat(attrs.fdv_usd) || 0,
        fdv: parseFloat(attrs.fdv_usd) || 0,
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
        }
      }
    }

    console.log(`[GeckoTerminal] Returning ${tokens.length} new tokens`);
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
  console.log(`[GeckoTerminal] searchTokens: query="${query}", limit=${limit}, dexFilter=${allowedDexPrefixes ? allowedDexPrefixes.join(',') : 'none'}`);

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
    console.log(`[GeckoTerminal] Search returned ${pools.length} pools`);

    if (pools.length === 0) {
      return [];
    }

    // Extract unique tokens from search results
    const seenAddresses = new Set();
    const tokens = [];

    for (const pool of pools) {
      if (tokens.length >= limit) break;

      const attrs = pool.attributes || {};
      const baseTokenId = pool.relationships?.base_token?.data?.id;
      const baseAddress = baseTokenId ? baseTokenId.replace('solana_', '') : null;

      if (!baseAddress || seenAddresses.has(baseAddress)) continue;

      // Filter by DEX if allowedDexPrefixes is provided
      if (allowedDexPrefixes) {
        const dexId = (pool.relationships?.dex?.data?.id || '').toLowerCase();
        const matchesDex = allowedDexPrefixes.some(prefix => dexId.startsWith(prefix));
        if (!matchesDex) continue;
      }

      seenAddresses.add(baseAddress);

      const poolName = attrs.name || '';
      const tokenSymbol = poolName.split(' / ')[0] || null;

      tokens.push({
        mintAddress: baseAddress,
        address: baseAddress,
        name: tokenSymbol,
        symbol: tokenSymbol,
        decimals: 9,
        logoUri: null,
        logoURI: null,
        price: parseFloat(attrs.base_token_price_usd) || 0,
        priceChange24h: parseFloat(attrs.price_change_percentage?.h24) || 0,
        volume24h: parseFloat(attrs.volume_usd?.h24) || 0,
        liquidity: parseFloat(attrs.reserve_in_usd) || 0,
        marketCap: parseFloat(attrs.market_cap_usd) || parseFloat(attrs.fdv_usd) || 0,
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

/**
 * Get OHLCV data for a token
 * First finds the top pool for the token, then fetches OHLCV
 * Endpoint: /networks/{network}/pools/{pool}/ohlcv/{timeframe}
 * Optimized: caches pool address to avoid repeated pool lookups
 */
async function getOHLCV(mintAddress, options = {}) {
  const { interval = '1h' } = options;

  console.log(`[GeckoTerminal] getOHLCV: ${mintAddress}, interval=${interval}`);

  try {
    // Check pool address cache first
    let poolAddress = null;
    const cached = poolAddressCache.get(mintAddress);
    if (cached && Date.now() < cached.expiry) {
      poolAddress = cached.address;
      console.log(`[GeckoTerminal] Using cached pool address for ${mintAddress}`);
    }

    // If not cached, fetch pools
    if (!poolAddress) {
      const poolsResponse = await deduplicatedRequest(`pools:${mintAddress}`, () =>
        geckoAxios.get(`/networks/${NETWORK}/tokens/${mintAddress}/pools`, {
          params: { page: 1 }
        })
      );

      const pools = poolsResponse.data.data || [];
      if (pools.length === 0) {
        console.log('[GeckoTerminal] No pools found for token');
        return { mintAddress, interval, data: [] };
      }

      // Use the first (most liquid) pool
      poolAddress = pools[0].attributes?.address;
      if (!poolAddress) {
        return { mintAddress, interval, data: [] };
      }

      // Cache the pool address
      poolAddressCache.set(mintAddress, {
        address: poolAddress,
        expiry: Date.now() + POOL_CACHE_TTL
      });
    }

    // Map interval to GeckoTerminal timeframe
    // GeckoTerminal supports: minute, hour, day
    let timeframe = 'hour';
    let aggregate = 1;

    if (interval.includes('m')) {
      timeframe = 'minute';
      aggregate = parseInt(interval) || 1;
    } else if (interval.includes('h')) {
      timeframe = 'hour';
      aggregate = parseInt(interval) || 1;
    } else if (interval.includes('d') || interval.includes('D')) {
      timeframe = 'day';
      aggregate = parseInt(interval) || 1;
    } else if (interval.includes('w') || interval.includes('W')) {
      timeframe = 'day';
      aggregate = 7;
    }

    const ohlcvResponse = await geckoRequest(() =>
      geckoAxios.get(`/networks/${NETWORK}/pools/${poolAddress}/ohlcv/${timeframe}`, {
        params: {
          aggregate: aggregate,
          limit: 100,
          currency: 'usd',
          token: 'base'
        }
      }),
      'getOHLCV'
    );

    const ohlcvList = ohlcvResponse.data.data?.attributes?.ohlcv_list || [];

    // Transform to standard format
    // GeckoTerminal format: [timestamp, open, high, low, close, volume]
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

  console.log(`[GeckoTerminal] getPriceHistory: ${mintAddress}, interval=${interval}`);

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

  console.log(`[GeckoTerminal] getTokenPools: ${mintAddress}, limit=${limit}`);

  try {
    const response = await geckoRequest(() =>
      geckoAxios.get(`/networks/${NETWORK}/tokens/${mintAddress}/pools`, {
        params: { page: 1 }
      }),
      'getTokenPools'
    );

    const pools = response.data.data || [];
    console.log(`[GeckoTerminal] Found ${pools.length} pools for token`);

    return pools.slice(0, limit).map(pool => {
      const attrs = pool.attributes || {};
      const baseTokenId = pool.relationships?.base_token?.data?.id || '';
      const quoteTokenId = pool.relationships?.quote_token?.data?.id || '';
      const dexId = pool.relationships?.dex?.data?.id || '';

      // Parse pool name to get symbols (format: "TOKEN_A / TOKEN_B")
      const poolName = attrs.name || '';
      const [symbolA, symbolB] = poolName.split(' / ').map(s => s.trim());

      // Format DEX name nicely
      const dexName = dexId.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

      return {
        address: attrs.address,
        name: attrs.name,
        // Frontend-expected fields
        symbolA: symbolA || '?',
        symbolB: symbolB || '?',
        type: dexName || 'AMM',
        tvl: parseFloat(attrs.reserve_in_usd) || 0,
        apr24h: null, // GeckoTerminal doesn't provide APR
        // Additional data
        dex: dexId,
        baseToken: baseTokenId.replace('solana_', ''),
        quoteToken: quoteTokenId.replace('solana_', ''),
        priceUsd: parseFloat(attrs.base_token_price_usd) || 0,
        priceChange24h: parseFloat(attrs.price_change_percentage?.h24) || 0,
        volume24h: parseFloat(attrs.volume_usd?.h24) || 0,
        liquidity: parseFloat(attrs.reserve_in_usd) || 0,
        txns24h: {
          buys: attrs.transactions?.h24?.buys || 0,
          sells: attrs.transactions?.h24?.sells || 0
        },
        createdAt: attrs.pool_created_at
      };
    });
  } catch (error) {
    console.error('[GeckoTerminal] getTokenPools error:', error.message);
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
      const baseTokenId = pool.relationships?.base_token?.data?.id;

      return {
        baseAddress: baseTokenId ? baseTokenId.replace('solana_', '') : null,
        poolAddress: attrs.address || null,
        name: attrs.name || '',
        createdAt: attrs.pool_created_at || null,
        price: parseFloat(attrs.base_token_price_usd) || 0,
        priceChange24h: parseFloat(attrs.price_change_percentage?.h24) || 0,
        volume24h: parseFloat(attrs.volume_usd?.h24) || 0,
        liquidity: parseFloat(attrs.reserve_in_usd) || 0,
        marketCap: parseFloat(attrs.market_cap_usd) || parseFloat(attrs.fdv_usd) || 0,
        fdv: parseFloat(attrs.fdv_usd) || 0
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

      const baseTokenId = pool.relationships?.base_token?.data?.id;

      filtered.push({
        baseAddress: baseTokenId ? baseTokenId.replace('solana_', '') : null,
        poolAddress: attrs.address || null,
        name: attrs.name || '',
        createdAt: poolCreatedAt || null,
        price: parseFloat(attrs.base_token_price_usd) || 0,
        priceChange24h: parseFloat(attrs.price_change_percentage?.h24) || 0,
        volume24h: parseFloat(attrs.volume_usd?.h24) || 0,
        liquidity: parseFloat(attrs.reserve_in_usd) || 0,
        marketCap: parseFloat(attrs.market_cap_usd) || parseFloat(attrs.fdv_usd) || 0,
        fdv: parseFloat(attrs.fdv_usd) || 0
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
  getPriceHistory,
  getTokenPools,
  getCoinSocialLinks,
  stopCleanup
};
