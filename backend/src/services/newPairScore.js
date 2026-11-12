/**
 * New Pairs score: 0 to 100 for a newly graduated token, from stored data only.
 * Pure functions, no I/O. The worker computes it (newPairMarket.scoreActive); the
 * simulation (scripts/newpairs/simulate.js) runs the same code on mock tokens.
 *
 *   score      = 100 × quality × confidence × risk
 *   quality    = Σ weight × term ÷ Σ weight     over the terms that have data
 *   confidence = 0.5 + 0.5 × sqrt(min(hours since bonding, 72) / 72)
 *   risk       = wash × sybil × whale × bundle × rug
 *
 * Ten terms, each 0 to 1. Seven are holder signals (80% of the weight), three are
 * market signals (20%). A term with no data is left out and the rest re-weighted, so
 * a token without a top-50 holder sample is scored on what is known and reported as
 * `pending`. Nothing uses an absolute graduation market cap or pool size, so no
 * launchpad starts ahead.
 *
 * Why it is hard to game:
 *   - Wash volume buys at most the 8% activity term, which falls again past 300%
 *     turnover; it creates no net buyers or holders and trips the wash factor.
 *   - Farmed holders raise growth, steadiness and base, but they hold dust and did
 *     not arrive through buys, so the sybil factor fires and breadth stays low.
 *   - A whale parking a bag raises retention only, lowers spread, trips the whale factor.
 *   - A bundled launch shows as concentration and equal bags; weakest defence in v1.
 *
 * The weights are a starting set. They are final only after the owner has seen the
 * simulation and the replay on real data.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const PARAMS = {
  weights: { growth: 0.20, steady: 0.10, base: 0.05, breadth: 0.10, retention: 0.15, spread: 0.15, dev: 0.05, activity: 0.08, trend: 0.07, pressure: 0.05 },
  holderTerms: ['growth', 'steady', 'base', 'breadth', 'retention', 'spread', 'dev'],
  top50Terms: ['retention', 'spread', 'dev'],
  growth: { lo: -10, flat: 0.3, hi: 25 },                  // % holders a day
  steady: { windowMs: 6 * HOUR, windows: 8, minWindows: 3, risePct: 0.5, riseShare: 0.6 },
  base: { lo: 200, hi: 5000 },                             // holders, log scale
  breadth: { lo: 0.30, hi: 0.60, minTraders: 20 },         // net buyers ÷ traders, 24h
  retention: { lo: 0.60, hi: 0.95 },
  spread: { top10: [15, 50], top50: [35, 80], top10Share: 0.67 },   // % of supply
  dev: { lo: 1, hi: 10 },                                  // % of supply
  activity: { volLo: 1e4, volHi: 1e6, turnFull: 0.5, turnFlatTo: 3, turnZero: 10 },
  trend: { drawdown: [0.2, 0.8], change: [-50, 50], drawdownShare: 0.6 },
  pressure: { lo: 0.40, hi: 0.60 },
  confidence: { floor: 0.5, fullHours: 72 },
  risk: {
    wash: { floor: 0.6, volPerTrader: [2000, 10000], turnover: [5, 15], organicBelow: 0.10 },
    sybil: { floor: 0.6, dust: [0.5, 0.9], unbought: [0.5, 0.9], minGrowth: 50 },
    whale: { floor: 0.7, top1: [5, 15] },
    bundle: 0.8,
    rug: { factor: 0.25, drawdown: 0.8 },
  },
  // A top-50 sample older than this no longer counts (the token is "holders pending" again)
  sampleMaxAgeMs: 36 * HOUR,
  minHistoryMs: 3 * HOUR,
};

const lin = (x, lo, hi) => Math.max(0, Math.min(1, (x - lo) / (hi - lo)));
const has = (v) => typeof v === 'number' && Number.isFinite(v);
const round = (v, d) => { const p = 10 ** d; return Math.round(v * p) / p; };

/** The ten terms, each 0..1, only those the features have data for. */
function terms(f, P = PARAMS) {
  const o = {};
  if (has(f.growth24)) {
    o.growth = f.growth24 <= 0 ? P.growth.flat * lin(f.growth24, P.growth.lo, 0) : P.growth.flat + (1 - P.growth.flat) * lin(f.growth24, 0, P.growth.hi);
  }
  if (f.windows >= P.steady.minWindows && has(f.rising) && has(f.spikeShare)) {
    o.steady = P.steady.riseShare * lin(f.rising / f.windows, 0, 1) + (1 - P.steady.riseShare) * (1 - lin(f.spikeShare, 0, 1));
  }
  if (has(f.holders)) o.base = lin(Math.log10(Math.max(f.holders, 1)), Math.log10(P.base.lo), Math.log10(P.base.hi));
  if (has(f.netBuyerRatio)) o.breadth = lin(f.netBuyerRatio, P.breadth.lo, P.breadth.hi);
  if (has(f.retention12)) o.retention = lin(f.retention12, P.retention.lo, P.retention.hi);
  if (has(f.top10) && has(f.top50)) {
    o.spread = P.spread.top10Share * (1 - lin(f.top10, ...P.spread.top10)) + (1 - P.spread.top10Share) * (1 - lin(f.top50, ...P.spread.top50));
  }
  if (has(f.devPct) && has(f.top10)) o.dev = 1 - lin(f.devPct, P.dev.lo, P.dev.hi);
  if (has(f.vol24) && f.mcap > 0) {
    const tv = f.vol24 / f.mcap;
    const A = P.activity;
    const turn = tv < A.turnFull ? tv / A.turnFull : tv <= A.turnFlatTo ? 1 : 1 - lin(tv, A.turnFlatTo, A.turnZero);
    o.activity = 0.5 * lin(Math.log10(Math.max(f.vol24, 1)), Math.log10(A.volLo), Math.log10(A.volHi)) + 0.5 * turn;
  }
  if (has(f.drawdown) && has(f.chg24)) {
    o.trend = P.trend.drawdownShare * (1 - lin(f.drawdown, ...P.trend.drawdown)) + (1 - P.trend.drawdownShare) * lin(f.chg24, ...P.trend.change);
  }
  if (has(f.buyShare)) o.pressure = lin(f.buyShare, P.pressure.lo, P.pressure.hi);
  return o;
}

