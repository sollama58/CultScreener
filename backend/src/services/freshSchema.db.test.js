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

  describe('conviction rank', () => {
    const mint = (tag) => `Rank${tag}`.padEnd(44, '1');
    const token = (m, conviction) => db.pool.query(
      'INSERT INTO tokens (mint_address, conviction_1m) VALUES ($1, $2)', [m, conviction]);

    test('ranks curated tokens with a score, and nothing else', async () => {
      await token(mint('Top'), 90);
      await token(mint('Mid'), 50);
      await token(mint('NoScore'), null);
      await token(mint('Zero'), 0);
      await token(mint('Outsider'), 99);
      for (const tag of ['Top', 'Mid', 'NoScore', 'Zero']) await db.addCuratedToken(mint(tag));

      assert.strictEqual(await db.getTokenConvictionRank(mint('Top')), 1);
      assert.strictEqual(await db.getTokenConvictionRank(mint('Mid')), 2);
      // Used to be rank 1: NULL compared with every row, so nothing counted as above it
      assert.strictEqual(await db.getTokenConvictionRank(mint('NoScore')), null);
      assert.strictEqual(await db.getTokenConvictionRank(mint('Zero')), null);
      // Not curated, so not on the leaderboard however high its score
      assert.strictEqual(await db.getTokenConvictionRank(mint('Outsider')), null);
      assert.strictEqual(await db.getTokenConvictionRank(mint('Missing')), null);
    });
  });

  describe('reference prices', () => {
    const MINT = 'FreshRefs11111111111111111111111111111111111';
    const priceChanges = require('./priceChanges');
    const needing = () => db.getCuratedMintsNeedingPriceRefs(50, priceChanges.REFRESH_AFTER_MS);
    const row = async () => (await db.getTopConvictionTokens(100, 0, { search: 'FreshRefs' }))
      .tokens.find(r => r.mint_address === MINT);

    test('failed refreshes leave the queue alone but do not keep old references fresh', async () => {
      await db.pool.query(
        `INSERT INTO tokens (mint_address, name, symbol, price, price_change_24h) VALUES ($1, 'R', 'R', 2, 5)`, [MINT]);
      await db.addCuratedToken(MINT);
      await db.setCuratedPriceRefs(MINT, { d1: 1, d7: 4, d30: 1 });
      assert.strictEqual(priceChanges.changesForRow(await row()).priceChange7d, -50);

      // Two days of failing refreshes: the refs were computed two days ago...
      await db.pool.query(
        `UPDATE curated_tokens SET price_refs_at = NOW() - INTERVAL '2 days', price_refs_tried_at = NOW() - INTERVAL '2 days'
         WHERE mint_address = $1`, [MINT]);
      assert.ok((await needing()).includes(MINT));
      // ...and the latest attempt just failed again
      await db.setCuratedPriceRefs(MINT, null);

      // To the back of the queue, as before
      assert.ok(!(await needing()).includes(MINT));
      // but the two-day-old references are no longer shown as 7d/30d changes
      const changes = priceChanges.changesForRow(await row());
      assert.strictEqual(changes.priceChange7d, null);
      assert.strictEqual(changes.priceChange30d, null);
    });
  });
}
