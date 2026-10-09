const express = require('express');
const router = express.Router();
const jupiterService = require('../services/jupiter');
const geckoService = require('../services/geckoTerminal');
const solanaService = require('../services/solana');
const db = require('../services/database');
const { cache, TTL, keys } = require('../services/cache');
const { validateMint, validatePagination, validateSearch, asyncHandler, SOLANA_ADDRESS_REGEX, catchUnlessOverloaded, requireDatabase, hashApiKey, canBypassCache } = require('../middleware/validation');
const { searchLimiter, viewLimiter, holderLookupLimiter } = require('../middleware/rateLimit');
const { BURN_WALLETS, LP_AUTHORITIES, SYSTEM_PROGRAM_ID } = require('../constants');
const holderPipeline = require('../services/holderPipeline');
const holderCounts = require('../services/holderCounts');
const priceChanges = require('../services/priceChanges');
const { resolveMintDecimals } = require('../services/mintDecimals');
const { inferSplBurn } = require('../services/splBurn');
const axios = require('axios');
const crypto = require('crypto');
const { rateLimitedRequest } = require('../services/rateLimiter');
const { CURATED_LIST_KEY } = require('../services/curatedTokens');
const { circuitBreakers } = require('../services/circuitBreaker');

// Require database for all token routes
router.use(requireDatabase);

// Middleware: reject requests for tokens not in the curated list or leaderboard.
// Prevents arbitrary tokens from triggering expensive RPC/computation calls.
// Result is cached (5 min for allowed, 1 min for denied) to avoid a DB query on every request.
const requireAllowedToken = asyncHandler(async (req, res, next) => {
  const mint = req.params.mint;
  if (!mint) return next();

  const cacheKey = `curated-allowed:${mint}`;
  const cached = await cache.get(cacheKey);
  if (cached === true) return next();
  if (cached === false) {
    return res.status(403).json({ error: 'Token not available. Only curated tokens can be viewed.', code: 'NOT_CURATED' });
  }

  const allowed = await db.isTokenAllowed(mint);
  // Cache longer for allowed tokens (rarely removed); shorter for denied (may be added soon)
  await cache.set(cacheKey, allowed, allowed ? 5 * 60 * 1000 : 60 * 1000).catch(() => {});
  if (!allowed) {
    return res.status(403).json({ error: 'Token not available. Only curated tokens can be viewed.', code: 'NOT_CURATED' });
  }
  next();
});

// Names that indicate missing/placeholder metadata
const PLACEHOLDER_NAMES = new Set(['unknown token', 'unknown', '']);

