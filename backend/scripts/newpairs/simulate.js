#!/usr/bin/env node
/**
 * New Pairs score simulation: mock tokens from six archetypes graduate over 14 days
 * and go through the real pipeline shape: hourly holder points (thinned like
 * newpair_points), 24h market stats, a top-50 sample every 6 hours for the 50 best
 * scores only, and the real scoring code (src/services/newPairScore.js).
 *
 *   node scripts/newpairs/simulate.js [tokens=2000] [seeds=3] [--json] [--no-sensitivity]
 *
 * It answers: which archetypes fill the top 20 and the top 50, how soon a real cult
 * reaches the shortlist, how much the top 20 changes between runs, and how much each
 * weight and ramp matters (each moved ±50%).
 *
 * The archetypes are assumptions about how such tokens behave, not measurements. The
 * replay on two weeks of real stored data (PR 9) is the check on them.
 */
const { PARAMS, HOUR, DAY, buildFeatures, scoreToken } = require('../../src/services/newPairScore');

const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const N_TOKENS = parseInt(args[0], 10) || 2000;
const N_SEEDS = parseInt(args[1], 10) || 3;
const JSON_OUT = process.argv.includes('--json');
const SENSITIVITY = !process.argv.includes('--no-sensitivity');
const DAYS = 14;
const STEP_H = 6;                 // ranking and holder-tier cadence
const SHORTLIST = 50;
const MIN_LIQUIDITY = 5000;

function rng(seed) {
  let s = seed >>> 0 || 1;
  const r = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  r.range = ([lo, hi]) => lo + r() * (hi - lo);
  r.normal = () => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
  return r;
}

// Share of listed tokens (those above the floors at some point). Daily rates are per day.
// holders: start count, growth a day, and an optional early spike. price: drift and
// noise a day, an optional pump then dump. stats: the 24h trading picture. top: the
// top-50 holder picture a sample would find.
const ARCHETYPES = {
  cult: { share: 0.06, holders0: [300, 1500], growth: [0.08, 0.20], mcap0: [6e4, 8e5], drift: [0.00, 0.10], noise: 0.12,
    turnover: [0.15, 0.8], traders: [0.10, 0.30], netBuyers: [0.45, 0.62], buyShare: [0.50, 0.58], organic: [0.20, 0.45],
    top10: [12, 24], top50: [30, 48], top1: [1.5, 4.5], dev: [0, 2], dust: [0.2, 0.4], retention: [0.86, 0.97], unbought: [0.0, 0.3] },
  pumpDump: { share: 0.40, holders0: [200, 900], growth: [-0.12, -0.03], spike: { peakH: [4, 20], gain: [0.6, 2.5] }, mcap0: [5e4, 4e5], drift: [-0.35, -0.10], noise: 0.25, pump: { peakH: [4, 20], gain: [2, 8] },
    turnover: [1.5, 8], traders: [0.15, 0.5], netBuyers: [0.25, 0.42], buyShare: [0.42, 0.50], organic: [0.03, 0.15],
    top10: [30, 50], top50: [60, 82], top1: [5, 12], dev: [2, 9], dust: [0.4, 0.65], retention: [0.40, 0.70], unbought: [0.1, 0.4] },
  slowRug: { share: 0.25, holders0: [300, 2500], growth: [-0.07, -0.01], mcap0: [5e4, 5e5], drift: [-0.16, -0.05], noise: 0.10,
    turnover: [0.1, 0.6], traders: [0.03, 0.12], netBuyers: [0.20, 0.36], buyShare: [0.40, 0.48], organic: [0.10, 0.30],
    top10: [26, 42], top50: [52, 72], top1: [5, 10], dev: [5, 12], dust: [0.35, 0.55], retention: [0.68, 0.85], unbought: [0, 0.2] },
  wash: { share: 0.10, holders0: [250, 900], growth: [-0.01, 0.03], mcap0: [1e5, 6e5], drift: [-0.03, 0.04], noise: 0.08,
    turnover: [6, 25], traders: [0.02, 0.06], netBuyers: [0.28, 0.40], buyShare: [0.49, 0.51], organic: [0.0, 0.05],
    top10: [30, 46], top50: [62, 80], top1: [5, 10], dev: [1, 4], dust: [0.15, 0.35], retention: [0.85, 0.95], unbought: [0, 0.2] },
  sybil: { share: 0.10, holders0: [400, 2000], growth: [0.20, 0.45], mcap0: [6e4, 4e5], drift: [-0.05, 0.03], noise: 0.10,
    turnover: [0.1, 0.5], traders: [0.01, 0.04], netBuyers: [0.28, 0.40], buyShare: [0.47, 0.53], organic: [0.03, 0.12],
    top10: [24, 38], top50: [48, 66], top1: [4, 8], dev: [0.5, 3], dust: [0.75, 0.92], retention: [0.85, 0.95], unbought: [0.8, 0.98] },
  whale: { share: 0.09, holders0: [300, 2000], growth: [0.00, 0.05], mcap0: [1e5, 1e6], drift: [-0.03, 0.04], noise: 0.08,
    turnover: [0.08, 0.4], traders: [0.04, 0.15], netBuyers: [0.38, 0.50], buyShare: [0.48, 0.54], organic: [0.15, 0.35],
    top10: [36, 52], top50: [55, 72], top1: [11, 22], dev: [0, 2], dust: [0.2, 0.4], retention: [0.92, 0.99], unbought: [0, 0.2] },
};
const NAMES = Object.keys(ARCHETYPES);

