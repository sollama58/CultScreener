const axios = require('axios');
const { normalizeLogoUri } = require('./tokenImage');
const { httpsAgent } = require('./httpAgent');
const { circuitBreakers } = require('./circuitBreaker');
const { rateLimitedRequest } = require('./rateLimiter');
const { cache, TTL } = require('./cache');

// RPC endpoint configuration with failover
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;

// Helius standard RPC requires the API key in the URL (not as a header).
// The x-api-key header only works for Helius REST/DAS APIs, not for
// JSON-RPC calls proxied to Solana validators.
// Note: the api-key query param appears in error logs when the full RPC URL
// is logged. Use log filtering or the Authorization header form if key
// exposure in logs is a concern for your threat model.
const RPC_ENDPOINTS = [
  // Primary: Helius with key in URL (if configured)
  HELIUS_API_KEY && `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`,
  // Secondary: Custom Helius RPC URL (may already contain the key)
  process.env.HELIUS_RPC_URL,
  // Tertiary: Public Solana RPC (rate limited but always available)
  'https://api.mainnet-beta.solana.com'
].filter(Boolean);

// Remove duplicates (e.g. if HELIUS_RPC_URL is the same as the primary)
function dedupeEndpoints(urls) {
  const seen = new Set();
  return urls.filter(url => {
    const base = url.split('?')[0];
    if (seen.has(base)) return false;
    seen.add(base);
    return true;
  });
}
const deduped = dedupeEndpoints(RPC_ENDPOINTS);
RPC_ENDPOINTS.length = 0;
RPC_ENDPOINTS.push(...deduped);

const RPC_FAILOVER_COOLDOWN_MS = 60000; // 1 minute before trying failed endpoint again

// Every JSON-RPC call goes to Helius; the public RPC is only an outage failover.
const rpcChains = {
  helius: { name: 'helius', endpoints: RPC_ENDPOINTS, index: 0, lastFailure: null },
};

// Get current RPC URL with failover logic
function getCurrentRpcUrl(chain = rpcChains.helius) {
  // If primary has been failing, check if cooldown has passed
  if (chain.index > 0 && chain.lastFailure) {
    const elapsed = Date.now() - chain.lastFailure;
    if (elapsed > RPC_FAILOVER_COOLDOWN_MS) {
      // Try to recover to primary
      chain.index = 0;
      chain.lastFailure = null;
      console.log(`[Solana] Attempting to recover to primary ${chain.name} RPC endpoint`);
    }
  }
  return chain.endpoints[chain.index] || chain.endpoints[0];
}

// Failover to next RPC endpoint
function failoverToNextRpc(chain = rpcChains.helius) {
  if (chain.index < chain.endpoints.length - 1) {
    chain.index++;
    chain.lastFailure = Date.now();
    console.log(`[Solana] Failing over ${chain.name} RPC to endpoint ${chain.index + 1}/${chain.endpoints.length}`);
    return true;
  }
  return false;
}

// ── Helius credit accounting ─────────────────────────────────────────────────
// Helius bills per call: 1 credit for standard RPC, 10 for DAS, getProgramAccounts
// and getTransactionsForAddress, 100 for the legacy Enhanced Transactions API.
// Counted per method, flushed to the cache every few seconds under a per-UTC-day
// key, and shown on /health/detailed so credit spend can be watched without the
// Helius dashboard.
const DAS_CREDITS = 10;
const ENHANCED_CREDITS = 100;
const RPC_METHOD_CREDITS = { getProgramAccounts: 10, getTransactionsForAddress: 10 };
const CREDIT_KEY_TTL = 3 * 24 * 3600000;
const creditBuffer = new Map();          // method → credits not yet flushed
const creditTotals = new Map();          // method → credits since process start
let creditsSinceStart = 0;

function countCredits(method, credits) {
  creditBuffer.set(method, (creditBuffer.get(method) || 0) + credits);
  creditTotals.set(method, (creditTotals.get(method) || 0) + credits);
  creditsSinceStart += credits;
}

function creditDay(offsetDays = 0) {
  return new Date(Date.now() - offsetDays * 86400000).toISOString().slice(0, 10);
}

async function flushCredits() {
  if (creditBuffer.size === 0) return;
  const entries = [...creditBuffer.entries()];
  creditBuffer.clear();
  const day = creditDay();
  let total = 0;
  for (const [method, credits] of entries) {
    total += credits;
    await cache.incrBy(`helius-credits:${day}:${method}`, credits, CREDIT_KEY_TTL).catch(() => {});
  }
  await cache.incrBy(`helius-credits:${day}`, total, CREDIT_KEY_TTL).catch(() => {});
}
const creditFlushTimer = setInterval(() => { flushCredits().catch(() => {}); }, 10000);
if (creditFlushTimer.unref) creditFlushTimer.unref();

/** Credit spend for today and yesterday (all processes, via the shared cache) plus this process. */
async function getCreditUsage() {
  await flushCredits().catch(() => {});
  const today = creditDay();
  const yesterday = creditDay(1);
  const byMethod = {};
  try {
    for (const key of await cache.scanKeys(`helius-credits:${today}:*`)) {
      const method = key.slice(`helius-credits:${today}:`.length);
      byMethod[method] = Number(await cache.get(key)) || 0;
    }
  } catch (_) {}
  return {
    today: { date: today, credits: Number(await cache.get(`helius-credits:${today}`).catch(() => 0)) || 0, byMethod },
    yesterday: { date: yesterday, credits: Number(await cache.get(`helius-credits:${yesterday}`).catch(() => 0)) || 0 },
    thisProcess: { credits: creditsSinceStart, byMethod: Object.fromEntries(creditTotals) },
  };
}

// Legacy export for backwards compatibility
const RPC_URL = RPC_ENDPOINTS[0];

