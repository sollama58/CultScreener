/**
 * Worker job handlers (src/worker.js) with the services they call stubbed. No Redis or
 * Postgres: the cache falls back to memory and jobQueue has no REDIS_URL, so every
 * addAnalyticsJob returns null. Lives under services/ because the npm test glob,
 * expanded by sh without globstar, only reaches test files one directory below src/.
 */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');

delete process.env.REDIS_URL;
delete process.env.DATABASE_URL;

const stub = (file, exports) => {
  const p = path.join(__dirname, file);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
  return exports;
};
const pipeline = stub('holderPipeline.js', {
  CONFIG: { listN: 100, refreshMs: 4 * 3600000, snapshotLockTtl: 600000 },
  getSnapshotHolderList: async () => null,
  takeSnapshot: async () => ({ status: 'ok' }),
});
stub('holderCounts.js', { getDisplayCounts: async () => ({}) });

const { cache, TTL } = require('./cache');
const solana = require('./solana');
const gecko = require('./geckoTerminal');
const db = require('./database');
const { jobProcessors, queueConcurrency } = require('../worker');

const MINT = 'WorkerJobMint1111111111111111111111111111111';
const ttls = new Map();
const realSet = cache.set.bind(cache);
cache.set = async (k, v, ttl) => { ttls.set(k, ttl); return realSet(k, v, ttl); };

const holderAccounts = (n, prefix) => Array.from({ length: n }, (_, i) => ({
  address: `${prefix}Acct${i}`, wallet: `${prefix}Wallet${i}`, uiAmount: 1000 - i,
}));

beforeEach(async () => {
  ttls.clear();
  for (const k of [`holder-analytics:${MINT}`, `holder-classify-pending:${MINT}`, `holder-snapshot-pending:${MINT}`, `similar:${MINT}`, `mcap-reported:${MINT}`]) {
    await cache.delete(k);
  }
  solana.getAccountInfo = async () => ({ value: { data: { parsed: { info: { decimals: 6, supply: '1000000000000000' } } } } });
  solana.getTokenAuthorities = async () => null;
  solana.getStreamflowLockedAmount = async () => 0;
  solana.getMultipleAccounts = async (addrs) => ({ value: addrs.map(() => ({ owner: '11111111111111111111111111111111', data: { parsed: { info: { owner: 'RpcOwner' } } } })) });
  solana.isHeliusConfigured = () => false;
});

describe('compute-holder-analytics', () => {
  test('a 20-account job for a token with a snapshot classifies the snapshot\'s 100 holders (audit #35)', async () => {
    pipeline.getSnapshotHolderList = async () => ({ rawAccounts: holderAccounts(100, 'Snap'), totalSupply: 1e9, decimals: 6 });
    await jobProcessors['compute-holder-analytics']({
      data: { mint: MINT, rawAccounts: holderAccounts(20, 'Rpc').map(a => ({ address: a.address, uiAmount: a.uiAmount })), totalSupply: 1e9, usedDAS: false, supplyDecimals: 6 },
      opts: { attempts: 3 }, attemptsMade: 0,
    });
    const cached = await cache.get(`holder-analytics:${MINT}`);
    assert.strictEqual(cached.holders.length, 100);
    assert.strictEqual(cached.holders[0].address, 'SnapWallet0');
    assert.strictEqual(ttls.get(`holder-analytics:${MINT}`), 4 * 3600000 + 2 * TTL.HOUR);
  });

  test('without a snapshot the job classifies the accounts it was given', async () => {
    pipeline.getSnapshotHolderList = async () => null;
    await jobProcessors['compute-holder-analytics']({
      data: { mint: MINT, rawAccounts: holderAccounts(20, 'Rpc'), totalSupply: 1e9, usedDAS: true, supplyDecimals: 6 },
    });
    assert.strictEqual((await cache.get(`holder-analytics:${MINT}`)).holders.length, 20);
  });

  test('a failed attempt keeps the pending lock through BullMQ\'s retry; the last one releases it (audit #185)', async () => {
    pipeline.getSnapshotHolderList = async () => null;
    solana.getMultipleAccounts = async () => { throw new Error('429 Too Many Requests'); };
    const job = (attemptsMade) => ({
      data: { mint: MINT, rawAccounts: holderAccounts(5, 'X'), totalSupply: 1e9, usedDAS: true, supplyDecimals: 6 },
      opts: { attempts: 3 }, attemptsMade,
    });
    await cache.set(`holder-classify-pending:${MINT}`, 1, 120000);
    await assert.rejects(jobProcessors['compute-holder-analytics'](job(0)), /429/);
    assert.ok(await cache.get(`holder-classify-pending:${MINT}`), 'kept for the retry');
    await assert.rejects(jobProcessors['compute-holder-analytics'](job(2)), /429/);
    assert.strictEqual(await cache.get(`holder-classify-pending:${MINT}`), undefined, 'released after the last attempt');
  });
});

