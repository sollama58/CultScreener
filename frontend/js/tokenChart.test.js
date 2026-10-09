// Run with: node --test frontend/js/tokenChart.test.js
// tokenChart.js is a browser script (no module system); load it in a vm with a stub document.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadTokenChart() {
  const src = fs.readFileSync(path.join(__dirname, 'tokenChart.js'), 'utf8');
  const ctx = {
    window: {},
    document: { readyState: 'loading', addEventListener() {}, getElementById() { return null; } },
    localStorage: { getItem() { return null; }, setItem() {} }
  };
  vm.createContext(ctx);
  vm.runInContext(`${src}\nthis.tokenChart = tokenChart;`, ctx);
  return ctx.tokenChart;
}

const { fmtValue } = loadTokenChart()._test;

test('fmtValue collapses long zero runs', () => {
  assert.strictEqual(fmtValue(0.00001234), '0.0₄1234');
  assert.strictEqual(fmtValue(0.00001), '0.0₄1');
  assert.strictEqual(fmtValue(0.000000056789), '0.0₇5679');
  assert.strictEqual(fmtValue(-0.00001234), '-0.0₄1234');
});

test('fmtValue carries rounding into the zero count at power-of-ten boundaries', () => {
  // Previously '0.0₄1' (0.00001), ten times too low
  assert.strictEqual(fmtValue(0.0000999997), '0.0001');
  // Previously '0.0₅1' (0.000001), ten times too low
  assert.strictEqual(fmtValue(0.00000999997), '0.0₄1');
  assert.strictEqual(fmtValue(0.000000999996), '0.0₅1');
  // Just below the carry window stays as is
  assert.strictEqual(fmtValue(0.000009999), '0.0₅9999');
});

test('fmtValue keeps the plain paths', () => {
  assert.strictEqual(fmtValue(0.001234), '0.001234');
  assert.strictEqual(fmtValue(0), '0');
  assert.strictEqual(fmtValue(null), '--');
  assert.strictEqual(fmtValue(12345), '12.35K');
});

test('normalizeHStyle keeps valid holder line settings and drops bad ones', () => {
  const { normalizeHStyle } = loadTokenChart()._test;
  assert.deepStrictEqual({ ...normalizeHStyle(null) }, { color: '#22d3ee', opacity: 1, pane: 'overlay' });
  assert.deepStrictEqual({ ...normalizeHStyle({ color: '#F472B6', opacity: 0.6, pane: 'pane' }) }, { color: '#f472b6', opacity: 0.6, pane: 'pane' });
  assert.deepStrictEqual({ ...normalizeHStyle({ color: 'red;}', opacity: 0, pane: 'left' }) }, { color: '#22d3ee', opacity: 0.1, pane: 'overlay' });
  assert.strictEqual(normalizeHStyle({ opacity: 'x' }).opacity, 1);
  assert.strictEqual(normalizeHStyle({ opacity: 5 }).opacity, 1);
});

test('hexToRgba applies the opacity', () => {
  const { hexToRgba } = loadTokenChart()._test;
  assert.strictEqual(hexToRgba('#22d3ee', 0.5), 'rgba(34,211,238,0.5)');
});

// Ticks sit on UTC boundaries; their date labels must read in UTC for viewers west of
// UTC too (a Month tick on Oct 1 00:00 UTC used to read "Sep" in New York).
test('fmtTick labels year/month/day ticks by their UTC date (price and holder charts)', () => {
  const prevTz = process.env.TZ;
  process.env.TZ = 'America/New_York';
  try {
    const holderSrc = fs.readFileSync(path.join(__dirname, 'holderChart.js'), 'utf8');
    const hctx = { window: {}, document: { readyState: 'loading', addEventListener() {}, getElementById() { return null; } }, localStorage: { getItem() { return null; }, setItem() {} } };
    vm.createContext(hctx);
    vm.runInContext(`${holderSrc}\nthis.holderChart = holderChart;`, hctx);
    for (const fmtTick of [loadTokenChart()._test.fmtTick, hctx.holderChart._test.fmtTick]) {
      const oct1 = Date.UTC(2026, 9, 1) / 1000;
      const jan1 = Date.UTC(2027, 0, 1) / 1000;
      const oct9 = Date.UTC(2026, 9, 9) / 1000;
      assert.strictEqual(fmtTick(jan1, 0), '2027');
      assert.match(fmtTick(oct1, 1), /Oct/);
      assert.match(fmtTick(oct9, 2), /9/);
      assert.match(fmtTick(oct9, 2), /Oct/);
    }
  } finally {
    if (prevTz === undefined) delete process.env.TZ; else process.env.TZ = prevTz;
  }
});