// Helius DAS API (Digital Asset Standard) — uses x-api-key header for auth
// This is separate from standard Solana RPC which requires key in the URL
const HELIUS_HEADERS = HELIUS_API_KEY ? { 'x-api-key': HELIUS_API_KEY } : {};
const HELIUS_DAS_URL = HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}` : null;

// 429 retry configuration for RPC and Helius DAS calls
const RPC_RETRY_CONFIG = {
  maxRetries: 3,
  baseDelay: 2000,       // 2s initial delay (faster than GeckoTerminal since RPC is critical path)
  maxDelay: 15000,       // 15s max delay
  backoffMultiplier: 2   // Exponential backoff: 2s → 4s → 8s
};

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// Validate social identifiers before constructing URLs to prevent injection
const SAFE_SOCIAL_ID = /^[a-zA-Z0-9_]{1,100}$/;
function safeSocialUrl(platform, value) {
  if (!value || typeof value !== 'string') return null;
  // If already a full URL, return as-is (caller trusts https:// prefix)
  if (value.startsWith('http')) return value;
  const cleaned = value.replace(/^@/, '');
  if (!SAFE_SOCIAL_ID.test(cleaned)) return null;
  switch (platform) {
    case 'twitter': return `https://x.com/${cleaned}`;
    case 'telegram': return `https://t.me/${cleaned}`;
    case 'discord': return `https://discord.gg/${cleaned}`;
    default: return null;
  }
}

/**
 * Wrap a request function with 429 retry + exponential backoff.
 * Non-429 errors are thrown immediately.
 *
 * IMPORTANT: The requestFn typically calls rateLimitedRequest() which queues the
 * request. On 429 retry, we sleep BEFORE re-entering the queue so the backoff
 * actually reduces pressure rather than just re-queuing immediately.
 */
async function withRpcRetry(requestFn, context = 'rpc') {
  let lastError;
  for (let attempt = 0; attempt <= RPC_RETRY_CONFIG.maxRetries; attempt++) {
    try {
      return await requestFn();
    } catch (error) {
      lastError = error;
      // Handle both axios 429 responses and queue overload errors
      const is429 = error.response?.status === 429;
      const isOverloaded = error.isOverloaded;
      if (!is429 && !isOverloaded) throw error;
      // For 429s, only retry once — fail fast so callers can use their DAS fallback
      // rather than blocking for 21+ seconds across 3 retries.
      const maxRetries = is429 ? 1 : RPC_RETRY_CONFIG.maxRetries;
      if (attempt === maxRetries) {
        console.error(`[Solana] ${context}: Max retries (${maxRetries}) exceeded for ${is429 ? '429' : 'queue overload'}`);
        throw error;
      }
      const baseDelay = RPC_RETRY_CONFIG.baseDelay * Math.pow(RPC_RETRY_CONFIG.backoffMultiplier, attempt);
      const jitter = Math.random() * 1500;
      const delay = Math.min(baseDelay + jitter, RPC_RETRY_CONFIG.maxDelay);
      console.log(`[Solana] ${context}: Rate limited (${is429 ? '429' : 'queue'}), retry ${attempt + 1}/${maxRetries} after ${Math.round(delay)}ms`);
      await sleep(delay);
    }
  }
  throw lastError;
}

// Make RPC call with circuit breaker, failover, retry, and 429 backoff
async function rpcCall(method, params = [], retryCount = 0) {
  const MAX_RETRIES = 2;
  const chain = rpcChains.helius;

  try {
    // Pick rate limiter key: use 'helius' when talking to a Helius endpoint so all
    // Helius traffic (RPC + DAS) shares one queue and respects a single rate limit.
    const rpcUrl = getCurrentRpcUrl(chain);
    const isHelius = rpcUrl.includes('helius');
    const rateLimiterKey = isHelius ? 'helius' : 'solana';

    return await withRpcRetry(() => rateLimitedRequest(rateLimiterKey, () => circuitBreakers.solanaRpc.execute(async () => {

      try {
        if (isHelius) countCredits(method, RPC_METHOD_CREDITS[method] || 1);
        const response = await axios.post(rpcUrl, {
          jsonrpc: '2.0',
          id: 1,
          method,
          params
        }, {
          timeout: 15000, // 15 second timeout (reduced from 30s for faster failover)
          httpsAgent
        });

        // Defensive check for malformed responses
        if (!response || !response.data) {
          throw new Error('Empty or malformed RPC response');
        }

        if (response.data.error) {
          const errorMsg = response.data.error.message || response.data.error.code || 'Unknown RPC error';
          const rpcError = new Error(errorMsg);
          rpcError.rpcCode = response.data.error.code;
          throw rpcError;
        }

        return response.data.result;
      } catch (error) {
        // Log error for debugging
        if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
          console.error(`[Solana] RPC timeout (${method}): Request timed out`);
        } else if (error.response) {
          console.error(`[Solana] RPC error (${method}): HTTP ${error.response.status}`);
        } else if (error.request) {
          console.error(`[Solana] RPC error (${method}): No response received`);
        }

        throw error;
      }
    })), method);
  } catch (error) {
    // Handle connection errors with failover OUTSIDE circuit breaker
    // to prevent double-counting failures on retry
    const isConnectionError =
      error.code === 'ECONNABORTED' ||
      error.code === 'ETIMEDOUT' ||
      error.code === 'ECONNRESET' ||
      error.code === 'ECONNREFUSED' ||
      !error.response;

    // Rate limited even after withRpcRetry's own retry: try the next endpoint.
    const isRateLimited = error.response?.status === 429;
    if ((isConnectionError || isRateLimited) && retryCount < MAX_RETRIES) {
      if (failoverToNextRpc(chain)) {
        console.log(`[Solana] Retrying ${method} with failover endpoint (attempt ${retryCount + 1})`);
        return rpcCall(method, params, retryCount + 1);
      }
    }

    throw error;
  }
}

// Get account info
async function getAccountInfo(address) {
  return rpcCall('getAccountInfo', [
    address,
    { encoding: 'jsonParsed' }
  ]);
}

// Get token account balance
async function getTokenAccountBalance(tokenAccount) {
  return rpcCall('getTokenAccountBalance', [tokenAccount]);
}

// Get token supply
async function getTokenSupply(mintAddress) {
  return rpcCall('getTokenSupply', [mintAddress]);
}

