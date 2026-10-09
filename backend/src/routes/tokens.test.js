/**
 * /api/tokens routes against stubbed services (no network, no Postgres, in-memory cache):
 * list cache keys and trending pagination, pools cache poisoning, view recording for
 * curated tokens only, query-type 500s, holder-count range, and DAS decimals.
 */
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const express = require('express');
const axios = require('axios');

delete process.env.REDIS_URL; // in-memory cache, private to this test process
process.env.HELIUS_API_KEY = process.env.HELIUS_API_KEY || 'test-key';

function stub(rel, exports) {
  const file = require.resolve(path.join(__dirname, rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
  return exports;
}

const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const addr = (i) => (`Tk${ALPHA[Math.floor(i / ALPHA.length)]}${ALPHA[i % ALPHA.length]}`).padEnd(44, '1');
const CURATED = addr(0);
const OTHER = addr(1);
const WALLET = addr(2);

// Overridable per test
const S = {};
function resetStubs() {
  Object.assign(S, {
    allowed: new Set([CURATED]),
    trendingPages: {},
    geckoCalls: [],
    pools: [],
    poolCalls: [],
    viewIncrements: [],
    tokenSupply: null,
    tokenMetadata: null,
    largest: null,
    largestDAS: null,
    dasCalls: [],
    ownerAccounts: null,
    dasTokenAccounts: null,
    jobs: [],
    overview: null,
    overviewError: null
  });
}
resetStubs();

const dbStub = {
  pool: null,
  isReady: () => true,
  isTokenAllowed: async (m) => S.allowed.has(m),
  getTokenViews: async () => 5,
  incrementTokenViews: async () => 6,
  getTokenViewsBatch: async () => ({}),
  getSentimentBatch: async () => ({}),
  hasApprovedSubmissionsBatch: async () => new Set(),
  getTopConvictionTokens: async () => ({ tokens: [], total: 0 }),
  getApprovedSubmissions: async () => []
};
stub('../services/database', new Proxy(dbStub, {
  get: (t, p) => (p in t ? t[p] : (p === 'then' ? undefined : async () => ({})))
}));
stub('../services/geckoTerminal', {
  getTrendingTokens: async ({ page }) => { S.geckoCalls.push(page); return S.trendingPages[page] || []; },
  getNewTokens: async (_l, _s, page) => { S.geckoCalls.push(page); return S.trendingPages[page] || []; },
  getTokenPools: async (mint, { limit }) => { S.poolCalls.push(limit); return S.pools.slice(0, limit); },
  getTokenOverview: async () => { if (S.overviewError) throw S.overviewError; return S.overview || null; },
  OHLCV_TIMEFRAMES: { '1m': 1, '5m': 1, '15m': 1, '1h': 1, '4h': 1, '12h': 1, '1d': 1 }
});
stub('../services/jupiter', { getTrendingTokens: async () => [], getTokenInfo: async () => null });
stub('../services/solana', {
  isHeliusConfigured: () => false,
  countCredits: () => {},
  getTokenMetadataBatch: async () => ({}),
  getTokenSupply: async () => { if (!S.tokenSupply) throw new Error('rpc down'); return S.tokenSupply; },
  getTokenMetadata: async () => S.tokenMetadata,
  getTokenLargestAccounts: async () => S.largest,
  getTokenLargestAccountsDAS: async (mint, decimals) => { S.dasCalls.push(decimals); return S.largestDAS && S.largestDAS(decimals); },
  getTokenAccountsByOwner: async () => { if (!S.ownerAccounts) throw new Error('rpc down'); return S.ownerAccounts; }
});
stub('../services/jobQueue', {
  getBufferedViewCounts: () => ({}),
  incrementViewCount: async (m) => { S.viewIncrements.push(m); return 1; },
  addAnalyticsJob: async (name, data) => { S.jobs.push({ name, data }); return { id: 1 }; }
});
stub('../services/holderPipeline', {
  getSnapshotHolderList: async () => null,
  ensureSnapshot: async () => {},
  CONFIG: { refreshMs: 6 * 3_600_000 }
});

let base, server, holderCounts, cache;

before(async () => {
  holderCounts = require('../services/holderCounts');
  holderCounts.getPoints = async () => [];
  holderCounts.getDisplayCounts = async () => ({});
  ({ cache } = require('../services/cache'));
  const app = express();
  app.use(express.json());
  app.use('/api/tokens', require('./tokens'));
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
  server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
beforeEach(async () => { resetStubs(); await cache.clear?.(); });

const get = (p) => fetch(base + p).then(async r => ({ status: r.status, body: await r.json() }));
const post = (p) => fetch(base + p, { method: 'POST' }).then(async r => ({ status: r.status, body: await r.json() }));
const tok = (i) => ({ address: addr(i), mintAddress: addr(i), name: `T${i}`, symbol: `T${i}`, logoUri: 'x' });

describe('GET /api/tokens (trending)', () => {
  test('different offsets with the same limit are cached separately', async () => {
    S.trendingPages = { 1: Array.from({ length: 20 }, (_, i) => tok(10 + i)) };
    const a = await get('/api/tokens?limit=10&offset=0');
    const b = await get('/api/tokens?limit=10&offset=5');
    assert.strictEqual(a.body[0].address, addr(10));
    assert.strictEqual(b.body[0].address, addr(15));
  });

  test('short pages and cross-page repeats: no duplicates, offsets index the merged list', async () => {
    // Page 1 yields 17 tokens (pools skipped), page 2 repeats the last of them
    S.trendingPages = {
      1: Array.from({ length: 17 }, (_, i) => tok(10 + i)),
      2: [tok(26), ...Array.from({ length: 19 }, (_, i) => tok(40 + i))]
    };
    const all = await get('/api/tokens?limit=40&offset=0');
    const addrs = all.body.map(t => t.address);
    assert.strictEqual(new Set(addrs).size, addrs.length);
    assert.strictEqual(addrs.length, 36);
    const second = await get('/api/tokens?limit=20&offset=20');
    assert.deepStrictEqual(second.body.map(t => t.address), addrs.slice(20, 36));
  });

  test('Gecko pages are fetched once and reused across offsets', async () => {
    S.trendingPages = {
      1: Array.from({ length: 20 }, (_, i) => tok(10 + i)),
      2: Array.from({ length: 20 }, (_, i) => tok(40 + i))
    };
    await get('/api/tokens?limit=20&offset=0');
    await get('/api/tokens?limit=20&offset=7');
    await get('/api/tokens?limit=20&offset=13');
    assert.deepStrictEqual(S.geckoCalls.sort(), [1, 2]);
  });

  test('a window past the last Gecko page makes no Gecko calls', async () => {
    S.trendingPages = { 1: [tok(10)] };
    await get('/api/tokens?limit=20&offset=200');
    assert.deepStrictEqual(S.geckoCalls, []);
  });

  test('an empty page before a full one neither shifts the window nor gets cached', async () => {
    S.trendingPages = { 1: Array.from({ length: 20 }, (_, i) => tok(10 + i)), 3: [tok(70)] };
    const first = await get('/api/tokens?limit=40&offset=20');
    // Page 2 failed: indices 20+ are unknown, so no tokens from page 3 at offset 20
    assert.ok(!first.body.some(t => t.address === addr(70)));
    S.trendingPages[2] = Array.from({ length: 20 }, (_, i) => tok(40 + i));
    const retry = await get('/api/tokens?limit=40&offset=20');
    assert.strictEqual(retry.body[0].address, addr(40));
  });
});

describe('GET /:mint/pools', () => {
  test('a bogus limit neither empties the response nor the shared cache', async () => {
    S.pools = Array.from({ length: 15 }, (_, i) => ({ address: `p${i}` }));
    const bad = await get(`/api/tokens/${CURATED}/pools?limit=abc`);
    assert.strictEqual(bad.body.length, 10);
    const one = await get(`/api/tokens/${CURATED}/pools?limit=1`);
    assert.strictEqual(one.body.length, 1);
    const normal = await get(`/api/tokens/${CURATED}/pools`);
    assert.strictEqual(normal.body.length, 10);
    assert.strictEqual(normal.body[0].address, 'p0');
  });
});

describe('POST /:mint/view', () => {
  test('non-curated mints are refused and never recorded', async () => {
    const r = await post(`/api/tokens/${OTHER}/view`);
    assert.strictEqual(r.status, 403);
    assert.deepStrictEqual(S.viewIncrements, []);
  });

  test('curated mints are recorded', async () => {
    const r = await post(`/api/tokens/${CURATED}/view`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.views, 6);
    assert.deepStrictEqual(S.viewIncrements, [CURATED]);
  });
});

describe('query parameter types', () => {
  test('repeated ohlcv interval is a 400, not a 500', async () => {
    const r = await get(`/api/tokens/${CURATED}/ohlcv?interval=1h&interval=4h`);
    assert.strictEqual(r.status, 400);
  });

  test('object conviction search is ignored, not a 500', async () => {
    const r = await get('/api/tokens/leaderboard/conviction?search[a]=b');
    assert.strictEqual(r.status, 200);
  });

  test('holder-count rejects Object.prototype names as range', async () => {
    const r = await get(`/api/tokens/${CURATED}/holder-count?range=constructor`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.range, '30d');
  });
});

describe('DAS fallbacks scale by the mint decimals', () => {
  test('holder/:wallet uses the mint decimals, not 9', async () => {
    S.tokenMetadata = { decimals: 6 };
    const orig = axios.post;
    axios.post = async () => ({ data: { result: { token_accounts: [{ mint: CURATED, amount: '2500000' }] } } });
    try {
      const r = await get(`/api/tokens/${CURATED}/holder/${WALLET}`);
      assert.strictEqual(r.body.balance, 2.5);
      assert.strictEqual(r.body.decimals, 6);
      assert.strictEqual(r.body.holdsToken, true);
    } finally { axios.post = orig; }
  });

  test('holder/:wallet with unknown decimals reports a holder with no balance', async () => {
    const orig = axios.post;
    axios.post = async () => ({ data: { result: { token_accounts: [{ mint: CURATED, amount: '2500000' }] } } });
    try {
      const r = await get(`/api/tokens/${CURATED}/holder/${WALLET}`);
      assert.strictEqual(r.body.holdsToken, true);
      assert.strictEqual(r.body.balance, null);
    } finally { axios.post = orig; }
  });

  test('holders: RPC and supply down, decimals come from metadata', async () => {
    S.tokenMetadata = { decimals: 6 };
    S.largestDAS = (d) => [{ address: 'acct1', wallet: WALLET, uiAmount: 5e12 / 10 ** d }];
    const r = await get(`/api/tokens/${CURATED}/holders`);
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(S.dasCalls, [6]);
    assert.strictEqual(r.body.holders[0].balance, 5e6);
    const job = S.jobs.find(j => j.name === 'compute-holder-analytics');
    assert.strictEqual(job.data.supplyDecimals, 6);
  });

  test('holders: decimals unknowable -> 503 instead of raw units', async () => {
    S.largestDAS = (d) => [{ address: 'acct1', wallet: WALLET, uiAmount: 5e12 / 10 ** d }];
    const r = await get(`/api/tokens/${CURATED}/holders`);
    assert.strictEqual(r.status, 503);
    assert.strictEqual(r.body.error, 'rpc_unavailable');
    assert.deepStrictEqual(S.dasCalls, []);
  });
});

describe('GET /:mint (detail) when GeckoTerminal fails', () => {
  for (const [label, err] of [
    ['a 502', Object.assign(new Error('Bad Gateway'), { response: { status: 502 } })],
    ['its breaker open', Object.assign(new Error('Circuit open'), { isCircuitBreakerError: true, isOverloaded: true })]
  ]) {
    test(`${label} serves partial data flagged geckoPartial, cached only briefly`, async () => {
      S.overviewError = err;
      const r = await get(`/api/tokens/${CURATED}`);
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.geckoPartial, true);
      // Re-cached with the 30s partial TTL, not the 10-minute PRICE_DATA one
      const meta = await cache.getWithMeta(`token:${CURATED}`);
      assert.ok(meta && meta.value.geckoPartial);
    });
  }
});
