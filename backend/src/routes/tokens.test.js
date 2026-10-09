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
    overviewError: null,
    helius: false,
    metaCalls: [],
    meta: null,
    jupiterCalls: 0
  });
}
resetStubs();

const dbBase = {
  pool: null,
  isReady: () => true,
  isTokenAllowed: async (m) => S.allowed.has(m),
  getTokenViews: async () => 5,
  incrementTokenViews: async () => 6,
  getTokenViewsBatch: async () => ({}),
  getSentimentBatch: async () => ({}),
  hasApprovedSubmissionsBatch: async () => new Set(),
  getTopConvictionTokens: async () => ({ tokens: [], total: 0 }),
  getApprovedSubmissions: async () => [],
  getCuratedTokens: async () => [...S.allowed].map(m => ({ mintAddress: m }))
};
// Tests patch dbStub / geckoStub / jupiterStub; beforeEach restores the base versions
const dbStub = { ...dbBase };
stub('../services/database', new Proxy(dbStub, {
  get: (t, p) => (p in t ? t[p] : (p === 'then' ? undefined : async () => ({})))
}));
const geckoBase = {
  getTrendingTokens: async ({ page }) => { S.geckoCalls.push(page); return S.trendingPages[page] || []; },
  getNewTokens: async (_l, _s, page) => { S.geckoCalls.push(page); return S.trendingPages[page] || []; },
  getTokenPools: async (mint, { limit }) => { S.poolCalls.push(limit); return S.pools.slice(0, limit); },
  getTokenOverview: async () => { if (S.overviewError) throw S.overviewError; return S.overview || null; },
  OHLCV_TIMEFRAMES: { '1m': 1, '5m': 1, '15m': 1, '1h': 1, '4h': 1, '12h': 1, '1d': 1 }
};
const geckoStub = stub('../services/geckoTerminal', { ...geckoBase });
const jupiterBase = { getTrendingTokens: async () => { S.jupiterCalls++; return []; }, getTokenInfo: async () => null };
const jupiterStub = stub('../services/jupiter', { ...jupiterBase });
const restore = (obj, base) => {
  for (const k of Object.keys(obj)) if (!(k in base)) delete obj[k];
  Object.assign(obj, base);
};
stub('../services/solana', {
  isHeliusConfigured: () => S.helius,
  countCredits: () => {},
  getTokenMetadataBatch: async (mints) => { S.metaCalls.push([...mints]); return S.meta ? S.meta(mints) : {}; },
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
beforeEach(async () => {
  resetStubs();
  restore(dbStub, dbBase);
  restore(geckoStub, geckoBase);
  restore(jupiterStub, jupiterBase);
  await cache.clear?.();
});

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

describe('GET /api/tokens list cache and cost bounds', () => {
  const page = (from, n, extra = {}) => Array.from({ length: n }, (_, i) => ({ ...tok(from + i), logoUri: null, ...extra }));

  test('sort/order/limit/offset variations reuse one list and ask Helius about each mint once', async () => {
    S.helius = true;
    S.trendingPages = { 1: page(10, 20), 2: page(40, 20) };
    const windows = [
      '?limit=10&offset=0', '?limit=10&offset=0&sort=price&order=asc', '?limit=37&offset=3',
      '?limit=20&offset=20&sort=marketCap', '?limit=5&offset=33', '?limit=40&offset=0&order=asc'
    ];
    for (const w of windows) {
      const r = await get('/api/tokens' + w);
      assert.strictEqual(r.status, 200);
    }
    const asked = S.metaCalls.flat();
    assert.strictEqual(asked.length, new Set(asked).size, 'no mint is sent to Helius twice');
    assert.strictEqual(asked.length, 40);
    // A single list key per filter, not one per window
    const listKeys = (await cache.scanKeys('list:*')).filter(k => k.includes('trending'));
    assert.deepStrictEqual(listKeys, ['list:gecko-trending:0']);
  });

  test('short Gecko pages: later windows fetch more pages instead of coming back short', async () => {
    // Each page yields 16 tokens after skipped pools
    S.trendingPages = { 1: page(10, 16), 2: page(30, 16), 3: page(50, 16), 4: page(70, 16) };
    const all = await get('/api/tokens?limit=60&offset=0');
    assert.strictEqual(all.body.length, 60);
    const third = await get('/api/tokens?limit=20&offset=40');
    assert.deepStrictEqual(third.body.map(t => t.address), all.body.slice(40, 60).map(t => t.address));
    assert.strictEqual(S.jupiterCalls, 0);
  });

  test('a window past the end of the Gecko list is empty, not a Jupiter page', async () => {
    S.trendingPages = { 1: page(10, 20) };
    const r = await get('/api/tokens?limit=20&offset=40');
    assert.deepStrictEqual(r.body, []);
    assert.strictEqual(S.jupiterCalls, 0);
  });

  test('gainers: consecutive pages slice one ranking (no repeats, no gaps)', async () => {
    let n = 0;
    S.trendingPages = {};
    for (let p = 1; p <= 5; p++) {
      S.trendingPages[p] = page(p * 20, 20).map(t => ({ ...t, priceChange24h: ((n++ * 37) % 100) - 50 }));
    }
    const first = await get('/api/tokens?filter=gainers&limit=20&offset=0');
    const second = await get('/api/tokens?filter=gainers&limit=20&offset=20');
    const a = first.body.map(t => t.address);
    const b = second.body.map(t => t.address);
    assert.strictEqual(a.length, 20);
    assert.strictEqual(b.length, 20);
    assert.ok(!a.some(x => b.includes(x)), 'no token on both pages');
    const minFirst = Math.min(...first.body.map(t => t.priceChange24h));
    const maxSecond = Math.max(...second.body.map(t => t.priceChange24h));
    assert.ok(minFirst >= maxSecond, 'page 1 outranks page 2');
  });

  test('an empty result (Gecko and Jupiter both empty) is not cached', async () => {
    const empty = await get('/api/tokens?filter=trending');
    assert.deepStrictEqual(empty.body, []);
    S.trendingPages = { 1: page(10, 20) };
    const after = await get('/api/tokens?filter=trending');
    assert.strictEqual(after.body.length, 20);
  });

  test('most_viewed returns DECIMAL columns as numbers', async () => {
    dbStub.getMostViewedTokens = async () => [{ token_mint: CURATED, view_count: 3 }];
    dbStub.getTokensBatch = async () => [{
      mint_address: CURATED, name: 'Cult', symbol: 'CULT', price: '0.00012300',
      volume_24h: '15234.5', price_change_24h: '1.5', market_cap: '1000'
    }];
    const r = await get('/api/tokens?filter=most_viewed');
    assert.strictEqual(r.body[0].price, 0.000123);
    assert.strictEqual(r.body[0].volume24h, 15234.5);
  });
});

describe('POST /api/tokens/batch', () => {
  const postJson = (p, body) => fetch(base + p, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  }).then(async r => ({ status: r.status, body: await r.json() }));

  test('unknown non-curated mints cost no Helius/Gecko call and are not cached', async () => {
    S.helius = true;
    let geckoAsked = null;
    geckoStub.getMultiTokenInfo = async (m) => { geckoAsked = m; return {}; };
    dbStub.getTokensBatch = async () => [];
    const r = await postJson('/api/tokens/batch', { mints: [OTHER, WALLET] });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.length, 2);
    assert.deepStrictEqual(S.metaCalls, []);
    assert.strictEqual(geckoAsked, null);
    assert.strictEqual(await cache.get(`batch:${OTHER}`), undefined);
  });

  test('a curated mint with no DB row gets Gecko market data next to its Helius name', async () => {
    S.helius = true;
    S.meta = () => ({ [CURATED]: { name: 'Cult', symbol: 'CULT', logoUri: 'l' } });
    geckoStub.getMultiTokenInfo = async () => ({ [CURATED]: { name: 'Cult', price: 2, marketCap: 500 } });
    dbStub.getTokensBatch = async () => [];
    const r = await postJson('/api/tokens/batch', { mints: [CURATED] });
    assert.strictEqual(r.body[0].name, 'Cult');
    assert.strictEqual(r.body[0].price, 2);
    assert.strictEqual(r.body[0].marketCap, 500);
  });

  test('entries built while the DB read failed are served but not cached', async () => {
    dbStub.getTokensBatch = async () => { throw new Error('pool timeout'); };
    const r = await postJson('/api/tokens/batch', { mints: [CURATED] });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(await cache.get(`batch:${CURATED}`), undefined);
    dbStub.getTokensBatch = async () => [{ mint_address: CURATED, name: 'Cult', symbol: 'CULT', logo_uri: 'l', price: '3' }];
    const again = await postJson('/api/tokens/batch', { mints: [CURATED] });
    assert.strictEqual(again.body[0].price, 3);
  });
});

