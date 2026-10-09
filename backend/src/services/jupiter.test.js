/**
 * Jupiter Token API V2 rows name the mint `id` and carry icon / usdPrice / mcap / stats24h.
 * Jupiter is stubbed at axios.create with that documented shape; nothing reaches the live API.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const axios = require('axios');

const MINT = 'Foo1111111111111111111111111111111111111111';

const V2_ROW = {
  id: MINT, name: 'Foo Coin', symbol: 'FOO', icon: 'https://img.example/foo.png', decimals: 6,
  usdPrice: 0.0021, mcap: 2100000, fdv: 2500000, liquidity: 80000, holderCount: 1234,
  stats24h: { priceChange: -4.5, buyVolume: 30000, sellVolume: 20000 }
};

const calls = [];
let jupiter;

before(() => {
  const realCreate = axios.create;
  axios.create = (cfg) => {
    const inst = realCreate.call(axios, cfg);
    inst.get = async (url, opts = {}) => {
      calls.push({ url, params: opts.params });
      if (url === '/tokens/v2/search' || url.startsWith('/tokens/v2/toptrending/')) return { data: [V2_ROW] };
      if (url === '/price/v3') return { data: {} };
      throw Object.assign(new Error(`unexpected ${url}`), { response: { status: 404 } });
    };
    return inst;
  };
  jupiter = require('./jupiter');
  axios.create = realCreate;
});

after(() => jupiter.stopCleanup());

describe('Token API V2 rows', () => {
  test('search returns the mint, logo and market figures', async () => {
    const [t] = await jupiter.searchTokens('foo');
    assert.strictEqual(t.address, MINT);
    assert.strictEqual(t.mintAddress, MINT);
    assert.strictEqual(t.logoUri, V2_ROW.icon);
    assert.strictEqual(t.price, 0.0021);
    assert.strictEqual(t.marketCap, 2100000);
    assert.strictEqual(t.volume24h, 50000);
    assert.strictEqual(t.priceChange24h, -4.5);
    // The V2 search row already carries the market figures, so search makes no /price/v3 call
    assert.strictEqual(calls.find(c => c.url === '/price/v3'), undefined);
  });

  test('getTokenInfo matches the row by id and keeps its name', async () => {
    const info = await jupiter.getTokenInfo(MINT);
    assert.strictEqual(info.name, 'Foo Coin');
    assert.strictEqual(info.address, MINT);
  });

  test('trending rows carry their address and market cap', async () => {
    const [t] = await jupiter.getTrendingTokens({ limit: 10 });
    assert.strictEqual(t.address, MINT);
    assert.strictEqual(t.marketCap, 2100000);
    assert.strictEqual(t.price, 0.0021);
  });
});

describe('price cache sweep (audit #112)', () => {
  test('evicts expired entries and keeps fresh ones', async () => {
    const { sweepPriceCache, priceCache } = jupiter._test;
    priceCache.clear();
    await jupiter.getTokenPrice(MINT);
    priceCache.set('Old1', { data: { price: 1, timestamp: 0 }, expiry: Date.now() - 1 });
    assert.strictEqual(sweepPriceCache(), 1);
    assert.ok(priceCache.has(MINT));
    assert.ok(!priceCache.has('Old1'));
    // Once expired, the fetched entry goes too
    assert.strictEqual(sweepPriceCache(Date.now() + 120000), 1);
    assert.strictEqual(priceCache.size, 0);
  });
});

describe('getTokenInfo for a mint search does not list (audit #113)', () => {
  test('answers the null-name default without a /price/v3 request', async () => {
    const before = calls.filter(c => c.url === '/price/v3').length;
    const info = await jupiter.getTokenInfo('Unl1111111111111111111111111111111111111111');
    assert.strictEqual(info.name, null);
    assert.strictEqual(info.symbol, null);
    assert.strictEqual(calls.filter(c => c.url === '/price/v3').length, before);
  });
});
