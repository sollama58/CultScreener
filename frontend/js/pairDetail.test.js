/**
 * Lite page for New Pairs tokens (run with: node --test frontend/js/pairDetail.test.js).
 * The page makes one request and nothing else, a curated token goes to the full page, every
 * block carries an age, and creator-written text is escaped.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = f => fs.readFileSync(path.join(__dirname, f), 'utf8');
const SRC = read('newPairs.js') + '\nthis.newPairsPage = newPairsPage;\n' + read('pairDetail.js') + '\nthis.pairDetail = pairDetail;';
const HTML = fs.readFileSync(path.join(__dirname, '..', 'pair.html'), 'utf8');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const NOW = Date.parse('2026-11-12T12:00:00Z');
const ago = ms => new Date(NOW - ms).toISOString();
const MINT = 'So11111111111111111111111111111111111111112';
const WEIGHTS = { growth: 0.20, steady: 0.10, base: 0.05, breadth: 0.10, retention: 0.15, spread: 0.15, dev: 0.05, activity: 0.08, trend: 0.07, pressure: 0.05 };

function load({ token, search = `?mint=${MINT}` } = {}) {
  const calls = [];
  const els = {};
  const el = id => (els[id] = els[id] || { id, style: {}, dataset: {}, addEventListener() {}, textContent: '', innerHTML: '' });
  const location = { search, replaced: null, replace(u) { this.replaced = u; } };
  const ctx = {
    console, URLSearchParams, setInterval: () => 1,
    window: { location },
    document: { title: '', getElementById: el, querySelectorAll: () => [], addEventListener() {} },
    api: { newPairs: { async token(m) { calls.push(m); return token(m); } } },
    utils: {
      escapeHtml: s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
      formatNumber: (n, p) => (n == null ? '--' : `${p}${n}`),
      formatPrice: n => (n == null ? '--' : `$${n}`),
      proxyImageUrl: u => (/^https:\/\//.test(u || '') ? u : null),
      getDefaultLogo: () => 'data:image/svg+xml,default',
      truncateAddress: (a, s = 4, e = 4) => `${a.slice(0, s)}...${a.slice(-e)}`,
      isValidSolanaAddress: a => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a),
      copyToClipboard() {}, handleImageError() {},
    },
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  return { page: ctx.pairDetail, calls, els, location, ctx };
}

const payload = (over = {}) => ({
  curated: false, weights: WEIGHTS,
  token: {
    rank: 4, mint: MINT, name: 'Alpha', symbol: 'ALPHA', launchpad: 'Pump.fun', graduatedAt: ago(30 * HOUR), score: 61.2, scoreState: 'full',
    confidence: 0.8, risk: 1, terms: { growth: 0.9, retention: 0.91 }, riskParts: { wash: 1, sybil: 1, whale: 1, bundle: 1, rug: 1 },
    price: 0.001, priceChange24h: 4, marketCap: 1e6, liquidity: 5e4, volume24h: 2e5, holders: 1500, holdersChange24h: 8,
    top10Pct: 21, top50Pct: 44, devPct: 0.5, retention12h: 0.9, rugged: false,
    at: { market: ago(4 * MIN), holders: ago(50 * MIN), top50: ago(6 * HOUR), scored: ago(5 * MIN) }, ...over,
  },
  topHolders: {
    sampledAt: ago(6 * HOUR), previousSampledAt: ago(18 * HOUR), exited: ['Exit1111111111111111111111111111111111111111'],
    holders: [
      { rank: 1, wallet: 'Wa11et11111111111111111111111111111111111111', pct: 4.2, changePct: -3.5, isNew: false },
      { rank: 2, wallet: 'Wa11et22222222222222222222222222222222222222', pct: 2.1, changePct: null, isNew: true },
    ],
  },
  samples: [{ at: ago(6 * HOUR), holders: 1500, top10Pct: 21, top50Pct: 44, retention12h: 0.9, complete: true }, { at: ago(18 * HOUR), holders: 900, top10Pct: 25, top50Pct: 50, retention12h: null, complete: true }],
  series: [{ t: NOW - 3 * HOUR, holders: 1000, marketCap: 5e5 }, { t: NOW - 2 * HOUR, holders: 1200, marketCap: 8e5 }, { t: NOW - HOUR, holders: 1500, marketCap: 1e6 }],
});

test('the page loads only what the lite page needs: no wallet, chart, holder or token-detail script', () => {
  const scripts = [...HTML.matchAll(/<script src="js\/([\w.]+)\?v=\d+">/g)].map(m => m[1]);
  assert.deepStrictEqual(scripts, ['config.js', 'api.js', 'newPairs.js', 'pairDetail.js', 'pwa.js']);
  assert.ok(!/connect-wallet/.test(HTML), 'no wallet button');
  assert.ok(/<meta name="robots" content="noindex">/.test(HTML));
});

test('the only API the page code names is /api/new-pairs, through api.newPairs.token', () => {
  const src = read('pairDetail.js');
  assert.deepStrictEqual([...new Set([...src.matchAll(/\bapi\.[\w.]+/g)].map(m => m[0]))], ['api.newPairs.token']);
  assert.ok(!/fetch\(|XMLHttpRequest|\/api\/tokens/.test(src.replace(/^\s*\/\/.*$/gm, '')));
});

test('init makes one request and draws the page', async () => {
  const { page, calls, els } = load({ token: async () => payload() });
  await page.init();
  assert.deepStrictEqual(calls, [MINT]);
  assert.strictEqual(els['pair-content'].style.display, '');
  assert.strictEqual(els['pair-loading'].style.display, 'none');
  assert.ok(els['pair-content'].innerHTML.includes('How the score is built'));
});

test('a curated token is sent to the full page', async () => {
  const { page, location, els } = load({ token: async () => ({ curated: true, mint: MINT }) });
  await page.init();
  assert.strictEqual(location.replaced, `token.html?mint=${MINT}`);
  assert.strictEqual(els['pair-content'], undefined, 'nothing is drawn before the redirect');
});

test('not listed, switched off, a bad link and a failed request each get their own message, with no retry storm', async () => {
  const err = (code) => async () => { const e = new Error(code); e.code = code; throw e; };
  for (const [token, title] of [[err('NOT_LISTED'), 'Not in New Pairs'], [err('NEWPAIRS_DISABLED'), 'Not available yet'], [err('TIMEOUT'), 'Could not load this token']]) {
    const { page, calls, els } = load({ token });
    await page.init();
    assert.strictEqual(els['pair-error-title'].textContent, title);
    assert.strictEqual(els['pair-error'].style.display, '');
    assert.strictEqual(calls.length, 1);
  }
  const bad = load({ token: async () => payload(), search: '?mint=<script>' });
  await bad.page.init();
  assert.strictEqual(bad.calls.length, 0, 'an invalid mint is not sent to the API');
  assert.strictEqual(bad.els['pair-error-title'].textContent, 'Token not found');
});

test('every block carries an age, coloured by the limits the tab uses', () => {
  const { page } = load();
  const html = page.pageHtml(payload(), NOW);
  const ages = [...html.matchAll(/class="pd-age pd-age--(\w+)" data-kind="(\w+)"[^>]*>([^<]+)</g)].map(m => `${m[2]}:${m[1]}:${m[3]}`);
  assert.deepStrictEqual(ages, [
    'market:fresh:Read 4m ago',                                   // price
    'market:fresh:Read 4m ago', 'market:fresh:Read 4m ago', 'market:fresh:Read 4m ago', // market cap, volume, liquidity
    'holders:amber:Read 50m ago',                                 // holder count
    'market:fresh:Scored 5m ago',
    'reading:fresh:Last reading 1h ago', 'reading:fresh:Last reading 1h ago',
    'top50:fresh:Checked 6h ago',
  ]);
  assert.ok(page.age('top50', null, NOW, 'Checked').includes('Not read yet'));
  assert.ok(page.age('top50', ago(40 * HOUR), NOW, 'Checked').includes('pd-age--old'));
});

test('creator-written text is escaped everywhere it is shown', () => {
  const { page } = load();
  const evil = '<img src=x onerror=alert(1)>';
  const html = page.pageHtml(payload({ name: evil, symbol: evil, launchpad: evil, logo: 'javascript:alert(1)' }), NOW);
  assert.ok(!html.includes('<img src=x'));
  assert.ok(!html.includes('javascript:'));
});

test('holders: share, change since the check before, new and exited wallets', () => {
  const { page } = load();
  const p = payload();
  const html = page.holdersHtml(p.token, p.topHolders, p.samples, NOW);
  assert.ok(html.includes('4.20%') && html.includes('-3.5%'));
  assert.ok(html.includes('class="pd-new"'));
  assert.ok(html.includes('Exit...1111'));
  assert.ok(html.includes('Changes are since the check before, 18h ago.'));
  assert.ok(html.includes('Earlier checks'));
  const first = page.holdersHtml(p.token, { ...p.topHolders, previousSampledAt: null, exited: [] }, p.samples.slice(0, 1), NOW);
  assert.ok(first.includes('first check') && !first.includes('Earlier checks') && !first.includes('Left the top holders'));
  const none = page.holdersHtml(p.token, { sampledAt: null, holders: [] }, [], NOW);
  assert.ok(none.includes('have not been checked yet') && none.includes('Not read yet'));
});

test('the score block names what is waiting for a holder check', () => {
  const { page } = load();
  const p = payload({ scoreState: 'holders_pending', terms: { growth: 0.9 } });
  const html = page.scoreHtml(p.token, WEIGHTS, NOW);
  assert.ok(html.includes('Top 50 holders not checked yet'));
  assert.strictEqual((html.match(/waiting for a top-50 holder check/g) || []).length, 3);
  assert.ok(html.includes('#4 among tokens bonded in the last 14 days'));
});

test('line: scales readings into the box, skips gaps, and refuses to draw fewer than two', () => {
  const { page } = load();
  const l = page.line([{ t: 0, v: 10 }, { t: 5, v: null }, { t: 10, v: 20 }], 100, 50, 0);
  assert.strictEqual(l.d, 'M0.0 50.0 L100.0 0.0');
  assert.strictEqual(l.count, 2);
  assert.strictEqual(page.line([{ t: 0, v: 5 }], 100, 50), null);
  assert.strictEqual(page.line(null), null);
  assert.strictEqual(page.line([{ t: 0, v: 7 }, { t: 10, v: 7 }], 100, 50, 0).d, 'M0.0 25.0 L100.0 25.0', 'a flat series sits mid-height');
  assert.ok(page.chart('Holders', [], String, NOW).includes('Not enough readings yet'));
});
