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

// audit #117: a failed Streamflow lookup must not be cached for hours as "0 locked"
test('holder analytics after a failed Streamflow lookup is flagged and cached briefly', async () => {
  const solanaService = require('./services/solana');
  const real = {
    getAccountInfo: solanaService.getAccountInfo,
    getTokenAuthorities: solanaService.getTokenAuthorities,
    getStreamflowLockedAmount: solanaService.getStreamflowLockedAmount,
    getMultipleAccounts: solanaService.getMultipleAccounts,
  };
  solanaService.getMultipleAccounts = async () => ({ value: [null] });
  solanaService.getAccountInfo = async () => null;
  solanaService.getTokenAuthorities = async () => null;
  solanaService.getStreamflowLockedAmount = async () => { throw new Error('timeout of 15000ms exceeded'); };
  stubPipeline.CONFIG.refreshMs = 4 * 3600000;
  const mint = 'StreamMint111111111111111111111111111111111';
  const writes = [];
  const realSet = cache.set;
  cache.set = async (k, v, ttl) => { writes.push({ k, v, ttl }); return realSet.call(cache, k, v, ttl); };
  try {
    await jobProcessors['compute-holder-analytics']({ data: {
      mint, totalSupply: 0, usedDAS: true, supplyDecimals: 6,
      rawAccounts: [{ wallet: 'W1', address: 'A1', uiAmount: 10 }],
    } });
    const w = writes.find(x => x.k === `holder-analytics:${mint}`);
    assert.strictEqual(w.v.supply.lockedUnknown, true);
    assert.strictEqual(w.ttl, 15 * 60 * 1000);
  } finally {
    cache.set = realSet;
    Object.assign(solanaService, real);
  }
});

test('getStreamflowLockedAmount reports an RPC failure instead of answering 0', async () => {
  const axios = require('axios');
  const solanaService = require('./services/solana');
  const realPost = axios.post;
  axios.post = async () => { throw Object.assign(new Error('Request failed with status code 400'), { response: { status: 400 } }); };
  try {
    const mint = 'StreamFail11111111111111111111111111111111';
    await assert.rejects(solanaService.getStreamflowLockedAmount(mint, 6));
    // Remembered for a few minutes, still as a failure
    await assert.rejects(solanaService.getStreamflowLockedAmount(mint, 6), /failed recently/);
  } finally {
    axios.post = realPost;
  }
});
