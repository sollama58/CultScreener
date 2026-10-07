const { test, describe } = require('node:test');
const assert = require('node:assert');
const { DAY, PARAMS, holdIndex, scoreToken, pickKing } = require('./kotpScore');

const full = { '6h': 97, '24h': 94, '3d': 88, '1w': 80, '1m': 62, '3m': 40, '6m': 25, '9m': 15, '1yr': 8 };
const young = { '6h': 98, '24h': 95, '3d': 85, '1w': 70, '1m': 0, '3m': 0, '6m': 0, '9m': 0, '1yr': 0 };
const base = { distribution: full, supplyDistribution: full, ageMs: 400 * DAY, holders: 5000, snapshotAgeMs: 3_600_000, coreWeekAgo: null, holdersMonthAgo: null };

describe('holdIndex', () => {
  test('only counts buckets the token is old enough to reach', () => {
    // 20 days old: 6h, 24h, 3d, 1w count (1w + 3d margin = 10d ≤ 20d); 1m does not
    const idx = holdIndex(young, 20 * DAY);
    const w = PARAMS.bucketWeight;
    const buckets = [['6h', 98], ['24h', 95], ['3d', 85], ['1w', 70]];
    const keyed = { '6h': 6 * 3_600_000, '24h': 24 * 3_600_000, '3d': 3 * DAY, '1w': 7 * DAY };
    const expected = buckets.reduce((s, [k, v]) => s + w({ ms: keyed[k] }) * v / 100, 0) / buckets.reduce((s, [k]) => s + w({ ms: keyed[k] }), 0);
    assert.ok(Math.abs(idx - expected) < 1e-9);
  });
  test('all-100 distribution scores 1, all-0 scores 0, no data scores null', () => {
    const all100 = Object.fromEntries(Object.keys(full).map(k => [k, 100]));
    const all0 = Object.fromEntries(Object.keys(full).map(k => [k, 0]));
    assert.strictEqual(holdIndex(all100, 400 * DAY), 1);
    assert.strictEqual(holdIndex(all0, 400 * DAY), 0);
    assert.strictEqual(holdIndex(null, 400 * DAY), null);
    assert.strictEqual(holdIndex(full, 2 * DAY), null); // nothing achievable yet
  });
  test('longer buckets weigh more', () => {
    const a = { ...full, '1yr': 20 };
    const b = { ...full, '6h': 100 };
    assert.ok(holdIndex(a, 400 * DAY) - holdIndex(full, 400 * DAY) > holdIndex(b, 400 * DAY) - holdIndex(full, 400 * DAY));
  });
});

describe('scoreToken', () => {
  test('eligibility gates', () => {
    assert.strictEqual(scoreToken({ ...base, ageMs: 5 * DAY }).reason, 'too_young');
    assert.strictEqual(scoreToken({ ...base, holders: 50 }).reason, 'too_few_holders');
    assert.strictEqual(scoreToken({ ...base, snapshotAgeMs: 3 * DAY }).reason, 'stale_snapshot');
    assert.strictEqual(scoreToken({ ...base, distribution: null }).reason, 'no_distribution');
    assert.strictEqual(scoreToken(base).eligible, true);
  });
  test('score is 100 × core with no history and a mature token', () => {
    const r = scoreToken(base);
    assert.strictEqual(r.confidence, 1);
    assert.strictEqual(r.momentum, 0);
    assert.strictEqual(r.retention, 0);
    assert.ok(Math.abs(r.score - 100 * r.core) < 0.02);
  });
  test('headcount outweighs supply', () => {
    const headStrong = scoreToken({ ...base, distribution: { ...full, '3m': 60 }, supplyDistribution: full });
    const supplyStrong = scoreToken({ ...base, distribution: full, supplyDistribution: { ...full, '3m': 60 } });
    assert.ok(headStrong.score > supplyStrong.score);
  });
  test('young tokens are discounted by the confidence ramp', () => {
    const r20 = scoreToken({ ...base, distribution: young, supplyDistribution: young, ageMs: 20 * DAY });
    const r90 = scoreToken({ ...base, distribution: young, supplyDistribution: young, ageMs: 90 * DAY });
    assert.ok(Math.abs(r20.confidence - Math.sqrt(20 / 90)) < 1e-9);
    assert.strictEqual(r90.confidence, 1);
    assert.ok(r20.score < r90.score);
  });
  test('momentum and retention move the score and saturate', () => {
    const r = scoreToken(base);
    const up = scoreToken({ ...base, coreWeekAgo: r.core - 0.5 });
    const down = scoreToken({ ...base, coreWeekAgo: r.core + 0.5 });
    assert.strictEqual(up.momentum, 1);
    assert.strictEqual(down.momentum, -1);
    assert.ok(Math.abs(up.score - r.score * 1.1) < 0.02);
    assert.ok(Math.abs(down.score - r.score * 0.9) < 0.02);
    const grow = scoreToken({ ...base, holdersMonthAgo: 1000 });
    const shrink = scoreToken({ ...base, holdersMonthAgo: 50000 });
    assert.ok(Math.abs(grow.score - r.score * 1.05) < 0.02);
    assert.ok(Math.abs(shrink.score - r.score * 0.75) < 0.02);
  });
});

