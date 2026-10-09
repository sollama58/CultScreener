/**
 * Home page tables (run with: node --test frontend/js/homeTables.test.js).
 * The leaderboard is read past its 100-row page cap, random-order tables get no top-3 highlight,
 * and the vs SOL podium is ranked by vs SOL whatever the table is sorted by.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const TOKEN_TABLE = fs.readFileSync(path.join(__dirname, 'tokenTable.js'), 'utf8');
const VERSUS = fs.readFileSync(path.join(__dirname, 'versus.js'), 'utf8');

function load(board) {
  const calls = [];
  const ctx = {
    console,
    api: {
      tokens: {
        async leaderboardConviction(params, options) {
          calls.push({ ...params, fresh: !!(options && options.fresh) });
          return board(params);
        }
      }
    },
    utils: { escapeHtml: s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;') }
  };
  vm.createContext(ctx);
  vm.runInContext(TOKEN_TABLE + '\nthis.tokenTable = tokenTable;\n' + VERSUS + '\nthis.versusPage = versusPage;', ctx);
  return { ctx, calls };
}

const tok = i => ({ mintAddress: `M${i}` });

test('loadBoard reads every page up to total', async () => {
  const all = Array.from({ length: 230 }, (_, i) => tok(i));
  const { ctx, calls } = load(({ limit, offset }) => ({ tokens: all.slice(offset, offset + limit), total: all.length }));
  const result = await ctx.tokenTable.loadBoard();
  assert.strictEqual(result.tokens.length, 230);
  assert.strictEqual(result.total, 230);
  assert.deepStrictEqual(calls.map(c => c.offset), [0, 100, 200]);
});

test('loadBoard makes one request when everything fits, and passes fresh through', async () => {
  const first = { tokens: [tok(1), tok(2)], total: 2 };
  const { ctx, calls } = load(() => first);
  const result = await ctx.tokenTable.loadBoard({ fresh: true });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].fresh, true);
  assert.strictEqual(result.tokens.length, 2);
  assert.notStrictEqual(result.tokens, first.tokens, 'the cached array is not handed out');
});

test('loadBoard keeps each mint once when rows shift between pages', async () => {
  const { ctx } = load(({ offset }) => (offset === 0
    ? { tokens: Array.from({ length: 100 }, (_, i) => tok(i)), total: 101 }
    : { tokens: [tok(99), tok(100)], total: 101 }));
  const result = await ctx.tokenTable.loadBoard();
  assert.strictEqual(result.tokens.length, 101);
});

test('a plain rank cell has no top-3 highlight', () => {
  const { ctx } = load(() => ({ tokens: [], total: 0 }));
  assert.match(ctx.tokenTable.rankCell(1), /tt-rank-top/);
  assert.doesNotMatch(ctx.tokenTable.rankCell(1, { plain: true }), /tt-rank-top/);
});

test('the vs SOL top 3 ignores the table sort', () => {
  const { ctx } = load(() => ({ tokens: [], total: 0 }));
  const v = ctx.versusPage;
  v.benchmarks = { sol: { priceChange24h: 0 }, btc: null };
  v.tokens = [
    { mintAddress: 'A', priceChange24h: 5, marketCap: 1 },
    { mintAddress: 'B', priceChange24h: -20, marketCap: 9 },
    { mintAddress: 'C', priceChange24h: 30, marketCap: 2 },
    { mintAddress: 'D', priceChange24h: 10, marketCap: 8 },
    { mintAddress: 'E', priceChange24h: null, marketCap: 99 },
  ];
  for (const [field, dir] of [['vsSol', 'desc'], ['vsSol', 'asc'], ['mcap', 'desc'], ['holders', 'asc']]) {
    v._sortField = field;
    v._sortDir = dir;
    assert.deepStrictEqual(v._getTop3().map(t => t.mintAddress), ['C', 'D', 'A'], `${field} ${dir}`);
  }
});
