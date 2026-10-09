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

describe('checkAndMarkSignature across a Redis reconnect', () => {
  const saved = {};
  afterEach(() => Object.assign(cache, saved));

  test('a signature marked in memory during the outage is still a replay once Redis is back', async () => {
    Object.assign(saved, { getBackendType: cache.getBackendType, setNX: cache.setNX, get: cache.get });
    cache.getBackendType = () => 'redis';
    // Outage: setNX/get answer as a disconnected RedisCache does
    cache.setNX = async () => false;
    cache.get = async () => undefined;
    const sig = `outage-${Date.now()}-${Math.random()}`;
    assert.strictEqual(await validation.checkAndMarkSignature(sig, 60000), false);

    // Reconnected, with no key for this signature: SET NX would succeed
    cache.setNX = async () => true;
    assert.strictEqual(await validation.checkAndMarkSignature(sig, 60000), true);
  });
});

// Ed25519 group order; S + L verifies under tweetnacl but is a different byte string.
const ED25519_L = (1n << 252n) + 27742317777372353535851937790883648493n;
function addLToS(signature) {
  let s = 0n;
  for (let i = 63; i >= 32; i--) s = (s << 8n) | BigInt(signature[i]);
  s += ED25519_L;
  const out = signature.slice();
  for (let i = 32; i < 64; i++) { out[i] = Number(s & 0xffn); s >>= 8n; }
  return s === 0n ? out : null; // null when S + L no longer fits in 32 bytes
}

describe('verifyWalletSignature', () => {
  test('rejects a non-canonical (S + L) variant of a valid signature', () => {
    for (let attempt = 0; attempt < 20; attempt++) {
      const kp = nacl.sign.keyPair();
      const wallet = bs58.encode(kp.publicKey);
      const msg = `HolDEX Link Device: ${wallet} at ${Date.now()}`;
      const signature = Array.from(nacl.sign.detached(new TextEncoder().encode(msg), kp.secretKey));
      const malleated = addLToS(signature);
      if (!malleated) continue;
      // tweetnacl itself accepts it; the wrapper must not
      assert.strictEqual(nacl.sign.detached.verify(new TextEncoder().encode(msg), new Uint8Array(malleated), kp.publicKey), true);
      assert.strictEqual(validation.verifyWalletSignature(msg, signature, wallet), true);
      assert.strictEqual(validation.verifyWalletSignature(msg, malleated, wallet), false);
      return;
    }
    assert.fail('no signature with room for S + L in 20 attempts');
  });
});

