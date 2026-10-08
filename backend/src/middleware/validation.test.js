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
