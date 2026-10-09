/**
 * addCuratedTokenFully: a mint already on the curated list is reported as such and left
 * alone (no market/DexScreener calls, no snapshot, no cache drops).
 *
 * The service runs against stubbed database, cache, market and pipeline modules.
 */
const { test, describe, before, beforeEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const MINT = 'So11111111111111111111111111111111111111112';
const calls = [];
let curated;          // mint → row
let raceInsert;       // the insert finds the row another request just added
let dbDown;           // the database is unavailable: nothing is inserted

const stub = (file, exports) => {
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
};
const local = rel => require.resolve(path.join(__dirname, rel));

let addCuratedTokenFully;

before(() => {
  stub(local('./cache'), {
    cache: {
      delete: async (k) => { calls.push(['delete', k]); },
      clearPattern: async (p) => { calls.push(['clearPattern', p]); },
    },
  });
  stub(local('./database'), {
    getCuratedToken: async (m) => curated.get(m) || null,
    addCuratedToken: async (m) => {
      calls.push(['insert', m]);
      if (dbDown) return null;
      if (raceInsert || curated.has(m)) { curated.set(m, { mintAddress: m }); return null; }
      curated.set(m, { mintAddress: m });
      return { mint_address: m };
    },
    updateCuratedTokenATH: async () => { calls.push(['ath']); },
    updateCuratedTokenDexScreener: async () => { calls.push(['dex']); },
    updateTokenMarketData: async () => { calls.push(['market']); },
  });
  stub(local('./geckoTerminal'), { getMarketData: async () => { calls.push(['gecko']); return { marketCap: 1000, price: 1 }; } });
  stub(local('./holderPipeline'), { ensureSnapshot: async () => { calls.push(['snapshot']); } });
  stub(require.resolve('axios'), { get: async () => { calls.push(['dexscreener']); return { data: { pairs: [] } }; } });
  ({ addCuratedTokenFully } = require('./curatedTokens'));
});

beforeEach(() => {
  calls.length = 0;
  curated = new Map();
  raceInsert = false;
  dbDown = false;
});

describe('addCuratedTokenFully', () => {
  test('a new mint is added and wired in', async () => {
    const r = await addCuratedTokenFully(MINT);
    assert.strictEqual(r.alreadyCurated, false);
    assert.deepStrictEqual(r.token, { mintAddress: MINT });
    const ops = calls.map(c => c[0]);
    assert.ok(ops.includes('insert') && ops.includes('snapshot') && ops.includes('clearPattern'), JSON.stringify(calls));
  });

  test('a mint already on the list is reported and left alone', async () => {
    curated.set(MINT, { mintAddress: MINT, name: 'Kept' });
    const r = await addCuratedTokenFully(MINT);
    assert.strictEqual(r.alreadyCurated, true);
    assert.strictEqual(r.token.name, 'Kept');
    assert.deepStrictEqual(calls, []);
  });

  test('losing an insert race to another add is reported the same way', async () => {
    raceInsert = true;
    const r = await addCuratedTokenFully(MINT);
    assert.strictEqual(r.alreadyCurated, true);
    assert.deepStrictEqual(calls.map(c => c[0]), ['gecko', 'insert']);
  });

  test('an insert that never happened is an error, not "already curated"', async () => {
    dbDown = true;
    await assert.rejects(addCuratedTokenFully(MINT), /Failed to add curated token/);
  });
});
