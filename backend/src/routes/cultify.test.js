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
const stranger = nacl.sign.keyPair();

function signB64(keyPair, message) {
  return Buffer.from(nacl.sign.detached(new TextEncoder().encode(message), keyPair.secretKey)).toString('base64');
}
function claimFor(mint, keyPair = burner, sig = BURN_SIG) {
  return signB64(keyPair, cultifyRoutes._createCultifyBurnClaimMessage(sig, mint, BURNER));
}
function hbClaimFor(mint, keyPair = burner, sig = BURN_SIG) {
  return signB64(keyPair, cultifyRoutes._createHBBurnClaimMessage(sig, mint, BURNER));
}

describe('POST /verify-burn duplicate signature', () => {
  beforeEach(() => {
    useFakeBurnTable();
    solanaService.getTransaction = async () => fakeBurnTx(BURNER, 10_000);
  });

  test('a racing claim of the same burn for another mint is refused', async () => {
    burns.set(BURN_SIG, { wallet_address: BURNER, token_mint: MINT, utility_type: 'cultify' });
    const r = await post('/verify-burn', { signature: BURN_SIG, mint: OTHER_MINT, wallet: BURNER, claimSignature: claimFor(OTHER_MINT) });
    assert.strictEqual(r.status, 409);
    assert.ok(!r.body.accessToken);
    assert.ok(![...store.values()].some(v => v && v.mint === OTHER_MINT), 'no access token stored for the other mint');
  });

  test('a racing claim of the same burn for the other utility is refused', async () => {
    burns.set(BURN_SIG, { wallet_address: BURNER, token_mint: MINT, utility_type: 'cultify' });
    const r = await post('/holder-behavior/verify-burn', { signature: BURN_SIG, mint: MINT, wallet: BURNER, claimSignature: hbClaimFor(MINT) });
    assert.strictEqual(r.status, 409);
    assert.ok(!r.body.accessToken);
  });

  test('a retry of the recorded claim still gets a token', async () => {
    burns.set(BURN_SIG, { wallet_address: BURNER, token_mint: MINT, utility_type: 'holder_behavior' });
    const r = await post('/holder-behavior/verify-burn', { signature: BURN_SIG, mint: MINT, wallet: BURNER, claimSignature: hbClaimFor(MINT) });
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.accessToken);
    assert.strictEqual(store.get(`hb:access:${r.body.accessToken}`).mint, MINT);
  });
});

describe('POST /verify-burn requires the burner to sign the claim', () => {
  beforeEach(() => {
    useFakeBurnTable();
    db.hasCultifyAccess = async (wallet, mint) =>
      [...burns.values()].some(b => b.wallet_address === wallet && b.token_mint === mint && b.utility_type === 'cultify');
    solanaService.getTransaction = async () => fakeBurnTx(BURNER, 5_000);
  });

  test('an unsigned claim (someone who saw the burn on-chain) is refused and records nothing', async () => {
    const r = await post('/verify-burn', { signature: BURN_SIG, mint: OTHER_MINT, wallet: BURNER });
    assert.strictEqual(r.status, 401);
    assert.strictEqual(burns.size, 0);
  });

  test('a claim signed by another wallet is refused', async () => {
    const r = await post('/verify-burn', { signature: BURN_SIG, mint: MINT, wallet: BURNER, claimSignature: claimFor(MINT, stranger) });
    assert.strictEqual(r.status, 401);
    assert.strictEqual(burns.size, 0);
  });

  test("the burner's claim for one token cannot be replayed for another", async () => {
    const r = await post('/verify-burn', { signature: BURN_SIG, mint: OTHER_MINT, wallet: BURNER, claimSignature: claimFor(MINT) });
    assert.strictEqual(r.status, 401);
  });

  test('a signed claim records the burn and returns a token', async () => {
    const r = await post('/verify-burn', { signature: BURN_SIG, mint: MINT, wallet: BURNER, claimSignature: claimFor(MINT) });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(burns.get(BURN_SIG), { wallet_address: BURNER, token_mint: MINT, utility_type: 'cultify' });
    assert.strictEqual(store.get(`cultify:access:${r.body.accessToken}`).mint, MINT);
  });

  test("the burner's retry after a lost response gets a token instead of 409", async () => {
    burns.set(BURN_SIG, { wallet_address: BURNER, token_mint: MINT, utility_type: 'cultify' });
    db.isCultifySignatureUsed = async (sig) => burns.has(sig);
    const r = await post('/verify-burn', { signature: BURN_SIG, mint: MINT, wallet: BURNER, claimSignature: claimFor(MINT) });
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.accessToken);
  });

  test('a retry outside the access window is not renewed', async () => {
    burns.set(BURN_SIG, { wallet_address: BURNER, token_mint: MINT, utility_type: 'cultify' });
    db.isCultifySignatureUsed = async (sig) => burns.has(sig);
    db.hasCultifyAccess = async () => false;
    const r = await post('/verify-burn', { signature: BURN_SIG, mint: MINT, wallet: BURNER, claimSignature: claimFor(MINT) });
    assert.strictEqual(r.status, 409);
  });
});