// Get multiple accounts
async function getMultipleAccounts(addresses) {
  return rpcCall('getMultipleAccounts', [
    addresses,
    { encoding: 'jsonParsed' }
  ]);
}

// Get token accounts by owner
async function getTokenAccountsByOwner(ownerAddress, mintAddress = null) {
  const filter = mintAddress
    ? { mint: mintAddress }
    : { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' };

  return rpcCall('getTokenAccountsByOwner', [
    ownerAddress,
    filter,
    { encoding: 'jsonParsed' }
  ]);
}

// Get recent blockhash
async function getRecentBlockhash() {
  return rpcCall('getLatestBlockhash');
}

// Send a signed raw transaction (base64-encoded)
async function sendRawTransaction(base64Tx) {
  return rpcCall('sendTransaction', [base64Tx, { encoding: 'base64', preflightCommitment: 'confirmed' }]);
}

// Get transaction (confirmed commitment — data available sooner than finalized)
async function getTransaction(signature) {
  return rpcCall('getTransaction', [
    signature,
    { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }
  ]);
}

// Get signatures for address
async function getSignaturesForAddress(address, limit = 10) {
  return rpcCall('getSignaturesForAddress', [
    address,
    { limit }
  ]);
}

// Health check with failover status
async function checkHealth() {
  try {
    const result = await rpcCall('getHealth');
    const chain = rpcChains.helius;
    const currentUrl = getCurrentRpcUrl(chain);
    return {
      healthy: result === 'ok',
      rpcUrl: currentUrl.split('?')[0], // Hide API key
      currentEndpoint: chain.index + 1,
      totalEndpoints: chain.endpoints.length,
      usingFallback: chain.index > 0,
      circuitBreakerState: circuitBreakers.solanaRpc.getStatus().state
    };
  } catch (error) {
    return {
      healthy: false,
      error: error.message,
      currentEndpoint: rpcChains.helius.index + 1,
      totalEndpoints: rpcChains.helius.endpoints.length,
      circuitBreakerState: circuitBreakers.solanaRpc.getStatus().state
    };
  }
}

/**
 * Get token holder count using Helius DAS API
 * Uses getTokenAccounts which returns total count of token accounts in response
 * Note: This returns token account count, not unique holders (one user can have multiple accounts)
 * For most tokens, this is a reasonable approximation of holder count
 * Requires HELIUS_API_KEY environment variable
 *
 * @param {string} mintAddress - Token mint address
 * @returns {Promise<number|null>} - Token account count (approximate holders) or null if unavailable
 */
/**
 * Get exact total holder count by paginating Helius DAS getTokenAccounts.
 * Each page returns up to 1000 accounts. We count across all pages to get
 * the true number. Cached for 24h so the cost is negligible (a 10k-holder
 * token = 10 DAS calls once per day).
 */
// In-flight dedup: if a paginating holder count fetch is already running for this
// mint, callers get the same Promise instead of launching a second identical scan.
const _holderCountInFlight = new Map();

// opts.maxPages  — cap pagination (default 100 = 100k holders). Pass 500 for curated daily job.
// opts.skipCache — bypass Redis read; used by record-holder-counts to always get a fresh count.
// Only caches when the count is exact (last page was partial, not a cap hit).
async function getTokenHolderCount(mintAddress, opts = {}) {
  if (!HELIUS_DAS_URL) return null;
  const { maxPages = 100, skipCache = false } = opts;

  if (!skipCache) {
    try {
      const cached = await cache.get(`holder-total:${mintAddress}`);
      if (cached && cached > 0) return cached;
    } catch (_) {}

    if (_holderCountInFlight.has(mintAddress)) {
      return _holderCountInFlight.get(mintAddress);
    }
  }

  const promise = _doGetTokenHolderCount(mintAddress, maxPages).then(async ({ count, isExact }) => {
    // Always cache — even capped counts prevent repeated expensive pagination.
    // skipCache=true (used by the daily job) bypasses this cache on the next read,
    // so capped values don't persist for curated tokens that need accurate counts.
    if (count && count > 0) {
      await cache.set(`holder-total:${mintAddress}`, count, TTL.HOLDER_COUNT).catch(() => {});
    }
    return count;
  }).finally(() => {
    if (!skipCache) _holderCountInFlight.delete(mintAddress);
  });

  if (!skipCache) _holderCountInFlight.set(mintAddress, promise);
  return promise;
}

// Returns { count, isExact }.
// isExact=false when we hit maxPages — used for logging; count is cached regardless.
async function _doGetTokenHolderCount(mintAddress, maxPages = 100) {
  try {
    return await circuitBreakers.heliusDas.execute(async () => {
      let totalCount = 0;
      let page = 1;
      let isExact = false;

      while (page <= maxPages) {
        countCredits('getTokenAccounts', DAS_CREDITS);
        const response = await rateLimitedRequest('helius', () =>
          axios.post(HELIUS_DAS_URL, {
            jsonrpc: '2.0',
            id: `holder-count-p${page}`,
            method: 'getTokenAccounts',
            params: {
              mint: mintAddress,
              page,
              limit: 1000,
              options: { showZeroBalance: false }
            }
          }, {
            timeout: 15000,
            headers: HELIUS_HEADERS,
            httpsAgent
          })
        );

        if (response.data.error) {
          console.warn(`[Solana] Holder count page ${page} error for ${mintAddress.slice(0, 8)}...: ${response.data.error.message || response.data.error.code} — returning partial count (${totalCount})`);
          break;
        }

        const accounts = response.data.result?.token_accounts;
        if (!accounts || accounts.length === 0) { isExact = true; break; }

        totalCount += accounts.length;

        if (accounts.length < 1000) { isExact = true; break; }
        page++;
      }

      if (totalCount > 0) {
        console.log(`[Solana] Helius holder count for ${mintAddress.slice(0, 8)}...: ${totalCount} (${page} pages${isExact ? '' : ', capped at maxPages'})`);
      }
      return { count: totalCount > 0 ? totalCount : null, isExact };
    }); // end circuitBreakers.heliusDas.execute
  } catch (error) {
    console.error('[Solana] Helius holder count error:', error.message);
    return { count: null, isExact: false };
  }
}

/**
 * Check if Helius API is configured
 */
function isHeliusConfigured() {
  return !!HELIUS_API_KEY;
}

/**
 * Get token metadata and price using Helius DAS API (getAsset)
 * More efficient than calling GeckoTerminal for basic info
 * Price is only available for top ~10k tokens by 24h volume
 *
 * @param {string} mintAddress - Token mint address
 * @returns {Promise<Object|null>} - Token info or null if unavailable
 */
async function getTokenMetadata(mintAddress) {
  if (!HELIUS_DAS_URL) {
    return null;
  }

  // Check cache first (1hr TTL — metadata rarely changes)
  const metaCacheKey = `helius-meta:${mintAddress}`;
  const cached = await cache.get(metaCacheKey);
  if (cached === 'NOT_FOUND') return null; // negative cache hit
  if (cached) return cached;

  try {
    // Fetching from Helius DAS (cache miss)

    countCredits('getAsset', DAS_CREDITS);
    const response = await withRpcRetry(() => rateLimitedRequest('helius', () =>
      axios.post(HELIUS_DAS_URL, {
        jsonrpc: '2.0',
        id: 'token-metadata',
        method: 'getAsset',
        params: {
          id: mintAddress,
          displayOptions: {
            showFungible: true
          }
        }
      }, {
        timeout: 10000,
        headers: HELIUS_HEADERS,
        httpsAgent
      })
    ), 'getTokenMetadata');

    if (response.data.error) {
      console.error('[Solana] Helius getAsset error:', response.data.error.message);
      await cache.set(metaCacheKey, 'NOT_FOUND', 300000); // 5-min negative cache
      return null;
    }

    const asset = response.data.result;
    if (!asset) {
      await cache.set(metaCacheKey, 'NOT_FOUND', 300000); // 5-min negative cache
      return null;
    }
    // The same getAsset answer carries the authorities; fill that cache too so
    // getTokenAuthorities never pays a second DAS call for the same mint.
    await cache.set(`token-auth:${mintAddress}`, { authorities: asset.authorities || [], creators: asset.creators || [] }, TTL.DAY).catch(() => {});

    const tokenInfo = asset.token_info || {};
    const content = asset.content || {};
    const metadata = content.metadata || {};

    // Extract price info if available (only for top 10k tokens)
    const priceInfo = tokenInfo.price_info || {};
    const price = priceInfo.price_per_token || null;

    // Extract logo URI from various possible locations in the response
    // Different tokens store their image in different places
    let logoUri = null;
    if (content.links?.image) {
      logoUri = content.links.image;
    } else if (content.files && content.files.length > 0) {
      // Look for image file in files array
      const imageFile = content.files.find(f =>
        f.mime?.startsWith('image/') ||
        f.uri?.match(/\.(png|jpg|jpeg|gif|webp|svg)(\?.*)?$/i)
      );
      logoUri = imageFile?.uri || content.files[0]?.uri || null;
    } else if (metadata.image) {
      logoUri = metadata.image;
    } else if (content.json_uri && content.json_uri.includes('image')) {
      // Some tokens store image URL in json_uri
      logoUri = content.json_uri;
    }

    // On-chain fallback links (content.links and metadata.extensions).
    // The primary source — off-chain JSON at json_uri — is fetched separately
    // via fetchOffchainLinks() so it can run in parallel with other work.
    const onchainLinks = {};
    try {
      if (typeof content.links?.external_url === 'string' && content.links.external_url) {
        onchainLinks.website = content.links.external_url;
      }
      const ext = metadata.extensions;
      if (ext && typeof ext === 'object') {
        const tw = safeSocialUrl('twitter', ext.twitter);
        if (tw) onchainLinks.twitter = tw;
        const tg = safeSocialUrl('telegram', ext.telegram);
        if (tg) onchainLinks.telegram = tg;
        const dc = safeSocialUrl('discord', ext.discord);
        if (dc) onchainLinks.discord = dc;
        if (!onchainLinks.website && typeof ext.website === 'string' && ext.website) {
          onchainLinks.website = ext.website.startsWith('http') ? ext.website : `https://${ext.website}`;
        }
      }
    } catch (e) {
      console.error('[Solana] onchainLinks extraction error:', e.message);
    }

    const result = {
      mintAddress: mintAddress,
      address: mintAddress,
      name: metadata.name || content.json_uri || null,
      symbol: tokenInfo.symbol || metadata.symbol || null,
      decimals: tokenInfo.decimals || 9,
      supply: tokenInfo.supply ? parseFloat(tokenInfo.supply) / Math.pow(10, tokenInfo.decimals || 9) : null,
      // Price only available for top 10k tokens by volume
      price: price,
      hasPriceData: price !== null,
      // Logo from content if available (checked multiple locations)
      logoUri: normalizeLogoUri(logoUri),
      // json_uri for off-chain metadata fetch (social links live here)
      jsonUri: (typeof content.json_uri === 'string' && content.json_uri) ? content.json_uri : null,
      // On-chain fallback links (extensions / content.links)
      onchainLinks: Object.keys(onchainLinks).length > 0 ? onchainLinks : null
    };

    // Debug: uncomment to trace metadata fetches
    // console.log(`[Solana] Token metadata for ${mintAddress}: ${result.name} (${result.symbol})`);

    // Cache for 1 hour (metadata rarely changes)
    await cache.set(metaCacheKey, result, TTL.HOUR);
    return result;
  } catch (error) {
    console.error('[Solana] getTokenMetadata error:', error.message);
    return null;
  }
}

/**
 * Fetch off-chain JSON metadata and extract social links.
 * Most Solana tokens (pump.fun, Metaplex standard) store twitter/telegram/
 * website/discord in the JSON file pointed to by json_uri.
 * Designed to run in parallel with other work — call this with the jsonUri
 * returned by getTokenMetadata().
 *
 * @param {string} jsonUri - URL to off-chain JSON metadata
 * @returns {Promise<Object|null>} - { twitter, telegram, website, discord } or null
 */
async function fetchOffchainLinks(jsonUri) {
  if (!jsonUri) return null;

  // SSRF protection: only allow https URLs and block private/internal IPs
  try {
    const parsed = new URL(jsonUri);
    if (parsed.protocol !== 'https:') return null;
    const host = parsed.hostname.toLowerCase();
    // Block private/internal ranges
    if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0'
      || host.startsWith('10.') || host.startsWith('192.168.')
      || host.startsWith('169.254.') || host.startsWith('172.')
      || host.endsWith('.internal') || host.endsWith('.local')) {
      return null;
    }
  } catch { return null; }

  try {
    const jsonRes = await axios.get(jsonUri, { timeout: 5000, httpsAgent });
    const offchain = jsonRes.data;
    if (!offchain || typeof offchain !== 'object') return null;

    const links = {};
    const tw = safeSocialUrl('twitter', offchain.twitter);
    if (tw) links.twitter = tw;
    const tg = safeSocialUrl('telegram', offchain.telegram);
    if (tg) links.telegram = tg;
    const dc = safeSocialUrl('discord', offchain.discord);
    if (dc) links.discord = dc;
    if (typeof offchain.website === 'string' && offchain.website) {
      links.website = offchain.website.startsWith('http') ? offchain.website : `https://${offchain.website}`;
    }
    if (!links.website && typeof offchain.external_url === 'string' && offchain.external_url) {
      links.website = offchain.external_url.startsWith('http') ? offchain.external_url : `https://${offchain.external_url}`;
    }

    return Object.keys(links).length > 0 ? links : null;
  } catch (err) {
    console.warn(`[Solana] Failed to fetch json_uri ${jsonUri}: ${err.message}`);
    return null;
  }
}

