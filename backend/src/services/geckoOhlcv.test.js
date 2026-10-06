const { test, describe } = require('node:test');
const assert = require('node:assert');
const { ohlcvTimeframe, poolSideForMint, OHLCV_TIMEFRAMES } = require('./geckoTerminal');

describe('ohlcvTimeframe', () => {
  test('maps every supported interval to a GeckoTerminal timeframe', () => {
    assert.deepStrictEqual(ohlcvTimeframe('1m'), { timeframe: 'minute', aggregate: 1 });
    assert.deepStrictEqual(ohlcvTimeframe('15m'), { timeframe: 'minute', aggregate: 15 });
    assert.deepStrictEqual(ohlcvTimeframe('4H'), { timeframe: 'hour', aggregate: 4 });
    assert.deepStrictEqual(ohlcvTimeframe('12h'), { timeframe: 'hour', aggregate: 12 });
    assert.deepStrictEqual(ohlcvTimeframe('1d'), { timeframe: 'day', aggregate: 1 });
  });

  test('falls back to a size GeckoTerminal accepts', () => {
    assert.deepStrictEqual(ohlcvTimeframe('30m'), OHLCV_TIMEFRAMES['15m']);
    assert.deepStrictEqual(ohlcvTimeframe('1w'), OHLCV_TIMEFRAMES['1d']);
    assert.deepStrictEqual(ohlcvTimeframe(undefined), OHLCV_TIMEFRAMES['1h']);
  });

  test('only offers aggregates GeckoTerminal supports', () => {
    const allowed = { minute: [1, 5, 15], hour: [1, 4, 12], day: [1] };
    for (const { timeframe, aggregate } of Object.values(OHLCV_TIMEFRAMES)) {
      assert.ok(allowed[timeframe].includes(aggregate), `${timeframe}/${aggregate}`);
    }
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