function pickArchetype(r) {
  let x = r();
  for (const name of NAMES) { if ((x -= ARCHETYPES[name].share) <= 0) return name; }
  return NAMES[0];
}

/** One token's whole 14 days, hour by hour: holders, market cap, and its fixed traits. */
function makeToken(i, r, t0) {
  const name = pickArchetype(r);
  const a = ARCHETYPES[name];
  const born = t0 + Math.floor(r() * DAYS * 24) * HOUR;
  const hours = Math.ceil((t0 + DAYS * DAY - born) / HOUR);
  const growth = r.range(a.growth); const drift = r.range(a.drift);
  const spike = a.spike && { peakH: r.range(a.spike.peakH), gain: r.range(a.spike.gain) };
  const pump = a.pump && { peakH: r.range(a.pump.peakH), gain: r.range(a.pump.gain) };
  const holders = [Math.round(r.range(a.holders0))];
  const mcap = [r.range(a.mcap0)];
  for (let h = 1; h <= hours; h++) {
    // Holders: steady daily rate, plus (pump-and-dump) one fast run-up that then bleeds
    let hRate = growth / 24;
    if (spike) hRate = h <= spike.peakH ? Math.log(1 + spike.gain) / spike.peakH : growth / 24;
    holders.push(Math.max(1, Math.round(holders[h - 1] * Math.exp(hRate + r.normal() * 0.004))));
    let mRate = drift / 24;
    if (pump) mRate = h <= pump.peakH ? Math.log(pump.gain) / pump.peakH : (drift - 0.9) / 24;
    mcap.push(Math.max(500, mcap[h - 1] * Math.exp(mRate + r.normal() * a.noise / Math.sqrt(24))));
  }
  const trait = (k) => r.range(a[k]);
  return {
    id: i, archetype: name, born, holders, mcap,
    turnover: trait('turnover'), traders: trait('traders'), netBuyers: trait('netBuyers'), buyShare: trait('buyShare'), organic: trait('organic'),
    top10: trait('top10'), top50: trait('top50'), top1: trait('top1'), dev: trait('dev'), dust: trait('dust'), retention: trait('retention'), unbought: trait('unbought'),
    liqShare: 0.05 + r() * 0.07, noise: r,
    sample: null, samples: 0, firstShortlistH: null, everTop20: false,
  };
}

/** What the worker would have stored for this token at `now`. */
function snapshot(t, now) {
  const age = Math.floor((now - t.born) / HOUR);
  const mcap = t.mcap[age];
  const peak = Math.max(...t.mcap.slice(0, age + 1));
  const holders = t.holders[age];
  const dayAgo = t.holders[Math.max(0, age - 24)];
  const mcapDayAgo = t.mcap[Math.max(0, age - 24)];
  const vol = mcap * t.turnover * Math.min(1, age / 24 + 0.2);
  const traders = Math.max(5, Math.round(holders * t.traders));
  // Net buyers: the archetype's ratio; farmed holders did not buy, so they add none
  const netBuyers = Math.round(traders * t.netBuyers);
  const points = [];
  for (let h = Math.max(0, age - 52); h < age; h++) {
    // Hourly for 3 days, then every 3 hours, as newpair_points keeps them
    if (h <= 72 || h % 3 === 0) points.push({ at: t.born + h * HOUR, holders: t.holders[h] });
  }
  const token = {
    graduatedAt: t.born, holders, mcap, liquidity: mcap * t.liqShare, peakMcap: peak,
    market: { stats: { '24h': { buyVolume: vol * t.buyShare, sellVolume: vol * (1 - t.buyShare), buyOrganicVolume: vol * t.buyShare * t.organic,
      numTraders: traders, numNetBuyers: t.archetype === 'sybil' ? Math.round((holders - dayAgo) * (1 - t.unbought)) : netBuyers,
      priceChange: (mcap / mcapDayAgo - 1) * 100 } } },
  };
  return { token, points };
}