/**
 * Get multiple token metadata in batch using Helius DAS API
 * Supports up to 1000 tokens per request
 *
 * @param {string[]} mintAddresses - Array of token mint addresses
 * @returns {Promise<Object>} - Map of address -> token info
 */
async function getTokenMetadataBatch(mintAddresses) {
  if (!HELIUS_DAS_URL || !mintAddresses || mintAddresses.length === 0) {
    return {};
  }

  try {
    // Helius getAssetBatch supports up to 1000 assets
    // Filter out any null/undefined entries before sending — Helius rejects null IDs
    const addresses = mintAddresses.filter(Boolean).slice(0, 1000);
    if (addresses.length === 0) return {};
    console.log(`[Solana] Fetching batch token metadata for ${addresses.length} tokens`);

    countCredits('getAssetBatch', DAS_CREDITS);
    const response = await withRpcRetry(() => rateLimitedRequest('helius', () =>
      axios.post(HELIUS_DAS_URL, {
        jsonrpc: '2.0',
        id: 'token-metadata-batch',
        method: 'getAssetBatch',
        params: {
          ids: addresses,
          displayOptions: {
            showFungible: true
          }
        }
      }, {
        timeout: 15000,
        headers: HELIUS_HEADERS,
        httpsAgent
      })
    ), 'getTokenMetadataBatch');

    if (response.data.error) {
      console.error('[Solana] Helius getAssetBatch error:', response.data.error.message);
      return {};
    }

    const assets = response.data.result || [];
    const result = {};

    for (const asset of assets) {
      if (!asset || !asset.id) continue;

      const tokenInfo = asset.token_info || {};
      const content = asset.content || {};
      const metadata = content.metadata || {};
      const priceInfo = tokenInfo.price_info || {};

      // Extract logo URI from various possible locations
      let logoUri = null;
      if (content.links?.image) {
        logoUri = content.links.image;
      } else if (content.files && content.files.length > 0) {
        const imageFile = content.files.find(f =>
          f.mime?.startsWith('image/') ||
          f.uri?.match(/\.(png|jpg|jpeg|gif|webp|svg)(\?.*)?$/i)
        );
        logoUri = imageFile?.uri || content.files[0]?.uri || null;
      } else if (metadata.image) {
        logoUri = metadata.image;
      }

      result[asset.id] = {
        mintAddress: asset.id,
        address: asset.id,
        name: metadata.name || content.json_uri || null,
        symbol: tokenInfo.symbol || metadata.symbol || null,
        decimals: tokenInfo.decimals || 9,
        supply: tokenInfo.supply ? parseFloat(tokenInfo.supply) / Math.pow(10, tokenInfo.decimals || 9) : null,
        price: priceInfo.price_per_token || null,
        hasPriceData: !!priceInfo.price_per_token,
        logoUri: normalizeLogoUri(logoUri)
      };
    }

    console.log(`[Solana] Batch metadata returned ${Object.keys(result).length} tokens`);
    return result;
  } catch (error) {
    console.error('[Solana] getTokenMetadataBatch error:', error.message);
    return {};
  }
}

