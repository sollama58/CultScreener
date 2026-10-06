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
// Uses a FIFO buy queue per token so partial sells are handled correctly:
//   Buy 100 → Buy 50 → Sell 50  produces one closed pair (oldest buy) + one open pair
//   instead of the previous behaviour where the second sell would drop its buy.
//
// "Still holding" entries include holdTime = now - buyTime.  This is intentional:
// a wallet that bought 2 years ago and never sold demonstrates strong conviction,
// and that long hold time should pull the average up — that IS the diamond hands signal.
function computeHoldPairs(walletAddress, transactions, now = Date.now()) {
  const buyQueue = {}; // mint -> [buyTimestamp, ...] FIFO — oldest buy first
  const pairs    = {}; // mint -> [{type, buyTime, sellTime, holdTime}]

  const sorted = [...transactions].sort((a, b) => a.timestamp - b.timestamp);

  for (const tx of sorted) {
    const ts = tx.timestamp * 1000; // seconds → ms
    for (const t of (tx.tokenTransfers || [])) {
      const { mint: tm, fromUserAccount, toUserAccount, tokenAmount } = t;
      if (!tm || HB_EXCLUDED_MINTS.has(tm)) continue;
      if (!tokenAmount || Number(tokenAmount) <= 0) continue;

      if (toUserAccount === walletAddress) {
        if (!buyQueue[tm]) buyQueue[tm] = [];
        buyQueue[tm].push(ts);
      } else if (fromUserAccount === walletAddress) {
        if (!pairs[tm]) pairs[tm] = [];
        const buyTime = (buyQueue[tm] && buyQueue[tm].length > 0) ? buyQueue[tm].shift() : null;
        pairs[tm].push({
          type: 'sold',
          buyTime,
          sellTime: ts,
          holdTime: buyTime != null ? ts - buyTime : null
        });
      }
    }
  }

  for (const [tm, queue] of Object.entries(buyQueue)) {
    if (!pairs[tm]) pairs[tm] = [];
    for (const buyTime of queue) {
      pairs[tm].push({ type: 'holding', buyTime, sellTime: null, holdTime: now - buyTime });
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

module.exports = {
  HB_EXCLUDED_MINTS,
  computeHoldPairs,
  buildDiamondHandsResult
};
