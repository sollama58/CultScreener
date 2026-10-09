/**
 * Owner-side API key deletion against a real Postgres: a key an admin revoked must survive the
 * owner's delete, so the owner cannot clear the revoke and register a fresh key (audit #4).
 *
 * Runs only when TEST_DATABASE_URL is set (CI provides a Postgres service).
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');

const DB_URL = process.env.TEST_DATABASE_URL;

if (!DB_URL) {
  test('API key DB tests (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {});
} else {
  process.env.DATABASE_URL = DB_URL;
  delete process.env.REDIS_URL;

  const db = require('./database');

  const ACTIVE = 'KeyActiveOwner111111111111111111111111111111';
  const REVOKED = 'KeyRevokedOwner11111111111111111111111111111';
  const OWNERS = [ACTIVE, REVOKED];

  const clean = () => db.pool.query('DELETE FROM api_keys WHERE owner_wallet = ANY($1)', [OWNERS]);

  before(async () => {
    await db.getInitializationPromise();
    await clean();
    await db.pool.query(
      `INSERT INTO api_keys (key_hash, key_prefix, owner_wallet, is_active)
       VALUES ($1, 'aaaa', $2, true), ($3, 'bbbb', $4, false)`,
      ['a'.repeat(64), ACTIVE, 'b'.repeat(64), REVOKED]
    );
  });

  after(async () => {
    await clean();
  });

  test('deleteApiKey removes an active key but leaves a revoked one in place', async () => {
    const deleted = await db.deleteApiKey(ACTIVE);
    assert.strictEqual(deleted.owner_wallet, ACTIVE);

    assert.strictEqual(await db.deleteApiKey(REVOKED), undefined);
    const { rows } = await db.pool.query('SELECT is_active FROM api_keys WHERE owner_wallet = $1', [REVOKED]);
    assert.deepStrictEqual(rows, [{ is_active: false }]);
  });
}
