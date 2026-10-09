/**
 * Service worker cache trimming (run with: node --test frontend/service-worker.test.js).
 * Every HTML page view used to trim STATIC_CACHE to 50 entries, evicting the precached
 * app shell, so offline pages loaded without their scripts and styles.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, 'service-worker.js'), 'utf8');
const ORIGIN = 'https://holdex.test';

function makeCaches() {
  const stores = new Map();
  const open = async (name) => {
    if (!stores.has(name)) {
      const m = new Map();
      stores.set(name, {
        m,
        async put(req, res) { const u = typeof req === 'string' ? new URL(req, ORIGIN).href : req.url; m.delete(u); m.set(u, res); },
        async add(u) { this.put(u, new Response('x')); },
        async addAll(list) {
          if (new Set(list).size !== list.length) throw new Error('InvalidStateError: duplicate requests');
          for (const u of list) await this.add(u);
        },
        async keys() { return [...m.keys()].map(url => ({ url })); },
        async delete(k) { return m.delete(k.url); },
        async match(req) { return m.get(req.url); }
      });
    }
    return stores.get(name);
  };
  return {
    stores,
    open,
    async keys() { return [...stores.keys()]; },
    async delete(n) { return stores.delete(n); },
    async match(req) {
      for (const s of stores.values()) { const r = await s.match(req); if (r) return r; }
      return undefined;
    }
  };
}

function load() {
  const handlers = {};
  const caches = makeCaches();
  const ctx = {
    console, URL, Response, Headers, Promise, Date, Set,
    caches,
    fetch: async () => new Response('<html></html>', { status: 200 }),
    self: {
      location: { origin: ORIGIN },
      addEventListener: (type, fn) => { handlers[type] = fn; },
      skipWaiting: () => Promise.resolve(),
      clients: { claim: () => Promise.resolve(), matchAll: () => Promise.resolve([]) }
    }
  };
  vm.createContext(ctx);
  vm.runInContext(SRC + '\nthis.__APP_SHELL = APP_SHELL; this.__STATIC = STATIC_CACHE;', ctx);
  return { ctx, handlers, caches };
}

async function dispatch(handlers, type, init) {
  let pending = [];
  const event = {
    ...init,
    waitUntil: p => pending.push(p),
    respondWith: p => pending.push(p)
  };
  handlers[type](event);
  await Promise.all(pending);
}

test('the app shell precaches with addAll (no duplicate URLs)', async () => {
  const { ctx } = load();
  assert.strictEqual(new Set(ctx.__APP_SHELL).size, ctx.__APP_SHELL.length);
});

test('many page views do not evict the precached app shell', async () => {
  const { ctx, handlers, caches } = load();
  await dispatch(handlers, 'install', {});
  const shell = ctx.__APP_SHELL.map(u => new URL(u, ORIGIN).href);
  // Same-origin assets also land in the static cache.
  for (let i = 0; i < 30; i++) {
    await dispatch(handlers, 'fetch', { request: { url: `${ORIGIN}/img/a${i}.png`, method: 'GET', destination: 'image' } });
  }
  for (let i = 0; i < 120; i++) {
    await dispatch(handlers, 'fetch', { request: { url: `${ORIGIN}/token.html?address=T${i}`, method: 'GET', destination: 'document' } });
  }
  const staticKeys = new Set((await (await caches.open(ctx.__STATIC)).keys()).map(k => k.url));
  for (const u of shell) assert.ok(staticKeys.has(u), `shell entry evicted: ${u}`);
});

// ── API fallback (audit #46, #160, #161, #168) ──────────────────────────────

const API = 'https://api.holdex.test';

async function respond(handlers, request) {
  let responded = null;
  const pending = [];
  handlers.fetch({
    request,
    waitUntil: p => pending.push(p),
    respondWith: p => { responded = p; }
  });
  const res = responded ? await responded : null;
  await Promise.all(pending);
  return res;
}

async function primeApi(ctx, caches, url, ageMs) {
  const cache = await caches.open(ctx.__STATIC.replace('-static', '-api'));
  await cache.put({ url }, new Response('{"price":1}', {
    status: 200,
    headers: { 'sw-cached-at': String(Date.now() - ageMs) }
  }));
}

test('an API copy older than its TTL is not served as live data while online', async () => {
  const { ctx, handlers, caches } = load();
  ctx.fetch = async () => { throw new TypeError('Failed to fetch'); };
  const url = `${API}/api/tokens/leaderboard/conviction`;
  await primeApi(ctx, caches, url, 60 * 60 * 1000);
  const res = await respond(handlers, { url, method: 'GET', destination: '' });
  assert.strictEqual(res.type, 'error');
});

test('a stale API copy is still served when the device is offline', async () => {
  const { ctx, handlers, caches } = load();
  ctx.fetch = async () => { throw new TypeError('Failed to fetch'); };
  ctx.self.navigator = { onLine: false };
  const url = `${API}/api/tokens/leaderboard/conviction`;
  await primeApi(ctx, caches, url, 60 * 60 * 1000);
  const res = await respond(handlers, { url, method: 'GET', destination: '' });
  assert.strictEqual(res.status, 200);
});

test('an API copy within its TTL stands in for a failed fetch', async () => {
  const { ctx, handlers, caches } = load();
  ctx.fetch = async () => { throw new TypeError('Failed to fetch'); };
  const url = `${API}/api/tokens/leaderboard/conviction`;
  await primeApi(ctx, caches, url, 60 * 1000);
  const res = await respond(handlers, { url, method: 'GET', destination: '' });
  assert.strictEqual(res.status, 200);
});

test('an uncached API GET that fails offline is a network error, not a 503', async () => {
  const { ctx, handlers } = load();
  ctx.fetch = async () => { throw new TypeError('Failed to fetch'); };
  const res = await respond(handlers, { url: `${API}/api/tokens/abc`, method: 'GET', destination: '' });
  assert.strictEqual(res.type, 'error');
});

test('image-proxy and wallet-keyed API reads are passed through, never stored', async () => {
  const { handlers } = load();
  for (const path of [
    '/api/image-proxy?url=x',
    '/api/watchlist/WALLET',
    '/api/watchlist/WALLET/count',
    '/api/sentiment/MINT?wallet=W',
    '/api/utilities/my-access?wallet=W',
    '/api/tokens/MINT/holder/WALLET',
    '/api/keys/me',
  ]) {
    const res = await respond(handlers, { url: `${API}${path}`, method: 'GET', destination: '' });
    assert.strictEqual(res, null, path);
  }
  const res = await respond(handlers, { url: `${API}/api/tokens/MINT`, method: 'GET', destination: '' });
  assert.ok(res, 'public token reads still go through the API cache');
});