/** True when the token is down 80% from its peak since bonding, or its liquidity is under the floor. */
function isRugged(f, P = PARAMS) {
  return (has(f.drawdown) && f.drawdown >= P.risk.rug.drawdown) || (has(f.liquidity) && has(f.minLiquidity) && f.liquidity < f.minLiquidity);
}

/** The five risk factors, each between its floor and 1, and their product. */
function risk(f, P = PARAMS) {
  const R = P.risk;
  const tv = has(f.vol24) && f.mcap > 0 ? f.vol24 / f.mcap : 0;
  const wash = 1 - (1 - R.wash.floor) * Math.max(
    has(f.volPerTrader) ? lin(f.volPerTrader, ...R.wash.volPerTrader) : 0,
    lin(tv, ...R.wash.turnover),
    has(f.organicShare) ? lin(R.wash.organicBelow - f.organicShare, 0, R.wash.organicBelow) : 0);
  const sybil = 1 - (1 - R.sybil.floor) * Math.max(
    has(f.dustShare) ? lin(f.dustShare, ...R.sybil.dust) : 0,
    has(f.unboughtShare) ? lin(f.unboughtShare, ...R.sybil.unbought) : 0);
  const whale = has(f.top1) ? 1 - (1 - R.whale.floor) * lin(f.top1, ...R.whale.top1) : 1;
  const bundle = f.equalBags ? R.bundle : 1;
  const rug = isRugged(f, P) ? R.rug.factor : 1;
  return { wash, sybil, whale, bundle, rug, total: wash * sybil * whale * bundle * rug };
}

function confidence(hours, P = PARAMS) {
  const h = Math.max(0, Math.min(has(hours) ? hours : 0, P.confidence.fullHours));
  return P.confidence.floor + (1 - P.confidence.floor) * Math.sqrt(h / P.confidence.fullHours);
}

/**
 * Score one token from its features.
 * @returns {{score, quality, confidence, risk, coverage, holderShare, pending, rugged, terms, riskParts}}
 *   coverage: the share of the weights that had data. pending: no top-50 term was
 *   available. score is null when no term at all has data.
 */
function scoreToken(f, P = PARAMS) {
  const t = terms(f, P);
  let sum = 0; let weight = 0; let holderWeight = 0;
  for (const [k, v] of Object.entries(t)) {
    sum += P.weights[k] * v;
    weight += P.weights[k];
    if (P.holderTerms.includes(k)) holderWeight += P.weights[k];
  }
  const r = risk(f, P);
  const c = confidence(f.hours, P);
  const quality = weight > 0 ? sum / weight : null;
  return {
    score: quality == null ? null : round(100 * quality * c * r.total, 1),
    quality: quality == null ? null : round(quality, 3),
    confidence: round(c, 2),
    risk: round(r.total, 2),
    coverage: round(weight, 2),
    holderShare: weight > 0 ? round(holderWeight / weight, 2) : null,
    pending: !P.top50Terms.some(k => k in t),
    rugged: r.rug < 1,
    terms: Object.fromEntries(Object.entries(t).map(([k, v]) => [k, round(v, 2)])),
    riskParts: { wash: round(r.wash, 2), sybil: round(r.sybil, 2), whale: round(r.whale, 2), bundle: round(r.bundle, 2), rug: round(r.rug, 2) },
  };
}

/** Holder count at `at`, from the newest point at or before it; null when there is none. */
function holdersAt(points, at) {
  let found = null;
  for (const p of points) {
    if (p.at > at) break;
    found = p;
  }
  return found ? found.holders : null;
}

/**
 * Holder growth features from the stored series.
 * @param {Array<{at:number, holders:number}>} points  oldest first, holder counts only
 * @param {number|null} holdersNow                     the live count (newer than any point)
 */