describe('GET /api/tokens/leaderboard/conviction', () => {
  test('a failed DB read is a 500 and is not cached as an empty board', async () => {
    dbStub.getTopConvictionTokens = async () => { throw new Error('statement timeout'); };
    const bad = await get('/api/tokens/leaderboard/conviction?limit=100&offset=0');
    assert.strictEqual(bad.status, 500);
    dbStub.getTopConvictionTokens = async () => ({ tokens: [{ mint_address: CURATED, name: 'Cult', symbol: 'CULT' }], total: 1 });
    const good = await get('/api/tokens/leaderboard/conviction?limit=100&offset=0');
    assert.strictEqual(good.status, 200);
    assert.strictEqual(good.body.tokens.length, 1);
  });
});

describe('GET /api/tokens/leaderboard/watchlist', () => {
  test('unnamed mints are looked up on Helius once across offsets; offset is bounded', async () => {
    S.helius = true;
    const offsets = [];
    dbStub.getMostWatchlistedTokens = async (limit, offset) => {
      offsets.push(offset);
      return { tokens: [{ token_mint: OTHER, watchlist_count: '2' }], total: 1 };
    };
    await get('/api/tokens/leaderboard/watchlist?offset=1');
    await get('/api/tokens/leaderboard/watchlist?offset=2');
    await get('/api/tokens/leaderboard/watchlist?offset=999999');
    assert.strictEqual(S.metaCalls.length, 1);
    assert.ok(Math.max(...offsets) <= 1000);
  });
});

