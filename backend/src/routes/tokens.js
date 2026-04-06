const express = require('express');
const router = express.Router();
const jupiterService = require('../services/jupiter');
const geckoService = require('../services/geckoTerminal');
const solanaService = require('../services/solana');
const db = require('../services/database');
const { cache, TTL, keys } = require('../services/cache');
const { validateMint, validatePagination, validateSearch, asyncHandler, SOLANA_ADDRESS_REGEX, catchUnlessOverloaded, requireDatabase } = require('../middleware/validation');
const { searchLimiter, strictLimiter } = require('../middleware/rateLimit');
const axios = require('axios');

// Require database for all token routes
router.use(requireDatabase);

// Names that indicate missing/placeholder metadata
const PLACEHOLDER_NAMES = new Set(['unknown token', 'unknown', '']);

// Helius DAS URL for holder verification fallback
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const HELIUS_DAS_URL = HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}` : null;

// Allowed values for token list query params — prevents cache key pollution
const VALID_FILTERS = ['trending', 'new', 'gainers', 'losers', 'most_viewed', 'tech', 'meme'];
const VALID_SORTS = ['volume', 'price', 'priceChange24h', 'marketCap', 'views'];
const VALID_ORDERS = ['asc', 'desc'];

// Known burn wallets and LP program IDs — shared across holder endpoints
const BURN_WALLETS = new Set([
  '1nc1nerator11111111111111111111111111111111',  // Solana incinerator (most common)
  '1111111111111111111111111111111111111111111',   // Null address (44 ones)
  'burnedFi11111111111111111111111111111111111',   // burnedFi vanity address
]);
const LP_PROGRAMS = new Set([
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',  // Raydium AMM v4
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',  // Raydium CLMM
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',  // Raydium CPMM
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',  // Orca Whirlpool
  'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',  // Meteora DLMM
  'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB',  // Meteora Pools
  '2wT8Yq49kHgDzXuPxZSaeLaH1qbmGXtEyPy64bL7aD3c',  // Lifinity v2
  '9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP',  // Orca Token Swap v2
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',  // Pump.fun AMM (bonding curve)
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',  // PumpSwap AMM
]);
const VALID_SUBMISSION_TYPES = ['banner', 'twitter', 'telegram', 'discord', 'tiktok', 'website', 'other'];
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

// GET /api/tokens - List tokens (trending, new, gainers, losers)
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

  const cacheKey = keys.tokenList(`${filter}-${sort}-${order}-${limit}`, Math.floor(offset / limit));

  // Try cache first - use getWithMeta since we store with setWithTimestamp
  // Note: We refresh view counts even for cached responses since they're cheap to fetch
  const cachedMeta = await cache.getWithMeta(cacheKey);
  if (cachedMeta && cachedMeta.value) {
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

    return res.json(tokens);
  }

  let tokens;
  let geckoError = null;

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
          heliusMetadata = await solanaService.getTokenMetadataBatch(missingMints);
        } catch (err) {
          // Helius batch failed, continue without it
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
            price: local.price || 0,
            priceChange24h: local.price_change_24h != null ? parseFloat(local.price_change_24h) : null,
            volume24h: local.volume_24h || 0,
            marketCap: local.market_cap || 0,
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
            marketCap: 0,
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
            marketCap: cached.marketCap || 0,
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
          marketCap: 0,
          logoUri: null,
          logoURI: null,
          views: viewCount
        };
      });

      // Enrich tokens with sentiment scores and community update flags
      try {
        const addrs = tokens.map(t => t.address || t.mintAddress);
        const [sentimentScores, communityMints] = await Promise.all([
          db.getSentimentBatch(addrs),
          db.hasApprovedSubmissionsBatch(addrs)
        ]);
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
          heliusMetadata = await solanaService.getTokenMetadataBatch(missingMints);
        } catch (err) {
          // Helius batch failed, continue without it
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
            price: local.price || 0, priceChange24h: local.price_change_24h != null ? parseFloat(local.price_change_24h) : null,
            volume24h: local.volume_24h || 0, marketCap: local.market_cap || 0,
            logoUri: local.logo_uri || null, logoURI: local.logo_uri || null,
            views: 0
          };
        }
        if (helius?.name && !PLACEHOLDER_NAMES.has(helius.name.toLowerCase())) {
          return {
            mintAddress: mint, address: mint,
            name: helius.name, symbol: helius.symbol || mint.slice(0, 5).toUpperCase(),
            price: 0, priceChange24h: null, volume24h: 0, marketCap: 0,
            logoUri: helius.logoUri || null, logoURI: helius.logoUri || null,
            views: 0
          };
        }
        if (cached?.name && !PLACEHOLDER_NAMES.has(cached.name.toLowerCase())) {
          return {
            mintAddress: mint, address: mint,
            name: cached.name, symbol: cached.symbol || mint.slice(0, 5).toUpperCase(),
            price: cached.price || 0, priceChange24h: cached.priceChange24h != null ? cached.priceChange24h : null,
            volume24h: cached.volume24h || 0, marketCap: cached.marketCap || 0,
            logoUri: cached.logoUri || null, logoURI: cached.logoURI || null,
            views: 0
          };
        }
        return {
          mintAddress: mint, address: mint,
          name: `${mint.slice(0, 4)}...${mint.slice(-4)}`, symbol: mint.slice(0, 5).toUpperCase(),
          price: 0, priceChange24h: null, volume24h: 0, marketCap: 0,
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

    // Use GeckoTerminal (free, no API key needed)
    // Optimization: Skip GeckoTerminal enrichment - use Helius batch API instead
    const useHeliusEnrichment = solanaService.isHeliusConfigured();

    // GeckoTerminal uses its own page size (~20 tokens/page, 1-based)
    // Calculate which gecko pages we need to cover the requested offset+limit window
    const geckoPageSize = 20;
    const requestStart = parseInt(offset);
    const requestEnd = requestStart + parseInt(limit);
    // For gainers/losers, always start from page 1 so each page sorts a consistent
    // superset of all previous pages' data — prevents duplicate tokens across pages
    const needsFullSort = (filter === 'gainers' || filter === 'losers');
    const firstGeckoPage = needsFullSort ? 1 : Math.floor(requestStart / geckoPageSize) + 1;
    const lastGeckoPage = Math.floor(Math.max(0, requestEnd - 1) / geckoPageSize) + 1;

    try {
      // Fetch all gecko pages needed to cover the requested window
      let allTokens = [];
      for (let gp = firstGeckoPage; gp <= lastGeckoPage; gp++) {
        let pageTokens;
        switch (filter) {
          case 'new':
            pageTokens = await geckoService.getNewTokens(geckoPageSize, useHeliusEnrichment, gp);
            break;
          default: // trending, gainers, losers all fetch trending pools
            pageTokens = await geckoService.getTrendingTokens({ limit: geckoPageSize, skipEnrichment: useHeliusEnrichment, page: gp });
        }
        if (pageTokens) allTokens = allTokens.concat(pageTokens);
      }

      // Apply filter-specific sorting before slicing
      if (filter === 'gainers') {
        allTokens.sort((a, b) => (b.priceChange24h || 0) - (a.priceChange24h || 0));
      } else if (filter === 'losers') {
        allTokens.sort((a, b) => (a.priceChange24h || 0) - (b.priceChange24h || 0));
      }

      // Slice to the requested window within the fetched data
      const sliceStart = requestStart - (firstGeckoPage - 1) * geckoPageSize;
      tokens = allTokens.slice(sliceStart, sliceStart + parseInt(limit));
    } catch (err) {
      geckoError = err;
      // Privacy: Don't log error details
    }

    // If GeckoTerminal returns empty or failed, fallback to Jupiter
    if (!tokens || tokens.length === 0) {
      // Privacy: Don't log fallback details
      try {
        tokens = await jupiterService.getTrendingTokens({
          sort,
          order,
          limit: parseInt(limit),
          offset: parseInt(offset)
        });
      } catch (jupiterError) {
        // Privacy: Don't log error details
        // If both failed and we had a GeckoTerminal error, throw that
        if (geckoError) throw geckoError;
        throw jupiterError;
      }
    }

    // Enrich tokens with Helius batch API only for tokens missing metadata
    // Skip if GeckoTerminal already provided complete name/symbol/logo
    if (useHeliusEnrichment && tokens && tokens.length > 0) {
      const needsEnrichment = tokens.filter(t => !t.name || !t.symbol || (!t.logoUri && !t.logoURI));
      if (needsEnrichment.length > 0) {
        const addresses = needsEnrichment.map(t => t.address || t.mintAddress);
        const heliusMetadata = await solanaService.getTokenMetadataBatch(addresses);

        for (const token of needsEnrichment) {
          const address = token.address || token.mintAddress;
          const meta = heliusMetadata[address];
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

    // Privacy: Don't log token counts or data

    // Filter out tokens without valid Solana addresses (defensive: some API responses
    // occasionally include entries with missing address fields)
    if (tokens && tokens.length > 0) {
      tokens = tokens.filter(t => {
        const addr = t.address || t.mintAddress;
        return addr && SOLANA_ADDRESS_REGEX.test(addr);
      });
    }

    // Enrich tokens with view counts, sentiment scores, and community flags in parallel
    if (tokens && tokens.length > 0) {
      const addresses = tokens.map(t => t.address || t.mintAddress);
      const [dbViewCounts, sentimentScores, communityMints] = await Promise.all([
        db.getTokenViewsBatch(addresses).catch(() => ({})),
        db.getSentimentBatch(addresses).catch(() => ({})),
        db.hasApprovedSubmissionsBatch(addresses).catch(() => new Set())
      ]);
      const viewCounts = mergeViewCounts(dbViewCounts, addresses);

      for (const token of tokens) {
        const address = token.address || token.mintAddress;
        token.views = viewCounts[address] || 0;
        const s = sentimentScores[address];
        token.sentimentScore = s ? s.score : 0;
        token.sentimentBullish = s ? s.bullish : 0;
        token.sentimentBearish = s ? s.bearish : 0;
        token.hasCommunityUpdates = communityMints.has(address);
      }
    }

    // Cache for 5 minutes (rolling cache for list views)
    await cache.setWithTimestamp(cacheKey, tokens, TTL.PRICE_DATA);

    res.json(tokens);
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
      // Fetch from Helius and local DB in parallel (independent sources)
      // Helius has priority; DB is fallback for mints Helius doesn't cover
      const [heliusData, dbRows] = await Promise.all([
        solanaService.isHeliusConfigured()
          ? solanaService.getTokenMetadataBatch(uncachedMints).catch(catchUnlessOverloaded({}))
          : Promise.resolve({}),
        db.getTokensBatch(uncachedMints).catch(() => [])
      ]);

      const localTokens = {};
      if (dbRows) {
        for (const local of dbRows) {
          if (local && local.mint_address && !heliusData[local.mint_address]) {
            localTokens[local.mint_address] = {
              mintAddress: local.mint_address,
              address: local.mint_address,
              name: local.name,
              symbol: local.symbol,
              decimals: local.decimals,
              logoUri: local.logo_uri
            };
          }
        }
      }

      // Priority 3: Try GeckoTerminal batch (market data) for mints still unresolved
      let geckoData = {};
      const stillNeeded = uncachedMints.filter(m => !heliusData[m] && !localTokens[m]);
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

        const heliusHasName = heliusData[mint]?.name && !PLACEHOLDER_NAMES.has(heliusData[mint].name.toLowerCase());
        const localHasName = localTokens[mint]?.name && !PLACEHOLDER_NAMES.has(localTokens[mint].name.toLowerCase());
        const geckoHasName = geckoData[mint]?.name && !PLACEHOLDER_NAMES.has(geckoData[mint].name.toLowerCase());

        if (heliusHasName) {
          const h = heliusData[mint];
          tokenData = {
            mintAddress: mint,
            address: mint,
            name: h.name,
            symbol: h.symbol || mintSymbol,
            decimals: h.decimals || 9,
            logoUri: h.logoUri || null,
            logoURI: h.logoUri || null,
            price: 0,
            priceChange24h: null,
            volume24h: 0,
            marketCap: 0
          };
        } else if (localHasName) {
          tokenData = localTokens[mint];
        } else if (geckoHasName) {
          const g = geckoData[mint];
          tokenData = {
            mintAddress: mint,
            address: mint,
            name: g.name,
            symbol: g.symbol || mintSymbol,
            decimals: g.decimals || 9,
            logoUri: g.logoUri || null,
            logoURI: g.logoUri || null,
            price: g.price || 0,
            priceChange24h: g.priceChange24h ?? null,
            volume24h: g.volume24h || 0,
            marketCap: g.marketCap || 0
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
        // full token detail cache (which includes liquidity, holders, supply, etc.)
        if (tokenData) {
          const batchCacheKey = `batch:${mint}`;
          cachePromises.push(cache.setWithTimestamp(batchCacheKey, tokenData, TTL.PRICE_DATA));
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
  const cacheKey = keys.tokenSearch(query.toLowerCase()) + (dexFilter ? ':dex' : '');

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

            // Cache to local database for future lookups
            db.upsertToken({
              mintAddress: query,
              name: externalInfo.name,
              symbol: externalInfo.symbol,
              decimals: externalInfo.decimals,
              logoUri: externalInfo.logoUri
            }).catch(err => {
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
      const [geckoResults, jupiterResults] = await Promise.all([
        geckoService.searchTokens(query, MIN_SEARCH_RESULTS, dexPrefixes).catch(catchUnlessOverloaded([])),
        jupiterService.searchTokens(query, MIN_SEARCH_RESULTS).catch(catchUnlessOverloaded([]))
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

// GET /api/tokens/leaderboard/watchlist - Most watchlisted tokens
router.get('/leaderboard/watchlist', asyncHandler(async (req, res) => {
  const limit = Math.min(Math.max(1, parseInt(req.query.limit) || 25), 100);
  const offset = Math.max(0, parseInt(req.query.offset) || 0);

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
      heliusMetadata = await solanaService.getTokenMetadataBatch(missingMints);
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
      marketCap: parseFloat(r.market_cap) || 0,
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
  const offset = Math.max(0, parseInt(req.query.offset) || 0);

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
      heliusMetadata = await solanaService.getTokenMetadataBatch(missingMints);
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
      marketCap: parseFloat(r.market_cap) || 0,
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
  const offset = Math.max(0, parseInt(req.query.offset) || 0);

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
      heliusMetadata = await solanaService.getTokenMetadataBatch(missingMints);
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
      marketCap: parseFloat(r.market_cap) || 0,
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
  if (req.query.search) filters.search = req.query.search.slice(0, 100);

  const filterKey = JSON.stringify(filters);
  const resultCacheKey = `leaderboard:conviction:${limit}:${offset}:${filterKey}`;
  const cached = await cache.get(resultCacheKey);
  if (cached) return res.json(cached);

  // Primary source: DB (persistent, survives cache expiry)
  const { tokens: dbRows, total } = await db.getTopConvictionTokens(limit, offset, filters).catch(() => ({ tokens: [], total: 0 }));

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
      priceChange24h: row.price_change_24h != null ? parseFloat(row.price_change_24h) : null,
      volume24h: parseFloat(row.volume_24h) || 0,
      marketCap: parseFloat(row.market_cap) || 0,
      logoUri: row.logo_uri || null,
      logoURI: row.logo_uri || null,
      conviction: distribution,
      conviction1m: parseFloat(row.conviction_1m) || 0,
      sampleSize: row.conviction_sample_size || 0,
      analyzed: row.conviction_sample_size || 0,
      convictionUpdatedAt: row.conviction_computed_at || null,
      holders: null
    };
  });

  // Batch-fetch holder counts from cache
  if (tokens.length > 0) {
    await Promise.all(tokens.map(async (t) => {
      const count = await cache.get(`holder-total:${t.mintAddress}`)
        || await cache.get(keys.holderCount(t.mintAddress));
      if (count && count > 0) t.holders = count;
    }));
  }

  const result = { tokens, total };
  await cache.set(resultCacheKey, result, TTL.MEDIUM);
  res.json(result);
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

  const cacheKey = `spikes:${minAgeDays}:${resultLimit}`;
  const cached = await cache.get(cacheKey);
  if (cached) {
    return res.json(cached);
  }

  try {
    // Step 1: Fetch trending pools from GeckoTerminal
    // First try to reuse token list cache (populated by /api/tokens?filter=trending)
    // to avoid redundant GeckoTerminal calls that compete for the shared rate limiter.
    const useHeliusEnrichment = solanaService.isHeliusConfigured();
    let allTokens = [];

    // Check if the main token list already has cached trending data
    // Deep-copy to avoid mutating the cached objects (we modify pairCreatedAt, name, etc. below)
    const cachedList = await cache.getWithMeta(keys.tokenList('trending-volume-desc-50', 0));
    if (cachedList && cachedList.value && cachedList.value.length > 0) {
      allTokens = cachedList.value.map(t => ({ ...t }));
    } else {
      // No cached trending data — fetch from GeckoTerminal (2 pages, not 3, to reduce load)
      const pageFetches = [1, 2].map(page =>
        geckoService.getTrendingTokens({ limit: 20, skipEnrichment: useHeliusEnrichment, page })
          .catch(catchUnlessOverloaded([]))
      );
      const pages = await Promise.all(pageFetches);
      for (const pageTokens of pages) {
        if (pageTokens) allTokens = allTokens.concat(pageTokens);
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

    if (allTokens.length === 0) {
      const result = { tokens: [], updatedAt: Date.now() };
      await cache.set(cacheKey, result, TTL.MEDIUM);
      return res.json(result);
    }

    // Step 2: Get pool creation dates for age filtering
    // GeckoTerminal trending pools don't always include pool_created_at,
    // so fetch token overviews for tokens missing creation dates
    const minAgeMs = minAgeDays * 24 * 60 * 60 * 1000;
    const now = Date.now();

    // For tokens without pairCreatedAt, try to get it from DB or GeckoTerminal overview
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

    if (established.length === 0) {
      const result = { tokens: [], updatedAt: Date.now() };
      await cache.set(cacheKey, result, TTL.MEDIUM);
      return res.json(result);
    }

    // Step 4: Enrich with Helius metadata (name, symbol, logo)
    if (useHeliusEnrichment) {
      const needsEnrichment = established.filter(t => !t.name || !t.symbol || (!t.logoUri && !t.logoURI));
      if (needsEnrichment.length > 0) {
        try {
          const addresses = needsEnrichment.map(t => t.address || t.mintAddress);
          const metadata = await solanaService.getTokenMetadataBatch(addresses);
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

    // Sort by spike score descending, return top N
    scored.sort((a, b) => b.spikeScore - a.spikeScore);
    const results = scored.slice(0, resultLimit);

    const result = { tokens: results, updatedAt: Date.now(), totalScanned: allTokens.length, totalEstablished: established.length };
    await cache.set(cacheKey, result, TTL.MEDIUM);
    res.json(result);
  } catch (error) {
    if (error.isOverloaded || error.isCircuitBreakerError) throw error;
    console.error('[Spikes] Error:', error.message);
    res.status(500).json({ error: 'Failed to detect spike tokens' });
  }
}));

// GET /api/tokens/:mint - Get single token details
// Uses 5-minute cache but requires data < 1 minute old (fresh) for individual token views
// Optimized: Uses getOrSetWithFreshness for stampede prevention on concurrent requests
router.get('/:mint', validateMint, asyncHandler(async (req, res) => {
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

    // Use getOrSetWithFreshness for stampede prevention
    // If multiple requests come in for the same token, they share one API fetch
    const result = await cache.getOrSetWithFreshness(cacheKey, async () => {
      // Fetch core data in parallel — holder count uses cache-first to avoid
      // blocking on paginated Helius DAS calls (which can take 2-30s for popular tokens).
      const fetchPromises = [
        // Helius provides: metadata, supply, price (for top 10k tokens)
        solanaService.isHeliusConfigured()
          ? solanaService.getTokenMetadata(mint).catch(catchUnlessOverloaded(null))
          : Promise.resolve(null),
        // GeckoTerminal pools: volume, price change, liquidity + coingeckoId
        geckoService.getTokenOverview(mint),
        db.getApprovedSubmissions(mint).catch(() => []),
        // Holder count: use cache (24h TTL) — never block on paginated DAS call
        cache.get(`holder-total:${mint}`).then(c => c || cache.get(keys.holderCount(mint)))
      ];

      const results = await Promise.all(fetchPromises);
      const [heliusMetadata, geckoOverview, submissions, cachedHolders] = results;

      // Use cached holder count; if missing, fire-and-forget a background fetch
      let holders = (typeof cachedHolders === 'number' && cachedHolders > 0) ? cachedHolders : null;
      if (!holders && solanaService.isHeliusConfigured()) {
        // Don't await — let it populate the cache for the next request
        solanaService.getTokenHolderCount(mint).then(count => {
          if (count && count > 0) {
            cache.set(keys.holderCount(mint), count, TTL.DAY);
            cache.set(`holder-total:${mint}`, count, TTL.DAY);
          }
        }).catch(() => {});
      }

      // Privacy: Don't log API response details

      // Data priority:
      // - Metadata (name, symbol, decimals): Helius > GeckoTerminal > Jupiter fallback
      // - Price: GeckoTerminal (more accurate) > Helius (only top 10k, cached)
      // - Volume, price change, liquidity: GeckoTerminal only
      const helius = heliusMetadata || {};
      const gecko = geckoOverview || {};

      // Calculate supply - prefer Helius (more accurate), fallback to GeckoTerminal
      let supply = helius.supply || null;
      let circulatingSupply = supply;
      if (!supply && gecko.totalSupply) {
        const decimals = helius.decimals || gecko.decimals || 9;
        const rawSupply = parseFloat(gecko.totalSupply);
        supply = rawSupply / Math.pow(10, decimals);
        circulatingSupply = supply;
      }

      // Resolve social links and Jupiter name fallback in parallel (non-blocking).
      // Links are cached for 24h since they rarely change.
      const linksCacheKey = `default-links:${mint}`;
      const [cachedLinks, jupiterMeta] = await Promise.all([
        cache.get(linksCacheKey),
        (!helius.name && !gecko.name)
          ? jupiterService.getTokenInfo(mint).catch(() => null)
          : Promise.resolve(null)
      ]);
      const jup = jupiterMeta || {};

      // Use cached links if available; otherwise fetch off-chain metadata in the background.
      // Don't block the response on IPFS/Arweave fetches (can take 1-5s).
      let mergedDefaultLinks = {};
      if (cachedLinks && Object.keys(cachedLinks).length > 0) {
        mergedDefaultLinks = cachedLinks;
      } else if (!cachedLinks && helius.jsonUri) {
        // Fire-and-forget: fetch off-chain links and cache for next request
        solanaService.fetchOffchainLinks(helius.jsonUri).then(offchainLinks => {
          const onchain = helius.onchainLinks || {};
          const links = {};
          for (const key of ['website', 'twitter', 'telegram', 'discord']) {
            if (offchainLinks && offchainLinks[key]) links[key] = offchainLinks[key];
            else if (onchain[key]) links[key] = onchain[key];
          }
          if (Object.keys(links).length > 0) {
            cache.set(linksCacheKey, links, TTL.DAY);
          }
        }).catch(() => {});
        // Use on-chain links as immediate fallback
        const onchain = helius.onchainLinks || {};
        for (const key of ['website', 'twitter', 'telegram', 'discord']) {
          if (onchain[key]) mergedDefaultLinks[key] = onchain[key];
        }
      }

      const tokenResult = {
        mintAddress: mint,
        address: mint,
        // Metadata: prefer Helius (faster, from RPC) then GeckoTerminal then Jupiter
        name: helius.name || gecko.name || jup.name || `${mint.slice(0, 4)}...${mint.slice(-4)}`,
        symbol: helius.symbol || gecko.symbol || jup.symbol || mint.slice(0, 5).toUpperCase(),
        decimals: helius.decimals || gecko.decimals || 9,
        logoUri: helius.logoUri || gecko.logoUri || null,
        logoURI: helius.logoUri || gecko.logoURI || null,
        // Price: prefer GeckoTerminal (more accurate), fallback to Helius
        price: gecko.price || helius.price || 0,
        // Market data: GeckoTerminal only (Helius doesn't provide these)
        priceChange24h: gecko.priceChange24h || jup.priceChange24h || 0,
        volume24h: gecko.volume24h || 0,
        liquidity: gecko.liquidity || 0,
        marketCap: gecko.marketCap || gecko.fdv || 0,
        fdv: gecko.fdv || 0,
        // Supply data - prefer Helius
        supply: supply,
        circulatingSupply: circulatingSupply,
        totalSupply: gecko.totalSupply || null,
        // Holder count from Helius (cached daily)
        holders: holders || null,
        // Token age (first pool creation timestamp from GeckoTerminal)
        pairCreatedAt: gecko.pairCreatedAt || null,
        // Default social links from token metadata (not community-submitted)
        defaultLinks: Object.keys(mergedDefaultLinks).length > 0 ? mergedDefaultLinks : null,
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
        const dbViews = await db.getTokenViews(mint);
        const buffered = jobQueue.getBufferedViewCounts([mint]);
        tokenResult.views = dbViews + (buffered[mint] || 0);
      } catch {
        tokenResult.views = 0;
      }

      // Also save to database for future reference
      const tokenName = helius.name || gecko.name;
      const tokenSymbol = helius.symbol || gecko.symbol;
      if (tokenName && tokenSymbol) {
        db.upsertToken({
          mintAddress: mint,
          name: tokenName,
          symbol: tokenSymbol,
          decimals: helius.decimals || gecko.decimals || 9,
          logoUri: helius.logoUri || gecko.logoUri,
          pairCreatedAt: gecko.pairCreatedAt || null,
          price: gecko.price || null,
          marketCap: gecko.marketCap || gecko.fdv || null,
          volume24h: gecko.volume24h || null,
          priceChange24h: gecko.priceChange24h || null
        }).catch(() => { /* Privacy: Don't log error details */ });
      }

      return tokenResult;
    }); // Use standard caching with stampede prevention (was requireFresh=true)

    if (!res.headersSent) res.json(result);
  } catch (error) {
    if (error.isOverloaded || error.isCircuitBreakerError) throw error;
    if (!res.headersSent) res.status(500).json({ error: 'Failed to fetch token details' });
  }
}));

// GET /api/tokens/:mint/price - Get price data only
// Uses 5-minute cache with 1-minute freshness for individual views
// Optimized: Uses getOrSetWithFreshness for stampede prevention
router.get('/:mint/price', validateMint, asyncHandler(async (req, res) => {
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
        if (err.isOverloaded || err.isCircuitBreakerError) throw err;
        // GeckoTerminal failed or timed out — fall through to Jupiter
      }

      if (!data) {
        data = await jupiterService.getTokenPrice(mint);
      }

      return data;
    });

    if (!res.headersSent) res.json(priceData);
  } catch (error) {
    if (error.isOverloaded || error.isCircuitBreakerError) throw error;
    if (!res.headersSent) res.status(500).json({ error: 'Failed to fetch price data' });
  }
}));

// GET /api/tokens/:mint/chart - Get price history for charts
// Uses getOrSet for automatic caching with stampede prevention
router.get('/:mint/chart', validateMint, asyncHandler(async (req, res) => {
  const { mint } = req.params;
  const { interval = '1h', limit = 100 } = req.query;

  // Validate interval
  const validIntervals = ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w'];
  const normalizedInterval = interval.toLowerCase();

  if (!validIntervals.includes(normalizedInterval)) {
    return res.status(400).json({
      error: 'Invalid interval',
      validIntervals
    });
  }

  const cacheKey = keys.tokenChart(mint, normalizedInterval);
  // Use longer TTL for chart data - minute intervals cache 1min, others cache 2min
  const cacheTTL = normalizedInterval.includes('m') ? TTL.MEDIUM : TTL.OHLCV;

  try {
    // Use getOrSet for caching with stampede prevention
    const chartData = await cache.getOrSet(cacheKey, async () => {
      // Try GeckoTerminal with 4s timeout, fall back to Jupiter on failure/empty
      let data = null;
      try {
        data = await Promise.race([
          geckoService.getPriceHistory(mint, { interval: normalizedInterval }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Chart timeout')), 4000))
        ]);
      } catch (err) {
        if (err.isOverloaded || err.isCircuitBreakerError) throw err;
        // GeckoTerminal failed or timed out — fall through to Jupiter
      }

      if (!data || !data.data || data.data.length === 0) {
        data = await jupiterService.getPriceHistory(mint, {
          interval: normalizedInterval,
          limit: Math.min(Math.max(1, parseInt(limit) || 100), 500)
        });
      }

      return data;
    }, cacheTTL);

    if (!res.headersSent) res.json(chartData);
  } catch (error) {
    if (error.isOverloaded || error.isCircuitBreakerError) throw error;
    if (!res.headersSent) res.status(500).json({ error: 'Failed to fetch chart data' });
  }
}));

// GET /api/tokens/:mint/ohlcv - Get OHLCV data for candlestick charts
// Uses getOrSet for automatic caching with stampede prevention
router.get('/:mint/ohlcv', validateMint, asyncHandler(async (req, res) => {
  const { mint } = req.params;
  const { interval = '1h' } = req.query;

  // Validate interval to prevent cache key pollution
  const validIntervals = ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w'];
  const normalizedInterval = interval.toLowerCase();
  if (!validIntervals.includes(normalizedInterval)) {
    return res.status(400).json({ error: 'Invalid interval', validIntervals });
  }

  const cacheKey = `ohlcv:${mint}:${normalizedInterval}`;

  try {
    // Use getOrSet for caching with stampede prevention
    // OHLCV data cached for 2 minutes to reduce GeckoTerminal API load
    const ohlcvData = await cache.getOrSet(cacheKey, async () => {
      return geckoService.getOHLCV(mint, { interval: normalizedInterval });
    }, TTL.OHLCV);

    if (!res.headersSent) res.json(ohlcvData);
  } catch (error) {
    if (error.isOverloaded || error.isCircuitBreakerError) throw error;
    if (!res.headersSent) res.status(500).json({ error: 'Failed to fetch OHLCV data' });
  }
}));

// GET /api/tokens/:mint/pools - Get liquidity pools for a token
// Uses getOrSet for automatic caching with stampede prevention
router.get('/:mint/pools', validateMint, asyncHandler(async (req, res) => {
  const { mint } = req.params;
  const { limit = 10 } = req.query;

  const cacheKey = keys.pools(mint);

  try {
    // Use getOrSet for caching with stampede prevention
    // Pools data cached for 3 minutes - pool info rarely changes
    const pools = await cache.getOrSet(cacheKey, async () => {
      return geckoService.getTokenPools(mint, { limit: parseInt(limit) });
    }, TTL.POOLS);

    if (!res.headersSent) res.json(pools);
  } catch (error) {
    if (error.isOverloaded || error.isCircuitBreakerError) throw error;
    // Privacy: Don't log error details
    if (!res.headersSent) res.status(500).json({ error: 'Failed to fetch pools data' });
  }
}));

// GET /api/tokens/:mint/submissions - Get all submissions for a token
router.get('/:mint/submissions', validateMint, asyncHandler(async (req, res) => {
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
router.post('/:mint/view', strictLimiter, validateMint, asyncHandler(async (req, res) => {
  const { mint } = req.params;

  try {
    // Use job queue for batched view counting (non-blocking)
    // Falls back to direct DB write if job queue not available
    const bufferedCount = await jobQueue.incrementViewCount(mint);

    // Return current known count (may be slightly stale but fast)
    const dbCount = await db.getTokenViews(mint);
    res.json({ views: dbCount + (bufferedCount || 0) });
  } catch (error) {
    // Fallback: Direct database update if job queue fails
    try {
      const viewCount = await db.incrementTokenViews(mint);
      res.json({ views: viewCount });
    } catch (fallbackError) {
      // Privacy: Don't log error details - view tracking is non-critical
      res.json({ views: 0 });
    }
  }
}));

// GET /api/tokens/:mint/views - Get view count for a token
router.get('/:mint/views', validateMint, asyncHandler(async (req, res) => {
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
// Used to verify submitter holds the token they want to update
router.get('/:mint/holder/:wallet', validateMint, asyncHandler(async (req, res) => {
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
            decimals = info.tokenAmount?.decimals || 9;
          }
        }
      }
    } catch (rpcErr) {
      // RPC failed — try DAS fallback below
    }

    // Method 2: Helius DAS fallback if RPC failed or returned zero
    // DAS getTokenAccounts can find Token-2022 accounts that standard RPC may miss
    if (balance === 0 && HELIUS_DAS_URL) {
      try {
        const dasResponse = await axios.post(HELIUS_DAS_URL, {
          jsonrpc: '2.0', id: 1,
          method: 'getTokenAccounts',
          params: { owner: wallet, mint, limit: 10 }
        }, { timeout: 10000 });

        if (dasResponse.data?.result?.token_accounts?.length > 0) {
          rpcSuccess = true;
          for (const ta of dasResponse.data.result.token_accounts) {
            if (ta.mint === mint) {
              const rawAmt = parseFloat(ta.amount || 0);
              // DAS doesn't return decimals per-account; use token info or default
              if (rawAmt > 0) {
                // We'll get exact balance from supply calc below; for now mark as holder
                balance = rawAmt / Math.pow(10, decimals);
              }
            }
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
    let liquidity = null;
    let circulatingSupply = null;
    let percentageHeld = null;

    // Try to get token info for supply data
    // Token info is stored via setWithTimestamp — use getWithMeta to unwrap correctly
    const tokenInfoMeta = await cache.getWithMeta(keys.tokenInfo(mint))
      || await cache.getWithMeta(`batch:${mint}`);
    const tokenInfo = tokenInfoMeta?.value ?? null;
    if (tokenInfo) {
      totalSupply = tokenInfo.supply || tokenInfo.totalSupply;
      liquidity = tokenInfo.liquidity;
      // Estimate circulating supply (total - liquidity locked)
      // This is a rough approximation
      if (totalSupply && liquidity && tokenInfo.price) {
        const liquidityTokens = liquidity / tokenInfo.price;
        circulatingSupply = Math.max(0, totalSupply - liquidityTokens);
      } else {
        circulatingSupply = totalSupply;
      }
    }

    // Calculate percentage if we have supply data
    if (balance > 0 && circulatingSupply && circulatingSupply > 0) {
      percentageHeld = (balance / circulatingSupply) * 100;
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

    // Cache for 1 minute (balances change frequently)
    await cache.set(cacheKey, result, 60000);

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

// GET /api/tokens/:mint/holders - Top holder analytics
// Returns the 20 largest token accounts with concentration metrics
router.get('/:mint/holders', validateMint, asyncHandler(async (req, res) => {
  const { mint } = req.params;
  const cacheKey = `holder-analytics:${mint}`;

  try {
    // Allow ?fresh=true to bypass cache (rate-limited by frontend to 1 per minute)
    if (req.query.fresh !== 'true') {
      const cached = await cache.get(cacheKey);
      if (cached) return res.json(cached);
    }

    // Get largest accounts, supply, mint account info, and token authorities in parallel.
    // Try standard RPC first (fast, pre-sorted), fall back to Helius DAS if it fails.
    const [rpcAccounts, supplyResult, mintAccount, tokenAuth] = await Promise.all([
      solanaService.getTokenLargestAccounts(mint),
      solanaService.getTokenSupply(mint).catch(catchUnlessOverloaded(null)),
      solanaService.getAccountInfo(mint).catch(catchUnlessOverloaded(null)),
      solanaService.getTokenAuthorities(mint).catch(catchUnlessOverloaded(null))
    ]);

    // If standard RPC failed, try Helius DAS API as fallback
    let largestAccounts = rpcAccounts;
    if (!largestAccounts) {
      const decimals = supplyResult?.value?.decimals || mintAccount?.value?.data?.parsed?.info?.decimals || 0;
      console.log(`[Tokens] Standard RPC failed for ${mint}, trying Helius DAS fallback (decimals=${decimals})`);
      largestAccounts = await solanaService.getTokenLargestAccountsDAS(mint, decimals);
    }

    if (!largestAccounts || largestAccounts.length === 0) {
      // Both methods failed — don't cache the failure
      return res.json({ holders: [], totalSupply: null, metrics: null, supply: null, error: !rpcAccounts ? 'rpc_unavailable' : null });
    }

    const totalSupply = supplyResult?.value
      ? parseFloat(supplyResult.value.uiAmountString || supplyResult.value.uiAmount || 0)
      : null;

    // Parse supply details + check for locked/burnt tokens among top holders
    let supply = null;
    const mintData = mintAccount?.value?.data?.parsed?.info;
    const decimals = mintData?.decimals || supplyResult?.value?.decimals || 0;
    const currentSupply = mintData
      ? parseFloat(mintData.supply) / Math.pow(10, decimals)
      : totalSupply;

    // Classify top holder accounts:
    // - Burnt: tokens sent to known dead/burn wallet addresses
    // - LP: tokens held by liquidity pool programs (Raydium, Orca, Meteora, etc.)
    // - Locked: Streamflow vesting contracts (queried by mint address)
    let deadWalletBurnt = 0;
    let lockedAmount = 0;
    const lpIndices = new Set();
    const burntIndices = new Set();

    // Start Streamflow lock detection in parallel with account classification below
    const streamflowPromise = solanaService.getStreamflowLockedAmount(mint, decimals).catch(err => {
      console.warn('[Tokens] Failed to check Streamflow locks:', err.message);
      return 0;
    });

    // DAS fallback provides wallet addresses directly (via `wallet` field);
    // standard RPC provides token account addresses that need resolution.
    const usedDAS = !rpcAccounts;
    try {
      const walletToIndices = new Map();
      if (usedDAS) {
        // DAS path: largestAccounts[].wallet is already the wallet owner
        largestAccounts.slice(0, 20).forEach((a, i) => {
          if (!a.wallet) return;
          if (BURN_WALLETS.has(a.wallet)) {
            deadWalletBurnt += a.uiAmount;
            burntIndices.add(i);
            return;
          }
          if (!walletToIndices.has(a.wallet)) walletToIndices.set(a.wallet, []);
          walletToIndices.get(a.wallet).push(i);
        });
      } else {
        // Standard RPC path: resolve token account addresses → wallet owners
        const accountAddresses = largestAccounts.slice(0, 20).map(a => a.address);
        const tokenAccounts = await solanaService.getMultipleAccounts(accountAddresses);
        if (tokenAccounts?.value) {
          tokenAccounts.value.forEach((acct, i) => {
            const wallet = acct?.data?.parsed?.info?.owner;
            if (!wallet) return;
            largestAccounts[i].wallet = wallet; // Store for display
            if (BURN_WALLETS.has(wallet)) {
              deadWalletBurnt += largestAccounts[i].uiAmount;
              burntIndices.add(i);
              return;
            }
            if (!walletToIndices.has(wallet)) walletToIndices.set(wallet, []);
            walletToIndices.get(wallet).push(i);
          });
        }
      }

      // Check wallet accounts' on-chain owner to detect LP programs
      const wallets = [...walletToIndices.keys()];
      if (wallets.length > 0) {
        const walletAccounts = await solanaService.getMultipleAccounts(wallets);
        if (walletAccounts?.value) {
          walletAccounts.value.forEach((acct, wi) => {
            if (!acct) return;
            if (LP_PROGRAMS.has(acct.owner)) {
              const indices = walletToIndices.get(wallets[wi]);
              if (indices) {
                for (const idx of indices) lpIndices.add(idx);
              }
            }
          });
        }
      }
    } catch (err) {
      console.warn('[Tokens] Failed to classify holder accounts:', err.message);
    }

    // Await Streamflow result (started above, ran in parallel with account classification)
    lockedAmount = await streamflowPromise;

    // SPL burn detection — only reliable for pump.fun tokens where the initial supply
    // is known (exactly 1,000,000,000 with 6 decimals). For other tokens, the initial
    // supply is unknown so we can't calculate SPL burns accurately.
    // Dead wallet burns (tokens sent to incinerator etc.) are detected for all tokens
    // via the top-holder scan above.
    const PUMP_FUN_AUTHORITIES = new Set([
      'TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM',  // pump.fun metadata authority
      '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',  // pump.fun program
      '39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg', // pump.fun fee account
    ]);

    let splBurnt = 0;
    let isPumpFun = false;

    if (currentSupply && currentSupply > 0) {
      // Pump.fun detection — check Helius authorities first
      const isPumpFunAuth = tokenAuth?.authorities?.some(a => PUMP_FUN_AUTHORITIES.has(a.address));

      // Fallback: detect via mint account pattern (6 decimals, both authorities revoked,
      // supply <= 1B). Catches tokens when Helius DAS doesn't return authority data.
      const isPumpFunMint = !isPumpFunAuth && decimals === 6 && mintData
        && mintData.mintAuthority === null
        && mintData.freezeAuthority === null
        && currentSupply > 0 && currentSupply <= 1000000000;

      isPumpFun = !!(isPumpFunAuth || isPumpFunMint);

      if (isPumpFun && decimals === 6) {
        const initialSupply = 1000000000; // 1 billion — all pump.fun tokens
        if (initialSupply > currentSupply) {
          splBurnt = initialSupply - currentSupply;
        }
      }
    }

    const burntAmount = splBurnt + deadWalletBurnt;
    // For pump.fun, denominator is the known 1B initial supply.
    // For dead-wallet-only burns, use currentSupply (tokens still exist on-chain).
    const supplyDenominator = isPumpFun ? 1000000000 : currentSupply;

    supply = {
      total: currentSupply,
      burnt: burntAmount,
      burntPct: supplyDenominator > 0 && burntAmount > 0 ? (burntAmount / supplyDenominator) * 100 : 0,
      locked: lockedAmount,
      lockedPct: currentSupply > 0 && lockedAmount > 0 ? (lockedAmount / currentSupply) * 100 : 0,
      splBurnt,
      deadWalletBurnt,
      isPumpFun
    };

    // Build holders list with LP/burnt flags
    // Prefer wallet address (meaningful to users) over token account address
    const holders = largestAccounts.map((a, i) => ({
      rank: i + 1,
      address: a.wallet || a.address,
      balance: a.uiAmount,
      percentage: (totalSupply || currentSupply) > 0 ? (a.uiAmount / (totalSupply || currentSupply)) * 100 : null,
      isLP: lpIndices.has(i),
      isBurnt: burntIndices.has(i)
    })).filter(h => h.balance > 0);

    // Concentration metrics — exclude LP and burnt wallets
    const realHolders = holders.filter(h => !h.isLP && !h.isBurnt);
    let metrics = null;
    if (totalSupply > 0 && realHolders.length > 0) {
      const top5Pct = realHolders.slice(0, 5).reduce((s, h) => s + (h.percentage || 0), 0);
      const top10Pct = realHolders.slice(0, 10).reduce((s, h) => s + (h.percentage || 0), 0);
      const top20Pct = realHolders.reduce((s, h) => s + (h.percentage || 0), 0);

      // Herfindahl-Hirschman Index (0-10000 scale) — higher = more concentrated
      const herfindahl = realHolders.reduce((s, h) => s + Math.pow(h.percentage || 0, 2), 0);

      // #1 holder dominance — what % of top-20 holdings belong to the single largest holder
      const top1Pct = realHolders[0]?.percentage || 0;
      const dominance = top20Pct > 0 ? (top1Pct / top20Pct) * 100 : 0;

      // Average holding among real holders (excl LP/burnt)
      const avgBalance = realHolders.reduce((s, h) => s + h.balance, 0) / realHolders.length;
      const avgPct = top20Pct / realHolders.length;

      // Concentration risk rating
      let riskLevel = 'low';
      if (top10Pct > 70 || top1Pct > 30) riskLevel = 'high';
      else if (top10Pct > 40 || top1Pct > 15) riskLevel = 'medium';

      metrics = {
        top5Pct: Math.round(top5Pct * 100) / 100,
        top10Pct: Math.round(top10Pct * 100) / 100,
        top20Pct: Math.round(top20Pct * 100) / 100,
        herfindahl: Math.round(herfindahl),
        top1Pct: Math.round(top1Pct * 100) / 100,
        dominance: Math.round(dominance * 100) / 100,
        avgBalance: avgBalance,
        avgPct: Math.round(avgPct * 100) / 100,
        riskLevel: riskLevel,
        holderCount: realHolders.length
      };

      // Use cached holder count, or fetch via paginated DAS if missing
      try {
        let totalCount = await cache.get(`holder-total:${mint}`)
          || await cache.get(keys.holderCount(mint));
        // If no cached count, fetch the real count (non-blocking for response but cache it)
        if (!totalCount && solanaService.isHeliusConfigured()) {
          totalCount = await solanaService.getTokenHolderCount(mint).catch(() => null);
          if (totalCount && totalCount > 0) {
            await cache.set(`holder-total:${mint}`, totalCount, TTL.DAY);
            await cache.set(keys.holderCount(mint), totalCount, TTL.DAY);
          }
        }
        if (totalCount && totalCount > 0) {
          metrics.holderCount = totalCount;
        }
      } catch (_) {}
    }

    const result = { holders, totalSupply, metrics, supply, fetchedAt: Date.now() };
    await cache.set(cacheKey, result, TTL.HOUR);
    if (!res.headersSent) res.json(result);
  } catch (error) {
    console.error('[Tokens] Holder analytics error:', error.message);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to fetch holder data' });
  }
}));

// GET /api/tokens/:mint/holders/hold-times - Average hold time per holder wallet
// Returns cached per-wallet hold times immediately. If any wallets are stale
// (>24hr or missing), queues a background worker job to compute them.
// Response includes `computed: false` when stale wallets are pending so the
// frontend knows to re-poll.
router.get('/:mint/holders/hold-times', validateMint, asyncHandler(async (req, res) => {
  const { mint } = req.params;

  try {
    // If Helius isn't configured, hold times can't be computed — return immediately
    if (!solanaService.isHeliusConfigured()) {
      return res.json({ holdTimes: {}, tokenHoldTimes: {}, computed: true });
    }

    // Get holder data (likely already cached from the main holders call).
    // If the cache is missing (expired/evicted), return computed: false so the
    // frontend keeps polling — the main holders endpoint will repopulate it.
    const holdersCache = await cache.get(`holder-analytics:${mint}`);
    if (!holdersCache || !holdersCache.holders || holdersCache.holders.length === 0) {
      console.log(`[HoldTimes] holder-analytics:${mint} cache miss — returning computed: false to trigger re-poll`);
      return res.json({ holdTimes: {}, tokenHoldTimes: {}, computed: false });
    }

    // Start with top 20 holders (skip LP and burn wallets)
    const top20Wallets = holdersCache.holders
      .filter(h => !h.isLP && !h.isBurnt && h.address)
      .map(h => h.address);

    // Use shared sample cache (wallet + ATA pairs) for efficient hold-time lookups
    let wallets = top20Wallets;
    let ataMap = {}; // wallet → ATA address (saves 1 RPC call per wallet)
    if (solanaService.isHeliusConfigured()) {
      try {
        const sampleCacheKey = `diamond-hands-wallets:${mint}`;
        let sample = await cache.get(sampleCacheKey);
        if (!sample) {
          const excludeSet = new Set([...BURN_WALLETS, ...LP_PROGRAMS]);
          const sampleResult = await solanaService.getTokenHolderSample(mint, 250, excludeSet);
          if (sampleResult && sampleResult.holders && sampleResult.holders.length > 0) {
            sample = sampleResult.holders;
            if (sampleResult.totalHolders) {
              await cache.set(`holder-total:${mint}`, sampleResult.totalHolders, TTL.DAY);
            }
            await cache.set(sampleCacheKey, sample, TTL.HOUR);
          }
        }
        // Build ATA map from sample (new format: [{wallet, ata}])
        if (Array.isArray(sample)) {
          for (const entry of sample) {
            if (typeof entry === 'object' && entry.wallet) {
              ataMap[entry.wallet] = entry.ata;
            }
          }
          const sampleWallets = sample.map(e => typeof e === 'object' ? e.wallet : e);
          if (sampleWallets.length > top20Wallets.length) {
            const top20Set = new Set(top20Wallets);
            const extra = sampleWallets.filter(w => !top20Set.has(w));
            wallets = [...top20Wallets, ...extra];
          }
        }
      } catch (err) {
        console.warn('[HoldTimes] Failed to expand holder sample:', err.message);
      }
    }

    if (wallets.length === 0) {
      return res.json({ holdTimes: {}, tokenHoldTimes: {}, computed: true });
    }

    // Check per-wallet caches, collect stale/missing wallets.
    // Cached values are either positive numbers or -1 sentinels (no data).
    const holdTimes = {};
    const tokenHoldTimes = {};
    const staleWallets = [];
    let freshWalletCount = 0;
    let walletAgeChecked = 0;
    const HOLD_CACHE_MS = 172800000; // 48h — hold times don't change fast

    await Promise.all(wallets.map(async (wallet) => {
      const [avgCached, tokenCached, ageCached] = await Promise.all([
        cache.get(`wallet-hold-time:${wallet}`),
        cache.get(`wallet-token-hold:${wallet}:${mint}`),
        cache.get(`wallet-age:${wallet}`)
      ]);

      if (avgCached != null) {
        if (avgCached > 0) holdTimes[wallet] = avgCached;
      }
      if (tokenCached != null) {
        if (tokenCached > 0) tokenHoldTimes[wallet] = tokenCached;
      }

      // Count fresh wallets (age < 24h). ageCached: positive ms = known age, -1 = unknown
      if (ageCached != null && ageCached > 0) {
        walletAgeChecked++;
        if (ageCached < 86400000) freshWalletCount++; // < 24h = fresh wallet
      } else if (ageCached === -1) {
        walletAgeChecked++; // age unknown (100+ txs) — not fresh
      }

      // Stale if either cache is missing
      if (avgCached == null || tokenCached == null) {
        staleWallets.push(wallet);
      }
    }));

    // Dispatch computation for stale wallets — try worker, fall back to inline.
    // Uses a unified pending key shared with diamond-hands so only ONE computation
    // runs per token, even when both endpoints are called simultaneously.
    let computed = true;
    if (staleWallets.length > 0) {
      const pendingKey = `holder-metrics-pending:${mint}`;
      const pending = await cache.get(pendingKey);
      let needsComputation = false;

      if (!pending) {
        needsComputation = true;
      } else if (typeof pending === 'number' && (Date.now() - pending) > 30000) {
        console.log(`[HolderMetrics] Pending for ${Math.round((Date.now() - pending) / 1000)}s, stale wallets remain — forcing inline fallback`);
        await cache.delete(pendingKey);
        needsComputation = true;
      } else {
        console.log(`[HolderMetrics] Already pending (${typeof pending === 'number' ? Math.round((Date.now() - pending) / 1000) + 's ago' : 'flag'}), ${staleWallets.length} stale wallets — waiting`);
      }

      if (needsComputation) {
        await cache.set(pendingKey, Date.now(), 120000);
        let useInline = false;

        const job = await jobQueue.addAnalyticsJob('compute-holder-metrics', {
          mint,
          wallets: staleWallets
        });

        if (job) {
          const workerActive = await jobQueue.isWorkerActive();
          if (!workerActive) {
            console.log(`[HolderMetrics] Job queued but no active worker — using inline fallback`);
            useInline = true;
          } else {
            console.log(`[HolderMetrics] Job queued to worker for ${staleWallets.length} wallets`);
          }
        } else {
          console.log(`[HolderMetrics] Job queue unavailable — using inline fallback`);
          useInline = true;
        }

        if (useInline) {
          const bgMint = mint;
          const HOLD_CACHE_MS = 172800000; // 48h — hold times don't change fast

          // Compute top 10 wallets synchronously (1 RPC call each with ATA)
          const syncWallets = staleWallets.slice(0, 10);
          const asyncWallets = staleWallets.slice(10);

          console.log(`[HolderMetrics] Inline: ${syncWallets.length} sync, ${asyncWallets.length} async for ${bgMint}`);

          const syncResults = await Promise.all(
            syncWallets.map(async (wallet) => {
              try {
                const holdTime = await solanaService.getTokenHoldTime(wallet, bgMint, ataMap[wallet] || null);
                return [wallet, holdTime];
              } catch { return [wallet, null]; }
            })
          );

          for (const [wallet, holdTime] of syncResults) {
            const val = holdTime ?? -1;
            await cache.set(`wallet-hold-time:${wallet}`, val, HOLD_CACHE_MS);
            await cache.set(`wallet-token-hold:${wallet}:${bgMint}`, val, HOLD_CACHE_MS);
            if (val > 0) { holdTimes[wallet] = val; tokenHoldTimes[wallet] = val; }
          }

          // Remaining wallets in background
          if (asyncWallets.length > 0) {
            setImmediate(() => {
              (async () => {
                const BATCH_SIZE = 5;
                let ok = 0, fail = 0;
                try {
                  for (let i = 0; i < asyncWallets.length; i += BATCH_SIZE) {
                    const batch = asyncWallets.slice(i, i + BATCH_SIZE);
                    const results = await Promise.all(
                      batch.map(async (w) => {
                        try {
                          return [w, await solanaService.getTokenHoldTime(w, bgMint, ataMap[w] || null)];
                        } catch { return [w, null]; }
                      })
                    );
                    for (const [w, ht] of results) {
                      const val = ht ?? -1;
                      await cache.set(`wallet-hold-time:${w}`, val, HOLD_CACHE_MS);
                      await cache.set(`wallet-token-hold:${w}:${bgMint}`, val, HOLD_CACHE_MS);
                      if (val > 0) ok++; else fail++;
                    }
                  }
                  console.log(`[HolderMetrics] Async done for ${bgMint}: ${ok} ok, ${fail} fail`);
                } catch (err) {
                  console.error(`[HolderMetrics] Async failed for ${bgMint}:`, err.message);
                } finally {
                  await cache.delete(`holder-metrics-pending:${bgMint}`);
                }
              })();
            });
          } else {
            await cache.delete(`holder-metrics-pending:${bgMint}`);
          }
        }
      }

      computed = false;
    }

    console.log(`[HoldTimes] Response for ${mint}: ${Object.keys(holdTimes).length} avg, ${Object.keys(tokenHoldTimes).length} token, computed=${computed}, stale=${staleWallets.length}, fresh=${freshWalletCount}/${walletAgeChecked}`);
    if (!res.headersSent) res.json({ holdTimes, tokenHoldTimes, computed, freshWallets: { count: freshWalletCount, checked: walletAgeChecked, total: wallets.length } });
  } catch (error) {
    console.error('[Tokens] Hold times error:', error.message);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to fetch hold times' });
  }
}));

// GET /api/tokens/:mint/holders/diamond-hands - Hold time distribution across top 250 holders
// Returns % of holders that have held the token for >6h, >24h, >3d, >1w, >1m.
// Uses Helius DAS to sample up to 250 holders, then getWalletHoldMetrics for each.
// Background computation with polling pattern (same as hold-times).
const DIAMOND_HANDS_BUCKETS = [
  { key: '6h',  label: '>6h',  ms: 6 * 3600000 },
  { key: '24h', label: '>24h', ms: 24 * 3600000 },
  { key: '3d',  label: '>3d',  ms: 3 * 86400000 },
  { key: '1w',  label: '>1w',  ms: 7 * 86400000 },
  { key: '1m',  label: '>1m',  ms: 30 * 86400000 },
  { key: '3m',  label: '>3m',  ms: 90 * 86400000 },
  { key: '6m',  label: '>6m',  ms: 180 * 86400000 },
  { key: '9m',  label: '>9m',  ms: 270 * 86400000 },
];

router.get('/:mint/holders/diamond-hands', validateMint, asyncHandler(async (req, res) => {
  const { mint } = req.params;

  try {
    if (!solanaService.isHeliusConfigured()) {
      return res.json({ distribution: null, sampleSize: 0, analyzed: 0, computed: true });
    }

    // Check for cached final result (1 hour TTL, set after full computation)
    const resultCacheKey = `diamond-hands:${mint}`;
    const cached = await cache.get(resultCacheKey);
    if (cached) {
      return res.json(cached);
    }

    // Get holder sample — filter out burn wallets and LP programs
    const walletsCacheKey = `diamond-hands-wallets:${mint}`;
    let wallets = await cache.get(walletsCacheKey);
    if (!wallets) {
      // Combine burn + LP addresses into a single exclusion set
      const excludeSet = new Set([...BURN_WALLETS, ...LP_PROGRAMS]);
      const sampleResult = await solanaService.getTokenHolderSample(mint, 250, excludeSet);
      if (!sampleResult || !sampleResult.holders || sampleResult.holders.length === 0) {
        return res.json({ distribution: null, sampleSize: 0, analyzed: 0, computed: true });
      }
      wallets = sampleResult.holders;
      if (sampleResult.totalHolders) {
        await cache.set(`holder-total:${mint}`, sampleResult.totalHolders, TTL.DAY);
      }
      await cache.set(walletsCacheKey, wallets, 3 * TTL.HOUR);
    }

    // Extract wallet addresses (new format: [{wallet, ata}], backwards-compat with old [string])
    const walletList = wallets.map(e => typeof e === 'object' ? e.wallet : e);
    const ataMap = {};
    if (Array.isArray(wallets)) {
      for (const e of wallets) {
        if (typeof e === 'object' && e.wallet && e.ata) ataMap[e.wallet] = e.ata;
      }
    }

    // Check per-wallet token hold time caches
    const holdTimes = {};
    const uncached = [];
    let analyzedCount = 0;

    await Promise.all(walletList.map(async (wallet) => {
      const val = await cache.get(`wallet-token-hold:${wallet}:${mint}`);
      if (val != null) {
        analyzedCount++;
        if (val > 0) holdTimes[wallet] = val;
      } else {
        uncached.push(wallet);
      }
    }));

    // If all wallets are cached, compute final distribution and cache it
    if (uncached.length === 0) {
      const result = buildDiamondHandsResult(holdTimes, walletList.length, analyzedCount);
      await cache.set(resultCacheKey, result, 3 * TTL.HOUR);
      // Persist to DB for the conviction leaderboard
      db.upsertConviction(mint, result.distribution, result.sampleSize, result.analyzed).catch(err => {
        console.error(`[DiamondHands] DB persist failed for ${mint.slice(0, 8)}:`, err.message);
      });
      return res.json(result);
    }

    // Background computation for uncached wallets.
    // Uses the same unified pending key as hold-times — if hold-times is already
    // computing these wallets, we piggyback on that instead of duplicating work.
    const pendingKey = `holder-metrics-pending:${mint}`;
    const pending = await cache.get(pendingKey);

    if (pending && typeof pending === 'number' && (Date.now() - pending) > 30000) {
      console.log(`[DiamondHands] Pending for ${Math.round((Date.now() - pending) / 1000)}s — retrying`);
      await cache.delete(pendingKey);
    }

    const isStillPending = await cache.get(pendingKey);

    if (!isStillPending) {
      await cache.set(pendingKey, Date.now(), 300000); // 5 min dedup

      const job = await jobQueue.addAnalyticsJob('compute-holder-metrics', {
        mint,
        wallets: uncached
      });

      let useInline = false;
      if (job) {
        const workerActive = await jobQueue.isWorkerActive();
        if (!workerActive) {
          console.log(`[DiamondHands] No worker — inline for ${uncached.length} wallets`);
          useInline = true;
        } else {
          console.log(`[DiamondHands] Job queued for ${uncached.length} wallets`);
        }
      } else {
        console.log(`[DiamondHands] Queue unavailable — inline for ${uncached.length} wallets`);
        useInline = true;
      }

      if (useInline) {
        const bgWallets = [...uncached];
        const bgMint = mint;

        setImmediate(() => {
          (async () => {
            console.log(`[DiamondHands] Inline: ${bgWallets.length} wallets for ${bgMint.slice(0, 8)}...`);
            const BATCH_SIZE = 10;
            const HOLD_CACHE_MS = 172800000; // 48h — hold times don't change fast
            let ok = 0;
            try {
              for (let i = 0; i < bgWallets.length; i += BATCH_SIZE) {
                const batch = bgWallets.slice(i, i + BATCH_SIZE);
                const results = await Promise.all(
                  batch.map(async (w) => {
                    try {
                      const ht = await solanaService.getTokenHoldTime(w, bgMint, ataMap[w] || null);
                      return [w, ht];
                    } catch { return [w, null]; }
                  })
                );
                for (const [w, ht] of results) {
                  const val = ht ?? -1;
                  await cache.set(`wallet-hold-time:${w}`, val, HOLD_CACHE_MS);
                  await cache.set(`wallet-token-hold:${w}:${bgMint}`, val, HOLD_CACHE_MS);
                  if (val > 0) ok++;
                }
              }
              console.log(`[DiamondHands] Inline done: ${ok}/${bgWallets.length} for ${bgMint.slice(0, 8)}`);
              // Rebuild and persist
              try {
                const allHoldTimes = {};
                let totalAnalyzed = 0;
                const allSample = await cache.get(`diamond-hands-wallets:${bgMint}`) || [];
                const allWalletList = allSample.map(e => typeof e === 'object' ? e.wallet : e);
                for (const w of allWalletList) {
                  const val = await cache.get(`wallet-token-hold:${w}:${bgMint}`);
                  if (val != null) {
                    totalAnalyzed++;
                    if (val > 0) allHoldTimes[w] = val;
                  }
                }
                if (totalAnalyzed === allWalletList.length && allWalletList.length > 0) {
                  const finalResult = buildDiamondHandsResult(allHoldTimes, allWalletList.length, totalAnalyzed);
                  await cache.set(`diamond-hands:${bgMint}`, finalResult, 3 * TTL.HOUR);
                  db.upsertConviction(bgMint, finalResult.distribution, finalResult.sampleSize, finalResult.analyzed).catch(() => {});
                }
              } catch (_) {}
            } catch (err) {
              console.error(`[DiamondHands] Inline failed:`, err.message);
            } finally {
              await cache.delete(`holder-metrics-pending:${bgMint}`);
            }
          })();
        });
      }
    } else {
      console.log(`[DiamondHands] Computation already pending for ${mint.slice(0, 8)}..., waiting for shared result`);
    }

    // Return partial distribution from cached data so far
    const partial = buildDiamondHandsResult(holdTimes, wallets.length, analyzedCount);
    partial.computed = false;
    partial.totalCount = wallets.length;
    console.log(`[DiamondHands] Partial: ${partial.analyzed}/${partial.totalCount} analyzed for ${mint.slice(0, 8)}...`);
    if (!res.headersSent) res.json(partial);
  } catch (error) {
    console.error('[DiamondHands] Error:', error.message);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to fetch diamond hands data' });
  }
}));

/**
 * Build diamond hands distribution from hold time data.
 * Denominator is values.length (wallets with positive hold times only).
 * Wallets with no data are excluded entirely from the calculation.
 */
function buildDiamondHandsResult(holdTimes, sampleSize, analyzed) {
  const values = Object.values(holdTimes);
  const denominator = values.length;
  if (denominator === 0) {
    return { distribution: null, sampleSize, analyzed: 0, computed: true };
  }

  const distribution = {};
  for (const bucket of DIAMOND_HANDS_BUCKETS) {
    const count = values.filter(ms => ms >= bucket.ms).length;
    distribution[bucket.key] = Math.round((count / denominator) * 1000) / 10;
  }

  return { distribution, sampleSize, analyzed, computed: true };
}

// GET /api/tokens/:mint/similar - Find tokens with similar names/symbols
// Anti-spoofing: helps users identify confusing or copycat token names
// Returns fast DB results inline (~5-20ms), then queues worker for GeckoTerminal enrichment.
// Response format: { results: [...], enriched: boolean }
router.get('/:mint/similar', validateMint, asyncHandler(async (req, res) => {
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
