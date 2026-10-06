/**
 * Holder metric math: pure functions with no I/O, so they can be unit tested
 * without Redis, Postgres or RPC. Used by holderBehaviorAnalysis (worker) and
 * routes/tokens.js (diamond hands distribution).
 */

const { DIAMOND_HANDS_BUCKETS } = require('../constants');

// Tokens to exclude from hold-time analysis: wrapped SOL, stablecoins, and liquid
// staking tokens. These are "SOL-adjacent" or "USD-adjacent" assets — holding or
// swapping them doesn't signal conviction in a specific project. We only want to
// measure hold times on actual tokens (memecoins, DeFi tokens, etc.).
//
// Filtering is applied at the individual tokenTransfer level, NOT the transaction
// level. So a BONK→USDC swap still records BONK as a sell; only the USDC leg is
// dropped. A pure USDC→SOL swap generates no hold pairs at all.
const HB_EXCLUDED_MINTS = new Set([
  // Wrapped / native SOL
  'So11111111111111111111111111111111111111112',    // Wrapped SOL (wSOL)

  // Stablecoins
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',  // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',  // USDT
  'USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA',   // USDS
  '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo',  // PYUSD
  'USDH1SM45983WjjMKkut3vDfb4CpBqBtvNMkZGGAJJq',   // USDH (Hubble)
  '7kbnvuGBxxj8AG9qp8Scn56muWGaRaFqxg1FsRp3PaFT',  // UXD
  'EjmyN6qEC1Tf1JxiG1ae7UTJhUxSwk1TCWNWqxWV4J6o',  // DAI (Wormhole)

  // Liquid staking tokens (SOL-pegged — swapping these ≈ swapping SOL)
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',  // mSOL (Marinade)
  'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',  // jitoSOL
  'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1',   // bSOL (BlazeStake)
  '7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj',  // stSOL (Lido)
  '5oVNBeEEQvYi1cX3ir8Dx5n1P7pdxydbGF2X4TxVusJm',  // INF (Sanctum)
]);

// ── computeHoldPairs ─────────────────────────────────────────────────────────

// Parse swap transactions into per-token hold pairs for a wallet.
// Buy = wallet receives token, Sell = wallet sends token.
//
// Matching is FIFO by amount: each buy is a lot, and a sell consumes the oldest
// lots first, producing one closed pair per lot it touches. So
//   Buy 100 → Sell 40 → Sell 60  gives two closed pairs, both dated from the buy,
//   Buy 100 → Buy 50 → Sell 50   closes half of the first lot; the rest of it and
//                                the second lot stay open.
// A sell larger than every known lot (the buy happened before the history we can
// see) closes what it can and records the remainder with a null buyTime/holdTime.
//
// "Still holding" entries include holdTime = now - buyTime.  This is intentional:
// a wallet that bought 2 years ago and never sold demonstrates strong conviction,
// and that long hold time should pull the average up — that IS the diamond hands signal.
//
// Amounts are Helius UI amounts (floats). A lot whose remainder falls below
// LOT_EPSILON of its original size counts as fully sold, so float noise doesn't
// leave phantom open positions behind.
const LOT_EPSILON = 1e-9;

function computeHoldPairs(walletAddress, transactions, now = Date.now()) {
  const lots  = {}; // mint -> [{buyTime, remaining, original}] FIFO — oldest first
  const pairs = {}; // mint -> [{type, buyTime, sellTime, holdTime}]

  const sorted = [...transactions].sort((a, b) => a.timestamp - b.timestamp);

  for (const tx of sorted) {
    const ts = tx.timestamp * 1000; // seconds → ms
    for (const t of (tx.tokenTransfers || [])) {
      const { mint: tm, fromUserAccount, toUserAccount, tokenAmount } = t;
      if (!tm || HB_EXCLUDED_MINTS.has(tm)) continue;
      const amount = Number(tokenAmount);
      if (!Number.isFinite(amount) || amount <= 0) continue;

      if (toUserAccount === walletAddress) {
        if (!lots[tm]) lots[tm] = [];
        lots[tm].push({ buyTime: ts, remaining: amount, original: amount });
      } else if (fromUserAccount === walletAddress) {
        if (!pairs[tm]) pairs[tm] = [];
        const queue = lots[tm] || [];
        let toSell = amount;
        while (toSell > amount * LOT_EPSILON && queue.length > 0) {
          const lot = queue[0];
          const used = Math.min(lot.remaining, toSell);
          lot.remaining -= used;
          toSell -= used;
          pairs[tm].push({ type: 'sold', buyTime: lot.buyTime, sellTime: ts, holdTime: ts - lot.buyTime });
          if (lot.remaining <= lot.original * LOT_EPSILON) queue.shift();
        }
        // The loop only stops with something left when the lots ran out: the buy
        // predates the history we can see. Ignore float crumbs from rounding.
        if (toSell > amount * 1e-6) {
          pairs[tm].push({ type: 'sold', buyTime: null, sellTime: ts, holdTime: null });
        }
      }
    }
  }

  for (const [tm, queue] of Object.entries(lots)) {
    for (const lot of queue) {
      if (!pairs[tm]) pairs[tm] = [];
      pairs[tm].push({ type: 'holding', buyTime: lot.buyTime, sellTime: null, holdTime: now - lot.buyTime });
    }
  }

  return pairs;
}

