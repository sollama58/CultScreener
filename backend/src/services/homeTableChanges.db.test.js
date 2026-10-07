/**
 * The home Diamond Hands table's price changes and holder velocity against a real Postgres:
 * the curated_tokens reference-price columns, the leaderboard query that reads them, and the
 * holder velocity query over holder_count_points.
 *
 * Runs only when TEST_DATABASE_URL is set (CI provides a Postgres service).
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');

const DB_URL = process.env.TEST_DATABASE_URL;

if (!DB_URL) {
  test('home table DB tests (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {});
} else {
  process.env.DATABASE_URL = DB_URL;
  delete process.env.REDIS_URL;

  const db = require('./database');
  const holderCounts = require('./holderCounts');
  const priceChanges = require('./priceChanges');

  const UP = 'VelUpMint11111111111111111111111111111111111';
  const NEW = 'VelNewMint1111111111111111111111111111111111';
  const MINTS = [UP, NEW];
  const HOUR = 3_600_000;

  const clean = async () => {
    await db.pool.query('DELETE FROM holder_count_points WHERE mint_address = ANY($1)', [MINTS]);
    await db.pool.query('DELETE FROM curated_tokens WHERE mint_address = ANY($1)', [MINTS]);
    await db.pool.query('DELETE FROM tokens WHERE mint_address = ANY($1)', [MINTS]);
  };

  before(async () => {
    await db.getInitializationPromise();
    // Added by db/migrate.js rather than database.js init, which is all this test runs
    await db.pool.query('ALTER TABLE curated_tokens ADD COLUMN IF NOT EXISTS is_emerging_cult BOOLEAN DEFAULT FALSE');
    await db.pool.query('ALTER TABLE curated_tokens ADD COLUMN IF NOT EXISTS is_tech_coin BOOLEAN DEFAULT FALSE');
    await clean();
  });

  after(async () => {
    await clean();
  });

  describe('holder velocity', () => {
    test('compares the latest complete point with the one 24h earlier', async () => {
      const now = Date.now();
      await holderCounts.recordPoint(UP, { takenAt: now - 29 * HOUR, holders: 1000, source: 'snapshot' });
      await holderCounts.recordPoint(UP, { takenAt: now - 5 * HOUR, holders: 9999, complete: false, source: 'snapshot' });
      await holderCounts.recordPoint(UP, { takenAt: now - 4 * HOUR, holders: 1050, source: 'snapshot' });
      await holderCounts.recordPoint(NEW, { takenAt: now - 2 * HOUR, holders: 500, source: 'snapshot' });

      const v = await holderCounts.getHolderVelocity(MINTS, now);
      assert.deepStrictEqual(v[UP], { level: 2, delta: 50, pct: 5, hours: 25 });
      assert.deepStrictEqual(v[NEW], { level: null });
    });
  });

  describe('reference prices', () => {
    test('stored refs reach the leaderboard row and expire after a failed refresh keeps them', async () => {
      await db.pool.query(
        `INSERT INTO tokens (mint_address, name, symbol, price, market_cap, price_change_24h)
         VALUES ($1, 'Up', 'UP', 2, 2000000, NULL)`, [UP]);
      await db.addCuratedToken(UP, 1000000);

      assert.ok((await db.getCuratedMintsNeedingPriceRefs(50, priceChanges.REFRESH_AFTER_MS)).includes(UP));
      await db.setCuratedPriceRefs(UP, { d1: 1, d7: 4, d30: null });
      assert.ok(!(await db.getCuratedMintsNeedingPriceRefs(50, priceChanges.REFRESH_AFTER_MS)).includes(UP));

      const { tokens } = await db.getTopConvictionTokens(100, 0, { search: 'VelUpMint' });
      const row = tokens.find(r => r.mint_address === UP);
      assert.deepStrictEqual(priceChanges.changesForRow(row),
        { priceChange24h: 100, priceChange7d: -50, priceChange30d: null });

      // A failed refresh moves only the timestamp
      await db.setCuratedPriceRefs(UP, null);
      const { rows } = await db.pool.query('SELECT price_ref_7d FROM curated_tokens WHERE mint_address = $1', [UP]);
      assert.strictEqual(parseFloat(rows[0].price_ref_7d), 4);
    });
  });
}
