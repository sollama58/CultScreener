/**
 * The queued rate limiter runs up to maxConcurrent requests at once. Before, the
 * Helius queue awaited each request before starting the next, so one slow page of
 * full transactions held every other Helius call in the process behind it.
 */
const { test, after } = require('node:test');
const assert = require('node:assert');
const limiter = require('./rateLimiter');

after(() => limiter.stopCleanup());

const sleep = ms => new Promise(r => setTimeout(r, ms));

function track() {
  const t = { now: 0, max: 0 };
  t.run = async (ms, value) => {
    t.now++;
    t.max = Math.max(t.max, t.now);
    await sleep(ms);
    t.now--;
    return value;
  };
  return t;
}

test('the Helius queue allows several requests in flight', () => {
  assert.ok(limiter.RATE_LIMITS.helius.maxConcurrent > 1);
});

test('a queue with maxConcurrent runs that many at once and returns each result', async () => {
  limiter.RATE_LIMITS.testConcurrent = {
    minInterval: 0, maxJitter: 0, burstLimit: 100, burstWindow: 1000,
    useQueue: true, maxConcurrent: 4, maxQueueSize: 100, queueTimeout: 5000,
  };
  const t = track();
  const started = Date.now();
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) =>
    limiter.rateLimitedRequest('testConcurrent', () => t.run(100, i))));
  const elapsed = Date.now() - started;
  assert.deepStrictEqual(results, [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.strictEqual(t.max, 4, 'never more than maxConcurrent in flight');
  assert.ok(elapsed < 500, `8 x 100ms with 4 at a time took ${elapsed}ms`);
  assert.strictEqual(limiter.getStatus('testConcurrent').inFlight, 0);
});

test('a queue without maxConcurrent stays one at a time, and errors reach their caller', async () => {
  limiter.RATE_LIMITS.testSerial = {
    minInterval: 0, maxJitter: 0, burstLimit: 100, burstWindow: 1000,
    useQueue: true, maxQueueSize: 100, queueTimeout: 5000,
  };
  const t = track();
  const ok = limiter.rateLimitedRequest('testSerial', () => t.run(30, 'a'));
  const bad = limiter.rateLimitedRequest('testSerial', async () => { await t.run(30); throw new Error('boom'); });
  const ok2 = limiter.rateLimitedRequest('testSerial', () => t.run(30, 'c'));
  assert.strictEqual(await ok, 'a');
  await assert.rejects(bad, /boom/);
  assert.strictEqual(await ok2, 'c');
  assert.strictEqual(t.max, 1);
});

test('GeckoTerminal free tier pacing stays within the requested requests per minute', () => {
  for (const rpm of [30, 20, 10]) {
    const c = limiter.geckoFreeTierLimits(rpm);
    assert.ok(60000 / c.minInterval <= rpm, `minInterval ${c.minInterval} at ${rpm}/min`);
    assert.ok(c.burstLimit * (60000 / c.burstWindow) <= rpm, `burst ${c.burstLimit} at ${rpm}/min`);
  }
  assert.strictEqual(limiter.geckoFreeTierLimits(30).minInterval, 2100);
});

// audit #116: callers arriving together used to all read the same stale state and fire at once
test('non-queued limits hold for concurrent callers: spacing and burst cap', async () => {
  limiter.RATE_LIMITS.testUnqueued = { minInterval: 40, maxJitter: 0, burstLimit: 3, burstWindow: 1000 };
  try {
    const starts = [];
    const t0 = Date.now();
    await Promise.all(Array.from({ length: 5 }, () =>
      limiter.rateLimitedRequest('testUnqueued', async () => { starts.push(Date.now() - t0); })));
    starts.sort((a, b) => a - b);
    for (let i = 1; i < 3; i++) assert.ok(starts[i] - starts[i - 1] >= 35, `spaced: ${starts}`);
    // Only 3 in any one 1s window: the 4th waits for the next window
    const firstWindow = Math.floor(t0 / 1000);
    const inFirst = starts.filter(s => Math.floor((t0 + s) / 1000) === firstWindow).length;
    assert.ok(inFirst <= 3, `burst capped: ${starts}`);
  } finally {
    delete limiter.RATE_LIMITS.testUnqueued;
  }
});

test('coingeckoPublic has limits of its own', () => {
  assert.ok(limiter.RATE_LIMITS.coingeckoPublic);
  assert.ok(limiter.RATE_LIMITS.coingeckoPublic.minInterval >= 1000);
});
