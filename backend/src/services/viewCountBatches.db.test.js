/**
 * batch-view-counts applies each batch once (audit #179): BullMQ re-runs a job that
 * stalled after its COMMIT, and that re-run must not count the views again.
 *
 * Runs the worker's processor against a fresh schema created by initializeDatabase, in
 * its own throwaway schema (search_path) like freshSchema.db.test.js.
 * Runs only when TEST_DATABASE_URL is set.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');

const DB_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = `views_${process.pid}`;

if (!DB_URL) {
  test('view count batch DB tests (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {});
} else {
  const withSchema = (url) => {
    const u = new URL(url);
    u.searchParams.set('options', `-c search_path=${SCHEMA}`);
    return u.toString();
  };
  const admin = new Pool({ connectionString: DB_URL });
  let db;
  let jobProcessors;

  before(async () => {
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    process.env.DATABASE_URL = withSchema(DB_URL);
    delete process.env.REDIS_URL;
    db = require('./database');
    assert.strictEqual(await db.getInitializationPromise(), true);
    ({ jobProcessors } = require('../worker'));
  });

  after(async () => {
    await db?.pool.end().catch(() => {});
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.end();
  });

  const views = async (mint) => {
    const { rows } = await db.pool.query('SELECT view_count FROM token_views WHERE token_mint = $1', [mint]);
    return rows[0]?.view_count ?? 0;
  };

  test('a re-run of the same batch adds its views once', async () => {
    const MINT = 'ViewBatchMint111111111111111111111111111111';
    const job = { data: { batchId: 'views-test-1', updates: [{ tokenMint: MINT, count: 3 }] } };
    assert.deepStrictEqual(await jobProcessors['batch-view-counts'](job), { updated: 1, errors: 0 });
    assert.deepStrictEqual(await jobProcessors['batch-view-counts'](job), { updated: 0, duplicate: true });
    assert.strictEqual(await views(MINT), 3);

    await jobProcessors['batch-view-counts']({ data: { batchId: 'views-test-2', updates: [{ tokenMint: MINT, count: 2 }] } });
    assert.strictEqual(await views(MINT), 5, 'a new batch still counts');
  });

  test('a batch queued before batch ids existed is applied as before', async () => {
    const MINT = 'ViewBatchMint222222222222222222222222222222';
    await jobProcessors['batch-view-counts']({ data: { updates: [{ tokenMint: MINT, count: 4 }] } });
    assert.strictEqual(await views(MINT), 4);
  });
}
