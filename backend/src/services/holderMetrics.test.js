/**
 * The holder metric math behind diamond hands and holder behaviour.
 *
 * These pin down behaviour so changes are made on purpose rather than by accident.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { computeHoldPairs, buildStratifiedDiamondHands, swapFromRawTransaction, HB_EXCLUDED_MINTS } = require('./holderMetrics');
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

  test('two buys then one smaller sell: FIFO closes part of the oldest lot, the rest stays open', () => {
    const pairs = computeHoldPairs(WALLET, [buy(1000, MINT, 100), buy(2000, MINT, 50), sell(5000, MINT, 50)], NOW);
    assert.deepStrictEqual(pairs[MINT], [
      { type: 'sold', buyTime: 1_000_000, sellTime: 5_000_000, holdTime: 4_000_000 },
      { type: 'holding', buyTime: 1_000_000, sellTime: null, holdTime: NOW - 1_000_000 },
      { type: 'holding', buyTime: 2_000_000, sellTime: null, holdTime: NOW - 2_000_000 }
    ]);
  });

  test('two buys then one sell of exactly the first lot: oldest closes, newer stays holding', () => {
    const pairs = computeHoldPairs(WALLET, [buy(1000, MINT, 100), buy(2000, MINT, 50), sell(5000, MINT, 100)], NOW);
    assert.deepStrictEqual(pairs[MINT], [
      { type: 'sold', buyTime: 1_000_000, sellTime: 5_000_000, holdTime: 4_000_000 },
      { type: 'holding', buyTime: 2_000_000, sellTime: null, holdTime: NOW - 2_000_000 }
    ]);
  });

  // Was a quirk (amount-blind matching gave the second sell a null holdTime); now
  // matching is by amount, so both partial sells are dated from the one buy.
  test('partial sells of one buy: both sells match the buy by amount', () => {
    const pairs = computeHoldPairs(WALLET, [buy(1000, MINT, 100), sell(2000, MINT, 40), sell(3000, MINT, 60)], NOW);
    assert.deepStrictEqual(pairs[MINT], [
      { type: 'sold', buyTime: 1_000_000, sellTime: 2_000_000, holdTime: 1_000_000 },
      { type: 'sold', buyTime: 1_000_000, sellTime: 3_000_000, holdTime: 2_000_000 }
    ]);
  });

  test('one sell spanning two lots closes both, one pair per lot', () => {
    const pairs = computeHoldPairs(WALLET, [buy(1000, MINT, 30), buy(2000, MINT, 70), sell(4000, MINT, 100)], NOW);
    assert.deepStrictEqual(pairs[MINT], [
      { type: 'sold', buyTime: 1_000_000, sellTime: 4_000_000, holdTime: 3_000_000 },
      { type: 'sold', buyTime: 2_000_000, sellTime: 4_000_000, holdTime: 2_000_000 }
    ]);
  });

  test('sell larger than known lots: matched part dated, the excess has no buy', () => {
    const pairs = computeHoldPairs(WALLET, [buy(1000, MINT, 40), sell(2000, MINT, 100)], NOW);
    assert.deepStrictEqual(pairs[MINT], [
      { type: 'sold', buyTime: 1_000_000, sellTime: 2_000_000, holdTime: 1_000_000 },
      { type: 'sold', buyTime: null, sellTime: 2_000_000, holdTime: null }
    ]);
  });

  test('float amounts that sum to the lot close it without a phantom remainder', () => {
    const pairs = computeHoldPairs(WALLET, [buy(1000, MINT, 0.3), sell(2000, MINT, 0.1), sell(3000, MINT, 0.2)], NOW);
    assert.strictEqual(pairs[MINT].length, 2);
    assert.ok(pairs[MINT].every(p => p.type === 'sold' && p.buyTime === 1_000_000));
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

describe('buildStratifiedDiamondHands', () => {
  const w = (wallet, stratum, amount) => ({ wallet, stratum, amount: String(amount) });

  const one = ms => buildStratifiedDiamondHands([w('a', 'top', 1)], { a: ms }, { top: { population: 1, amount: '1' } }).distribution;

  test('nothing resolved gives null distributions', () => {
    const r = buildStratifiedDiamondHands([w('a', 'top', 10)], {}, { top: { population: 1, amount: '10' } });
    assert.deepStrictEqual(r, { distribution: null, supplyDistribution: null, resolved: 0, resolvedByStratum: {} });
  });

  // Decided in the holder pipeline rebuild: inclusive on purpose (">6h" reads as
  // "6h or more"; at ms resolution the boundary never matters in practice).
  test('every bucket is present and every boundary is inclusive', () => {
    assert.deepStrictEqual(Object.keys(one(HOUR)), DIAMOND_HANDS_BUCKETS.map(b => b.key));
    for (const b of DIAMOND_HANDS_BUCKETS) {
      assert.strictEqual(one(b.ms)[b.key], 100, b.key);
      assert.strictEqual(one(b.ms - 1)[b.key], 0, b.key);
    }
  });

  test('reports how many wallets resolved per stratum', () => {
    const sample = [w('a', 'top', 100), w('b', 'mid', 10), w('c', 'mid', 10), w('d', 'tail', 1)];
    const strata = { top: { population: 1, amount: '100' }, mid: { population: 9, amount: '90' }, tail: { population: 90, amount: '90' } };
    const r = buildStratifiedDiamondHands(sample, { a: DAY, b: DAY, c: HOUR }, strata);
    assert.deepStrictEqual(r.resolvedByStratum, { top: 1, mid: 2 });
    assert.strictEqual(r.resolved, 3);
  });

  test('a single stratum is a plain headcount share; supply view weights by balance', () => {
    const sample = [w('a', 'top', 900), w('b', 'top', 100)];
    const strata = { top: { population: 2, amount: '1000' } };
    const r = buildStratifiedDiamondHands(sample, { a: 2 * DAY, b: HOUR }, strata);
    assert.strictEqual(r.resolved, 2);
    assert.strictEqual(r.distribution['24h'], 50);
    assert.strictEqual(r.supplyDistribution['24h'], 90);
    assert.strictEqual(r.distribution['6h'], 50);
  });

  test('strata are weighted by population, not by how many were sampled', () => {
    // 1 whale (all sampled) holding long; tail of 999, sample of 2, both short-term
    const sample = [w('whale', 'top', 1_000_000), w('t1', 'tail', 10), w('t2', 'tail', 10)];
    const strata = { top: { population: 1, amount: '1000000' }, tail: { population: 999, amount: '9990' } };
    const r = buildStratifiedDiamondHands(sample, { whale: 40 * DAY, t1: HOUR, t2: HOUR }, strata);
    assert.strictEqual(r.distribution['1m'], 0.1);                // 1/1000 of holders
    assert.strictEqual(r.supplyDistribution['1m'], 99);            // ~99% of supply is the whale's
  });

  test('a stratum with nothing resolved drops out and the rest re-weight', () => {
    const sample = [w('a', 'top', 100), w('b', 'mid', 10)];
    const strata = { top: { population: 1, amount: '100' }, mid: { population: 9, amount: '90' } };
    const r = buildStratifiedDiamondHands(sample, { a: 2 * DAY }, strata);
    assert.strictEqual(r.resolved, 1);
    assert.strictEqual(r.distribution['24h'], 100);
  });

  test('zero or negative hold times count as unresolved', () => {
    const sample = [w('a', 'top', 1), w('b', 'top', 1)];
    const r = buildStratifiedDiamondHands(sample, { a: 0, b: -1 }, { top: { population: 2, amount: '2' } });
    assert.strictEqual(r.resolved, 0);
  });

  test('every bucket is present and the distribution never increases', () => {
    const sample = [];
    const holdTimes = {};
    for (let i = 0; i < 30; i++) {
      const stratum = i < 5 ? 'top' : i < 15 ? 'mid' : 'tail';
      sample.push(w(`w${i}`, stratum, 1000 - i));
      holdTimes[`w${i}`] = i * 13 * DAY + HOUR;
    }
    const strata = { top: { population: 5, amount: '5000' }, mid: { population: 100, amount: '50000' }, tail: { population: 1000, amount: '90000' } };
    const { distribution, supplyDistribution } = buildStratifiedDiamondHands(sample, holdTimes, strata);
    assert.deepStrictEqual(Object.keys(distribution), DIAMOND_HANDS_BUCKETS.map(b => b.key));
    for (const d of [distribution, supplyDistribution]) {
      const vals = DIAMOND_HANDS_BUCKETS.map(b => d[b.key]);
      for (let i = 1; i < vals.length; i++) assert.ok(vals[i] <= vals[i - 1], `${vals}`);
    }
  });
});

describe('swapFromRawTransaction', () => {
  const WSOL = 'So11111111111111111111111111111111111111112';
  const bal = (owner, mint, amount, decimals = 6) => ({ accountIndex: 3, owner, mint, uiTokenAmount: { amount: String(amount), decimals } });
  const raw = ({ pre = [], post = [], keys = [WALLET, OTHER], preBal = [0, 0], postBal = [0, 0], fee = 5000, err = null, blockTime = 1_700_000_000 } = {}) => ({
    blockTime,
    transaction: { signatures: ['sig1'], message: { accountKeys: keys } },
    meta: { err, fee, preBalances: preBal, postBalances: postBal, preTokenBalances: pre, postTokenBalances: post },
  });

  test('buying a token with SOL is a swap with one buy transfer', () => {
    const tx = raw({ pre: [bal(WALLET, MINT, 0)], post: [bal(WALLET, MINT, 2_500_000)], preBal: [10e9, 0], postBal: [9e9 - 5000, 0] });
    const swap = swapFromRawTransaction(tx, WALLET);
    assert.deepStrictEqual(swap, {
      signature: 'sig1', timestamp: 1_700_000_000,
      tokenTransfers: [{ mint: MINT, fromUserAccount: null, toUserAccount: WALLET, tokenAmount: 2.5 }],
    });
    const pairs = computeHoldPairs(WALLET, [swap], NOW);
    assert.strictEqual(pairs[MINT].length, 1);
    assert.strictEqual(pairs[MINT][0].type, 'holding');
  });

  test('selling a token for USDC is a swap with one sell transfer, the cash leg carried through', () => {
    const tx = raw({
      pre: [bal(WALLET, MINT, 5_000_000), bal(WALLET, USDC, 0)],
      post: [bal(WALLET, MINT, 0), bal(WALLET, USDC, 12_000_000)],
    });
    const swap = swapFromRawTransaction(tx, WALLET);
    assert.strictEqual(swap.tokenTransfers.length, 2);
    const sell = swap.tokenTransfers.find(t => t.mint === MINT);
    assert.deepStrictEqual(sell, { mint: MINT, fromUserAccount: WALLET, toUserAccount: null, tokenAmount: 5 });
    assert.ok(swap.tokenTransfers.some(t => t.mint === USDC && t.toUserAccount === WALLET));
  });

  test('token-to-token swaps give a sell and a buy', () => {
    const tx = raw({ pre: [bal(WALLET, MINT, 100), bal(WALLET, MINT_B, 0)], post: [bal(WALLET, MINT, 0), bal(WALLET, MINT_B, 300)] });
    const swap = swapFromRawTransaction(tx, WALLET);
    assert.strictEqual(swap.tokenTransfers.filter(t => t.fromUserAccount === WALLET).length, 1);
    assert.strictEqual(swap.tokenTransfers.filter(t => t.toUserAccount === WALLET).length, 1);
  });

  test('plain transfers, cash-only swaps, failed transactions and other owners are not swaps', () => {
    // received a token, gave nothing (airdrop / transfer in)
    assert.strictEqual(swapFromRawTransaction(raw({ pre: [], post: [bal(WALLET, MINT, 10)] }), WALLET), null);
    // sent a token, only paid the fee and a little rent
    assert.strictEqual(swapFromRawTransaction(raw({ pre: [bal(WALLET, MINT, 10)], post: [bal(WALLET, MINT, 0)], preBal: [1e9, 0], postBal: [1e9 - 5000 - 2_039_280, 0] }), WALLET), null);
    // SOL -> USDC is cash for cash
    assert.strictEqual(swapFromRawTransaction(raw({ pre: [bal(WALLET, USDC, 0)], post: [bal(WALLET, USDC, 50e6)], preBal: [10e9, 0], postBal: [9e9, 0] }), WALLET), null);
    // wSOL in, token out, but the transaction failed
    assert.strictEqual(swapFromRawTransaction(raw({ err: { x: 1 }, pre: [bal(WALLET, MINT, 10), bal(WALLET, WSOL, 0)], post: [bal(WALLET, MINT, 0), bal(WALLET, WSOL, 1e9, 9)] }), WALLET), null);
    // somebody else's swap in which the wallet only appears
    assert.strictEqual(swapFromRawTransaction(raw({ pre: [bal(OTHER, MINT, 0)], post: [bal(OTHER, MINT, 10)], preBal: [0, 10e9], postBal: [0, 9e9] }), WALLET), null);
    assert.strictEqual(swapFromRawTransaction(null, WALLET), null);
  });

  test('the fee is not a SOL leg; a wallet that is not the payer still gets its lamport delta', () => {
    const paidFeeOnly = raw({ pre: [bal(WALLET, MINT, 0)], post: [bal(WALLET, MINT, 10)], preBal: [1e9, 0], postBal: [1e9 - 5000, 0] });
    assert.strictEqual(swapFromRawTransaction(paidFeeOnly, WALLET), null);
    const notPayer = raw({ keys: [OTHER, WALLET], pre: [bal(WALLET, MINT, 0)], post: [bal(WALLET, MINT, 10)], preBal: [1e9, 5e9], postBal: [1e9 - 5000, 4e9] });
    assert.ok(swapFromRawTransaction(notPayer, WALLET));
  });
});
