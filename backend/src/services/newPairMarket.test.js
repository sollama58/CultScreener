/**
 * Cheap-tier mapping and schedules (pure parts): what we keep from a Jupiter or
 * DexScreener row, the floors, and when a below-floor token gets another look.
 */
const { test } = require('node:test');
const assert = require('node:assert');

const { mapJupiter, mapDexScreener, parseFloors, aboveFloors, nextRecheck, DEFAULT_FLOORS } = require('./newPairMarket');

const MINT = '8gVYRsYzTY1yDz4e7dhQocvkwFCri3mgpmrrVcVZpump';
const HOUR = 3_600_000;

// Shape read off lite-api.jup.ag/tokens/v2/search on 2026-11-12
const JUP_ROW = {
  id: MINT, name: '  Haaland Hair ', symbol: 'HALH', icon: 'https://static.datapi.jup.ag/token-icons/x.webp', decimals: 6,
  dev: 'AaZvkVSGSzrfJ6zpUq58QfwFHTpEBWUa1nou7vA9Qjs1', circSupply: 1e9, totalSupply: 2e9,
  tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', launchpad: 'pump.fun',
  graduatedPool: '8KY9gyM6z5hQK33vYJSojGwu5Bd2vP8YJ5yyJLu1CqeT', graduatedAt: '2026-11-12T00:56:20Z',
  holderCount: 1500, fdv: 80000, mcap: 40000, usdPrice: 0.00004, liquidity: 9000,
  stats5m: { volumeChange: -100 },
  stats1h: { priceChange: -12.5, holderChange: 150, buyVolume: 1123.05, sellVolume: 1128.87, numBuys: 498, numSells: 461, numTraders: 53, numNetBuyers: 18, injected: '<script>' },
  audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, topHoldersPercentage: 10.69, devMigrations: 13, devMints: 159 },
  organicScore: 0, organicScoreLabel: 'low', tags: ['token-2022'],
};

test('mapJupiter keeps the documented fields and nothing else', () => {
  const r = mapJupiter(JUP_ROW);
  assert.strictEqual(r.mint, MINT);
  assert.strictEqual(r.name, 'Haaland Hair');
  assert.strictEqual(r.jupLaunchpad, 'pump.fun');
  assert.strictEqual(r.mcap, 40000);
  assert.strictEqual(r.liquidity, 9000);
  assert.strictEqual(r.holderCount, 1500);
  assert.strictEqual(r.graduatedPool, '8KY9gyM6z5hQK33vYJSojGwu5Bd2vP8YJ5yyJLu1CqeT');
  assert.deepStrictEqual(r.market.stats['1h'], { priceChange: -12.5, holderChange: 150, buyVolume: 1123.05, sellVolume: 1128.87, numBuys: 498, numSells: 461, numTraders: 53, numNetBuyers: 18 });
  assert.deepStrictEqual(r.market.stats['5m'], { volumeChange: -100 });
  assert.strictEqual(r.market.stats['6h'], undefined);
  assert.deepStrictEqual(r.market.audit, { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, topHoldersPercentage: 10.69, devBalancePercentage: null, devMigrations: 13, devMints: 159 });
  assert.strictEqual(r.market.circSupply, 1e9);
});