// Every wallet-signature middleware: a valid signature passes once, and is refused when it is
// from another wallet, expired, replayed, non-canonical, or signed for a different action/token.
describe('wallet-signature middlewares', () => {
  const MINT = 'So11111111111111111111111111111111111111112';
  const OTHER_MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
  const sign = (kp, msg) => Array.from(nacl.sign.detached(new TextEncoder().encode(msg), kp.secretKey));

  // build(wallet, ts, mint) -> { req fields without signature, message the wallet must sign }
  const cases = [
    {
      name: 'validateDeviceLinkSignature', mw: validation.validateDeviceLinkSignature,
      build: (wallet, ts) => ({ body: { wallet, signatureTimestamp: ts }, message: validation.createDeviceLinkSignatureMessage(wallet, ts) }),
      wrongAction: (wallet, ts) => validation.createDataDeletionSignatureMessage(wallet, ts)
    },
    {
      name: 'validateWalletSignature', mw: validation.validateWalletSignature,
      build: (wallet, ts) => ({ body: { wallet, signatureTimestamp: ts }, message: validation.createDataDeletionSignatureMessage(wallet, ts) }),
      wrongAction: (wallet, ts) => validation.createDeviceLinkSignatureMessage(wallet, ts)
    },
    {
      name: 'validateWatchlistSignature (add)', mw: validation.validateWatchlistSignature,
      build: (wallet, ts, mint) => ({ method: 'POST', body: { wallet, tokenMint: mint, signatureTimestamp: ts }, message: validation.createWatchlistSignatureMessage('add', wallet, mint, ts) }),
      wrongAction: (wallet, ts) => validation.createWatchlistSignatureMessage('remove', wallet, MINT, ts)
    },
    {
      name: 'validateWatchlistSignature (remove)', mw: validation.validateWatchlistSignature,
      build: (wallet, ts, mint) => ({ method: 'DELETE', body: { wallet, tokenMint: mint, signatureTimestamp: ts }, message: validation.createWatchlistSignatureMessage('remove', wallet, mint, ts) }),
      wrongAction: (wallet, ts) => validation.createWatchlistSignatureMessage('add', wallet, MINT, ts)
    },
    {
      name: 'validateVoteSignature', mw: validation.validateVoteSignature,
      build: (wallet, ts) => ({ body: { submissionId: 42, voterWallet: wallet, voteType: 'up', signatureTimestamp: ts }, message: validation.createVoteSignatureMessage('up', 42, ts) }),
      wrongAction: (wallet, ts) => validation.createVoteSignatureMessage('down', 42, ts)
    },
    {
      name: 'validateBatchVoteSignature', mw: validation.validateBatchVoteSignature,
      build: (wallet, ts) => {
        const votes = [{ submissionId: 2, voteType: 'up' }, { submissionId: 1, voteType: 'down' }];
        return { body: { votes, voterWallet: wallet, signatureTimestamp: ts }, message: validation.createBatchVoteSignatureMessage(votes, wallet, ts) };
      },
      wrongAction: (wallet, ts) => validation.createBatchVoteSignatureMessage([{ submissionId: 2, voteType: 'down' }, { submissionId: 1, voteType: 'down' }], wallet, ts)
    },
    {
      name: 'validateSubmissionSignature', mw: validation.validateSubmissionSignature,
      build: (wallet, ts, mint) => ({ body: { tokenMint: mint, submissionType: 'twitter', submitterWallet: wallet, signatureTimestamp: ts }, message: validation.createSubmissionSignatureMessage('twitter', mint, ts) }),
      wrongAction: (wallet, ts) => validation.createSubmissionSignatureMessage('banner', MINT, ts)
    },
    {
      name: 'validateBatchSubmissionSignature', mw: validation.validateBatchSubmissionSignature,
      build: (wallet, ts, mint) => {
        const submissions = [{ submissionType: 'twitter' }, { submissionType: 'banner' }];
        return { body: { tokenMint: mint, submissions, submitterWallet: wallet, signatureTimestamp: ts }, message: validation.createBatchSubmissionSignatureMessage(['twitter', 'banner'], mint, ts) };
      },
      wrongAction: (wallet, ts) => validation.createBatchSubmissionSignatureMessage(['twitter'], MINT, ts)
    },
    {
      name: 'validateSentimentSignature', mw: validation.validateSentimentSignature,
      build: (wallet, ts, mint) => ({ params: { mint }, body: { voterWallet: wallet, sentiment: 'bullish', signatureTimestamp: ts }, message: validation.createSentimentSignatureMessage('bullish', mint, wallet, ts) }),
      wrongAction: (wallet, ts) => validation.createSentimentSignatureMessage('bearish', MINT, wallet, ts)
    },
    {
      name: 'validateCallSignature', mw: validation.validateCallSignature,
      build: (wallet, ts, mint) => ({ params: { mint }, body: { callerWallet: wallet, signatureTimestamp: ts }, message: validation.createCallSignatureMessage(mint, wallet, ts) }),
      wrongAction: (wallet, ts) => validation.createSentimentSignatureMessage('bullish', MINT, wallet, ts)
    },
    {
      name: "requireApiKeySignature('rotate')", mw: validation.requireApiKeySignature('rotate'),
      build: (wallet, ts) => ({ body: { wallet, signatureTimestamp: ts }, message: validation.createApiKeySignatureMessage(wallet, ts, 'rotate') }),
      wrongAction: (wallet, ts) => validation.createApiKeySignatureMessage(wallet, ts, 'register')
    }
  ];

  // A request for MINT whose body carries `signature` (the message was signed by `kp`)
  function request(c, kp, ts, signedMessage, overrides = {}) {
    const wallet = overrides.wallet || bs58.encode(kp.publicKey);
    const built = c.build(wallet, ts, MINT);
    const signature = overrides.signature || sign(kp, signedMessage || built.message);
    return {
      method: built.method || 'POST',
      params: { ...(built.params || {}) },
      body: { ...built.body, signature },
      header: () => undefined
    };
  }

  for (const c of cases) {
    describe(c.name, () => {
      test('passes a valid signature once, then refuses the replay', async () => {
        const kp = nacl.sign.keyPair();
        const req = request(c, kp, Date.now());
        const first = await run(c.mw, { ...req, body: { ...req.body } });
        assert.strictEqual(first.next, true, JSON.stringify(first.body));
        const second = await run(c.mw, { ...req, body: { ...req.body } });
        assert.strictEqual(second.status, 400);
        assert.strictEqual(second.body.code, 'SIGNATURE_REPLAY');
      });

      test('refuses a signature from another wallet', async () => {
        const kp = nacl.sign.keyPair();
        const other = nacl.sign.keyPair();
        const ts = Date.now();
        const claimed = bs58.encode(kp.publicKey);
        const req = request(c, kp, ts, null, { signature: sign(other, c.build(claimed, ts, MINT).message) });
        const out = await run(c.mw, req);
        assert.strictEqual(out.next, false);
        assert.strictEqual(out.status, 401);
      });

      test('refuses an expired signature', async () => {
        const kp = nacl.sign.keyPair();
        const out = await run(c.mw, request(c, kp, Date.now() - validation.SIGNATURE_EXPIRY_MS - 1000));
        assert.strictEqual(out.status, 400);
        assert.strictEqual(out.body.code, 'SIGNATURE_EXPIRED');
      });

      test('refuses a timestamp in the future', async () => {
        const kp = nacl.sign.keyPair();
        const out = await run(c.mw, request(c, kp, Date.now() + 60000));
        assert.strictEqual(out.next, false);
        assert.strictEqual(out.status, 400);
      });

      test('refuses a signature for a different action or token', async () => {
        const kp = nacl.sign.keyPair();
        const ts = Date.now();
        const wallet = bs58.encode(kp.publicKey);
        const wrong = await run(c.mw, request(c, kp, ts, c.wrongAction(wallet, ts)));
        assert.strictEqual(wrong.status, 401);
        if (c.build(wallet, ts, OTHER_MINT).message !== c.build(wallet, ts, MINT).message) {
          const otherMint = await run(c.mw, request(c, kp, ts, c.build(wallet, ts, OTHER_MINT).message));
          assert.strictEqual(otherMint.status, 401);
        }
      });

      test('refuses the S + L variant of a signature already used', async () => {
        for (let attempt = 0; attempt < 20; attempt++) {
          const kp = nacl.sign.keyPair();
          const req = request(c, kp, Date.now());
          const malleated = addLToS(req.body.signature);
          if (!malleated) continue;
          assert.strictEqual((await run(c.mw, { ...req, body: { ...req.body } })).next, true);
          const out = await run(c.mw, { ...req, body: { ...req.body, signature: malleated } });
          assert.strictEqual(out.next, false);
          assert.strictEqual(out.status, 401);
          return;
        }
        assert.fail('no signature with room for S + L in 20 attempts');
      });
    });
  }
});

