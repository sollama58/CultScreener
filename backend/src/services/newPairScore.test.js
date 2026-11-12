/**
 * New Pairs score: the eight worked examples from the plan (they are the numbers the
 * owner approved), every term at its bounds, re-weighting when terms are missing,
 * each risk factor, and the features derived from the stored series.
 */
const { test } = require('node:test');
const assert = require('node:assert');

const S = require('./newPairScore');
const { PARAMS, HOUR, DAY, scoreToken, terms, risk, confidence, holderSeriesFeatures, buildFeatures, authoritiesOpen } = S;

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} is not ${b}`);

// name → [features, expected score, quality, confidence, risk]
const EXAMPLES = {
  'cult, 60h': [{ hours: 60, holders: 3200, growth24: 14, windows: 8, rising: 7, spikeShare: 0.25, netBuyerRatio: 0.52, retention12: 0.92, top10: 16, top50: 38, devPct: 0.5, top1: 3.1, vol24: 6e5, mcap: 1.8e6, liquidity: 9e4, drawdown: 0.18, chg24: 22, buyShare: 0.54, volPerTrader: 350, organicShare: 0.35, dustShare: 0.30, unboughtShare: 0.2 }, 79.2, 0.83, 0.96, 1.00],
  'same cult at 5h, holders pending': [{ hours: 5, holders: 900, growth24: 25, windows: 0, netBuyerRatio: 0.55, vol24: 3.5e5, mcap: 4e5, liquidity: 4e4, drawdown: 0.10, chg24: 30, buyShare: 0.56, volPerTrader: 300, organicShare: 0.30 }, 55.4, 0.88, 0.63, 1.00],
  'whale parked a bag, 4d': [{ hours: 96, holders: 1500, growth24: 3, windows: 8, rising: 5, spikeShare: 0.3, netBuyerRatio: 0.45, retention12: 0.96, top10: 41, top50: 58, devPct: 0.5, top1: 14, vol24: 1.2e5, mcap: 6e5, liquidity: 5e4, drawdown: 0.25, chg24: 4, buyShare: 0.51, volPerTrader: 400, organicShare: 0.25, dustShare: 0.3, unboughtShare: 0.1 }, 43.2, 0.59, 1.00, 0.73],
  'sybil-farmed holders, 3d': [{ hours: 72, holders: 6000, growth24: 30, windows: 8, rising: 8, spikeShare: 0.15, netBuyerRatio: 0.33, retention12: 0.9, top10: 30, top50: 55, devPct: 1, top1: 6, vol24: 8e4, mcap: 2.5e5, liquidity: 2e4, drawdown: 0.3, chg24: 2, buyShare: 0.5, volPerTrader: 600, organicShare: 0.08, dustShare: 0.85, unboughtShare: 0.9 }, 39.4, 0.74, 1.00, 0.54],
  'slow rug, 9d': [{ hours: 216, holders: 2400, growth24: -4, windows: 8, rising: 2, spikeShare: 0.6, netBuyerRatio: 0.28, retention12: 0.78, top10: 34, top50: 60, devPct: 8, top1: 8, vol24: 4e4, mcap: 1.5e5, liquidity: 1.8e4, drawdown: 0.72, chg24: -9, buyShare: 0.43, volPerTrader: 500, organicShare: 0.2, dustShare: 0.45, unboughtShare: 0 }, 29.1, 0.32, 1.00, 0.91],
  'pump-and-dump, 20h': [{ hours: 20, holders: 1900, growth24: 60, windows: 3, rising: 2, spikeShare: 0.85, netBuyerRatio: 0.35, retention12: 0.55, top10: 42, top50: 71, devPct: 6, top1: 9, vol24: 2.4e6, mcap: 4e5, liquidity: 3e4, drawdown: 0.65, chg24: -40, buyShare: 0.44, volPerTrader: 4000, organicShare: 0.06, dustShare: 0.55, unboughtShare: 0.3 }, 23.5, 0.44, 0.76, 0.70],
  'wash-traded, 30h': [{ hours: 30, holders: 600, growth24: 1, windows: 5, rising: 2, spikeShare: 0.5, netBuyerRatio: 0.31, retention12: 0.9, top10: 38, top50: 74, devPct: 2, top1: 7, vol24: 5e6, mcap: 3e5, liquidity: 2.5e4, drawdown: 0.15, chg24: 8, buyShare: 0.5, volPerTrader: 27000, organicShare: 0.02, dustShare: 0.2, unboughtShare: 0 }, 21.7, 0.47, 0.82, 0.56],
  'rugged, 2d': [{ hours: 48, holders: 1100, growth24: -12, windows: 8, rising: 1, spikeShare: 0.9, netBuyerRatio: 0.2, retention12: 0.5, top10: 25, top50: 50, devPct: 0, top1: 5, vol24: 9e4, mcap: 4e4, liquidity: 6e3, drawdown: 0.85, chg24: -70, buyShare: 0.38, volPerTrader: 300, organicShare: 0.2, dustShare: 0.5, unboughtShare: 0 }, 5.7, 0.25, 0.91, 0.25],
};

for (const [name, [features, score, quality, conf, riskTotal]] of Object.entries(EXAMPLES)) {
  test(`worked example: ${name} scores ${score}`, () => {
    const r = scoreToken({ ...features, minLiquidity: 5000 });
    assert.strictEqual(r.score, score);
    near(r.quality, quality, 0.0051);
    assert.strictEqual(r.confidence, conf);
    assert.strictEqual(r.risk, riskTotal);
  });
}

test('the examples rank in the order the plan shows, and only the 5h token is pending', () => {
  const scored = Object.entries(EXAMPLES).map(([name, [f]]) => ({ name, ...scoreToken({ ...f, minLiquidity: 5000 }) }));
  assert.deepStrictEqual([...scored].sort((a, b) => b.score - a.score).map(s => s.name), Object.keys(EXAMPLES));
  assert.deepStrictEqual(scored.filter(s => s.pending).map(s => s.name), ['same cult at 5h, holders pending']);
  assert.deepStrictEqual(scored.filter(s => s.rugged).map(s => s.name), ['rugged, 2d']);
});

test('weights sum to 1 with holder terms at 80%', () => {
  const total = Object.values(PARAMS.weights).reduce((s, w) => s + w, 0);
  near(total, 1);
  near(PARAMS.holderTerms.reduce((s, k) => s + PARAMS.weights[k], 0), 0.8);
});

test('every term is 0 at its low bound and 1 at its high bound', () => {
  const lo = terms({ growth24: -10, windows: 8, rising: 0, spikeShare: 1, holders: 200, netBuyerRatio: 0.30, retention12: 0.60, top10: 50, top50: 80, devPct: 10, vol24: 1e4, mcap: 1e9, drawdown: 0.8, chg24: -50, buyShare: 0.40 });
  for (const [k, v] of Object.entries(lo)) near(v, 0, 1e-4), assert.ok(k);
  assert.strictEqual(Object.keys(lo).length, 10);
  const hi = terms({ growth24: 25, windows: 8, rising: 8, spikeShare: 0, holders: 5000, netBuyerRatio: 0.60, retention12: 0.95, top10: 15, top50: 35, devPct: 1, vol24: 1e6, mcap: 1e6, drawdown: 0.2, chg24: 50, buyShare: 0.60 });
  for (const v of Object.values(hi)) near(v, 1);
  // Beyond the bounds nothing leaves 0..1
  const wild = terms({ growth24: 9999, windows: 8, rising: 8, spikeShare: -3, holders: 1e9, netBuyerRatio: 5, retention12: 2, top10: -5, top50: -5, devPct: -1, vol24: 1e12, mcap: 1, drawdown: -1, chg24: 1e6, buyShare: 7 });
  for (const v of Object.values(wild)) assert.ok(v >= 0 && v <= 1.0000001, String(v));
});

test('growth: flat holders score 0.3; activity falls again past 300% turnover', () => {
  near(terms({ growth24: 0 }).growth, 0.3);
  near(terms({ growth24: -5 }).growth, 0.15);
  near(terms({ growth24: 12.5 }).growth, 0.65);
  const act = (vol, mcap) => terms({ vol24: vol, mcap }).activity;
  near(act(1e6, 1e6), 1);
  near(act(1e6, 1e5), 0.5);           // 1,000% turnover: the turnover half is gone
  near(act(1e6, 4e6), 0.5 + 0.25);    // 25% turnover: half way up
});

test('missing terms are left out and the rest re-weighted', () => {
  const only = scoreToken({ hours: 72, holders: 5000, netBuyerRatio: 0.6 });
  assert.deepStrictEqual(only.terms, { base: 1, breadth: 1 });
  assert.strictEqual(only.quality, 1);
  assert.strictEqual(only.score, 100);
  assert.strictEqual(only.coverage, 0.15);
  assert.strictEqual(only.pending, true);
  const none = scoreToken({ hours: 10 });
  assert.strictEqual(none.score, null);
  assert.strictEqual(none.quality, null);
  // Dev share needs a top-50 sample to mean anything
  assert.strictEqual('dev' in terms({ devPct: 2 }), false);
  // Without a sample the cheap terms are still mostly holder signals
  const cheap = scoreToken({ hours: 72, growth24: 10, windows: 8, rising: 6, spikeShare: 0.3, holders: 1000, netBuyerRatio: 0.5, vol24: 1e5, mcap: 1e6, drawdown: 0.1, chg24: 5, buyShare: 0.5 });
  assert.strictEqual(cheap.coverage, 0.65);
  assert.strictEqual(cheap.holderShare, 0.69);
});

test('confidence: 0.5 at bonding, 1 from 72 hours', () => {
  near(confidence(0), 0.5);
  near(confidence(72), 1);
  near(confidence(1000), 1);
  near(confidence(-5), 0.5);
  near(confidence(6), 0.6443, 1e-3);
  near(confidence(24), 0.7887, 1e-3);
});

test('risk factors: each stays between its floor and 1 and trips on its own signal', () => {
  const clean = risk({ vol24: 1e5, mcap: 1e6, volPerTrader: 500, organicShare: 0.4, dustShare: 0.2, unboughtShare: 0.1, top1: 3, liquidity: 5e4, minLiquidity: 5000, drawdown: 0.1 });
  assert.deepStrictEqual(clean, { wash: 1, sybil: 1, whale: 1, bundle: 1, rug: 1, total: 1 });
  near(risk({ volPerTrader: 10000 }).wash, 0.6);
  near(risk({ volPerTrader: 6000 }).wash, 0.8);
  near(risk({ vol24: 15e6, mcap: 1e6 }).wash, 0.6);
  near(risk({ organicShare: 0 }).wash, 0.6);
  near(risk({ organicShare: 0.05 }).wash, 0.8);
  near(risk({ dustShare: 0.9 }).sybil, 0.6);
  near(risk({ unboughtShare: 0.7 }).sybil, 0.8);
  near(risk({ top1: 15 }).whale, 0.7);
  near(risk({ top1: 99 }).whale, 0.7);
  near(risk({ equalBags: true }).bundle, 0.8);
  near(risk({ drawdown: 0.8 }).rug, 0.25);
  near(risk({ drawdown: 0.79 }).rug, 1);
  near(risk({ liquidity: 4999, minLiquidity: 5000 }).rug, 0.25);
  near(risk({ liquidity: 4999 }).rug, 1);   // no floor known: not judged
  // Everything at once: the product of the floors
  near(risk({ volPerTrader: 1e9, dustShare: 1, top1: 100, equalBags: true, drawdown: 1 }).total, 0.6 * 0.6 * 0.7 * 0.8 * 0.25);
});

test('holder series: 24h growth, a scaled rate under a day, nothing under 3 hours', () => {
  const now = Date.UTC(2026, 10, 12);
  const pts = (pairs) => pairs.map(([h, holders]) => ({ at: now - h * HOUR, holders }));
  // 30 hours of history: growth against the point at or before 24h ago
  let f = holderSeriesFeatures(pts([[30, 900], [24, 1000], [12, 1050]]), 1100, now);
  near(f.growth24, 10);
  assert.strictEqual(f.growthCount24, 100);
  // 6 hours of history: +5% in 6h is a 20% a day rate
  f = holderSeriesFeatures(pts([[6, 1000]]), 1050, now);
  near(f.growth24, 20, 1e-9);
  assert.strictEqual(f.growthCount24, null);
  // 2 hours: too early
  assert.strictEqual(holderSeriesFeatures(pts([[2, 1000]]), 1500, now).growth24, null);
  assert.strictEqual(holderSeriesFeatures([], 1500, now).growth24, null);
  assert.strictEqual(holderSeriesFeatures(pts([[30, 0], [24, 0]]), 10, now).growth24, null);
});

test('holder series: a staircase is steady, one spike is not', () => {
  const now = Date.UTC(2026, 10, 12);
  const hourly = (fn) => Array.from({ length: 49 }, (_, i) => ({ at: now - (48 - i) * HOUR, holders: Math.round(fn(i)) }));
  const stairs = holderSeriesFeatures(hourly(i => 1000 + 20 * i), null, now);
  assert.strictEqual(stairs.windows, 8);
  assert.strictEqual(stairs.rising, 8);
  near(stairs.spikeShare, 1 / 8, 1e-9);
  const spike = holderSeriesFeatures(hourly(i => (i < 40 ? 1000 : 2000)), null, now);
  assert.strictEqual(spike.windows, 8);
  assert.strictEqual(spike.rising, 1);
  assert.strictEqual(spike.spikeShare, 1);
  const falling = holderSeriesFeatures(hourly(i => 2000 - 10 * i), null, now);
  assert.strictEqual(falling.rising, 0);
  assert.strictEqual(falling.spikeShare, 1);
  // 13 hours of history covers two whole windows: not enough for the term
  const short = holderSeriesFeatures(hourly(i => 1000 + i).slice(-14), null, now);
  assert.strictEqual(short.windows, 2);
  assert.strictEqual(short.rising, null);
  assert.strictEqual('steady' in terms(short), false);
});

test('buildFeatures: market stats, drawdown from the peak, unbought growth, and sample age', () => {
  const now = Date.UTC(2026, 10, 12);
  const token = {
    graduatedAt: now - 30 * HOUR, holders: 1400, mcap: 500000, liquidity: 40000, peakMcap: 1000000,
    market: { stats: { '24h': { buyVolume: 60000, sellVolume: 40000, numTraders: 200, numNetBuyers: 80, buyOrganicVolume: 15000, priceChange: -12 } }, audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true } },
  };
  const points = [{ at: now - 26 * HOUR, holders: 1000 }, { at: now - 12 * HOUR, holders: 1200 }];
  const sample = { takenAt: now - 5 * HOUR, top1: 4, top10: 20, top50: 40, devPct: 1, dustShare: 0.3, retention12: 0.9, equalBags: false };
  const f = buildFeatures(token, points, sample, { now, minLiquidity: 5000 });
  near(f.hours, 30);
  assert.strictEqual(f.vol24, 100000);
  near(f.buyShare, 0.6);
  near(f.netBuyerRatio, 0.4);
  near(f.volPerTrader, 500);
  near(f.organicShare, 0.25);
  near(f.drawdown, 0.5);
  assert.strictEqual(f.chg24, -12);
  near(f.growth24, 40);
  near(f.unboughtShare, 0.8);   // 400 new holders, 80 net buyers
  assert.strictEqual(f.top10, 20);
  assert.strictEqual(scoreToken(f).pending, false);

  // A sample older than 36h no longer counts
  const stale = buildFeatures(token, points, { ...sample, takenAt: now - 37 * HOUR }, { now, minLiquidity: 5000 });
  assert.strictEqual(stale.top10, undefined);
  assert.strictEqual(scoreToken(stale).pending, true);

  // Too few traders to trust a ratio; no market data at all still gives a score from holders
  const thin = buildFeatures({ ...token, market: { stats: { '24h': { numTraders: 5, numNetBuyers: 5, buyVolume: 10, sellVolume: 0 } } } }, points, null, { now, minLiquidity: 5000 });
  assert.strictEqual(thin.netBuyerRatio, undefined);
  assert.strictEqual(thin.volPerTrader, undefined);
  const bare = buildFeatures({ graduatedAt: now - DAY, holders: 500 }, [], null, { now, minLiquidity: 5000 });
  assert.deepStrictEqual(Object.keys(scoreToken(bare).terms), ['base']);
});

test('authoritiesOpen: only an explicit false keeps a token off the list', () => {
  assert.strictEqual(authoritiesOpen({ market: { audit: { mintAuthorityDisabled: false, freezeAuthorityDisabled: true } } }), true);
  assert.strictEqual(authoritiesOpen({ market: { audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: false } } }), true);
  assert.strictEqual(authoritiesOpen({ market: { audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true } } }), false);
  assert.strictEqual(authoritiesOpen({ market: { audit: { mintAuthorityDisabled: null } } }), false);
  assert.strictEqual(authoritiesOpen({}), false);
});