/**
 * Get the 20 largest token accounts for a mint using standard Solana RPC.
 * Returns accounts sorted by balance descending.
 *
 * @param {string} mintAddress - Token mint address
 * @returns {Promise<Array|null>} - Array of { address, amount, decimals, uiAmount } or null
 */
async function getTokenLargestAccounts(mintAddress) {
  try {
    const result = await rpcCall('getTokenLargestAccounts', [mintAddress]);
    if (!result || !result.value) return null;
    return result.value.map(a => ({
      address: a.address,
      amount: a.amount,
      decimals: a.decimals,
      uiAmount: parseFloat(a.uiAmountString || a.uiAmount || 0)
    }));
  } catch (error) {
    console.error('[Solana] getTokenLargestAccounts error:', error.message);
    return null;
  }
}

/**
 * Fallback: Get top token holders via Helius DAS API (getTokenAccounts).
 * Unlike getTokenLargestAccounts, DAS doesn't sort by balance — it returns
 * paginated accounts. We fetch a page and sort client-side.
 * Slower but far more reliable (uses Helius plan, not public RPC limits).
 *
 * @param {string} mintAddress - Token mint address
 * @param {number} decimals - Token decimals (needed to convert raw amounts)
 * @returns {Promise<Array|null>} - Array of { address, uiAmount } sorted by balance desc, or null
 */
