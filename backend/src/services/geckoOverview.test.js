/**
 * getTokenOverview / getOHLCV / getTokenPools against a token whose deepest pool is ZEC / TOKEN.
 * GeckoTerminal is stubbed at axios.create with documented response shapes; nothing here
 * reaches the live API.
 */
const { test, describe, before } = require('node:test');
const assert = require('node:assert');
const axios = require('axios');

const TOKEN = 'Foo1111111111111111111111111111111111111111';
const ZEC = 'A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS';
const SOL = 'So11111111111111111111111111111111111111112';

const pool = (address, base, quote, name, a) => ({
  id: `solana_${address}`, type: 'pool',
  attributes: { address, name, pool_created_at: '2026-09-01T00:00:00Z', ...a },
  relationships: {
    base_token: { data: { id: `solana_${base}`, type: 'token' } },
    quote_token: { data: { id: `solana_${quote}`, type: 'token' } },
    dex: { data: { id: 'raydium', type: 'dex' } }
  }
});

// GeckoTerminal's own order puts the busy thin SOL pool first
const POOLS = [
  pool('PoolSol', TOKEN, SOL, 'FOO / SOL', {
    base_token_price_usd: '0.00209', quote_token_price_usd: '150', reserve_in_usd: '8000',
    volume_usd: { h24: '90000' }, price_change_percentage: { h24: '-12.5' }, fdv_usd: '2090000', market_cap_usd: null,
    pool_created_at: '2026-08-01T00:00:00Z'
  }),
  pool('PoolZec', ZEC, TOKEN, 'ZEC / FOO', {
    base_token_price_usd: '45.1', quote_token_price_usd: '0.0021', reserve_in_usd: '250000',
    volume_usd: { h24: '40000' }, price_change_percentage: { h24: '3.2' }, fdv_usd: '730000000', market_cap_usd: '650000000'
  })
];

// A token that only ever trades as the quote: GeckoTerminal publishes no 24h change for it
const QUOTE_ONLY = 'Bar1111111111111111111111111111111111111111';
const QUOTE_ONLY_POOLS = [
  pool('PoolZecBar', ZEC, QUOTE_ONLY, 'ZEC / BAR', {
    base_token_price_usd: '45.1', quote_token_price_usd: '0.5', reserve_in_usd: '250000',
    volume_usd: { h24: '40000' }, price_change_percentage: { h24: '3.2' }, fdv_usd: '730000000', market_cap_usd: '650000000'
  })
];

// A token GeckoTerminal does not index (every request 404s), and one whose requests fail
// transiently (502) until flakyFails is cleared
const MISSING = 'Mis1111111111111111111111111111111111111111';
const FLAKY = 'Fla1111111111111111111111111111111111111111';
let flakyFails = true;
let flakyCalls = 0;

const calls = [];
let gecko;

before(() => {
  const realCreate = axios.create;
  axios.create = (cfg) => {
    const inst = realCreate.call(axios, cfg);
    inst.get = async (url, opts = {}) => {
      calls.push({ url, params: opts.params });
      if (url.endsWith(`/tokens/${TOKEN}/pools`)) return { data: { data: POOLS } };
      if (url.endsWith(`/tokens/${QUOTE_ONLY}/pools`)) return { data: { data: QUOTE_ONLY_POOLS } };
      if (url.endsWith(`/tokens/${QUOTE_ONLY}`)) {
        return { data: { data: { id: `solana_${QUOTE_ONLY}`, type: 'token', attributes: {
          address: QUOTE_ONLY, name: 'Bar', symbol: 'BAR', decimals: 6, price_usd: '0.5',
          fdv_usd: '500000', market_cap_usd: null, total_supply: '1000000000000', volume_usd: { h24: '40000' }
        } } } };
      }
      if (url.endsWith(`/tokens/${TOKEN}`)) {
        return { data: { data: { id: `solana_${TOKEN}`, type: 'token', attributes: {
          address: TOKEN, name: 'Foo', symbol: 'FOO', decimals: 6, price_usd: '0.0021',
          fdv_usd: '2100000', market_cap_usd: null, total_supply: '1000000000000000', volume_usd: { h24: '130000' }
        } } } };
      }
      if (url.includes('/pools/PoolZec/ohlcv/')) {
        return { data: { data: { attributes: { ohlcv_list: [[1790000000, 0.002, 0.0022, 0.0019, 0.0021, 500]] } } } };
      }
      if (url.includes(FLAKY)) {
        flakyCalls++;
        if (flakyFails) throw Object.assign(new Error('Bad Gateway'), { response: { status: 502 } });
        return { data: { data: POOLS.map(p => ({ ...p, relationships: { ...p.relationships,
          base_token: p.id === 'solana_PoolSol' ? { data: { id: `solana_${FLAKY}` } } : p.relationships.base_token,
          quote_token: p.id === 'solana_PoolZec' ? { data: { id: `solana_${SOL}` } } : p.relationships.quote_token } })) } };
      }
      throw Object.assign(new Error(`unexpected ${url}`), { response: { status: 404 } });
    };
    return inst;
  };
  gecko = require('./geckoTerminal');
  // No COINGECKO_API_KEY here, so the limiter is paced for the free API; requests are stubbed
  Object.assign(require('./rateLimiter').RATE_LIMITS.geckoTerminal, { minInterval: 0, maxJitter: 0, burstLimit: 1000 });
});

