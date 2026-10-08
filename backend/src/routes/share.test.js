/**
 * /share/:mint and /share/:mint/og-image with a token read from Postgres, whose DECIMAL
 * columns arrive as strings. The cache and db are stubbed; nothing touches Redis or Postgres.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const db = require('../services/database');
const { cache } = require('../services/cache');

const MINT = 'Foo1111111111111111111111111111111111111111';

// The shape node-pg returns for `SELECT * FROM tokens`: DECIMAL as strings
const DB_ROW = {
  mint_address: MINT, name: 'Foo', symbol: 'FOO',
  price: '0.00123', market_cap: '1230000', price_change_24h: '-4.5', conviction_1m: '62.4', holder_count: 1500
};

let server, base;
const unhandled = [];
const onUnhandled = (r) => unhandled.push(r);

before(async () => {
  cache.get = async () => null;
  db.getToken = async () => ({ ...DB_ROW });
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
});