async function getTokenLargestAccountsDAS(mintAddress, decimals = 0) {
  if (!HELIUS_DAS_URL) return null;

  try {
    countCredits('getTokenAccounts', DAS_CREDITS);
    const response = await circuitBreakers.heliusDas.execute(() =>
      withRpcRetry(() => rateLimitedRequest('helius', () =>
        axios.post(HELIUS_DAS_URL, {
          jsonrpc: '2.0',
          id: 'largest-holders',
          method: 'getTokenAccounts',
          params: {
            mint: mintAddress,
            page: 1,
            limit: 20,
            options: { showZeroBalance: false }
          }
        }, {
          timeout: 15000,
          headers: HELIUS_HEADERS,
          httpsAgent
        })
      ), 'getTokenLargestAccountsDAS')
    );

    if (response.data.error) {
      console.error('[Solana] DAS getTokenAccounts error:', response.data.error.message);
      return null;
    }

    const accounts = response.data.result?.token_accounts;
    if (!accounts || accounts.length === 0) return null;

    const divisor = Math.pow(10, decimals);
    // Map to same format as getTokenLargestAccounts, sort by amount desc
    // DAS returns both token account address and wallet owner
    return accounts
      .map(a => ({
        address: a.address,
        wallet: a.owner,
        amount: String(a.amount),
        decimals: decimals,
        uiAmount: parseFloat(a.amount) / divisor
      }))
      .filter(a => a.uiAmount > 0)
      .sort((a, b) => b.uiAmount - a.uiAmount);
  } catch (error) {
    console.error('[Solana] getTokenLargestAccountsDAS error:', error.message);
    return null;
  }
}

/**
 * Get a sample of token holder wallet addresses using Helius DAS API.
 * Fetches up to 1000 token accounts in a single call, deduplicates by owner,
 * and returns up to `count` unique wallet addresses.
 *
 * @param {string} mintAddress - Token mint address
 * @param {number} [count=250] - Max number of unique wallets to return
 * @param {Set} [excludeAddresses] - Addresses to skip (burn wallets, LP programs, etc.)
 * @returns {Promise<string[]|null>} - Array of wallet addresses or null
 */
/**
 * Get a sample of token holders with their ATA addresses.
 * Returns array of { wallet, ata } objects. Including the ATA allows
 * downstream hold-time computation to skip the getTokenAccountsByOwner call.
 */
async function getTokenHolderSample(mintAddress, count = 250, excludeAddresses = null) {
  if (!HELIUS_DAS_URL) return null;

  try {
    countCredits('getTokenAccounts', DAS_CREDITS);
    const response = await withRpcRetry(() => rateLimitedRequest('helius', () =>
      axios.post(HELIUS_DAS_URL, {
        jsonrpc: '2.0',
        id: 'holder-sample',
        method: 'getTokenAccounts',
        params: {
          mint: mintAddress,
          page: 1,
          limit: 1000,
          options: { showZeroBalance: false }
        }
      }, {
        timeout: 20000,
        headers: HELIUS_HEADERS,
        httpsAgent
      })
    ), 'getTokenHolderSample');

    if (response.data.error) {
      console.error('[Solana] getTokenHolderSample DAS error:', response.data.error.message);
      return null;
    }

    const result = response.data.result;
    const accounts = result?.token_accounts;
    if (!accounts || accounts.length === 0) return null;

    // Determine total holder count.
    // IMPORTANT: Do NOT trust result.total from Helius DAS — it can return the
    // page size (1000) instead of the true total across all pages.
    // We do NOT call getTokenHolderCount() inline here — it paginates up to 50
    // pages and floods the Helius queue. Instead, return a lower-bound estimate
    // and let the caller fetch the precise count asynchronously if needed.
    let totalHolders = null;

    if (accounts.length >= 1000) {
      // Full page — there are more holders. Return 1000+ as lower bound.
      // Precise count should be fetched separately via getTokenHolderCount().
      totalHolders = 1000;
    } else {
      // Fewer than 1000 accounts — this is the complete set
      totalHolders = accounts.length;
    }

    // Deduplicate by owner wallet, keep ATA address for cheap hold-time lookups
    const seen = new Set();
    const allHolders = [];
    for (const a of accounts) {
      if (!a.owner || !a.amount || a.amount === '0' || a.amount === 0) continue;
      if (seen.has(a.owner)) continue;
      if (excludeAddresses && excludeAddresses.has(a.owner)) continue;
      seen.add(a.owner);
      allHolders.push({ wallet: a.owner, ata: a.address || null, amount: parseFloat(a.amount) || 0 });
    }

    // Sort by balance descending and skip dust wallets (bottom 10% by balance)
    allHolders.sort((a, b) => b.amount - a.amount);
    const cutoff = Math.floor(allHolders.length * 0.9);
    const holders = allHolders.slice(0, Math.min(count, cutoff || allHolders.length))
      .map(({ wallet, ata }) => ({ wallet, ata }));

    console.log(`[Solana] getTokenHolderSample: ${holders.length} holders (${totalHolders} total) from ${accounts.length} accounts for ${mintAddress.slice(0, 8)}...`);
    return { holders, totalHolders };
  } catch (error) {
    console.error('[Solana] getTokenHolderSample error:', error.message);
    return null;
  }
}

/**
 * Page through every token account of a mint (Helius DAS getTokenAccounts, 1000
 * per page). Used by the holder snapshot job. Throws on any page error so a
 * half-read holder list is never mistaken for a full one; hitting maxPages is
 * the only way to get complete=false.
 *
 * @returns {Promise<{accounts: Array<{owner, address, amount}>, pages: number, complete: boolean}>}
 */
