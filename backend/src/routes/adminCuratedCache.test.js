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
let alreadyCurated = false;

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
      scanKeys: async () => [],
      deleteMany: async (ks) => ks.length,
      set: async () => {},
    },
  });
  stub('../services/database', {
    removeCuratedToken: async () => ({ mint_address: MINT }),
  });
  stub('../services/curatedTokens', {
    addCuratedTokenFully: async (mint) => ({ token: { mintAddress: mint }, alreadyCurated }),
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

  test('adding a mint already on the list says so and leaves the cache alone', async () => {
    calls.length = 0;
    alreadyCurated = true;
    try {
      const { status, body } = await call('post', '/curated', { body: { mintAddress: MINT } });
      assert.strictEqual(status, 200);
      assert.strictEqual(body.alreadyExists, true);
      assert.deepStrictEqual(calls, []);
    } finally {
      alreadyCurated = false;
    }
  });

  test('removing a token clears the cached leaderboard and featured King', async () => {
    calls.length = 0;
    const { status } = await call('delete', '/curated/:mint', { params: { mint: MINT } });
    assert.strictEqual(status, 200);
    assert.ok(calls.some(([op, p]) => op === 'clearPattern' && p === 'leaderboard:conviction:*'), JSON.stringify(calls));
    assert.ok(calls.some(([op, k]) => op === 'delete' && k === 'king-of-pill:featured'), JSON.stringify(calls));
  });
});
