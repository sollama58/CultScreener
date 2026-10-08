/**
 * Worker job handlers, with the services they call stubbed. No Redis or Postgres.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

delete process.env.REDIS_URL;

const pipelinePath = path.join(__dirname, 'services', 'holderPipeline.js');
const stubPipeline = { CONFIG: { snapshotFailCooldown: 5 * 60 * 1000 }, runBackfill: null };
require.cache[pipelinePath] = { id: pipelinePath, filename: pipelinePath, loaded: true, exports: stubPipeline };

const { cache } = require('./services/cache');
const { jobProcessors } = require('./worker');

test('a failed backfill run keeps the per-mint lock so its retry is the only runner (audit #52)', async () => {
  const mint = 'BackfillMint1111111111111111111111111111111';
  const lockKey = `holder-backfill-pending:${mint}`;
  stubPipeline.runBackfill = async (m) => {
    // What runBackfill's finally does on the way out.
    await cache.delete(`holder-backfill-pending:${m}`);
    throw new Error('connection terminated');
  };

  await assert.rejects(jobProcessors['backfill-holder-acquisitions']({ data: { mint } }), /connection terminated/);
  assert.ok(await cache.get(lockKey), 'pending lock is held after the failure');
  // An API-triggered ensureBackfill (setNX on the same key) is refused.
  assert.strictEqual(await cache.setNX(lockKey, Date.now(), 60000), false);
});

test('a successful backfill run returns its result unchanged', async () => {
  stubPipeline.runBackfill = async () => ({ status: 'ok', settled: 3 });
  assert.deepStrictEqual(await jobProcessors['backfill-holder-acquisitions']({ data: { mint: 'M2' } }), { status: 'ok', settled: 3 });
});
