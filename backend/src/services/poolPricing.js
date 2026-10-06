// Reading a token's market data out of DEX pool records without assuming what it is paired with.
//
// A GeckoTerminal pool is "BASE / QUOTE" and its headline fields belong to the base token:
// base_token_price_usd, fdv_usd, market_cap_usd and price_change_percentage all describe
// the base. A token paired against SOL or USDC is almost always the base, so code that read
// those fields straight off the first pool usually worked. A token paired against something
// else (ZEC, JUP, another memecoin) can sit on the quote side, and then every one of those
// fields described the other token. DexScreener pairs have the same shape (baseToken,
// priceUsd, info).
//
// These helpers find which side the token is on, pick the pool by liquidity rather than by
// list order or quote type, and only take the side-specific fields that belong to the token.

const NETWORK = 'solana';

// Assets that are only ever the "money" side of a memecoin pool. A list of pools that shows
// one of these as the base is really listing the other token.
const MAJOR_QUOTE_MINTS = new Set([
  'So11111111111111111111111111111111111111112',  // wSOL
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
]);

const toNum = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

function geckoTokenAddress(id) {
  if (!id || typeof id !== 'string') return null;
  return id.startsWith(`${NETWORK}_`) ? id.slice(NETWORK.length + 1) : id;
}

function geckoPoolTokens(pool) {
  const rel = pool?.relationships || {};
  return {
    base: geckoTokenAddress(rel.base_token?.data?.id),
    quote: geckoTokenAddress(rel.quote_token?.data?.id),
  };
}

/**
 * 'base' or 'quote' for where mintAddress sits in a GeckoTerminal pool, or null when the
 * pool's relationships name neither side as the mint. Pools without relationships at all
 * are treated as base, which is how every caller read them before.
 */
function geckoPoolSide(pool, mintAddress) {
  const { base, quote } = geckoPoolTokens(pool);
  if (!base && !quote) return 'base';
  if (base === mintAddress) return 'base';
  if (quote === mintAddress) return 'quote';
  return null;
}

/** Strip a fee tier suffix like "0.25%" from one half of a pool name. */
function cleanPoolSymbol(s) {
  if (!s) return null;
  const out = String(s).replace(/\s+\d+(\.\d+)?%$/, '').trim();
  return out || null;
}

/** The symbol for one side of a "BASE / QUOTE" pool name. */
function poolNameSymbol(name, side = 'base') {
  const parts = String(name || '').split(' / ');
  return cleanPoolSymbol(side === 'quote' ? parts[1] : parts[0]);
}

/**
 * The token's own figures from one pool. Pool-wide numbers (liquidity, volume) are the same
 * for both sides. FDV, market cap and 24h change are only published for the base, so they
 * come back null for a quote-side token rather than as the other token's numbers.
 */
function geckoPoolView(pool, side) {
  const a = pool?.attributes || {};
  const isQuote = side === 'quote';
  return {
    side: isQuote ? 'quote' : 'base',
    poolAddress: a.address || null,
    price: toNum(isQuote ? a.quote_token_price_usd : a.base_token_price_usd),
    priceChange24h: isQuote ? null : toNum(a.price_change_percentage?.h24),
    marketCap: isQuote ? null : toNum(a.market_cap_usd),
    fdv: isQuote ? null : toNum(a.fdv_usd),
    liquidity: toNum(a.reserve_in_usd),
    volume24h: toNum(a.volume_usd?.h24),
    symbol: poolNameSymbol(a.name, isQuote ? 'quote' : 'base'),
    pairCreatedAt: a.pool_created_at || null,
  };
}

/**
 * Choose the pool to read a token's price from: the deepest pool that actually contains the
 * token, whatever it is paired with. Ties keep the provider's order.
 * Returns { pool, side } or null.
 */
function pickGeckoPool(pools, mintAddress) {
  let best = null;
  let bestLiq = -1;
  for (const pool of pools || []) {
    const side = geckoPoolSide(pool, mintAddress);
    if (!side) continue;
    const liq = toNum(pool?.attributes?.reserve_in_usd) || 0;
    if (liq > bestLiq) {
      best = { pool, side };
      bestLiq = liq;
    }
  }
  return best;
}

/**
 * The token's 24h change from the deepest pool where it is the base (the only side the
 * provider publishes a change for), or null when it is never the base.
 */
