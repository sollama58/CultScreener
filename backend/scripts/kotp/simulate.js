/**
 * King of the Pill simulation: realistic mock holder bases for ~40 curated tokens,
 * one year of daily scoring and crowning, reporting how often the crown moves.
 * Each token also has a mock market (a daily price walk, market cap and 24h volume),
 * so the trading-activity and price-momentum terms of the score are exercised too.
 *
 *   node simulate.js [days=365] [seeds=5] [--json]
 */
const { PARAMS, DAY, BUCKETS, scoreToken, pickKing } = require('../../src/services/kotpScore');

// ── Deterministic RNG ───────────────────────────────────────────────────────
function rng(seed) {
  let s = seed >>> 0 || 1;
  const r = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  r.int = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
  r.exp = mean => -Math.log(1 - r()) * mean;
  r.pareto = (xm, a) => xm / Math.pow(1 - r(), 1 / a);
  r.normal = () => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
  return r;
}

// ── Mock token universe ─────────────────────────────────────────────────────
// Archetypes: steady cult (low churn), hype coin (fast growth, fast churn), fading
// (net outflow), new launch (appears mid-sim), whale-held (supply concentrated).
// Market: drift and vol are the daily log-return mean and spread, mcap the starting
// market cap in USD, turnover the typical 24h volume as a share of market cap.
const ARCHETYPES = [
  { name: 'cult',   w: 0.35, churn: [0.004, 0.012], inflow: [0.004, 0.015], holders: [800, 20000],  age: [60, 700],
    drift: [0, 0.004],       vol: [0.04, 0.08], mcap: [1e6, 5e7], turnover: [0.03, 0.15] },
  { name: 'hype',   w: 0.25, churn: [0.02, 0.06],   inflow: [0.02, 0.08],   holders: [500, 15000],  age: [10, 120],
    drift: [-0.01, 0.02],    vol: [0.10, 0.20], mcap: [2e5, 2e7], turnover: [0.2, 1.0] },
  { name: 'fading', w: 0.15, churn: [0.015, 0.04],  inflow: [0.001, 0.008], holders: [300, 8000],   age: [90, 500],
    drift: [-0.012, -0.002], vol: [0.05, 0.10], mcap: [1e5, 5e6], turnover: [0.005, 0.05] },
  { name: 'launch', w: 0.15, churn: [0.01, 0.04],   inflow: [0.03, 0.12],   holders: [150, 1500],   age: [-200, 3], // negative = launches later
    drift: [-0.005, 0.02],   vol: [0.10, 0.25], mcap: [5e4, 2e6], turnover: [0.2, 1.5] },
  { name: 'whale',  w: 0.10, churn: [0.006, 0.02],  inflow: [0.004, 0.02],  holders: [200, 3000],   age: [30, 400],
    drift: [-0.003, 0.005],  vol: [0.05, 0.12], mcap: [2e5, 1e7], turnover: [0.02, 0.2] },
];

function pickArchetype(r) {
  let x = r();
  for (const a of ARCHETYPES) { if ((x -= a.w) <= 0) return a; }
  return ARCHETYPES[0];
}

function makeToken(i, r, t0) {
  const a = pickArchetype(r);
  const lerp = ([lo, hi]) => lo + r() * (hi - lo);
  const ageDays = lerp(a.age);
  const t = {
    mint: `${a.name}-${i}`, archetype: a.name,
    launchedAt: t0 - ageDays * DAY,
    churn: lerp(a.churn), inflow: lerp(a.inflow),
    targetHolders: Math.round(lerp(a.holders)),
    whaleAlpha: a.name === 'whale' ? 0.8 : 1.3,
    wallets: [],      // { acquiredAt, balance }
    sampleBias: (r() - 0.5) * 2 * 2,
    holdersHistory: [], coreHistory: [],
    // Market: price starts at 1, so market cap is mcap0 × price
    drift: lerp(a.drift), vol: lerp(a.vol), mcap0: lerp(a.mcap), turnover: lerp(a.turnover),
    price: 1, priceHistory: [], volume24h: null,
  };
  return t;
}

