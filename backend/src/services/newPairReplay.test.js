/**
 * New Pairs replay: which marks are due, what a mark stores, and the replay itself on
 * a made-up history where the outcome is known.
 */
const { test } = require('node:test');
const assert = require('node:assert');

const { PARAMS, HOUR, DAY, scoreToken } = require('./newPairScore');
const R = require('./newPairReplay');

test('dueMarks: a mark is due from its day until 12 hours after, once', () => {
  assert.deepStrictEqual(R.dueMarks(23 * HOUR), []);
  assert.deepStrictEqual(R.dueMarks(DAY), [1]);
  assert.deepStrictEqual(R.dueMarks(DAY + 11 * HOUR), [1]);
  assert.deepStrictEqual(R.dueMarks(DAY + 12 * HOUR), [], 'first scored too late: no mark from late data');
  assert.deepStrictEqual(R.dueMarks(DAY + HOUR, { 1: { at: 1 } }), []);
  assert.deepStrictEqual(R.dueMarks(3 * DAY + HOUR, { 1: { at: 1 } }), [3]);
  assert.deepStrictEqual(R.dueMarks(7 * DAY, null), [7]);
  assert.deepStrictEqual(R.dueMarks(14 * DAY + HOUR, {}), [14]);
  assert.deepStrictEqual(R.dueMarks(20 * DAY), []);
});

test('compactFeatures: numbers to 4 significant digits, true flags kept, null and false dropped', () => {
  assert.deepStrictEqual(
    R.compactFeatures({ hours: 24.123456, holders: 1500, growth24: null, equalBags: false, drawdown: 0, top10: 17.98765, vol24: 123456.7, bad: NaN, name: 'x' }),
    { hours: 24.12, holders: 1500, drawdown: 0, top10: 17.99, vol24: 123500 });
  assert.deepStrictEqual(R.compactFeatures({ equalBags: true }), { equalBags: true });
  assert.deepStrictEqual(R.compactFeatures(null), {});
});

test('a stored mark re-scores to the score it was stored with', () => {
  const f = { hours: 60, holders: 3200, growth24: 14, windows: 8, rising: 7, spikeShare: 0.25, netBuyerRatio: 0.52, retention12: 0.92, top10: 16, top50: 38, devPct: 0.5, top1: 3.1,
    vol24: 6e5, mcap: 1.8e6, liquidity: 9e4, minLiquidity: 5000, drawdown: 0.18, chg24: 22, buyShare: 0.54, volPerTrader: 350, organicShare: 0.35, dustShare: 0.30, unboughtShare: 0.2, equalBags: false };
  const live = scoreToken(f);
  const mark = R.buildMark({ at: 5, ageMs: 60 * HOUR, score: live.score, rugged: live.rugged, features: f, holders: 3200, mcap: 1.8e6, liquidity: 9e4 });
  assert.deepStrictEqual({ ...mark, f: null }, { at: 5, ageH: 60, score: 79.2, rugged: false, holders: 3200, mcap: 1.8e6, liquidity: 9e4, f: null });
  assert.strictEqual(scoreToken(mark.f).score, live.score);
  assert.ok(JSON.stringify(mark).length < 600, 'four marks stay small on the token row');
});

test('succeeded: not rugged at the later mark and more holders than at the earlier one', () => {
  assert.strictEqual(R.succeeded({ holders: 100 }, { holders: 101, rugged: false }), true);
  assert.strictEqual(R.succeeded({ holders: 100 }, { holders: 100, rugged: false }), false);
  assert.strictEqual(R.succeeded({ holders: 100 }, { holders: 500, rugged: true }), false);
  assert.strictEqual(R.succeeded({ holders: null }, { holders: 500, rugged: false }), false);
});

test('paramSets: the current weights, each weight up and down, holder terms only, no risk; PARAMS untouched', () => {
  const before = JSON.stringify(PARAMS);
  const sets = R.paramSets();
  assert.strictEqual(sets.length, 1 + 2 * Object.keys(PARAMS.weights).length + 2);
  assert.strictEqual(sets[0].params, PARAMS);
  const up = sets.find(s => s.label === 'retention +50%');
  assert.ok(Math.abs(up.params.weights.retention - PARAMS.weights.retention * 1.5) < 1e-12);
  const holders = sets.find(s => s.label === 'holder terms only').params.weights;
  assert.strictEqual(holders.activity, 0);
  assert.strictEqual(holders.growth, PARAMS.weights.growth);
  assert.strictEqual(JSON.stringify(PARAMS), before);
});

