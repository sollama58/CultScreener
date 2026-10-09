/**
 * /share/:mint and /share/:mint/og-image with a token read from Postgres, whose DECIMAL
 * columns arrive as strings, and with the setWithTimestamp-wrapped token:/batch: cache
 * entries. The cache, db and holder counts are stubbed; nothing touches Redis or Postgres.
 */
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const db = require('../services/database');
const { cache } = require('../services/cache');
const holderCounts = require('../services/holderCounts');

const MINT = 'Foo1111111111111111111111111111111111111111';

// The shape node-pg returns for `SELECT * FROM tokens`: DECIMAL as strings
const DB_ROW = {
  mint_address: MINT, name: 'Foo', symbol: 'FOO',
  price: '0.00123', market_cap: '1230000', price_change_24h: '-4.5', conviction_1m: '62.4'
};

// Per-test cache contents and DB row; reset before each test
let cacheEntries = {};
let dbRow = DB_ROW;
const wrap = (value) => ({ value, age: 0, fresh: true });

let server, base;
const unhandled = [];
const onUnhandled = (r) => unhandled.push(r);

before(async () => {
  cache.getWithMeta = async (key) => (cacheEntries[key] ? wrap(cacheEntries[key]) : undefined);
  db.getToken = async () => (dbRow ? { ...dbRow } : null);
  holderCounts.getDisplayCounts = async (mints) => ({ [mints[0]]: 1500 });
  process.on('unhandledRejection', onUnhandled);
  const app = express();
  app.use('/share', require('./share'));
  app.use((err, req, res, next) => res.status(500).send('error'));
  await new Promise(r => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  process.off('unhandledRejection', onUnhandled);
  server.close();
});

describe('share routes with a Postgres token row', () => {
  beforeEach(() => { cacheEntries = {}; dbRow = DB_ROW; });

  test('/share/:mint renders the description from string decimals', async () => {
    const res = await fetch(`${base}/share/${MINT}`, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
    assert.strictEqual(res.status, 200);
    const html = await res.text();
    assert.match(html, /\$0\.001230 \| -4\.50% 24h \| MCap \$1\.23M \| Diamond Hands 62%/);
    assert.deepStrictEqual(unhandled, []);
  });

  test('/share/:mint/og-image renders the card from string decimals', async () => {
    const res = await fetch(`${base}/share/${MINT}/og-image`, { signal: AbortSignal.timeout(5000) });
    assert.strictEqual(res.status, 200);
    const svg = await res.text();
    assert.match(svg, /\$0\.001230/);
    assert.match(svg, /-4\.50% 24h/);
    assert.match(svg, /1,500/);
    assert.deepStrictEqual(unhandled, []);
  });

  test('/share/:mint does not ship the CSP-blocked inline redirect script', async () => {
    const html = await (await fetch(`${base}/share/${MINT}`, { redirect: 'manual' })).text();
    assert.doesNotMatch(html, /<script/);
    assert.match(html, /http-equiv="refresh"/);
  });
});

describe('share routes with a cached token', () => {
  beforeEach(() => { cacheEntries = {}; dbRow = DB_ROW; });

  test('a token: detail cache entry (setWithTimestamp wrapper) is unwrapped, not shown as Unknown Token', async () => {
    cacheEntries[`token:${MINT}`] = { name: 'Foo', symbol: 'FOO', price: 0.002, marketCap: 2500000, priceChange24h: 3.25, holders: 4242 };
    const html = await (await fetch(`${base}/share/${MINT}`, { redirect: 'manual' })).text();
    assert.match(html, /<title>Foo \(FOO\) - HolDEX<\/title>/);
    // Live market data from the cache, conviction from the DB row
    assert.match(html, /\$0\.002000 \| \+3\.25% 24h \| MCap \$2\.50M \| Diamond Hands 62%/);
    const svg = await (await fetch(`${base}/share/${MINT}/og-image`)).text();
    assert.match(svg, /4,242/);
    assert.doesNotMatch(svg, /Unknown Token/);
  });

  test('a batch: entry with no DB row still names the token', async () => {
    dbRow = null;
    cacheEntries[`batch:${MINT}`] = { name: 'Bar', symbol: 'BAR', price: 1.5, marketCap: 900, priceChange24h: null };
    const html = await (await fetch(`${base}/share/${MINT}`, { redirect: 'manual' })).text();
    assert.match(html, /<title>Bar \(BAR\) - HolDEX<\/title>/);
    assert.match(html, /\$1\.5 \| MCap \$900/);
  });

  test('an unknown mint renders Unknown Token without a holder lookup', async () => {
    dbRow = null;
    let lookups = 0;
    const orig = holderCounts.getDisplayCounts;
    holderCounts.getDisplayCounts = async () => { lookups++; return {}; };
    try {
      const svg = await (await fetch(`${base}/share/${MINT}/og-image`)).text();
      assert.match(svg, /Unknown Token/);
      assert.strictEqual(lookups, 0);
    } finally {
      holderCounts.getDisplayCounts = orig;
    }
  });

  test('a long name with & is truncated before escaping, so the SVG stays well-formed', async () => {
    dbRow = { ...DB_ROW, name: 'ABCDEFGHIJKLMNOPQRST & more' };
    const svg = await (await fetch(`${base}/share/${MINT}/og-image`)).text();
    assert.match(svg, />ABCDEFGHIJKLMNOPQRST &amp;\.\.</);
    // Every & in the document starts a complete entity
    assert.doesNotMatch(svg, /&(?!(amp|lt|gt|quot);)/);
  });
});

test('/share has its own per-IP rate limit', async () => {
  let status = 200;
  for (let i = 0; i < 130 && status !== 429; i++) {
    status = (await fetch(`${base}/share/${MINT}`, { redirect: 'manual' })).status;
  }
  assert.strictEqual(status, 429);
});