describe('token whose deepest pool is ZEC / TOKEN', () => {
  test('overview prices the token, not ZEC', async () => {
    const o = await gecko.getTokenOverview(TOKEN);
    assert.strictEqual(o.price, 0.0021);
    assert.strictEqual(o.poolSide, 'quote');
    assert.strictEqual(o.poolAddress, 'PoolZec');
    assert.strictEqual(o.liquidity, 250000);
    assert.strictEqual(o.fdv, 2100000, 'FDV from the token endpoint, not ZEC\'s 730M');
    assert.strictEqual(o.marketCap, 2100000);
    assert.strictEqual(o.priceChange24h, -12.5, '24h change from the pool where FOO is the base');
    assert.strictEqual(o.volume24h, 130000, 'volume across both pools');
    assert.strictEqual(o.symbol, 'FOO');
    assert.strictEqual(o.pairCreatedAt, '2026-08-01T00:00:00Z');
  });

  test('OHLCV charts the ZEC pool from the token side', async () => {
    const r = await gecko.getOHLCV(TOKEN, { interval: '1h', limit: 100 });
    assert.strictEqual(r.poolAddress, 'PoolZec');
    const call = calls.find(c => c.url.includes('/ohlcv/'));
    assert.strictEqual(call.params.token, 'quote');
    assert.strictEqual(call.params.currency, 'usd');
    assert.strictEqual(r.data[0].close, 0.0021);
  });

  test('pools list is deepest first and priced from the token side', async () => {
    const pools = await gecko.getTokenPools(TOKEN, { limit: 10 });
    assert.deepStrictEqual(pools.map(p => p.address), ['PoolZec', 'PoolSol']);
    assert.strictEqual(pools[0].priceUsd, 0.0021);
    assert.strictEqual(pools[0].side, 'quote');
    assert.strictEqual(pools[0].priceChange24h, null);
    assert.strictEqual(pools[1].priceUsd, 0.00209);
  });

  test('overview, OHLCV and pools share one pools-page request', () => {
    const poolsCalls = calls.filter(c => c.url.endsWith(`/tokens/${TOKEN}/pools`));
    assert.strictEqual(poolsCalls.length, 1);
  });
});

describe('token that only trades as the quote', () => {
  test('overview reports an unknown 24h change, not 0% and not ZEC\'s change', async () => {
    const o = await gecko.getTokenOverview(QUOTE_ONLY);
    assert.strictEqual(o.price, 0.5);
    assert.strictEqual(o.poolSide, 'quote');
    assert.strictEqual(o.priceChange24h, null);
  });
});

describe('failures', () => {
  test('a token GeckoTerminal does not index is null, and remembered', async () => {
    assert.strictEqual(await gecko.getTokenOverview(MISSING), null);
    const n = calls.length;
    assert.strictEqual(await gecko.getTokenOverview(MISSING), null);
    assert.strictEqual(calls.length, n, 'second lookup answered from the error cache');
  });

  test('a transient failure is thrown, not error-cached, so the next request recovers', async () => {
    await assert.rejects(gecko.getTokenOverview(FLAKY), /Bad Gateway/);
    flakyFails = false;
    const o = await gecko.getTokenOverview(FLAKY);
    assert.ok(o && o.price > 0, 'recovered as soon as GeckoTerminal answered');
  });

  test('getTokenInfo: 404 is null, a transient failure is thrown', async () => {
    assert.strictEqual(await gecko.getTokenInfo(MISSING), null);
    flakyFails = true;
    await assert.rejects(gecko.getTokenInfo(FLAKY), /Bad Gateway/);
    flakyFails = false;
  });

  test('OHLCV for a token GeckoTerminal does not index is an empty chart, asked for once', async () => {
    const before = calls.filter(c => c.url.includes(`/tokens/${MISSING}/pools`)).length;
    const first = await gecko.getOHLCV(MISSING, { interval: '1h' });
    const second = await gecko.getOHLCV(MISSING, { interval: '1h' });
    assert.deepStrictEqual(first.data, []);
    assert.strictEqual(first.error, undefined);
    assert.deepStrictEqual(second.data, []);
    const after = calls.filter(c => c.url.includes(`/tokens/${MISSING}/pools`)).length;
    assert.ok(after - before <= 1, `pools requests: ${after - before}`);
  });
});

describe('getMarketData', () => {
  test('reports an unknown 24h change and liquidity, not 0', async () => {
    const m = await gecko.getMarketData(TOKEN);
    assert.strictEqual(m.price, 0.0021);
    assert.strictEqual(m.priceChange24h, null);
    assert.strictEqual(m.liquidity, null);
  });
});
