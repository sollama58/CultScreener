const axios = require('axios');
const { httpsAgent } = require('./httpAgent');
const { circuitBreakers } = require('./circuitBreaker');
const { rateLimitedRequest } = require('./rateLimiter');

// RPC endpoint configuration with failover
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;

// Helius standard RPC requires the API key in the URL (not as a header).
// The x-api-key header only works for Helius REST/DAS APIs, not for
// JSON-RPC calls proxied to Solana validators.
const RPC_ENDPOINTS = [
  // Primary: Helius with key in URL (if configured)
  HELIUS_API_KEY && `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`,
  // Secondary: Custom Helius RPC URL (may already contain the key)
  process.env.HELIUS_RPC_URL,
  // Tertiary: Public Solana RPC (rate limited but always available)
  'https://api.mainnet-beta.solana.com'
].filter(Boolean);

// Remove duplicates (e.g. if HELIUS_RPC_URL is the same as the primary)
const seen = new Set();
const deduped = RPC_ENDPOINTS.filter(url => {
  const base = url.split('?')[0];
  if (seen.has(base)) return false;
  seen.add(base);
  return true;
});
RPC_ENDPOINTS.length = 0;
RPC_ENDPOINTS.push(...deduped);

// Current RPC index for failover
let currentRpcIndex = 0;
let lastRpcFailure = null;
const RPC_FAILOVER_COOLDOWN_MS = 60000; // 1 minute before trying failed endpoint again

// Get current RPC URL with failover logic
function getCurrentRpcUrl() {
  // If primary has been failing, check if cooldown has passed
  if (currentRpcIndex > 0 && lastRpcFailure) {
    const elapsed = Date.now() - lastRpcFailure;
    if (elapsed > RPC_FAILOVER_COOLDOWN_MS) {
      // Try to recover to primary
      currentRpcIndex = 0;
      lastRpcFailure = null;
      console.log('[Solana] Attempting to recover to primary RPC endpoint');
    }
  }
  return RPC_ENDPOINTS[currentRpcIndex] || RPC_ENDPOINTS[0];
}