describe('pickKing', () => {
  const scored = [{ mint: 'A', score: 80 }, { mint: 'B', score: 75 }, { mint: 'C', score: 70 }];
  test('first king is the top score', () => {
    const p = pickKing(scored, null, {}, 100);
    assert.deepStrictEqual([p.mint, p.changed, p.reason], ['A', true, 'first_king']);
  });
  test('nobody is dethroned inside the minimum reign', () => {
    const p = pickKing([{ mint: 'A', score: 10 }, { mint: 'B', score: 90 }], { mint: 'A', crownedOn: 100 }, {}, 102);
    assert.deepStrictEqual([p.mint, p.changed, p.reason], ['A', false, 'min_reign']);
  });
  test('after the minimum reign the king fades and must be beaten by the margin', () => {
    // day 3: A counts 80 × 0.94 = 75.2, plus margin 2 → B at 75 defends nothing
    let p = pickKing(scored, { mint: 'A', crownedOn: 100 }, {}, 103);
    assert.deepStrictEqual([p.mint, p.reason], ['A', 'defended']);
    // B at 77.3 beats 77.2
    p = pickKing([{ mint: 'A', score: 80 }, { mint: 'B', score: 77.3 }], { mint: 'A', crownedOn: 100 }, {}, 103);
    assert.deepStrictEqual([p.mint, p.changed, p.reason], ['B', true, 'overtaken']);
    // day 5: A counts 80 × 0.82 = 65.6 + 2 → C at 70 takes it when B is cooling down
    p = pickKing(scored, { mint: 'A', crownedOn: 100 }, { B: 100 }, 105);
    assert.deepStrictEqual([p.mint, p.reason], ['C', 'overtaken']);
  });
  test('the crown moves at the maximum reign regardless', () => {
    const p = pickKing([{ mint: 'A', score: 99 }, { mint: 'B', score: 10 }], { mint: 'A', crownedOn: 100 }, {}, 107);
    assert.deepStrictEqual([p.mint, p.changed, p.reason], ['B', true, 'max_reign']);
  });
  test('cooldown keeps ex-kings out and the repeat penalty ranks challengers', () => {
    // B ended a reign 5 days ago: in cooldown, so C is the challenger
    let p = pickKing(scored, { mint: 'A', crownedOn: 100 }, { B: 102 }, 107);
    assert.strictEqual(p.mint, 'C');
    // B's reign ended 20 days ago (out of cooldown) but costs 4%: 75 × 0.96 = 72 > 70, still B
    p = pickKing(scored, { mint: 'A', crownedOn: 100 }, { B: 87 }, 107, PARAMS, { B: [87] });
    assert.strictEqual(p.mint, 'B');
    // two recent reigns: 75 × 0.92 = 69 < 70, so C
    p = pickKing(scored, { mint: 'A', crownedOn: 100 }, { B: 87 }, 107, PARAMS, { B: [60, 87] });
    assert.strictEqual(p.mint, 'C');
  });
  test('a king that drops out of eligibility is replaced at once', () => {
    const p = pickKing([{ mint: 'B', score: 75 }], { mint: 'A', crownedOn: 106 }, {}, 107);
    assert.deepStrictEqual([p.mint, p.changed, p.reason], ['B', true, 'king_ineligible']);
    const none = pickKing([], { mint: 'A', crownedOn: 106 }, {}, 107);
    assert.deepStrictEqual([none.mint, none.changed], ['A', false]);
  });
  test('accepts Date values for days', () => {
    const d = n => new Date(n * DAY);
    const p = pickKing(scored, { mint: 'A', crownedOn: d(100) }, { B: d(102) }, d(107));
    assert.strictEqual(p.mint, 'C');
  });
});