describe('GET /check-access/:mint with ?wallet=', () => {
  beforeEach(() => {
    db.hasCultifyAccess = async (wallet, mint) => wallet === BURNER && mint === MINT;
  });

  function accessProof(keyPair = burner, ts = Date.now()) {
    return `&sig=${encodeURIComponent(signB64(keyPair, cultifyRoutes._createCultifyAccessMessage(MINT, BURNER, ts)))}&sigTs=${ts}`;
  }

  test("naming a burner's wallet is not enough for a token", async () => {
    const r = await get(`/check-access/${MINT}?wallet=${BURNER}`);
    assert.deepStrictEqual(r.body, { access: false, reason: 'signature_required' });
  });

  test("the burner's signature gets a token, once", async () => {
    const proof = accessProof();
    const r = await get(`/check-access/${MINT}?wallet=${BURNER}${proof}`);
    assert.strictEqual(r.body.access, true);
    assert.strictEqual(store.get(`cultify:access:${r.body.accessToken}`).mint, MINT);

    const replay = await get(`/check-access/${MINT}?wallet=${BURNER}${proof}`);
    assert.deepStrictEqual(replay.body, { access: false, reason: 'signature_invalid', detail: 'replayed' });
  });

  test("a refused signature says why, instead of asking for one again", async () => {
    const other = await get(`/check-access/${MINT}?wallet=${BURNER}${accessProof(stranger)}`);
    assert.deepStrictEqual(other.body, { access: false, reason: 'signature_invalid', detail: 'bad_signature' });
    const stale = await get(`/check-access/${MINT}?wallet=${BURNER}${accessProof(burner, Date.now() - 10 * 60 * 1000)}`);
    assert.deepStrictEqual(stale.body, { access: false, reason: 'signature_invalid', detail: 'expired' });
    const ahead = await get(`/check-access/${MINT}?wallet=${BURNER}${accessProof(burner, Date.now() + 5 * 60 * 1000)}`);
    assert.deepStrictEqual(ahead.body, { access: false, reason: 'signature_invalid', detail: 'future' });
    const garbled = await get(`/check-access/${MINT}?wallet=${BURNER}&sig=nope&sigTs=${Date.now()}`);
    assert.deepStrictEqual(garbled.body, { access: false, reason: 'signature_invalid', detail: 'bad_signature' });
    assert.ok(![...store.keys()].some(k => k.startsWith('cultify:access:')), 'no token stored');
  });

  test('a signature from a slow wallet prompt (3 minutes) or a clock 30s ahead still counts', async () => {
    const slow = await get(`/check-access/${MINT}?wallet=${BURNER}${accessProof(burner, Date.now() - 3 * 60 * 1000)}`);
    assert.strictEqual(slow.body.access, true);
    const ahead = await get(`/check-access/${MINT}?wallet=${BURNER}${accessProof(burner, Date.now() + 30 * 1000)}`);
    assert.strictEqual(ahead.body.access, true);
  });

  test('a wallet with no burn on record is told to burn', async () => {
    const r = await get(`/check-access/${MINT}?wallet=${bs58.encode(stranger.publicKey)}`);
    assert.deepStrictEqual(r.body, { access: false, reason: 'none' });
  });
});

// ── Holder Behavior: the same wallet proofs ─────────────────────────────

