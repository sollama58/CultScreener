/**
 * Adding or removing a curated token from the admin panel must drop the cached conviction
 * leaderboard (the home table), whose keys do not contain the mint.
 *
 * The route handlers are called directly with the database, cache and add flow stubbed.
 */
const { test, describe, before } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const MINT = 'So11111111111111111111111111111111111111112';
const calls = [];
let scanKeys = [];
let releaseBackfill = null;

const stub = (rel, exports) => {
  const file = require.resolve(path.join(__dirname, rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
};

let router;

before(() => {
  stub('../services/cache', {
    // Modules loaded through admin.js read TTL presets at load time
    TTL: new Proxy({}, { get: () => 60000 }),
    keys: new Proxy({}, { get: () => (...a) => a.join(':') }),
    cache: {
      clearPattern: async (p) => { calls.push(['clearPattern', p]); },
      delete: async (k) => { calls.push(['delete', k]); },
      get: async () => null,
      scanKeys: async () => scanKeys,
      deleteMany: async (ks) => { calls.push(['deleteMany', ks]); return ks.length; },
      set: async () => {},
    },
  });
  stub('../services/database', {
    removeCuratedToken: async () => ({ mint_address: MINT }),
    setEmergingCult: async () => ({ mint_address: MINT }),
    setTechCoin: async () => ({ mint_address: MINT }),
    // Holds the backfill loop open until the test releases it
    getCuratedTokens: () => new Promise(r => { releaseBackfill = () => r([]); }),
  });
  stub('../services/curatedTokens', {
    addCuratedTokenFully: async (mint) => ({ token: { mintAddress: mint } }),
    invalidateCuratedList: async () => {},
  });
  router = require('./admin');
});

// The route's own handler: the last layer of its stack, after the rate limiter
function handler(method, routePath) {
  const layer = router.stack.find(l => l.route && l.route.path === routePath && l.route.methods[method]);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

async function call(method, routePath, req) {
  let status = 200;
  return new Promise((resolve, reject) => {
    const res = {
      status(code) { status = code; return this; },
      json(body) { resolve({ status, body }); return this; },
      set() { return this; },
    };
    // asyncHandler passes errors to next() and does not return its promise
    handler(method, routePath)({ params: {}, body: {}, headers: {}, ...req }, res, reject);
  });
}

describe('admin curated tokens and the leaderboard cache', () => {
  test('adding a token clears the cached leaderboard', async () => {
    calls.length = 0;
    const { status } = await call('post', '/curated', { body: { mintAddress: MINT } });
    assert.strictEqual(status, 201);
    assert.ok(calls.some(([op, p]) => op === 'clearPattern' && p === 'leaderboard:conviction:*'), JSON.stringify(calls));
  });

  test('removing a token clears the cached leaderboard and featured King', async () => {
    calls.length = 0;
    const { status } = await call('delete', '/curated/:mint', { params: { mint: MINT } });
    assert.strictEqual(status, 200);
    assert.ok(calls.some(([op, p]) => op === 'clearPattern' && p === 'leaderboard:conviction:*'), JSON.stringify(calls));
    assert.ok(calls.some(([op, k]) => op === 'delete' && k === 'king-of-pill:featured'), JSON.stringify(calls));
  });
});

describe('admin label toggles', () => {
  for (const [routePath, body] of [['/curated/:mint/emerging-cult', { emergingCult: true }], ['/curated/:mint/tech-coin', { techCoin: true }]]) {
    test(`${routePath} clears the cached leaderboard the Tech and Emerging tabs read`, async () => {
      calls.length = 0;
      const { status } = await call('patch', routePath, { params: { mint: MINT }, body });
      assert.strictEqual(status, 200);
      assert.ok(calls.some(([op, p]) => op === 'clearPattern' && p === 'leaderboard:conviction:*'), JSON.stringify(calls));
    });
  }
});

describe('admin wipe-token-cache', () => {
  test('deletes the upstream caches the rebuild reads and the suffixed submissions keys', async () => {
    calls.length = 0;
    scanKeys = [`submissions:${MINT}:all:approved`, `streamflow-locked:${MINT}:6`, 'submissions:OtherMint:all:approved', 'leaderboard:conviction:100:0:'];
    const { status } = await call('post', '/wipe-token-cache', { body: { mint: MINT } });
    scanKeys = [];
    assert.strictEqual(status, 200);
    const deletedKeys = calls.filter(([op]) => op === 'deleteMany').flatMap(([, ks]) => ks);
    for (const k of [`token:${MINT}`, `helius-meta:${MINT}`, `gecko-overview:${MINT}`, `holder-total-none:${MINT}`,
      `hb-analysis:${MINT}`, `api:token:${MINT}`, `submissions:${MINT}:all:approved`, `streamflow-locked:${MINT}:6`,
      'leaderboard:conviction:100:0:']) {
      assert.ok(deletedKeys.includes(k), k);
    }
    assert.ok(!deletedKeys.includes('submissions:OtherMint:all:approved'));
  });
});

describe('admin backfill-holder-history', () => {
  test('refuses a second run while one is in progress', async () => {
    const first = call('post', '/backfill-holder-history', {});
    await new Promise(r => setImmediate(r));
    const second = await call('post', '/backfill-holder-history', {});
    assert.strictEqual(second.status, 409);
    releaseBackfill();
    assert.strictEqual((await first).status, 400); // no curated tokens in the stub
    // Finished: the next run is allowed again
    const third = call('post', '/backfill-holder-history', {});
    await new Promise(r => setImmediate(r));
    releaseBackfill();
    assert.strictEqual((await third).status, 400);
  });
});