// Helius DAS URL for holder verification fallback
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const HELIUS_DAS_URL = HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}` : null;

// Allowed values for token list query params — prevents cache key pollution
const VALID_FILTERS = ['trending', 'new', 'gainers', 'losers', 'most_viewed', 'tech', 'meme'];
const VALID_SORTS = ['volume', 'price', 'priceChange24h', 'marketCap', 'views'];
const VALID_ORDERS = ['asc', 'desc'];
// GeckoTerminal's trending_pools / new_pools endpoints serve pages 1-10 only
const GECKO_MAX_PAGES = 10;
// GeckoTerminal returns at most 20 pools per token page
const POOLS_PAGE_SIZE = 20;
// How old a snapshot may be to stand in for the top holders when the RPC is down
const STALE_SNAPSHOT_MAX_AGE_MS = 24 * 3_600_000;

// First candidate that is a real decimals value (0 included), else 9. `a || b || 9` turned a
// 0-decimal mint into 9.
function pickDecimals(...candidates) {
  for (const d of candidates) if (Number.isInteger(d) && d >= 0) return d;
  return 9;
}

// Circulating supply from a holder-analytics `supply` block: total minus Streamflow-locked
// and burn-wallet amounts (SPL burns are already out of the on-chain total). null when unknown.
function circulatingFromAnalytics(supply) {
  if (!supply || !(supply.total > 0)) return null;
  return Math.max(0, supply.total - (supply.locked || 0) - (supply.deadWalletBurnt || 0));
}

// BURN_WALLETS, LP_AUTHORITIES and SYSTEM_PROGRAM_ID imported from ../constants (shared with worker.js)
const VALID_SUBMISSION_TYPES = ['banner', 'twitter', 'telegram', 'discord', 'tiktok', 'website'];
const VALID_SUBMISSION_STATUSES = ['pending', 'approved', 'rejected', 'all'];
const jobQueue = require('../services/jobQueue');

// Merge DB view counts with any buffered (unflushed) counts from the job queue
// so the token list always reflects the latest views, even before a flush cycle
function mergeViewCounts(dbCounts, addresses) {
  const buffered = jobQueue.getBufferedViewCounts(addresses);
  const merged = { ...dbCounts };
  for (const mint of addresses) {
    if (buffered[mint]) {
      merged[mint] = (merged[mint] || 0) + buffered[mint];
    }
  }
  return merged;
}

// Stampede guard for GET /api/tokens, whose miss path responds from several branches and
// stores a setWithTimestamp envelope (so it can't sit inside cache.getOrSet): the first
// miss for a key claims it, and concurrent misses wait for that response to finish and
// then re-read the cache instead of each running the Gecko/Helius/DB pipeline.
const listMissInFlight = new Map();
const LIST_MISS_WAIT_MS = 30000;

function claimListMiss(key, res) {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const done = () => {
    if (listMissInFlight.get(key) === pending) listMissInFlight.delete(key);
    release();
  };
  listMissInFlight.set(key, pending);
  res.once('finish', done);
  res.once('close', done);
  setTimeout(done, LIST_MISS_WAIT_MS).unref();
}

// Helius getAssetBatch metadata (name, symbol, decimals, logo) cached per mint for an hour, so
// list and leaderboard misses under different cache keys don't each pay 10 credits for mints
// another key already looked up. A mint Helius doesn't know is remembered as a miss too: for
// an hour when the same call named other mints (the call worked), for a minute when it named
// none (getTokenMetadataBatch also answers {} when the call fails).
const BATCH_META_KEY = (mint) => `batch-meta:${mint}`;
const META_MISS = 'NOT_FOUND';
async function getTokenMetadataBatchCached(mints) {
  const unique = [...new Set((mints || []).filter(Boolean))];
  if (unique.length === 0) return {};
  const cached = await cache.mget(unique.map(BATCH_META_KEY)).catch(() => []);
  const result = {};
  const toFetch = [];
  unique.forEach((mint, i) => {
    const v = cached[i];
    if (v === META_MISS) return;
    if (v && typeof v === 'object') result[mint] = v;
    else toFetch.push(mint);
  });
  if (toFetch.length === 0) return result;

  const fetched = await solanaService.getTokenMetadataBatch(toFetch) || {};
  const missTtl = toFetch.some(m => fetched[m]) ? TTL.METADATA : TTL.ERROR;
  await Promise.all(toFetch.map(mint => {
    const meta = fetched[mint];
    if (!meta) return cache.set(BATCH_META_KEY(mint), META_MISS, missTtl).catch(() => {});
    const entry = {
      mintAddress: mint,
      address: mint,
      name: meta.name || null,
      symbol: meta.symbol || null,
      decimals: meta.decimals,
      logoUri: meta.logoUri || null
    };
    result[mint] = entry;
    return cache.set(BATCH_META_KEY(mint), entry, TTL.METADATA).catch(() => {});
  }));
  return result;
}

// Postgres DECIMAL columns arrive as strings ("0.00012300"); list responses send numbers
const toNum = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

// Gecko-backed filters keep ONE merged, enriched list per filter and answer every window by
// slicing it. Keying the cache on the caller's sort/order/limit/offset let any client mint a
// new key per request: a ~50 KB Redis write plus a Helius getAssetBatch each time.
const GECKO_LIST_FILTERS = new Set(['trending', 'new', 'gainers', 'losers']);
// GeckoTerminal serves up to 20 pools per list page; a page yields fewer tokens than that
// (non-memecoin pools and repeats are skipped), so pages are fetched until the list is long enough
const GECKO_PAGE_SIZE = 20;
// gainers/losers rank a fixed population (the first N trending pages), so every offset slices
// the same ordering instead of re-ranking whichever pages its window happened to need
const RANKED_LIST_PAGES = 5;
const geckoListKey = (filter) => keys.tokenList(`gecko-${filter}`, 0);

// One Gecko list page through its own cache; null when it failed or came back empty
async function getGeckoListPage(kind, page, useHeliusEnrichment) {
  const pageKey = `gecko-list-page:${kind}:${useHeliusEnrichment ? 1 : 0}:${page}`;
  const cachedPage = await cache.get(pageKey);
  if (Array.isArray(cachedPage) && cachedPage.length > 0) return cachedPage;
  const fetchPage = kind === 'new'
    ? geckoService.getNewTokens(GECKO_PAGE_SIZE, useHeliusEnrichment, page)
    : geckoService.getTrendingTokens({ limit: GECKO_PAGE_SIZE, skipEnrichment: useHeliusEnrichment, page });
  const result = await fetchPage.catch(err => {
    if (err.isOverloaded || err.isCircuitBreakerError) throw err;
    console.warn(`[Tokens] GeckoTerminal ${kind} page ${page} failed: ${err.response?.status || err.message}`);
    return null;
  });
  // The service answers [] on errors too, so an empty page is never cached
  if (!Array.isArray(result) || result.length === 0) return null;
  await cache.set(pageKey, result, TTL.MEDIUM);
  return result;
}

// Merge Gecko pages from page 1 (deduped across pages) until the list holds minLength tokens.
// exhausted: no further page can extend it. incomplete: a page failed while a later one had
// data, so indices past the gap are unknown (not cached). truncated: stopped at an empty page
// before Gecko's last one, most likely a failure (cached only briefly).
async function buildGeckoList(filter, minLength, useHeliusEnrichment) {
  const kind = filter === 'new' ? 'new' : 'trending';
  const ranked = filter === 'gainers' || filter === 'losers';
  const tokens = [];
  const seen = new Set();
  let next = 1;
  let stoppedAt = null;
  let incomplete = false;

  while (stoppedAt === null && next <= GECKO_MAX_PAGES) {
    const missing = Math.max(1, Math.ceil((minLength - tokens.length) / GECKO_PAGE_SIZE));
    const last = ranked ? RANKED_LIST_PAGES : Math.min(GECKO_MAX_PAGES, next + missing - 1);
    const pageNums = [];
    for (let p = next; p <= last; p++) pageNums.push(p);
    const pages = await Promise.all(pageNums.map(p => getGeckoListPage(kind, p, useHeliusEnrichment)));
    const firstEmpty = pages.findIndex(p => !p);
    const usable = firstEmpty === -1 ? pages : pages.slice(0, firstEmpty);
    if (firstEmpty !== -1) {
      stoppedAt = pageNums[firstEmpty];
      if (pages.slice(firstEmpty + 1).some(Boolean)) incomplete = true;
    }
    // The same token can lead pools on two different pages; keep its first appearance
    for (const page of usable) {
      for (const t of page) {
        const addr = t.address || t.mintAddress;
        if (seen.has(addr)) continue;
        seen.add(addr);
        tokens.push({ ...t });
      }
    }
    next = last + 1;
    if (ranked || tokens.length >= minLength) break;
  }

  if (filter === 'gainers') {
    tokens.sort((a, b) => (b.priceChange24h || 0) - (a.priceChange24h || 0));
  } else if (filter === 'losers') {
    tokens.sort((a, b) => (a.priceChange24h || 0) - (b.priceChange24h || 0));
  }
  return {
    tokens,
    exhausted: ranked || stoppedAt !== null || next > GECKO_MAX_PAGES,
    incomplete,
    truncated: stoppedAt !== null && stoppedAt < GECKO_MAX_PAGES
  };
}

// Helius names/logos for tokens missing them, valid addresses only, then sentiment and
// community flags (views are added per response by withViewCounts)
async function enrichListTokens(tokens, useHeliusEnrichment) {
  if (useHeliusEnrichment && tokens.length > 0) {
    const needsEnrichment = tokens.filter(t => !t.name || !t.symbol || (!t.logoUri && !t.logoURI));
    if (needsEnrichment.length > 0) {
      const heliusMetadata = await getTokenMetadataBatchCached(needsEnrichment.map(t => t.address || t.mintAddress));
      for (const token of needsEnrichment) {
        const meta = heliusMetadata[token.address || token.mintAddress];
        if (meta) {
          token.name = meta.name || token.name;
          token.symbol = meta.symbol || token.symbol;
          token.decimals = meta.decimals || token.decimals;
          token.logoUri = meta.logoUri || token.logoUri;
          token.logoURI = meta.logoUri || token.logoURI;
        }
      }
    }
  }

  // Filter out tokens without valid Solana addresses (defensive: some API responses
  // occasionally include entries with missing address fields)
  const valid = tokens.filter(t => {
    const addr = t.address || t.mintAddress;
    return addr && SOLANA_ADDRESS_REGEX.test(addr);
  });

  if (valid.length > 0) {
    const addresses = valid.map(t => t.address || t.mintAddress);
    const [sentimentScores, communityMints] = await Promise.all([
      db.getSentimentBatch(addresses).catch(() => ({})),
      db.hasApprovedSubmissionsBatch(addresses).catch(() => new Set())
    ]);
    for (const token of valid) {
      const address = token.address || token.mintAddress;
      const s = sentimentScores[address];
      token.sentimentScore = s ? s.score : 0;
      token.sentimentBullish = s ? s.bullish : 0;
      token.sentimentBearish = s ? s.bearish : 0;
      token.hasCommunityUpdates = communityMints.has(address);
    }
  }
  return valid;
}

// Current view counts (DB + unflushed buffer) on a response window
async function withViewCounts(tokens) {
  if (!tokens || tokens.length === 0) return tokens || [];
  const addresses = tokens.map(t => t.address || t.mintAddress);
  const viewCounts = mergeViewCounts(await db.getTokenViewsBatch(addresses).catch(() => ({})), addresses);
  return tokens.map(t => ({ ...t, views: viewCounts[t.address || t.mintAddress] || 0 }));
}

// GET /api/tokens for trending / new / gainers / losers
async function serveGeckoList(res, { filter, sort, order, limit, offset }) {
  const start = offset;
  const end = offset + limit;
  // GeckoTerminal serves at most GECKO_MAX_PAGES pages: a window starting past them is empty
  if (start >= GECKO_MAX_PAGES * GECKO_PAGE_SIZE) return res.json([]);

  const useHeliusEnrichment = solanaService.isHeliusConfigured();
  const listKey = geckoListKey(filter);
  const readList = async () => {
    const list = (await cache.getWithMeta(listKey))?.value;
    return list && Array.isArray(list.tokens) && list.tokens.length > 0 ? list : null;
  };
  const covers = (list) => !!list && (list.tokens.length >= end || list.exhausted);

  let list = await readList();
  // Another request is already building this list: wait for it, then use what it cached
  if (!covers(list) && listMissInFlight.has(listKey)) {
    await listMissInFlight.get(listKey);
    list = await readList();
  }
  if (covers(list)) return res.json(await withViewCounts(list.tokens.slice(start, end)));

  claimListMiss(listKey, res);
  try {
    let built = null;
    let geckoError = null;
    try {
      built = await buildGeckoList(filter, end, useHeliusEnrichment);
    } catch (err) {
      geckoError = err;
    }

    if (built && built.tokens.length > 0) {
      const tokens = await enrichListTokens(built.tokens, useHeliusEnrichment);
      if (!built.incomplete && tokens.length > 0) {
        await cache.setWithTimestamp(listKey, { tokens, exhausted: built.exhausted },
          built.truncated ? TTL.MEDIUM : TTL.PRICE_DATA);
      }
      // Past the end of Gecko's list the window is empty: a Jupiter page here would be a
      // different ranking that repeats tokens from earlier pages
      return res.json(await withViewCounts(tokens.slice(start, end)));
    }

    // Gecko returned nothing at all: fall back to Jupiter's trending list. Jupiter serves at most
    // 100 tokens, so one list per sort/order is fetched and sliced, and kept only for a minute
    // (it may be Jupiter's own verified-token fallback rather than a trending list).
    const fallbackKey = keys.tokenList(`jupiter-fallback-${sort}-${order}`, 0);
    let fallback = await cache.get(fallbackKey);
    if (!Array.isArray(fallback)) {
      let fetched;
      try {
        fetched = await jupiterService.getTrendingTokens({ sort, order, limit: 100, offset: 0 });
      } catch (jupiterError) {
        // If both failed and we had a GeckoTerminal error, throw that
        if (geckoError) throw geckoError;
        throw jupiterError;
      }
      fallback = await enrichListTokens((fetched || []).map(t => ({ ...t })), useHeliusEnrichment);
      // An empty list is never cached: upstream usually recovers within seconds
      if (fallback.length > 0) await cache.set(fallbackKey, fallback, TTL.ERROR);
    }
    return res.json(await withViewCounts(fallback.slice(start, end)));
  } catch (error) {
    if (error.isOverloaded || error.isCircuitBreakerError) throw error;
    // Privacy: Don't log error details or stack traces
    return res.status(500).json({ error: 'Failed to fetch tokens' });
  }
}

// GET /api/tokens - List tokens (trending, new, gainers, losers, most_viewed, tech, meme)
// Optimized: Uses Helius batch API for metadata enrichment instead of extra GeckoTerminal calls
router.get('/', validatePagination, asyncHandler(async (req, res) => {
  const {
    sort: rawSort = 'volume',
    order: rawOrder = 'desc',
    limit = 50,
    offset = 0,
    filter: rawFilter = 'trending'
  } = req.query;

  // Validate query params against whitelists to prevent cache key pollution
  const filter = VALID_FILTERS.includes(rawFilter) ? rawFilter : 'trending';
  const sort = VALID_SORTS.includes(rawSort) ? rawSort : 'volume';
  const order = VALID_ORDERS.includes(rawOrder) ? rawOrder : 'desc';

  if (GECKO_LIST_FILTERS.has(filter)) {
    return serveGeckoList(res, { filter, sort, order, limit: parseInt(limit) || 50, offset: parseInt(offset) || 0 });
  }

  // DB-backed filters (most_viewed, tech, meme) ignore sort/order, so they stay out of the key.
  // Key on the exact offset: bucketing by Math.floor(offset / limit) served offset=25 the
  // cached offset=0 window (and vice versa).
  const cacheKey = keys.tokenList(`${filter}-${limit}`, parseInt(offset) || 0);

  // Try cache first - use getWithMeta since we store with setWithTimestamp
  // Note: We refresh view counts even for cached responses since they're cheap to fetch
  const serveCached = async () => {
    const cachedMeta = await cache.getWithMeta(cacheKey);
    if (!cachedMeta || !cachedMeta.value) return false;
    // Privacy: Don't log cache details

    // Refresh view counts from database + buffer (cheap query, keeps views up-to-date)
    let tokens = cachedMeta.value;
    if (tokens && tokens.length > 0) {
      const addresses = tokens.map(t => t.address || t.mintAddress);
      const viewCounts = mergeViewCounts(await db.getTokenViewsBatch(addresses), addresses);
      tokens = tokens.map(t => ({
        ...t,
        views: viewCounts[t.address || t.mintAddress] || 0
      }));
    }

    res.json(tokens);
    return true;
  };
  if (await serveCached()) return;
  // Another request is already computing this key: wait for it, then serve what it cached
  if (listMissInFlight.has(cacheKey)) {
    await listMissInFlight.get(cacheKey);
    if (await serveCached()) return;
  }
  claimListMiss(cacheKey, res);

  let tokens;

  try {
    // Handle most_viewed filter separately - uses our local database
    // Optimized: Fetches metadata in batches to avoid rate limiting issues
    if (filter === 'most_viewed') {
      const mostViewed = await db.getMostViewedTokens(parseInt(limit), parseInt(offset));

      if (!mostViewed || mostViewed.length === 0) {
        return res.json([]);
      }

      // Get the token mints that have views
      const mints = mostViewed.map(v => v.token_mint);
      const viewCountMap = {};
      mostViewed.forEach(v => { viewCountMap[v.token_mint] = v.view_count; });

      // Step 1: Batch fetch from local database (fast, no API calls)
      const localTokens = await db.getTokensBatch(mints);
      const localTokenMap = {};
      if (localTokens) {
        localTokens.forEach(t => {
          if (t && t.mint_address) localTokenMap[t.mint_address] = t;
        });
      }

      // Step 2: Batch fetch metadata from Helius for tokens not in local DB
      const missingMints = mints.filter(m => !localTokenMap[m]?.name);
      let heliusMetadata = {};
      if (missingMints.length > 0 && solanaService.isHeliusConfigured()) {
        try {
          heliusMetadata = await getTokenMetadataBatchCached(missingMints);
        } catch (err) {
          if (err.isOverloaded || err.isCircuitBreakerError) throw err;
          console.warn('[Tokens] Helius batch metadata failed:', err.response?.status || err.message);
        }
      }

      // Step 3: Check cache for any remaining tokens (in parallel)
      const stillMissing = missingMints.filter(m => !heliusMetadata[m]?.name);
      const cacheResults = {};
      if (stillMissing.length > 0) {
        const cacheChecks = await Promise.all(
          stillMissing.map(async (mint) => {
            const cachedMeta = await cache.getWithMeta(keys.tokenInfo(mint))
              || await cache.getWithMeta(`batch:${mint}`);
            return { mint, value: cachedMeta?.value };
          })
        );
        for (const { mint, value } of cacheChecks) {
          if (value?.name) cacheResults[mint] = value;
        }
      }

      // Step 4: Build token list from available data (NO individual API calls)
      // Price data will be fetched on-demand when user clicks on token detail
      tokens = mints.map(mint => {
        const viewCount = viewCountMap[mint] || 0;
        const local = localTokenMap[mint];
        const helius = heliusMetadata[mint];
        const cached = cacheResults[mint];

        // Use best available data source (skip local if it has a placeholder name)
        const localHasRealName = local?.name && !PLACEHOLDER_NAMES.has(local.name.toLowerCase());
        if (localHasRealName) {
          return {
            mintAddress: mint,
            address: mint,
            name: local.name,
            symbol: local.symbol || mint.slice(0, 5).toUpperCase(),
            price: toNum(local.price),
            priceChange24h: local.price_change_24h != null ? parseFloat(local.price_change_24h) : null,
            volume24h: toNum(local.volume_24h),
            marketCap: parseFloat(local.market_cap) || null,
            logoUri: local.logo_uri || null,
            logoURI: local.logo_uri || null,
            views: viewCount
          };
        }

        if (helius?.name && !PLACEHOLDER_NAMES.has(helius.name.toLowerCase())) {
          return {
            mintAddress: mint,
            address: mint,
            name: helius.name,
            symbol: helius.symbol || mint.slice(0, 5).toUpperCase(),
            price: 0,
            priceChange24h: null,
            volume24h: 0,
            marketCap: null,
            logoUri: helius.logoUri || null,
            logoURI: helius.logoUri || null,
            views: viewCount
          };
        }

        const cachedHasRealName = cached?.name && !PLACEHOLDER_NAMES.has(cached.name.toLowerCase());
        if (cachedHasRealName) {
          return {
            mintAddress: mint,
            address: mint,
            name: cached.name,
            symbol: cached.symbol || mint.slice(0, 5).toUpperCase(),
            price: cached.price || 0,
            priceChange24h: cached.priceChange24h != null ? cached.priceChange24h : null,
            volume24h: cached.volume24h || 0,
            marketCap: cached.marketCap || null,
            logoUri: cached.logoUri || null,
            logoURI: cached.logoURI || null,
            views: viewCount
          };
        }

        // Fallback: minimal data (user can click to get full details)
        return {
          mintAddress: mint,
          address: mint,
          name: `${mint.slice(0, 4)}...${mint.slice(-4)}`,
          symbol: mint.slice(0, 5).toUpperCase(),
          price: 0,
          priceChange24h: null,
          volume24h: 0,
          marketCap: null,
          logoUri: null,
          logoURI: null,
          views: viewCount
        };
      });

      // Enrich tokens with sentiment scores and community update flags
      try {
        const addrs = tokens.map(t => t.address || t.mintAddress);
        const [sentimentResult, communityResult] = await Promise.allSettled([
          db.getSentimentBatch(addrs),
          db.hasApprovedSubmissionsBatch(addrs)
        ]);
        const sentimentScores = sentimentResult.status === 'fulfilled' ? sentimentResult.value : {};
        const communityMints = communityResult.status === 'fulfilled' ? communityResult.value : new Set();
        for (const token of tokens) {
          const addr = token.address || token.mintAddress;
          const s = sentimentScores[addr];
          token.sentimentScore = s ? s.score : 0;
          token.sentimentBullish = s ? s.bullish : 0;
          token.sentimentBearish = s ? s.bearish : 0;
          token.hasCommunityUpdates = communityMints.has(addr);
        }
      } catch { /* non-critical */ }

      // Cache the result (1 minute - balances freshness with performance)
      await cache.setWithTimestamp(cacheKey, tokens, TTL.MEDIUM);
      return res.json(tokens);
    }

    // Handle category filters (tech / meme) - tokens tagged by community submissions
    if (filter === 'tech' || filter === 'meme') {
      const mints = await db.getTokensByCategory(filter, parseInt(limit), parseInt(offset));

      if (!mints || mints.length === 0) {
        return res.json([]);
      }

      // Batch fetch from local database
      const localTokens = await db.getTokensBatch(mints);
      const localTokenMap = {};
      if (localTokens) {
        localTokens.forEach(t => {
          if (t && t.mint_address) localTokenMap[t.mint_address] = t;
        });
      }

      // Batch fetch metadata from Helius for tokens not in local DB
      const missingMints = mints.filter(m => !localTokenMap[m]?.name);
      let heliusMetadata = {};
      if (missingMints.length > 0 && solanaService.isHeliusConfigured()) {
        try {
          heliusMetadata = await getTokenMetadataBatchCached(missingMints);
        } catch (err) {
          if (err.isOverloaded || err.isCircuitBreakerError) throw err;
          console.warn('[Tokens] Helius batch metadata failed:', err.response?.status || err.message);
        }
      }

      // Check cache for remaining tokens (parallel lookups)
      const stillMissing = missingMints.filter(m => !heliusMetadata[m]?.name);
      const cacheResults = {};
      if (stillMissing.length > 0) {
        const cacheLookups = await Promise.all(
          stillMissing.map(async (mint) => {
            const cachedMeta = await cache.getWithMeta(keys.tokenInfo(mint))
              || await cache.getWithMeta(`batch:${mint}`);
            return [mint, cachedMeta?.value];
          })
        );
        for (const [mint, value] of cacheLookups) {
          if (value?.name) cacheResults[mint] = value;
        }
      }

      // Build token list from available data
      tokens = mints.map(mint => {
        const local = localTokenMap[mint];
        const helius = heliusMetadata[mint];
        const cached = cacheResults[mint];

        if (local?.name && !PLACEHOLDER_NAMES.has(local.name.toLowerCase())) {
          return {
            mintAddress: mint, address: mint,
            name: local.name, symbol: local.symbol || mint.slice(0, 5).toUpperCase(),
            price: toNum(local.price), priceChange24h: local.price_change_24h != null ? parseFloat(local.price_change_24h) : null,
            volume24h: toNum(local.volume_24h), marketCap: parseFloat(local.market_cap) || null,
            logoUri: local.logo_uri || null, logoURI: local.logo_uri || null,
            views: 0
          };
        }
        if (helius?.name && !PLACEHOLDER_NAMES.has(helius.name.toLowerCase())) {
          return {
            mintAddress: mint, address: mint,
            name: helius.name, symbol: helius.symbol || mint.slice(0, 5).toUpperCase(),
            price: 0, priceChange24h: null, volume24h: 0, marketCap: null,
            logoUri: helius.logoUri || null, logoURI: helius.logoUri || null,
            views: 0
          };
        }
        if (cached?.name && !PLACEHOLDER_NAMES.has(cached.name.toLowerCase())) {
          return {
            mintAddress: mint, address: mint,
            name: cached.name, symbol: cached.symbol || mint.slice(0, 5).toUpperCase(),
            price: cached.price || 0, priceChange24h: cached.priceChange24h != null ? cached.priceChange24h : null,
            volume24h: cached.volume24h || 0, marketCap: cached.marketCap || null,
            logoUri: cached.logoUri || null, logoURI: cached.logoURI || null,
            views: 0
          };
        }
        return {
          mintAddress: mint, address: mint,
          name: `${mint.slice(0, 4)}...${mint.slice(-4)}`, symbol: mint.slice(0, 5).toUpperCase(),
          price: 0, priceChange24h: null, volume24h: 0, marketCap: null,
          logoUri: null, logoURI: null, views: 0
        };
      });

      // Enrich with view counts, sentiment scores, and community flags in parallel
      const addresses = tokens.map(t => t.address);
      const [dbViewCounts, sentimentScores, communityMints] = await Promise.all([
        db.getTokenViewsBatch(addresses).catch(() => ({})),
        db.getSentimentBatch(addresses).catch(() => ({})),
        db.hasApprovedSubmissionsBatch(addresses).catch(() => new Set())
      ]);
      const viewCounts = mergeViewCounts(dbViewCounts, addresses);
      for (const token of tokens) {
        token.views = viewCounts[token.address] || 0;
        const s = sentimentScores[token.address];
        token.sentimentScore = s ? s.score : 0;
        token.sentimentBullish = s ? s.bullish : 0;
        token.sentimentBearish = s ? s.bearish : 0;
        token.hasCommunityUpdates = communityMints.has(token.address);
      }

      await cache.setWithTimestamp(cacheKey, tokens, TTL.MEDIUM);
      return res.json(tokens);
    }
  } catch (error) {
    if (error.isOverloaded || error.isCircuitBreakerError) throw error;
    // Privacy: Don't log error details or stack traces
    res.status(500).json({ error: 'Failed to fetch tokens' });
  }
}));

const MIN_SEARCH_RESULTS = 15;
const MAX_BATCH_SIZE = 50; // Limit batch requests to prevent abuse

// POST /api/tokens/batch - Get multiple tokens in one request (optimized for watchlist)
// This endpoint reduces N individual requests to 1 batch request
router.post('/batch', searchLimiter, asyncHandler(async (req, res) => {
  const { mints } = req.body;

  // Validate input
  if (!mints || !Array.isArray(mints)) {
    return res.status(400).json({ error: 'mints array required' });
  }

  if (mints.length === 0) {
    return res.json([]);
  }

  if (mints.length > MAX_BATCH_SIZE) {
    return res.status(400).json({
      error: `Maximum ${MAX_BATCH_SIZE} tokens per batch request`,
      requested: mints.length
    });
  }

  // Validate each mint is a valid Solana address
  const validMints = mints.filter(mint =>
    typeof mint === 'string' && SOLANA_ADDRESS_REGEX.test(mint)
  );

  if (validMints.length === 0) {
    return res.status(400).json({ error: 'No valid mint addresses provided' });
  }

  // Privacy: Don't log batch request details

  try {
    // Check cache for all mints in parallel
    const results = [];
    const uncachedMints = [];

    const cacheChecks = await Promise.all(
      validMints.map(async (mint) => {
        // Check full detail cache first, then batch-specific cache
        const detailCached = await cache.getWithMeta(keys.tokenInfo(mint));
        if (detailCached && detailCached.value) return { mint, cached: detailCached };
        const batchCached = await cache.getWithMeta(`batch:${mint}`);
        return { mint, cached: batchCached };
      })
    );

    for (const { mint, cached } of cacheChecks) {
      if (cached && cached.value) {
        results.push({ mint, data: cached.value, cached: true });
      } else {
        uncachedMints.push(mint);
      }
    }

    // Privacy: Don't log cache statistics

    // Batch fetch uncached tokens
    if (uncachedMints.length > 0) {
      // Local DB first: curated and previously seen tokens have a row with metadata and the
      // worker's market data. Helius (getAssetBatch, credits and a shared queue) is asked
      // only for mints the DB has no usable name for.
      // A failed read is not "no rows": entries built without the DB are served but not cached,
      // or every watchlist would show $0 prices for these mints until the cache expired.
      let dbFailed = false;
      const dbRows = await db.getTokensBatch(uncachedMints).catch(() => { dbFailed = true; return []; });

      const num = v => (v != null && v !== '' && Number.isFinite(parseFloat(v)) ? parseFloat(v) : null);
      const localTokens = {};
      if (dbRows) {
        for (const local of dbRows) {
          if (local && local.mint_address) {
            localTokens[local.mint_address] = {
              mintAddress: local.mint_address,
              address: local.mint_address,
              name: local.name,
              symbol: local.symbol,
              decimals: local.decimals,
              logoUri: local.logo_uri,
              logoURI: local.logo_uri || null,
              price: num(local.price) || 0,
              priceChange24h: num(local.price_change_24h),
              volume24h: num(local.volume_24h) || 0,
              marketCap: num(local.market_cap)
            };
          }
        }
      }
      const hasName = t => !!(t?.name && !PLACEHOLDER_NAMES.has(t.name.toLowerCase()));
      // Upstream lookups (Helius credits, GeckoTerminal quota) are for curated mints only: the
      // site shows no other token, and this route takes any caller-chosen list of mints.
      const curatedRows = await cache.getOrSet(CURATED_LIST_KEY, () => db.getCuratedTokens(), TTL.MEDIUM).catch(() => []);
      const curated = new Set((Array.isArray(curatedRows) ? curatedRows : []).map(t => t.mintAddress));
      // A DB row with a name but no logo still asks Helius, for the logo only
      const needHelius = uncachedMints.filter(m => curated.has(m) && (!hasName(localTokens[m]) || !localTokens[m].logoUri));
      const heliusData = needHelius.length > 0 && solanaService.isHeliusConfigured()
        ? await getTokenMetadataBatchCached(needHelius).catch(catchUnlessOverloaded({}))
        : {};

      // Priority 3: GeckoTerminal batch (market data) for curated mints with no DB row. Helius
      // names a token but has no price, so it can't stand in for the row's market data.
      let geckoData = {};
      const stillNeeded = uncachedMints.filter(m => curated.has(m) && !localTokens[m]);
      if (stillNeeded.length > 0 && stillNeeded.length <= 30) {
        try {
          geckoData = await geckoService.getMultiTokenInfo(stillNeeded);
        } catch (err) {
          // Privacy: Don't log error details
        }
      }

      // Combine all sources and cache results
      const cachePromises = [];
      for (const mint of uncachedMints) {
        let tokenData = null;
        const mintShort = `${mint.slice(0, 4)}...${mint.slice(-4)}`;
        const mintSymbol = mint.slice(0, 5).toUpperCase();

        const heliusHasName = hasName(heliusData[mint]);
        const localHasName = hasName(localTokens[mint]);
        const geckoHasName = hasName(geckoData[mint]);

        if (localHasName) {
          tokenData = localTokens[mint];
          if (!tokenData.logoUri && heliusData[mint]?.logoUri) {
            tokenData.logoUri = heliusData[mint].logoUri;
            tokenData.logoURI = heliusData[mint].logoUri;
          }
        } else if (heliusHasName) {
          const h = heliusData[mint];
          const g = geckoData[mint] || {};
          tokenData = {
            mintAddress: mint,
            address: mint,
            name: h.name,
            symbol: h.symbol || mintSymbol,
            decimals: pickDecimals(h.decimals),
            logoUri: h.logoUri || null,
            logoURI: h.logoUri || null,
            price: g.price || 0,
            priceChange24h: g.priceChange24h ?? null,
            volume24h: g.volume24h || 0,
            marketCap: g.marketCap || 0
          };
        } else if (geckoHasName) {
          const g = geckoData[mint];
          tokenData = {
            mintAddress: mint,
            address: mint,
            name: g.name,
            symbol: g.symbol || mintSymbol,
            decimals: pickDecimals(g.decimals),
            logoUri: g.logoUri || null,
            logoURI: g.logoUri || null,
            price: g.price || 0,
            priceChange24h: g.priceChange24h ?? null,
            volume24h: g.volume24h || 0,
            marketCap: g.marketCap || null
          };
        } else {
          // Fallback: minimal data with truncated mint as name
          tokenData = {
            mintAddress: mint,
            address: mint,
            name: mintShort,
            symbol: mintSymbol,
            decimals: 9,
            logoUri: null,
            logoURI: null,
            price: 0,
            priceChange24h: null,
            volume24h: 0,
            marketCap: 0
          };
        }

        // Cache under a batch-specific key so partial data doesn't pollute the
        // full token detail cache (which includes liquidity, holders, supply, etc.).
        // Not cached: entries built while the DB read failed, and placeholders for unknown
        // non-curated mints (a caller could otherwise fill Redis with random mints).
        if (tokenData) {
          if (!dbFailed && (localTokens[mint] || curated.has(mint))) {
            const batchCacheKey = `batch:${mint}`;
            cachePromises.push(cache.setWithTimestamp(batchCacheKey, tokenData, TTL.PRICE_DATA));
          }
          results.push({ mint, data: tokenData, cached: false });
        }
      }
      await Promise.all(cachePromises);
    }

    // Get view counts, sentiment scores, and community flags for all tokens
    const [dbViewCounts, sentimentScores, communityMints] = await Promise.all([
      db.getTokenViewsBatch(validMints),
      db.getSentimentBatch(validMints).catch(() => ({})),
      db.hasApprovedSubmissionsBatch(validMints).catch(() => new Set())
    ]);
    const viewCounts = mergeViewCounts(dbViewCounts, validMints);

    // Build final response array in original order
    const resultMap = new Map(results.map(r => [r.mint, r]));
    const response = validMints.map(mint => {
      const result = resultMap.get(mint);
      if (result && result.data) {
        const s = sentimentScores[mint];
        return {
          ...result.data,
          views: viewCounts[mint] || 0,
          sentimentScore: s ? s.score : 0,
          sentimentBullish: s ? s.bullish : 0,
          sentimentBearish: s ? s.bearish : 0,
          hasCommunityUpdates: communityMints.has(mint)
        };
      }
      return null;
    }).filter(Boolean);

    return res.json(response);

  } catch (error) {
    if (error.isOverloaded || error.isCircuitBreakerError) throw error;
    // Privacy: Don't log error details
    return res.status(500).json({ error: 'Failed to fetch token batch' });
  }
}));

// Allowed DEX prefixes for search filtering (covers Pumpfun, Pumpswap, Raydium)
const SEARCH_DEX_PREFIXES = ['raydium', 'pump'];

// GET /api/tokens/search - Search tokens (hybrid local + external)
router.get('/search', searchLimiter, validateSearch, asyncHandler(async (req, res) => {
  const { q } = req.query;
  const query = q.trim();
  // dex=1 means filter to major DEXes only (Pumpfun, Pumpswap, Raydium)
  const dexFilter = req.query.dex === '1';
  const cacheKey = keys.tokenSearch(query.toLowerCase(), dexFilter);

  // Try cache first
  const cached = await cache.get(cacheKey);
  if (cached) {
    return res.json(cached);
  }

  try {
    // Check if query is an exact contract address
    // Exact address lookups always bypass DEX filter
    const isExactAddress = SOLANA_ADDRESS_REGEX.test(query);

    if (isExactAddress) {
      // For exact addresses, fetch full token details directly
      let tokenInfo = null;

      // Try local database first
      const localToken = await db.getToken(query);
      if (localToken) {
        tokenInfo = {
          address: localToken.mint_address,
          name: localToken.name,
          symbol: localToken.symbol,
          decimals: localToken.decimals,
          logoURI: localToken.logo_uri,
          price: localToken.price ? parseFloat(localToken.price) : 0,
          marketCap: localToken.market_cap ? parseFloat(localToken.market_cap) : null,
          volume24h: localToken.volume_24h ? parseFloat(localToken.volume_24h) : null,
          source: 'local'
        };
      }

      // Check if local result has a placeholder name
      const localIsPlaceholder = tokenInfo && (
        !tokenInfo.name || PLACEHOLDER_NAMES.has(tokenInfo.name.toLowerCase())
      );

      // If not in local DB or local has placeholder name, fetch from external API
      if (!tokenInfo || localIsPlaceholder) {
        try {
          const externalInfo = await jupiterService.getTokenInfo(query);
          const hasRealName = externalInfo && externalInfo.name &&
            externalInfo.name.toLowerCase() !== 'unknown token' && externalInfo.name !== 'Unknown';
          if (hasRealName) {
            tokenInfo = {
              address: query,
              name: externalInfo.name,
              symbol: externalInfo.symbol,
              decimals: externalInfo.decimals,
              logoURI: externalInfo.logoUri,
              source: 'external'
            };

            // Cache to local database for future lookups - curated mints only. Anyone can
            // search any address, and every row written here would surface in local search
            // and /:mint/similar for good (nothing prunes the tokens table).
            db.isTokenAllowed(query).then(curated => curated && db.upsertToken({
              mintAddress: query,
              name: externalInfo.name,
              symbol: externalInfo.symbol,
              decimals: externalInfo.decimals,
              logoUri: externalInfo.logoUri
            })).catch(err => {
              console.warn('[Tokens] DB cache failed (non-critical):', err.code || 'unknown');
            });
          }
        } catch (err) {
          // Privacy: Don't log error details
        }
      }

      // Enrich with community flag
      if (tokenInfo) {
        try {
          const communityMints = await db.hasApprovedSubmissionsBatch([query]);
          tokenInfo.hasCommunityUpdates = communityMints.has(query);
        } catch { /* non-critical */ }
      }

      const results = tokenInfo ? [tokenInfo] : [];
      // Single-token lookups are pure metadata — cache longer
      await cache.set(cacheKey, results, results.length > 0 ? TTL.METADATA : TTL.MEDIUM);
      return res.json(results);
    }

    // For string searches, use hybrid approach
    let results = [];
    const seenAddresses = new Set();
    const dexPrefixes = dexFilter ? SEARCH_DEX_PREFIXES : null;

    // 1. Search local database first (skip when DEX filter active — local DB has no DEX info)
    if (!dexFilter && db.isReady()) {
      try {
        const localResults = await db.searchTokens(query, MIN_SEARCH_RESULTS);
        for (const token of localResults) {
          if (!seenAddresses.has(token.address)) {
            seenAddresses.add(token.address);
            // Ensure tokens matched by symbol/mint have display names
            const addr = token.address || '';
            if (!token.name || PLACEHOLDER_NAMES.has(token.name.toLowerCase())) {
              token.name = addr ? `${addr.slice(0, 4)}...${addr.slice(-4)}` : null;
            }
            if (!token.symbol) {
              token.symbol = addr ? addr.slice(0, 5).toUpperCase() : null;
            }
            results.push(token);
          }
        }
      } catch (err) {
        // Privacy: Don't log error details
      }
    }

    // 2. If local results are insufficient, fetch from external APIs in parallel
    if (results.length < MIN_SEARCH_RESULTS) try {
      // Jupiter results carry no DEX, so a DEX-filtered search uses GeckoTerminal only
      const [geckoResults, jupiterResults] = await Promise.all([
        geckoService.searchTokens(query, MIN_SEARCH_RESULTS, dexPrefixes).catch(catchUnlessOverloaded([])),
        dexFilter ? [] : jupiterService.searchTokens(query, MIN_SEARCH_RESULTS).catch(catchUnlessOverloaded([]))
      ]);

      // Merge results: GeckoTerminal first (free, no API key), then Jupiter
      const allExternal = [...(geckoResults || []), ...(jupiterResults || [])];

      for (const token of allExternal) {
        const address = token.address || token.mint;
        if (!address || !SOLANA_ADDRESS_REGEX.test(address)) continue;
        if (!seenAddresses.has(address)) {
          seenAddresses.add(address);
          results.push({
            address,
            name: token.name || `${address.slice(0, 4)}...${address.slice(-4)}`,
            symbol: token.symbol || address.slice(0, 5).toUpperCase(),
            decimals: token.decimals,
            logoURI: token.logoURI || token.logoUri || token.logo,
            price: token.price || 0,
            priceChange24h: token.priceChange24h ?? null,
            volume24h: token.volume24h ?? null,
            marketCap: token.marketCap ?? null,
            source: 'external'
          });

          if (results.length >= MIN_SEARCH_RESULTS) break;
        }
      }
    } catch (err) {
      if (err.isOverloaded || err.isCircuitBreakerError) throw err;
      // Privacy: Don't log error details for normal API failures
    }

    // Enrich with community update flags
    if (results.length > 0) {
      try {
        const addrs = results.map(t => t.address);
        const communityMints = await db.hasApprovedSubmissionsBatch(addrs);
        for (const token of results) {
          token.hasCommunityUpdates = communityMints.has(token.address);
        }
      } catch { /* non-critical */ }
    }

    // Cache results for 1 minute
    await cache.set(cacheKey, results, TTL.MEDIUM);

    res.json(results);
  } catch (error) {
    if (error.isOverloaded || error.isCircuitBreakerError) throw error;
    // Privacy: Don't log error details
    res.status(500).json({ error: 'Failed to search tokens' });
  }
}));

// Every (limit, offset) pair is its own cache key and a miss can cost a Helius call, so the
// offset is bounded: no leaderboard holds anywhere near this many tokens
const MAX_LEADERBOARD_OFFSET = 1000;

// GET /api/tokens/leaderboard/watchlist - Most watchlisted tokens
router.get('/leaderboard/watchlist', asyncHandler(async (req, res) => {
  const limit = Math.min(Math.max(1, parseInt(req.query.limit) || 25), 100);
  const offset = Math.min(MAX_LEADERBOARD_OFFSET, Math.max(0, parseInt(req.query.offset) || 0));

  const cacheKey = `leaderboard:watchlist:${limit}:${offset}`;
  const cached = await cache.get(cacheKey);
  if (cached) return res.json(cached);

  const { tokens: rows, total } = await db.getMostWatchlistedTokens(limit, offset);

  if (!rows || rows.length === 0) {
    const empty = { tokens: [], total: 0 };
    await cache.set(cacheKey, empty, TTL.MEDIUM);
    return res.json(empty);
  }

  // Build token list from DB data, enriching missing metadata
  const mints = rows.map(r => r.token_mint);
  const watchCountMap = {};
  rows.forEach(r => { watchCountMap[r.token_mint] = parseInt(r.watchlist_count); });

  // Batch fetch from local DB for any tokens missing metadata
  const missingMints = rows.filter(r => !r.name).map(r => r.token_mint);
  let heliusMetadata = {};
  if (missingMints.length > 0 && solanaService.isHeliusConfigured()) {
    try {
      heliusMetadata = await getTokenMetadataBatchCached(missingMints);
    } catch (err) { /* continue without */ }
  }

  const tokens = rows.map(r => {
    const helius = heliusMetadata[r.token_mint];
    return {
      mintAddress: r.token_mint,
      address: r.token_mint,
      name: r.name || helius?.name || `${r.token_mint.slice(0, 4)}...${r.token_mint.slice(-4)}`,
      symbol: r.symbol || helius?.symbol || r.token_mint.slice(0, 5).toUpperCase(),
      price: parseFloat(r.price) || 0,
      priceChange24h: r.price_change_24h != null ? parseFloat(r.price_change_24h) : null,
      volume24h: parseFloat(r.volume_24h) || 0,
      marketCap: parseFloat(r.market_cap) || null,
      logoUri: r.logo_uri || helius?.logoUri || null,
      logoURI: r.logo_uri || helius?.logoUri || null,
      watchlistCount: watchCountMap[r.token_mint] || 0
    };
  });

  // Enrich with sentiment scores
  try {
    const sentimentScores = await db.getSentimentBatch(mints);
    for (const token of tokens) {
      const s = sentimentScores[token.address];
      token.sentimentScore = s ? s.score : 0;
      token.sentimentBullish = s ? s.bullish : 0;
      token.sentimentBearish = s ? s.bearish : 0;
    }
  } catch { /* non-critical */ }

  const result = { tokens, total };
  await cache.set(cacheKey, result, TTL.MEDIUM);
  res.json(result);
}));

// GET /api/tokens/leaderboard/sentiment - Top sentiment tokens
router.get('/leaderboard/sentiment', asyncHandler(async (req, res) => {
  const limit = Math.min(Math.max(1, parseInt(req.query.limit) || 25), 100);
  const offset = Math.min(MAX_LEADERBOARD_OFFSET, Math.max(0, parseInt(req.query.offset) || 0));

  const cacheKey = `leaderboard:sentiment:${limit}:${offset}`;
  const cached = await cache.get(cacheKey);
  if (cached) return res.json(cached);

  const { tokens: rows, total } = await db.getTopSentimentTokens(limit, offset);

  if (!rows || rows.length === 0) {
    const empty = { tokens: [], total: 0 };
    await cache.set(cacheKey, empty, TTL.MEDIUM);
    return res.json(empty);
  }

  // Build token list from DB data, enriching missing metadata
  const mints = rows.map(r => r.token_mint);

  const missingMints = rows.filter(r => !r.name).map(r => r.token_mint);
  let heliusMetadata = {};
  if (missingMints.length > 0 && solanaService.isHeliusConfigured()) {
    try {
      heliusMetadata = await getTokenMetadataBatchCached(missingMints);
    } catch (err) { /* continue without */ }
  }

  const tokens = rows.map(r => {
    const helius = heliusMetadata[r.token_mint];
    return {
      mintAddress: r.token_mint,
      address: r.token_mint,
      name: r.name || helius?.name || `${r.token_mint.slice(0, 4)}...${r.token_mint.slice(-4)}`,
      symbol: r.symbol || helius?.symbol || r.token_mint.slice(0, 5).toUpperCase(),
      price: parseFloat(r.price) || 0,
      priceChange24h: r.price_change_24h != null ? parseFloat(r.price_change_24h) : null,
      volume24h: parseFloat(r.volume_24h) || 0,
      marketCap: parseFloat(r.market_cap) || null,
      logoUri: r.logo_uri || helius?.logoUri || null,
      logoURI: r.logo_uri || helius?.logoUri || null,
      sentimentScore: r.score || 0,
      sentimentBullish: r.bullish || 0,
      sentimentBearish: r.bearish || 0
    };
  });

  const result = { tokens, total };
  await cache.set(cacheKey, result, TTL.MEDIUM);
  res.json(result);
}));

// GET /api/tokens/leaderboard/calls - Most called tokens (24h rolling window)
router.get('/leaderboard/calls', asyncHandler(async (req, res) => {
  const limit = Math.min(Math.max(1, parseInt(req.query.limit) || 25), 100);
  const offset = Math.min(MAX_LEADERBOARD_OFFSET, Math.max(0, parseInt(req.query.offset) || 0));

  const cacheKey = `leaderboard:calls:${limit}:${offset}`;
  const cached = await cache.get(cacheKey);
  if (cached) return res.json(cached);

  const { tokens: rows, total } = await db.getMostCalledTokens(limit, offset);

  if (!rows || rows.length === 0) {
    const empty = { tokens: [], total: 0 };
    await cache.set(cacheKey, empty, TTL.MEDIUM);
    return res.json(empty);
  }

  const missingMints = rows.filter(r => !r.name).map(r => r.token_mint);
  let heliusMetadata = {};
  if (missingMints.length > 0 && solanaService.isHeliusConfigured()) {
    try {
      heliusMetadata = await getTokenMetadataBatchCached(missingMints);
    } catch (err) { /* continue without */ }
  }

  const tokens = rows.map(r => {
    const helius = heliusMetadata[r.token_mint];
    return {
      mintAddress: r.token_mint,
      address: r.token_mint,
      name: r.name || helius?.name || `${r.token_mint.slice(0, 4)}...${r.token_mint.slice(-4)}`,
      symbol: r.symbol || helius?.symbol || r.token_mint.slice(0, 5).toUpperCase(),
      price: parseFloat(r.price) || 0,
      priceChange24h: r.price_change_24h != null ? parseFloat(r.price_change_24h) : null,
      volume24h: parseFloat(r.volume_24h) || 0,
      marketCap: parseFloat(r.market_cap) || null,
      logoUri: r.logo_uri || helius?.logoUri || null,
      logoURI: r.logo_uri || helius?.logoUri || null,
      callCount: parseInt(r.call_count) || 0
    };
  });

  const result = { tokens, total };
  await cache.set(cacheKey, result, TTL.MEDIUM);
  res.json(result);
}));

// GET /api/tokens/leaderboard/conviction - Top tokens by >1M holder conviction
// Reads from persistent DB storage (populated whenever diamond-hands completes).
// Falls back to scanning cached diamond-hands keys for tokens not yet persisted.
router.get('/leaderboard/conviction', asyncHandler(async (req, res) => {
  const limit = Math.min(Math.max(1, parseInt(req.query.limit) || 25), 100);
  const offset = Math.max(0, parseInt(req.query.offset) || 0);

  const filters = {};
  if (req.query.minConviction != null) filters.minConviction = Math.max(0, Math.min(100, parseFloat(req.query.minConviction) || 0));
  if (req.query.minMcap != null) filters.minMcap = Math.max(0, parseFloat(req.query.minMcap) || 0);
  if (req.query.maxMcap != null) filters.maxMcap = Math.max(0, parseFloat(req.query.maxMcap) || 0);
  if (req.query.minSample != null) filters.minSample = Math.max(0, parseInt(req.query.minSample) || 0);
  if (typeof req.query.search === 'string' && req.query.search) filters.search = req.query.search.slice(0, 100);

  const filterKey = JSON.stringify(filters);
  const resultCacheKey = `leaderboard:conviction:${limit}:${offset}:${filterKey}`;
  // A search result is a one-off subset of the unfiltered page: keep it only briefly
  const resultTtl = filters.search ? TTL.MEDIUM : TTL.LONG;
  let computed = false;
  // getOrSet: concurrent misses (several viewers at expiry) share one computation
  const result = await cache.getOrSet(resultCacheKey, async () => {
    computed = true;
    // Primary source: DB (persistent, survives cache expiry). A failed read throws out of
    // getOrSet, so nothing is cached: an empty board stored here blanked every home tab for
    // the whole TTL after a momentary Postgres error.
    const { tokens: dbRows, total } = await db.getTopConvictionTokens(limit, offset, filters);

    const tokens = dbRows.map(row => {
      let distribution = {};
      try {
        distribution = typeof row.conviction_data === 'string'
          ? JSON.parse(row.conviction_data)
          : row.conviction_data || {};
      } catch { /* malformed JSON — use empty */ }
      return {
        mintAddress: row.mint_address,
        address: row.mint_address,
        name: row.name || `${row.mint_address.slice(0, 4)}...${row.mint_address.slice(-4)}`,
        symbol: row.symbol || row.mint_address.slice(0, 5).toUpperCase(),
        price: parseFloat(row.price) || 0,
        // 24h, 7d and 30d change against stored reference prices (services/priceChanges.js)
        ...priceChanges.changesForRow(row),
        volume24h: parseFloat(row.volume_24h) || 0,
        marketCap: parseFloat(row.market_cap) || null,
        logoUri: row.logo_uri || null,
        logoURI: row.logo_uri || null,
        conviction: distribution,
        conviction1m: parseFloat(row.conviction_1m) || 0,
        sampleSize: row.conviction_sample_size || 0,
        analyzed: row.conviction_sample_size || 0,
        convictionUpdatedAt: row.conviction_computed_at || null,
        // Token age for the home tables: under 3 months there are no 3-month holders to count
        pairCreatedAt: row.pair_created_at || null,
        mcapAtAdded: row.mcap_at_added != null ? parseFloat(row.mcap_at_added) : null,
        mcapAth: row.mcap_ath != null ? parseFloat(row.mcap_ath) : null,
        emergingCult: row.is_emerging_cult || false,
        techCoin: row.is_tech_coin || false,
        holders: null,
        holderVelocity: null,
        // Latest daily Diamond Hands score (services/kingOfPill.js); the table's default order
        diamondHandsScore: null,
        diamondHandsScoreDate: null
      };
    });

    if (tokens.length > 0 && db.pool) {
      const scores = await require('../services/kingOfPill').getLatestScores(tokens.map(t => t.mintAddress)).catch(() => ({}));
      for (const t of tokens) {
        const s = scores[t.mintAddress];
        if (s) { t.diamondHandsScore = s.score; t.diamondHandsScoreDate = s.date; }
      }
    }

    // Holder counts: Redis, else the latest holder snapshot's count from Postgres.
    // Velocity: 24h change between holder snapshots (holderCounts.holderVelocity).
    if (tokens.length > 0) {
      const mints = tokens.map(t => t.mintAddress);
      const [counts, velocity] = await Promise.all([
        holderCounts.getDisplayCounts(mints).catch(() => ({})),
        db.pool ? holderCounts.getHolderVelocity(mints).catch(() => ({})) : {},
      ]);
      for (const t of tokens) {
        if (counts[t.mintAddress]) t.holders = counts[t.mintAddress];
        t.holderVelocity = velocity[t.mintAddress] || { level: null };
      }
    }

    // Queue background Helius fetches for any tokens still missing holder counts
    if (solanaService.isHeliusConfigured()) {
      const missing = tokens.filter(t => !t.holders);
      if (missing.length > 0) {
        jobQueue.addAnalyticsJob('fetch-holder-counts-batch', {
          mints: missing.map(t => t.mintAddress)
        }).catch(() => {});
      }
    }

    return { tokens, total };
  }, resultTtl);

  // Enrich cached result with any holder counts fetched since this result was cached
  if (!computed && result.tokens && result.tokens.length > 0) {
    const need = result.tokens.filter(t => !t.holders);
    const counts = need.length ? await holderCounts.getDisplayCounts(need.map(t => t.mintAddress)).catch(() => ({})) : {};
    for (const t of need) if (counts[t.mintAddress]) t.holders = counts[t.mintAddress];
  }
  res.json(result);
}));

// GET /api/tokens/king-of-pill - The featured token in the banner on the main page.
// The automatic King (services/kingOfPill.js: the top daily Diamond Hands score with a
// rotation rule) unless an admin override mint is set, which always wins.
router.get('/king-of-pill', asyncHandler(async (req, res) => {
  const cacheKey = 'king-of-pill:featured';
  // getOrSet: concurrent misses share one read. No King is not cached (null), as before.
  const result = await cache.getOrSet(cacheKey, async () => {
    const manual = await db.getSetting('king_of_pill_mint');
    let mint = manual || null;
    let kotp = null;
    if (manual) {
      kotp = { mode: 'manual' };
    } else {
      const king = await require('../services/kingOfPill').getCurrentKing().catch(err => {
        console.error('[KotP] Read failed:', err.message);
        return null;
      });
      if (king) {
        mint = king.mint;
        kotp = { mode: 'auto', score: king.score, scoreDate: king.scoreDate, reignDay: king.reignDay, crownedOn: king.crownedOn,
                 contenders: king.contenders.map(c => ({ name: c.name, symbol: c.symbol, score: c.score })) };
      }
    }
    if (!mint) return null;

    // Fetch basic token data from DB (name, symbol, logo)
    const row = await db.getToken(mint);
    if (!row) return null;

    // Layer in live price/change from cache if available.
    // Price cache uses setWithTimestamp so we need getWithMeta to unwrap the _data envelope.
    const priceMeta = await cache.getWithMeta(`price:${mint}`);
    const priceData = priceMeta?.value;

    const token = {
      mintAddress: mint,
      name: row.name || null,
      symbol: row.symbol || null,
      logoUri: row.logo_uri || null,
      price: priceData?.price ?? (row.price ? parseFloat(row.price) : null),
      priceChange24h: priceData?.priceChange24h ?? (row.price_change_24h != null ? parseFloat(row.price_change_24h) : null),
      kotp,
    };

    return { token };
  }, TTL.LONG);
  res.json(result || { token: null });
}));

// GET /api/tokens/benchmarks - SOL and BTC 24h price change used by the "vs SOL" tab
// Cached 5 minutes — CoinGecko simple/price endpoint, free tier, no key required.
router.get('/benchmarks', asyncHandler(async (req, res) => {
  const cacheKey    = 'benchmarks:sol-btc';
  const lastGoodKey = 'benchmarks:sol-btc:last-good';

  try {
    // getOrSet: concurrent misses share one CoinGecko call. The last-good fallback stays
    // on the catch path below so stale data is never cached under the 5-minute key.
    const result = await cache.getOrSet(cacheKey, async () => {
      // Public CoinGecko API (a few req/min per IP): spaced by the default limiter
      const response = await rateLimitedRequest('coingeckoPublic', () => axios.get(
        'https://api.coingecko.com/api/v3/simple/price',
        {
          params: { ids: 'solana,bitcoin', vs_currencies: 'usd', include_24hr_change: true },
          timeout: 8000,
          headers: { Accept: 'application/json' }
        }
      ));
      const data = response.data || {};

      // Merge with last-good data so a partial response (price OK, change null) doesn't
      // wipe a previously-known price_change_24h value out of the active cache.
      const lastGood = await cache.get(lastGoodKey);
      const result = {
        sol: {
          price: data.solana?.usd ?? lastGood?.sol?.price ?? null,
          priceChange24h: data.solana?.usd_24h_change ?? lastGood?.sol?.priceChange24h ?? null
        },
        btc: {
          price: data.bitcoin?.usd ?? lastGood?.btc?.price ?? null,
          priceChange24h: data.bitcoin?.usd_24h_change ?? lastGood?.btc?.priceChange24h ?? null
        },
        updatedAt: Date.now(),
      };
      // Keep a long-lived copy so CoinGecko outages can serve stale-but-real data
      if (result.sol.price != null || result.btc.price != null) {
        await cache.set(lastGoodKey, result, TTL.DAY);
      }
      return result;
    }, TTL.LONG);
    res.json(result);
  } catch (err) {
    console.warn('[benchmarks] CoinGecko fetch failed:', err.message);
    // Prefer stale real data over nulls — the frontend will display it with existing context
    const lastGood = await cache.get(lastGoodKey);
    if (lastGood) {
      console.warn('[benchmarks] Serving last-known-good benchmark data');
      return res.json(lastGood);
    }
    res.json({ sol: { price: null, priceChange24h: null }, btc: { price: null, priceChange24h: null } });
  }
}));

// GET /api/tokens/spikes - Detect established tokens (>1d old) with unusual activity spikes
// Scans trending pools, filters to tokens older than 1 day, and scores by spike indicators:
// - Volume/MCap ratio (high ratio = unusual volume relative to size)
// - Price change magnitude (large moves in either direction)
// - Transaction count (high trading activity)
// - Holder count (from Birdeye, fetched for top candidates)
// Cached for 2 minutes to avoid hammering upstream APIs.
// IMPORTANT: Must be registered before /:mint to avoid Express treating "spikes" as a mint param.
router.get('/spikes', searchLimiter, asyncHandler(async (req, res) => {
  const { minAge = 1, limit = 30 } = req.query;
  const minAgeDays = Math.max(1, Math.min(30, parseInt(minAge) || 1));
  const resultLimit = Math.max(1, Math.min(50, parseInt(limit) || 30));

  // One scan serves every minAge/limit: it keeps each token at least a day old with its age,
  // and the request filters and slices it (a key per minAge x limit multiplied Helius calls)
  const cacheKey = 'spikes:scan';
  // An empty scan is not stored under cacheKey (it is usually an upstream blip, and the next
  // good scan should replace it at once), but it is remembered briefly here: during a
  // GeckoTerminal 429 every request would otherwise run fresh trending fetches through the
  // shared limiter (the breaker does not open on 429s, and empty pages are not cached).
  const emptyKey = 'spikes:empty';
  try {
    if (await cache.get(emptyKey)) return res.json({ tokens: [], updatedAt: Date.now() });
    // getOrSet: concurrent misses share one scan of the trending pools
    const scan = await cache.getOrSet(cacheKey, async () => {
      // Step 1: Fetch trending pools from GeckoTerminal
      // First try to reuse token list cache (populated by /api/tokens?filter=trending)
      // to avoid redundant GeckoTerminal calls that compete for the shared rate limiter.
      const useHeliusEnrichment = solanaService.isHeliusConfigured();
      let allTokens = [];

      // Check if the main token list already has cached trending data
      // Deep-copy to avoid mutating the cached objects (we modify pairCreatedAt, name, etc. below)
      const cachedList = await cache.getWithMeta(geckoListKey('trending'));
      if (cachedList && cachedList.value && Array.isArray(cachedList.value.tokens) && cachedList.value.tokens.length > 0) {
        allTokens = cachedList.value.tokens.map(t => ({ ...t }));
      } else {
        // No cached trending data — fetch from GeckoTerminal (2 pages, not 3, to reduce load)
        // (through the list route's per-page cache, so the two share Gecko pages)
        const pageFetches = [1, 2].map(page =>
          getGeckoListPage('trending', page, useHeliusEnrichment)
            .catch(catchUnlessOverloaded([]))
        );
        const pages = await Promise.all(pageFetches);
        for (const pageTokens of pages) {
          if (pageTokens) allTokens = allTokens.concat(pageTokens.map(t => ({ ...t })));
        }
      }

      // Deduplicate by address
      const seen = new Set();
      allTokens = allTokens.filter(t => {
        const addr = t.address || t.mintAddress;
        if (!addr || seen.has(addr)) return false;
        seen.add(addr);
        return true;
      });

      // An empty scan is not cached (null): it is usually an upstream blip
      if (allTokens.length === 0) return null;

      // Step 2: Get pool creation dates for age filtering
      // Trending tokens carry their pool's pool_created_at as pairCreatedAt; a token
      // without one (older cached pages) falls back to the date stored in the DB.
      const minAgeMs = 1 * 24 * 60 * 60 * 1000;
      const now = Date.now();

      // For tokens without pairCreatedAt, try to get it from the DB
      const needsCreationDate = allTokens.filter(t => !t.pairCreatedAt && !t.createdAt);
      if (needsCreationDate.length > 0) {
        const dbTokens = await db.getTokensBatch(needsCreationDate.map(t => t.address || t.mintAddress)).catch(() => []);
        const dbMap = {};
        if (dbTokens) {
          dbTokens.forEach(t => {
            if (t && t.mint_address && t.pair_created_at) {
              dbMap[t.mint_address] = t.pair_created_at;
            }
          });
        }
        for (const token of needsCreationDate) {
          const addr = token.address || token.mintAddress;
          if (dbMap[addr]) {
            token.pairCreatedAt = dbMap[addr];
          }
        }
      }

      // Step 3: Filter to tokens older than minAge
      const established = allTokens.filter(t => {
        const createdStr = t.pairCreatedAt || t.createdAt;
        if (!createdStr) return false; // Skip tokens with unknown age
        const createdMs = new Date(createdStr).getTime();
        if (isNaN(createdMs)) return false;
        return (now - createdMs) >= minAgeMs;
      });

      if (established.length === 0) return null;

      // Step 4: Enrich with Helius metadata (name, symbol, logo)
      if (useHeliusEnrichment) {
        const needsEnrichment = established.filter(t => !t.name || !t.symbol || (!t.logoUri && !t.logoURI));
        if (needsEnrichment.length > 0) {
          try {
            const addresses = needsEnrichment.map(t => t.address || t.mintAddress);
            const metadata = await getTokenMetadataBatchCached(addresses);
            for (const token of needsEnrichment) {
              const addr = token.address || token.mintAddress;
              const meta = metadata[addr];
              if (meta) {
                if (!token.name || token.name === token.symbol) token.name = meta.name || token.name;
                if (!token.symbol || token.symbol === '???' || token.symbol === (addr || '').slice(0, 5).toUpperCase()) token.symbol = meta.symbol || token.symbol;
                if (!token.logoUri && !token.logoURI) {
                  token.logoUri = meta.logoUri || null;
                  token.logoURI = meta.logoUri || null;
                }
              }
            }
          } catch (e) { /* non-critical */ }
        }
      }

      // Step 5: Fetch holder counts from Birdeye using batch endpoint
      // Uses getMultiTokenPrices which accepts up to 100 addresses in a single call,
      // then falls back to individual getTokenOverview only for the top 5 candidates
      // that need holder data (getMultiTokenPrices returns mc but not holder count).
      const prelimScored = established.map(t => {
        const volMcapRatio = (t.marketCap > 0) ? (t.volume24h || 0) / t.marketCap : 0;
        const absChange = Math.abs(t.priceChange24h || 0);
        const txns = t.transactions24h || 0;
        return { ...t, _prelimScore: volMcapRatio * 30 + absChange + txns * 0.01 };
      }).sort((a, b) => b._prelimScore - a._prelimScore);

  // Step 6: Calculate spike scores
      const scored = prelimScored.map(token => {
        const addr = token.address || token.mintAddress;
        const volume = token.volume24h || 0;
        const mcap = token.marketCap || 0;
        const priceChange = token.priceChange24h || 0;
        const txns = token.transactions24h || 0;

        // Volume/MCap ratio — a $500K mcap token with $2M volume is spiking hard
        const volMcapRatio = mcap > 0 ? volume / mcap : 0;

        // Score components (weighted)
        const volumeScore = Math.min(volMcapRatio * 30, 40);        // 0-40 points
        const priceScore = Math.min(Math.abs(priceChange) / 2, 30); // 0-30 points
        const txnScore = Math.min(txns / 100, 20);                  // 0-20 points

        const spikeScore = Math.round((volumeScore + priceScore + txnScore) * 10) / 10;

        // Determine spike types
        const spikeTypes = [];
        if (volMcapRatio > 0.5) spikeTypes.push('volume');
        if (Math.abs(priceChange) > 15) spikeTypes.push('price');
        if (txns > 500) spikeTypes.push('transactions');

        // Calculate age in days
        const createdStr = token.pairCreatedAt || token.createdAt;
        const ageDays = createdStr ? Math.round((now - new Date(createdStr).getTime()) / 86400000 * 10) / 10 : null;

        return {
          mintAddress: addr,
          address: addr,
          name: token.name || `${addr.slice(0, 4)}...${addr.slice(-4)}`,
          symbol: token.symbol || addr.slice(0, 5).toUpperCase(),
          logoUri: token.logoUri || token.logoURI || null,
          price: token.price || 0,
          priceChange24h: priceChange,
          volume24h: volume,
          marketCap: mcap,
          fdv: token.fdv || 0,
          liquidity: token.liquidity || 0,
          holders: null,
          transactions24h: txns,
          volMcapRatio: Math.round(volMcapRatio * 1000) / 1000,
          ageDays,
          spikeScore,
          spikeTypes,
          poolAddress: token.poolAddress || null
        };
      });

      // Sort by spike score descending
      scored.sort((a, b) => b.spikeScore - a.spikeScore);

      return { tokens: scored, updatedAt: Date.now(), totalScanned: allTokens.length };
    }, TTL.MEDIUM);

    if (!scan) {
      await cache.set(emptyKey, true, TTL.SHORT);
      return res.json({ tokens: [], updatedAt: Date.now() });
    }
    const established = scan.tokens.filter(t => t.ageDays != null && t.ageDays >= minAgeDays);
    res.json({
      tokens: established.slice(0, resultLimit),
      updatedAt: scan.updatedAt,
      totalScanned: scan.totalScanned,
      totalEstablished: established.length
    });
  } catch (error) {
    if (error.isOverloaded || error.isCircuitBreakerError) throw error;
    console.error('[Spikes] Error:', error.message);
    res.status(500).json({ error: 'Failed to detect spike tokens' });
  }
}));

// GET /api/tokens/:mint - Get single token details
// Uses 5-minute cache but requires data < 1 minute old (fresh) for individual token views
// Optimized: Uses getOrSetWithFreshness for stampede prevention on concurrent requests
router.get('/:mint', validateMint, requireAllowedToken, asyncHandler(async (req, res) => {
  const { mint } = req.params;
  const cacheKey = keys.tokenInfo(mint);

  // Privacy: Don't log token addresses

  try {
    // Evict partial data left by the batch endpoint (which shares the same cache key).
    // Batch-cached tokens lack detail-only fields like submissions, pairCreatedAt, etc.
    // Without this check the detail endpoint returns incomplete data to the frontend.
    const existing = await cache.getWithMeta(cacheKey);
    if (existing && existing.value && !existing.value.submissions) {
      await cache.delete(cacheKey);
    }

    // A full detail entry is served from the read above (requireFresh is off, so
    // getOrSetWithFreshness would only read and parse the same value again).
    const hit = existing && existing.value && existing.value.submissions ? existing.value : null;

    // Set only by the request that ran the fetch below: a degraded result is re-cached
    // briefly by that request alone, never again on later cache hits (which would keep
    // pushing its expiry out and stop the retry from ever happening).
    let degraded = false;

    // Use getOrSetWithFreshness for stampede prevention
    // If multiple requests come in for the same token, they share one API fetch
    const result = hit || await cache.getOrSetWithFreshness(cacheKey, async () => {
      // Fetch core data in parallel — holder count uses cache-first to avoid
      // blocking on paginated Helius DAS calls (which can take 2-30s for popular tokens).
      let geckoTimedOut = false;
      // A failed DB side-read builds a page without banner/socials/curated stats/views
      let dbFailed = false;
      const dbFallback = (value) => () => { dbFailed = true; return value; };
      const fetchPromises = [
        // Helius provides: metadata, supply, price (for top 10k tokens)
        solanaService.isHeliusConfigured()
          ? solanaService.getTokenMetadata(mint).catch(catchUnlessOverloaded(null))
          : Promise.resolve(null),
        // GeckoTerminal pools: volume, price change, liquidity + coingeckoId
        // 5s timeout — rate-limited Gecko shouldn't stall the entire page load.
        // geckoPartial:true is set on the result so the frontend can retry market data.
        Promise.race([
          geckoService.getTokenOverview(mint),
          new Promise((_, reject) =>
            setTimeout(() => reject(Object.assign(new Error('gecko-timeout'), { isGeckoTimeout: true })), 5000)
          )
        ]).catch(err => {
          // Any GeckoTerminal failure, including its breaker being open or its request queue
          // being full, serves partial data: the Helius metadata is still good, and geckoPartial
          // keeps the zero-valued market data cached for 30s, not 10 minutes, and makes the
          // frontend retry. (getTokenOverview answers null only for a token it does not index.)
          geckoTimedOut = true;
          console.warn(`[Tokens] GeckoTerminal unavailable (${err.message}) for ${mint.slice(0, 8)}... — serving partial data`);
          return null;
        }),
        db.getApprovedSubmissions(mint).catch(dbFallback([])),
        holderCounts.getDisplayCounts([mint]).then(c => c[mint] || null).catch(() => null),
        // View count and curated data: independent of the above, so fetched alongside them
        db.getTokenViews(mint).catch(dbFallback(null)),
        db.getCuratedToken(mint).catch(dbFallback(null)),
        // Locked/burnt amounts for the circulating figure, when the holders panel has them
        cache.get(`holder-analytics:${mint}`).catch(() => null)
      ];

      const results = await Promise.all(fetchPromises);
      const [heliusMetadata, geckoOverview, submissions, cachedHolders, dbViews, curated, holderAnalytics] = results;

      // Use cached holder count; if missing, queue a background fetch via worker
      let holders = (typeof cachedHolders === 'number' && cachedHolders > 0) ? cachedHolders : null;
      if (!holders && solanaService.isHeliusConfigured()) {
        jobQueue.addAnalyticsJob('fetch-holder-counts-batch', { mints: [mint] }).catch(() => {});
      }

      // Privacy: Don't log API response details

      // Data priority:
      // - Metadata (name, symbol, decimals): Helius > GeckoTerminal > Jupiter fallback
      // - Price: GeckoTerminal (more accurate) > Helius (only top 10k, cached)
      // - Volume, price change, liquidity: GeckoTerminal only
      const helius = heliusMetadata || {};
      const gecko = geckoOverview || {};

      // Calculate supply - prefer Helius (more accurate), fallback to GeckoTerminal
      const decimals = pickDecimals(helius.decimals, gecko.decimals);
      let supply = helius.supply || null;
      if (!supply && gecko.totalSupply) {
        const rawSupply = parseFloat(gecko.totalSupply);
        supply = rawSupply / Math.pow(10, decimals);
      }
      // Circulating = total less Streamflow-locked and burn-wallet supply, as the holders
      // panel computes it; until that classification exists it can only be the total.
      const circulatingSupply = circulatingFromAnalytics(holderAnalytics?.supply) ?? supply;

      const usdPrice = gecko.price || helius.price || 0;
      const impliedFdv = usdPrice > 0 && supply > 0 ? usdPrice * supply : null;

      // Jupiter name fallback (only when Helius and GeckoTerminal both lack name)
      const jupiterMeta = (!helius.name && !gecko.name)
        ? await jupiterService.getTokenInfo(mint).catch(err => {
            if (err.isCircuitBreakerError || err.isOverloaded) throw err;
            console.warn(`[Tokens] Jupiter metadata fallback failed for ${mint.slice(0, 8)}...: ${err.response?.status || err.message}`);
            return null;
          })
        : null;
      const jup = jupiterMeta || {};

      const tokenResult = {
        mintAddress: mint,
        address: mint,
        // Metadata: prefer Helius (faster, from RPC) then GeckoTerminal then Jupiter
        name: helius.name || gecko.name || jup.name || `${mint.slice(0, 4)}...${mint.slice(-4)}`,
        symbol: helius.symbol || gecko.symbol || jup.symbol || mint.slice(0, 5).toUpperCase(),
        decimals,
        logoUri: helius.logoUri || gecko.logoUri || null,
        logoURI: helius.logoUri || gecko.logoURI || null,
        // Price: prefer GeckoTerminal (more accurate), fallback to Helius
        price: usdPrice,
        // Market data: GeckoTerminal only (Helius doesn't provide these)
        priceChange24h: gecko.priceChange24h ?? jup.priceChange24h ?? null,
        volume24h: gecko.volume24h || 0,
        liquidity: gecko.liquidity || 0,
        // A quote-side pool publishes no FDV for the token; fall back to price x supply
        marketCap: gecko.marketCap || gecko.fdv || impliedFdv || null,
        fdv: gecko.fdv || impliedFdv || 0,
        // Supply data - prefer Helius
        supply: supply,
        circulatingSupply: circulatingSupply,
        totalSupply: gecko.totalSupply || null,
        // Holder count from Helius (cached daily)
        holders: holders || null,
        // Token age (first pool creation timestamp from GeckoTerminal)
        pairCreatedAt: gecko.pairCreatedAt || null,
        // Submissions
        submissions: {
          banners: submissions.filter(s => s.submission_type === 'banner'),
          socials: submissions.filter(s => s.submission_type !== 'banner')
        }
      };

      // Set hasCommunityUpdates flag (used by frontend for green checkmark)
      tokenResult.hasCommunityUpdates = submissions.length > 0;

      // Include view count so the frontend can display it immediately
      try {
        if (dbViews == null) throw new Error('view count unavailable');
        const buffered = jobQueue.getBufferedViewCounts([mint]);
        tokenResult.views = dbViews + (buffered[mint] || 0);
      } catch {
        tokenResult.views = 0;
      }

      // Include curated token DexScreener data (banner + socials) and mcap tracking if available
      if (curated) {
        if (curated.bannerUrl) tokenResult.bannerUrl = curated.bannerUrl;
        if (curated.socials && Object.keys(curated.socials).length > 0) {
          tokenResult.socials = curated.socials;
        }
        tokenResult.addedAt = curated.addedAt;
        tokenResult.mcapAtAdded = curated.mcapAtAdded;
        tokenResult.mcapAth = curated.mcapAth;
        tokenResult.mcapAthAt = curated.mcapAthAt;
        tokenResult.emergingCult = curated.emergingCult || false;
        tokenResult.techCoin = curated.techCoin || false;
      }

      // Also save to database for future reference
      const tokenName = helius.name || gecko.name;
      const tokenSymbol = helius.symbol || gecko.symbol;
      if (tokenName && tokenSymbol) {
        // Only write metadata — market data (price, priceChange24h, etc.) must come from
        // updateTokenMarketData (worker / admin refresh) to avoid single page-load nulls
        // overwriting the worker's authoritative values.
        db.upsertToken({
          mintAddress: mint,
          name: tokenName,
          symbol: tokenSymbol,
          decimals,
          logoUri: helius.logoUri || gecko.logoUri,
          pairCreatedAt: gecko.pairCreatedAt || null,
        }).catch(() => { /* Privacy: Don't log error details */ });
      }

      if (geckoTimedOut) tokenResult.geckoPartial = true;
      degraded = geckoTimedOut || dbFailed;

      return tokenResult;
    }); // Use standard caching with stampede prevention (was requireFresh=true)

    // Partial result (Gecko rate-limited or a DB read failed): re-cache with a 30s TTL so
    // a request after that retries, rather than serving zeroed market data or a page
    // without its banner/socials for the full 10 minutes.
    if (degraded && result) {
      await cache.set(cacheKey, result, 30_000).catch(() => {});
    }

    if (!res.headersSent) res.json(result);
  } catch (error) {
    if (error.isOverloaded || error.isCircuitBreakerError) throw error;
    if (!res.headersSent) res.status(500).json({ error: 'Failed to fetch token details' });
  }
}));

// GET /api/tokens/:mint/price - Get price data only
// Uses 5-minute cache with 1-minute freshness for individual views
// Optimized: Uses getOrSetWithFreshness for stampede prevention
router.get('/:mint/price', validateMint, requireAllowedToken, asyncHandler(async (req, res) => {
  const { mint } = req.params;
  const cacheKey = keys.tokenPrice(mint);

  try {
    // Use getOrSetWithFreshness for stampede prevention
    const priceData = await cache.getOrSetWithFreshness(cacheKey, async () => {
      // Try GeckoTerminal with 3s timeout, fall back to Jupiter immediately on failure
      let data = null;
      try {
        data = await Promise.race([
          geckoService.getTokenOverview(mint),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Price timeout')), 3000))
        ]);
      } catch (err) {
        // GeckoTerminal failed, timed out, or is shedding load (breaker open / queue full) —
        // fall through to Jupiter, an independent upstream
      }

      if (!data) {
        const jup = await jupiterService.getTokenPrice(mint);
        // getTokenPrice answers {price: 0, error: true} on failure (and price 0 when it has
        // no quote). Caching that served $0 for the full 10-minute TTL even after Gecko came
        // back: fail this request instead, so the next one tries again.
        if (!jup || jup.error || !(jup.price > 0)) {
          throw new Error('price unavailable');
        }
        // Same shape as the Gecko overview: market fields Jupiter can't supply are null
        // (not missing), so the token page keeps its '--' placeholders instead of $0.
        data = { ...jup, marketCap: null, fdv: null, volume24h: null, liquidity: null };
      }

      return data;
    });

    if (!res.headersSent) res.json(priceData);
  } catch (error) {
    if (error.isOverloaded || error.isCircuitBreakerError) throw error;
    if (!res.headersSent) res.status(500).json({ error: 'Failed to fetch price data' });
  }
}));

// GET /api/tokens/:mint/ohlcv - Get OHLCV data for candlestick charts
// Feeds the token page's chart modal. ?interval=1m|5m|15m|1h|4h|12h|1d, ?limit=1..1000.
// Uses getOrSet for automatic caching with stampede prevention
router.get('/:mint/ohlcv', validateMint, requireAllowedToken, asyncHandler(async (req, res) => {
  const { mint } = req.params;
  const { interval = '1h' } = req.query;

  // Validate interval to prevent cache key pollution
  const validIntervals = Object.keys(geckoService.OHLCV_TIMEFRAMES);
  const normalizedInterval = String(interval).toLowerCase();
  if (!validIntervals.includes(normalizedInterval)) {
    return res.status(400).json({ error: 'Invalid interval', validIntervals });
  }
  // Only two sizes are cached so callers can't fan the cache out with arbitrary limits
  const limit = parseInt(req.query.limit) > 100 ? 1000 : 100;

  const cacheKey = `ohlcv:${mint}:${normalizedInterval}:${limit}`;
  // Minute candles go stale quickly; hour/day candles can sit for the full OHLCV TTL.
  // 2 minutes, not 1: the chart modal polls every 60s, so a 60s TTL made nearly every
  // poll an upstream GeckoTerminal request per (mint, interval).
  const cacheTTL = normalizedInterval.endsWith('m') ? 2 * TTL.MEDIUM : TTL.OHLCV;

  try {
    const ohlcvData = await cache.getOrSet(cacheKey, async () => {
      const result = await geckoService.getOHLCV(mint, { interval: normalizedInterval, limit });
      // Don't cache a failed upstream call as an empty chart for the whole TTL
      if (result.error) {
        const err = new Error(result.error);
        err.upstream = true;
        throw err;
      }
      return result;
    }, cacheTTL);

    if (!res.headersSent) res.json(ohlcvData);
  } catch (error) {
    if (error.isOverloaded || error.isCircuitBreakerError) throw error;
    if (!res.headersSent) res.status(502).json({ error: 'Failed to fetch OHLCV data' });
  }
}));

// GET /api/tokens/:mint/pools - Get liquidity pools for a token
// Uses getOrSet for automatic caching with stampede prevention
router.get('/:mint/pools', validateMint, requireAllowedToken, asyncHandler(async (req, res) => {
  const { mint } = req.params;
  // The cache key is per mint only, so always cache the full list (one GeckoTerminal page,
  // 20 pools) and apply the caller's limit after the read: ?limit=abc|0|1 must not shrink
  // the list everyone else is served.
  const limit = Math.min(Math.max(1, parseInt(req.query.limit) || 10), POOLS_PAGE_SIZE);

  const cacheKey = keys.pools(mint);

  try {
    // Use getOrSet for caching with stampede prevention
    // Pools data cached for 3 minutes - pool info rarely changes
    const pools = await cache.getOrSet(cacheKey, async () => {
      const list = await geckoService.getTokenPools(mint, { limit: POOLS_PAGE_SIZE });
      // null = upstream failure: don't cache it as an empty pool list for the whole TTL
      if (list == null) {
        const err = new Error('pools unavailable');
        err.upstream = true;
        throw err;
      }
      return list;
    }, TTL.POOLS);

    if (!res.headersSent) res.json(Array.isArray(pools) ? pools.slice(0, limit) : pools);
  } catch (error) {
    if (error.isOverloaded || error.isCircuitBreakerError) throw error;
    // Privacy: Don't log error details
    if (!res.headersSent) res.status(500).json({ error: 'Failed to fetch pools data' });
  }
}));

// GET /api/tokens/:mint/submissions - Get all submissions for a token
router.get('/:mint/submissions', validateMint, requireAllowedToken, asyncHandler(async (req, res) => {
  const { mint } = req.params;
  const { type, status = 'all' } = req.query;

  // Validate type and status to prevent cache pollution
  if (type && !VALID_SUBMISSION_TYPES.includes(type)) {
    return res.status(400).json({ error: 'Invalid submission type' });
  }
  if (!VALID_SUBMISSION_STATUSES.includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  try {
    // Cache key includes type and status filters
    const cacheKey = `${keys.submissions(mint)}:${type || 'all'}:${status}`;

    const submissions = await cache.getOrSet(cacheKey, async () => {
      const options = {};
      if (type) options.type = type;
      if (status !== 'all') options.status = status;
      return db.getSubmissionsByToken(mint, options);
    }, TTL.SHORT); // Cache for 1 minute

    res.json(submissions);
  } catch (error) {
    // Privacy: Don't log error details
    res.status(500).json({ error: 'Failed to fetch submissions' });
  }
}));

// POST /api/tokens/:mint/view - Record a page view for a token
// Called when the token detail page loads
// Uses job queue to batch view updates for better performance
// Curated tokens only: anything else would land in token_views and the most_viewed list.
// viewLimiter (not the shared write-action strictLimiter) so page loads never see a 429.
router.post('/:mint/view', validateMint, requireAllowedToken, viewLimiter, asyncHandler(async (req, res) => {
  const { mint } = req.params;

  // Use job queue for batched view counting (non-blocking)
  // Falls back to direct DB write if job queue not available
  let bufferedCount = 0;
  let buffered = false;
  try {
    bufferedCount = await jobQueue.incrementViewCount(mint);
    buffered = true;
  } catch (error) {
    // Queue unavailable: recorded by the direct write below
  }

  if (buffered) {
    // The view is buffered (and will be flushed): a failed read here must not write it a
    // second time, so it only costs the displayed total.
    try {
      // Return current known count (may be slightly stale but fast)
      const dbCount = await db.getTokenViews(mint);
      res.json({ views: dbCount + (bufferedCount || 0) });
    } catch (error) {
      res.json({ recorded: true });
    }
  } else {
    // Fallback: Direct database update if job queue fails
    try {
      const viewCount = await db.incrementTokenViews(mint);
      res.json({ views: viewCount });
    } catch (fallbackError) {
      console.warn('[Views] All fallback paths failed for', mint);
      res.status(500).json({ views: 0, error: 'view_record_failed' });
    }
  }
}));

// GET /api/tokens/:mint/views - Get view count for a token
router.get('/:mint/views', validateMint, requireAllowedToken, asyncHandler(async (req, res) => {
  const { mint } = req.params;

  try {
    const dbCount = await db.getTokenViews(mint);
    const buffered = jobQueue.getBufferedViewCounts([mint]);
    res.json({ views: dbCount + (buffered[mint] || 0) });
  } catch (error) {
    // Privacy: Don't log error details
    res.json({ views: 0 });
  }
}));

// GET /api/tokens/:mint/holder/:wallet - Check if wallet holds token and get balance info
// Public API only (no page calls it). Every new wallet is an uncached Helius call, so it has
// its own small per-IP limit.
router.get('/:mint/holder/:wallet', holderLookupLimiter, validateMint, requireAllowedToken, asyncHandler(async (req, res) => {
  const { mint, wallet } = req.params;

  // Basic wallet address validation
  if (!wallet || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet)) {
    return res.status(400).json({ error: 'Invalid wallet address' });
  }

  const cacheKey = `holder:${mint}:${wallet}`;

  try {
    // Check cache first (short TTL since balances change)
    const cached = await cache.get(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    // Get token accounts for this wallet that hold the specific token
    let balance = 0;
    let decimals = 9;
    let rpcSuccess = false;

    // Method 1: Standard RPC getTokenAccountsByOwner
    try {
      const tokenAccounts = await solanaService.getTokenAccountsByOwner(wallet, mint);
      rpcSuccess = true;
      if (tokenAccounts && tokenAccounts.value && tokenAccounts.value.length > 0) {
        for (const account of tokenAccounts.value) {
          const info = account.account?.data?.parsed?.info;
          if (info && info.mint === mint) {
            balance += parseFloat(info.tokenAmount?.uiAmount || 0);
            decimals = pickDecimals(info.tokenAmount?.decimals);
          }
        }
      }
    } catch (rpcErr) {
      // RPC failed — try DAS fallback below
    }

    // Method 2: Helius DAS fallback, only when the RPC call failed. A successful RPC answer
    // with no accounts is a confirmed non-holder: the mint filter covers Token-2022 mints
    // too, and a 10-credit DAS call per empty wallet made random wallets a credit drain.
    if (!rpcSuccess && HELIUS_DAS_URL) {
      try {
        // Same rate limit and breaker as the other DAS callers (Helius RPS budget)
        const dasResponse = await circuitBreakers.heliusDas.execute(() =>
          rateLimitedRequest('helius', () => {
            solanaService.countCredits('getTokenAccounts', 10);
            return axios.post(HELIUS_DAS_URL, {
              jsonrpc: '2.0', id: 1,
              method: 'getTokenAccounts',
              params: { owner: wallet, mint, limit: 10 }
            }, { timeout: 10000 });
          })
        );

        if (dasResponse.data?.result?.token_accounts?.length > 0) {
          rpcSuccess = true;
          let rawTotal = 0;
          for (const ta of dasResponse.data.result.token_accounts) {
            if (ta.mint === mint) rawTotal += parseFloat(ta.amount || 0);
          }
          if (rawTotal > 0) {
            // DAS amounts are raw base units with no decimals; scaling by a guessed 9 put
            // 6-decimal (pump.fun) balances off by 1000x
            const mintDecimals = await resolveMintDecimals(mint);
            if (mintDecimals == null) {
              // Holds the token, but the amount can't be scaled: say so rather than guess
              return res.json({
                wallet, mint, balance: null, decimals: null, holdsToken: true,
                verified: true, totalSupply: null, circulatingSupply: null, percentageHeld: null
              });
            }
            decimals = mintDecimals;
            balance = rawTotal / Math.pow(10, decimals);
          }
        } else if (dasResponse.data?.result) {
          // DAS responded but no accounts — confirmed not holding
          rpcSuccess = true;
        }
      } catch (dasErr) {
        // DAS also failed — if RPC also failed, we have no data
      }
    }

    // If both methods failed entirely, signal the error to frontend
    if (!rpcSuccess) {
      return res.json({
        wallet, mint, balance: 0, holdsToken: false,
        verified: false, error: 'Unable to verify — RPC unavailable, please retry'
      });
    }

    // Get token supply for percentage calculation
    let totalSupply = null;
    let circulatingSupply = null;
    let percentageHeld = null;

    // Try to get token info for supply data
    // Token info is stored via setWithTimestamp — use getWithMeta to unwrap correctly
    const tokenInfoMeta = await cache.getWithMeta(keys.tokenInfo(mint))
      || await cache.getWithMeta(`batch:${mint}`);
    const tokenInfo = tokenInfoMeta?.value ?? null;
    if (tokenInfo) {
      // Display supply (UI units). The raw Gecko totalSupply is not scaled, so it is no
      // fallback here.
      totalSupply = tokenInfo.supply || null;
      circulatingSupply = tokenInfo.circulatingSupply || totalSupply;
    }

    // Share of total supply, as the holders panel reports it. Subtracting pool USD liquidity
    // divided by price counted both sides of the pool as tokens, and pushed results past 100%.
    if (balance > 0 && totalSupply > 0) {
      percentageHeld = Math.min(100, (balance / totalSupply) * 100);
    }

    const result = {
      wallet,
      mint,
      balance,
      decimals,
      holdsToken: balance > 0,
      verified: true,
      totalSupply,
      circulatingSupply,
      percentageHeld: percentageHeld !== null ? parseFloat(percentageHeld.toFixed(6)) : null
    };

    // Cache for 1 minute (balances change frequently); a confirmed non-holder for 5
    await cache.set(cacheKey, result, result.holdsToken ? 60000 : 5 * 60000);

    res.json(result);
  } catch (error) {
    // Privacy: Don't log error details
    // Signal that verification failed (not that user doesn't hold)
    res.status(502).json({
      wallet,
      mint,
      balance: 0,
      holdsToken: false,
      verified: false,
      error: 'Unable to verify balance — please retry'
    });
  }
}));

// True when the caller holds a valid admin session or an active API key.
// GET /api/tokens/:mint/holders - Top holder analytics
// Phase 1 (inline): Fetch largest accounts + supply (2 fast RPC calls)
// Phase 2 (worker): Classify LP/burn/lock, resolve wallets (6+ slow RPC calls)
// If the worker result is cached, returns full data immediately.
router.get('/:mint/holders', validateMint, requireAllowedToken, asyncHandler(async (req, res) => {
  const { mint } = req.params;
  const cacheKey = `holder-analytics:${mint}`;

  try {
    // ?fresh=true bypasses the cache, but only for admin sessions and API-key callers;
    // anyone else could otherwise force uncached RPC calls on every request.
    const bypass = req.query.fresh === 'true' && await canBypassCache(req);
    if (!bypass) {
      const cached = await cache.get(cacheKey);
      if (cached) return res.json(cached);
    }

    // Phase 1, preferred: the top holders of a recent full snapshot (no RPC).
    const snapList = await holderPipeline.getSnapshotHolderList(mint).catch(() => null);
    if (snapList) {
      return res.json(await _serveSnapshotHolders(mint, snapList, cacheKey, bypass));
    }
    // No recent snapshot: ask for one, and serve the 20-account RPC view meanwhile.
    if (solanaService.isHeliusConfigured()) holderPipeline.ensureSnapshot(mint).catch(() => {});

    // Phase 1: Fast inline — only the 2 cheapest RPC calls
    const [rpcAccounts, supplyResult] = await Promise.all([
      solanaService.getTokenLargestAccounts(mint),
      solanaService.getTokenSupply(mint).catch(catchUnlessOverloaded(null))
    ]);

    if (!rpcAccounts) {
      // RPC down. An older snapshot's top holders are still the real largest accounts; a
      // single DAS getTokenAccounts page is not (it is in index order, not by balance), and
      // serving it as "top holders" had the worker cache concentration metrics from 20
      // arbitrary small wallets for hours. With neither, say so and let the client retry.
      const staleList = await holderPipeline.getSnapshotHolderList(mint, { maxAgeMs: STALE_SNAPSHOT_MAX_AGE_MS }).catch(() => null);
      if (staleList) {
        return res.json(await _serveSnapshotHolders(mint, staleList, cacheKey, bypass));
      }
      return res.status(503).json({ holders: [], totalSupply: null, metrics: null, supply: null, error: 'rpc_unavailable' });
    }
    const largestAccounts = rpcAccounts;

    if (largestAccounts.length === 0) {
      return res.json({ holders: [], totalSupply: null, metrics: null, supply: null, error: null });
    }

    const totalSupply = supplyResult?.value
      ? parseFloat(supplyResult.value.uiAmountString || supplyResult.value.uiAmount || 0)
      : null;

    // Build basic holders list (no LP/burn flags yet — those come from the worker)
    // Percentages set to null since LP status unknown — worker will compute actual percentages excluding LPs
    const holders = largestAccounts.map((a, i) => ({
      rank: i + 1,
      address: a.wallet || a.address,
      balance: a.uiAmount,
      percentage: null,  // Will be computed by worker after LP detection
      isLP: false,
      isBurnt: false
    })).filter(h => h.balance > 0);

    // Basic concentration metrics (will be refined by worker once LP/burn flags are set)
    let metrics = null;
    if (totalSupply > 0 && holders.length > 0) {
      // In fast path, percentages are null (set by worker after LP detection)
      // So we don't compute concentration metrics yet (they'll be computed by worker)
      metrics = {
        top5Pct: null,
        top10Pct: null,
        top20Pct: null,
        herfindahl: null,
        top1Pct: null,
        dominance: null,
        avgBalance: null,
        avgPct: null,
        holderCount: null
      };

      try {
        const totalCount = (await holderCounts.getDisplayCounts([mint]))[mint];
        if (totalCount && totalCount > 0) {
          metrics.holderCount = totalCount;
        } else if (solanaService.isHeliusConfigured()) {
          jobQueue.addAnalyticsJob('fetch-holder-counts-batch', { mints: [mint] }).catch(() => {});
        }
      } catch (_) {}
    }

    // Build fast result and cache briefly (worker will overwrite with full data)
    const fastResult = { holders, totalSupply, metrics, supply: null, fetchedAt: Date.now() };

    // Decimals for the worker's Streamflow scaling. getTokenSupply can fail on its own while
    // getTokenLargestAccounts succeeds; each RPC account carries the mint decimals too.
    // Sending 0 there scaled locked amounts (and lockedPct) by 10^decimals.
    let supplyDecimals = [supplyResult?.value?.decimals, ...largestAccounts.map(a => a.decimals)]
      .find(d => Number.isInteger(d) && d >= 0);
    if (supplyDecimals === undefined) supplyDecimals = await resolveMintDecimals(mint);

    if (supplyDecimals != null) {
      const rawAccounts = largestAccounts.slice(0, 20).map(a => ({
        address: a.address,
        wallet: a.wallet || null,
        uiAmount: a.uiAmount
      }));
      await _cacheFastResultAndClassify(mint, cacheKey, fastResult,
        { rawAccounts, totalSupply, usedDAS: false, supplyDecimals },
        { value: { ...(supplyResult?.value || {}), decimals: supplyDecimals } }, bypass);
    } else {
      // No decimals, so no classification job; still cache briefly so polls in this window
      // don't repeat the three reads above.
      await cache.setNX(cacheKey, fastResult, 30000);
    }

    if (!res.headersSent) res.json(fastResult);
  } catch (error) {
    console.error('[Tokens] Holder analytics error:', error.message);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to fetch holder data' });
  }
}));

// Cache the unclassified fast result for 2 minutes and queue the worker classification,
// once per pending window. Both writes are SET NX: a poll whose cache miss came just before
// the worker finished must not replace the classified result with the unflagged one (or
// queue the work again), and while a classification is already pending (queued by the
// snapshot job or another request) the fast result is still cached, so polls in that
// window are served from cache instead of repeating the reads. `overwrite` is the admin
// ?fresh=true path, which replaces whatever is cached.
async function _cacheFastResultAndClassify(mint, cacheKey, fastResult, jobData, supplyResult, overwrite = false) {
  // setNX answers false while Redis is disconnected, which would read as "already cached"
  // and skip classification entirely. Then the writes below are no-ops anyway, so take the
  // plain path and let the queue (or the inline fallback) run.
  const cacheDown = cache.getBackendType() === 'redis' && cache.backend?.isConnected === false;
  let stored;
  if (overwrite || cacheDown) {
    await cache.set(cacheKey, fastResult, 120000);
    stored = true;
  } else {
    stored = await cache.setNX(cacheKey, fastResult, 120000);
  }
  if (!stored) return; // a result (classified or fast) is already there

  const pendingKey = `holder-classify-pending:${mint}`;
  if (!cacheDown && !(await cache.setNX(pendingKey, Date.now(), 120000))) return; // already queued

  const job = await jobQueue.addAnalyticsJob('compute-holder-analytics', { mint, ...jobData });
  if (!job) {
    // No worker available — do classification inline as fallback
    await cache.delete(pendingKey);
    await _classifyHoldersInline(mint, jobData.rawAccounts, jobData.totalSupply, jobData.usedDAS, supplyResult, cacheKey);
  }
}

// Holder list from a snapshot: unflagged top holders now, LP/burn/percentages from the
// compute-holder-analytics job (which the snapshot job normally queues already).
async function _serveSnapshotHolders(mint, snapList, cacheKey, overwrite = false) {
  const { rawAccounts, totalSupply, decimals } = snapList;
  const holders = rawAccounts.map((a, i) => ({
    rank: i + 1, address: a.wallet, balance: a.uiAmount, percentage: null, isLP: false, isBurnt: false
  })).filter(h => h.balance > 0);
  const holderCount = (await holderCounts.getDisplayCounts([mint]).catch(() => ({})))[mint];
  const metrics = {
    top5Pct: null, top10Pct: null, top20Pct: null, herfindahl: null, top1Pct: null,
    dominance: null, avgBalance: null, avgPct: null, holderCount: holderCount || null
  };
  const fastResult = { holders, totalSupply, metrics, supply: null, fetchedAt: Date.now() };

  await _cacheFastResultAndClassify(mint, cacheKey, fastResult,
    { rawAccounts, totalSupply, usedDAS: true, supplyDecimals: decimals },
    { value: { decimals } }, overwrite);
  return fastResult;
}

// Concurrency guard — only 1 inline classification runs at a time in the API process.
// Without this, a worker outage + burst of requests creates a storm of concurrent RPC calls.
let _inlineClassifyActive = 0;
const MAX_INLINE_CLASSIFY = 1;

// Inline fallback for holder classification when worker is unavailable.
// Still runs in the API process but AFTER the response is sent (fire-and-forget).
// Guarded by _inlineClassifyActive so at most 1 runs concurrently.
async function _classifyHoldersInline(mint, rawAccounts, totalSupply, usedDAS, supplyResult, cacheKey) {
  if (_inlineClassifyActive >= MAX_INLINE_CLASSIFY) {
    console.warn(`[Tokens] Inline classify skipped for ${mint.slice(0, 8)} — ${_inlineClassifyActive} already running (worker may be down)`);
    return;
  }
  // Taken now, not inside setImmediate: callers in the same event-loop turn would all
  // pass the check above before any deferred increment ran.
  _inlineClassifyActive++;
  setImmediate(() => {
    (async () => {
      try {
        const [mintAccount, tokenAuth] = await Promise.all([
          solanaService.getAccountInfo(mint).catch(() => null),
          solanaService.getTokenAuthorities(mint).catch(() => null)
        ]);

        const mintData = mintAccount?.value?.data?.parsed?.info;
        const decimals = Number.isInteger(mintData?.decimals) ? mintData.decimals
          : Number.isInteger(supplyResult?.value?.decimals) ? supplyResult.value.decimals : 0;
        const currentSupply = mintData
          ? parseFloat(mintData.supply) / Math.pow(10, decimals)
          : totalSupply;

        let deadWalletBurnt = 0;
        const lpIndices = new Set();
        const burntIndices = new Set();

        // A failed Streamflow read is not "nothing locked": flagged, and cached briefly
        let lockedUnknown = false;
        const streamflowPromise = solanaService.getStreamflowLockedAmount(mint, decimals).catch(() => { lockedUnknown = true; return 0; });

        const walletToIndices = new Map();
        if (usedDAS) {
          rawAccounts.forEach((a, i) => {
            if (!a.wallet) return;
            if (BURN_WALLETS.has(a.wallet)) { deadWalletBurnt += a.uiAmount; burntIndices.add(i); return; }
            if (!walletToIndices.has(a.wallet)) walletToIndices.set(a.wallet, []);
            walletToIndices.get(a.wallet).push(i);
          });
        } else {
          const accts = await solanaService.getMultipleAccounts(rawAccounts.map(a => a.address));
          if (accts?.value) {
            accts.value.forEach((acct, i) => {
              const wallet = acct?.data?.parsed?.info?.owner;
              if (!wallet) return;
              rawAccounts[i].wallet = wallet;
              if (BURN_WALLETS.has(wallet)) { deadWalletBurnt += rawAccounts[i].uiAmount; burntIndices.add(i); return; }
              if (!walletToIndices.has(wallet)) walletToIndices.set(wallet, []);
              walletToIndices.get(wallet).push(i);
            });
          }
        }

        const wallets = [...walletToIndices.keys()];
        if (wallets.length > 0) {
          const walletAccounts = await solanaService.getMultipleAccounts(wallets);
          if (walletAccounts?.value) {
            walletAccounts.value.forEach((acct, wi) => {
              if ((acct && acct.owner && acct.owner !== SYSTEM_PROGRAM_ID) || LP_AUTHORITIES.has(wallets[wi])) {
                const indices = walletToIndices.get(wallets[wi]);
                if (indices) for (const idx of indices) lpIndices.add(idx);
              }
            });
          }
        }

        const lockedAmount = await streamflowPromise;
        const result = _buildFullHolderResult(rawAccounts, totalSupply, currentSupply, mintData, tokenAuth, lpIndices, burntIndices, deadWalletBurnt, lockedAmount, decimals, mint);
        if (lockedUnknown) result.lockedUnknown = true;
        await cache.set(cacheKey, result, lockedUnknown ? 15 * 60 * 1000 : TTL.HOUR);
      } catch (err) {
        console.error('[Tokens] Inline holder classify failed:', err.message);
      } finally {
        _inlineClassifyActive--;
      }
    })();
  });
}

// Shared logic to build the full holder analytics result with LP/burn/lock flags
function _buildFullHolderResult(rawAccounts, totalSupply, currentSupply, mintData, tokenAuth, lpIndices, burntIndices, deadWalletBurnt, lockedAmount, decimals, mint) {
  // SPL burn detection (pump.fun only: the one launch with a known original supply)
  const { isPumpFun, splBurnt, supplyDenominator } = inferSplBurn({ currentSupply, decimals, tokenAuth });

  const burntAmount = splBurnt + deadWalletBurnt;
  const supply = {
    total: currentSupply, burnt: burntAmount,
    burntPct: supplyDenominator > 0 && burntAmount > 0 ? (burntAmount / supplyDenominator) * 100 : 0,
    locked: lockedAmount, lockedPct: currentSupply > 0 && lockedAmount > 0 ? (lockedAmount / currentSupply) * 100 : 0,
    splBurnt, deadWalletBurnt, isPumpFun
  };

  const holders = rawAccounts.map((a, i) => ({
    rank: i + 1, address: a.wallet || a.address, balance: a.uiAmount,
    percentage: (totalSupply || currentSupply) > 0 ? (a.uiAmount / (totalSupply || currentSupply)) * 100 : null,
    isLP: lpIndices.has(i), isBurnt: burntIndices.has(i)
  })).filter(h => h.balance > 0);

  const realHolders = holders.filter(h => !h.isLP && !h.isBurnt);
  let metrics = null;
  if ((totalSupply || currentSupply) > 0 && realHolders.length > 0) {
    const top5Pct = realHolders.slice(0, 5).reduce((s, h) => s + (h.percentage || 0), 0);
    const top10Pct = realHolders.slice(0, 10).reduce((s, h) => s + (h.percentage || 0), 0);
    const top20Pct = realHolders.slice(0, 20).reduce((s, h) => s + (h.percentage || 0), 0);
    const top1Pct = realHolders[0]?.percentage || 0;

    metrics = {
      top5Pct: Math.round(top5Pct * 100) / 100, top10Pct: Math.round(top10Pct * 100) / 100,
      top20Pct: Math.round(top20Pct * 100) / 100,
      herfindahl: Math.round(realHolders.reduce((s, h) => s + Math.pow(h.percentage || 0, 2), 0)),
      top1Pct: Math.round(top1Pct * 100) / 100,
      dominance: top20Pct > 0 ? Math.round((top1Pct / top20Pct) * 10000) / 100 : 0,
      avgBalance: realHolders.reduce((s, h) => s + h.balance, 0) / realHolders.length,
      avgPct: Math.round((top20Pct / realHolders.length) * 100) / 100,
      holderCount: null
    };
  }

  return { holders, totalSupply, metrics, supply, fetchedAt: Date.now() };
}

// GET /api/tokens/:mint/holders/hold-times - Average hold time per holder wallet
// Returns cached per-wallet hold times immediately. If any wallets are stale
// (>24hr or missing), queues a background worker job to compute them.
// Response includes `computed: false` when stale wallets are pending so the
// frontend knows to re-poll.
// ─── Holder count history ────────────────────────────────────────────────────
// One point per holder snapshot (services/holderCounts.js). Reads Postgres only.
router.get('/:mint/holder-count', validateMint, requireAllowedToken, asyncHandler(async (req, res) => {
  const { mint } = req.params;
  // Own keys only: 'constructor', 'toString' etc. are on every object literal
  const range = typeof req.query.range === 'string' && Object.prototype.hasOwnProperty.call(holderCounts.RANGES, req.query.range)
    ? req.query.range : '30d';
  const cacheKey = `holder-count:${mint}:${range}`;
  const cached = await cache.get(cacheKey).catch(() => null);
  if (cached) return res.json(cached);

  const points = await holderCounts.getPoints(mint);
  const result = {
    mint,
    ...holderCounts.buildHolderSeries(points, { range }),
    dustUsd: holderCounts.DUST_USD,
    refreshHours: Math.round(holderPipeline.CONFIG.refreshMs / 3_600_000),
  };
  // New points clear this key (holderCounts.clearSeriesCache); the TTL only
  // bounds how stale the change stats' "now" can get.
  await cache.set(cacheKey, result, 10 * TTL.MEDIUM).catch(() => {});
  res.json(result);
}));

// Older daily shape, kept for pages still running the previous frontend.
router.get('/:mint/holder-history', validateMint, requireAllowedToken, asyncHandler(async (req, res) => {
  const { mint } = req.params;
  const days = Math.min(parseInt(req.query.days) || 30, 90);
  const history = await holderCounts.getDailyHistory(mint, days);
  res.json({ mint, history });
}));

router.get('/:mint/holders/hold-times', validateMint, requireAllowedToken, asyncHandler(async (req, res) => {
  const { mint } = req.params;

  try {
    // If Helius isn't configured, hold times can't be computed — return immediately
    if (!solanaService.isHeliusConfigured()) {
      return res.json({ holdTimes: {}, tokenHoldTimes: {}, floors: [], computed: true });
    }

    // Get holder data (likely already cached from the main holders call).
    // If the cache is missing (expired/evicted), return computed: false so the
    // frontend keeps polling — the main holders endpoint will repopulate it.
    const holdersCache = await cache.get(`holder-analytics:${mint}`);
    if (!holdersCache || !holdersCache.holders || holdersCache.holders.length === 0) {
      console.log(`[HoldTimes] holder-analytics:${mint} cache miss — returning computed: false to trigger re-poll`);
      return res.json({ holdTimes: {}, tokenHoldTimes: {}, floors: [], computed: false });
    }

    // Listed holders (skip LP and burn wallets). Hold times come from holder
    // snapshots in Postgres (services/holderPipeline.js); no RPC on this path.
    const wallets = holdersCache.holders
      .filter(h => !h.isLP && !h.isBurnt && h.address)
      .map(h => h.address);

    if (wallets.length === 0) {
      return res.json({ holdTimes: {}, tokenHoldTimes: {}, floors: [], computed: true });
    }

    // A computed result is cached for the diamond-hands result TTL, tagged with the wallet
    // list it was computed for (the list changes when classification or a new snapshot
    // lands); holderPipeline drops the key on a new snapshot or a finished backfill.
    const holdTimesKey = `hold-times:${mint}`;
    const walletsHash = crypto.createHash('sha1').update(wallets.join(',')).digest('hex');
    const cachedHoldTimes = await cache.get(holdTimesKey).catch(() => undefined);
    if (cachedHoldTimes && cachedHoldTimes.walletsHash === walletsHash) {
      const { holdTimes, floors } = cachedHoldTimes;
      return res.json({ holdTimes, tokenHoldTimes: holdTimes, floors, computed: true });
    }

    const { holdTimes, floors, computed } = await holderPipeline.getHoldTimes(mint, wallets);
    if (computed) {
      await cache.set(holdTimesKey, { walletsHash, holdTimes, floors }, holderPipeline.CONFIG.resultTtl).catch(() => {});
    }
    // holdTimes and tokenHoldTimes are the same thing (time holding this token);
    // both keys are kept for the frontend. floors: wallets whose time is a lower
    // bound (the history read stopped before the streak start).
    if (!res.headersSent) res.json({ holdTimes, tokenHoldTimes: holdTimes, floors, computed });
  } catch (error) {
    console.error('[Tokens] Hold times error:', error.message);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to fetch hold times' });
  }
}));

// GET /api/tokens/:mint/holders/diamond-hands - Hold time distribution
// Share of holders (and of held supply) that have held for >6h ... >1yr, measured on
// a stratified sample of the full holder snapshot (services/holderPipeline.js).
// Returns computed: false while the snapshot or hold-time backfill is still running;
// the frontend polls.
router.get('/:mint/holders/diamond-hands', validateMint, requireAllowedToken, asyncHandler(async (req, res) => {
  const { mint } = req.params;

  try {
    if (!solanaService.isHeliusConfigured()) {
      return res.json({ distribution: null, sampleSize: 0, analyzed: 0, computed: true });
    }
    // While the backfill runs every poll would re-read the snapshot and positions; an
    // in-progress result is shared for 5s. Its own key: cultify treats any hit on
    // diamond-hands:<mint> as the final result.
    const partialKey = `diamond-hands-partial:${mint}`;
    const partial = await cache.get(partialKey).catch(() => undefined);
    if (partial) return res.json(partial);
    const result = await holderPipeline.getDiamondHands(mint);
    if (result && !result.computed) await cache.set(partialKey, result, 5000).catch(() => {});
    if (!res.headersSent) res.json(result);
  } catch (error) {
    console.error('[DiamondHands] Error:', error.message);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to fetch diamond hands data' });
  }
}));

// GET /api/tokens/:mint/similar - Find tokens with similar names/symbols
// Anti-spoofing: helps users identify confusing or copycat token names
// Returns fast DB results inline (~5-20ms), then queues worker for GeckoTerminal enrichment.
// Response format: { results: [...], enriched: boolean }
router.get('/:mint/similar', validateMint, requireAllowedToken, asyncHandler(async (req, res) => {
  const { mint } = req.params;
  const cacheKey = `similar:${mint}`;
  const pendingKey = `similar-pending:${mint}`;

  try {
    // Check cache first — worker writes enriched results here
    const cached = await cache.get(cacheKey);
    if (cached != null) {
      return res.json(cached);
    }

    // Resolve token name/symbol for similarity query
    let tokenName = null;
    let tokenSymbol = null;

    // Try token-info cache first (fast), then fall back to DB
    const cachedMeta = await cache.getWithMeta(keys.tokenInfo(mint))
      || await cache.getWithMeta(`batch:${mint}`);
    if (cachedMeta && cachedMeta.value) {
      tokenName = cachedMeta.value.name;
      tokenSymbol = cachedMeta.value.symbol;
    }
    if (!tokenName) {
      const localToken = await db.getToken(mint);
      if (localToken) {
        tokenName = localToken.name;
        tokenSymbol = localToken.symbol;
      }
    }

    // Run inline DB similarity query (~5-20ms)
    let results = [];
    if (tokenName) {
      try {
        results = await db.findSimilarTokens(mint, tokenName, tokenSymbol, 5);
      } catch (err) {
        console.warn(`[Similar] Inline DB query failed for ${mint}:`, err.message);
      }
    }

    // Queue worker for GeckoTerminal enrichment (deduped by pending flag)
    const isPending = await cache.get(pendingKey);
    if (!isPending) {
      await cache.set(pendingKey, true, 60000);
      const job = await jobQueue.addSearchJob('compute-similar-tokens', { mint });
      if (!job) {
        // Worker unavailable — cache inline results as final
        await cache.delete(pendingKey);
        const final = { results, enriched: true };
        await cache.set(cacheKey, final, results.length > 0 ? TTL.HOUR : TTL.PRICE_DATA);
        return res.json(final);
      }
    }

    // Return fast DB results immediately; worker will enrich in background
    res.json({ results, enriched: false });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch similar tokens' });
  }
}));

module.exports = router;
module.exports._classifyHoldersInline = _classifyHoldersInline;
