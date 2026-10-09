/**
 * GET /v1/leaderboard/:mint returns the token's rank on a cache miss (cache.get answers
 * undefined, not null), and caches it; unscored or non-curated tokens get rank null.
 * GET /v1/leaderboard validates its numeric filters, passes search through unencoded and
 * keeps its cache entries apart from the internal leaderboard route's.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const express = require('express');

delete process.env.REDIS_URL;

const MINT = 'Tk'.padEnd(44, '1');
const UNSCORED = 'Us'.padEnd(44, '1');
const UNCURATED = 'Uc'.padEnd(44, '1');
let rankQueries = 0;
const leaderboardCalls = [];
const dbFile = require.resolve(path.join(__dirname, '../services/database'));
require.cache[dbFile] = { id: dbFile, filename: dbFile, loaded: true, exports: {
  isReady: () => true,
  getApiKeyByHash: async () => ({ id: 1, is_active: true, key_prefix: 'k', owner_wallet: null, name: 't' }),
  updateApiKeyUsage: async () => {},
  getToken: async (mint) => ({ mint_address: mint, name: 'Tok', conviction_1m: mint === UNSCORED ? null : '42.5' }),
  getCuratedToken: async (mint) => (mint === UNCURATED ? null : { mintAddress: mint }),
  getTokenConvictionRank: async () => { rankQueries++; return 7; },
  getTopConvictionTokens: async (limit, offset, filters) => {
    leaderboardCalls.push({ limit, offset, filters });
    return { tokens: [{ mint_address: MINT, name: 'Tok' }], total: 1 };
  }
} };

let server, base;
before(async () => {
  const app = express();
  app.use('/v1', require('./public'));
  server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('rank is computed on a cache miss and served from cache afterwards', async () => {
  const headers = { 'X-API-Key': 'a'.repeat(64) };
  const first = await (await fetch(`${base}/v1/leaderboard/${MINT}`, { headers })).json();
  assert.strictEqual(first.data.rank, 7);
  const second = await (await fetch(`${base}/v1/leaderboard/${MINT}`, { headers })).json();
  assert.strictEqual(second.data.rank, 7);
  assert.strictEqual(rankQueries, 1);
});

test('unscored and non-curated tokens get rank null, not #1', async () => {
  const headers = { 'X-API-Key': 'a'.repeat(64) };
  const before = rankQueries;
  for (const mint of [UNSCORED, UNCURATED]) {
    const body = await (await fetch(`${base}/v1/leaderboard/${mint}`, { headers })).json();
    assert.strictEqual(body.success, true);
    assert.strictEqual(body.data.rank, null);
  }
  assert.strictEqual(rankQueries, before);
});

test('leaderboard: a non-numeric filter is a 400 and does not touch the unfiltered cache entry', async () => {
  const headers = { 'X-API-Key': 'a'.repeat(64) };
  for (const q of ['minMcap=abc', 'minConviction=x', 'maxMcap=NaN', 'minSample=x']) {
    const res = await fetch(`${base}/v1/leaderboard?${q}`, { headers });
    assert.strictEqual(res.status, 400, q);
  }
  assert.strictEqual(leaderboardCalls.length, 0);
  const plain = await (await fetch(`${base}/v1/leaderboard`, { headers })).json();
  assert.strictEqual(plain.total, 1);
  assert.strictEqual(plain.data.length, 1);
});

test('leaderboard: a negative or zero limit is clamped to 1, not sent to Postgres', async () => {
  const headers = { 'X-API-Key': 'a'.repeat(64) };
  const res = await fetch(`${base}/v1/leaderboard?limit=-1`, { headers });
  assert.strictEqual(res.status, 200);
  assert.strictEqual((await res.json()).limit, 1);
  assert.strictEqual(leaderboardCalls.at(-1).limit, 1);
});

test('leaderboard: search is passed to the query unencoded', async () => {
  const headers = { 'X-API-Key': 'a'.repeat(64) };
  await fetch(`${base}/v1/leaderboard?search=${encodeURIComponent("Rock & Roll's")}`, { headers });
  assert.strictEqual(leaderboardCalls.at(-1).filters.search, "Rock & Roll's");
});

test('leaderboard: cache entries live under their own v1 prefix', async () => {
  const { cache } = require('../services/cache');
  const headers = { 'X-API-Key': 'a'.repeat(64) };
  const q = 'minConviction=10&minMcap=1&maxMcap=2&minSample=3&search=x';
  await fetch(`${base}/v1/leaderboard?${q}`, { headers });
  const internalKey = 'leaderboard:conviction:25:0:{"minConviction":10,"minMcap":1,"maxMcap":2,"minSample":3,"search":"x"}';
  assert.strictEqual(await cache.get(internalKey), undefined);
  assert.ok(await cache.get(`leaderboard:conviction:v1:25:0:${internalKey.split(':0:')[1]}`));
});