// Seed a token's holder base as of `now`: holders accumulated over its life with
// survival that favours older acquisitions (the people who held are the ones still here).
function seedHolders(t, r, now) {
  const age = now - t.launchedAt;
  if (age <= 0) return;
  const n = Math.round(t.targetHolders * Math.min(1, age / (30 * DAY)) * (0.5 + r()));
  for (let k = 0; k < n; k++) {
    // Acquisition time: mix of early buyers and a steady stream, thinned by churn
    let acq;
    if (r() < 0.35) acq = t.launchedAt + r() * Math.min(age, 7 * DAY);
    else acq = now - r.exp(1 / Math.max(t.churn, 0.003) * DAY);
    acq = Math.max(t.launchedAt, Math.min(now - DAY * r(), acq));
    t.wallets.push({ acquiredAt: acq, balance: r.pareto(1, t.whaleAlpha) });
  }
}

function stepDay(t, r, now) {
  if (now < t.launchedAt) return;
  if (t.wallets.length === 0 && now - t.launchedAt < 2 * DAY) seedHolders(t, r, now);
  // Occasional shocks: a dump day or a hype day
  let churn = t.churn, inflow = t.inflow;
  const shock = r();
  if (shock < 0.03) churn *= 4;            // dump
  else if (shock < 0.06) inflow *= 4;      // hype
  // Market: a log-normal price step (dumps fall, hype days rise) and the day's volume,
  // which runs hotter on shock days
  const jump = shock < 0.03 ? -0.2 : shock < 0.06 ? 0.2 : 0;
  t.price *= Math.exp(t.drift + t.vol * r.normal() + jump);
  t.volume24h = t.mcap0 * t.price * t.turnover * Math.exp(0.5 * r.normal()) * (shock < 0.06 ? 3 : 1);
  // Sell: recent buyers are ~3x more likely to sell than long holders
  t.wallets = t.wallets.filter(w => {
    const heldDays = (now - w.acquiredAt) / DAY;
    const mult = heldDays < 3 ? 3 : heldDays < 30 ? 1.5 : heldDays < 180 ? 0.8 : 0.5;
    const whaleMult = w.balance > 50 ? 0.5 : 1;
    return r() >= churn * mult * whaleMult;
  });
  // Buy
  const room = Math.max(0, 1 - t.wallets.length / (3 * t.targetHolders));
  const nNew = Math.round(r.exp(inflow * Math.max(t.wallets.length, 50) * room));
  for (let k = 0; k < nNew; k++) t.wallets.push({ acquiredAt: now - r() * DAY, balance: r.pareto(1, t.whaleAlpha) });
}

// Bucket distributions as the pipeline reports them (full population here; the real
// stratified estimate adds a little noise, applied below).
function distributions(t, now, r) {
  const n = t.wallets.length;
  if (!n) return { distribution: null, supplyDistribution: null };
  const total = t.wallets.reduce((s, w) => s + w.balance, 0);
  const distribution = {}, supplyDistribution = {};
  for (const b of BUCKETS) {
    let c = 0, amt = 0;
    for (const w of t.wallets) if (now - w.acquiredAt >= b.ms) { c++; amt += w.balance; }
    // Sampling error of a stable 250-wallet sample: a persistent per-token offset plus a little daily jitter
    const noise = () => t.sampleBias + (r() - 0.5) * 2 * 0.5;
    distribution[b.key] = Math.max(0, Math.min(100, Math.round((c / n * 100 + noise()) * 10) / 10));
    supplyDistribution[b.key] = Math.max(0, Math.min(100, Math.round((amt / total * 100 + noise()) * 10) / 10));
  }
  return { distribution, supplyDistribution };
}

