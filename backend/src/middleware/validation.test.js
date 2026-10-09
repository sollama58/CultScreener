/**
 * validateSearch rejects non-string / blank q; checkAndMarkSignature falls back to the
 * in-memory store when Redis can't answer; the GDPR deletion signature is single-use.
 */
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert');
const nacl = require('tweetnacl');
const bs58 = require('bs58');
const { cache } = require('../services/cache');
const validation = require('./validation');

function run(mw, req) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(body) { resolve({ next: false, status: this.statusCode, body }); return this; }
    };
    Promise.resolve(mw(req, res, () => resolve({ next: true, req }))).catch(err => resolve({ error: err }));
  });
}

describe('validateSearch', () => {
  for (const [label, q] of [['array', ['ab', 'cd']], ['object', { a: 'bc' }], ['whitespace', '   '], ['missing', undefined]]) {
    test(`rejects ${label} q with 400`, async () => {
      const out = await run(validation.validateSearch, { query: { q } });
      assert.strictEqual(out.next, false);
      assert.strictEqual(out.status, 400);
    });
  }

  test('passes a normal query through, trimmed', async () => {
    const out = await run(validation.validateSearch, { query: { q: '  bonk ' } });
    assert.strictEqual(out.next, true);
    assert.strictEqual(out.req.query.q, 'bonk');
  });
});

describe('checkAndMarkSignature with an unreachable Redis', () => {
  const saved = {};
  afterEach(() => Object.assign(cache, saved));

  test('a fresh signature is accepted once, then reported as replay', async () => {
    Object.assign(saved, { getBackendType: cache.getBackendType, setNX: cache.setNX, get: cache.get });
    // What RedisCache does while disconnected: setNX -> false, get -> undefined, never throws
    cache.getBackendType = () => 'redis';
    cache.setNX = async () => false;
    cache.get = async () => undefined;
    const sig = `fresh-${Date.now()}-${Math.random()}`;
    assert.strictEqual(await validation.checkAndMarkSignature(sig, 60000), false);
    assert.strictEqual(await validation.checkAndMarkSignature(sig, 60000), true);
  });

  test('a key really present in Redis is still a replay', async () => {
    Object.assign(saved, { getBackendType: cache.getBackendType, setNX: cache.setNX, get: cache.get });
    cache.getBackendType = () => 'redis';
    cache.setNX = async () => false;
    cache.get = async () => 1;
    assert.strictEqual(await validation.checkAndMarkSignature(`seen-${Math.random()}`, 60000), true);
  });
});

describe('validateWalletSignature (data deletion)', () => {
  test('the same signature cannot be used twice', async () => {
    const kp = nacl.sign.keyPair();
    const wallet = bs58.encode(kp.publicKey);
    const ts = Date.now();
    const msg = new TextEncoder().encode(validation.createDataDeletionSignatureMessage(wallet, ts));
    const signature = Array.from(nacl.sign.detached(msg, kp.secretKey));
    const body = { wallet, signature, signatureTimestamp: ts };

    const first = await run(validation.validateWalletSignature, { body: { ...body } });
    assert.strictEqual(first.next, true);
    const second = await run(validation.validateWalletSignature, { body: { ...body } });
    assert.strictEqual(second.next, false);
    assert.strictEqual(second.status, 400);
    assert.strictEqual(second.body.code, 'SIGNATURE_REPLAY');
  });
});

describe('device link signatures name their action', () => {
  function signed(message, kp) {
    return Array.from(nacl.sign.detached(new TextEncoder().encode(message), kp.secretKey));
  }

  test('a signature given to list or unlink phones is refused by /pair', async () => {
    const kp = nacl.sign.keyPair();
    const wallet = bs58.encode(kp.publicKey);
    const ts = Date.now();
    for (const message of [
      validation.createDeviceListSignatureMessage(wallet, ts),
      validation.createDeviceRevokeSignatureMessage(wallet, ts, 'all'),
      validation.createDeviceRevokeSignatureMessage(wallet, ts, 7),
    ]) {
      const out = await run(validation.validateDeviceLinkSignature, {
        body: { wallet, signature: signed(message, kp), signatureTimestamp: ts }
      });
      assert.strictEqual(out.next, false, message);
      assert.strictEqual(out.status, 401);
    }
  });

  test('a pairing signature is refused by list and unlink', async () => {
    const kp = nacl.sign.keyPair();
    const wallet = bs58.encode(kp.publicKey);
    const ts = Date.now();
    const signature = signed(validation.createDeviceLinkSignatureMessage(wallet, ts), kp);
    const list = await run(validation.validateDeviceListSignature, { body: { wallet, signature, signatureTimestamp: ts } });
    assert.strictEqual(list.status, 401);
    const revoke = await run(validation.validateDeviceRevokeSignature, { body: { wallet, signature, signatureTimestamp: ts, all: true } });
    assert.strictEqual(revoke.status, 401);
  });

  test('unlinking is bound to the device it names', async () => {
    const kp = nacl.sign.keyPair();
    const wallet = bs58.encode(kp.publicKey);
    const ts = Date.now();
    const signature = signed(validation.createDeviceRevokeSignatureMessage(wallet, ts, 7), kp);
    const other = await run(validation.validateDeviceRevokeSignature, { body: { wallet, signature, signatureTimestamp: ts, deviceId: 8 } });
    assert.strictEqual(other.status, 401);
    const all = await run(validation.validateDeviceRevokeSignature, { body: { wallet, signature, signatureTimestamp: ts, all: true } });
    assert.strictEqual(all.status, 401);
    const same = await run(validation.validateDeviceRevokeSignature, { body: { wallet, signature, signatureTimestamp: ts, deviceId: 7 } });
    assert.strictEqual(same.next, true);
    assert.strictEqual(same.req.linkedWallet, wallet);
  });

  test('each action accepts its own message', async () => {
    const kp = nacl.sign.keyPair();
    const wallet = bs58.encode(kp.publicKey);
    const ts = Date.now();
    const pair = await run(validation.validateDeviceLinkSignature, {
      body: { wallet, signature: signed(validation.createDeviceLinkSignatureMessage(wallet, ts), kp), signatureTimestamp: ts }
    });
    assert.strictEqual(pair.next, true);
    const list = await run(validation.validateDeviceListSignature, {
      body: { wallet, signature: signed(validation.createDeviceListSignatureMessage(wallet, ts), kp), signatureTimestamp: ts }
    });
    assert.strictEqual(list.next, true);
    const all = await run(validation.validateDeviceRevokeSignature, {
      body: { wallet, signature: signed(validation.createDeviceRevokeSignatureMessage(wallet, ts, 'all'), kp), signatureTimestamp: ts, all: true }
    });
    assert.strictEqual(all.next, true);
  });
});
