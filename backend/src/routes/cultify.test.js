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