describe('POST /holder-behavior/verify-burn requires the burner to sign the claim', () => {
  beforeEach(() => {
    useFakeBurnTable();
    db.hasHBAccess = async (wallet, mint) =>
      [...burns.values()].some(b => b.wallet_address === wallet && b.token_mint === mint && b.utility_type === 'holder_behavior');
    solanaService.getTransaction = async () => fakeBurnTx(BURNER, 10_000);
  });

  test('an unsigned claim (someone who saw the burn on-chain) is refused and records nothing', async () => {
    const r = await post('/holder-behavior/verify-burn', { signature: BURN_SIG, mint: OTHER_MINT, wallet: BURNER });
    assert.strictEqual(r.status, 401);
    assert.strictEqual(burns.size, 0);
  });

  test('a claim signed by another wallet is refused', async () => {
    const r = await post('/holder-behavior/verify-burn', { signature: BURN_SIG, mint: MINT, wallet: BURNER, claimSignature: hbClaimFor(MINT, stranger) });
    assert.strictEqual(r.status, 401);
    assert.strictEqual(burns.size, 0);
  });

  test("the burner's claim for one token cannot be replayed for another", async () => {
    const r = await post('/holder-behavior/verify-burn', { signature: BURN_SIG, mint: OTHER_MINT, wallet: BURNER, claimSignature: hbClaimFor(MINT) });
    assert.strictEqual(r.status, 401);
  });

  test('a Cultify claim does not count for Holder Behavior', async () => {
    const r = await post('/holder-behavior/verify-burn', { signature: BURN_SIG, mint: MINT, wallet: BURNER, claimSignature: claimFor(MINT) });
    assert.strictEqual(r.status, 401);
    assert.strictEqual(burns.size, 0);
  });

  test('a signed claim records the burn and returns a token', async () => {
    const r = await post('/holder-behavior/verify-burn', { signature: BURN_SIG, mint: MINT, wallet: BURNER, claimSignature: hbClaimFor(MINT) });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(burns.get(BURN_SIG), { wallet_address: BURNER, token_mint: MINT, utility_type: 'holder_behavior' });
    assert.strictEqual(store.get(`hb:access:${r.body.accessToken}`).mint, MINT);
  });

  test("the burner's retry after a lost response gets a token instead of 409", async () => {
    burns.set(BURN_SIG, { wallet_address: BURNER, token_mint: MINT, utility_type: 'holder_behavior' });
    db.isCultifySignatureUsed = async (sig) => burns.has(sig);
    const r = await post('/holder-behavior/verify-burn', { signature: BURN_SIG, mint: MINT, wallet: BURNER, claimSignature: hbClaimFor(MINT) });
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.accessToken);
  });

  test('a retry outside the access window is not renewed', async () => {
    burns.set(BURN_SIG, { wallet_address: BURNER, token_mint: MINT, utility_type: 'holder_behavior' });
    db.isCultifySignatureUsed = async (sig) => burns.has(sig);
    db.hasHBAccess = async () => false;
    const r = await post('/holder-behavior/verify-burn', { signature: BURN_SIG, mint: MINT, wallet: BURNER, claimSignature: hbClaimFor(MINT) });
    assert.strictEqual(r.status, 409);
  });
});

function hbAccessProof(keyPair = burner, ts = Date.now(), wallet = BURNER) {
  return `&sig=${encodeURIComponent(signB64(keyPair, cultifyRoutes._createHBAccessMessage(MINT, wallet, ts)))}&sigTs=${ts}`;
}

