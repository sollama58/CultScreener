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
