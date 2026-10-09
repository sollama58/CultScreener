const { test, describe } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { warmBatchEntry, bodyParserErrorResponse, isForeignPageRequest } = require('./appHelpers');

const MINT = 'So11111111111111111111111111111111111111112';

describe('warmBatchEntry', () => {
  test('carries the address fields the frontend matches batch rows by (audit #9)', () => {
    const entry = warmBatchEntry(MINT, { name: 'Wrapped SOL', symbol: 'SOL', price: 150, marketCap: 1e9, logoUri: 'https://x/y.png', volume24h: 5, priceChange24h: 1.5, decimals: 9 });
    assert.strictEqual(entry.address, MINT);
    assert.strictEqual(entry.mintAddress, MINT);
    assert.strictEqual(entry.logoURI, 'https://x/y.png');
    assert.strictEqual(entry.price, 150);
    assert.strictEqual(entry.marketCap, 1e9);
  });

  test('null price defaults like the batch route, and no entry without a usable name', () => {
    assert.strictEqual(warmBatchEntry(MINT, { name: 'X', price: null, volume24h: null }).price, 0);
    assert.strictEqual(warmBatchEntry(MINT, { name: 'Unknown Token' }), null);
    assert.strictEqual(warmBatchEntry(MINT, { name: null }), null);
    assert.strictEqual(warmBatchEntry(MINT, undefined), null);
  });
});

describe('bodyParserErrorResponse (audit #67)', () => {
  test('express.json errors map to client errors, anything else to null', async () => {
    const app = express();
    app.use(express.json({ limit: '1kb' }));
    app.post('/x', (req, res) => res.json({ ok: true }));
    app.use((err, req, res, next) => {
      const r = bodyParserErrorResponse(err);
      res.status(r ? r.statusCode : 500).json({ code: r ? r.errorCode : 'INTERNAL_ERROR' });
    });
    const server = app.listen(0);
    await new Promise(r => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const post = (body) => fetch(`${base}/x`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      let r = await post('{"a":}');
      assert.strictEqual(r.status, 400);
      assert.strictEqual((await r.json()).code, 'INVALID_JSON');
      r = await post(JSON.stringify({ a: 'x'.repeat(2048) }));
      assert.strictEqual(r.status, 413);
      assert.strictEqual((await r.json()).code, 'PAYLOAD_TOO_LARGE');
    } finally {
      server.close();
    }
    assert.strictEqual(bodyParserErrorResponse(new Error('boom')), null);
  });
});

describe('isForeignPageRequest (audit #8)', () => {
  const allowed = ['https://holdex.live', 'https://www.holdex.live'];
  const req = (headers) => ({ headers: { host: 'cultscreener-api.onrender.com', ...headers } });

  test('HolDEX pages, the API host itself and requests naming no page are not foreign', () => {
    assert.strictEqual(isForeignPageRequest(req({ referer: 'https://holdex.live/token.html?mint=x' }), allowed), false);
    assert.strictEqual(isForeignPageRequest(req({ origin: 'https://www.holdex.live' }), allowed), false);
    assert.strictEqual(isForeignPageRequest(req({ referer: 'https://cultscreener-api.onrender.com/share/abc' }), allowed), false);
    assert.strictEqual(isForeignPageRequest(req({}), allowed), false);
  });

  test('another site embedding the proxy is foreign', () => {
    assert.strictEqual(isForeignPageRequest(req({ referer: 'https://evil.example/page' }), allowed), true);
    assert.strictEqual(isForeignPageRequest(req({ origin: 'https://evil.example' }), allowed), true);
  });
});
