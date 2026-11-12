/**
 * New Pairs storage against a real Postgres: first graduation wins, a failed run
 * leaves the cursor alone, and the credit ledger adds up per UTC day.
 *
 * Runs only when TEST_DATABASE_URL is set (CI provides a Postgres service).
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');

const DB_URL = process.env.TEST_DATABASE_URL;

if (!DB_URL) {
  test('new pairs store DB tests (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {});
} else {
  process.env.DATABASE_URL = DB_URL;
  delete process.env.REDIS_URL;

  const db = require('./database');
  const store = require('./newPairStore');

  const A = 'NewPairA11111111111111111111111111111111111';
  const B = 'NewPairB11111111111111111111111111111111111';
  const DET = 'test-detector';
  const T0 = Date.UTC(2026, 10, 12, 12);

  async function clean() {
    await store.ensureSchema();
    await db.pool.query('DELETE FROM newpair_tokens WHERE mint_address = ANY($1)', [[A, B]]);
    await db.pool.query('DELETE FROM newpair_detectors WHERE id = $1', [DET]);
    await db.pool.query(`DELETE FROM newpair_credit_days WHERE source LIKE 'test:%'`);
  }

  describe('newPairStore', () => {
    before(clean);
    after(async () => { await clean(); await db.pool.end(); });

    test('insertGraduations stores new mints once; the first graduation wins', async () => {
      const first = [
        { mint: A, quoteMint: 'So11111111111111111111111111111111111111112', graduatedAt: T0, signature: 'sigA', slot: 100 },
        { mint: B, quoteMint: null, graduatedAt: T0 + 1000, signature: 'sigB', slot: 101 },
        { mint: null, graduatedAt: T0 },          // ignored
        { mint: 'NoTime', graduatedAt: null },    // ignored
      ];
      assert.strictEqual(await store.insertGraduations(DET, 'Test Pad', first), 2);
      assert.strictEqual(await store.insertGraduations(DET, 'Other', [{ mint: A, graduatedAt: T0 + 5000, signature: 'later', slot: 200 }]), 0);
      assert.strictEqual(await store.insertGraduations(DET, 'Test Pad', []), 0);
      const { rows } = await db.pool.query('SELECT * FROM newpair_tokens WHERE mint_address = $1', [A]);
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].graduation_sig, 'sigA');
      assert.strictEqual(Number(rows[0].graduation_slot), 100);
      assert.strictEqual(new Date(rows[0].graduated_at).getTime(), T0);
      assert.strictEqual(rows[0].graduated_source, `onchain:${DET}`);
      assert.strictEqual(rows[0].launchpad, 'Test Pad');
      assert.strictEqual(rows[0].status, 'new');
    });

    test('detector state: empty at first, a failed run keeps the cursor, totals add up', async () => {
      assert.deepStrictEqual(await store.getDetectorState(DET), { cursorSig: null, cursorSlot: null, cursorTime: null, caughtUpAt: null, lastHeliusAt: null });

      await store.saveDetectorRun(DET, { cursor: { sig: 's1', slot: 500, time: T0 }, caughtUpAt: T0 + 1, source: 'helius', usedHelius: true, ok: true, found: 3, unhandled: 1, now: T0 + 2 });
      assert.deepStrictEqual(await store.getDetectorState(DET), { cursorSig: 's1', cursorSlot: 500, cursorTime: T0, caughtUpAt: T0 + 1, lastHeliusAt: T0 + 2 });

      // A failed free run: error recorded, cursor, caught-up time and last Helius time untouched
      await store.saveDetectorRun(DET, { source: 'free', ok: false, error: 'x'.repeat(500), now: T0 + 60_000 });
      assert.deepStrictEqual(await store.getDetectorState(DET), { cursorSig: 's1', cursorSlot: 500, cursorTime: T0, caughtUpAt: T0 + 1, lastHeliusAt: T0 + 2 });
      let { rows } = await db.pool.query('SELECT * FROM newpair_detectors WHERE id = $1', [DET]);
      assert.strictEqual(rows[0].last_error.length, 200);
      assert.strictEqual(rows[0].last_source, 'free');
      assert.strictEqual(new Date(rows[0].last_ok_at).getTime(), T0 + 2);
      assert.strictEqual(new Date(rows[0].last_run_at).getTime(), T0 + 60_000);

      // A good free run moves the cursor and clears the error
      await store.saveDetectorRun(DET, { cursor: { sig: 's2', slot: 600, time: T0 + 90_000 }, source: 'free', ok: true, found: 2, now: T0 + 120_000 });
      const state = await store.getDetectorState(DET);
      assert.strictEqual(state.cursorSig, 's2');
      assert.strictEqual(state.cursorSlot, 600);
      assert.strictEqual(state.lastHeliusAt, T0 + 2);
      ({ rows } = await db.pool.query('SELECT * FROM newpair_detectors WHERE id = $1', [DET]));
      assert.strictEqual(rows[0].last_error, null);
      assert.strictEqual(Number(rows[0].found_total), 5);
      assert.strictEqual(Number(rows[0].unhandled_total), 1);
    });

    test('credits add up per UTC day across sources', async () => {
      const day = Date.UTC(2031, 0, 5, 23, 59); // a day nothing else writes to
      assert.strictEqual(await store.creditsSpentToday(day), 0);
      await store.addCredits('test:discover', 10, day);
      await store.addCredits('test:discover', 30, day);
      await store.addCredits('test:holders', 5, day);
      await store.addCredits('test:holders', 0, day);
      assert.strictEqual(await store.creditsSpentToday(day), 45);
      assert.strictEqual(await store.creditsSpentToday(day + 2 * 60_000), 0); // next UTC day
    });
  });
}
