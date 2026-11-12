/**
 * /api/new-pairs against a stubbed read service: the public switch, window validation,
 * the cache in front of the list, 404 and curated answers for a mint, and that no
 * request touches Helius, Jupiter or GeckoTerminal.
 */
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const express = require('express');

delete process.env.REDIS_URL; // in-memory cache, private to this test process

function stub(rel, exports) {
  const file = require.resolve(path.join(__dirname, rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
  return exports;
}

const upstreamCalls = [];
const forbidden = (name) => new Proxy({}, {
  get: (_t, prop) => (prop === 'then' ? undefined : (...args) => { upstreamCalls.push(`${name}.${String(prop)}`); throw new Error(`${name}.${String(prop)} must not be called`); }),
});
stub('../services/solana', forbidden('solana'));
stub('../services/jupiter', forbidden('jupiter'));
stub('../services/geckoTerminal', forbidden('geckoTerminal'));
stub('../services/freeRpc', forbidden('freeRpc'));
let dbReady = true;
stub('../services/database', new Proxy({ pool: null, isReady: () => dbReady }, { get: (t, p) => (p in t ? t[p] : (p === 'then' ? undefined : async () => null)) }));

const LISTED = 'Listed'.padEnd(44, '1');
const CURATED = 'Curated'.padEnd(44, '1');
const UNKNOWN = 'Unknown'.padEnd(44, '1');
const calls = { list: [], token: [] };
stub('../services/newPairList', {
  WINDOWS: { '3d': 1, '7d': 1, '14d': 1 },
  DEFAULT_WINDOW: '7d',
  buildList: async (window) => { calls.list.push(window); return { window, total: 1, shown: 1, tokens: [{ rank: 1, mint: LISTED, score: 79.2 }] }; },
  buildToken: async (mint) => {
    calls.token.push(mint);
    if (mint === CURATED) return { curated: true, mint };
    if (mint === LISTED) return { curated: false, token: { mint, score: 79.2 }, topHolders: { holders: [] } };
    return null;
  },
});

const { cache } = require('../services/cache');
const router = require('./newPairs');

let server; let base;
const get = async (url) => { const res = await fetch(base + url); return { status: res.status, body: await res.json() }; };

describe('/api/new-pairs', () => {
  before(async () => {
    const app = express();
    app.use('/api/new-pairs', router);
    await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}/api/new-pairs`;
  });
  after(() => new Promise(resolve => server.close(resolve)));
  beforeEach(async () => {
    process.env.NEWPAIRS_PUBLIC = 'true';
    dbReady = true;
    calls.list.length = 0; calls.token.length = 0;
    for (const w of ['3d', '7d', '14d']) await cache.delete(`newpairs:list:${w}`);
    for (const m of [LISTED, CURATED, UNKNOWN]) await cache.delete(`newpairs:token:${m}`);
  });

  test('closed until NEWPAIRS_PUBLIC is true: 404 with a code the tab can read, and nothing is built', async () => {
    for (const value of [undefined, 'false', '1', 'TRUE']) {
      if (value === undefined) delete process.env.NEWPAIRS_PUBLIC; else process.env.NEWPAIRS_PUBLIC = value;
      for (const url of ['', `/${LISTED}`]) {
        const r = await get(url);
        assert.strictEqual(r.status, 404);
        assert.strictEqual(r.body.code, 'NEWPAIRS_DISABLED');
      }
    }
    assert.strictEqual(calls.list.length + calls.token.length, 0);
  });

  test('list: default window 7d, the three windows accepted, anything else is a 400', async () => {
    assert.strictEqual((await get('')).body.window, '7d');
    assert.strictEqual((await get('?window=3d')).body.window, '3d');
    assert.strictEqual((await get('?window=14d')).body.tokens[0].mint, LISTED);
    for (const bad of ['30d', '', '7d&window=3d', 'constructor', '__proto__']) {
      const r = await get(`?window=${bad}`);
      assert.strictEqual(r.status, 400, `window=${bad}`);
    }
    assert.deepStrictEqual(calls.list, ['7d', '3d', '14d']);
  });

  test('list: a burst of requests builds once and then reads the cache', async () => {
    const results = await Promise.all(Array.from({ length: 12 }, () => get('?window=7d')));
    assert.ok(results.every(r => r.status === 200));
    await get('?window=7d');
    assert.deepStrictEqual(calls.list, ['7d']);
  });

  test('token: listed payload, curated pointer, and a cached 404 for a mint the finder does not list', async () => {
    assert.strictEqual((await get(`/${LISTED}`)).body.token.score, 79.2);
    assert.deepStrictEqual((await get(`/${CURATED}`)).body, { curated: true, mint: CURATED });
    for (let i = 0; i < 3; i++) {
      const r = await get(`/${UNKNOWN}`);
      assert.strictEqual(r.status, 404);
      assert.strictEqual(r.body.code, 'NOT_LISTED');
    }
    assert.strictEqual(calls.token.filter(m => m === UNKNOWN).length, 1, 'the miss is cached too');
    const bad = await get('/not-a-mint!');
    assert.strictEqual(bad.status, 400);
  });

  test('database not ready: 503, not a crash', async () => {
    dbReady = false;
    assert.strictEqual((await get('')).status, 503);
  });

  test('no request reached Helius, Jupiter, GeckoTerminal or a free RPC', () => {
    assert.deepStrictEqual(upstreamCalls, []);
  });
});
