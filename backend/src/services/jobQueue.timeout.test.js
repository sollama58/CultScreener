/**
 * While Redis is unreachable a BullMQ add never settles on its own (audit #30). The
 * producer must give up quickly and return null so callers' in-process fallbacks run.
 * bullmq is replaced with an in-process stub so nothing touches a real Redis.
 */
const { test } = require('node:test');
const assert = require('node:assert');

process.env.REDIS_URL = 'redis://stub.invalid:6379';
process.env.QUEUE_ADD_TIMEOUT_MS = '50';
process.env.VIEW_FLUSH_INTERVAL_MS = '60000';

const created = [];
let addImpl = () => new Promise(() => {}); // Redis down: never settles
class FakeQueue {
  constructor(name, opts) { this.name = name; this.opts = opts; created.push(this); }
  add(name, data, opts) { return addImpl(this.name, name, data, opts); }
  async close() {}
}
const bullmqPath = require.resolve('bullmq');
require.cache[bullmqPath] = { id: bullmqPath, filename: bullmqPath, loaded: true, exports: { Queue: FakeQueue } };

const jobQueue = require('./jobQueue');

test('producer queues fail fast instead of parking commands in the offline queue', () => {
  assert.strictEqual(jobQueue.initialize(), true);
  assert.ok(created.length > 0);
  for (const q of created) assert.strictEqual(q.opts.connection.enableOfflineQueue, false);
});

test('an add that never settles returns null after the timeout, for every queue', async () => {
  const started = Date.now();
  const results = await Promise.all([
    jobQueue.addAnalyticsJob('compute-holder-analytics', { mint: 'M' }),
    jobQueue.addSearchJob('compute-similar-tokens', { mint: 'M' }),
    jobQueue.addMaintenanceJob('cleanup-sessions'),
  ]);
  assert.deepStrictEqual(results, [null, null, null]);
  assert.ok(Date.now() - started < 1000, `took ${Date.now() - started}ms`);
});

test('a rejected add returns null and a late rejection is not left unhandled', async () => {
  const unhandled = [];
  const onUnhandled = (r) => unhandled.push(r);
  process.on('unhandledRejection', onUnhandled);
  try {
    addImpl = () => new Promise((_, reject) => setTimeout(() => reject(new Error('late')), 100));
    assert.strictEqual(await jobQueue.addAnalyticsJob('x'), null);
    await new Promise(r => setTimeout(r, 150));
    assert.deepStrictEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('views being queued still count in the displayed total until the flush settles (audit #179)', async () => {
  let release;
  addImpl = (queue, name, data, opts) => new Promise(r => { release = () => r({ id: opts.jobId, data }); });
  process.env.QUEUE_ADD_TIMEOUT_MS = '50';
  await jobQueue.incrementViewCount('MintV');
  await jobQueue.incrementViewCount('MintV');
  const flushing = jobQueue.flushViewCounts();
  await new Promise(r => setImmediate(r));
  assert.deepStrictEqual(jobQueue.getBufferedViewCounts(['MintV']), { MintV: 2 }, 'not dropped while queueing');
  await jobQueue.incrementViewCount('MintV');
  assert.deepStrictEqual(jobQueue.getBufferedViewCounts(['MintV']), { MintV: 3 });
  release();
  await flushing;
  assert.deepStrictEqual(jobQueue.getBufferedViewCounts(['MintV']), { MintV: 1 }, 'queued views handed to the job');
});
