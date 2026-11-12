/**
 * New Pairs pruning against a real Postgres: listed tokens past the window are archived
 * with their marks and deleted with their series and samples, never-listed ones are only
 * deleted, tokens inside the window stay, and old archive rows and credit days expire.
 *
 * Runs only when TEST_DATABASE_URL is set (CI provides a Postgres service).
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');

const DB_URL = process.env.TEST_DATABASE_URL;

if (!DB_URL) {
  test('new pairs prune DB tests (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {});
} else {
  process.env.DATABASE_URL = DB_URL;
  delete process.env.REDIS_URL;

  const db = require('./database');
  const store = require('./newPairStore');
  const prune = require('./newPairPrune');

  const HOUR = 3_600_000; const DAY = 24 * HOUR;
  // In the past on purpose: the prune deletes every token older than its cutoff, and the
  // suites run side by side on one database. No other suite has rows from before 2020.
  const NOW = Date.UTC(2020, 5, 15, 12);
  const mint = (c) => `NpPrn${c}`.padEnd(43, '1');
  const [DONE, PROMOTED, HIDDEN, BELOW, UNSCORED, EDGE, FRESH, GONE] = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map(mint);
  const ALL = [DONE, PROMOTED, HIDDEN, BELOW, UNSCORED, EDGE, FRESH, GONE];
  const MARKS = { 1: { at: 1, ageH: 24.1, score: 40, rugged: false, holders: 900, mcap: 80000, liquidity: 20000, f: { hours: 24.1, holders: 900 } } };

  const clean = async () => {
    await store.ensureSchema();
    await db.pool.query('DELETE FROM newpair_tokens WHERE mint_address = ANY($1)', [ALL]);
    await db.pool.query('DELETE FROM newpair_archive WHERE mint_address = ANY($1)', [ALL]);
    await db.pool.query('DELETE FROM curated_tokens WHERE mint_address = ANY($1)', [ALL]);
    await db.pool.query('DELETE FROM tokens WHERE mint_address = ANY($1)', [ALL]);
    await db.pool.query(`DELETE FROM newpair_credit_days WHERE source = 'prune-test'`);
  };
  async function seed(m, ageMs, { status = 'active', score = 50, hidden = false, rugged = false } = {}) {
    await store.insertGraduations('pumpfun', 'Pump.fun', [{ mint: m, graduatedAt: NOW - ageMs, signature: `sig${m.slice(5, 6)}`, slot: 7 }]);
    await db.pool.query(
      `UPDATE newpair_tokens SET status = $2, name = 'Tok', symbol = 'TOK', score = $3, hidden = $4, rugged = $5, marks = $6,
         holder_count = 1500, mcap = 120000, liquidity = 30000, peak_mcap = 400000 WHERE mint_address = $1`,
      [m, status, score, hidden, rugged, JSON.stringify(MARKS)]);
    return (await db.pool.query('SELECT id FROM newpair_tokens WHERE mint_address = $1', [m])).rows[0].id;
  }
  const left = async () => (await db.pool.query('SELECT mint_address FROM newpair_tokens WHERE mint_address = ANY($1) ORDER BY 1', [ALL])).rows.map(r => r.mint_address);
  const archive = async () => (await db.pool.query('SELECT * FROM newpair_archive WHERE mint_address = ANY($1) ORDER BY 1', [ALL])).rows;

  describe('newPairPrune', () => {
    let doneId;
    before(async () => {
      await db.getInitializationPromise();   // curated_tokens comes from database.js
      await clean();
      doneId = await seed(DONE, 14 * DAY + 3 * HOUR, { score: 62.5 });
      await seed(PROMOTED, 15 * DAY);
      await seed(HIDDEN, 15 * DAY, { hidden: true, rugged: true });
      await seed(BELOW, 15 * DAY, { status: 'below_floor', score: null });
      await seed(UNSCORED, 15 * DAY, { score: null });
      await seed(EDGE, 14 * DAY + HOUR);      // past 14 days, inside the 2-hour grace: its day-14 mark may not be stored yet
      await seed(FRESH, 2 * DAY);
      await db.pool.query(`INSERT INTO tokens (mint_address, name, symbol) VALUES ($1, 'Pro', 'PRO') ON CONFLICT DO NOTHING`, [PROMOTED]);
      await db.pool.query(`INSERT INTO curated_tokens (mint_address) VALUES ($1) ON CONFLICT DO NOTHING`, [PROMOTED]);
      await db.pool.query(
        `INSERT INTO newpair_points (token_id, at, price_usd, mcap, liquidity, holder_count, source)
         VALUES ($1, to_timestamp($2 / 1000.0), 0.0001, NULL, 20000, 700, 'jupiter'), ($1, to_timestamp($3 / 1000.0), 0.0001, 75000, 20000, 800, 'jupiter'),
                ($1, to_timestamp($4 / 1000.0), 0.0001, 120000, 30000, 1500, 'jupiter')`,
        [doneId, NOW - 14 * DAY, NOW - 13 * DAY, NOW - DAY]);
      const { rows } = await db.pool.query(
        `INSERT INTO newpair_holder_samples (token_id, taken_at, holder_count, dust_count, complete, top1_pct, top10_pct, top50_pct)
         VALUES ($1, to_timestamp($2 / 1000.0), 1400, 300, TRUE, 4, 20, 40) RETURNING id`, [doneId, NOW - DAY]);
      await db.pool.query(`INSERT INTO newpair_holder_entries (sample_id, rank, wallet, amount) VALUES ($1, 1, 'PruneWallet', '1000')`, [rows[0].id]);
      // An archive row and a credit day past 180 days, and one of each inside
      await db.pool.query(
        `INSERT INTO newpair_archive (mint_address, detector, graduated_at, archived_at) VALUES ($1, 'pumpfun', to_timestamp($2 / 1000.0), to_timestamp($3 / 1000.0))`,
        [GONE, NOW - 200 * DAY, NOW - 181 * DAY]);
      await db.pool.query(
        `INSERT INTO newpair_credit_days (day, source, credits) VALUES ($1, 'prune-test', 5), ($2, 'prune-test', 6)`,
        [store.utcDay(NOW - 181 * DAY), store.utcDay(NOW - 179 * DAY)]);
    });
    after(async () => { await clean(); await db.pool.end(); });

    test('archives what was listed, deletes everything past the window, keeps the rest', async () => {
      const tally = await prune.run({ now: NOW });
      assert.ok(tally.archived >= 3 && tally.deleted >= 5, JSON.stringify(tally));
      assert.ok(tally.archiveExpired >= 1 && tally.creditDaysExpired >= 1, JSON.stringify(tally));
      assert.deepStrictEqual(await left(), [EDGE, FRESH]);

      const rows = await archive();
      assert.deepStrictEqual(rows.map(r => r.mint_address), [DONE, PROMOTED, HIDDEN], 'never-listed tokens and the expired row are not there');
      const done = rows[0];
      assert.strictEqual(done.detector, 'pumpfun');
      assert.strictEqual(done.launchpad, 'Pump.fun');
      assert.strictEqual(done.symbol, 'TOK');
      assert.strictEqual(new Date(done.graduated_at).getTime(), NOW - 14 * DAY - 3 * HOUR);
      assert.strictEqual(new Date(done.archived_at).getTime(), NOW);
      assert.deepStrictEqual(done.marks, MARKS);
      assert.strictEqual(Number(done.final_score), 62.5);
      assert.strictEqual(Number(done.final_holders), 1500);
      assert.strictEqual(Number(done.final_mcap), 120000);
      assert.strictEqual(Number(done.final_liquidity), 30000);
      assert.strictEqual(Number(done.first_mcap), 75000, 'the first point that has a market cap');
      assert.strictEqual(Number(done.peak_mcap), 400000);
      assert.deepStrictEqual([done.rugged, done.hidden, done.promoted], [false, false, false]);
      assert.deepStrictEqual([rows[1].promoted, rows[1].hidden], [true, false]);
      assert.deepStrictEqual([rows[2].promoted, rows[2].hidden, rows[2].rugged], [false, true, true]);
      assert.strictEqual(rows[1].first_mcap, null);
    });

    test('the deleted token took its series, samples and holder entries with it', async () => {
      for (const table of ['newpair_points', 'newpair_holder_samples']) {
        assert.strictEqual((await db.pool.query(`SELECT COUNT(*)::int AS n FROM ${table} WHERE token_id = $1`, [doneId])).rows[0].n, 0, table);
      }
      assert.strictEqual((await db.pool.query(`SELECT COUNT(*)::int AS n FROM newpair_holder_entries WHERE wallet = 'PruneWallet'`)).rows[0].n, 0);
    });

    test('credit days: past 180 days gone, inside kept; a second run does nothing', async () => {
      const { rows } = await db.pool.query(`SELECT credits FROM newpair_credit_days WHERE source = 'prune-test'`);
      assert.deepStrictEqual(rows.map(r => Number(r.credits)), [6]);
      const again = await prune.run({ now: NOW });
      assert.deepStrictEqual(again, { archived: 0, deleted: 0, archiveExpired: 0, creditDaysExpired: 0 });
      assert.strictEqual((await archive()).length, 3);
    });

    test('a token that comes back after being archived replaces its archive row', async () => {
      await seed(DONE, 16 * DAY, { score: 10 });
      await prune.run({ now: NOW + HOUR });
      const rows = (await archive()).filter(r => r.mint_address === DONE);
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(Number(rows[0].final_score), 10);
    });
  });
}
