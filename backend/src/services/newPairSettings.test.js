/**
 * New Pairs settings: parsing what is stored and refusing what is out of range.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

let stored = null;
const dbFile = require.resolve(path.join(__dirname, 'database'));
require.cache[dbFile] = { id: dbFile, filename: dbFile, loaded: true, exports: {
  pool: null,
  getSetting: async () => stored,
  setSetting: async (_k, v) => { stored = v; },
} };
const settings = require('./newPairSettings');

const ENV = { NEWPAIRS_HELIUS_DAILY_CREDITS: '10000' };

test('parse: defaults for nothing, bad JSON and out-of-range values', () => {
  const defaults = { minMcap: 25000, minLiquidity: 5000, shortlistSize: 50, dailyCredits: 10000, maxDailyCredits: 10000 };
  assert.deepStrictEqual(settings.parse(null, ENV), defaults);
  assert.deepStrictEqual(settings.parse('{not json', ENV), defaults);
  assert.deepStrictEqual(settings.parse('[1,2]', ENV), defaults);
  assert.deepStrictEqual(settings.parse(JSON.stringify({ minMcap: -1, shortlistSize: 5000, dailyCredits: -3 }), ENV), defaults);
  assert.deepStrictEqual(settings.parse(JSON.stringify({ shortlistSize: 12.5, dailyCredits: '900' }), ENV), defaults);
});

test('parse: a stored cap above the env ceiling is read as the ceiling; no env means 10,000', () => {
  const raw = JSON.stringify({ dailyCredits: 9000 });
  assert.strictEqual(settings.parse(raw, { NEWPAIRS_HELIUS_DAILY_CREDITS: '4000' }).dailyCredits, 4000);
  assert.strictEqual(settings.parse(raw, {}).dailyCredits, 9000);
  assert.strictEqual(settings.parse(null, {}).maxDailyCredits, 10000);
  assert.strictEqual(settings.parse(null, { NEWPAIRS_HELIUS_DAILY_CREDITS: '0' }).dailyCredits, 0, 'zero turns Helius spend off');
  assert.strictEqual(settings.parse(null, { NEWPAIRS_HELIUS_DAILY_CREDITS: 'lots' }).dailyCredits, 10000);
});

test('save: only the keys given change', async () => {
  stored = null;
  await settings.save({ minLiquidity: 9000 }, ENV);
  await settings.save({ dailyCredits: 2500 }, ENV);
  assert.deepStrictEqual(await settings.get(ENV), { minMcap: 25000, minLiquidity: 9000, shortlistSize: 50, dailyCredits: 2500, maxDailyCredits: 10000 });
});

test('save: refuses out-of-range values and stores nothing', async () => {
  stored = null;
  const cases = [
    [{ dailyCredits: 10001 }, /cannot be above 10000/],
    [{ dailyCredits: -1 }, /dailyCredits/],
    [{ dailyCredits: 12.5 }, /dailyCredits/],
    [{ dailyCredits: '5000' }, /dailyCredits/],
    [{ shortlistSize: 9 }, /shortlistSize/],
    [{ shortlistSize: 201 }, /shortlistSize/],
    [{ minMcap: -5 }, /minMcap/],
    [{ minLiquidity: Infinity }, /minLiquidity/],
    [{ minMcap: null }, /minMcap/],
    [[], /object/],
    [null, /object/],
  ];
  for (const [input, message] of cases) {
    await assert.rejects(settings.save(input, ENV), e => e.status === 400 && message.test(e.message), JSON.stringify(input));
  }
  assert.strictEqual(stored, null);
});
