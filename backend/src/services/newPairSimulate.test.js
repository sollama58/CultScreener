/**
 * The simulation script runs the real scoring code; this keeps it runnable and pins
 * the property the starting weights were chosen for: mock cults, 6% of tokens, take
 * most of the top 20, and the gaming archetypes stay out.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { run, NAMES } = require('../../scripts/newpairs/simulate');

test('simulation is deterministic per seed and ranks cults over the gaming archetypes', () => {
  const a = run(42, 600);
  assert.deepStrictEqual(run(42, 600), a);
  const total = NAMES.reduce((s, n) => s + a.top20[n], 0);
  assert.ok(Math.abs(total - 1) < 1e-9);
  assert.ok(a.top20.cult > 0.8, `cult share of the top 20 was ${a.top20.cult}`);
  assert.ok(a.top20.wash + a.top20.slowRug < 0.05);
  assert.ok(a.cultShortlisted > 0.5);
  assert.ok(a.churn >= 0 && a.churn < 0.5);
});
