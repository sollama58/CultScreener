/**
 * /api/admin/new-pairs against stubbed services: input validation, status codes, and
 * that the router answers nothing without an admin session when mounted as admin.js
 * mounts it.
 */
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const express = require('express');

delete process.env.REDIS_URL;

function stub(rel, exports) {
  const file = require.resolve(path.join(__dirname, rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
  return exports;
}

const KNOWN = 'Known'.padEnd(44, '1');
const CURATED = 'Curated'.padEnd(44, '1');
const UNKNOWN = 'Unknown'.padEnd(44, '1');
const calls = [];
stub('../services/newPairAdmin', {
  preview: async () => { calls.push(['preview']); return { tokens: [{ mint: KNOWN }], credits: { cap: 10000 } }; },
  setHidden: async (mint, hidden) => { calls.push(['hide', mint, hidden]); return mint !== UNKNOWN; },
  promote: async (mint) => { calls.push(['promote', mint]); return mint === UNKNOWN ? null : { token: { mintAddress: mint }, alreadyCurated: mint === CURATED }; },
  clearPublicCache: async () => { calls.push(['clear']); },
});
stub('../services/newPairSettings', {
  BOUNDS: { shortlistSize: [10, 200] },
  get: async () => ({ shortlistSize: 50, dailyCredits: 10000, maxDailyCredits: 10000 }),
  save: async (input) => {
    calls.push(['save', input]);
    if (input.dailyCredits > 10000) { const e = new Error('dailyCredits cannot be above 10000, the limit set by NEWPAIRS_HELIUS_DAILY_CREDITS'); e.status = 400; throw e; }
    if (input.boom) throw new Error('database down');
    return { shortlistSize: 50, dailyCredits: input.dailyCredits ?? 10000, maxDailyCredits: 10000 };
  },
});
stub('../middleware/rateLimit', { adminWriteLimiter: (req, res, next) => next() });

const router = require('./adminNewPairs');

let server; let base; let signedIn = true;
const call = async (method, url, body) => {
  const res = await fetch(base + url, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json(), cache: res.headers.get('cache-control') };
};

describe('/api/admin/new-pairs', () => {
  before(async () => {
    const app = express();
    app.use(express.json());
    // Stands in for validateAdminSession, which routes/admin.js runs before this router
    app.use('/api/admin', (req, res, next) => (signedIn ? next() : res.status(401).json({ error: 'Admin session required' })));
    app.use('/api/admin/new-pairs', router);
    app.use((err, req, res, _next) => res.status(500).json({ error: 'Internal error' }));
    await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}/api/admin/new-pairs`;
  });
  after(() => new Promise(resolve => server.close(resolve)));
  beforeEach(() => { calls.length = 0; signedIn = true; });

  test('routes/admin.js mounts the router after the session check', () => {
    const src = require('fs').readFileSync(path.join(__dirname, 'admin.js'), 'utf8');
    const session = src.indexOf('router.use(validateAdminSession)');
    const mount = src.indexOf("router.use('/new-pairs'");
    assert.ok(session > 0 && mount > session);
  });

  test('nothing answers without a session', async () => {
    signedIn = false;
    for (const [m, u, b] of [['GET', '/'], ['GET', '/settings'], ['PUT', '/settings', {}], ['PATCH', `/${KNOWN}`, { hidden: true }], ['POST', `/${KNOWN}/promote`]]) {
      assert.strictEqual((await call(m, u, b)).status, 401, `${m} ${u}`);
    }
    assert.deepStrictEqual(calls, []);
  });

  test('GET / returns the preview, never cacheable', async () => {
    const r = await call('GET', '/');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.tokens[0].mint, KNOWN);
    assert.strictEqual(r.cache, 'no-store');
  });

  test('GET /settings is the settings, not a token called "settings"', async () => {
    const r = await call('GET', '/settings');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.settings.maxDailyCredits, 10000);
    assert.deepStrictEqual(r.body.bounds.shortlistSize, [10, 200]);
  });

  test('PUT /settings saves, clears the public cache, and turns a refused value into a 400', async () => {
    const ok = await call('PUT', '/settings', { dailyCredits: 6000 });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.body.settings.dailyCredits, 6000);
    assert.deepStrictEqual(calls, [['save', { dailyCredits: 6000 }], ['clear']]);
    const over = await call('PUT', '/settings', { dailyCredits: 10001 });
    assert.strictEqual(over.status, 400);
    assert.match(over.body.error, /cannot be above 10000/);
    assert.strictEqual((await call('PUT', '/settings', { boom: true })).status, 500, 'a real failure is not reported as bad input');
  });

  test('PATCH /:mint hides and shows, and validates', async () => {
    assert.deepStrictEqual((await call('PATCH', `/${KNOWN}`, { hidden: true })).body, { success: true, hidden: true });
    assert.deepStrictEqual((await call('PATCH', `/${KNOWN}`, { hidden: false })).body, { success: true, hidden: false });
    assert.strictEqual((await call('PATCH', `/${UNKNOWN}`, { hidden: true })).status, 404);
    assert.strictEqual((await call('PATCH', `/${KNOWN}`, { hidden: 'yes' })).status, 400);
    assert.strictEqual((await call('PATCH', `/${KNOWN}`, {})).status, 400);
    assert.strictEqual((await call('PATCH', '/not-a-mint', { hidden: true })).status, 400);
    assert.deepStrictEqual(calls, [['hide', KNOWN, true], ['hide', KNOWN, false], ['hide', UNKNOWN, true]]);
  });

  test('POST /:mint/promote: 201 when added, 200 when already curated, 404 for a mint the finder lacks', async () => {
    assert.strictEqual((await call('POST', `/${KNOWN}/promote`)).status, 201);
    const again = await call('POST', `/${CURATED}/promote`);
    assert.strictEqual(again.status, 200);
    assert.strictEqual(again.body.alreadyCurated, true);
    assert.strictEqual((await call('POST', `/${UNKNOWN}/promote`)).status, 404);
    assert.strictEqual((await call('POST', '/not-a-mint/promote')).status, 400);
  });
});
