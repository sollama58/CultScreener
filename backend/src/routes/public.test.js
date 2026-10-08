/**
 * GET /v1/leaderboard/:mint returns the token's rank on a cache miss (cache.get answers
 * undefined, not null), and caches it; unscored or non-curated tokens get rank null.
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
const dbFile = require.resolve(path.join(__dirname, '../services/database'));
require.cache[dbFile] = { id: dbFile, filename: dbFile, loaded: true, exports: {
  isReady: () => true,
  getApiKeyByHash: async () => ({ id: 1, is_active: true, key_prefix: 'k', owner_wallet: null, name: 't' }),
  updateApiKeyUsage: async () => {},
  getToken: async (mint) => ({ mint_address: mint, name: 'Tok', conviction_1m: mint === UNSCORED ? null : '42.5' }),
  getCuratedToken: async (mint) => (mint === UNCURATED ? null : { mintAddress: mint }),
  getTokenConvictionRank: async () => { rankQueries++; return 7; }
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
