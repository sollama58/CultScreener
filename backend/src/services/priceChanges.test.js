const { test, describe } = require('node:test');
const assert = require('node:assert');
const { priceAt, referencePrices, changePct, changesForRow, fetchReferencePrices } = require('./priceChanges');

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 7, 12);

// 4h candles, oldest first, price rising 1 per candle from `start`
function candles(fromT, count, start = 1) {
  return Array.from({ length: count }, (_, i) => ({
    timestamp: fromT + i * 4 * HOUR,
    open: start + i,
    close: start + i + 1,
  }));
}

describe('priceAt', () => {
  test('open of the candle covering t', () => {
    const list = candles(NOW - 2 * DAY, 12);
    // t is 1h into the candle that opened at NOW - 2d + 8h
    assert.strictEqual(priceAt(list, NOW - 2 * DAY + 9 * HOUR), 3);
  });

  test('close of the last candle before a gap', () => {
    const list = [{ timestamp: NOW - 3 * DAY, open: 5, close: 6 }, { timestamp: NOW, open: 9, close: 9 }];
    assert.strictEqual(priceAt(list, NOW - DAY), 6);
  });

  test('null when the pool is younger than the window', () => {
    assert.strictEqual(priceAt(candles(NOW - DAY, 6), NOW - 7 * DAY), null);
  });
});

describe('referencePrices', () => {
  test('1, 7 and 30 days back, any input order', () => {
    const list = candles(NOW - 31 * DAY, 31 * 6).reverse();
    const refs = referencePrices(list, NOW);
    // NOW - 30d is the 6th candle (index 6): open 7
    assert.strictEqual(refs.d30, 7);
    assert.strictEqual(refs.d7, 1 + 24 * 6);
    assert.strictEqual(refs.d1, 1 + 30 * 6);
  });

  test('a young token has a 1d reference only', () => {
    const refs = referencePrices(candles(NOW - 3 * DAY, 18), NOW);
    assert.strictEqual(refs.d30, null);
    assert.strictEqual(refs.d7, null);
    assert.ok(refs.d1 > 0);
  });
});

describe('changePct', () => {
  test('percent from ref', () => {
    assert.strictEqual(changePct(150, 100), 50);
    assert.strictEqual(changePct('50', '100'), -50);
  });
  test('null without both sides', () => {
    assert.strictEqual(changePct(null, 1), null);
    assert.strictEqual(changePct(1, 0), null);
  });
});

describe('changesForRow', () => {
  const fresh = new Date(NOW - HOUR).toISOString();

  test('stored 24h change wins over the 1d reference', () => {
    const c = changesForRow({ price: '2', price_change_24h: '12.5', price_ref_1d: '1', price_ref_7d: '4', price_ref_30d: '1', price_refs_at: fresh }, NOW);
    assert.deepStrictEqual(c, { priceChange24h: 12.5, priceChange7d: -50, priceChange30d: 100 });
  });

  test('1d reference fills a missing 24h change', () => {
    const c = changesForRow({ price: 2, price_change_24h: null, price_ref_1d: 1, price_refs_at: fresh }, NOW);
    assert.strictEqual(c.priceChange24h, 100);
    assert.strictEqual(c.priceChange7d, null);
  });

  test('the 24h fallback is not read from references more than 6h old (audit #182)', () => {
    const row = { price: 2, price_change_24h: null, price_ref_1d: 1, price_ref_7d: 1 };
    // 5h old: still within the 24h window's tolerance
    assert.strictEqual(changesForRow({ ...row, price_refs_at: new Date(NOW - 5 * HOUR) }, NOW).priceChange24h, 100);
    // 20h old: it would measure a ~44h move, so unknown rather than mislabelled; 7d still shown
    const old = changesForRow({ ...row, price_refs_at: new Date(NOW - 20 * HOUR) }, NOW);
    assert.strictEqual(old.priceChange24h, null);
    assert.strictEqual(old.priceChange7d, 100);
  });

  test('references a day old are not used', () => {
    const c = changesForRow({ price: 2, price_ref_7d: 1, price_refs_at: new Date(NOW - 2 * DAY) }, NOW);
    assert.strictEqual(c.priceChange7d, null);
  });
});

describe('fetchReferencePrices', () => {
  test('asks for 4h candles and computes references', async () => {
    let asked;
    const gecko = { getOHLCV: async (mint, opts) => { asked = opts; return { data: candles(NOW - 31 * DAY, 186) }; } };
    const refs = await fetchReferencePrices('mint', { now: NOW, gecko });
    assert.strictEqual(asked.interval, '4h');
    assert.strictEqual(refs.d30, 7);
  });

  test('null without candles, throws on upstream error', async () => {
    assert.strictEqual(await fetchReferencePrices('m', { gecko: { getOHLCV: async () => ({ data: [] }) } }), null);
    await assert.rejects(fetchReferencePrices('m', { gecko: { getOHLCV: async () => ({ data: [], error: '429' }) } }));
  });
});
