/**
 * New Pairs tab (run with: node --test frontend/js/newPairs.test.js).
 * Ages go amber and grey on the documented limits, rugged tokens stay hidden until asked for,
 * creator-written text is escaped, and the score breakdown adds up to the score.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, 'tokenTable.js'), 'utf8') + '\nthis.tokenTable = tokenTable;\n' +
  fs.readFileSync(path.join(__dirname, 'newPairs.js'), 'utf8') + '\nthis.newPairsPage = newPairsPage;';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const NOW = Date.parse('2026-11-12T12:00:00Z');
const ago = ms => new Date(NOW - ms).toISOString();
const WEIGHTS = { growth: 0.20, steady: 0.10, base: 0.05, breadth: 0.10, retention: 0.15, spread: 0.15, dev: 0.05, activity: 0.08, trend: 0.07, pressure: 0.05 };

function load(list) {
  const calls = [];
  const ctx = {
    console,
    api: { newPairs: { async list(w) { calls.push(w); return list(w); } } },
    utils: {
      escapeHtml: s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
      formatNumber: (n, p) => (n == null ? '--' : `${p}${n}`),
      proxyImageUrl: u => (/^https:\/\//.test(u || '') ? u : null),
      getDefaultLogo: () => 'data:image/svg+xml,default',
    },
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  return { page: ctx.newPairsPage, calls };
}

const tok = (over = {}) => ({
  mint: 'Mint1111111111111111111111111111111111111111', name: 'Alpha', symbol: 'ALPHA', launchpad: 'Pump.fun',
  graduatedAt: ago(30 * HOUR), score: 50, scoreState: 'full', terms: {}, riskParts: {}, marketCap: 1e6, liquidity: 5e4,
  holders: 1000, holdersChange24h: 5, rugged: false, curated: false, emergingCult: false,
  at: { market: ago(4 * MIN), holders: ago(6 * MIN), top50: ago(3 * HOUR) }, ...over,
});

test('ages: market and holders go amber after 30 minutes and grey after 2 hours', () => {
  const { page } = load();
  for (const kind of ['market', 'holders']) {
    assert.strictEqual(page.ageState(kind, ago(30 * MIN), NOW), 'fresh');
    assert.strictEqual(page.ageState(kind, ago(31 * MIN), NOW), 'amber');
    assert.strictEqual(page.ageState(kind, ago(2 * HOUR), NOW), 'amber');
    assert.strictEqual(page.ageState(kind, ago(2 * HOUR + MIN), NOW), 'old');
  }
  assert.strictEqual(page.ageState('market', null, NOW), 'none');
  assert.strictEqual(page.ageState('market', 'not a date', NOW), 'none');
});

test('ages: the top-50 check goes amber after 14 hours and grey after 36', () => {
  const { page } = load();
  assert.strictEqual(page.ageState('top50', ago(14 * HOUR), NOW), 'fresh');
  assert.strictEqual(page.ageState('top50', ago(14 * HOUR + MIN), NOW), 'amber');
  assert.strictEqual(page.ageState('top50', ago(36 * HOUR + MIN), NOW), 'old');
});

test('age text is the largest unit, and a missing time is --', () => {
  const { page } = load();
  assert.strictEqual(page.ageText(ago(20 * 1000), NOW), '<1m');
  assert.strictEqual(page.ageText(ago(59 * MIN), NOW), '59m');
  assert.strictEqual(page.ageText(ago(47 * HOUR), NOW), '47h');
  assert.strictEqual(page.ageText(ago(49 * HOUR), NOW), '2d');
  assert.strictEqual(page.ageText(null, NOW), '--');
  // A server clock a little ahead of the browser is "now", not a negative age
  assert.strictEqual(page.ageText(new Date(NOW + 5000).toISOString(), NOW), '<1m');
});

test('the phone dot shows the oldest data; a token with no top-50 check yet is not "old" for it', () => {
  const { page } = load();
  assert.strictEqual(page.worstState(tok(), NOW), 'fresh');
  assert.strictEqual(page.worstState(tok({ at: { market: ago(4 * MIN), holders: ago(45 * MIN), top50: ago(HOUR) } }), NOW), 'amber');
  assert.strictEqual(page.worstState(tok({ at: { market: ago(3 * HOUR), holders: ago(MIN), top50: ago(HOUR) } }), NOW), 'old');
  assert.strictEqual(page.worstState(tok({ at: { market: ago(MIN), holders: ago(MIN), top50: null } }), NOW), 'fresh');
  assert.strictEqual(page.worstState(tok({ at: { market: null, holders: ago(MIN), top50: null } }), NOW), 'old');
});

test('rugged tokens are hidden until "show rugged"', () => {
  const { page } = load();
  const rows = [tok({ mint: 'A' }), tok({ mint: 'B', rugged: true })];
  assert.deepStrictEqual(page.view(rows, {}).map(t => t.mint), ['A']);
  assert.deepStrictEqual(page.view(rows, { showRugged: true }).map(t => t.mint), ['A', 'B']);
  assert.strictEqual(page.showRugged, false, 'off by default');
});

test('filters: holders checked, launchpad, and search by name, ticker or mint', () => {
  const { page } = load();
  const rows = [
    tok({ mint: 'AAAmint', name: 'Quiet Ones', symbol: 'QUIET' }),
    tok({ mint: 'BBBmint', name: 'Loud', symbol: 'LOUD', launchpad: 'Bags', scoreState: 'holders_pending' }),
    tok({ mint: 'CCCmint', name: null, symbol: null, scoreState: 'holders_stale' }),
  ];
  const mints = opts => page.view(rows, opts).map(t => t.mint);
  assert.deepStrictEqual(mints({ checkedOnly: true }), ['AAAmint', 'CCCmint']);
  assert.deepStrictEqual(mints({ launchpad: 'Bags' }), ['BBBmint']);
  assert.deepStrictEqual(mints({ query: ' quiet ' }), ['AAAmint']);
  assert.deepStrictEqual(mints({ query: 'loud' }), ['BBBmint']);
  assert.deepStrictEqual(mints({ query: 'cccM' }), ['CCCmint']);
  assert.deepStrictEqual(mints({ query: 'nothing' }), []);
});

test('sorts put the largest first, missing values last, and keep the server order on ties', () => {
  const { page } = load();
  const rows = [
    tok({ mint: 'A', score: 60, marketCap: 10, holders: 5, holdersChange24h: null, graduatedAt: ago(50 * HOUR) }),
    tok({ mint: 'B', score: 60, marketCap: null, holders: 50, holdersChange24h: -4, graduatedAt: ago(2 * HOUR) }),
    tok({ mint: 'C', score: 90, marketCap: 30, holders: 20, holdersChange24h: 12, graduatedAt: ago(9 * HOUR) }),
  ];
  const order = sort => page.view(rows, { sort }).map(t => t.mint).join('');
  assert.strictEqual(order('score'), 'CAB');
  assert.strictEqual(order('newest'), 'BCA');
  assert.strictEqual(order('mcap'), 'CAB');
  assert.strictEqual(order('holders'), 'BCA');
  assert.strictEqual(order('growth'), 'CBA');
  assert.strictEqual(order('no-such-sort'), 'CAB');
});

test('creator-written text is escaped in the row and the breakdown', () => {
  const { page } = load();
  const evil = '<img src=x onerror=alert(1)>';
  const token = tok({ name: evil, symbol: '"><script>', launchpad: evil, logo: 'javascript:alert(1)', mint: 'M"x' });
  const row = page.rowHtml(token, 1, NOW);
  assert.ok(!row.includes('<img src=x'), 'name and launchpad are text');
  assert.ok(!row.includes('<script>'));
  assert.ok(!row.includes('javascript:'), 'a logo that is not an https URL falls back to the default');
  assert.ok(row.includes('data-mint="M&quot;x"'));
  const tip = page.tipHtml(token, WEIGHTS, NOW);
  assert.ok(!tip.includes('<script>'));
});

test('a curated row opens the full page, any other row the lite page', () => {
  const { page } = load();
  assert.ok(page.rowHtml(tok({ curated: true }), 1, NOW).includes('data-curated="1"'));
  assert.ok(!page.rowHtml(tok(), 1, NOW).includes('data-curated'));
  assert.ok(page.rowHtml(tok({ curated: true, emergingCult: true }), 1, NOW).includes('title="Emerging Cult"'));
  assert.strictEqual(page.rowHtml(tok({ mint: '' }), 1, NOW), '');
});

test('the score cell says when holders are pending or stale', () => {
  const { page } = load();
  assert.ok(page.scoreCell(tok({ scoreState: 'holders_pending' })).includes('holders pending'));
  assert.ok(page.scoreCell(tok({ scoreState: 'holders_pending' })).includes('np-score--pending'));
  assert.ok(page.scoreCell(tok({ scoreState: 'holders_stale' })).includes('holders stale'));
  assert.ok(!page.scoreCell(tok()).includes('np-score-note'));
  assert.ok(!page.scoreCell(tok({ score: null })).includes('np-score'), 'no score, no button');
});

test('the breakdown reproduces the score: 100 x quality x confidence x risk', () => {
  const { page } = load();
  const token = tok({
    score: 47.7, confidence: 0.8, risk: 0.8,
    terms: { growth: 0.9, steady: 0.7, base: 0.5, breadth: 0.6, retention: 0.91, spread: 0.7, dev: 1, activity: 0.8, trend: 0.5, pressure: 0.4 },
    riskParts: { wash: 1, sybil: 1, whale: 1, bundle: 0.8, rug: 1 },
  });
  const b = page.breakdown(token, WEIGHTS);
  assert.strictEqual(b.lines.length, 10);
  assert.strictEqual(b.missing.length, 0);
  assert.ok(Math.abs(b.available - 100) < 1e-9);
  const retention = b.lines.find(l => l.key === 'retention');
  assert.ok(Math.abs(retention.points - 13.65) < 1e-9, 'Retention 0.91 x 15 = 13.65');
  assert.ok(Math.abs(100 * b.quality * b.confidence * b.risk - 47.7) < 0.05);
  assert.deepStrictEqual([...b.reasons.map(r => r.key)], ['bundle']);
  const tip = page.tipHtml(token, WEIGHTS, NOW);
  assert.ok(tip.includes('equal-size bags'));
  assert.ok(tip.includes('13.7'));
});

test('the breakdown names the terms waiting for a top-50 check and divides by what has data', () => {
  const { page } = load();
  const token = tok({ scoreState: 'holders_pending', confidence: 1, risk: 1, terms: { growth: 1, steady: 1, base: 1, breadth: 1, activity: 1, trend: 1, pressure: 1 }, at: { market: ago(MIN), holders: ago(MIN), top50: null } });
  const b = page.breakdown(token, WEIGHTS);
  assert.deepStrictEqual([...b.missing.map(m => m.key)], ['retention', 'spread', 'dev']);
  assert.strictEqual(b.waitingTop50, true);
  assert.ok(Math.abs(b.available - 65) < 1e-9);
  assert.ok(Math.abs(b.quality - 1) < 1e-9);
  const tip = page.tipHtml(token, WEIGHTS, NOW);
  assert.ok(tip.includes('waiting for a top-50 holder check'));
  assert.ok(tip.includes('not checked yet'));
  // Without weights (an older API) the terms still show, with no points
  assert.strictEqual(page.breakdown(token, undefined).quality, null);
});

test('holder change maps onto the shared velocity arrows', () => {
  const { page } = load();
  assert.deepStrictEqual([25, 10, 9.9, 1, 0.5, -0.9, -1, -10, null, NaN].map(v => page.velocityLevel(v)), [2, 2, 1, 1, 0, 0, -1, -2, null, null]);
  assert.ok(page.holdersCell(tok({ holdersChange24h: null })).includes('Not enough holder history'));
  assert.ok(page.holdersCell(tok({ holdersChange24h: 12.34 })).includes('+12.3%'));
});

test('launchpad filter options are the labels in the data, most common first', () => {
  const { page } = load();
  const rows = [tok({ launchpad: 'Bags' }), tok({ launchpad: 'Pump.fun' }), tok({ launchpad: 'Pump.fun' }), tok({ launchpad: null })];
  assert.deepStrictEqual([...page.launchpads(rows)], ['Pump.fun', 'Bags']);
});

test('the summary line gives the window, the floors, the rugged count and the scoring age', () => {
  const { page } = load();
  const text = page.metaText({ window: '14d', total: 400, shown: 300, rugged: 12, floors: { marketCap: 50000, liquidity: 10000 }, scoredAt: ago(5 * MIN) }, 288, NOW);
  assert.strictEqual(text, '288 of 400 tokens bonded in the last 14 days · above $50000 market cap and $10000 liquidity · best 300 loaded · 12 rugged · scored 5m ago');
  assert.ok(page.metaText({ window: '7d', total: 0, shown: 0, rugged: 0 }, 0, NOW).endsWith('not scored yet'));
});

test('probe: the tab is offered only when the API returned a list, and asks once', async () => {
  const off = load(async () => { const e = new Error('off'); e.status = 404; e.code = 'NEWPAIRS_DISABLED'; throw e; });
  assert.strictEqual(await off.page.probe(), false);
  const on = load(async () => ({ window: '7d', tokens: [] }));
  assert.strictEqual(await on.page.probe(), true);
  await on.page.probe();
  assert.deepStrictEqual(on.calls, ['7d']);
  const odd = load(async () => ({ error: 'unexpected' }));
  assert.strictEqual(await odd.page.probe(), false);
});
