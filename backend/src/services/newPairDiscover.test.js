/**
 * Discovery with every dependency faked: which path a run takes, what it costs, where
 * the cursor ends up, and that the daily cap and the paced fallback hold.
 */
const { test } = require('node:test');
const assert = require('node:assert');

const { createDiscovery, chooseSource, fallbackIntervalMs, gtfaCredits, FREE_MAX_LAG_MS } = require('./newPairDiscover');
const { DETECTORS } = require('./newPairLaunchpads');
const fixtures = require('./fixtures/newPairGraduations.json');

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.UTC(2026, 10, 12, 12);
const quiet = { warn() {}, log() {}, error() {} };

function fakeStore(initial = {}) {
  const s = {
    state: { cursorSig: null, cursorSlot: null, cursorTime: null, caughtUpAt: null, lastHeliusAt: null, ...initial },
    inserted: [], runs: [], credits: 0,
    async getDetectorState() { return { ...s.state }; },
    async insertGraduations(id, label, rows) { s.inserted.push(...rows.map(r => r.mint)); return rows.length; },
    async saveDetectorRun(id, run) { s.runs.push({ id, ...run }); },
    async addCredits(source, n) { s.credits += n; s.lastSource = source; },
    async creditsSpentToday() { return s.credits; },
  };
  return s;
}

const noHelius = {
  isTransactionHistoryAvailable: () => true,
  getAccountTransactionsPage: async () => { throw new Error('Helius must not be called'); },
};
const credits = { withSource: (source, fn) => fn() };
const sigOf = (tx) => tx.transaction.signatures[0];
const sigRow = (tx, extra = {}) => ({ signature: sigOf(tx), slot: tx.slot, blockTime: tx.blockTime, err: null, ...extra });

/** A free RPC that knows the given transactions (newest first in signature listings). */
function fakeFreeRpc(txs, { failOn } = {}) {
  const calls = [];
  return {
    calls,
    async call(method, params) {
      calls.push({ method, params });
      if (method === 'getSignaturesForAddress') {
        const until = params[1].until;
        const rows = [...txs].sort((a, b) => b.slot - a.slot).map(t => sigRow(t));
        const stop = rows.findIndex(r => r.signature === until);
        return stop === -1 ? rows : rows.slice(0, stop);
      }
      if (method === 'getTransaction') {
        if (failOn && params[0] === failOn) throw new Error('freeRpc getTransaction failed on a.example: 429');
        return txs.find(t => sigOf(t) === params[0]) || null;
      }
      throw new Error(`unexpected ${method}`);
    },
  };
}

test('gtfaCredits: 10 per 100 returned, never under 10', () => {
  assert.deepStrictEqual([0, 1, 100, 101, 250].map(gtfaCredits), [10, 10, 10, 20, 30]);
});

test('fallbackIntervalMs waits for about 80 transactions, between 15 minutes and 6 hours', () => {
  assert.strictEqual(Math.round(fallbackIntervalMs(DETECTORS.pumpfun) / MIN), 70);
  assert.strictEqual(fallbackIntervalMs(DETECTORS.launchlab), 6 * HOUR);
  assert.strictEqual(fallbackIntervalMs({ txPerDay: 100000 }), 15 * MIN);
  // A whole day of fallback on all three markers stays near 500 credits
  const perDay = Object.values(DETECTORS).reduce((sum, d) => sum + (24 * HOUR / fallbackIntervalMs(d)) * 10, 0);
  assert.ok(perDay < 600, `fallback would cost ${perDay} credits/day`);
});

test('chooseSource: backfill and long gaps go to Helius, the rest is free', () => {
  const fresh = { cursorSlot: 5, cursorTime: NOW - HOUR, caughtUpAt: null };
  assert.strictEqual(chooseSource({ state: { cursorSlot: null }, now: NOW }), 'helius');
  assert.strictEqual(chooseSource({ state: fresh, now: NOW }), 'free');
  assert.strictEqual(chooseSource({ state: { ...fresh, cursorTime: NOW - FREE_MAX_LAG_MS - 1 }, now: NOW }), 'helius');
  // A quiet marker: old cursor, but read through to the tip recently
  assert.strictEqual(chooseSource({ state: { cursorSlot: 5, cursorTime: NOW - 48 * HOUR, caughtUpAt: NOW - 10 * MIN }, now: NOW }), 'free');
  assert.strictEqual(chooseSource({ mode: 'free', state: { cursorSlot: null }, now: NOW }), 'free');
  assert.strictEqual(chooseSource({ mode: 'helius', state: fresh, now: NOW }), 'helius');
});

