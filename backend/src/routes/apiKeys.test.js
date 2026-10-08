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
db.isReady = () => true;
const keysByWallet = new Map();
db.getApiKeyByWallet = async (wallet) => keysByWallet.get(wallet) || null;

const router = require('./apiKeys');

const app = express();
app.use(express.json());
app.use('/api/keys', router);
const server = app.listen(0);
const base = () => `http://127.0.0.1:${server.address().port}`;

after(() => {
  db.isReady = origIsReady;
  db.getApiKeyByWallet = origGetApiKeyByWallet;
  validation.stopSignatureCleanup();
  server.close();
});

function signedBody(keyPair) {
  const wallet = bs58.encode(keyPair.publicKey);
  const signatureTimestamp = Date.now();
  const message = validation.createApiKeySignatureMessage(wallet, signatureTimestamp);
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
