/**
 * The GDPR deletion route's cache clean-up: utility access the cache holds for a wallet goes
 * with its database rows. Uses the in-memory cache; nothing touches Redis or Postgres.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { cache } = require('../services/cache');
const { forgetWalletAccess } = require('./watchlist');
const { recordIssuedToken } = require('../services/accessTokens');

const WALLET = 'Gdpr111111111111111111111111111111111111111';
const OTHER = 'Keep111111111111111111111111111111111111111';
const MINT = 'Mint111111111111111111111111111111111111111';
const TTL = 60_000;

describe('forgetWalletAccess', () => {
  test('drops the wallet\'s access tokens, issued-token records and My Utilities index, and nothing else', async () => {
    await cache.set(`hb:wallet-idx:${WALLET}`, [{ mint: MINT, expiresAt: Date.now() + TTL }], TTL);
    await cache.set(`hb:access:tokHb`, { wallet: WALLET, mint: MINT, expiresAt: Date.now() + TTL }, TTL);
    await cache.set(`hb:access-by:${WALLET}:${MINT}`, { token: 'tokHb', expiresAt: Date.now() + TTL }, TTL);
    // A Cultify token issued without an access-by record is found through the issued record
    await cache.set(`cultify:access:tokCult`, { wallet: WALLET, mint: MINT }, TTL);
    await recordIssuedToken('cultify', WALLET, MINT, 'tokCult', TTL);
    await cache.set(`cultify:access:tokOther`, { wallet: OTHER, mint: MINT }, TTL);
    await recordIssuedToken('cultify', OTHER, MINT, 'tokOther', TTL);
    await cache.set(`hb:wallet-idx:${OTHER}`, [{ mint: MINT, expiresAt: Date.now() + TTL }], TTL);

    await forgetWalletAccess(WALLET);

    for (const key of [`hb:wallet-idx:${WALLET}`, 'hb:access:tokHb', `hb:access-by:${WALLET}:${MINT}`, 'cultify:access:tokCult', `cultify:issued:${WALLET}`]) {
      assert.strictEqual(await cache.get(key), undefined, key);
    }
    assert.ok(await cache.get('cultify:access:tokOther'));
    assert.ok(await cache.get(`hb:wallet-idx:${OTHER}`));
    assert.ok(await cache.get(`cultify:issued:${OTHER}`));
  });

  test('never scans the keyspace', async () => {
    const scan = cache.scanKeys;
    cache.scanKeys = async () => { throw new Error('scanKeys called'); };
    try {
      await forgetWalletAccess(WALLET);
    } finally {
      cache.scanKeys = scan;
    }
  });
});
