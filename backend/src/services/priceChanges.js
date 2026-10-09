/**
 * 24h, 7d and 30d price changes for the home Diamond Hands table.
 *
 * The table must not call upstream per row on page load, so the worker stores, per curated
 * token, the price it had 1, 7 and 30 days ago (curated_tokens.price_ref_*). The leaderboard
 * then compares each against the live price that refresh-curated-prices writes every 10
 * minutes, so the changes move with the price while the reference points are refreshed only
 * every few hours.
 *
 * Reference prices come from 4h OHLCV candles of the token's deepest pool, read from the
 * token's own side of it (geckoTerminal.getOHLCV picks the pool with poolPricing.pickGeckoPool).
 * One request per token per refresh covers all three windows.
 *
 * The 24h column prefers tokens.price_change_24h, a rolling figure the price refresh already
 * stores; the 1d reference is only its fallback, for tokens GeckoTerminal publishes no 24h
 * change for (a token on the quote side of every pool it trades in).
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const CANDLE_MS = 4 * HOUR;
const WINDOWS = { d1: DAY, d7: 7 * DAY, d30: 30 * DAY };
// 30 days of 4h candles plus a day of slack
const CANDLE_LIMIT = 31 * 6;
// Stored references older than this are refreshed
const REFRESH_AFTER_MS = 3 * HOUR;
// ...and older than this are not used at all (refreshes have been failing)
const MAX_REF_AGE_MS = DAY;
// A reference is the price `window` before the time it was fetched, so a change computed from it
// spans window + its age. Each window only uses references young enough to keep that stretch to
// a quarter of the window at most: the 24h fallback stops after 6h (instead of reading a 47h move
// as "24h" after a day of failed refreshes), 7d and 30d keep the one-day limit.
const MAX_REF_AGE_BY_WINDOW = {
  d1: Math.min(MAX_REF_AGE_MS, WINDOWS.d1 / 4),
  d7: Math.min(MAX_REF_AGE_MS, WINDOWS.d7 / 4),
  d30: Math.min(MAX_REF_AGE_MS, WINDOWS.d30 / 4),
};

const finite = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * The token's price at time t from candles sorted oldest first. The candle covering t gives
 * its open; when t falls in a gap after a candle (no trades), that candle's close is still
 * the price. null when every candle starts after t (the pool is younger than the window).
 */
function priceAt(candles, t, candleMs = CANDLE_MS) {
  let found = null;
  for (const c of candles) {
    if (c.timestamp <= t) found = c; else break;
  }
  if (!found) return null;
  const v = found.timestamp + candleMs <= t ? finite(found.close) : finite(found.open);
  return v != null && v > 0 ? v : null;
}

/**
 * Prices 1, 7 and 30 days before `now` from OHLCV candles (any order).
 * @returns {{d1: number|null, d7: number|null, d30: number|null}}
 */
function referencePrices(candles, now = Date.now(), candleMs = CANDLE_MS) {
  const sorted = (candles || [])
    .filter(c => c && Number.isFinite(c.timestamp))
    .sort((a, b) => a.timestamp - b.timestamp);
  const out = {};
  for (const [key, win] of Object.entries(WINDOWS)) out[key] = priceAt(sorted, now - win, candleMs);
  return out;
}

/** Percent change from ref to price, or null when either is missing. */
function changePct(price, ref) {
  const p = finite(price);
  const r = finite(ref);
  if (p == null || r == null || !(p > 0) || !(r > 0)) return null;
  return ((p - r) / r) * 100;
}

/**
 * The three changes for one leaderboard row.
 * @param {Object} row tokens + curated_tokens columns (price, price_change_24h, price_ref_*)
 */
function changesForRow(row, now = Date.now()) {
  const refsAt = row.price_refs_at ? new Date(row.price_refs_at).getTime() : NaN;
  const age = Number.isFinite(refsAt) ? now - refsAt : Infinity;
  const ref = (win, column) => (age <= MAX_REF_AGE_BY_WINDOW[win] ? row[column] : null);
  const stored24h = finite(row.price_change_24h);
  return {
    priceChange24h: stored24h != null ? stored24h : changePct(row.price, ref('d1', 'price_ref_1d')),
    priceChange7d: changePct(row.price, ref('d7', 'price_ref_7d')),
    priceChange30d: changePct(row.price, ref('d30', 'price_ref_30d')),
  };
}

/**
 * Fetch and compute one token's reference prices. One GeckoTerminal OHLCV request (plus a
 * pool lookup the first time the worker sees the token).
 * @returns {Promise<{d1, d7, d30}|null>} null when the token has no pool or no candles
 * @throws when GeckoTerminal fails, so the caller can keep the references it has
 */
async function fetchReferencePrices(mint, { now = Date.now(), gecko = require('./geckoTerminal') } = {}) {
  const ohlcv = await gecko.getOHLCV(mint, { interval: '4h', limit: CANDLE_LIMIT });
  // getOHLCV reports upstream failures as { error } rather than throwing
  if (!ohlcv || ohlcv.error) throw new Error(ohlcv?.error || 'no OHLCV response');
  if (!Array.isArray(ohlcv.data) || ohlcv.data.length === 0) return null;
  return referencePrices(ohlcv.data, now);
}

module.exports = {
  REFRESH_AFTER_MS,
  MAX_REF_AGE_MS,
  MAX_REF_AGE_BY_WINDOW,
  CANDLE_LIMIT,
  priceAt,
  referencePrices,
  changePct,
  changesForRow,
  fetchReferencePrices,
};
