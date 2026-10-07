/**
 * Holder snapshot math: aggregation, new-wallet acquisition, stratified sampling,
 * and the transfer-history rewind that finds when a holding streak began.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  aggregateHolders, newWalletAcquisition, selectSample, sampleKey, uiToRaw, tokenAccountDelta,
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
  // n holders with strictly decreasing balances, none of them dust
  const makeHolders = n => Array.from({ length: n }, (_, i) => ({
    wallet: `W${String(i).padStart(6, '0')}`, tokenAccount: `T${i}`, amount: BigInt(1_000_000 + (n - i) * 1000), rank: i + 1,
  }));

  test('small holder base: everyone eligible is measured', () => {
    const holders = makeHolders(120);
    const { sample, meta } = selectSample(MINT, holders);
    assert.strictEqual(sample.length, 120);
    assert.strictEqual(meta.method, 'stratified-v1');
    assert.strictEqual(meta.strata.top.population, 50);
    assert.strictEqual(meta.strata.top.sampled, 50);
    assert.strictEqual(meta.strata.mid.population, 0);
    assert.strictEqual(meta.strata.tail.population, 70);
    assert.strictEqual(meta.strata.tail.sampled, 70);
  });

  test('large holder base: top 50 always, then an even random split between mid and tail', () => {
    const holders = makeHolders(10_000);
    const { sample, meta } = selectSample(MINT, holders);
    assert.strictEqual(sample.length, 250);
    assert.deepStrictEqual(sample.filter(s => s.stratum === 'top').map(s => s.rank), Array.from({ length: 50 }, (_, i) => i + 1));
    assert.strictEqual(meta.strata.mid.population, 950);   // ranks 51..1000 (top 10%)
    assert.strictEqual(meta.strata.tail.population, 9000);
    assert.strictEqual(meta.strata.mid.sampled, 100);
    assert.strictEqual(meta.strata.tail.sampled, 100);
    const mids = sample.filter(s => s.stratum === 'mid');
    assert.ok(mids.every(s => s.rank > 50 && s.rank <= 1000));
    assert.ok(sample.filter(s => s.stratum === 'tail').every(s => s.rank > 1000));
    assert.strictEqual(new Set(sample.map(s => s.wallet)).size, 250);
  });

  test('unused budget in one stratum goes to the other', () => {
    // 50 top, mid = ranks 51..60 (10 wallets, top 10% of 600 is 60), tail = 540
    const { meta } = selectSample(MINT, makeHolders(600));
    assert.strictEqual(meta.strata.mid.sampled, 10);
    assert.strictEqual(meta.strata.tail.sampled, 190);
  });

  test('the random strata are not just the largest holders', () => {
    const { sample } = selectSample(MINT, makeHolders(10_000));
    const tailRanks = sample.filter(s => s.stratum === 'tail').map(s => s.rank).sort((a, b) => a - b);
    // a uniform sample of ranks 1001..10000 should reach well into the bottom half
    assert.ok(tailRanks[tailRanks.length - 1] > 7000, `max tail rank ${tailRanks[tailRanks.length - 1]}`);
    assert.ok(tailRanks[0] < 3000, `min tail rank ${tailRanks[0]}`);
  });

  test('deterministic for a mint, and a wallet that stays stays sampled', () => {
    const holders = makeHolders(5000);
    const a = selectSample(MINT, holders).sample.map(s => s.wallet);
    const b = selectSample(MINT, holders).sample.map(s => s.wallet);
    assert.deepStrictEqual(a, b);
    // drop 100 unsampled tail holders: everyone sampled before is still sampled
    const sampled = new Set(a);
    const dropped = holders.filter(h => h.rank > 1000 && !sampled.has(h.wallet)).slice(0, 100).map(h => h.wallet);
    const fewer = holders.filter(h => !dropped.includes(h.wallet)).map((h, i) => ({ ...h, rank: i + 1 }));
    const c = new Set(selectSample(MINT, fewer).sample.filter(s => s.stratum === 'tail').map(s => s.wallet));
    for (const w of a.filter(w => selectSample(MINT, holders).sample.find(s => s.wallet === w).stratum === 'tail')) {
      assert.ok(c.has(w), `${w} dropped out of the tail sample`);
    }
  });

  test('a different mint draws a different random sample', () => {
    const holders = makeHolders(5000);
    const a = selectSample(MINT, holders).sample.filter(s => s.stratum === 'tail').map(s => s.wallet);
    const b = new Set(selectSample('OtherMint', holders).sample.filter(s => s.stratum === 'tail').map(s => s.wallet));
    assert.ok(a.filter(w => b.has(w)).length < a.length / 2);
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

  test('sampleKey is stable and mint-specific', () => {
    assert.strictEqual(sampleKey(MINT, 'A'), sampleKey(MINT, 'A'));
    assert.notStrictEqual(sampleKey(MINT, 'A'), sampleKey('M2', 'A'));
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

  test('zero-delta transactions (e.g. unrelated instructions) are stepped over', () => {
    const r = rewindToStreakStart(100n, [tx(3000, 0), tx(2000, 0), tx(1000, 100)]);
    assert.strictEqual(r.acquiredAt, 1_000_000);
  });
});
