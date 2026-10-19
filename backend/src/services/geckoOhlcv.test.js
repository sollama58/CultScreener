const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  ohlcvTimeframe, weeksFromDays, poolSideForMint, OHLCV_TIMEFRAMES, retryAfterMs,
  stitchLaunchCandles, pumpCurveAddress, timeframeSeconds
} = require('./geckoTerminal');
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

describe('timeframeSeconds', () => {
  test('gives the candle length for each GeckoTerminal size', () => {
    assert.strictEqual(timeframeSeconds(OHLCV_TIMEFRAMES['5m']), 300);
    assert.strictEqual(timeframeSeconds(OHLCV_TIMEFRAMES['4h']), 14400);
    assert.strictEqual(timeframeSeconds(OHLCV_TIMEFRAMES['1w']), 86400);
  });
});

describe('pumpCurveAddress', () => {
  test('derives the pump.fun bonding curve for a pump mint', () => {
    assert.strictEqual(pumpCurveAddress('D3S6J9s1byrNBt3ZKwEDiPsNRqHtoEP8zQKdhyBdpump'), '78FjADbvKVgBonKtHDuDjuHUYa4UUAhVYkr2WurqDNEF');
  });

  test('is null for other mints and bad input', () => {
    assert.strictEqual(pumpCurveAddress('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'), null);
    assert.strictEqual(pumpCurveAddress('notakeypump'), null);
    assert.strictEqual(pumpCurveAddress(undefined), null);
  });
});

describe('stitchLaunchCandles', () => {
  const T = 1_800_000_000_000;
  const c = (min, open, close, volume = 1) => ({ timestamp: T + min * 60000, open, high: Math.max(open, close), low: Math.min(open, close), close, volume });
  const pool = [c(10, 4, 5), c(5, 3, 4)]; // newest first, history starts at minute 5

  test('puts the curve candles before the pool, merging the shared candle', () => {
    const curve = [c(5, 2, 3, 2), c(0, 1, 2)];
    assert.deepStrictEqual(stitchLaunchCandles(pool, curve, 300), [
      c(10, 4, 5),
      { timestamp: T + 5 * 60000, open: 2, high: 4, low: 2, close: 4, volume: 3 },
      c(0, 1, 2)
    ]);
  });

  test('ignores curve candles newer than the pool start', () => {
    const curve = [c(10, 9, 9), c(0, 2, 3)];
    assert.deepStrictEqual(stitchLaunchCandles(pool, curve, 300), [...pool, c(0, 2, 3)]);
  });

  test('leaves the pool alone when the curve did not hand over to it', () => {
    // Ended long before the pool opened
    assert.strictEqual(stitchLaunchCandles(pool, [c(-60, 2, 3)], 300), pool);
    // A price nowhere near the pool's (wrong side or currency)
    assert.strictEqual(stitchLaunchCandles(pool, [c(0, 1000, 1000)], 300), pool);
    assert.strictEqual(stitchLaunchCandles(pool, [], 300), pool);
    assert.deepStrictEqual(stitchLaunchCandles([], [c(0, 1, 2)], 300), []);
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
