/**
 * King of the Pill: the daily Diamond Hands score and the crowning rule.
 * Pure functions, no I/O, so the simulation and the unit tests share them.
 */

const { DIAMOND_HANDS_BUCKETS } = require('../constants');

const DAY = 86_400_000;
const BUCKETS = DIAMOND_HANDS_BUCKETS;

const PARAMS = {
  // Longer holds count more, but on a log scale: 6h→1, 24h→3, 1w→5.8, 1m→7.9, 1yr→11.5
  bucketWeight: b => Math.log2(b.ms / 3_600_000 / 3),
  // A bucket is "achievable" for a token when holders have had this much time to reach
  // it since the token could first be bought, plus 3 days of buying window.
  achievableMarginMs: 3 * DAY,
  headcountWeight: 0.7,        // share of holders past each threshold (hard to buy)
  supplyWeight: 0.3,           // share of supply in those wallets (easy for one whale)
  confidenceFullDays: 90,      // tokens younger than this are discounted (sqrt ramp: 20d→0.47, 45d→0.71, 90d→1)
  minAgeDays: 7,               // younger tokens are not scored
  minHolders: 100,
  maxSnapshotAgeMs: 48 * 3_600_000,
  momentumWeight: 0.10,        // ±10% for the 7-day change in the core index
  momentumFullSwing: 0.05,     // a 5-point move of the core index saturates momentum
  retentionGainWeight: 0.05,   // up to +5% for growing the holder base over 30 days
  retentionLossWeight: 0.25,   // up to -25% for losing holders over 30 days (a dying token is not a king)
  retentionFullSwing: 0.20,    // ±20% holders in a month saturates retention
  // Trading activity: half the 24h volume in dollars (log scale between the floor and
  // the full mark), half the turnover (24h volume as a share of market cap). A token
  // trading at the full mark on both gets +volumeWeight, a dead one -volumeWeight,
  // and one with no volume or market cap data sits in the middle (no effect).
  volumeWeight: 0.25,          // ±25% for trading activity
  volumeFloorUsd: 10_000,      // $10k/day of volume or less counts as none
  volumeFullUsd: 1_000_000,    // $1M/day saturates the dollar half
  turnoverFull: 0.25,          // 25% of market cap traded per day saturates the turnover half
  // Price momentum: the 24h, 7d and 30d price changes, each saturating at its own swing
  // and weighted so the longer windows count more (a 24h spike alone moves little).
  // Gains are worth more than losses cost, so the crown leans towards tokens on the way up.
  priceGainWeight: 0.15,       // up to +15% for rising prices
  priceLossWeight: 0.10,       // up to -10% for falling prices
  priceFullSwing: { d1: 25, d7: 50, d30: 100 },   // percent change that saturates each window
  priceWindowWeight: { d1: 0.2, d7: 0.4, d30: 0.4 },
  // Crowning
  minReignDays: 3,             // nobody is dethroned before this
  maxReignDays: 7,             // and nobody keeps it past this
  fatiguePerDay: 0.06,         // from day minReignDays on, the king's score counts 6% less per day
  challengeMargin: 2,          // a challenger must beat the fatigued king by this many points
  cooldownDays: 14,            // an ex-king can't be crowned again for this long
  repeatPenalty: 0.04,         // each reign in the last repeatWindowDays costs a challenger 4%
  repeatWindowDays: 60,
};

/**
 * Weighted hold index of a bucket distribution (shares in percent, 0..100), normalised
 * by the buckets this token's age makes achievable. Returns 0..1, or null without data.
 */
function holdIndex(distribution, ageMs, p = PARAMS) {
  if (!distribution) return null;
  let num = 0, den = 0, used = 0;
  for (const b of BUCKETS) {
    if (b.ms + p.achievableMarginMs > ageMs) continue;
    const share = Number(distribution[b.key]);
    if (!Number.isFinite(share)) continue;
    const w = p.bucketWeight(b);
    num += w * Math.min(100, Math.max(0, share)) / 100;
    den += w;
    used++;
  }
  if (!used || den <= 0) return null;
  return num / den;
}

