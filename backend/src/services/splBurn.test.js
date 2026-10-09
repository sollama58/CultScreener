const { test } = require('node:test');
const assert = require('node:assert');
const { inferSplBurn } = require('./splBurn');

const PUMP_AUTH = { authorities: [{ address: 'TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM', scopes: ['full'] }] };
const OTHER_AUTH = { authorities: [{ address: 'SomeCreatorWa11et111111111111111111111111111', scopes: ['full'] }] };

test('a hand-launched 100M token with revoked authorities shows no SPL burn (audit #34)', () => {
  // 6 decimals, mint and freeze authority revoked, supply under 1B: not proof of pump.fun
  const r = inferSplBurn({ currentSupply: 100_000_000, decimals: 6, tokenAuth: OTHER_AUTH });
  assert.deepStrictEqual(r, { isPumpFun: false, splBurnt: 0, supplyDenominator: 100_000_000 });
});

test('an unknown authority (lookup failed) infers nothing either', () => {
  const r = inferSplBurn({ currentSupply: 420_690_000, decimals: 6, tokenAuth: null });
  assert.strictEqual(r.isPumpFun, false);
  assert.strictEqual(r.splBurnt, 0);
});

test('a pump.fun token reports the supply burnt below its 1B original', () => {
  const r = inferSplBurn({ currentSupply: 990_000_000, decimals: 6, tokenAuth: PUMP_AUTH });
  assert.deepStrictEqual(r, { isPumpFun: true, splBurnt: 10_000_000, supplyDenominator: 1_000_000_000 });
});

test('a pump.fun token with no burn reports none', () => {
  const r = inferSplBurn({ currentSupply: 1_000_000_000, decimals: 6, tokenAuth: PUMP_AUTH });
  assert.strictEqual(r.splBurnt, 0);
});
