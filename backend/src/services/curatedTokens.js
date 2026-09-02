// The one implementation of "add a token to the curated list".
//
// This used to live twice - once in routes/curated.js and once in routes/admin.js (the surface
// the admin panel actually posts to) - and the copies drifted exactly as hand-copied code does:
// only one seeded the tokens table (so admin-added tokens sat blank on the home page for up to
// ten minutes), only one initialised the ATH record and queued the conviction job, and they
// disagreed on which socials to capture. Both routes now call this, which does the union.

const axios = require('axios');
const db = require('./database');
const geckoService = require('./geckoTerminal');
const { cache } = require('./cache');

/**
 * Fetch banner image and social links from DexScreener for a given mint.
 * Returns null if the API call fails or no data is found.
 */
async function fetchDexScreenerData(mint) {
  try {
    const response = await axios.get(
      `https://api.dexscreener.com/tokens/v1/solana/${encodeURIComponent(mint)}`,
      { timeout: 10000 }
    );

    const pairs = response.data;
    if (!Array.isArray(pairs) || pairs.length === 0) {
      return null;
    }

    const info = pairs[0].info || {};
    const socials = Array.isArray(info.socials) ? info.socials : [];
    const websites = Array.isArray(info.websites) ? info.websites : [];

    const findSocial = (type) => {
      const entry = socials.find(s => s.type === type);
      return entry ? entry.url : null;
    };

    return {
      name: pairs[0].baseToken?.name || null,
      symbol: pairs[0].baseToken?.symbol || null,
      logoUri: info.imageUrl || null,
      bannerUrl: info.header || null,
      socials: {
        twitter: findSocial('twitter'),
        telegram: findSocial('telegram'),
        discord: findSocial('discord'),
        tiktok: findSocial('tiktok'),
        website: websites.length > 0 ? websites[0].url : null
      }
    };
  } catch (error) {
    console.error(`[Curated] DexScreener fetch failed for ${mint}:`, error.message);
    return null;
  }
}

/**
 * Add a mint to the curated list and fully wire it into the site: mcap-at-listing, initial ATH,
 * DexScreener enrichment, an immediate tokens-table seed (so the home page shows a real
 * logo/price right away rather than blanks until the next refresh-curated-prices run), and the
 * conviction-analysis job that puts it on the leaderboard.
 *
 * Every step beyond the insert itself is non-critical: a token added while an upstream is down
 * is still added, and the periodic workers backfill whatever was missed.
 */
async function addCuratedTokenFully(mintAddress) {
  // Fetch market cap before adding so we can record it at time of listing
  let mcapAtAdded = null;
  let marketData = null;
  try {
    marketData = await geckoService.getMarketData(mintAddress);
    mcapAtAdded = marketData?.marketCap || null;
  } catch { /* non-critical — token can be added without mcap */ }

  await db.addCuratedToken(mintAddress, mcapAtAdded);

  // Set initial ATH to the listing mcap (separate call — safe if column is missing)
  if (mcapAtAdded) {
    await db.updateCuratedTokenATH(mintAddress, mcapAtAdded).catch(() => {});
  }

  // Invalidate the 'not allowed' cache entry so the token is immediately accessible
  await cache.delete(`curated-allowed:${mintAddress}`).catch(() => {});

  // Fetch DexScreener data and enrich
  const dexData = await fetchDexScreenerData(mintAddress);
  if (dexData) {
    await db.updateCuratedTokenDexScreener(mintAddress, dexData).catch(() => {});
  }

  // Seed the tokens table immediately so the token has a real logo/price/market cap on the
  // home page right away — otherwise it would sit blank until the refresh-curated-prices
  // worker's next run (up to 10 minutes later).
  if (marketData || dexData) {
    await db.updateTokenMarketData({
      mintAddress,
      price: marketData?.price ?? null,
      marketCap: marketData?.marketCap || marketData?.fdv || null,
      volume24h: marketData?.volume24h ?? null,
      priceChange24h: marketData?.priceChange24h ?? null,
      logoUri: dexData?.logoUri ?? null,
      name: dexData?.name ?? null,
      symbol: dexData?.symbol ?? null,
    }).catch(() => { /* non-critical — worker will backfill on next run */ });
  }

  // Trigger conviction analysis via the job queue so the token appears on the leaderboard
  try {
    const jobQueue = require('./jobQueue');
    await jobQueue.addAnalyticsJob('compute-holder-analytics', { mint: mintAddress }, { priority: 10 });
  } catch { /* non-critical */ }

  const token = await db.getCuratedToken(mintAddress).catch(() => null);
  return { token, dexScreenerEnriched: !!dexData };
}

module.exports = { addCuratedTokenFully, fetchDexScreenerData };