test('free path: stores real graduations, skips the no-op duplicate, advances the cursor, spends nothing', async () => {
  const txs = [fixtures.pumpV2Real, fixtures.pumpV2NoOp, fixtures.pumpLegacyMigrate].sort((a, b) => a.slot - b.slot);
  const store = fakeStore({ cursorSlot: txs[0].slot - 10, cursorSig: 'older', cursorTime: NOW - HOUR });
  const d = createDiscovery({ store, freeRpc: fakeFreeRpc(txs), solana: noHelius, heliusCredits: credits, now: () => NOW, env: {}, log: quiet });
  const tally = await d.runDetector(DETECTORS.pumpfun, NOW + 60_000);
  assert.strictEqual(tally.error, null);
  assert.strictEqual(tally.source, 'free');
  assert.strictEqual(tally.found, 2);
  assert.strictEqual(tally.credits, 0);
  assert.strictEqual(store.credits, 0);
  const newest = txs[txs.length - 1];
  assert.deepStrictEqual(store.runs[0].cursor, { sig: sigOf(newest), slot: newest.slot, time: newest.blockTime * 1000 });
  assert.strictEqual(store.runs[0].caughtUpAt, NOW);
  assert.strictEqual(store.runs[0].ok, true);
});

test('free path failure mid-run keeps the cursor before the failed transaction and, when the fallback is not due, spends nothing', async () => {
  const txs = [fixtures.pumpV2Real, fixtures.pumpLegacyMigrate, fixtures.pumpCoinQuoted].sort((a, b) => a.slot - b.slot);
  const store = fakeStore({ cursorSlot: txs[0].slot - 10, cursorSig: 'older', cursorTime: NOW - HOUR, lastHeliusAt: NOW - 5 * MIN });
  const free = fakeFreeRpc(txs, { failOn: sigOf(txs[1]) });
  const d = createDiscovery({ store, freeRpc: free, solana: noHelius, heliusCredits: credits, now: () => NOW, env: {}, log: quiet });
  const tally = await d.runDetector(DETECTORS.pumpfun, NOW + 60_000);
  assert.match(tally.error, /429/);
  assert.strictEqual(store.runs[0].cursor.sig, sigOf(txs[0]));
  assert.strictEqual(store.runs[0].caughtUpAt, null);
  assert.strictEqual(store.runs[0].ok, false);
  assert.strictEqual(store.credits, 0);
});

test('free path failure falls back to Helius once the interval has passed, resuming from the free cursor', async () => {
  const txs = [fixtures.pumpV2Real, fixtures.pumpLegacyMigrate, fixtures.pumpCoinQuoted].sort((a, b) => a.slot - b.slot);
  const store = fakeStore({ cursorSlot: txs[0].slot - 10, cursorSig: 'older', cursorTime: NOW - HOUR, lastHeliusAt: NOW - 3 * HOUR });
  const pages = [];
  const solana = {
    isTransactionHistoryAvailable: () => true,
    async getAccountTransactionsPage(address, opts) { pages.push({ address, opts }); return { txs: txs.slice(1), paginationToken: null }; },
  };
  const d = createDiscovery({ store, freeRpc: fakeFreeRpc(txs, { failOn: sigOf(txs[1]) }), solana, heliusCredits: credits, now: () => NOW, env: {}, log: quiet });
  const tally = await d.runDetector(DETECTORS.pumpfun, NOW + 60_000);
  assert.strictEqual(tally.error, null);
  assert.strictEqual(tally.source, 'helius');
  assert.strictEqual(pages.length, 1);
  assert.strictEqual(pages[0].address, DETECTORS.pumpfun.marker);
  assert.deepStrictEqual(pages[0].opts.filters, { slot: { gte: txs[0].slot } });
  assert.strictEqual(pages[0].opts.sortOrder, 'asc');
  assert.strictEqual(store.credits, 10);
  assert.strictEqual(store.lastSource, 'newpairs:discover');
  assert.strictEqual(store.runs[0].usedHelius, true);
  assert.strictEqual(store.runs[0].cursor.sig, sigOf(txs[2]));
  assert.strictEqual(new Set(store.inserted).size, 3);
});

