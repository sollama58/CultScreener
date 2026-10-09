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

  describe('session expiry', () => {
    const MINUTE = 60_000;
    const WALLET = 'FreshWallet111111111111111111111111111111111';

    test('a two-minute pairing code is valid when Node and Postgres disagree on the time zone', async () => {
      await db.createDeviceSession('fresh-pairing', WALLET, new Date(Date.now() + 2 * MINUTE));
      // Used to be 9 hours stale on arrival: the +00:00 offset was dropped and the wall-clock
      // time read back as Tokyo time
      assert.ok(await db.getDeviceSession('fresh-pairing'));
      const activated = await db.activateDeviceSession('fresh-pairing', 'fresh-session');
      assert.ok(activated);
      assert.ok(await db.getDeviceSession('fresh-session'));
    });

    test('an expired pairing code is not valid', async () => {
      await db.createDeviceSession('fresh-expired', WALLET, new Date(Date.now() - MINUTE));
      assert.strictEqual(await db.getDeviceSession('fresh-expired'), undefined);
    });

    test('admin sessions last as long as asked, no more', async () => {
      await db.createAdminSession('fresh-admin', new Date(Date.now() + MINUTE));
      assert.ok(await db.getAdminSession('fresh-admin'));
      await db.createAdminSession('fresh-admin-old', new Date(Date.now() - MINUTE));
      assert.strictEqual(await db.getAdminSession('fresh-admin-old'), undefined);
    });

    test('boot converts session columns left as TIMESTAMP by older versions', async () => {
      await db.pool.query('ALTER TABLE device_sessions ALTER COLUMN expires_at TYPE TIMESTAMP');
      await db.pool.query('ALTER TABLE admin_sessions ALTER COLUMN expires_at TYPE TIMESTAMP');
      // An older version never recorded the schema it applied
      await db.pool.query(`DELETE FROM app_settings WHERE key = 'schema_ddl_hash'`);
      assert.strictEqual(await db.initializeDatabase(), true);
      const { rows } = await db.pool.query(
        `SELECT table_name, column_name, data_type FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name IN ('admin_sessions', 'device_sessions')
           AND column_name IN ('created_at', 'activated_at', 'expires_at')`);
      assert.strictEqual(rows.length, 5);
      for (const r of rows) assert.strictEqual(r.data_type, 'timestamp with time zone', `${r.table_name}.${r.column_name}`);
      // Still valid after the conversion
      assert.ok(await db.getDeviceSession('fresh-session'));
    });
  });

  describe('GDPR deletion', () => {
    test('every statement gets the 2-minute budget, not the pool\'s 30-second client timeout', async () => {
      const WALLET = 'FreshGdpr1111111111111111111111111111111111';
      await db.pool.query('INSERT INTO watchlist (wallet_address, token_mint) VALUES ($1, $2)',
        [WALLET, 'FreshGdprMint111111111111111111111111111111']);

      const seen = [];
      const connect = db.pool.connect;
      db.pool.connect = async function () {
        const client = await connect.call(this);
        const real = client.query;
        client.query = function (config, values) {
          seen.push(typeof config === 'object' ? config.query_timeout : undefined);
          return real.call(this, config, values);
        };
        const release = client.release;
        client.release = function (...args) {
          client.query = real;
          client.release = release;
          return release.apply(this, args);
        };
        return client;
      };
      let result;
      try {
        result = await db.deleteUserData(WALLET);
      } finally {
        db.pool.connect = connect;
      }
      assert.strictEqual(result.deleted.watchlist, 1);
      assert.ok(seen.length > 5);
      assert.deepStrictEqual(seen.filter(t => t !== 120000), []);
    });
  });

  describe('schema step at boot', () => {
    // A second connection into the same schema, to hold locks the way live traffic does
    let other;
    before(() => { other = new Pool({ connectionString: withOptions(DB_URL), max: 1 }); });
    after(() => other.end());

    test('records the schema it applied, and a restart with the same schema takes no table locks', async () => {
      const { rows } = await db.pool.query(`SELECT value FROM app_settings WHERE key = 'schema_ddl_hash'`);
      assert.match(rows[0].value, /^[0-9a-f]{64}$/);
      const holder = await other.connect();
      try {
        await holder.query('BEGIN');
        await holder.query('LOCK TABLE tokens IN ACCESS SHARE MODE');
        const started = Date.now();
        assert.strictEqual(await db.initializeDatabase(), true);
        // Used to queue an ACCESS EXCLUSIVE request behind this transaction (and every
        // later tokens query behind that) on each start
        assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
        assert.strictEqual(db.isReady(), true);
      } finally {
        await holder.query('ROLLBACK');
        holder.release();
      }
    });

    test('a changed schema waits at most a few seconds for a busy table, then retries', async () => {
      await db.pool.query(`UPDATE app_settings SET value = 'older' WHERE key = 'schema_ddl_hash'`);
      const holder = await other.connect();
      try {
        await holder.query('BEGIN');
        await holder.query('LOCK TABLE tokens IN ACCESS SHARE MODE');
        const started = Date.now();
        assert.strictEqual(await db.initializeDatabase(), false);
        const took = Date.now() - started;
        assert.ok(took >= 4000 && took < 15000, `took ${took} ms`);
      } finally {
        await holder.query('ROLLBACK');
        holder.release();
      }
      // Not recorded as applied, so the next attempt runs it
      const { rows } = await db.pool.query(`SELECT value FROM app_settings WHERE key = 'schema_ddl_hash'`);
      assert.strictEqual(rows[0].value, 'older');
      assert.strictEqual(await db.initializeDatabase(), true);
      const again = await db.pool.query(`SELECT value FROM app_settings WHERE key = 'schema_ddl_hash'`);
      assert.match(again.rows[0].value, /^[0-9a-f]{64}$/);
    });

    test('token timestamps have a time zone, so conviction times are right whatever the session zone', async () => {
      const MINT = 'FreshTz111111111111111111111111111111111111';
      await db.pool.query('ALTER TABLE tokens ALTER COLUMN conviction_computed_at TYPE TIMESTAMP');
      await db.pool.query('ALTER TABLE token_views ALTER COLUMN last_viewed_at TYPE TIMESTAMP');
      await db.pool.query(`DELETE FROM app_settings WHERE key = 'schema_ddl_hash'`);
      assert.strictEqual(await db.initializeDatabase(), true);
      const { rows } = await db.pool.query(
        `SELECT table_name, column_name, data_type FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND ((table_name = 'tokens' AND column_name IN ('pair_created_at', 'created_at', 'updated_at', 'conviction_computed_at'))
             OR (table_name = 'token_views' AND column_name IN ('last_viewed_at', 'created_at')))`);
      assert.strictEqual(rows.length, 6);
      for (const r of rows) assert.strictEqual(r.data_type, 'timestamp with time zone', `${r.table_name}.${r.column_name}`);

      await db.pool.query('INSERT INTO tokens (mint_address) VALUES ($1)', [MINT]);
      await db.upsertConviction(MINT, { '1m': 50 }, 10, 10);
      const token = await db.getToken(MINT);
      // Was 9 hours in the future with a TIMESTAMP column in a Tokyo session
      assert.ok(Math.abs(new Date(token.conviction_computed_at).getTime() - Date.now()) < 60_000);
    });
  });

  describe('pool errors', () => {
    test('an idle connection failing does not take the database offline', async () => {
      assert.strictEqual(db.isReady(), true);
      db.pool.emit('error', new Error('Connection terminated unexpectedly'));
      assert.strictEqual(db.isReady(), true);
      await new Promise(r => setTimeout(r, 100)); // the probe query succeeds
      assert.strictEqual(db.isReady(), true);
    });

    test('a connection dropped mid-transaction fails that transaction, not the process', async () => {
      const client = await db.pool.connect();
      try {
        await client.query('BEGIN');
        const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        await admin.query('SELECT pg_terminate_backend($1)', [pid]);
        // Without a listener, pg's 'error' event on the checked-out client was an uncaught exception
        await new Promise(r => setTimeout(r, 200));
        await assert.rejects(client.query('SELECT 1'));
      } finally {
        client.release();
      }
      const { rows } = await db.pool.query('SELECT 1 AS ok');
      assert.strictEqual(rows[0].ok, 1);
    });
  });

  // Last: it drops every table in the schema
  describe('db:reset', () => {
    test('drops every table, so submissions work again after the app recreates them', async () => {
      const submit = (n) => db.createSubmission({
        tokenMint: 'FreshReset111111111111111111111111111111111',
        submissionType: 'website',
        contentUrl: `https://example.com/${n}`,
      });
      await submit(1);
      await submit(2);

      const migrate = require('../../db/migrate');
      try {
        assert.strictEqual(await migrate.resetDatabase(), true);
      } finally {
        await migrate.pool.end();
      }
      const { rows } = await db.pool.query('SELECT tablename FROM pg_tables WHERE schemaname = current_schema()');
      assert.deepStrictEqual(rows, []);

      // App boot recreates the schema; the first new submission reuses id 1
      assert.strictEqual(await db.initializeDatabase(), true);
      const created = await submit(1);
      assert.strictEqual(created.id, 1);
    });
  });
}
