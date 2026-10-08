/**
 * database.js against an empty schema, as on a fresh install: initializeDatabase alone (no
 * db/migrate.js, no init.sql) must leave every table and column the app reads in place.
 *
 * Runs in its own throwaway schema (search_path) so it neither sees nor disturbs the tables the
 * other DB tests share. The session TimeZone is set far from UTC on purpose: timestamps the app
 * writes from JS Dates must still compare correctly against NOW().
 *
 * Runs only when TEST_DATABASE_URL is set (CI provides a Postgres service).
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');

const DB_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = `fresh_${process.pid}`;

if (!DB_URL) {
  test('fresh schema DB tests (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {});
} else {
  // Node in UTC, Postgres session in UTC+9: a mismatch the schema has to survive
  process.env.TZ = 'UTC';
  const withOptions = (url) => {
    const u = new URL(url);
    u.searchParams.set('options', `-c search_path=${SCHEMA} -c timezone=Asia/Tokyo`);
    return u.toString();
  };
  const admin = new Pool({ connectionString: DB_URL });
  let db;

  before(async () => {
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    process.env.DATABASE_URL = withOptions(DB_URL);
    delete process.env.REDIS_URL;
    db = require('./database');
    assert.strictEqual(await db.getInitializationPromise(), true);
  });

  after(async () => {
    await db?.pool.end().catch(() => {});
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.end();
  });

  describe('curated tokens', () => {
    test('initializeDatabase creates the emerging-cult and tech-coin flags', async () => {
      const MINT = 'FreshCurated1111111111111111111111111111111';
      await db.addCuratedToken(MINT);
      await db.setEmergingCult(MINT, true);
      await db.setTechCoin(MINT, true);
      const token = await db.getCuratedToken(MINT);
      assert.strictEqual(token.emergingCult, true);
      assert.strictEqual(token.techCoin, true);
      const list = await db.getCuratedTokens();
      assert.ok(list.some(t => t.mintAddress === MINT));
      const board = await db.getTopConvictionTokens(10, 0);
      assert.ok(board.tokens.some(t => t.mint_address === MINT));
    });
  });
}
