/**
 * Reading a token's price from pools it may sit on either side of (e.g. a ZEC / TOKEN pair).
 * Fixtures follow the documented GeckoTerminal pool and DexScreener pair shapes.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  geckoPoolSide, geckoPoolView, pickGeckoPool, geckoBaseSideChange, geckoListedToken,
  poolNameSymbol, pickDexScreenerPair, dexScreenerPairPriceUsd
} = require('./poolPricing');

const TOKEN = 'Foo1111111111111111111111111111111111111111';
const ZEC = 'A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS';
const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function geckoPool({ address, base, quote, name, baseUsd, quoteUsd, reserve, vol, change, fdv, mcap, created }) {
  return {
    id: `solana_${address}`,
    type: 'pool',
    attributes: {
      address,
      name,
      base_token_price_usd: String(baseUsd),
      quote_token_price_usd: String(quoteUsd),
      reserve_in_usd: String(reserve),
      volume_usd: { h24: String(vol) },
      price_change_percentage: { h24: String(change) },
      fdv_usd: fdv == null ? null : String(fdv),
      market_cap_usd: mcap == null ? null : String(mcap),
      pool_created_at: created || '2026-09-01T00:00:00Z'
    },
    relationships: {
      base_token: { data: { id: `solana_${base}`, type: 'token' } },
      quote_token: { data: { id: `solana_${quote}`, type: 'token' } },
      dex: { data: { id: 'raydium', type: 'dex' } }
    }
  };
}

// TOKEN's deepest pool lists ZEC as the base; a thinner SOL pool lists TOKEN as the base
const zecPool = geckoPool({
  address: 'PoolZec', base: ZEC, quote: TOKEN, name: 'ZEC / FOO 0.25%',
  baseUsd: 45.1, quoteUsd: 0.0021, reserve: 250000, vol: 40000, change: 3.2, fdv: 730000000, mcap: 650000000
});
const solPool = geckoPool({
  address: 'PoolSol', base: TOKEN, quote: SOL, name: 'FOO / SOL',
  baseUsd: 0.00209, quoteUsd: 150, reserve: 8000, vol: 90000, change: -12.5, fdv: 2090000, mcap: null,
  created: '2026-08-01T00:00:00Z'
});

describe('geckoPoolSide', () => {
  test('finds the token on either side', () => {
    assert.strictEqual(geckoPoolSide(zecPool, TOKEN), 'quote');
    assert.strictEqual(geckoPoolSide(solPool, TOKEN), 'base');
  });
  test('null for a pool that does not contain the token', () => {
    assert.strictEqual(geckoPoolSide(zecPool, SOL), null);
  });
  test('treats a pool without relationships as base, as before', () => {
    assert.strictEqual(geckoPoolSide({ attributes: {} }, TOKEN), 'base');
  });
});

describe('geckoPoolView', () => {
  test('quote side takes the quote price and none of the base-only fields', () => {
    const v = geckoPoolView(zecPool, 'quote');
    assert.strictEqual(v.price, 0.0021);
    assert.strictEqual(v.fdv, null);
    assert.strictEqual(v.marketCap, null);
    assert.strictEqual(v.priceChange24h, null);
    assert.strictEqual(v.liquidity, 250000);
    assert.strictEqual(v.symbol, 'FOO');
  });
  test('base side is unchanged', () => {
    const v = geckoPoolView(solPool, 'base');
    assert.strictEqual(v.price, 0.00209);
    assert.strictEqual(v.fdv, 2090000);
    assert.strictEqual(v.priceChange24h, -12.5);
    assert.strictEqual(v.symbol, 'FOO');
  });
});

describe('pickGeckoPool', () => {
  test('picks by liquidity, not by list order or quote type', () => {
    const picked = pickGeckoPool([solPool, zecPool], TOKEN);
    assert.strictEqual(picked.pool, zecPool);
    assert.strictEqual(picked.side, 'quote');
  });
  test('skips pools that do not contain the token', () => {
    assert.strictEqual(pickGeckoPool([zecPool], SOL), null);
  });
  test('24h change comes from a pool where the token is the base', () => {
    assert.strictEqual(geckoBaseSideChange([zecPool, solPool], TOKEN), -12.5);
    assert.strictEqual(geckoBaseSideChange([zecPool], TOKEN), null);
  });
});

describe('geckoListedToken (trending / new / search rows)', () => {
  test('a SOL / TOKEN pool lists TOKEN at the quote price', () => {
    const p = geckoPool({ address: 'P', base: SOL, quote: TOKEN, name: 'SOL / FOO', baseUsd: 150, quoteUsd: 0.002, reserve: 1, vol: 1, change: 5, fdv: 9e10 });
    const row = geckoListedToken(p);
    assert.strictEqual(row.address, TOKEN);
    assert.strictEqual(row.price, 0.002);
    assert.strictEqual(row.fdv, null, 'SOL FDV must not be reported as the token FDV');
  });
  test('a SOL / USDC pool lists nothing', () => {
    const p = geckoPool({ address: 'P', base: SOL, quote: USDC, name: 'SOL / USDC', baseUsd: 150, quoteUsd: 1, reserve: 1, vol: 1, change: 0 });
    assert.strictEqual(geckoListedToken(p), null);
    assert.strictEqual(geckoListedToken(p, 'sol').address, SOL, 'a search still finds wSOL');
  });
  test('a search for the quote token lists the quote side', () => {
    assert.strictEqual(geckoListedToken(zecPool, 'foo').address, TOKEN);
    assert.strictEqual(geckoListedToken(zecPool, 'zec').address, ZEC);
    assert.strictEqual(geckoListedToken(zecPool).address, ZEC);
  });
});

describe('poolNameSymbol', () => {
  test('strips fee tiers', () => {
    assert.strictEqual(poolNameSymbol('ZEC / FOO 0.25%', 'quote'), 'FOO');
    assert.strictEqual(poolNameSymbol('ZEC / FOO 0.25%', 'base'), 'ZEC');
  });
});

describe('pickDexScreenerPair', () => {
  const pair = (base, quote, liq, priceUsd, priceNative, info) => ({
    chainId: 'solana', pairAddress: `${base}-${quote}`,
    baseToken: { address: base, name: base === TOKEN ? 'Foo' : 'Zcash', symbol: base === TOKEN ? 'FOO' : 'ZEC' },
    quoteToken: { address: quote, name: quote === TOKEN ? 'Foo' : 'Other', symbol: quote === TOKEN ? 'FOO' : 'X' },
    priceUsd: String(priceUsd), priceNative: String(priceNative),
    liquidity: { usd: liq }, info
  });
  const zec = pair(ZEC, TOKEN, 250000, 45.1, 21476, { header: 'zec-banner' });
  const sol = pair(TOKEN, SOL, 8000, 0.00209, 0.0000139, { header: 'foo-banner' });

  test('prefers a pair where the token is the base, even if thinner', () => {
    const picked = pickDexScreenerPair([zec, sol], TOKEN);
    assert.strictEqual(picked.pair, sol);
    assert.strictEqual(picked.side, 'base');
    assert.strictEqual(picked.token.symbol, 'FOO');
  });
  test('quote-only token: names the token itself and prices it from priceNative', () => {
    const picked = pickDexScreenerPair([zec], TOKEN);
    assert.strictEqual(picked.side, 'quote');
    assert.strictEqual(picked.token.symbol, 'FOO');
    const usd = dexScreenerPairPriceUsd(picked.pair, picked.side);
    assert.ok(Math.abs(usd - 45.1 / 21476) < 1e-12);
  });
});