function clamp(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }

/**
 * Trading activity, -1..1: the mean of the dollar volume index (log scale from
 * volumeFloorUsd to volumeFullUsd) and the turnover index (24h volume / market cap,
 * saturating at turnoverFull), each rescaled from 0..1 to -1..1. Unknown volume gives
 * 0; unknown market cap leaves only the dollar half in play.
 */
function activityIndex(volume24h, marketCap, p = PARAMS) {
  if (volume24h == null) return 0;
  const vol = Number(volume24h);
  if (!Number.isFinite(vol) || vol < 0) return 0;
  const span = Math.log10(p.volumeFullUsd) - Math.log10(p.volumeFloorUsd);
  const dollars = clamp((Math.log10(Math.max(vol, 1)) - Math.log10(p.volumeFloorUsd)) / span, 0, 1);
  const mcap = Number(marketCap);
  const turnover = Number.isFinite(mcap) && mcap > 0 ? clamp(vol / mcap / p.turnoverFull, 0, 1) : null;
  const index = turnover == null ? dollars : (dollars + turnover) / 2;
  return 2 * index - 1;
}

/**
 * Price momentum, -1..1: the weighted mean of the 24h, 7d and 30d price changes, each
 * clamped to ±1 at its full swing. Windows without a figure drop out of the mean
 * (renormalised); no figures at all gives 0.
 */
function priceMomentumIndex(changes, p = PARAMS) {
  let num = 0, den = 0;
  for (const key of ['d1', 'd7', 'd30']) {
    const v = changes ? Number(changes[key]) : NaN;
    if (changes == null || changes[key] == null || !Number.isFinite(v)) continue;
    const w = p.priceWindowWeight[key];
    num += w * clamp(v / p.priceFullSwing[key], -1, 1);
    den += w;
  }
  return den > 0 ? num / den : 0;
}

/**
 * Daily Diamond Hands score for one token.
 *
 * @param {object} t
 *   distribution        headcount bucket shares (percent)
 *   supplyDistribution  supply bucket shares (percent) or null
 *   ageMs               time since the token could first be bought
 *   holders             holder count at the snapshot
 *   snapshotAgeMs       how old the snapshot behind the distribution is
 *   coreWeekAgo         core index stored 7 days ago (null if unknown)
 *   holdersMonthAgo     holder count 30 days ago (or the oldest known, at least 7 days back; null if unknown)
 *   volume24h           24h trading volume in USD (null if unknown)
 *   marketCap           market cap in USD (null if unknown)
 *   priceChanges        { d1, d7, d30 } percent price changes (each null if unknown)
 * @returns {{eligible, reason?, score, core, headcount, supply, confidence, momentum, retention, activity, priceMomentum}}
 */
function scoreToken(t, p = PARAMS) {
  const ageDays = (t.ageMs || 0) / DAY;
  const out = { eligible: false, score: null, core: null };
  if (!(ageDays >= p.minAgeDays)) return { ...out, reason: 'too_young' };
  if (!(t.holders >= p.minHolders)) return { ...out, reason: 'too_few_holders' };
  if (!(t.snapshotAgeMs <= p.maxSnapshotAgeMs)) return { ...out, reason: 'stale_snapshot' };

  const headcount = holdIndex(t.distribution, t.ageMs, p);
  if (headcount == null) return { ...out, reason: 'no_distribution' };
  const supply = holdIndex(t.supplyDistribution, t.ageMs, p);
  const core = supply == null ? headcount : p.headcountWeight * headcount + p.supplyWeight * supply;

  const confidence = Math.sqrt(clamp(ageDays / p.confidenceFullDays, 0, 1));
  const momentum = t.coreWeekAgo != null ? clamp((core - t.coreWeekAgo) / p.momentumFullSwing, -1, 1) : 0;
  const retention = (t.holdersMonthAgo > 0 && t.holders > 0)
    ? clamp((t.holders / t.holdersMonthAgo - 1) / p.retentionFullSwing, -1, 1) : 0;
  const retentionWeight = retention < 0 ? p.retentionLossWeight : p.retentionGainWeight;
  const activity = activityIndex(t.volume24h, t.marketCap, p);
  const priceMomentum = priceMomentumIndex(t.priceChanges, p);
  const priceWeight = priceMomentum < 0 ? p.priceLossWeight : p.priceGainWeight;

  const score = 100 * confidence * core
    * (1 + p.momentumWeight * momentum + retentionWeight * retention + p.volumeWeight * activity
         + priceWeight * priceMomentum);
  return {
    eligible: true, score: Math.round(score * 100) / 100,
    core: Math.round(core * 10000) / 10000, headcount, supply, confidence, momentum, retention, activity, priceMomentum,
  };
}

