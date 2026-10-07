const { test, describe } = require('node:test');
const assert = require('node:assert');
const { dustThresholdRaw, countHolders, buildHolderSeries, _test } = require('./holderCounts');

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 7, 12);

describe('dustThresholdRaw', () => {
  test('uses the price when there is one', () => {
    // $1 at $0.001 per token = 1000 tokens = 1000 * 10^6 raw
    assert.strictEqual(dustThresholdRaw({ priceUsd: 0.001, decimals: 6, supplyRaw: '1', dustUsd: 1 }), 1_000_000_000n);
  });

  test('falls back to a millionth of supply', () => {
    assert.strictEqual(dustThresholdRaw({ priceUsd: null, decimals: 6, supplyRaw: '1000000000000000' }), 1_000_000_000n);
    assert.strictEqual(dustThresholdRaw({ priceUsd: 0, decimals: 6, supplyRaw: '10' }), 1n);
  });

  test('null when nothing to go on or dust is off', () => {
    assert.strictEqual(dustThresholdRaw({}), null);
    assert.strictEqual(dustThresholdRaw({ priceUsd: 1, decimals: 6, dustUsd: 0 }), null);
  });
});

describe('countHolders', () => {
  const holders = [
    { wallet: 'whale', amount: 5000n },
    { wallet: 'burn', amount: 4000n },
    { wallet: 'lp', amount: 3000n },
    { wallet: 'a', amount: 100n },
    { wallet: 'dust1', amount: 9n },
    { wallet: 'dust2', amount: '1' },
    { wallet: 'zero', amount: 0n },
  ];

  test('counts wallets with a balance, excluding burn/LP, and flags dust', () => {
    const r = countHolders(holders, { exclude: new Set(['burn', 'lp']), dustRaw: 10n });
    assert.deepStrictEqual(r, { holders: 4, dust: 2 });
  });

  test('dust is null when there is no threshold', () => {
    assert.deepStrictEqual(countHolders(holders), { holders: 6, dust: null });
  });
});

describe('buildHolderSeries', () => {
  // Legacy daily rows for 10 days, then 4-hourly snapshot points for 3 days.
  function rows() {
    const out = [];
    for (let d = 13; d >= 4; d--) {
      out.push({ taken_at: new Date(NOW - d * DAY), legacy_count: 1000 + (13 - d) * 10, source: 'daily' });
    }
    for (let h = 72; h >= 0; h -= 4) {
      const holders = 950 + (72 - h);
      out.push({ taken_at: new Date(NOW - h * HOUR), holders, dust: 50, legacy_count: holders + 50, complete: true, source: 'snapshot' });
    }
    return out;
  }

  test('current is the latest measured point', () => {
    const r = buildHolderSeries(rows(), { range: 'all', now: NOW });
    assert.strictEqual(r.current.holders, 1022);
    assert.strictEqual(r.current.real, 972);
    assert.strictEqual(r.current.at, Math.floor(NOW / 1000));
  });

  test('legacy rows become an estimate scaled at the first real point, before it only', () => {
    const r = buildHolderSeries(rows(), { range: 'all', now: NOW });
    const { actual, est } = r.series.holders;
    assert.strictEqual(est.length, 10);
    assert.ok(est[est.length - 1][0] < actual[0][0]);
    // first real point: 950 holders, 1000 legacy → ratio 0.95
    assert.strictEqual(est[0][1], Math.round(1000 * 0.95));
    // the real-holders metric scales by its own ratio (900 / 1000)
    assert.strictEqual(r.series.real.est[0][1], 900);
  });

  test('24h change uses measured points; 7d falls back to the estimate and says so', () => {
    const r = buildHolderSeries(rows(), { range: 'all', now: NOW });
    const c = r.series.holders.changes;
    assert.strictEqual(c['24h'].delta, 24);
    assert.strictEqual(c['24h'].approx, false);
    assert.strictEqual(c['7d'].approx, true);
    // 7 days before NOW: the legacy row at NOW-7d (1060) * 0.95 = 1007
    assert.strictEqual(c['7d'].delta, 1022 - 1007);
    assert.strictEqual(c['30d'], null);
  });

  test('a baseline far before the window target is not used', () => {
    const r = buildHolderSeries([
      { taken_at: new Date(NOW - 5 * DAY), holders: 100, complete: true },
      { taken_at: new Date(NOW), holders: 200, complete: true },
    ], { range: 'all', now: NOW });
    assert.strictEqual(r.series.holders.changes['24h'], null);
  });

  test('range filters the chart but not the changes', () => {
    const r = buildHolderSeries(rows(), { range: '24h', now: NOW });
    assert.ok(r.series.holders.actual.every(p => p[0] >= Math.floor((NOW - DAY) / 1000)));
    assert.strictEqual(r.series.holders.est.length, 0);
    assert.ok(r.series.holders.changes['7d']);
  });

  test('capped snapshots are marked as lower bounds', () => {
    const r = buildHolderSeries([{ taken_at: new Date(NOW), holders: 250000, complete: false }], { range: '7d', now: NOW });
    assert.deepStrictEqual(r.series.holders.actual, [[Math.floor(NOW / 1000), 250000, 0]]);
    assert.strictEqual(r.current.complete, false);
  });

  test('only legacy rows: the chart shows them as they are', () => {
    const r = buildHolderSeries([{ taken_at: new Date(NOW - DAY), legacy_count: 500 }], { range: '7d', now: NOW });
    assert.strictEqual(r.current, null);
    assert.deepStrictEqual(r.series.holders.est, [[Math.floor((NOW - DAY) / 1000), 500]]);
    assert.deepStrictEqual(r.series.real.est, []);
  });

  test('unknown range falls back to 30d', () => {
    assert.strictEqual(buildHolderSeries([], { range: 'nope', now: NOW }).range, '30d');
  });
});

describe('downsample', () => {
  test('keeps at most max points and always the last one', () => {
    const list = Array.from({ length: 2000 }, (_, i) => ({ t: i * 1000, v: i }));
    const out = _test.downsample(list, 100);
    assert.ok(out.length <= 100);
    assert.strictEqual(out[out.length - 1].v, 1999);
  });
});

describe('holderVelocity', () => {
  const { holderVelocity } = require('./holderCounts');
  const at = (holders, baseHolders, spanH = 24, ageH = 1) => holderVelocity({
    holders, baseHolders, takenAt: NOW - ageH * HOUR, baseAt: NOW - (ageH + spanH) * HOUR,
  }, NOW);

  test('levels by 24h percent change', () => {
    assert.strictEqual(at(1030, 1000).level, 2);
    assert.strictEqual(at(1010, 1000).level, 1);
    assert.strictEqual(at(1001, 1000).level, 0);
    assert.strictEqual(at(990, 1000).level, -1);
    assert.strictEqual(at(970, 1000).level, -2);
  });

  test('a couple of wallets on a tiny token is flat', () => {
    assert.strictEqual(at(102, 100).level, 0);
    assert.strictEqual(at(104, 100).level, 2);
  });

  test('reports delta, pct and span', () => {
    assert.deepStrictEqual(at(1010, 1000, 26), { level: 1, delta: 10, pct: 1, hours: 26 });
  });

  test('null without enough history', () => {
    assert.strictEqual(holderVelocity({ holders: 1000, takenAt: NOW }, NOW).level, null);
    // baseline too far before the 24h mark
    assert.strictEqual(at(1100, 1000, 40).level, null);
    // latest snapshot too old to describe now
    assert.strictEqual(at(1100, 1000, 24, 48).level, null);
    assert.strictEqual(holderVelocity(null, NOW).level, null);
  });
});
