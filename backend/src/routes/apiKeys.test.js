/**
 * The key-info lookup reads the signed wallet fields from the request body. Browsers
 * cannot send a body on a GET, so the lookup must also be reachable as POST /api/keys/me.
 */
const { test, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const nacl = require('tweetnacl');
const bs58Module = require('bs58');
const bs58 = bs58Module.default || bs58Module;

const db = require('../services/database');
const validation = require('../middleware/validation');

const origIsReady = db.isReady;
const origGetApiKeyByWallet = db.getApiKeyByWallet;
const origDeleteApiKey = db.deleteApiKey;
const origCreateApiKey = db.createApiKey;
db.isReady = () => true;
const keysByWallet = new Map();
db.getApiKeyByWallet = async (wallet) => keysByWallet.get(wallet) || null;
db.deleteApiKey = async (wallet) => {
  const row = keysByWallet.get(wallet);
  if (!row || row.is_active === false) return null;
  keysByWallet.delete(wallet);
  return row;
};
db.createApiKey = async (wallet, hash, prefix) => {
  if (keysByWallet.has(wallet)) return null;
  const row = { key_prefix: prefix, created_at: new Date().toISOString(), is_active: true };
  keysByWallet.set(wallet, row);
  return row;
};

const router = require('./apiKeys');

const app = express();
app.use(express.json());
app.use('/api/keys', router);
const server = app.listen(0);
const base = () => `http://127.0.0.1:${server.address().port}`;

after(() => {
  db.isReady = origIsReady;
  db.getApiKeyByWallet = origGetApiKeyByWallet;
  db.deleteApiKey = origDeleteApiKey;
  db.createApiKey = origCreateApiKey;
  validation.stopSignatureCleanup();
  server.close();
});

function signedBody(keyPair, action = 'view') {
  const wallet = bs58.encode(keyPair.publicKey);
  const signatureTimestamp = Date.now();
  const message = validation.createApiKeySignatureMessage(wallet, signatureTimestamp, action);
  const signature = Array.from(nacl.sign.detached(new TextEncoder().encode(message), keyPair.secretKey));
  return { wallet, signature, signatureTimestamp };
}

test('POST /api/keys/me returns the key info for a signed wallet', async () => {
  const kp = nacl.sign.keyPair();
  const body = signedBody(kp);
  keysByWallet.set(body.wallet, {
    key_prefix: 'cult_abc', created_at: '2026-01-01T00:00:00.000Z',
    last_used_at: null, request_count: 7, is_active: true
  });

  const res = await fetch(`${base()}/api/keys/me`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.strictEqual(data.found, true);
  assert.strictEqual(data.prefix, 'cult_abc');
  assert.strictEqual(data.request_count, 7);
});

test('POST /api/keys/me without a signature is rejected', async () => {
  const res = await fetch(`${base()}/api/keys/me`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wallet: bs58.encode(nacl.sign.keyPair().publicKey) })
  });
  assert.strictEqual(res.status, 400);
  assert.strictEqual((await res.json()).code, 'SIGNATURE_REQUIRED');
});

function send(method, path, body) {
  return fetch(`${base()}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

test('a signature for one API key action is refused by the others', async () => {
  const kp = nacl.sign.keyPair();
  const wallet = bs58.encode(kp.publicKey);
  keysByWallet.set(wallet, { key_prefix: 'cult_old', created_at: '2026-01-01T00:00:00.000Z', is_active: true });

  // A "register" signature (the wording a phishing page would copy) cannot rotate or revoke.
  for (const [method, path] of [['POST', '/api/keys/rotate'], ['DELETE', '/api/keys/me']]) {
    const res = await send(method, path, signedBody(kp, 'register'));
    assert.strictEqual(res.status, 401, `${method} ${path}`);
    assert.strictEqual((await res.json()).code, 'INVALID_SIGNATURE');
  }
  assert.strictEqual(keysByWallet.get(wallet).key_prefix, 'cult_old');

  const res = await send('POST', '/api/keys/rotate', signedBody(kp, 'rotate'));
  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.ok(data.key);
  assert.notStrictEqual(keysByWallet.get(wallet).key_prefix, 'cult_old');
});

test('POST /me still takes the old page\'s "register" signature, unless the fallback is off', async () => {
  const kp = nacl.sign.keyPair();
  const wallet = bs58.encode(kp.publicKey);
  keysByWallet.set(wallet, { key_prefix: 'cult_view', created_at: '2026-01-01T00:00:00.000Z', is_active: true });
  let res = await send('POST', '/api/keys/me', signedBody(kp, 'register'));
  assert.strictEqual(res.status, 200);
  res = await send('POST', '/api/keys/me', signedBody(kp, 'view'));
  assert.strictEqual(res.status, 200);
  process.env.ACCEPT_LEGACY_SIGNATURE_MESSAGES = 'false';
  try {
    res = await send('POST', '/api/keys/me', signedBody(kp, 'register'));
    assert.strictEqual(res.status, 401);
  } finally {
    delete process.env.ACCEPT_LEGACY_SIGNATURE_MESSAGES;
  }
});

test('an admin-revoked key cannot be rotated or deleted and re-registered by its owner', async () => {
  const kp = nacl.sign.keyPair();
  const wallet = bs58.encode(kp.publicKey);
  const revoked = { key_prefix: 'cult_rev', created_at: '2026-01-01T00:00:00.000Z', is_active: false };
  keysByWallet.set(wallet, revoked);

  let res = await send('POST', '/api/keys/rotate', signedBody(kp, 'rotate'));
  assert.strictEqual(res.status, 403);
  assert.strictEqual((await res.json()).code, 'KEY_REVOKED');

  res = await send('DELETE', '/api/keys/me', signedBody(kp, 'revoke'));
  assert.strictEqual(res.status, 403);
  assert.strictEqual((await res.json()).code, 'KEY_REVOKED');

  res = await send('POST', '/api/keys', signedBody(kp, 'register'));
  assert.strictEqual(res.status, 409);
  assert.strictEqual(keysByWallet.get(wallet), revoked);
});

test('an active key can be deleted by its owner', async () => {
  const kp = nacl.sign.keyPair();
  const wallet = bs58.encode(kp.publicKey);
  keysByWallet.set(wallet, { key_prefix: 'cult_act', created_at: '2026-01-01T00:00:00.000Z', is_active: true });
  const res = await send('DELETE', '/api/keys/me', signedBody(kp, 'revoke'));
  assert.strictEqual(res.status, 200);
  assert.strictEqual(keysByWallet.has(wallet), false);
});