/**
 * Who wears the crown today.
 *
 * @param {Array<{mint, score}>} scored  today's eligible tokens
 * @param {{mint, crownedOn}|null} king  current reign (crownedOn = day index or Date)
 * @param {Object<string, number>} lastReignEnd  mint → day the last reign ended
 * @param {Object<string, number[]>} [reignEnds]  mint → days each of its reigns ended (for the repeat penalty)
 * @param {number} today  day index (or Date) in the same unit as crownedOn
 * @returns {{mint, changed, reason, score, reignDays}}
 */
function pickKing(scored, king, lastReignEnd, today, p = PARAMS, reignEnds = {}) {
  const dayOf = v => (v instanceof Date ? Math.floor(v.getTime() / DAY) : v);
  const tDay = dayOf(today);
  const recentReigns = m => (reignEnds[m] || []).filter(e => tDay - dayOf(e) < p.repeatWindowDays).length;
  // Challengers are ranked on their score less a small penalty per recent reign, so the
  // crown keeps moving around rather than between the same two or three tokens.
  const byScore = [...scored].filter(s => s.score != null)
    .map(s => ({ ...s, challenge: s.score * (1 - p.repeatPenalty * recentReigns(s.mint)) }))
    .sort((a, b) => b.challenge - a.challenge || (a.mint < b.mint ? -1 : 1));
  const inCooldown = s => {
    const end = lastReignEnd[s.mint];
    return end != null && tDay - dayOf(end) < p.cooldownDays;
  };
  const kingRow = king ? byScore.find(s => s.mint === king.mint) : null;
  const reignDays = king ? tDay - dayOf(king.crownedOn) : 0;
  const challenger = byScore.find(s => !king || (s.mint !== king.mint && !inCooldown(s)));

  if (!king || !kingRow) {
    // No king, or the king dropped out of eligibility
    if (!challenger) return king ? { mint: king.mint, changed: false, reason: 'no_challenger', score: null, reignDays }
                                : { mint: null, changed: false, reason: 'nobody_eligible', score: null, reignDays: 0 };
    return { mint: challenger.mint, changed: !king || challenger.mint !== king.mint, reason: king ? 'king_ineligible' : 'first_king', score: challenger.score, reignDays: 0 };
  }
  if (reignDays < p.minReignDays || !challenger) {
    return { mint: king.mint, changed: false, reason: reignDays < p.minReignDays ? 'min_reign' : 'no_challenger', score: kingRow.score, reignDays };
  }
  if (reignDays >= p.maxReignDays) {
    return { mint: challenger.mint, changed: true, reason: 'max_reign', score: challenger.score, reignDays: 0 };
  }
  const fatigue = 1 - p.fatiguePerDay * (reignDays - p.minReignDays + 1);
  if (kingRow.score * fatigue + p.challengeMargin >= challenger.challenge) {
    return { mint: king.mint, changed: false, reason: 'defended', score: kingRow.score, reignDays };
  }
  return { mint: challenger.mint, changed: true, reason: 'overtaken', score: challenger.score, reignDays: 0 };
}

module.exports = { BUCKETS, PARAMS, DAY, holdIndex, activityIndex, priceMomentumIndex, scoreToken, pickKing };
