/**
 * Helius credit days in Postgres: the month line survives losing the Redis keys.
 *
 * Runs only when TEST_DATABASE_URL is set (CI provides a Postgres service).
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');

const DB_URL = process.env.TEST_DATABASE_URL;

if (!DB_URL) {
  test('helius credit DB tests (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {});
} else {
  process.env.DATABASE_URL = DB_URL;
  delete process.env.REDIS_URL;

  const db = require('./database');
  const { cache } = require('./cache');
  const credits = require('./heliusCredits');
  const today = new Date().toISOString().slice(0, 10);

  const stored = async () => {
    const { rows } = await db.pool.query('SELECT credits FROM helius_credit_days WHERE day = $1', [today]);
    return rows.length ? Number(rows[0].credits) : 0;
  };

  before(async () => { await db.getInitializationPromise(); });
  after(async () => { await db.pool.end(); });

  describe('helius credit days (Postgres)', () => {
    test('each flush adds the day total to Postgres, read back when Redis lost the day (audit #102)', async () => {
      const base = await stored();
      credits.count('getTokenAccounts', 10);
      credits.count('getTokenAccounts', 20);
      await credits.flush();
      assert.ok(await stored() >= base + 30, 'day total stored');

      // Redis restarted: every helius key is gone
      for (const k of await cache.scanKeys('helius-*')) await cache.delete(k);
      assert.ok(await cache.get(`helius-credits:${today}`) == null);
      const u = await credits.getUsage({ fresh: true });
      assert.ok(u.today.credits >= base + 30, `today still counted (${u.today.credits})`);
      assert.ok(u.month.toDate >= base + 30);
    });
  });
}