describe('GET /holder-behavior/check-access/:mint with ?wallet=', () => {
  let whitelisted;
  beforeEach(() => {
    whitelisted = false;
    db.isWalletWhitelisted = async (wallet) => whitelisted && wallet === BURNER;
    db.hasHBAccess = async (wallet, mint) => wallet === BURNER && mint === MINT;
  });

  test("naming a burner's wallet is not enough for a token", async () => {
    const r = await get(`/holder-behavior/check-access/${MINT}?wallet=${BURNER}`);
    assert.deepStrictEqual(r.body, { access: false, reason: 'signature_required' });
    assert.ok(![...store.keys()].some(k => k.startsWith('hb:access:')), 'no token stored');
  });

  test("naming a whitelisted wallet is not enough for a token", async () => {
    whitelisted = true;
    db.hasHBAccess = async () => false;
    const r = await get(`/holder-behavior/check-access/${MINT}?wallet=${BURNER}`);
    assert.deepStrictEqual(r.body, { access: false, reason: 'signature_required' });
  });

  test("the whitelisted wallet's signature gets a token", async () => {
    whitelisted = true;
    const r = await get(`/holder-behavior/check-access/${MINT}?wallet=${BURNER}${hbAccessProof()}`);
    assert.strictEqual(r.body.access, true);
    assert.strictEqual(r.body.reason, 'whitelisted');
    assert.strictEqual(store.get(`hb:access:${r.body.accessToken}`).mint, MINT);
  });

  test("the burner's signature gets a token, once", async () => {
    const proof = hbAccessProof();
    const r = await get(`/holder-behavior/check-access/${MINT}?wallet=${BURNER}${proof}`);
    assert.strictEqual(r.body.access, true);
    assert.strictEqual(r.body.reason, 'burned');
    assert.strictEqual(store.get(`hb:access:${r.body.accessToken}`).mint, MINT);

    const replay = await get(`/holder-behavior/check-access/${MINT}?wallet=${BURNER}${proof}`);
    assert.deepStrictEqual(replay.body, { access: false, reason: 'signature_invalid', detail: 'replayed' });
  });

  test("someone else's signature, a stale one or a Cultify one is refused, saying why", async () => {
    const other = await get(`/holder-behavior/check-access/${MINT}?wallet=${BURNER}${hbAccessProof(stranger)}`);
    assert.deepStrictEqual(other.body, { access: false, reason: 'signature_invalid', detail: 'bad_signature' });
    const stale = await get(`/holder-behavior/check-access/${MINT}?wallet=${BURNER}${hbAccessProof(burner, Date.now() - 10 * 60 * 1000)}`);
    assert.deepStrictEqual(stale.body, { access: false, reason: 'signature_invalid', detail: 'expired' });
    const ts = Date.now();
    const cultifySig = signB64(burner, cultifyRoutes._createCultifyAccessMessage(MINT, BURNER, ts));
    const cross = await get(`/holder-behavior/check-access/${MINT}?wallet=${BURNER}&sig=${encodeURIComponent(cultifySig)}&sigTs=${ts}`);
    assert.deepStrictEqual(cross.body, { access: false, reason: 'signature_invalid', detail: 'bad_signature' });
  });

  test("a whitelisted wallet's refused signature is reported, not sent to the burn gate", async () => {
    whitelisted = true;
    db.hasHBAccess = async () => false;
    const ahead = await get(`/holder-behavior/check-access/${MINT}?wallet=${BURNER}${hbAccessProof(burner, Date.now() + 2 * 60 * 1000)}`);
    assert.deepStrictEqual(ahead.body, { access: false, reason: 'signature_invalid', detail: 'future' });
    const slow = await get(`/holder-behavior/check-access/${MINT}?wallet=${BURNER}${hbAccessProof(burner, Date.now() - 4 * 60 * 1000)}`);
    assert.strictEqual(slow.body.access, true);
  });

  test('a valid access token still works without a signature', async () => {
    store.set('hb:access:hbtok', { wallet: BURNER, mint: MINT, expiresAt: Date.now() + 60000 });
    const r = await get(`/holder-behavior/check-access/${MINT}?token=hbtok&wallet=${BURNER}`);
    assert.deepStrictEqual(r.body, { access: true, reason: 'burned' });
  });

  test('a wallet with no burn on record is told to burn', async () => {
    const r = await get(`/holder-behavior/check-access/${MINT}?wallet=${bs58.encode(stranger.publicKey)}`);
    assert.deepStrictEqual(r.body, { access: false, reason: 'none' });
  });
});