// ── buildDiamondHandsResult ──────────────────────────────────────────────────

/**
 * Build diamond hands distribution from hold time data.
 * Denominator is values.length (wallets with positive hold times only).
 * Wallets with no data are excluded entirely from the calculation.
 */
function buildDiamondHandsResult(holdTimes, sampleSize, analyzed) {
  const values = Object.values(holdTimes);
  const denominator = values.length;
  if (denominator === 0) {
    return { distribution: null, sampleSize, analyzed, computed: true };
  }

  const distribution = {};
  for (const bucket of DIAMOND_HANDS_BUCKETS) {
    const count = values.filter(ms => ms >= bucket.ms).length;
    distribution[bucket.key] = Math.round((count / denominator) * 1000) / 10;
  }

  return { distribution, sampleSize, analyzed, computed: true };
}

// ── buildStratifiedDiamondHands ──────────────────────────────────────────────

const round1 = x => Math.round(x * 1000) / 10; // share 0..1 → percent, one decimal

/**
 * Diamond hands distribution for a stratified sample (see holderSnapshot.selectSample).
 *
 * Two views per bucket:
 *   distribution        – share of holders (by headcount) past the threshold;
 *   supplyDistribution  – share of the held supply sitting in those wallets.
 *
 * Each stratum's proportion is measured on its resolved wallets and weighted by
 * the stratum's size (headcount view) or its total balance (supply view), so a
 * sample that over-represents whales still describes the whole holder base.
 * Strata with nothing resolved yet drop out and the rest are re-weighted, which
 * is what partial results during a backfill show.
 *
 * @param {Array<{wallet, stratum, amount}>} sample amount is a raw-unit string
 * @param {Object<string, number>} holdTimes wallet → hold time in ms; wallets that
 *   are missing or ≤ 0 are unresolved
 * @param {Object<string, {population, amount}>} strata from the sample meta
 * @returns {{distribution, supplyDistribution, resolved}}
 */
function buildStratifiedDiamondHands(sample, holdTimes, strata) {
  const groups = {};
  for (const s of sample || []) {
    const ms = holdTimes[s.wallet];
    if (!(ms > 0)) continue;
    if (!groups[s.stratum]) groups[s.stratum] = [];
    groups[s.stratum].push({ ms, amount: Number(s.amount) || 0 });
  }

  const resolved = Object.values(groups).reduce((n, g) => n + g.length, 0);
  if (resolved === 0) return { distribution: null, supplyDistribution: null, resolved: 0 };

  const active = Object.keys(groups).filter(k => strata && strata[k] && strata[k].population > 0);
  const popTotal = active.reduce((n, k) => n + strata[k].population, 0);
  const amtTotal = active.reduce((n, k) => n + (Number(strata[k].amount) || 0), 0);

  const distribution = {};
  const supplyDistribution = {};
  for (const bucket of DIAMOND_HANDS_BUCKETS) {
    let byHolders = 0;
    let bySupply = 0;
    for (const k of active) {
      const g = groups[k];
      const past = g.filter(w => w.ms >= bucket.ms);
      byHolders += (strata[k].population / popTotal) * (past.length / g.length);
      const gAmt = g.reduce((n, w) => n + w.amount, 0);
      if (amtTotal > 0 && gAmt > 0) {
        const pastAmt = past.reduce((n, w) => n + w.amount, 0);
        bySupply += ((Number(strata[k].amount) || 0) / amtTotal) * (pastAmt / gAmt);
      }
    }
    distribution[bucket.key] = round1(byHolders);
    supplyDistribution[bucket.key] = amtTotal > 0 ? round1(bySupply) : null;
  }

  return { distribution, supplyDistribution, resolved };
}

module.exports = {
  HB_EXCLUDED_MINTS,
  computeHoldPairs,
  buildDiamondHandsResult,
  buildStratifiedDiamondHands
};
