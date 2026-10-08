/**
 * Worker job handlers, with the services they call stubbed. No Redis or Postgres.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

delete process.env.REDIS_URL;

const pipelinePath = path.join(__dirname, 'services', 'holderPipeline.js');
const stubPipeline = { CONFIG: {}, runBackfill: null };
require.cache[pipelinePath] = { id: pipelinePath, filename: pipelinePath, loaded: true, exports: stubPipeline };

const { cache } = require('./services/cache');
const { jobProcessors } = require('./worker');

// The pending lock's cooldown after a failure is runBackfill's job (holderPipeline.db.test.js
// checks it keeps the lock for CONFIG.backfillFailCooldown); the processor must leave it alone.
test('a failed backfill run is rethrown for BullMQ, and the lock runBackfill left is untouched', async () => {
  const mint = 'BackfillMint1111111111111111111111111111111';
  const lockKey = `holder-backfill-pending:${mint}`;
  const writes = [];
  const realSet = cache.set;
  cache.set = async (k, v, ttl) => { writes.push({ k, ttl }); return realSet.call(cache, k, v, ttl); };
  stubPipeline.runBackfill = async (m) => {
    // What runBackfill's catch does on the way out: keep the lock as its own cooldown
    await realSet.call(cache, `holder-backfill-pending:${m}`, 'runBackfill', 60 * 1000);
    throw new Error('connection terminated');
  };
  try {
    await assert.rejects(jobProcessors['backfill-holder-acquisitions']({ data: { mint } }), /connection terminated/);
    assert.deepStrictEqual(writes, [], 'the processor sets no lock of its own');
    assert.strictEqual(await cache.get(lockKey), 'runBackfill');
  } finally {
    cache.set = realSet;
  }
});

test('a successful backfill run returns its result unchanged', async () => {
  stubPipeline.runBackfill = async () => ({ status: 'ok', settled: 3 });
  assert.deepStrictEqual(await jobProcessors['backfill-holder-acquisitions']({ data: { mint: 'M2' } }), { status: 'ok', settled: 3 });
});

test('a job without a mint does not run a backfill', async () => {
  stubPipeline.runBackfill = async () => { throw new Error('should not run'); };
  assert.deepStrictEqual(await jobProcessors['backfill-holder-acquisitions']({ data: {} }), { error: 'No mint provided' });
});