describe('verifyAdminPassword', () => {
  const crypto = require('crypto');
  const original = process.env.ADMIN_PASSWORD;
  afterEach(() => {
    if (original === undefined) delete process.env.ADMIN_PASSWORD;
    else process.env.ADMIN_PASSWORD = original;
  });
  const hashed = (password, keylen = 64) => {
    const salt = crypto.randomBytes(16);
    return `scrypt:${salt.toString('hex')}:${crypto.scryptSync(password, salt, keylen).toString('hex')}`;
  };

  test('accepts the right password and refuses a wrong one (scrypt)', async () => {
    process.env.ADMIN_PASSWORD = hashed('correct horse');
    assert.strictEqual(await validation.verifyAdminPassword('correct horse'), true);
    assert.strictEqual(await validation.verifyAdminPassword('wrong'), false);
  });

  test('a hash of the wrong length fails the login instead of crashing the process', async () => {
    let uncaught = null;
    const onUncaught = (err) => { uncaught = err; };
    process.on('uncaughtException', onUncaught);
    try {
      for (const value of [hashed('pw', 32), hashed('pw').slice(0, -3), hashed('pw').slice(0, -2) + 'zz']) {
        process.env.ADMIN_PASSWORD = value;
        assert.ok(validation.adminPasswordFormatError(value));
        assert.strictEqual(await validation.verifyAdminPassword('pw'), false);
      }
      await new Promise(r => setImmediate(r));
    } finally {
      process.off('uncaughtException', onUncaught);
    }
    assert.strictEqual(uncaught, null);
  });

  test('adminPasswordFormatError accepts what hash-password.js writes and plaintext', () => {
    assert.strictEqual(validation.adminPasswordFormatError(hashed('pw')), null);
    assert.strictEqual(validation.adminPasswordFormatError('plain-password'), null);
    assert.ok(validation.adminPasswordFormatError('scrypt:abcd'));
  });
});

describe('validateAdminSession', () => {
  const db = require('../services/database');
  const saved = {};
  afterEach(() => Object.assign(db, saved));
  const token = 'a'.repeat(64);
  const withHeaders = (headers, cookies) => ({ cookies, header: (name) => headers[name] });

  test('401 without a token, or with a malformed one', async () => {
    assert.strictEqual((await run(validation.validateAdminSession, withHeaders({}))).status, 401);
    assert.strictEqual((await run(validation.validateAdminSession, withHeaders({ 'X-Admin-Session': 'not-hex' }))).status, 401);
  });

  test('401 for an unknown or expired session; passes a live one from the header or cookie', async () => {
    saved.getAdminSession = db.getAdminSession;
    const live = new Map([[token, { session_token: token }]]);
    db.getAdminSession = async (t) => live.get(t);

    const expired = await run(validation.validateAdminSession, withHeaders({ 'X-Admin-Session': 'b'.repeat(64) }));
    assert.strictEqual(expired.status, 401);

    const viaHeader = await run(validation.validateAdminSession, withHeaders({ 'X-Admin-Session': token }));
    assert.strictEqual(viaHeader.next, true);
    assert.strictEqual(viaHeader.req.adminSession.session_token, token);

    const viaCookie = await run(validation.validateAdminSession, withHeaders({}, { admin_session: token }));
    assert.strictEqual(viaCookie.next, true);
  });
});