async function getAllTokenAccounts(mintAddress, { maxPages = 100 } = {}) {
  if (!HELIUS_DAS_URL) throw new Error('Helius DAS not configured');
  const accounts = [];
  let page = 1;
  let complete = false;
  while (page <= maxPages) {
    countCredits('getTokenAccounts', DAS_CREDITS);
    const response = await circuitBreakers.heliusDas.execute(() =>
      withRpcRetry(() => rateLimitedRequest('helius', () =>
        axios.post(HELIUS_DAS_URL, {
          jsonrpc: '2.0',
          id: `snapshot-p${page}`,
          method: 'getTokenAccounts',
          params: { mint: mintAddress, page, limit: 1000, options: { showZeroBalance: false } }
        }, { timeout: 20000, headers: HELIUS_HEADERS, httpsAgent })
      ), 'getAllTokenAccounts')
    );
    if (response.data.error) {
      throw new Error(`DAS page ${page}: ${response.data.error.message || response.data.error.code}`);
    }
    const batch = response.data.result?.token_accounts || [];
    for (const a of batch) accounts.push({ owner: a.owner, address: a.address, amount: a.amount });
    if (batch.length < 1000) { complete = true; break; }
    page++;
  }
  return { accounts, pages: Math.min(page, maxPages), complete };
}

/**
 * One page of signatures for an address, newest first, optionally before a signature.
 */
async function getSignaturesPage(address, { limit = 100, before } = {}) {
  const opts = { limit };
  if (before) opts.before = before;
  return rpcCall('getSignaturesForAddress', [address, opts]);
}

/**
 * Parse up to 100 transactions by signature with the Helius Enhanced API.
 * Returns them in the order given; signatures Helius couldn't parse are skipped.
 */
async function parseTransactions(signatures) {
  if (!HELIUS_API_KEY) throw new Error('Helius not configured');
  if (!signatures || signatures.length === 0) return [];
  countCredits('enhanced:/v0/transactions', ENHANCED_CREDITS);
  const response = await withRpcRetry(() => rateLimitedRequest('helius', () =>
    axios.post(
      'https://api.helius.xyz/v0/transactions',
      { transactions: signatures.slice(0, 100) },
      { params: { 'api-key': HELIUS_API_KEY }, timeout: 30000, httpsAgent }
    )
  ), 'parseTransactions');
  if (!Array.isArray(response.data)) throw new Error('Unexpected parseTransactions response');
  const bySig = new Map(response.data.filter(Boolean).map(t => [t.signature, t]));
  return signatures.map(sig => bySig.get(sig)).filter(Boolean);
}

// Helius' getTransactionsForAddress (10 credits per call, up to 1000 full
// transactions) replaces getSignaturesForAddress + the 100-credit Enhanced
// Transactions parse for the hold-time backfill. Latched off for the process
// when the endpoint doesn't serve it (-32601) so callers use the legacy path.
let gtfaUnavailable = false;

function isTransactionHistoryAvailable() {
  return !!HELIUS_API_KEY && !gtfaUnavailable;
}

/**
 * One page of an account's succeeded transactions with full meta (pre/post token
 * balances), newest first, via getTransactionsForAddress.
 * @returns {Promise<{txs: Array, paginationToken: string|null}>}
 */
async function getAccountTransactionsPage(address, { limit = 1000, paginationToken, sortOrder = 'desc' } = {}) {
  if (!isTransactionHistoryAvailable()) throw new Error('getTransactionsForAddress not available');
  const opts = {
    transactionDetails: 'full',
    sortOrder,
    limit: Math.max(1, Math.min(1000, limit)),
    encoding: 'json',
    maxSupportedTransactionVersion: 0,
    filters: { status: 'succeeded' },
  };
  if (paginationToken) opts.paginationToken = paginationToken;
  try {
    const result = await rpcCall('getTransactionsForAddress', [address, opts]);
    if (!result || !Array.isArray(result.data)) throw new Error('Unexpected getTransactionsForAddress response');
    return { txs: result.data, paginationToken: result.paginationToken || null };
  } catch (error) {
    if (error.rpcCode === -32601) {
      gtfaUnavailable = true;
      console.warn('[Solana] getTransactionsForAddress not served by this endpoint; backfill falls back to signatures + Enhanced API');
    }
    throw error;
  }
}

/**
 * Get token authorities from Helius DAS (update authority, creator, etc.)
 * Used to detect token origin (e.g. pump.fun) for supply analysis.
 *
 * @param {string} mintAddress - Token mint address
 * @returns {Promise<Object|null>} - { authorities: [...], creators: [...] } or null
 */
async function getTokenAuthorities(mintAddress) {
  if (!HELIUS_DAS_URL) return null;

  // Check cache first (1hr TTL — authorities never change after mint)
  const authCacheKey = `token-auth:${mintAddress}`;
  const cached = await cache.get(authCacheKey);
  if (cached) return cached;

  try {
    countCredits('getAsset', DAS_CREDITS);
    const response = await withRpcRetry(() => rateLimitedRequest('helius', () =>
      axios.post(HELIUS_DAS_URL, {
        jsonrpc: '2.0',
        id: 'token-auth',
        method: 'getAsset',
        params: { id: mintAddress }
      }, { timeout: 8000, headers: HELIUS_HEADERS, httpsAgent })
    ), 'getTokenAuthorities');

    if (response.data.error || !response.data.result) return null;
    const asset = response.data.result;
    const result = {
      authorities: asset.authorities || [],
      creators: asset.creators || []
    };
    await cache.set(authCacheKey, result, TTL.DAY); // Authorities never change
    return result;
  } catch (error) {
    return null;
  }
}

/**
 * Fetch parsed transaction history for a wallet using Helius Enhanced Transactions API.
 * Uses Helius's getTransactionsForAddress which returns human-readable, enriched
 * transaction data including swap details, token transfers, and timestamps.
 *
 * @param {string} walletAddress - Solana wallet address
 * @param {Object} [options] - Query options
 * @param {number} [options.limit=100] - Max transactions to return (up to 100)
 * @param {string} [options.type] - Filter by transaction type (e.g. 'SWAP')
 * @returns {Promise<Array|null>} - Array of parsed transactions or null
 */
