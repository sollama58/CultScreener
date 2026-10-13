/**
 * Holder snapshot math: aggregation, new-wallet acquisition, the conviction sample,
 * and the transfer-history rewind that finds when a holding streak began.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  aggregateHolders, newWalletAcquisition, selectSample, uiToRaw, tokenAccountDelta,
  metaTokenAccountDelta, holderFingerprint, rewindToStreakStart, toBigInt, MAX_SNAPSHOT_GAP_MS,
} = require('./holderSnapshot');

const MINT = 'Mint111111111111111111111111111111111111111';
const HOUR = 3_600_000;

describe('toBigInt', () => {
  test('accepts strings, numbers and bigints; junk becomes 0', () => {
    assert.strictEqual(toBigInt('123456789012345678901'), 123456789012345678901n);
    assert.strictEqual(toBigInt(42), 42n);
    assert.strictEqual(toBigInt(7n), 7n);
    assert.strictEqual(toBigInt('12.9'), 12n);
    assert.strictEqual(toBigInt(null), 0n);
    assert.strictEqual(toBigInt('abc'), 0n);
  });
});

describe('aggregateHolders', () => {
  test('sums accounts per owner, ranks by balance, keeps the largest account', () => {
    const holders = aggregateHolders([
      { owner: 'A', address: 'a1', amount: '100' },
      { owner: 'B', address: 'b1', amount: 500 },
      { owner: 'A', address: 'a2', amount: '450' },
      { owner: 'C', address: 'c1', amount: '0' },
      { owner: null, address: 'x', amount: '9' },
    ]);
    assert.deepStrictEqual(holders, [
      { wallet: 'A', tokenAccount: 'a2', amount: 550n, rank: 1 },
      { wallet: 'B', tokenAccount: 'b1', amount: 500n, rank: 2 },
    ]);
  });

  test('raw amounts beyond 2^53 stay exact', () => {
    const [h] = aggregateHolders([
      { owner: 'A', address: 'a', amount: '9007199254740993' },
      { owner: 'A', address: 'b', amount: '1' },
    ]);
    assert.strictEqual(h.amount, 9007199254740994n);
  });

  test('ties order by wallet so ranks are stable', () => {
    const holders = aggregateHolders([{ owner: 'Z', amount: '5' }, { owner: 'M', amount: '5' }]);
    assert.deepStrictEqual(holders.map(h => h.wallet), ['M', 'Z']);
  });

  test('an account that appears twice (page shift mid-read) is counted once', () => {
    const h = aggregateHolders([
      { owner: 'A', address: 'a1', amount: '100' },
      { owner: 'A', address: 'a1', amount: '100' },
      { owner: 'A', address: 'a2', amount: '5' },
    ]);
    assert.strictEqual(h.length, 1);
    assert.strictEqual(h[0].amount, 105n);
  });

  test('empty input', () => {
    assert.deepStrictEqual(aggregateHolders([]), []);
    assert.deepStrictEqual(aggregateHolders(undefined), []);
  });
});

describe('newWalletAcquisition', () => {
  const T = 1_800_000_000_000;

  test('no previous snapshot: unknown, needs backfill', () => {
    assert.deepStrictEqual(newWalletAcquisition(null, T), { acquiredAt: null, source: 'pending' });
  });

  test('previous complete snapshot within the gap: acquired at this snapshot', () => {
    assert.deepStrictEqual(newWalletAcquisition({ takenAt: T - HOUR, complete: true }, T), { acquiredAt: T, source: 'snapshot' });
  });

  test('gap exactly at the limit still counts; one ms over does not', () => {
    assert.strictEqual(newWalletAcquisition({ takenAt: T - MAX_SNAPSHOT_GAP_MS, complete: true }, T).source, 'snapshot');
    assert.strictEqual(newWalletAcquisition({ takenAt: T - MAX_SNAPSHOT_GAP_MS - 1, complete: true }, T).source, 'pending');
  });

  test('previous snapshot capped (incomplete): a "new" wallet may just have been past the cap', () => {
    assert.strictEqual(newWalletAcquisition({ takenAt: T - HOUR, complete: false }, T).source, 'pending');
  });

  test('clock went backwards: do not trust it', () => {
    assert.strictEqual(newWalletAcquisition({ takenAt: T + HOUR, complete: true }, T).source, 'pending');
  });
});

describe('selectSample', () => {
  // n holders with strictly decreasing, nearly equal balances, none of them dust
  const makeHolders = n => Array.from({ length: n }, (_, i) => ({
    wallet: `W${String(i).padStart(6, '0')}`, tokenAccount: `T${i}`, amount: BigInt(1_000_000 + (n - i) * 1000), rank: i + 1,
  }));

  test('small holder base: everyone above the floor is measured', () => {
    const { sample, meta } = selectSample(MINT, makeHolders(120));
    assert.strictEqual(sample.length, 120);
    assert.strictEqual(meta.method, 'top-v1');
    assert.deepStrictEqual(meta.strata, { top: { population: 120, amount: meta.strata.top.amount, sampled: 120 } });
  });

  test('large holder base: the 250 largest holders, in rank order', () => {
    // 1000 wallets, each ~0.1% of held supply: all clear the 0.05% floor
    const { sample, meta } = selectSample(MINT, makeHolders(1000));
    assert.strictEqual(sample.length, 250);
    assert.deepStrictEqual(sample.map(s => s.rank), Array.from({ length: 250 }, (_, i) => i + 1));
    assert.ok(sample.every(s => s.stratum === 'top'));
    assert.strictEqual(meta.strata.top.population, 250);
    assert.strictEqual(meta.eligible, 1000);
  });

  test('holders under 0.05% of held supply are not measured', () => {
    const holders = [
      { wallet: 'BIG', amount: 9_990n, rank: 1 },
      { wallet: 'EDGE', amount: 5n, rank: 2 },  // exactly 0.05% of 10_000
      { wallet: 'SMALL', amount: 4n, rank: 3 }, // under the floor, still a holder
      { wallet: 'SMALL2', amount: 1n, rank: 4 },
    ];
    const { sample, meta } = selectSample(MINT, holders);
    assert.deepStrictEqual(sample.map(s => s.wallet), ['BIG', 'EDGE']);
    assert.strictEqual(meta.eligible, 4);
    assert.strictEqual(meta.strata.top.population, 2);
  });

  test('deterministic for the same holder list', () => {
    const holders = makeHolders(800);
    assert.deepStrictEqual(selectSample(MINT, holders), selectSample(MINT, holders));
  });

  test('excluded wallets (LP, burn) are left out and counted', () => {
    const holders = makeHolders(100);
    const { sample, meta } = selectSample(MINT, holders, { exclude: new Set(['W000000', 'W000001']) });
    assert.ok(!sample.some(s => s.wallet === 'W000000' || s.wallet === 'W000001'));
    assert.strictEqual(meta.excluded, 2);
    assert.strictEqual(sample[0].wallet, 'W000002');
  });

  test('dust balances are not holders', () => {
    const holders = [
      { wallet: 'BIG', amount: 10_000_000_000n, rank: 1 },
      { wallet: 'OK', amount: 1_000n, rank: 2 },      // exactly 1e-7 of the total
      { wallet: 'DUST', amount: 999n, rank: 3 },
    ];
    // total = 10_000_001_999; 1e-7 of it ≈ 1000.0002, so 1000 is just below — dust too
    const { sample, meta } = selectSample(MINT, holders);
    assert.deepStrictEqual(sample.map(s => s.wallet), ['BIG']);
    assert.strictEqual(meta.dust, 2);
  });

  test('sample entries carry amount as a string and their stratum', () => {
    const { sample } = selectSample(MINT, makeHolders(3));
    assert.deepStrictEqual(sample[0], { wallet: 'W000000', tokenAccount: 'T0', rank: 1, amount: '1003000', stratum: 'top' });
  });
});

describe('uiToRaw', () => {
  test('parses decimal strings and numbers exactly', () => {
    assert.strictEqual(uiToRaw('12.5', 6), 12_500_000n);
    assert.strictEqual(uiToRaw(12.5, 6), 12_500_000n);
    assert.strictEqual(uiToRaw('0.000001', 6), 1n);
    assert.strictEqual(uiToRaw('1.23456789', 6), 1_234_567n); // truncates past decimals
    assert.strictEqual(uiToRaw(100, 0), 100n);
    assert.strictEqual(uiToRaw('-3', 2), -300n);
    assert.strictEqual(uiToRaw(null, 6), 0n);
    assert.strictEqual(uiToRaw('1e5', 6), 0n); // not a plain decimal: refuse rather than guess
  });
});

describe('tokenAccountDelta', () => {
  const ATA = 'Ata1';
  test('uses raw tokenBalanceChanges for the account when present', () => {
    const tx = {
      accountData: [
        { tokenBalanceChanges: [{ tokenAccount: ATA, mint: MINT, rawTokenAmount: { tokenAmount: '-2500', decimals: 6 } }] },
        { tokenBalanceChanges: [{ tokenAccount: 'other', mint: MINT, rawTokenAmount: { tokenAmount: '2500', decimals: 6 } }] },
      ],
      tokenTransfers: [{ mint: MINT, fromTokenAccount: ATA, toTokenAccount: 'other', tokenAmount: 99 }],
    };
    assert.strictEqual(tokenAccountDelta(tx, ATA, MINT, 6), -2500n);
  });

  test('falls back to tokenTransfers with UI amounts', () => {
    const tx = { tokenTransfers: [
      { mint: MINT, fromTokenAccount: 'x', toTokenAccount: ATA, tokenAmount: 1.5 },
      { mint: MINT, fromTokenAccount: ATA, toTokenAccount: 'y', tokenAmount: '0.5' },
      { mint: 'OtherMint', fromTokenAccount: 'x', toTokenAccount: ATA, tokenAmount: 100 },
    ] };
    assert.strictEqual(tokenAccountDelta(tx, ATA, MINT, 6), 1_000_000n);
  });

  test('failed transactions and unrelated ones move nothing', () => {
    assert.strictEqual(tokenAccountDelta({ transactionError: { x: 1 }, tokenTransfers: [{ mint: MINT, toTokenAccount: ATA, tokenAmount: 5 }] }, ATA, MINT, 0), 0n);
    assert.strictEqual(tokenAccountDelta({ tokenTransfers: [] }, ATA, MINT, 0), 0n);
    assert.strictEqual(tokenAccountDelta(null, ATA, MINT, 0), 0n);
  });
});

describe('metaTokenAccountDelta', () => {
  const ATA = 'Ata1';
  const bal = (accountIndex, amount, mint = MINT) => ({ accountIndex, mint, owner: 'w', uiTokenAmount: { amount } });

  test('reads pre/post token balances for the account in a "json" transaction', () => {
    const tx = {
      blockTime: 1000,
      transaction: { message: { accountKeys: ['payer', ATA, 'other'] } },
      meta: { err: null, preTokenBalances: [bal(1, '100'), bal(2, '5')], postTokenBalances: [bal(1, '160'), bal(2, '0')] },
    };
    assert.strictEqual(metaTokenAccountDelta(tx, ATA, MINT), 60n);
    assert.strictEqual(metaTokenAccountDelta(tx, 'other', MINT), -5n);
  });

  test('handles jsonParsed keys, lookup-table addresses, and accounts created or closed in the tx', () => {
    const parsed = {
      transaction: { message: { accountKeys: [{ pubkey: 'payer' }, { pubkey: ATA }] } },
      meta: { preTokenBalances: [], postTokenBalances: [bal(1, '42')] },
    };
    assert.strictEqual(metaTokenAccountDelta(parsed, ATA, MINT), 42n, 'account created: no pre balance');
    const loaded = {
      transaction: { message: { accountKeys: ['payer'] } },
      meta: { loadedAddresses: { writable: ['w1'], readonly: [ATA] }, preTokenBalances: [bal(2, '7')], postTokenBalances: [] },
    };
    assert.strictEqual(metaTokenAccountDelta(loaded, ATA, MINT), -7n, 'account closed: no post balance');
  });

  test('failed transactions, other mints and unknown accounts move nothing', () => {
    const tx = {
      transaction: { message: { accountKeys: [ATA] } },
      meta: { err: { x: 1 }, preTokenBalances: [bal(0, '1')], postTokenBalances: [bal(0, '9')] },
    };
    assert.strictEqual(metaTokenAccountDelta(tx, ATA, MINT), 0n);
    const other = { transaction: { message: { accountKeys: [ATA] } }, meta: { preTokenBalances: [bal(0, '1', 'X')], postTokenBalances: [bal(0, '9', 'X')] } };
    assert.strictEqual(metaTokenAccountDelta(other, ATA, MINT), 0n);
    assert.strictEqual(metaTokenAccountDelta(other, 'nobody', MINT), 0n);
    assert.strictEqual(metaTokenAccountDelta(null, ATA, MINT), 0n);
  });
});

describe('holderFingerprint', () => {
  const accounts = [{ address: 'a', amount: '10' }, { address: 'b', amount: 20 }];
  test('is order-independent and changes with any balance, account or supply change', () => {
    const fp = holderFingerprint('1000', accounts);
    assert.strictEqual(holderFingerprint('1000', [...accounts].reverse()), fp);
    assert.notStrictEqual(holderFingerprint('1001', accounts), fp);
    assert.notStrictEqual(holderFingerprint('1000', [{ address: 'a', amount: '11' }, accounts[1]]), fp);
    assert.notStrictEqual(holderFingerprint('1000', [...accounts, { address: 'c', amount: '1' }]), fp);
    assert.ok(fp.startsWith('2:'));
  });
});

describe('rewindToStreakStart', () => {
  const tx = (sec, delta) => ({ timestamp: sec, delta: BigInt(delta) });

  test('single buy: the streak starts at the buy', () => {
    const r = rewindToStreakStart(100n, [tx(5000, 100)]);
    assert.deepStrictEqual(r, { done: true, acquiredAt: 5_000_000, balance: 0n, oldestAt: 5_000_000 });
  });

  test('partial sells after the buy do not reset the streak', () => {
    // newest first: sold 30, sold 20, bought 100 → balance 50 now
    const r = rewindToStreakStart(50n, [tx(3000, -30), tx(2000, -20), tx(1000, 100)]);
    assert.strictEqual(r.done, true);
    assert.strictEqual(r.acquiredAt, 1_000_000);
  });

  test('sold out and re-bought: the streak starts at the re-buy, not the first buy', () => {
    // newest first: rebuy 40 @4000, sell 100 @3000, buy 100 @1000
    const r = rewindToStreakStart(40n, [tx(4000, 40), tx(3000, -100), tx(1000, 100)]);
    assert.strictEqual(r.acquiredAt, 4_000_000);
  });

  test('topping up mid-streak keeps the original start', () => {
    const r = rewindToStreakStart(150n, [tx(3000, 50), tx(1000, 100)]);
    assert.strictEqual(r.acquiredAt, 1_000_000);
  });

  test('not found on this page: resumable with the rewound balance', () => {
    const page1 = rewindToStreakStart(150n, [tx(3000, 50)]);
    assert.deepStrictEqual(page1, { done: false, acquiredAt: null, balance: 100n, oldestAt: 3_000_000 });
    const page2 = rewindToStreakStart(page1.balance, [tx(1000, 100)]);
    assert.strictEqual(page2.acquiredAt, 1_000_000);
  });

  test('history exhausted without reaching zero: oldest transaction is the estimate', () => {
    const r = rewindToStreakStart(500n, [tx(3000, 50), tx(2000, 0)], { exhausted: true });
    assert.deepStrictEqual(r, { done: true, acquiredAt: 2_000_000, balance: 450n, oldestAt: 2_000_000 });
  });

  test('empty, exhausted history gives no answer', () => {
    assert.deepStrictEqual(rewindToStreakStart(5n, [], { exhausted: true }), { done: true, acquiredAt: null, balance: 5n, oldestAt: null });
  });

  test('a transaction without a block time still moves the balance', () => {
    // 100 now; +60 (no block time), +40 at t=10. Without applying the +60 the
    // rewind would stop at +40 with a wrong balance.
    const r = rewindToStreakStart(100n, [{ timestamp: 0, delta: 60n }, { timestamp: 10, delta: 40n }], { exhausted: true });
    assert.strictEqual(r.done, true);
    assert.strictEqual(r.acquiredAt, 10_000);
  });

  test('a streak start without a block time is dated by the next newer transaction, not the previous streak', () => {
    // newest first: sell 20 @2000, re-buy 100 (no block time), sell 50 @1000, buy 50 @500
    const r = rewindToStreakStart(80n, [tx(2000, -20), { timestamp: 0, delta: 100n }, tx(1000, -50), tx(500, 50)], { exhausted: true });
    assert.deepStrictEqual(r, { done: true, acquiredAt: 2_000_000, balance: 0n, oldestAt: 2_000_000 });
    // first on its page: no date here, the caller uses a newer page's or gives up
    const first = rewindToStreakStart(100n, [{ timestamp: 0, delta: 100n }, tx(1000, -50), tx(500, 50)], { exhausted: true });
    assert.deepStrictEqual(first, { done: true, acquiredAt: null, balance: 0n, oldestAt: null });
  });

  test('zero-delta transactions (e.g. unrelated instructions) are stepped over', () => {
    const r = rewindToStreakStart(100n, [tx(3000, 0), tx(2000, 0), tx(1000, 100)]);
    assert.strictEqual(r.acquiredAt, 1_000_000);
  });
});