// ── One run ─────────────────────────────────────────────────────────────────
function run({ days = 365, seed = 1, nTokens = 40, params = PARAMS, rule = 'fatigue' } = {}) {
  const r = rng(seed);
  const t0 = Date.UTC(2026, 0, 1);
  const tokens = Array.from({ length: nTokens }, (_, i) => makeToken(i, r, t0));
  for (const t of tokens) seedHolders(t, r, t0);

  let king = null;                 // { mint, crownedOn (day index) }
  const lastReignEnd = {};
  const reignEnds = {};
  const reigns = [];
  const reasons = {};
  let scoreMoves = [], top5Changes = 0, prevTop5 = null;
  const dailyScores = [];

  for (let d = 0; d < days; d++) {
    const now = t0 + d * DAY;
    const scored = [];
    for (const t of tokens) {
      stepDay(t, r, now);
      const { distribution, supplyDistribution } = distributions(t, now, r);
      const holders = t.wallets.length;
      t.holdersHistory.push(holders);
      const launched = now >= t.launchedAt;
      if (launched) t.priceHistory.push(t.price);
      const change = back => (t.priceHistory.length > back
        ? (t.price / t.priceHistory[t.priceHistory.length - 1 - back] - 1) * 100 : null);
      const res = scoreToken({
        distribution, supplyDistribution,
        ageMs: now - t.launchedAt, holders,
        snapshotAgeMs: r() * 6 * 3_600_000,
        coreWeekAgo: t.coreHistory.length >= 7 ? t.coreHistory[t.coreHistory.length - 7] : null,
        holdersMonthAgo: t.holdersHistory.length >= 8 ? t.holdersHistory[Math.max(0, t.holdersHistory.length - 31)] : null,
        volume24h: launched ? t.volume24h : null,
        marketCap: launched ? t.mcap0 * t.price : null,
        priceChanges: launched ? { d1: change(1), d7: change(7), d30: change(30) } : null,
      }, params);
      t.coreHistory.push(res.core);
      if (res.eligible) scored.push({ mint: t.mint, score: res.score, archetype: t.archetype });
      if (res.eligible && t.lastScore != null) scoreMoves.push(Math.abs(res.score - t.lastScore));
      t.lastScore = res.eligible ? res.score : null;
    }
    const top5 = [...scored].sort((a, b) => b.score - a.score).slice(0, 5).map(s => s.mint);
    if (prevTop5 && top5.join() !== prevTop5.join()) top5Changes++;
    prevTop5 = top5;
    dailyScores.push(scored);

    let pick;
    if (rule === 'naive') {
      const best = [...scored].sort((a, b) => b.score - a.score)[0];
      pick = best ? { mint: best.mint, changed: !king || king.mint !== best.mint, reason: 'top', score: best.score } : { mint: king?.mint ?? null, changed: false, reason: 'none' };
    } else {
      pick = pickKing(scored, king, lastReignEnd, d, params, reignEnds);
    }
    reasons[pick.reason] = (reasons[pick.reason] || 0) + 1;
    if (pick.changed || (!king && pick.mint)) {
      if (king) { lastReignEnd[king.mint] = d; (reignEnds[king.mint] = reignEnds[king.mint] || []).push(d); reigns[reigns.length - 1].ended = d; }
      king = { mint: pick.mint, crownedOn: d };
      reigns.push({ mint: pick.mint, archetype: tokens.find(t => t.mint === pick.mint)?.archetype, started: d, ended: null, score: pick.score });
    }
  }
  if (king) reigns[reigns.length - 1].ended = days;

  const lengths = reigns.map(x => x.ended - x.started);
  const sorted = [...lengths].sort((a, b) => a - b);
  const byMint = {};
  for (const x of reigns) byMint[x.mint] = (byMint[x.mint] || 0) + (x.ended - x.started);
  const byArch = {};
  for (const x of reigns) byArch[x.archetype] = (byArch[x.archetype] || 0) + 1;
  const eligibleCounts = dailyScores.map(s => s.length);
  return {
    seed, days, rule,
    reigns: reigns.length,
    distinctKings: Object.keys(byMint).length,
    meanReign: +(days / reigns.length).toFixed(2),
    medianReign: sorted[Math.floor(sorted.length / 2)],
    minReign: sorted[0], maxReign: sorted[sorted.length - 1],
    topKingShare: +(Math.max(...Object.values(byMint)) / days).toFixed(3),
    reignsByArchetype: byArch,
    fadingShare: +(((byArch.fading || 0) / reigns.length)).toFixed(2),
    reasons,
    eligiblePerDay: +(eligibleCounts.reduce((a, b) => a + b, 0) / days).toFixed(1),
    meanDailyScoreMove: +(scoreMoves.reduce((a, b) => a + b, 0) / scoreMoves.length).toFixed(2),
    top5ChangeDays: +(top5Changes / (days - 1)).toFixed(2),
    reignsSample: reigns.slice(0, 12).map(x => `${x.mint}:${x.ended - x.started}d@${x.score?.toFixed(1)}`),
  };
}

