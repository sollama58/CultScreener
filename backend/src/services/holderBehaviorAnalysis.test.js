/**
 * Holder Behavior orchestration: how many Helius pages a wallet costs, what is
 * cached, and what a run with failed wallets stores. Helius and the snapshot
 * pipeline are stubbed; the in-memory cache is used.
 */
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');

delete process.env.REDIS_URL;

const pipelinePath = path.join(__dirname, 'holderPipeline.js');
const stubPipeline = { getSnapshotHolderList: async () => null };
require.cache[pipelinePath] = { id: pipelinePath, filename: pipelinePath, loaded: true, exports: stubPipeline };

const solanaService = require('./solana');
const { cache } = require('./cache');
const hb = require('./holderBehaviorAnalysis');

hb.HB_RUN_CONFIG.batchDelayMs = 0;
hb.HB_RUN_CONFIG.retryDelayMs = 0;

const WALLET = 'Wa11et1111111111111111111111111111111111111';
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

// A raw transaction in which `wallet` bought `mint` with SOL
function rawBuy(mint, slotTime, wallet = WALLET) {
  return {
    blockTime: slotTime,
    meta: {
      err: null, fee: 5000,
      preBalances: [5_000_000_000], postBalances: [4_000_000_000],
      preTokenBalances: [],
      postTokenBalances: [{ owner: wallet, mint, uiTokenAmount: { amount: '1000', decimals: 0 } }]
    },
    transaction: { message: { accountKeys: [wallet] } }
  };
}

const realFns = {};
function stub(name, fn) {
  if (!(name in realFns)) realFns[name] = solanaService[name];
  solanaService[name] = fn;
}

beforeEach(async () => {
  for (const [k, v] of Object.entries(realFns)) solanaService[k] = v;
  await cache.clear?.();
  stubPipeline.getSnapshotHolderList = async () => null;
});

test('getTransactionsForAddress path: at most HB_HISTORY_TXS/250 pages of 250 per wallet', async () => {
  const calls = [];
  stub('isTransactionHistoryAvailable', () => true);
  stub('getAccountTransactionsPage', async (w, opts) => {
    calls.push(opts.limit);
    // Full pages of non-swap transactions, always with a next page
    return { txs: Array.from({ length: 250 }, () => ({ meta: { err: null } })), paginationToken: 'next' };
  });
  const swaps = await hb.fetchSwapHistory(WALLET, 200);
  assert.deepStrictEqual(swaps, []);
  assert.deepStrictEqual(calls, [250, 250, 250, 250], '1,000 transactions read, no more');
  // The empty answer is cached, so the next run costs nothing
  assert.deepStrictEqual(await cache.get(`hb-swaps:v2:${WALLET}`), []);
  await hb.fetchSwapHistory(WALLET, 200);
  assert.strictEqual(calls.length, 4);
});

test('swaps round-trip through the compact cache format', async () => {
  stub('isTransactionHistoryAvailable', () => true);
  stub('getAccountTransactionsPage', async () => ({ txs: [rawBuy(BONK, 1_700_000_000)], paginationToken: null }));
  const first = await hb.fetchSwapHistory(WALLET, 200);
  assert.strictEqual(first.length, 1);
  stub('getAccountTransactionsPage', async () => { throw new Error('should be cached'); });
  const second = await hb.fetchSwapHistory(WALLET, 200);
  assert.deepStrictEqual(second, first);
  const t = second[0].tokenTransfers.find(x => x.mint === BONK);
  assert.strictEqual(t.toUserAccount, WALLET);
  assert.strictEqual(t.tokenAmount, 1000);
});

test('legacy Enhanced path caches a wallet with no swaps', async () => {
  let calls = 0;
  stub('isTransactionHistoryAvailable', () => false);
  stub('getTransactionsForAddress', async () => { calls++; return []; });
  assert.deepStrictEqual(await hb.fetchSwapHistory(WALLET, 200), []);
  assert.deepStrictEqual(await hb.fetchSwapHistory(WALLET, 200), []);
  assert.strictEqual(calls, 1, 'the empty answer is reused, not re-bought at 100 credits');
});

test('legacy Enhanced path does not cache a failed read (null) as "no swaps"', async () => {
  let calls = 0;
  stub('isTransactionHistoryAvailable', () => false);
  stub('getTransactionsForAddress', async () => { calls++; return null; });
  assert.deepStrictEqual(await hb.fetchSwapHistory(WALLET, 200), []);
  assert.ok(await cache.get(`hb-swaps:v2:${WALLET}`) == null);
  await hb.fetchSwapHistory(WALLET, 200);
  assert.strictEqual(calls, 2);
});

test('legacy Enhanced path pages by 100 up to maxCount', async () => {
  const limits = [];
  stub('isTransactionHistoryAvailable', () => false);
  stub('getTransactionsForAddress', async (w, opts) => {
    limits.push(opts.limit);
    return Array.from({ length: opts.limit }, (_, i) => ({ signature: `s${limits.length}-${i}`, timestamp: 1, tokenTransfers: [] }));
  });
  const swaps = await hb.fetchSwapHistory(WALLET, 200);
  assert.strictEqual(swaps.length, 200);
  assert.deepStrictEqual(limits, [100, 100]);
});