test('mapJupiter treats creator-written and malformed fields as untrusted', () => {
  const r = mapJupiter({
    id: MINT, name: 'x'.repeat(500), symbol: 42, icon: 'javascript:alert(1)', decimals: 99, dev: 'not an address',
    launchpad: { a: 1 }, usdPrice: -1, mcap: 'big', fdv: 123, liquidity: Infinity, holderCount: 12.5,
    stats1h: 'nope', audit: { mintAuthorityDisabled: 'yes', topHoldersPercentage: '50' },
  });
  assert.strictEqual(r.name.length, 100);
  assert.strictEqual(r.symbol, null);
  assert.strictEqual(r.logoUri, null);
  assert.strictEqual(r.decimals, null);
  assert.strictEqual(r.devWallet, null);
  assert.strictEqual(r.jupLaunchpad, null);
  assert.strictEqual(r.price, null);
  assert.strictEqual(r.mcap, 123); // falls back to fdv
  assert.strictEqual(r.liquidity, null);
  assert.strictEqual(r.holderCount, null);
  assert.deepStrictEqual(r.market.stats, {});
  assert.strictEqual(r.market.audit.mintAuthorityDisabled, null);
  assert.strictEqual(r.market.audit.topHoldersPercentage, null);
  assert.strictEqual(mapJupiter({ id: '<img>' }).mint, null);
  assert.strictEqual(mapJupiter({ id: MINT, icon: 'https://ok.example/a.png"onerror="x' }).logoUri, null);
});

test('mapDexScreener takes each mint\'s deepest pool and carries no holder data', () => {
  const pair = (liq, price, extra = {}) => ({
    baseToken: { address: MINT }, priceUsd: String(price), liquidity: { usd: liq }, marketCap: 50000, fdv: 99999,
    txns: { h1: { buys: 272, sells: 245 } }, volume: { h1: 620.9, m5: 0 }, priceChange: { h1: -98.36 }, ...extra,
  });
  const map = mapDexScreener([pair(100, 1), pair(9000, 2), pair(50, 3), { baseToken: { address: 'bad' } }, null]);
  assert.strictEqual(map.size, 1);
  const r = map.get(MINT);
  assert.strictEqual(r.price, 2);
  assert.strictEqual(r.liquidity, 9000);
  assert.strictEqual(r.mcap, 50000);
  assert.deepStrictEqual(r.market.stats['1h'], { priceChange: -98.36, volume: 620.9, numBuys: 272, numSells: 245 });
  assert.deepStrictEqual(r.market.stats['5m'], { volume: 0 });
  assert.strictEqual('holderCount' in r, false);
  assert.strictEqual(mapDexScreener({ error: 'nope' }).size, 0);
  assert.strictEqual(mapDexScreener([pair(1, 'abc', { marketCap: undefined })]).get(MINT).mcap, 99999);
  assert.strictEqual(mapDexScreener([pair(1, 'abc')]).get(MINT).price, null);
});

test('floors: defaults, admin overrides, and bad settings ignored', () => {
  assert.deepStrictEqual(parseFloors(null), DEFAULT_FLOORS);
  assert.deepStrictEqual(parseFloors('not json'), DEFAULT_FLOORS);
  assert.deepStrictEqual(parseFloors('{"minMcap":50000}'), { minMcap: 50000, minLiquidity: 5000 });
  assert.deepStrictEqual(parseFloors('{"minMcap":-1,"minLiquidity":"9"}'), DEFAULT_FLOORS);
  assert.strictEqual(aboveFloors({ mcap: 25000, liquidity: 5000 }, DEFAULT_FLOORS), true);
  assert.strictEqual(aboveFloors({ mcap: 24999, liquidity: 5000 }, DEFAULT_FLOORS), false);
  assert.strictEqual(aboveFloors({ mcap: 1e6, liquidity: null }, DEFAULT_FLOORS), false);
});

test('nextRecheck: +1h, +6h, +24h, +3d after graduation, then nothing', () => {
  const g = Date.UTC(2026, 10, 1);
  assert.deepStrictEqual(nextRecheck(g, g + 5 * 60_000), { step: 0, at: g + HOUR });
  assert.deepStrictEqual(nextRecheck(g, g + HOUR), { step: 1, at: g + 6 * HOUR });
  assert.deepStrictEqual(nextRecheck(g, g + 7 * HOUR), { step: 2, at: g + 24 * HOUR });
  assert.deepStrictEqual(nextRecheck(g, g + 30 * HOUR), { step: 3, at: g + 72 * HOUR });
  assert.strictEqual(nextRecheck(g, g + 72 * HOUR), null);
});