// 2 bonding weeks of 10 tokens. In each, the 3 tokens with strong day-1 holder growth
// go on to gain holders; the rest lose them or rug. The good ones sort last by mint, so a
// weight set that cannot tell tokens apart (ties broken by mint) picks none of them.
const WEEK = 7 * DAY;
function history() {
  const rows = [];
  for (let week = 0; week < 2; week++) {
    for (let i = 0; i < 10; i++) {
      const good = i >= 7;
      const f = { hours: 24, holders: 1000, growth24: good ? 40 - i : -5 - i, netBuyerRatio: good ? 0.5 : 0.3, vol24: 1e5, mcap: 5e5, liquidity: 5e4, minLiquidity: 5000, drawdown: 0.2, chg24: 0, buyShare: 0.5 };
      const day1 = R.buildMark({ at: 0, ageMs: DAY, score: scoreToken(f).score, rugged: false, features: f, holders: 1000, mcap: 5e5, liquidity: 5e4 });
      const day7 = { at: 0, ageH: 168, score: 1, rugged: !good && i === 0, holders: good ? 2000 : 800, mcap: 1, liquidity: 1, f: {} };
      rows.push({ mint: `w${week}t${i}`, graduatedAt: 2900 * WEEK + week * WEEK + i * HOUR, marks: { 1: day1, 7: day7 } });
    }
  }
  // Has a day-1 mark only: counted as a token, not as eligible
  rows.push({ mint: 'young', graduatedAt: 2902 * WEEK, marks: { 1: rows[0].marks[1] } });
  return rows;
}

test('replay: top picks per bonding week against the base rate, per weight set', () => {
  const sets = R.paramSets().filter(s => ['current weights', 'no risk factors'].includes(s.label));
  const r = R.replay(history(), { sets, topN: 3 });
  assert.strictEqual(r.tokens, 21);
  assert.strictEqual(r.topN, 3);
  assert.deepStrictEqual(r.pairs.map(p => [p.entryDay, p.outcomeDay, p.eligible]), [[1, 7, 20], [1, 14, 0], [3, 7, 0], [3, 14, 0]]);
  const p = r.pairs[0];
  assert.strictEqual(p.weeks, 2);
  assert.ok(Math.abs(p.baseRate - 0.3) < 1e-12);
  assert.deepStrictEqual({ ...p.sets[0] }, { label: 'current weights', picked: 6, hits: 6, rate: 1, lift: 1 / 0.3 });
  // Nothing eligible: nulls, not a division by zero
  assert.deepStrictEqual({ ...r.pairs[1].sets[0] }, { label: 'current weights', picked: 0, hits: 0, rate: null, lift: null });
  assert.strictEqual(r.pairs[1].baseRate, null);
});

test('replay: a weight set that ignores what predicts does no better than the base rate', () => {
  const blind = JSON.parse(JSON.stringify(PARAMS));
  for (const k of Object.keys(blind.weights)) blind.weights[k] = k === 'activity' ? 1 : 0;   // identical for every token
  const p = R.replay(history(), { sets: [{ label: 'activity only', params: blind }], topN: 3 }).pairs[0];
  assert.strictEqual(p.sets[0].picked, 6);
  assert.strictEqual(p.sets[0].rate, 0);
});

test('termTable: the top fifth by each term at day 1, judged at day 7', () => {
  const terms = R.termTable(history());
  assert.deepStrictEqual(terms.map(t => t.term), Object.keys(PARAMS.weights));
  const growth = terms.find(t => t.term === 'growth');
  assert.strictEqual(growth.withData, 20);
  assert.strictEqual(growth.topRate, 1);
  assert.ok(Math.abs(growth.lift - 1 / 0.3) < 1e-9);
  const retention = terms.find(t => t.term === 'retention');   // no top-50 sample in this history
  assert.deepStrictEqual({ ...retention }, { term: 'retention', withData: 0, baseRate: null, topRate: null, lift: null });
});
