/**
 * HELIUS_RPS sets both the spacing and the per-second cap of the helius limiter
 * (audit #49). Own file so the env var is read fresh when the module loads.
 */
const { test, after } = require('node:test');
const assert = require('node:assert');

process.env.HELIUS_RPS = '40';
const limiter = require('./rateLimiter');
after(() => limiter.stopCleanup());

test('the helius burst cap follows HELIUS_RPS instead of a fixed 20 (audit #49)', () => {
  const h = limiter.RATE_LIMITS.helius;
  assert.strictEqual(h.minInterval, 25);
  assert.strictEqual(h.burstLimit, 40);
  assert.ok(h.burstLimit * h.minInterval <= h.burstWindow, 'the burst cap must not bind below the configured rate');
});