function holderSeriesFeatures(points, holdersNow, now, P = PARAMS) {
  const out = { growth24: null, growthCount24: null, windows: 0, rising: null, spikeShare: null };
  const series = points.filter(p => has(p.holders) && p.holders >= 0 && p.at <= now);
  if (has(holdersNow)) series.push({ at: now, holders: holdersNow });
  if (series.length < 2) return out;
  const first = series[0];
  const last = series[series.length - 1];
  const span = last.at - first.at;

  if (span >= P.minHistoryMs && first.holders > 0) {
    const dayAgo = holdersAt(series, last.at - DAY);
    if (dayAgo != null && dayAgo > 0) {
      out.growth24 = (last.holders / dayAgo - 1) * 100;
      out.growthCount24 = last.holders - dayAgo;
    } else {
      // Under a day of history: the change since the first point, as a daily rate
      out.growth24 = (last.holders / first.holders - 1) * 100 * (DAY / span);
    }
  }

  // The last eight 6-hour windows that the series fully covers
  const S = P.steady;
  const gains = [];
  for (let i = 0; i < S.windows; i++) {
    const end = last.at - i * S.windowMs;
    const start = end - S.windowMs;
    if (start < first.at) break;
    const a = holdersAt(series, start);
    const b = holdersAt(series, end);
    if (a == null || b == null) break;
    gains.push({ gain: b - a, pct: a > 0 ? ((b - a) / a) * 100 : 0 });
  }
  out.windows = gains.length;
  if (gains.length >= S.minWindows) {
    out.rising = gains.filter(g => g.pct >= S.risePct).length;
    const positive = gains.map(g => Math.max(0, g.gain));
    const total = positive.reduce((s, g) => s + g, 0);
    out.spikeShare = total > 0 ? Math.max(...positive) / total : 1;
  }
  return out;
}

/**
 * Everything scoreToken needs, from what is stored.
 * @param {Object} token   { graduatedAt(ms), holders, mcap, liquidity, peakMcap, market: {stats, audit} }
 * @param {Array} points   [{at(ms), holders}] oldest first
 * @param {Object|null} sample  latest top-50 sample: { takenAt(ms), top1, top10, top50, devPct, dustShare, retention12, equalBags }
 * @param {Object} opts    { now, minLiquidity }
 */
function buildFeatures(token, points, sample, { now, minLiquidity }, P = PARAMS) {
  const s24 = token.market?.stats?.['24h'] || {};
  const f = {
    hours: (now - token.graduatedAt) / HOUR,
    holders: has(token.holders) ? token.holders : null,
    mcap: has(token.mcap) ? token.mcap : null,
    liquidity: has(token.liquidity) ? token.liquidity : null,
    minLiquidity,
    ...holderSeriesFeatures(points || [], token.holders, now, P),
  };
  const buy = has(s24.buyVolume) ? s24.buyVolume : null;
  const sell = has(s24.sellVolume) ? s24.sellVolume : null;
  if (buy != null || sell != null) {
    f.vol24 = (buy || 0) + (sell || 0);
    if (f.vol24 > 0) f.buyShare = (buy || 0) / f.vol24;
  }
  if (has(s24.numTraders) && s24.numTraders >= P.breadth.minTraders) {
    if (has(s24.numNetBuyers)) f.netBuyerRatio = Math.max(0, s24.numNetBuyers) / s24.numTraders;
    if (has(f.vol24)) f.volPerTrader = f.vol24 / s24.numTraders;
  }
  if (has(s24.buyOrganicVolume) && buy > 0) f.organicShare = Math.min(1, s24.buyOrganicVolume / buy);
  if (has(s24.priceChange)) f.chg24 = s24.priceChange;
  if (has(token.peakMcap) && token.peakMcap > 0 && has(token.mcap)) f.drawdown = Math.max(0, 1 - token.mcap / token.peakMcap);
  // Holders that arrived in the last day without a matching net buyer (airdrops, transfers)
  if (has(f.growthCount24) && f.growthCount24 >= P.risk.sybil.minGrowth && has(s24.numNetBuyers)) {
    f.unboughtShare = Math.max(0, Math.min(1, 1 - Math.max(0, s24.numNetBuyers) / f.growthCount24));
  }
  if (sample && has(sample.takenAt) && now - sample.takenAt <= P.sampleMaxAgeMs) {
    for (const k of ['top1', 'top10', 'top50', 'devPct', 'dustShare', 'retention12']) if (has(sample[k])) f[k] = sample[k];
    f.equalBags = !!sample.equalBags;
  }
  return f;
}

/** A token whose mint or freeze authority is still enabled is not listed. */
function authoritiesOpen(token) {
  const a = token.market?.audit || {};
  return a.mintAuthorityDisabled === false || a.freezeAuthorityDisabled === false;
}

module.exports = { PARAMS, HOUR, DAY, lin, terms, risk, confidence, isRugged, scoreToken, holderSeriesFeatures, buildFeatures, authoritiesOpen };
