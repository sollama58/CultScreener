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
