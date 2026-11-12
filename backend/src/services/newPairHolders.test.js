/**
 * Top-50 holder sample math: exclusions, shares, the dev wallet, equal bags, and what
 * two samples say about retention, new entrants and exits.
 */
const { test } = require('node:test');
const assert = require('node:assert');

const { summarize, compareSamples, hasEqualBags, largest, isDue, prioritize, toScoreSample } = require('./newPairHolders');

const HOUR = 3_600_000;
const T = Date.UTC(2026, 10, 12, 12);
const w = (i) => `Wallet${String(i).padStart(3, '0')}`.padEnd(43, 'x');
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} is not ${b}`);

const POOL = 'HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC';   // Meteora DAMM v2 authority (registry)
const BURN = '1nc1nerator11111111111111111111111111111111';
const LOCKER = 'LockerProgramOwned1111111111111111111111111';
const DEV = w(999);

/** 1,000,000 supply: pool 300k, burn 100k, locker 50k, sixty wallets, dev, and dust. */
function balances() {
  const m = new Map([[POOL, 300_000n], [BURN, 100_000n], [LOCKER, 50_000n], [DEV, 9_000n]]);
  for (let i = 1; i <= 60; i++) m.set(w(i), BigInt(10_000 - i * 100));   // 9,900 down to 4,000
  for (let i = 1; i <= 40; i++) m.set(`Dust${i}`.padEnd(43, 'd'), 1n);
  return m;
}

test('summarize: vaults, burn and program-owned wallets are not holders; shares are of supply less burned', () => {
  const s = summarize({ balances: balances(), supplyRaw: '1000000', decimals: 0, priceUsd: 0.001, devWallet: DEV, programOwned: new Set([LOCKER]), takenAt: T });
  assert.strictEqual(s.entries[0].wallet, w(1));
  assert.ok(!s.entries.some(e => [POOL, BURN, LOCKER].includes(e.wallet)));
  assert.strictEqual(s.entries.length, 97);        // the largest 100, less the three that are not holders
  // supply less burned = 900,000
  near(s.top1, (9900 / 900000) * 100, 1e-3);
  const top10 = [...Array(10)].reduce((sum, _, i) => sum + 10000 - (i + 1) * 100, 0);
  near(s.top10, (top10 / 900000) * 100, 1e-3);
  // top 50: the dev's 9,000 ranks among the wallets
  const all = [...Array(60)].map((_, i) => 10000 - (i + 1) * 100).concat(9000).sort((a, b) => b - a).slice(0, 50);
  near(s.top50, (all.reduce((a, b) => a + b, 0) / 900000) * 100, 1e-3);
  near(s.devPct, 1, 1e-3);
  assert.strictEqual(s.holderCount, 101);       // 60 wallets + dev + 40 dust
  assert.strictEqual(s.dustCount, 40);          // $0.001 a token: 1 token is under a cent
  assert.strictEqual(s.equalBags, false);
  assert.strictEqual(s.retention12, null);      // first sample: nothing to compare
  assert.strictEqual(s.newIn, null);
});

test('summarize: a dev wallet that is itself a vault has no dev share; an empty map gives nulls', () => {
  const s = summarize({ balances: balances(), supplyRaw: '1000000', decimals: 0, priceUsd: 0.001, devWallet: LOCKER, programOwned: new Set([LOCKER]), takenAt: T });
  assert.strictEqual(s.devPct, null);
  const empty = summarize({ balances: new Map(), supplyRaw: '1000000', decimals: 0, priceUsd: 1, devWallet: null, takenAt: T });
  assert.strictEqual(empty.top10, null);
  assert.strictEqual(empty.holderCount, 0);
  assert.deepStrictEqual(empty.entries, []);
  const gone = summarize({ balances: new Map([[w(1), 5n]]), supplyRaw: '100', decimals: 0, priceUsd: 1, devWallet: DEV, takenAt: T });
  assert.strictEqual(gone.devPct, 0);           // the dev sold everything
});

test('largest: biggest first, ties broken by wallet so runs are repeatable', () => {
  const m = new Map([['b', 5n], ['a', 5n], ['c', 9n], ['d', 1n]]);
  assert.deepStrictEqual(largest(m, 3).map(h => h.wallet), ['c', 'a', 'b']);
});

test('hasEqualBags: five of the top ten within 2% of each other', () => {
  const top = (amounts) => amounts.map((a, i) => ({ wallet: w(i), amount: BigInt(a) }));
  assert.strictEqual(hasEqualBags(top([9000, 5000, 5010, 5020, 5050, 5090, 3000, 2000, 1000, 900])), true);
  assert.strictEqual(hasEqualBags(top([9000, 5000, 5010, 5020, 5050, 5200, 3000, 2000, 1000, 900])), false);
  assert.strictEqual(hasEqualBags(top([100, 100, 100, 100])), false);
  // Equal bags below rank 10 do not count
  assert.strictEqual(hasEqualBags(top([90, 80, 70, 60, 50, 40, 30, 20, 10, 9, 5, 5, 5, 5, 5])), false);
});

test('compareSamples: retention by headcount and balance, per 12 hours', () => {
  const prevEntries = [...Array(50)].map((_, i) => ({ wallet: w(i + 1), amount: '1000' }));
  const now = new Map(prevEntries.map(e => [e.wallet, 1000n]));
  for (let i = 1; i <= 5; i++) now.delete(w(i));          // five sold out
  for (let i = 6; i <= 10; i++) now.set(w(i), 400n);      // five sold more than half
  now.set(w(11), 500n);                                   // exactly half: still a holder
  const top = largest(now, 50);
  let r = compareSamples({ top, balances: now, prev: { takenAt: T - 12 * HOUR, entries: prevEntries }, takenAt: T });
  near(r.retention12, 0.8);                               // 40 of 50 by headcount, same by balance
  assert.strictEqual(r.exits, 5);                         // previous top-10 wallets that are gone
  // The same change over 6 hours is a faster bleed: squared for 12h
  r = compareSamples({ top, balances: now, prev: { takenAt: T - 6 * HOUR, entries: prevEntries }, takenAt: T });
  near(r.retention12, 0.64);
  // Gaps too short or too long say nothing
  assert.strictEqual(compareSamples({ top, balances: now, prev: { takenAt: T - HOUR, entries: prevEntries }, takenAt: T }).retention12, null);
  assert.strictEqual(compareSamples({ top, balances: now, prev: { takenAt: T - 60 * HOUR, entries: prevEntries }, takenAt: T }).retention12, null);
  assert.deepStrictEqual(compareSamples({ top, balances: now, prev: null, takenAt: T }), { retention12: null, newIn: null, exits: null });
});

test('compareSamples: one whale staying does not hide everyone else leaving', () => {
  const prevEntries = [{ wallet: w(1), amount: '900000' }, ...[...Array(49)].map((_, i) => ({ wallet: w(i + 2), amount: '1000' }))];
  const now = new Map([[w(1), 900000n]]);
  const r = compareSamples({ top: largest(now, 50), balances: now, prev: { takenAt: T - 12 * HOUR, entries: prevEntries }, takenAt: T });
  // 2% by headcount, 95% by balance: the average, not the balance figure
  near(r.retention12, (1 / 50 + 900000 / 949000) / 2, 1e-4);
});

test('compareSamples: new entrants are judged against the stored ranks below 50 too', () => {
  const prevEntries = [...Array(60)].map((_, i) => ({ wallet: w(i + 1), amount: String(10000 - i * 100) }));
  const now = new Map(prevEntries.map(e => [e.wallet, BigInt(e.amount)]));
  now.set(w(55), 20000n);            // was rank 55 with 4,600: grew, but held over a tenth before
  now.set(w(200), 30000n);           // never seen
  now.set(w(60), 50000n);            // was rank 60 with 4,100: under a tenth of today's bag
  const r = compareSamples({ top: largest(now, 50), balances: now, prev: { takenAt: T - 12 * HOUR, entries: prevEntries }, takenAt: T });
  assert.strictEqual(r.newIn, 2);
  assert.strictEqual(r.exits, 0);
});

test('isDue and prioritize: every 6h for 3 days then 12h; never-checked first by score', () => {
  const young = T - 24 * HOUR; const old = T - 5 * 24 * HOUR;
  assert.strictEqual(isDue({ graduatedAt: young, lastSampleAt: null }, T), true);
  assert.strictEqual(isDue({ graduatedAt: young, lastSampleAt: T - 5 * HOUR }, T), false);
  assert.strictEqual(isDue({ graduatedAt: young, lastSampleAt: T - 6 * HOUR }, T), true);
  assert.strictEqual(isDue({ graduatedAt: old, lastSampleAt: T - 8 * HOUR }, T), false);
  assert.strictEqual(isDue({ graduatedAt: old, lastSampleAt: T - 12 * HOUR }, T), true);
  const order = prioritize([
    { id: 'waited7h', graduatedAt: young, lastSampleAt: T - 7 * HOUR, score: 90 },
    { id: 'newLow', graduatedAt: young, lastSampleAt: null, score: 40 },
    { id: 'fresh', graduatedAt: young, lastSampleAt: T - HOUR, score: 99 },
    { id: 'newHigh', graduatedAt: young, lastSampleAt: null, score: 70 },
    { id: 'waited20h', graduatedAt: old, lastSampleAt: T - 20 * HOUR, score: 50 },
  ], T).map(t => t.id);
  assert.deepStrictEqual(order, ['newHigh', 'newLow', 'waited20h', 'waited7h']);
});

test('toScoreSample: dust share from the counts, nulls kept as nulls', () => {
  const s = toScoreSample({ taken_at: new Date(T), top1_pct: 3.5, top10_pct: 20, top50_pct: 40, dev_pct: null, holder_count: 200, dust_count: 50, retention12: null, equal_bags: true });
  assert.deepStrictEqual(s, { takenAt: T, top1: 3.5, top10: 20, top50: 40, devPct: null, dustShare: 0.25, retention12: null, equalBags: true });
  assert.strictEqual(toScoreSample({ taken_at: new Date(T), holder_count: 0, dust_count: 0 }).dustShare, null);
});