function takeSample(t, now) {
  const first = t.samples === 0;
  t.samples++;
  const jitter = () => 1 + (t.noise() - 0.5) * 0.06;
  t.sample = { takenAt: now, top1: t.top1 * jitter(), top10: t.top10 * jitter(), top50: t.top50 * jitter(), devPct: t.dev, dustShare: t.dust,
    retention12: first ? null : Math.min(1, t.retention * jitter()), equalBags: false };
}

function run(seed, nTokens, P = PARAMS) {
  const r = rng(seed);
  const t0 = 0;
  const tokens = Array.from({ length: nTokens }, (_, i) => makeToken(i, r, t0));
  const stats = { steps: 0, top20: Object.fromEntries(NAMES.map(n => [n, 0])), top50: Object.fromEntries(NAMES.map(n => [n, 0])), churn: [], listed: 0, rugged: 0 };
  let prevTop20 = null;
  for (let step = 1; step <= (DAYS * 24) / STEP_H; step++) {
    const now = t0 + step * STEP_H * HOUR;
    const ranked = [];
    for (const t of tokens) {
      if (t.born >= now) continue;
      const { token, points } = snapshot(t, now);
      const s = scoreToken(buildFeatures(token, points, t.sample, { now, minLiquidity: MIN_LIQUIDITY }, P), P);
      if (step > 12) { stats.listed++; if (s.rugged) stats.rugged++; }
      if (s.score != null && !s.rugged) ranked.push({ t, score: s.score });   // rugged tokens are hidden by default
    }
    ranked.sort((a, b) => b.score - a.score);
    // The holder tier checks the 50 best scores
    for (const { t } of ranked.slice(0, SHORTLIST)) {
      if (t.firstShortlistH == null) t.firstShortlistH = (now - t.born) / HOUR;
      takeSample(t, now);
    }
    for (const { t } of ranked.slice(0, 20)) t.everTop20 = true;
    if (step <= 12) continue;   // first 3 days: the list is still filling
    stats.steps++;
    for (const { t } of ranked.slice(0, 20)) stats.top20[t.archetype]++;
    for (const { t } of ranked.slice(0, 50)) stats.top50[t.archetype]++;
    const ids = new Set(ranked.slice(0, 20).map(x => x.t.id));
    if (prevTop20) stats.churn.push([...ids].filter(id => !prevTop20.has(id)).length / 20);
    prevTop20 = ids;
  }
  const cults = tokens.filter(t => t.archetype === 'cult' && t.born < t0 + (DAYS - 3) * DAY);
  const reached = cults.filter(t => t.firstShortlistH != null).map(t => t.firstShortlistH).sort((a, b) => a - b);
  return {
    top20: Object.fromEntries(NAMES.map(n => [n, stats.top20[n] / (stats.steps * 20)])),
    top50: Object.fromEntries(NAMES.map(n => [n, stats.top50[n] / (stats.steps * 50)])),
    churn: stats.churn.reduce((s, c) => s + c, 0) / Math.max(1, stats.churn.length),
    cultShortlisted: reached.length / Math.max(1, cults.length),
    cultMedianHoursToShortlist: reached.length ? reached[Math.floor(reached.length / 2)] : null,
    cultEverTop20: cults.filter(t => t.everTop20).length / Math.max(1, cults.length),
    ruggedShare: stats.rugged / Math.max(1, stats.listed),
  };
}

function average(results) {
  const mean = (pick) => results.reduce((s, r) => s + (pick(r) ?? 0), 0) / results.length;
  return {
    top20: Object.fromEntries(NAMES.map(n => [n, mean(r => r.top20[n])])),
    top50: Object.fromEntries(NAMES.map(n => [n, mean(r => r.top50[n])])),
    churn: mean(r => r.churn), cultShortlisted: mean(r => r.cultShortlisted),
    cultMedianHoursToShortlist: mean(r => r.cultMedianHoursToShortlist), cultEverTop20: mean(r => r.cultEverTop20), ruggedShare: mean(r => r.ruggedShare),
  };
}