function geckoBaseSideChange(pools, mintAddress) {
  const picked = pickGeckoPool((pools || []).filter(p => geckoPoolSide(p, mintAddress) === 'base'), mintAddress);
  return picked ? geckoPoolView(picked.pool, 'base').priceChange24h : null;
}

/**
 * For pool lists (trending, new, search) that turn each pool into one token row: which side
 * is the token the row should be about. A SOL/USDC/USDT base means the row is the quote.
 * When a search query is given and only one side's symbol matches it, that side wins.
 */
function geckoListedSide(pool, query = null) {
  const { base, quote } = geckoPoolTokens(pool);
  if (query && quote) {
    const q = String(query).trim().toLowerCase();
    const name = pool?.attributes?.name || '';
    const baseSym = (poolNameSymbol(name, 'base') || '').toLowerCase();
    const quoteSym = (poolNameSymbol(name, 'quote') || '').toLowerCase();
    const baseHit = q && baseSym.includes(q);
    const quoteHit = q && quoteSym.includes(q);
    if (quoteHit && !baseHit && !MAJOR_QUOTE_MINTS.has(quote)) return 'quote';
    if (baseHit && !quoteHit && !MAJOR_QUOTE_MINTS.has(base)) return 'base';
  }
  if (base && MAJOR_QUOTE_MINTS.has(base) && quote && !MAJOR_QUOTE_MINTS.has(quote)) return 'quote';
  return 'base';
}

/**
 * One row for a pool list: { address, ...geckoPoolView } for the listed side. Without a
 * search query, a pool whose listed token is itself SOL/USDC/USDT (a SOL / USDC pool) gives
 * null, as the trending and new lists always skipped those. A search keeps them, so a search
 * for "SOL" still finds wSOL.
 */
function geckoListedToken(pool, query = null) {
  const side = geckoListedSide(pool, query);
  const tokens = geckoPoolTokens(pool);
  const address = side === 'quote' ? tokens.quote : tokens.base;
  if (!address || (!query && MAJOR_QUOTE_MINTS.has(address))) return null;
  return { address, ...geckoPoolView(pool, side) };
}

/**
 * Pick the DexScreener pair to describe a token with. DexScreener's /tokens/v1 returns every
 * pair the token is in, on either side, and a pair's info (logo, banner, socials) and
 * priceUsd belong to its base token. Prefer the deepest pair where the token is the base;
 * otherwise the deepest pair at all, flagged as quote so callers skip base-only fields.
 * Returns { pair, side, token } or null; token is the pair's record for the mint itself.
 */
function pickDexScreenerPair(pairs, mintAddress) {
  if (!Array.isArray(pairs) || pairs.length === 0) return null;
  const liq = (p) => toNum(p?.liquidity?.usd) || 0;
  let bestBase = null;
  let bestAny = null;
  for (const pair of pairs) {
    const base = pair?.baseToken?.address;
    const quote = pair?.quoteToken?.address;
    const side = base === mintAddress ? 'base' : quote === mintAddress ? 'quote' : null;
    if (!side) continue;
    if (side === 'base' && (!bestBase || liq(pair) > liq(bestBase))) bestBase = pair;
    if (!bestAny || liq(pair) > liq(bestAny)) bestAny = pair;
  }
  if (bestBase) return { pair: bestBase, side: 'base', token: bestBase.baseToken };
  if (bestAny) return { pair: bestAny, side: 'quote', token: bestAny.quoteToken };
  // Nothing names the mint (shouldn't happen for /tokens/v1); keep the old first-pair read.
  return { pair: pairs[0], side: 'base', token: pairs[0].baseToken || null };
}

/**
 * The token's USD price from a DexScreener pair. priceUsd is the base's price and
 * priceNative is base priced in quote, so the quote's USD price is priceUsd / priceNative.
 */
function dexScreenerPairPriceUsd(pair, side) {
  const usd = toNum(pair?.priceUsd);
  if (usd == null) return null;
  if (side !== 'quote') return usd;
  const native = toNum(pair?.priceNative);
  return native && native > 0 ? usd / native : null;
}

module.exports = {
  MAJOR_QUOTE_MINTS,
  geckoTokenAddress,
  geckoPoolTokens,
  geckoPoolSide,
  geckoPoolView,
  pickGeckoPool,
  geckoBaseSideChange,
  geckoListedSide,
  geckoListedToken,
  poolNameSymbol,
  pickDexScreenerPair,
  dexScreenerPairPriceUsd,
};