function summarize(results) {
  const avg = k => +(results.reduce((a, b) => a + b[k], 0) / results.length).toFixed(2);
  return {
    runs: results.length, rule: results[0].rule,
    reignsPerYear: avg('reigns'), meanReignDays: avg('meanReign'), medianReignDays: avg('medianReign'),
    maxReignDays: Math.max(...results.map(x => x.maxReign)), distinctKings: avg('distinctKings'),
    topKingShareOfDays: avg('topKingShare'), fadingShare: avg('fadingShare'), eligiblePerDay: avg('eligiblePerDay'),
    meanDailyScoreMove: avg('meanDailyScoreMove'), top5ChangeDays: avg('top5ChangeDays'),
  };
}

if (require.main === module) {
  const days = parseInt(process.argv[2], 10) || 365;
  const seeds = parseInt(process.argv[3], 10) || 5;
  const out = {};
  const runs = (opts) => Array.from({ length: seeds }, (_, i) => run({ days, seed: 1000 + i, ...opts }));

  out.proposed = summarize(runs({}));
  out.naiveTopScore = summarize(runs({ rule: 'naive' }));
  out.variants = {};
  const variants = {
    'fatigue 5%/day':            { fatiguePerDay: 0.05 },
    'fatigue 12%/day':           { fatiguePerDay: 0.12 },
    'max reign 5d':              { maxReignDays: 5 },
    'max reign 8d':              { maxReignDays: 8 },
    'cooldown 21d':              { cooldownDays: 21 },
    'min reign 2d':              { minReignDays: 2 },
    'min reign 4d':              { minReignDays: 4 },
    'no challenge margin':       { challengeMargin: 0 },
    'challenge margin 4':        { challengeMargin: 4 },
    'no repeat penalty':         { repeatPenalty: 0 },
    'cooldown 10d':              { cooldownDays: 10 },
    'no momentum/retention':     { momentumWeight: 0, retentionGainWeight: 0, retentionLossWeight: 0 },
    'no activity/price':         { volumeWeight: 0, priceGainWeight: 0, priceLossWeight: 0 },
    'no age normalisation':      { achievableMarginMs: -400 * DAY, confidenceFullDays: 0.001 },
  };
  for (const [name, over] of Object.entries(variants)) out.variants[name] = summarize(runs({ params: { ...PARAMS, ...over } }));
  const one = run({ days, seed: 1000 });
  out.exampleRun = { reasons: one.reasons, reignsByArchetype: one.reignsByArchetype, firstReigns: one.reignsSample };
  if (process.argv.includes('--json')) console.log(JSON.stringify(out, null, 2));
  else {
    const row = (name, s) => console.log(name.padEnd(26), `reigns/yr ${String(s.reignsPerYear).padStart(6)}  mean ${String(s.meanReignDays).padStart(5)}d  median ${String(s.medianReignDays).padStart(4)}d  max ${String(s.maxReignDays).padStart(3)}d  kings ${String(s.distinctKings).padStart(5)}  top-share ${s.topKingShareOfDays}  fading ${s.fadingShare}  eligible/day ${s.eligiblePerDay}  score move ${s.meanDailyScoreMove}  top5 churn ${s.top5ChangeDays}`);
    row('PROPOSED', out.proposed);
    row('naive: highest score', out.naiveTopScore);
    for (const [k, v] of Object.entries(out.variants)) row(k, v);
    console.log('\nexample run:', JSON.stringify(out.exampleRun, null, 1));
  }
}

module.exports = { run, summarize };
