/**
 * The three graduation detectors against real mainnet transactions (trimmed to the
 * fields matchGraduation reads; fetched 2026-11-12 with encoding "json").
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fx = require('./fixtures/newPairGraduations.json');
const { DETECTORS, WSOL, discriminator, enabledDetectors } = require('./newPairLaunchpads');
const { matchGraduation } = require('./newPairDetectors');

const mintsOf = (tx, list) => new Set((tx.meta[list] || []).map(b => b.mint));
// The graduating token is the one the curve already held: in both balance lists, and
// not the SOL side. Independent of the instruction layout the detector relies on.
function expectedMints(tx) {
  const pre = mintsOf(tx, 'preTokenBalances');
  return [...mintsOf(tx, 'postTokenBalances')].filter(m => pre.has(m) && m !== WSOL);
}

test('Pump.fun migrate_v2 that created the pool is a graduation', () => {
  const tx = fx.pumpV2Real;
  const g = matchGraduation(DETECTORS.pumpfun, tx);
  assert.deepStrictEqual(expectedMints(tx), [g.mint]);
  assert.strictEqual(g.quoteMint, WSOL);
  assert.strictEqual(g.instruction, 'migrate_v2');
  assert.strictEqual(g.signature, tx.transaction.signatures[0]);
  assert.strictEqual(g.slot, tx.slot);
  assert.strictEqual(g.graduatedAt, tx.blockTime * 1000);
});

test('the duplicate migrate that did nothing is not a graduation', () => {
  assert.strictEqual(matchGraduation(DETECTORS.pumpfun, fx.pumpV2NoOp), null);
  assert.strictEqual(matchGraduation(DETECTORS.pumpfun, fx.pumpVersion1), null);
});

test('the older Pump.fun migrate instruction is read too', () => {
  const tx = fx.pumpLegacyMigrate;
  const g = matchGraduation(DETECTORS.pumpfun, tx);
  assert.deepStrictEqual(expectedMints(tx), [g.mint]);
  assert.strictEqual(g.instruction, 'migrate');
  assert.strictEqual(g.quoteMint, WSOL);
});

test('a coin quoted in another coin graduates as itself, not as its quote', () => {
  const tx = fx.pumpCoinQuoted;
  const g = matchGraduation(DETECTORS.pumpfun, tx);
  const both = expectedMints(tx);
  assert.strictEqual(both.length, 2, 'fixture has two candidate mints');
  assert.ok(both.includes(g.mint));
  assert.ok(both.includes(g.quoteMint));
  assert.notStrictEqual(g.mint, g.quoteMint);
});

test('Meteora DBC migration_damm_v2, top level and inside a wrapper program', () => {
  for (const tx of [fx.dbcTopLevel, fx.dbcInner]) {
    const g = matchGraduation(DETECTORS['meteora-dbc'], tx);
    assert.deepStrictEqual(expectedMints(tx), [g.mint]);
    assert.strictEqual(g.quoteMint, WSOL);
    assert.strictEqual(g.instruction, 'migration_damm_v2');
  }
});

test('a DBC token created and migrated in one transaction is still named', () => {
  const tx = fx.dbcCreateAndMigrate;
  const g = matchGraduation(DETECTORS['meteora-dbc'], tx);
  assert.ok(mintsOf(tx, 'postTokenBalances').has(g.mint));
  assert.notStrictEqual(g.mint, WSOL);
  assert.strictEqual(g.quoteMint, WSOL);
});

test('LaunchLab migrate_to_cpswap, SOL-quoted and coin-quoted', () => {
  const sol = matchGraduation(DETECTORS.launchlab, fx.launchlabReal);
  assert.deepStrictEqual(expectedMints(fx.launchlabReal), [sol.mint]);
  assert.strictEqual(sol.quoteMint, WSOL);

  const coin = matchGraduation(DETECTORS.launchlab, fx.launchlabCoinQuoted);
  const both = expectedMints(fx.launchlabCoinQuoted);
  assert.ok(both.includes(coin.mint) && both.includes(coin.quoteMint) && coin.mint !== coin.quoteMint);
});

test('failed transactions and other instructions of the watched account are ignored', () => {
  assert.strictEqual(matchGraduation(DETECTORS.launchlab, fx.launchlabFailed), null);
  assert.strictEqual(matchGraduation(DETECTORS.launchlab, fx.launchlabConfig), null);
  assert.strictEqual(matchGraduation(DETECTORS.pumpfun, null), null);
  assert.strictEqual(matchGraduation(DETECTORS.pumpfun, { meta: null }), null);
});

test('a detector only reads its own program', () => {
  assert.strictEqual(matchGraduation(DETECTORS.launchlab, fx.pumpV2Real), null);
  assert.strictEqual(matchGraduation(DETECTORS.pumpfun, fx.dbcTopLevel), null);
  assert.strictEqual(matchGraduation(DETECTORS['meteora-dbc'], fx.launchlabReal), null);
});

test('a migration instruction with an unknown layout is reported, not guessed', () => {
  const tx = JSON.parse(JSON.stringify(fx.launchlabReal));
  const bs58 = require('bs58');
  const keys = tx.transaction.message.accountKeys.concat(tx.meta.loadedAddresses.writable || [], tx.meta.loadedAddresses.readonly || []);
  const ix = tx.transaction.message.instructions.find(i => keys[i.programIdIndex] === DETECTORS.launchlab.program);
  ix.data = bs58.encode(Buffer.from(discriminator('migrate_to_amm'), 'hex'));
  assert.deepStrictEqual(matchGraduation(DETECTORS.launchlab, tx), { unhandled: 'migrate_to_amm' });
});

test('a mint position that names an account the transaction did not move is refused', () => {
  const wrong = { ...DETECTORS.pumpfun, instructions: Object.fromEntries(
    Object.entries(DETECTORS.pumpfun.instructions).map(([d, l]) => [d, { ...l, mint: 0 }])) };
  assert.strictEqual(matchGraduation(wrong, fx.pumpV2Real), null);
});

test('NEWPAIRS_DETECTORS picks detectors; empty means all', () => {
  assert.deepStrictEqual(enabledDetectors('').map(d => d.id), ['pumpfun', 'meteora-dbc', 'launchlab']);
  assert.deepStrictEqual(enabledDetectors('launchlab, pumpfun,nope').map(d => d.id), ['launchlab', 'pumpfun']);
});
