/**
 * The holder metric math behind diamond hands and holder behaviour.
 *
 * These pin down current behaviour, quirks included, so the holder pipeline rebuild
 * can change it on purpose rather than by accident. Where a test documents a quirk
 * rather than a design choice, it says so.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { computeHoldPairs, buildDiamondHandsResult, HB_EXCLUDED_MINTS } = require('./holderMetrics');
const { DIAMOND_HANDS_BUCKETS } = require('../constants');

const WALLET = 'Wa11et1111111111111111111111111111111111111';
const OTHER  = 'Other11111111111111111111111111111111111111';
const MINT   = 'Mint111111111111111111111111111111111111111';
const MINT_B = 'MintB11111111111111111111111111111111111111';
const USDC   = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const HOUR = 3_600_000;
const DAY  = 24 * HOUR;
const NOW  = 1_800_000_000_000; // fixed "now" in ms

// Helius-style swap tx: timestamp in seconds, transfers in or out of WALLET.
const buy  = (sec, mint = MINT, amount = 100) => ({ timestamp: sec, tokenTransfers: [{ mint, fromUserAccount: OTHER, toUserAccount: WALLET, tokenAmount: amount }] });
const sell = (sec, mint = MINT, amount = 100) => ({ timestamp: sec, tokenTransfers: [{ mint, fromUserAccount: WALLET, toUserAccount: OTHER, tokenAmount: amount }] });

describe('computeHoldPairs', () => {
  test('empty input yields no pairs', () => {
    assert.deepStrictEqual(computeHoldPairs(WALLET, [], NOW), {});
  });

  test('tx with no tokenTransfers is ignored', () => {
    assert.deepStrictEqual(computeHoldPairs(WALLET, [{ timestamp: 1000 }], NOW), {});
  });

  test('buy then sell gives one closed pair, timestamps converted to ms', () => {
    const pairs = computeHoldPairs(WALLET, [buy(1000), sell(4600)], NOW);
    assert.deepStrictEqual(pairs, {
      [MINT]: [{ type: 'sold', buyTime: 1_000_000, sellTime: 4_600_000, holdTime: HOUR }]
    });
  });

  test('unsold buy is holding, with holdTime measured to now', () => {
    const buySec = (NOW - 3 * DAY) / 1000;
    const pairs = computeHoldPairs(WALLET, [buy(buySec)], NOW);
    assert.deepStrictEqual(pairs[MINT], [
      { type: 'holding', buyTime: NOW - 3 * DAY, sellTime: null, holdTime: 3 * DAY }
    ]);
  });

  test('input order does not matter (sorted by timestamp)', () => {
    const ordered  = computeHoldPairs(WALLET, [buy(1000), sell(2000), buy(3000)], NOW);
    const shuffled = computeHoldPairs(WALLET, [buy(3000), sell(2000), buy(1000)], NOW);
    assert.deepStrictEqual(shuffled, ordered);
  });

  test('sold and re-bought: closed pair for the first round, holding for the re-buy', () => {
    const pairs = computeHoldPairs(WALLET, [buy(1000), sell(2000), buy(3000)], NOW);
    assert.deepStrictEqual(pairs[MINT], [
      { type: 'sold', buyTime: 1_000_000, sellTime: 2_000_000, holdTime: 1_000_000 },
      { type: 'holding', buyTime: 3_000_000, sellTime: null, holdTime: NOW - 3_000_000 }
    ]);
  });

  test('two buys then one sell: FIFO closes the oldest buy, newer stays holding', () => {
    const pairs = computeHoldPairs(WALLET, [buy(1000, MINT, 100), buy(2000, MINT, 50), sell(5000, MINT, 50)], NOW);
    assert.deepStrictEqual(pairs[MINT], [
      { type: 'sold', buyTime: 1_000_000, sellTime: 5_000_000, holdTime: 4_000_000 },
      { type: 'holding', buyTime: 2_000_000, sellTime: null, holdTime: NOW - 2_000_000 }
    ]);
  });

  // Quirk: matching is per transfer, not per amount. One buy split across two partial
  // sells closes on the first sell; the second has no buy left and gets a null holdTime.
  test('partial sells of one buy: first sell closes it, second has no buy (amount-blind)', () => {
    const pairs = computeHoldPairs(WALLET, [buy(1000, MINT, 100), sell(2000, MINT, 40), sell(3000, MINT, 60)], NOW);
    assert.deepStrictEqual(pairs[MINT], [
      { type: 'sold', buyTime: 1_000_000, sellTime: 2_000_000, holdTime: 1_000_000 },
      { type: 'sold', buyTime: null, sellTime: 3_000_000, holdTime: null }
    ]);
  });

  test('sell with no prior buy in the window has null buyTime and holdTime', () => {
    const pairs = computeHoldPairs(WALLET, [sell(2000)], NOW);
    assert.deepStrictEqual(pairs[MINT], [
      { type: 'sold', buyTime: null, sellTime: 2_000_000, holdTime: null }
    ]);
  });

  test('excluded mints (SOL, stables, LSTs) are dropped per transfer, other legs kept', () => {
    assert.ok(HB_EXCLUDED_MINTS.has(USDC));
    // Token -> USDC swap: the token leg counts as a sell, the USDC leg is ignored.
    const swap = {
      timestamp: 2000,
      tokenTransfers: [
        { mint: MINT, fromUserAccount: WALLET, toUserAccount: OTHER, tokenAmount: 100 },
        { mint: USDC, fromUserAccount: OTHER, toUserAccount: WALLET, tokenAmount: 5 }
      ]
    };
    const pairs = computeHoldPairs(WALLET, [buy(1000), swap], NOW);
    assert.deepStrictEqual(Object.keys(pairs), [MINT]);
    assert.strictEqual(pairs[MINT][0].type, 'sold');
  });

  test('zero, negative or missing amounts and missing mint are ignored', () => {
    const txs = [
      buy(1000, MINT, 0),
      buy(1000, MINT, -5),
      buy(1000, MINT, '0'),
      { timestamp: 1000, tokenTransfers: [{ mint: MINT, fromUserAccount: OTHER, toUserAccount: WALLET }] },
      { timestamp: 1000, tokenTransfers: [{ fromUserAccount: OTHER, toUserAccount: WALLET, tokenAmount: 10 }] }
    ];
    assert.deepStrictEqual(computeHoldPairs(WALLET, txs, NOW), {});
  });

  test('string amounts are accepted', () => {
    const pairs = computeHoldPairs(WALLET, [buy(1000, MINT, '12.5')], NOW);
    assert.strictEqual(pairs[MINT].length, 1);
  });

  test('transfers not involving the wallet are ignored', () => {
    const tx = { timestamp: 1000, tokenTransfers: [{ mint: MINT, fromUserAccount: OTHER, toUserAccount: 'Someone', tokenAmount: 10 }] };
    assert.deepStrictEqual(computeHoldPairs(WALLET, [tx], NOW), {});
  });

  test('mints are tracked independently', () => {
    const pairs = computeHoldPairs(WALLET, [buy(1000, MINT), buy(1500, MINT_B), sell(2000, MINT_B)], NOW);
    assert.strictEqual(pairs[MINT][0].type, 'holding');
    assert.deepStrictEqual(pairs[MINT_B], [
      { type: 'sold', buyTime: 1_500_000, sellTime: 2_000_000, holdTime: 500_000 }
    ]);
  });

  test('defaults now to Date.now() when not given', () => {
    const buySec = Math.floor(Date.now() / 1000) - 10;
    const before = Date.now();
    const pairs = computeHoldPairs(WALLET, [buy(buySec)]);
    const after = Date.now();
    const { holdTime } = pairs[MINT][0];
    assert.ok(holdTime >= before - buySec * 1000 && holdTime <= after - buySec * 1000, `${holdTime}`);
  });
});

describe('buildDiamondHandsResult', () => {
  const bucketMs = Object.fromEntries(DIAMOND_HANDS_BUCKETS.map(b => [b.key, b.ms]));

  test('empty hold times gives a null distribution but keeps the counts', () => {
    assert.deepStrictEqual(buildDiamondHandsResult({}, 50, 0), {
      distribution: null, sampleSize: 50, analyzed: 0, computed: true
    });
  });

  test('every bucket is present in the distribution', () => {
    const { distribution } = buildDiamondHandsResult({ a: HOUR }, 1, 1);
    assert.deepStrictEqual(Object.keys(distribution), DIAMOND_HANDS_BUCKETS.map(b => b.key));
  });

  test('threshold is inclusive: exactly 6h counts as >6h, 1ms less does not', () => {
    const at    = buildDiamondHandsResult({ a: bucketMs['6h'] }, 1, 1).distribution;
    const under = buildDiamondHandsResult({ a: bucketMs['6h'] - 1 }, 1, 1).distribution;
    assert.strictEqual(at['6h'], 100);
    assert.strictEqual(at['24h'], 0);
    assert.strictEqual(under['6h'], 0);
  });

  test('every bucket boundary is inclusive', () => {
    for (const b of DIAMOND_HANDS_BUCKETS) {
      assert.strictEqual(buildDiamondHandsResult({ a: b.ms }, 1, 1).distribution[b.key], 100, b.key);
      assert.strictEqual(buildDiamondHandsResult({ a: b.ms - 1 }, 1, 1).distribution[b.key], 0, b.key);
    }
  });

  test('buckets are cumulative and percentages round to one decimal', () => {
    const holdTimes = { a: HOUR, b: 2 * DAY, c: 400 * DAY };
    const { distribution } = buildDiamondHandsResult(holdTimes, 10, 3);
    assert.strictEqual(distribution['6h'], 66.7);  // b, c
    assert.strictEqual(distribution['24h'], 66.7);
    assert.strictEqual(distribution['3d'], 33.3);  // c
    assert.strictEqual(distribution['1yr'], 33.3);
  });

  test('denominator is wallets with data, not sampleSize or analyzed', () => {
    const { distribution, sampleSize, analyzed } = buildDiamondHandsResult({ a: 2 * DAY, b: HOUR }, 50, 40);
    assert.strictEqual(distribution['24h'], 50);
    assert.strictEqual(sampleSize, 50);
    assert.strictEqual(analyzed, 40);
  });

  test('distribution is monotonically non-increasing across buckets', () => {
    const holdTimes = {};
    for (let i = 0; i < 37; i++) holdTimes[`w${i}`] = i * 11 * DAY + i * HOUR;
    const { distribution } = buildDiamondHandsResult(holdTimes, 37, 37);
    const vals = DIAMOND_HANDS_BUCKETS.map(b => distribution[b.key]);
    for (let i = 1; i < vals.length; i++) assert.ok(vals[i] <= vals[i - 1], `${vals}`);
  });
});