// ── runHolderBehaviorAnalysis ────────────────────────────────────────────────

const MINT = 'HbMint11111111111111111111111111111111111111';
const holders = n => Array.from({ length: n }, (_, i) => ({ wallet: `holder${String(i).padStart(38, '0')}` }));

function captureSets() {
  const sets = [];
  const realSet = cache.set;
  cache.set = async (k, v, ttl) => { sets.push({ k, v, ttl }); return realSet.call(cache, k, v, ttl); };
  return { sets, restore: () => { cache.set = realSet; } };
}

test('a run whose failed wallets succeed on retry is cached for the full 12 hours', async () => {
  stub('getTokenHolderSample', async () => ({ holders: holders(10) }));
  stub('isTransactionHistoryAvailable', () => true);
  const seen = new Map();
  stub('getAccountTransactionsPage', async (w) => {
    seen.set(w, (seen.get(w) || 0) + 1);
    // Every wallet fails its first read (a Helius blip), then answers
    if (seen.get(w) === 1) throw new Error('502 Bad Gateway');
    return { txs: [rawBuy(BONK, 1_700_000_000, w)], paginationToken: null };
  });
  await cache.set(`hb-pending:${MINT}`, 1, 60000);
  const { sets, restore } = captureSets();
  try {
    await hb.runHolderBehaviorAnalysis(MINT);
  } finally { restore(); }
  const write = sets.find(s => s.k === `hb-analysis:${MINT}`);
  assert.strictEqual(write.v.status, 'done');
  assert.strictEqual(write.v.failedCount, 0);
  assert.strictEqual(write.v.analyzedCount, 10);
  assert.strictEqual(write.ttl, hb.HB_ANALYSIS_CACHE_TTL);
  assert.ok(await cache.get(`hb-pending:${MINT}`) == null, 'the pending flag is cleared');
});

test('a run where many wallets still fail is cached only briefly and says how many failed', async () => {
  stub('getTokenHolderSample', async () => ({ holders: holders(10) }));
  stub('isTransactionHistoryAvailable', () => true);
  stub('getAccountTransactionsPage', async (w) => {
    if (w.endsWith('1') || w.endsWith('2') || w.endsWith('3')) throw new Error('timeout of 40000ms exceeded');
    return { txs: [rawBuy(BONK, 1_700_000_000, w)], paginationToken: null };
  });
  const { sets, restore } = captureSets();
  try {
    await hb.runHolderBehaviorAnalysis(MINT);
  } finally { restore(); }
  const write = sets.find(s => s.k === `hb-analysis:${MINT}`);
  assert.strictEqual(write.v.failedCount, 3);
  assert.strictEqual(write.v.analyzedCount, 7);
  assert.strictEqual(write.v.holders.filter(h => h.failed).length, 3);
  assert.strictEqual(write.ttl, hb.HB_PARTIAL_CACHE_TTL);
  // Failed wallets left no swap cache behind, so the next run reads them again
  assert.ok(await cache.get(`hb-swaps:v2:${holders(10)[1].wallet}`) == null);
});

test('a run uses the snapshot holder list when one exists, minus LP wallets', async () => {
  const list = holders(4);
  stubPipeline.getSnapshotHolderList = async () => ({
    snapshot: { sample_meta: { lpWallets: [list[0].wallet] } },
    rawAccounts: list.map(h => ({ wallet: h.wallet }))
  });
  stub('getTokenHolderSample', async () => { throw new Error('should not sample'); });
  stub('isTransactionHistoryAvailable', () => true);
  const read = [];
  stub('getAccountTransactionsPage', async (w) => { read.push(w); return { txs: [], paginationToken: null }; });
  await hb.runHolderBehaviorAnalysis(MINT);
  const result = await cache.get(`hb-analysis:${MINT}`);
  assert.strictEqual(result.holderCount, 3);
  assert.ok(!read.includes(list[0].wallet));
});

test('a second analysis of the same mint while one is running here is skipped (audit #108)', async () => {
  stub('getTokenHolderSample', async () => ({ holders: holders(2) }));
  stub('isTransactionHistoryAvailable', () => true);
  let reads = 0;
  let release;
  const gate = new Promise(r => { release = r; });
  stub('getAccountTransactionsPage', async () => { reads++; await gate; return { txs: [], paginationToken: null }; });
  const first = hb.runHolderBehaviorAnalysis(MINT);
  await new Promise(r => setTimeout(r, 20));
  await cache.set(`hb-pending:${MINT}`, 1, 60000); // a new run's flag, e.g. after a Redis restart
  await hb.runHolderBehaviorAnalysis(MINT);
  assert.strictEqual(reads, 2, 'the second run read nothing');
  assert.ok(await cache.get(`hb-pending:${MINT}`), 'and left the flag to the running analysis');
  release();
  await first;
  assert.ok(await cache.get(`hb-pending:${MINT}`) == null);
});