describe('GET /holder-behavior/analyze/:mint for a whitelisted wallet', () => {
  let added;
  beforeEach(() => {
    added = [];
    db.isWalletWhitelisted = async (wallet) => wallet === BURNER;
    jobQueue.addAnalyticsJob = async (name, data, opts) => { added.push(opts); return { id: opts.jobId }; };
  });

  test('naming a whitelisted wallet does not start an analysis', async () => {
    const r = await get(`/holder-behavior/analyze/${MINT}?wallet=${BURNER}`);
    assert.strictEqual(r.status, 403);
    assert.strictEqual(added.length, 0);
  });

  test('a refused signature is reported as invalid, not as missing', async () => {
    const r = await get(`/holder-behavior/analyze/${MINT}?wallet=${BURNER}${hbAccessProof(stranger)}`);
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.body.code, 'SIGNATURE_INVALID');
    assert.strictEqual(r.body.detail, 'bad_signature');
    assert.strictEqual(added.length, 0);
  });

  test("the whitelisted wallet's signature does", async () => {
    const r = await get(`/holder-behavior/analyze/${MINT}?wallet=${BURNER}${hbAccessProof()}`);
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body, { status: 'computing' });
    assert.strictEqual(added.length, 1);
  });

  test('an access token for another mint does not count', async () => {
    store.set('hb:access:other', { wallet: BURNER, mint: OTHER_MINT, expiresAt: Date.now() + 60000 });
    const r = await get(`/holder-behavior/analyze/${MINT}?token=other`);
    assert.strictEqual(r.status, 403);
    assert.strictEqual(added.length, 0);
  });
});

describe('GET /analyze/:mint DAS fallback decimals', () => {
  let added;
  let dasDecimals;
  beforeEach(() => {
    added = [];
    dasDecimals = [];
    db.isTokenAllowed = async () => true;
    solanaService.getTokenLargestAccounts = async () => null; // RPC down
    solanaService.getTokenSupply = async () => { throw new Error('rpc down'); };
    solanaService.getTokenMetadata = async () => null;
    solanaService.getTokenLargestAccountsDAS = async (mint, decimals) => {
      dasDecimals.push(decimals);
      return [{ address: 'acct1', wallet: 'owner1', uiAmount: 1234 / 10 ** decimals }];
    };
    jobQueue.addAnalyticsJob = async (name, data) => { added.push({ name, data }); return { id: 'j' }; };
  });

  test('unknown decimals: answers rpc_unavailable without caching or queueing raw units', async () => {
    const r = await get(`/analyze/${MINT}`);
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body, { holders: [], totalSupply: null, metrics: null, supply: null, error: 'rpc_unavailable' });
    assert.deepStrictEqual(dasDecimals, [], 'DAS not scaled with a guess');
    assert.strictEqual(store.has(`holder-analytics:${MINT}`), false);
    assert.strictEqual(store.has(`holder-classify-pending:${MINT}`), false);
    assert.strictEqual(added.length, 0);
  });

  test('decimals from Helius metadata scale the DAS amounts and reach the worker job', async () => {
    solanaService.getTokenMetadata = async () => ({ decimals: 6 });
    const r = await get(`/analyze/${MINT}`);
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(dasDecimals, [6]);
    assert.strictEqual(r.body.holders[0].balance, 1234 / 1e6);
    const job = added.find(j => j.name === 'compute-holder-analytics');
    assert.ok(job, 'enrichment job queued');
    assert.strictEqual(job.data.supplyDecimals, 6);
    assert.strictEqual(job.data.usedDAS, true);
  });
});

describe('getActiveHBAccess (My Utilities)', () => {
  const WALLET = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';

  test('rebuilds from the DB when the Redis wallet index is gone, and repopulates it', async () => {
    const expiresAt = Date.now() + 3600000;
    db.getHBAccessByWallet = async (w) => (w === WALLET ? [{ mint: MINT, expiresAt }, { mint: 'Old', expiresAt: Date.now() - 1 }] : []);
    const active = await cultifyRoutes.getActiveHBAccess(WALLET);
    assert.deepStrictEqual(active, [{ mint: MINT, expiresAt }]);
    assert.deepStrictEqual(store.get(`hb:wallet-idx:${WALLET}`), [{ mint: MINT, expiresAt }]);
  });

  test('uses the Redis index when it has live entries', async () => {
    const expiresAt = Date.now() + 3600000;
    store.set(`hb:wallet-idx:${WALLET}`, [{ mint: MINT, expiresAt }]);
    db.getHBAccessByWallet = async () => { throw new Error('should not be called'); };
    assert.deepStrictEqual(await cultifyRoutes.getActiveHBAccess(WALLET), [{ mint: MINT, expiresAt }]);
  });
});
