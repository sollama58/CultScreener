const { test, describe } = require('node:test');
const assert = require('node:assert');
const { ohlcvTimeframe, weeksFromDays, poolSideForMint, OHLCV_TIMEFRAMES, retryAfterMs } = require('./geckoTerminal');
const { RATE_LIMITS } = require('./rateLimiter');

describe('ohlcvTimeframe', () => {
  test('maps every supported interval to a GeckoTerminal timeframe', () => {
    assert.deepStrictEqual(ohlcvTimeframe('1m'), { timeframe: 'minute', aggregate: 1 });
    assert.deepStrictEqual(ohlcvTimeframe('15m'), { timeframe: 'minute', aggregate: 15 });
    assert.deepStrictEqual(ohlcvTimeframe('4H'), { timeframe: 'hour', aggregate: 4 });
    assert.deepStrictEqual(ohlcvTimeframe('12h'), { timeframe: 'hour', aggregate: 12 });
    assert.deepStrictEqual(ohlcvTimeframe('1d'), { timeframe: 'day', aggregate: 1 });
    assert.deepStrictEqual(ohlcvTimeframe('1W'), { timeframe: 'day', aggregate: 1, weekly: true });
  });

  test('falls back to a size GeckoTerminal accepts', () => {
    assert.deepStrictEqual(ohlcvTimeframe('30m'), OHLCV_TIMEFRAMES['15m']);
    assert.deepStrictEqual(ohlcvTimeframe('2w'), OHLCV_TIMEFRAMES['1d']);
    assert.deepStrictEqual(ohlcvTimeframe(undefined), OHLCV_TIMEFRAMES['1h']);
  });

  test('only offers aggregates GeckoTerminal supports', () => {
    const allowed = { minute: [1, 5, 15], hour: [1, 4, 12], day: [1] };
    for (const { timeframe, aggregate } of Object.values(OHLCV_TIMEFRAMES)) {
      assert.ok(allowed[timeframe].includes(aggregate), `${timeframe}/${aggregate}`);
    }
  });
});

describe('weeksFromDays', () => {
  // 2026-10-05 is a Monday
  const day = (iso, o, h, l, c, v) => ({ timestamp: Date.parse(iso + 'T00:00:00Z'), open: o, high: h, low: l, close: c, volume: v });

  test('folds days into Monday-open weeks, newest first', () => {
    const days = [
      day('2026-10-12', 9, 10, 8, 9.5, 5), // next Monday
      day('2026-10-11', 6, 9, 6, 8, 3),    // Sunday
      day('2026-10-07', 4, 7, 3, 6, 2),
      day('2026-10-05', 5, 5, 2, 4, 1),    // Monday
      day('2026-10-04', 1, 2, 1, 1.5, 1)   // previous Sunday
    ];
    assert.deepStrictEqual(weeksFromDays(days), [
      { timestamp: Date.parse('2026-10-12T00:00:00Z'), open: 9, high: 10, low: 8, close: 9.5, volume: 5 },
      { timestamp: Date.parse('2026-10-05T00:00:00Z'), open: 5, high: 9, low: 2, close: 8, volume: 6 },
      { timestamp: Date.parse('2026-09-28T00:00:00Z'), open: 1, high: 2, low: 1, close: 1.5, volume: 1 }
    ]);
  });

  test('drops the oldest week when the daily window was cut short', () => {
    const days = [day('2026-10-06', 2, 3, 1, 2, 1), day('2026-10-04', 1, 2, 1, 1.5, 1)];
    const weeks = weeksFromDays(days, true);
    assert.strictEqual(weeks.length, 1);
    assert.strictEqual(weeks[0].timestamp, Date.parse('2026-10-05T00:00:00Z'));
  });
});

describe('poolSideForMint', () => {
  const mint = 'So11111111111111111111111111111111111111112';
  const other = 'Ex1111111111111111111111111111111111111111';
  const pool = (base, quote) => ({
    relationships: { base_token: { data: { id: `solana_${base}` } }, quote_token: { data: { id: `solana_${quote}` } } }
  });

  test('uses quote when the token is the pool quote', () => {
    assert.strictEqual(poolSideForMint(pool(other, mint), mint), 'quote');
  });

  test('uses base otherwise', () => {
    assert.strictEqual(poolSideForMint(pool(mint, other), mint), 'base');
    assert.strictEqual(poolSideForMint({}, mint), 'base');
  });
});

describe('free tier pacing', () => {
  test('without COINGECKO_API_KEY the limiter is paced for 30 requests a minute', () => {
    if (process.env.COINGECKO_API_KEY) return;
    const g = RATE_LIMITS.geckoTerminal;
    assert.ok(g.minInterval >= 2000, `minInterval ${g.minInterval}`);
    assert.ok(g.burstLimit * (60000 / g.burstWindow) <= 30, 'bursts stay within 30/min');
  });
});

describe('retryAfterMs', () => {
  const err = (headers) => ({ response: { status: 429, headers } });

  test('reads Retry-After seconds', () => {
    assert.strictEqual(retryAfterMs(err({ 'retry-after': '20' })), 20000);
  });

  test('reads a Retry-After date', () => {
    const ms = retryAfterMs(err({ 'retry-after': new Date(Date.now() + 10000).toUTCString() }));
    assert.ok(ms > 8000 && ms <= 10000, String(ms));
  });

  test('returns null without a usable header', () => {
    assert.strictEqual(retryAfterMs(err({})), null);
    assert.strictEqual(retryAfterMs(err({ 'retry-after': 'soon' })), null);
    assert.strictEqual(retryAfterMs({}), null);
  });
});