// Failover to next RPC endpoint
function failoverToNextRpc() {
  if (currentRpcIndex < RPC_ENDPOINTS.length - 1) {
    currentRpcIndex++;
    lastRpcFailure = Date.now();
    console.log(`[Solana] Failing over to RPC endpoint ${currentRpcIndex + 1}/${RPC_ENDPOINTS.length}`);
    return true;
  }
  return false;
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
 */
async function withRpcRetry(requestFn, context = 'rpc') {
  let lastError;
  for (let attempt = 0; attempt <= RPC_RETRY_CONFIG.maxRetries; attempt++) {
    try {
      return await requestFn();
    } catch (error) {
      lastError = error;
      if (error.response?.status !== 429) throw error;
      if (attempt === RPC_RETRY_CONFIG.maxRetries) {
        console.error(`[Solana] ${context}: Max retries (${RPC_RETRY_CONFIG.maxRetries}) exceeded for 429`);
        throw error;
      }
      const baseDelay = RPC_RETRY_CONFIG.baseDelay * Math.pow(RPC_RETRY_CONFIG.backoffMultiplier, attempt);
      const jitter = Math.random() * 1000;
      const delay = Math.min(baseDelay + jitter, RPC_RETRY_CONFIG.maxDelay);
      console.log(`[Solana] ${context}: Rate limited (429), retry ${attempt + 1}/${RPC_RETRY_CONFIG.maxRetries} after ${Math.round(delay)}ms`);
      await sleep(delay);
    }
  }
  throw lastError;
}

// Make RPC call with circuit breaker, failover, retry, and 429 backoff
async function rpcCall(method, params = [], retryCount = 0) {
  const MAX_RETRIES = 2;

  try {
    // Pick rate limiter key: use 'helius' when talking to a Helius endpoint so all
    // Helius traffic (RPC + DAS) shares one queue and respects a single rate limit.
    const rpcUrl = getCurrentRpcUrl();
    const rateLimiterKey = rpcUrl.includes('helius') ? 'helius' : 'solana';

    return await withRpcRetry(() => rateLimitedRequest(rateLimiterKey, () => circuitBreakers.solanaRpc.execute(async () => {

      try {
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
          throw new Error(errorMsg);
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

    if (isConnectionError && retryCount < MAX_RETRIES) {
      if (failoverToNextRpc()) {
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
    const currentUrl = getCurrentRpcUrl();
    return {
      healthy: result === 'ok',
      rpcUrl: currentUrl.split('?')[0], // Hide API key
      currentEndpoint: currentRpcIndex + 1,
      totalEndpoints: RPC_ENDPOINTS.length,
      usingFallback: currentRpcIndex > 0,
      circuitBreakerState: circuitBreakers.solanaRpc.getStatus().state
    };
  } catch (error) {
    return {
      healthy: false,
      error: error.message,
      currentEndpoint: currentRpcIndex + 1,
      totalEndpoints: RPC_ENDPOINTS.length,
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
 * Get total holder count from Solscan public API.
 * Returns the exact number of holders for any Solana token.
 * Single HTTP call, no pagination needed.
 */
async function getTokenHolderCount(mintAddress) {
  try {
    const response = await axios.get(
      `https://api.solscan.io/v2/token/holder/count?token=${encodeURIComponent(mintAddress)}`,
      {
        timeout: 10000,
        httpsAgent,
        headers: { 'Accept': 'application/json', 'User-Agent': 'CultScreener/1.0' }
      }
    );

    const count = response.data?.data?.holder_count ?? response.data?.data?.count ?? response.data?.holder_count;
    if (typeof count === 'number' && count > 0) {
      console.log(`[Solana] Solscan holder count for ${mintAddress.slice(0, 8)}...: ${count}`);
      return count;
    }

    // Fallback: try the token meta endpoint
    const metaResponse = await axios.get(
      `https://api.solscan.io/v2/token/meta?token=${encodeURIComponent(mintAddress)}`,
      {
        timeout: 10000,
        httpsAgent,
        headers: { 'Accept': 'application/json', 'User-Agent': 'CultScreener/1.0' }
      }
    );

    const metaCount = metaResponse.data?.data?.holder ?? metaResponse.data?.data?.holder_count;
    if (typeof metaCount === 'number' && metaCount > 0) {
      console.log(`[Solana] Solscan meta holder count for ${mintAddress.slice(0, 8)}...: ${metaCount}`);
      return metaCount;
    }

    return null;
  } catch (error) {
    console.error('[Solana] Solscan holder count error:', error.message);
    return null;
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

  try {
    console.log(`[Solana] Fetching token metadata for ${mintAddress}`);

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
      return null;
    }

    const asset = response.data.result;
    if (!asset) {
      return null;
    }

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
      logoUri: logoUri,
      // json_uri for off-chain metadata fetch (social links live here)
      jsonUri: (typeof content.json_uri === 'string' && content.json_uri) ? content.json_uri : null,
      // On-chain fallback links (extensions / content.links)
      onchainLinks: Object.keys(onchainLinks).length > 0 ? onchainLinks : null
    };

    console.log(`[Solana] Token metadata for ${mintAddress}:`, {
      name: result.name,
      symbol: result.symbol,
      hasPriceData: result.hasPriceData,
      logoUri: result.logoUri
    });

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
        logoUri: logoUri
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
    const response = await withRpcRetry(() => rateLimitedRequest('helius', () =>
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
    ), 'getTokenLargestAccountsDAS');

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

    // Total holder count from DAS (across all pages, not just this page)
    const totalHolders = typeof result.total === 'number' ? result.total : null;

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

    // Attach totalHolders as a non-enumerable property so callers can read it
    // before the array is JSON-serialized (JSON.stringify strips array properties)
    Object.defineProperty(holders, 'totalHolders', { value: totalHolders, enumerable: false });

    console.log(`[Solana] getTokenHolderSample: ${holders.length} holders (${totalHolders} total) from ${accounts.length} accounts for ${mintAddress.slice(0, 8)}...`);
    return holders;
  } catch (error) {
    console.error('[Solana] getTokenHolderSample error:', error.message);
    return null;
  }
}

/**
 * Get how long a wallet has held a token. Uses the ATA address directly
 * (skips getTokenAccountsByOwner) when provided. Only 1 RPC call.
 */
async function getTokenHoldTime(walletAddress, tokenMint, ataAddress = null) {
  try {
    // If we don't have the ATA, look it up (1 extra RPC call)
    let ata = ataAddress;
    if (!ata) {
      const accounts = await rpcCall('getTokenAccountsByOwner', [
        walletAddress,
        { mint: tokenMint },
        { encoding: 'jsonParsed' }
      ]);
      if (!accounts?.value || accounts.value.length === 0) return null;
      ata = accounts.value[0].pubkey;
    }

    // Get oldest signature on this token account (1 RPC call)
    // Most individual token accounts have < 100 txs, so 1 call suffices
    let oldestTimestamp = null;
    let beforeSig = undefined;

    for (let page = 0; page < 2; page++) {
      const params = [ata, { limit: 1000 }];
      if (beforeSig) params[1].before = beforeSig;

      const sigs = await rpcCall('getSignaturesForAddress', params);
      if (!sigs || sigs.length === 0) break;

      const oldest = sigs[sigs.length - 1];
      if (oldest.blockTime) oldestTimestamp = oldest.blockTime * 1000;
      if (sigs.length < 1000) break;
      beforeSig = oldest.signature;
    }

    if (!oldestTimestamp) return null;
    return Date.now() - oldestTimestamp;
  } catch {
    return null;
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
  try {
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
    return {
      authorities: asset.authorities || [],
      creators: asset.creators || []
    };
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
async function getTransactionsForAddress(walletAddress, { limit = 100, type } = {}) {
  if (!HELIUS_API_KEY) {
    console.warn(`[Solana] getTransactionsForAddress skipped: no HELIUS_API_KEY`);
    return null;
  }

  try {
    const params = { 'api-key': HELIUS_API_KEY, limit };
    if (type) params.type = type;

    const response = await withRpcRetry(() => rateLimitedRequest('helius', () =>
      axios.get(
        `https://api.helius.xyz/v0/addresses/${walletAddress}/transactions`,
        { params, timeout: 10000, httpsAgent }
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
 * Get hold metrics for a wallet: average hold time across all tokens AND
 * how long the wallet has held a specific token. Uses a single Helius API call
 * (unfiltered) and extracts both metrics from the same transaction data.
 *
 * @param {string} walletAddress - Solana wallet address
 * @param {string} tokenMint - The specific token mint to measure hold duration for
 * @returns {Promise<{avgHoldTime: number|null, tokenHoldTime: number|null}>}
 */
// Base currencies and stablecoins to exclude from avg hold time calculations.
// These appear in every swap as intermediaries and would skew the average.
const HOLD_TIME_EXCLUDE_MINTS = new Set([
  'So11111111111111111111111111111111111111112',  // Wrapped SOL
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
]);

// NFT transaction types to exclude from hold time calculations
const HOLD_TIME_EXCLUDE_TYPES = new Set([
  'NFT_SALE', 'NFT_LISTING', 'NFT_CANCEL_LISTING', 'NFT_BID',
  'NFT_BID_CANCELLED', 'NFT_MINT', 'BURN', 'BURN_NFT',
  'COMPRESSED_NFT_MINT', 'COMPRESSED_NFT_TRANSFER',
]);

/**
 * Get hold metrics for a wallet. Uses the ATA-based approach exclusively:
 * 1 RPC call if ATA address is provided, 2 if not.
 * No Helius enhanced API calls — only standard Solana RPC.
 *
 * avgHoldTime is no longer computed (required expensive Helius enhanced API).
 * tokenHoldTime uses getSignaturesForAddress on the ATA.
 */
async function getWalletHoldMetrics(walletAddress, tokenMint, ataAddress = null) {
  const tokenHoldTime = await getTokenHoldTime(walletAddress, tokenMint, ataAddress).catch(() => null);
  return { avgHoldTime: tokenHoldTime, tokenHoldTime, walletAge: null };
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
async function getStreamflowLockedAmount(mintAddress, decimals = 0) {
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

    if (!result || result.length === 0) return 0;

    const divisor = Math.pow(10, decimals);
    let totalLocked = 0;

    for (const account of result) {
      const data = Buffer.from(account.account.data[0], 'base64');
      // Skip closed streams
      if (data.length > CLOSED_OFFSET && data[CLOSED_OFFSET] !== 0) continue;
      const withdrawn = data.readBigUInt64LE(WITHDRAWN_OFFSET);
      const deposited = data.readBigUInt64LE(NET_DEPOSITED_OFFSET);
      const remaining = deposited - withdrawn;
      if (remaining > 0n) {
        totalLocked += Number(remaining) / divisor;
      }
    }

    console.log(`[Solana] Streamflow locked for ${mintAddress}: ${totalLocked} (${result.length} contracts found)`);
    return totalLocked;
  } catch (error) {
    console.error('[Solana] getStreamflowLockedAmount error:', error.message);
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
  getTransaction,
  getSignaturesForAddress,
  getTokenHolderCount,
  getTokenLargestAccounts,
  getTokenLargestAccountsDAS,
  getTokenHolderSample,
  getTokenMetadata,
  fetchOffchainLinks,
  getTokenMetadataBatch,
  getStreamflowLockedAmount,
  getTokenAuthorities,
  getTransactionsForAddress,
  getWalletHoldMetrics,
  getTokenHoldTime,
  isHeliusConfigured,
  checkHealth
};