describe('GET /api/tokens/search', () => {
  test('dex=1 leaves out Jupiter results (they carry no DEX)', async () => {
    geckoStub.searchTokens = async () => [{ address: addr(20), name: 'Ray' }];
    jupiterStub.searchTokens = async () => [{ address: addr(21), name: 'Orca only' }];
    const r = await get('/api/tokens/search?q=bonk&dex=1');
    assert.deepStrictEqual(r.body.map(t => t.address), [addr(20)]);
    const all = await get('/api/tokens/search?q=bonk');
    assert.ok(all.body.some(t => t.address === addr(21)));
  });

  test('an exact-address search stores only curated mints in the tokens table', async () => {
    const upserts = [];
    dbStub.getToken = async () => null;
    dbStub.upsertToken = async (t) => { upserts.push(t.mintAddress); };
    jupiterStub.getTokenInfo = async (m) => ({ name: `Name ${m.slice(0, 4)}`, symbol: 'X' });
    await get(`/api/tokens/search?q=${OTHER}`);
    await get(`/api/tokens/search?q=${CURATED}`);
    await new Promise(r => setImmediate(r));
    assert.deepStrictEqual(upserts, [CURATED]);
  });
});

describe('GET /api/tokens/spikes', () => {
  test('trending tokens carry their pool age, and one scan serves every minAge', async () => {
    const day = 86400000;
    S.trendingPages = {
      1: [
        { ...tok(10), pairCreatedAt: new Date(Date.now() - 10 * day).toISOString(), volume24h: 100, marketCap: 50 },
        { ...tok(11), pairCreatedAt: new Date(Date.now() - 3 * day).toISOString(), volume24h: 10, marketCap: 50 },
        { ...tok(12), pairCreatedAt: new Date(Date.now() - 3600000).toISOString() }
      ]
    };
    const one = await get('/api/tokens/spikes');
    assert.deepStrictEqual(one.body.tokens.map(t => t.address).sort(), [addr(10), addr(11)].sort());
    const callsAfterFirst = S.geckoCalls.length;
    const five = await get('/api/tokens/spikes?minAge=5&limit=10');
    assert.deepStrictEqual(five.body.tokens.map(t => t.address), [addr(10)]);
    assert.strictEqual(five.body.totalEstablished, 1);
    assert.strictEqual(S.geckoCalls.length, callsAfterFirst);
  });

  test('an empty scan is not cached', async () => {
    const empty = await get('/api/tokens/spikes');
    assert.deepStrictEqual(empty.body.tokens, []);
    S.trendingPages = { 1: [{ ...tok(10), pairCreatedAt: new Date(Date.now() - 5 * 86400000).toISOString() }] };
    const after = await get('/api/tokens/spikes');
    assert.strictEqual(after.body.tokens.length, 1);
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