describe('snapshot-holders', () => {
  test('an unchanged snapshot renews a full classification instead of letting it lapse (audit #125)', async () => {
    pipeline.takeSnapshot = async () => ({ status: 'unchanged' });
    pipeline.getSnapshotHolderList = async () => ({ rawAccounts: holderAccounts(30, 'S'), totalSupply: 1e9, decimals: 6 });
    await realSet(`holder-analytics:${MINT}`, { holders: holderAccounts(30, 'S'), supply: { total: 1 } }, 1000);
    await jobProcessors['snapshot-holders']({ data: { mint: MINT } });
    assert.strictEqual(ttls.get(`holder-analytics:${MINT}`), 4 * 3600000 + 2 * TTL.HOUR);
    assert.strictEqual(ttls.has(`holder-classify-pending:${MINT}`), false, 'no classification queued');
  });

  test('a short inline classification is not renewed; the snapshot list is classified (audit #125)', async () => {
    pipeline.takeSnapshot = async () => ({ status: 'unchanged' });
    pipeline.getSnapshotHolderList = async () => ({ rawAccounts: holderAccounts(100, 'S'), totalSupply: 1e9, decimals: 6 });
    // The API's inline fallback: 20 RPC accounts, with a supply
    await realSet(`holder-analytics:${MINT}`, { holders: holderAccounts(20, 'R'), supply: { total: 1 } }, TTL.HOUR);
    await jobProcessors['snapshot-holders']({ data: { mint: MINT } });
    assert.strictEqual(ttls.get(`holder-analytics:${MINT}`), undefined, 'the short result is left to expire');
    assert.ok(ttls.has(`holder-classify-pending:${MINT}`), 'a classification was attempted');
  });

  test('a failed classification add releases the pending lock at once (audit #126); a fast result is not a classification', async () => {
    pipeline.takeSnapshot = async () => ({ status: 'unchanged' });
    pipeline.getSnapshotHolderList = async () => ({ rawAccounts: holderAccounts(3, 'S'), totalSupply: 1e9, decimals: 6 });
    // The API's 2-minute fast result: no supply, so it doesn't count as classified
    await realSet(`holder-analytics:${MINT}`, { holders: [], supply: null }, 120000);
    await jobProcessors['snapshot-holders']({ data: { mint: MINT } });
    assert.ok(ttls.has(`holder-classify-pending:${MINT}`), 'a classification was attempted');
    assert.strictEqual(ttls.get(`holder-analytics:${MINT}`), undefined, 'the fast result is not renewed');
    // No queue in this test, so addAnalyticsJob returned null
    assert.strictEqual(await cache.get(`holder-classify-pending:${MINT}`), undefined);
  });

  test('past the concurrency cap a snapshot job is moved to the delayed set, not run (audit #186)', async () => {
    const releases = [];
    pipeline.takeSnapshot = () => new Promise(r => releases.push(() => r({ status: 'empty' })));
    const running = [1, 2, 3].map(i => jobProcessors['snapshot-holders']({ data: { mint: `M${i}` } }, 'tok'));
    await new Promise(r => setImmediate(r));
    assert.strictEqual(releases.length, 3);
    let delayedTo = null;
    const job = { data: { mint: MINT }, moveToDelayed: async (ts, token) => { delayedTo = { ts, token }; } };
    await assert.rejects(jobProcessors['snapshot-holders'](job, 'tok4'), (err) => err.name === 'DelayedError');
    assert.strictEqual(delayedTo.token, 'tok4');
    assert.ok(delayedTo.ts > Date.now());
    assert.ok(await cache.get(`holder-snapshot-pending:${MINT}`), 'its lock is kept while it waits');
    releases.forEach(r => r());
    await Promise.all(running);
  });
});