const runAll = (P, nTokens = N_TOKENS, seeds = N_SEEDS) => average(Array.from({ length: seeds }, (_, i) => run(1000 + i * 7919, nTokens, P)));
const pct = (v) => `${(v * 100).toFixed(1)}%`.padStart(7);
const clone = (o) => JSON.parse(JSON.stringify(o));

function sensitivity() {
  const rows = [];
  const tokens = Math.min(N_TOKENS, 1000);
  const add = (label, mutate) => {
    const P = clone(PARAMS);
    mutate(P);
    const r = runAll(P, tokens, Math.min(N_SEEDS, 2));
    rows.push({ label, cultTop20: r.top20.cult, cultTop50: r.top50.cult, churn: r.churn, hours: r.cultMedianHoursToShortlist });
  };
  add('baseline', () => {});
  for (const k of Object.keys(PARAMS.weights)) {
    add(`${k} weight -50%`, (P) => { P.weights[k] *= 0.5; });
    add(`${k} weight +50%`, (P) => { P.weights[k] *= 1.5; });
  }
  add('confidence floor 0.3', (P) => { P.confidence.floor = 0.3; });
  add('confidence floor 0.7', (P) => { P.confidence.floor = 0.7; });
  add('confidence full at 36h', (P) => { P.confidence.fullHours = 36; });
  add('confidence full at 144h', (P) => { P.confidence.fullHours = 144; });
  add('growth full at +12.5%/day', (P) => { P.growth.hi = 12.5; });
  add('growth full at +50%/day', (P) => { P.growth.hi = 50; });
  add('retention ramp 50-90%', (P) => { P.retention.lo = 0.5; P.retention.hi = 0.9; });
  add('wash and sybil floors 0.4', (P) => { P.risk.wash.floor = 0.4; P.risk.sybil.floor = 0.4; });
  add('wash and sybil floors 0.8', (P) => { P.risk.wash.floor = 0.8; P.risk.sybil.floor = 0.8; });
  add('whale floor 0.5', (P) => { P.risk.whale.floor = 0.5; });
  add('no risk factors', (P) => { P.risk.wash.floor = 1; P.risk.sybil.floor = 1; P.risk.whale.floor = 1; P.risk.bundle = 1; });
  return rows;
}

function main() {
  const base = runAll(PARAMS);
  const sens = SENSITIVITY ? sensitivity() : [];
  if (JSON_OUT) { console.log(JSON.stringify({ tokens: N_TOKENS, seeds: N_SEEDS, days: DAYS, base, sensitivity: sens }, null, 2)); return; }
  console.log(`New Pairs score simulation: ${N_TOKENS} tokens over ${DAYS} days, ${N_SEEDS} seeds, ranked every ${STEP_H}h, shortlist ${SHORTLIST}`);
  console.log(`Rugged tokens are hidden from the ranks (${pct(base.ruggedShare).trim()} of listed token-steps).\n`);
  console.log('Archetype       share of tokens   share of top 20   share of top 50');
  for (const n of NAMES) console.log(`${n.padEnd(15)} ${pct(ARCHETYPES[n].share).padStart(12)} ${pct(base.top20[n]).padStart(17)} ${pct(base.top50[n]).padStart(17)}`);
  console.log(`\nCults that reach the shortlist (top ${SHORTLIST}):   ${pct(base.cultShortlisted).trim()}`);
  console.log(`Median hours from bonding to the shortlist: ${base.cultMedianHoursToShortlist.toFixed(1)}`);
  console.log(`Cults that reach the top 20 at some point:  ${pct(base.cultEverTop20).trim()}`);
  console.log(`Top-20 churn per ${STEP_H}h (share replaced):      ${pct(base.churn).trim()}`);
  if (sens.length) {
    console.log(`\nSensitivity (${Math.min(N_TOKENS, 1000)} tokens, ${Math.min(N_SEEDS, 2)} seeds): cult share of the top 20 and top 50, churn, hours to shortlist`);
    console.log('Change                         cult/top20  cult/top50    churn   hours');
    for (const r of sens) console.log(`${r.label.padEnd(30)} ${pct(r.cultTop20)}    ${pct(r.cultTop50)}   ${pct(r.churn)}  ${r.hours.toFixed(1).padStart(6)}`);
  }
}

if (require.main === module) main();
module.exports = { run, ARCHETYPES, NAMES };
