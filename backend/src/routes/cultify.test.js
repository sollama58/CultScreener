const { test, describe, beforeEach, before, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');

const db = require('../services/database');
const { cache } = require('../services/cache');
const solanaService = require('../services/solana');
const holderPipeline = require('../services/holderPipeline');
const jobQueue = require('../services/jobQueue');
const cultifyRoutes = require('./cultify');

// The router runs against stubs: an in-memory cache and fake db / RPC / pipeline calls, so these
// tests exercise the route logic without Postgres, Redis or Helius.
const store = new Map();
cache.get = async (k) => (store.has(k) ? store.get(k) : null);
cache.set = async (k, v) => { store.set(k, v); return true; };
cache.delete = async (k) => { store.delete(k); return true; };
cache.setNX = async (k, v) => { if (store.has(k)) return false; store.set(k, v); return true; };
cache.getBackendType = () => 'memory';

const MINT = 'So11111111111111111111111111111111111111112';

let server;
let baseUrl;
let ipCounter = 0;

before(async () => {
  const app = express();
  app.use(express.json());
  // A fresh client IP per request keeps the per-IP rate limiters out of the way
  app.use((req, _res, next) => {
    Object.defineProperty(req, 'ip', { value: `10.0.${(ipCounter >> 8) & 255}.${ipCounter++ & 255}` });
    next();
  });
  app.use('/api/cultify', cultifyRoutes);
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}/api/cultify`;
});

after(() => new Promise((resolve) => server.close(resolve)));

beforeEach(() => {
  store.clear();
  db.isTokenAllowed = async () => false;
  solanaService.isHeliusConfigured = () => true;
});

async function get(path) {
  const resp = await fetch(baseUrl + path);
  return { status: resp.status, body: await resp.json() };
}

describe('GET /diamond-hands/:mint', () => {
  test('returns the pipeline result instead of failing on every request', async () => {
    db.isTokenAllowed = async () => true;
    const result = { distribution: { '6h': 80 }, sampleSize: 50, analyzed: 50, computed: true };
    let calls = 0;
    holderPipeline.getDiamondHands = async (mint) => { calls++; assert.strictEqual(mint, MINT); return result; };

    const r = await get(`/diamond-hands/${MINT}`);
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body, result);
    assert.strictEqual(calls, 1);
  });

  test('serves a cached final result', async () => {
    db.isTokenAllowed = async () => true;
    const cached = { distribution: { '6h': 10 }, sampleSize: 5, analyzed: 5, computed: true };
    store.set(`diamond-hands:${MINT}`, cached);
    holderPipeline.getDiamondHands = async () => { throw new Error('should not be called'); };

    const r = await get(`/diamond-hands/${MINT}`);
    assert.deepStrictEqual(r.body, cached);
  });

  test('still in progress: passes computed:false through for a burn-token holder', async () => {
    store.set('cultify:access:tok1', { wallet: 'w', mint: MINT });
    holderPipeline.getDiamondHands = async () => ({ distribution: null, sampleSize: 0, analyzed: 0, computed: false });

    const r = await get(`/diamond-hands/${MINT}?token=tok1`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.computed, false);
  });
});

describe('GET /holder-behavior/analyze/:mint', () => {
  const HB_TOKEN = 'hbtok';
  let added;

  beforeEach(() => {
    added = [];
    db.isWalletWhitelisted = async () => false;
    store.set(`hb:access:${HB_TOKEN}`, { wallet: 'w', mint: MINT, expiresAt: Date.now() + 60000 });
    jobQueue.addAnalyticsJob = async (name, data, opts) => { added.push({ name, data, opts }); return { id: opts.jobId }; };
  });

  test('a retry after a finished (failed) run enqueues a new job with a valid, fresh id', async () => {
    const first = await get(`/holder-behavior/analyze/${MINT}?token=${HB_TOKEN}`);
    assert.deepStrictEqual(first.body, { status: 'computing' });
    assert.strictEqual(added.length, 1);

    // The worker finishes: failed result cached, then expired; pending flag cleared
    store.delete(`hb-pending:${MINT}`);
    await new Promise(r => setTimeout(r, 2));

    const retry = await get(`/holder-behavior/analyze/${MINT}?token=${HB_TOKEN}`);
    assert.deepStrictEqual(retry.body, { status: 'computing' });
    assert.strictEqual(added.length, 2);
    for (const { name, data, opts } of added) {
      assert.strictEqual(name, 'compute-holder-behavior');
      assert.deepStrictEqual(data, { mint: MINT });
      // BullMQ rejects custom ids containing ':' (unless in its 3-part legacy form)
      assert.ok(!opts.jobId.includes(':'), `invalid BullMQ jobId ${opts.jobId}`);
    }
    assert.notStrictEqual(added[0].opts.jobId, added[1].opts.jobId);
  });

  test('a run already pending is not enqueued again', async () => {
    store.set(`hb-pending:${MINT}`, Date.now());
    const r = await get(`/holder-behavior/analyze/${MINT}?token=${HB_TOKEN}`);
    assert.deepStrictEqual(r.body, { status: 'computing' });
    assert.strictEqual(added.length, 0);
  });

  test('concurrent first requests enqueue one job', async () => {
    await Promise.all([1, 2, 3].map(() => get(`/holder-behavior/analyze/${MINT}?token=${HB_TOKEN}`)));
    assert.strictEqual(added.length, 1);
  });
});

// ── Burn claims ──────────────────────────────────────────────────────────

const BURN_MINT = '9zB5wRarXMj86MymwLumSKA1Dx35zPqqKfcZtK1Spump';
const OTHER_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const BURN_SIG = '5'.repeat(88);

// cultify_burns stand-in, shared by the db stubs and the pool the route queries
const burns = new Map();
function fakeBurnTx(wallet, uiAmount) {
  return {
    meta: { err: null },
    transaction: { message: { instructions: [{
      parsed: { type: 'burn', info: { mint: BURN_MINT, authority: wallet, amount: String(BigInt(uiAmount) * 1_000_000n) } }
    }] } }
  };
}

async function post(path, body) {
  const resp = await fetch(baseUrl + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  return { status: resp.status, body: await resp.json() };
}

function useFakeBurnTable() {
  burns.clear();
  // Both racing requests got past the pre-check; the insert is what decides
  db.isCultifySignatureUsed = async () => false;
  db.recordCultifyBurn = async (wallet, mint, sig, amount, utility = 'cultify') => {
    if (burns.has(sig)) { const e = new Error('duplicate key'); e.code = '23505'; throw e; }
    burns.set(sig, { wallet_address: wallet, token_mint: mint, utility_type: utility });
  };
  Object.defineProperty(db, 'pool', {
    configurable: true,
    get: () => ({
      query: async (sql, [sig]) => ({ rows: burns.has(sig) ? [burns.get(sig)] : [] })
    })
  });
}

const nacl = require('tweetnacl');
const bs58 = require('bs58');
const burner = nacl.sign.keyPair();
const BURNER = bs58.encode(burner.publicKey);

describe('POST /verify-burn duplicate signature', () => {
  beforeEach(() => {
    useFakeBurnTable();
    solanaService.getTransaction = async () => fakeBurnTx(BURNER, 10_000);
  });

  test('a racing claim of the same burn for another mint is refused', async () => {
    burns.set(BURN_SIG, { wallet_address: BURNER, token_mint: MINT, utility_type: 'cultify' });
    const r = await post('/verify-burn', { signature: BURN_SIG, mint: OTHER_MINT, wallet: BURNER });
    assert.strictEqual(r.status, 409);
    assert.ok(!r.body.accessToken);
    assert.ok(![...store.values()].some(v => v && v.mint === OTHER_MINT), 'no access token stored for the other mint');
  });

  test('a racing claim of the same burn for the other utility is refused', async () => {
    burns.set(BURN_SIG, { wallet_address: BURNER, token_mint: MINT, utility_type: 'cultify' });
    const r = await post('/holder-behavior/verify-burn', { signature: BURN_SIG, mint: MINT, wallet: BURNER });
    assert.strictEqual(r.status, 409);
    assert.ok(!r.body.accessToken);
  });

  test('a retry of the recorded claim still gets a token', async () => {
    burns.set(BURN_SIG, { wallet_address: BURNER, token_mint: MINT, utility_type: 'holder_behavior' });
    const r = await post('/holder-behavior/verify-burn', { signature: BURN_SIG, mint: MINT, wallet: BURNER });
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.accessToken);
    assert.strictEqual(store.get(`hb:access:${r.body.accessToken}`).mint, MINT);
  });
});