test('NEWPAIRS_DISCOVERY_SOURCE=free never calls Helius, even when the fallback is due', async () => {
  const txs = [fixtures.pumpV2Real];
  const store = fakeStore({ cursorSlot: txs[0].slot - 10, cursorSig: 'older', cursorTime: NOW - HOUR });
  const d = createDiscovery({ store, freeRpc: fakeFreeRpc(txs, { failOn: sigOf(txs[0]) }), solana: noHelius, heliusCredits: credits, now: () => NOW, env: { NEWPAIRS_DISCOVERY_SOURCE: 'free' }, log: quiet });
  const tally = await d.runDetector(DETECTORS.pumpfun, NOW + 60_000);
  assert.match(tally.error, /429/);
  assert.strictEqual(store.credits, 0);
});

test('backfill: first run reads Helius oldest-first from 14 days back, page by page, counting credits', async () => {
  const store = fakeStore();
  const all = [fixtures.pumpV2Real, fixtures.pumpLegacyMigrate, fixtures.pumpCoinQuoted].sort((a, b) => a.slot - b.slot);
  const pages = [];
  const solana = {
    isTransactionHistoryAvailable: () => true,
    async getAccountTransactionsPage(address, opts) {
      pages.push(opts);
      return opts.paginationToken ? { txs: all.slice(2), paginationToken: null } : { txs: all.slice(0, 2), paginationToken: 'next' };
    },
  };
  const sources = [];
  const d = createDiscovery({ store, freeRpc: fakeFreeRpc([]), solana, heliusCredits: { withSource: (s, fn) => { sources.push(s); return fn(); } }, now: () => NOW, env: {}, log: quiet });
  const tally = await d.runDetector(DETECTORS.pumpfun, NOW + 60_000);
  assert.strictEqual(tally.error, null);
  assert.deepStrictEqual(pages[0].filters, { blockTime: { gte: Math.floor((NOW - 14 * 24 * HOUR) / 1000) } });
  assert.strictEqual(pages[1].paginationToken, 'next');
  assert.strictEqual(store.credits, 20);
  assert.deepStrictEqual(sources, ['newpairs:discover', 'newpairs:discover']);
  assert.strictEqual(tally.found, 3);
  assert.strictEqual(store.runs[0].cursor.slot, all[2].slot);
  assert.strictEqual(store.runs[0].caughtUpAt, NOW);
});

test('the daily cap stops Helius before the call, and the cursor is left alone', async () => {
  const store = fakeStore();
  store.credits = 995;
  const d = createDiscovery({ store, freeRpc: fakeFreeRpc([]), solana: noHelius, heliusCredits: credits, now: () => NOW, env: { NEWPAIRS_HELIUS_DAILY_CREDITS: '1000' }, log: quiet });
  const tally = await d.runDetector(DETECTORS.pumpfun, NOW + 60_000);
  assert.match(tally.error, /daily Helius cap reached \(995 of 1000/);
  assert.strictEqual(store.credits, 995);
  assert.strictEqual(store.runs[0].cursor, null);
});

test('a Helius endpoint that rejects version 1 is retried at version 0 and remembered', async () => {
  const store = fakeStore();
  const versions = [];
  const solana = {
    isTransactionHistoryAvailable: () => true,
    async getAccountTransactionsPage(address, opts) {
      versions.push(opts.maxSupportedTransactionVersion);
      if (opts.maxSupportedTransactionVersion !== 0) throw Object.assign(new Error('invalid params'), { rpcCode: -32602 });
      return { txs: [fixtures.pumpV2Real], paginationToken: null };
    },
  };
  const d = createDiscovery({ store, freeRpc: fakeFreeRpc([]), solana, heliusCredits: credits, now: () => NOW, env: {}, log: quiet });
  assert.strictEqual((await d.runDetector(DETECTORS.pumpfun, NOW + 60_000)).found, 1);
  await d.runDetector(DETECTORS.pumpfun, NOW + 60_000);
  assert.deepStrictEqual(versions, [1, 0, 0]);
});

test('run(): one detector failing does not stop the others, and nothing throws', async () => {
  const store = fakeStore({ cursorSlot: 1, cursorSig: 'older', cursorTime: NOW - HOUR, lastHeliusAt: NOW });
  const free = { async call() { throw new Error('freeRpc getSignaturesForAddress failed on a.example: 403'); } };
  const d = createDiscovery({ store, freeRpc: free, solana: noHelius, heliusCredits: credits, now: () => NOW, env: {}, log: quiet });
  const result = await d.run({ timeBudgetMs: 1000 });
  assert.strictEqual(result.detectors.length, 3);
  assert.ok(result.detectors.every(r => /403/.test(r.error)));
  assert.strictEqual(store.runs.length, 3);
  assert.deepStrictEqual((await createDiscovery({ store, env: { NEWPAIRS_DETECTORS: 'nope' }, log: quiet }).run()).detectors, []);
});