async function getTransactionsForAddress(walletAddress, { limit = 100, type, before } = {}) {
  if (!HELIUS_API_KEY) {
    console.warn(`[Solana] getTransactionsForAddress skipped: no HELIUS_API_KEY`);
    return null;
  }

  try {
    const params = { 'api-key': HELIUS_API_KEY, limit };
    if (type) params.type = type;
    if (before) params.before = before;

    countCredits('enhanced:/v0/addresses/transactions', ENHANCED_CREDITS);
    const response = await withRpcRetry(() => rateLimitedRequest('helius', () =>
      axios.get(
        `https://api.helius.xyz/v0/addresses/${walletAddress}/transactions`,
        { params, timeout: 20000, httpsAgent }
      )
    ), 'getTransactionsForAddress');

    if (!response.data || !Array.isArray(response.data)) {
      console.warn(`[Solana] getTransactionsForAddress: unexpected response for ${walletAddress.slice(0, 8)}...`);
      return null;
    }
    return response.data;
  } catch (error) {
    // 404 is expected for token accounts (ATAs) and program-owned addresses
    // that don't have wallet-level transaction history — not an error
    if (error.response && error.response.status === 404) return null;
    console.error(`[Solana] getTransactionsForAddress error for ${walletAddress.slice(0, 8)}...: ${error.response?.status || error.code || error.message}`);
    return null;
  }
}

/**
 * Get total locked token amount from Streamflow vesting contracts.
 * Queries on-chain Streamflow program accounts filtered by token mint,
 * then sums (deposited - withdrawn) for all active (non-closed) streams.
 *
 * @param {string} mintAddress - Token mint address
 * @param {number} decimals - Token decimals for converting raw amounts
 * @returns {Promise<number>} - Total locked amount in UI units (0 if none found)
 */
// Cache Streamflow results: getProgramAccounts is 10 credits and vesting
// schedules change slowly, so keep answers for a day in the shared cache (every
// process sees them) and in a small local map for speed.
const streamflowCache = new Map();
const STREAMFLOW_CACHE_TTL = TTL.DAY;

async function getStreamflowLockedAmount(mintAddress, decimals = 0) {
  // Check local cache first, then the shared cache
  const cached = streamflowCache.get(mintAddress);
  if (cached && Date.now() < cached.expiry) return cached.value;
  const shared = await cache.get(`streamflow-locked:${mintAddress}:${decimals}`).catch(() => undefined);
  if (typeof shared === 'number') {
    streamflowCache.set(mintAddress, { value: shared, expiry: Date.now() + 60 * 60 * 1000 });
    return shared;
  }

  const STREAMFLOW_PROGRAM = 'strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m';
  const STREAM_ACC_SIZE = 1104;
  const MINT_OFFSET = 177;
  const WITHDRAWN_OFFSET = 17;
  const NET_DEPOSITED_OFFSET = 417;
  const CLOSED_OFFSET = 671;

  try {
    const result = await rpcCall('getProgramAccounts', [
      STREAMFLOW_PROGRAM,
      {
        encoding: 'base64',
        filters: [
          { dataSize: STREAM_ACC_SIZE },
          { memcmp: { offset: MINT_OFFSET, bytes: mintAddress } }
        ],
        // Fetch only bytes 0-672 — enough for withdrawn (17), deposited (417), closed (671)
        dataSlice: { offset: 0, length: 672 }
      }
    ]);

    if (!result || result.length === 0) {
      streamflowCache.set(mintAddress, { value: 0, expiry: Date.now() + STREAMFLOW_CACHE_TTL });
      await cache.set(`streamflow-locked:${mintAddress}:${decimals}`, 0, STREAMFLOW_CACHE_TTL).catch(() => {});
      return 0;
    }

    const divisor = Math.pow(10, decimals);
    let totalLocked = 0;

    for (const account of result) {
      const data = Buffer.from(account.account.data[0], 'base64');
      // Skip closed streams
      if (data.length > CLOSED_OFFSET && data[CLOSED_OFFSET] !== 0) continue;
      const withdrawn = data.readBigUInt64LE(WITHDRAWN_OFFSET);
      const deposited = data.readBigUInt64LE(NET_DEPOSITED_OFFSET);
      const remaining = deposited >= withdrawn ? deposited - withdrawn : 0n;
      if (remaining > 0n) {
        totalLocked += Number(remaining) / divisor;
      }
    }

    console.log(`[Solana] Streamflow locked for ${mintAddress}: ${totalLocked} (${result.length} contracts found)`);
    streamflowCache.set(mintAddress, { value: totalLocked, expiry: Date.now() + STREAMFLOW_CACHE_TTL });
    await cache.set(`streamflow-locked:${mintAddress}:${decimals}`, totalLocked, STREAMFLOW_CACHE_TTL).catch(() => {});
    return totalLocked;
  } catch (error) {
    console.error('[Solana] getStreamflowLockedAmount error:', error.message);
    // Cache zeros briefly (5 min) to avoid hammering RPC on repeated failures
    streamflowCache.set(mintAddress, { value: 0, expiry: Date.now() + 5 * 60 * 1000 });
    return 0;
  }
}

module.exports = {
  rpcCall,
  getAccountInfo,
  getTokenAccountBalance,
  getTokenSupply,
  getMultipleAccounts,
  getTokenAccountsByOwner,
  getRecentBlockhash,
  sendRawTransaction,
  getTransaction,
  getSignaturesForAddress,
  getTokenHolderCount,
  getTokenLargestAccounts,
  getTokenLargestAccountsDAS,
  getTokenHolderSample,
  getAllTokenAccounts,
  getSignaturesPage,
  parseTransactions,
  getTokenMetadata,
  fetchOffchainLinks,
  getTokenMetadataBatch,
  getStreamflowLockedAmount,
  getTokenAuthorities,
  getTransactionsForAddress,
  getAccountTransactionsPage,
  isTransactionHistoryAvailable,
  isHeliusConfigured,
  checkHealth,
  getCreditUsage,
  countCredits,
  // exported for tests
  _rpcChains: rpcChains,
};
