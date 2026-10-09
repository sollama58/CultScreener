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

test('createByteBudget.record counts bytes even past the limit; exhausted() reports it', () => {
  const { createByteBudget } = require('./cache');
  let t = 0;
  const budget = createByteBudget({ limitBytes: 1000, windowMs: 24000, buckets: 24, now: () => t });
  budget.record(900);
  assert.strictEqual(budget.exhausted(), false);
  budget.record(300);
  assert.strictEqual(budget.used(), 1200);
  assert.strictEqual(budget.exhausted(), true);
  t = 24000;
  assert.strictEqual(budget.exhausted(), false);
});

test('createKeyedByteBudget gives each key its own allowance and bounds how many it keeps (audit #8)', () => {
  const { createKeyedByteBudget } = require('./cache');
  let t = 0;
  const budgets = createKeyedByteBudget({ limitBytes: 1000, windowMs: 24000, buckets: 24, maxKeys: 2, now: () => t });
  budgets.forKey('a').record(1200);
  assert.strictEqual(budgets.forKey('a').exhausted(), true);
  assert.strictEqual(budgets.forKey('b').exhausted(), false, 'one key spending its budget leaves the others theirs');
  budgets.forKey('a'); // a is now the most recently used
  budgets.forKey('c'); // over maxKeys: b, the least recently used, is dropped
  assert.strictEqual(budgets.size(), 2);
  assert.strictEqual(budgets.forKey('a').exhausted(), true, 'the recently used key keeps its count');
  t = 24000;
  assert.strictEqual(budgets.forKey('a').exhausted(), false);
});

test('createSharedByteBudget keeps its count in the store, so a restarted process sees it (audit #65)', async () => {
  const { createSharedByteBudget } = require('./cache');
  // A minimal store with the two calls the budget makes
  const data = new Map();
  const store = {
    async mget(keys) { return keys.map(k => data.get(k)); },
    async incrBy(k, by) { data.set(k, (data.get(k) || 0) + by); return data.get(k); }
  };
  let t = 0;
  const opts = { store, prefix: 'budget', limitBytes: 1000, windowMs: 24000, buckets: 24, now: () => t };
  const first = createSharedByteBudget(opts);
  assert.strictEqual(await first.tryConsume(800), true);

  // A new process (deploy/restart) shares the same count instead of starting from zero
  const second = createSharedByteBudget(opts);
  assert.strictEqual(await second.tryConsume(300), false);
  assert.strictEqual(await second.tryConsume(200), true);
  assert.strictEqual(await first.used(), 1000);

  // The store restarted empty: the budget is free again along with the entries it counted
  data.clear();
  assert.strictEqual(await first.tryConsume(900), true);

  // Slices age out after the window
  t = 24000 + 1000;
  assert.strictEqual(await first.used(), 0);

  // A store that cannot answer refuses (the guarded write would not land either)
  const down = createSharedByteBudget({ ...opts, store: { mget: async (k) => k.map(() => undefined), incrBy: async () => null } });
  assert.strictEqual(await down.tryConsume(1), false);
});
