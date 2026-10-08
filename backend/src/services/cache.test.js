const { test } = require('node:test');
const assert = require('node:assert');

const { CacheService } = require('./cache');

test('Redis retryStrategy never gives up reconnecting (audit #1)', async () => {
  const prev = process.env.REDIS_URL;
  // Unreachable port: we only inspect the client options, never a live connection.
  process.env.REDIS_URL = 'redis://127.0.0.1:1';
  const svc = new CacheService();
  try {
    assert.strictEqual(svc.backendType, 'redis');
    const retry = svc.backend.client.options.retryStrategy;
    for (const times of [1, 20, 21, 100, 10000]) {
      const delay = retry(times);
      assert.strictEqual(typeof delay, 'number', `attempt ${times} must return a delay`);
      assert.ok(delay > 0 && delay <= 30000);
    }
  } finally {
    svc.backend.client.disconnect();
    if (prev === undefined) delete process.env.REDIS_URL; else process.env.REDIS_URL = prev;
  }
});

test('Redis cache marks itself connected again on ready (audit #1)', async () => {
  const prev = process.env.REDIS_URL;
  process.env.REDIS_URL = 'redis://127.0.0.1:1';
  const svc = new CacheService();
  try {
    svc.backend.isConnected = false;
    svc.backend.client.emit('ready');
    assert.strictEqual(svc.backend.isConnected, true);
  } finally {
    svc.backend.client.disconnect();
    if (prev === undefined) delete process.env.REDIS_URL; else process.env.REDIS_URL = prev;
  }
});

test('createByteBudget bounds bytes written per window, then frees them as they age (audit #59)', () => {
  const { createByteBudget } = require('./cache');
  let t = 0;
  const budget = createByteBudget({ limitBytes: 1000, windowMs: 24000, buckets: 24, now: () => t });
  assert.strictEqual(budget.tryConsume(600), true);
  t = 5000;
  assert.strictEqual(budget.tryConsume(300), true);
  assert.strictEqual(budget.tryConsume(200), false, 'would exceed the limit');
  assert.strictEqual(budget.tryConsume(100), true, 'exactly at the limit is allowed');
  assert.strictEqual(budget.used(), 1000);
  t = 24000; // the first write's slice has aged out
  assert.strictEqual(budget.used(), 400);
  assert.strictEqual(budget.tryConsume(600), true);
  assert.strictEqual(budget.tryConsume(1), false);
  t = 29000; // everything from t=5000 has aged out
  assert.strictEqual(budget.used(), 600);
});