describe('fetch-holder-counts-batch', () => {
  test('a mint whose snapshot is running is not scanned a second time (audit #124)', async () => {
    const scanned = [];
    solana.getTokenHolderCount = async (m) => { scanned.push(m); return 10; };
    await realSet(`holder-snapshot-pending:${MINT}`, Date.now(), 60000);
    const res = await jobProcessors['fetch-holder-counts-batch']({ data: { mints: [MINT, 'OtherMint'] } });
    assert.deepStrictEqual(scanned, ['OtherMint']);
    assert.strictEqual(res.skipped, 1);
  });
});

describe('compute-similar-tokens (audit #123)', () => {
  const local = (address) => ({ address, name: address, symbol: address, source: 'local' });
  beforeEach(() => {
    db.isReady = () => true;
    db.getToken = async () => ({ name: 'Bonk', symbol: 'BONK' });
    db.findSimilarTokens = async () => [local('Bonk2'), local('Bonk3'), local('Bonk4'), local('Bonk5'), local('Bonk6')];
    gecko.getMultiTokenInfo = async () => ({});
    gecko.searchTokens = async () => [];
  });

  test('when every DEX lookup fails the look-alikes are kept, and cached only briefly', async () => {
    gecko.getTokenOverview = async () => { throw new Error('GeckoTerminal 503'); };
    await jobProcessors['compute-similar-tokens']({ data: { mint: MINT } });
    const cached = await cache.get(`similar:${MINT}`);
    assert.strictEqual(cached.results.length, 5);
    assert.strictEqual(ttls.get(`similar:${MINT}`), TTL.PRICE_DATA);
  });

  test('look-alikes GeckoTerminal does not index (null, a 404) are all dropped', async () => {
    gecko.getTokenOverview = async () => null;
    await jobProcessors['compute-similar-tokens']({ data: { mint: MINT } });
    const cached = await cache.get(`similar:${MINT}`);
    assert.deepStrictEqual(cached.results, []);
  });

  test('when GeckoTerminal answers, tokens it has no qualifying pool for are still dropped', async () => {
    gecko.getTokenOverview = async (a) => (a === 'Bonk2' ? { dexIds: ['raydium'] } : a === 'Bonk3' ? { dexIds: ['orca'] } : null);
    await jobProcessors['compute-similar-tokens']({ data: { mint: MINT } });
    const cached = await cache.get(`similar:${MINT}`);
    assert.deepStrictEqual(cached.results.map(t => t.address), ['Bonk2']);
    assert.strictEqual(ttls.get(`similar:${MINT}`), TTL.HOUR);
  });
});

describe('refresh-curated-prices (audit #127)', () => {
  let athWrites;
  beforeEach(() => {
    athWrites = [];
    db.getCuratedTokens = async () => [{ mintAddress: MINT, mcapAtAdded: 1 }];
    db.updateTokenMarketData = async () => {};
    db.updateCuratedTokenATH = async (m, v) => { athWrites.push(v); return true; };
    db.getMintsMissingLogo = async () => [];
    cache.clearPattern = async () => {};
  });

  test('an FDV-only reading does not move the ATH of a token that reports a market cap', async () => {
    gecko.getMultiTokenInfo = async () => ({ [MINT]: { price: 1, marketCap: 3e6, fdv: 10e6 } });
    await jobProcessors['refresh-curated-prices']({});
    gecko.getMultiTokenInfo = async () => ({ [MINT]: { price: 1, marketCap: null, fdv: 10e6 } });
    await jobProcessors['refresh-curated-prices']({});
    assert.deepStrictEqual(athWrites, [3e6]);
  });

  test('a token GeckoTerminal never gives a market cap for still tracks its ATH on FDV', async () => {
    gecko.getMultiTokenInfo = async () => ({ [MINT]: { price: 1, marketCap: null, fdv: 10e6 } });
    await jobProcessors['refresh-curated-prices']({});
    assert.deepStrictEqual(athWrites, [10e6]);
  });
});

test('WORKER_CONCURRENCY sets the analytics queue only; the light queues get small fixed slots (audit #187)', () => {
  process.env.WORKER_CONCURRENCY = '10';
  try {
    assert.strictEqual(queueConcurrency('analytics'), 10);
    assert.strictEqual(queueConcurrency('search'), 2);
    assert.strictEqual(queueConcurrency('maintenance'), 1);
    assert.strictEqual(queueConcurrency('notifications'), 1);
  } finally {
    delete process.env.WORKER_CONCURRENCY;
  }
});
