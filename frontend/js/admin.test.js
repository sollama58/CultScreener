/**
 * Admin panel regressions (run with: node --test frontend/js/admin.test.js).
 * - esc() must escape quotes: its output goes inside title="..." / data-*="..." attributes.
 * - A degraded API answers /health/detailed with 503 and the full report; show it.
 * - verifySession() keeps the stored token on non-401 failures (cold start, 5xx, network).
 * - "Refresh SOL/BTC Prices" must not report success when the server sent stale data.
 * - After re-login, the tab still on screen is reloaded, not only the dashboard.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, 'admin.js'), 'utf8');

function load({ fetchImpl, token = null } = {}) {
  const els = new Map();
  const el = (id) => {
    if (!els.has(id)) els.set(id, { id, style: {}, textContent: '', innerHTML: '', value: '', dataset: {}, disabled: false, addEventListener() {}, focus() {}, classList: { add() {}, remove() {} } });
    return els.get(id);
  };
  const store = () => {
    const m = new Map();
    return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) };
  };
  const toasts = [];
  const ctx = {
    console,
    setTimeout: () => 0,
    document: { readyState: 'complete', getElementById: el, querySelectorAll: () => [], querySelector: () => null, addEventListener() {} },
    window: { addEventListener() {} },
    sessionStorage: store(),
    confirm: () => true,
    config: { api: { baseUrl: 'http://x' } },
    fetch: fetchImpl || (async () => ({ ok: true, status: 200, json: async () => ({}) })),
    toast: {
      error: m => toasts.push(['error', m]),
      success: m => toasts.push(['success', m]),
      warning: m => toasts.push(['warning', m])
    }
  };
  vm.createContext(ctx);
  vm.runInContext(SRC + '\nthis.admin = admin;', ctx);
  if (token) { ctx.admin.token = token; ctx.sessionStorage.setItem('admin_token', token); }
  return { admin: ctx.admin, el, toasts, ctx };
}

const respond = (status, body) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test('esc() escapes double and single quotes as well as markup', () => {
  const { admin } = load();
  assert.strictEqual(admin.esc('x" style="position:fixed" x=\''), 'x&quot; style=&quot;position:fixed&quot; x=&#39;');
  assert.strictEqual(admin.esc('<b>&</b>'), '&lt;b&gt;&amp;&lt;/b&gt;');
  assert.strictEqual(admin.esc(null), '');
  assert.strictEqual(admin.esc(0), '0');
});

test('Health tab renders the report from a 503 (degraded) response', async () => {
  const body = { status: 'degraded', checks: { database: { status: 'ok', healthy: true, poolSize: 4, idleConnections: 3, waitingRequests: 0 } } };
  const { admin, el } = load({ fetchImpl: respond(503, body) });
  await admin.loadHealth();
  const html = el('health-grid').innerHTML;
  assert.ok(!html.includes('Error'), html);
  assert.ok(html.includes('degraded'));
  assert.ok(html.includes('Pool: 4 open, 3 idle'));
});

test('Other request failures still throw', async () => {
  const { admin } = load({ fetchImpl: respond(500, { error: 'boom' }) });
  await assert.rejects(admin.request('/health/detailed', { acceptStatuses: [503] }), /boom/);
});

test('verifySession keeps the stored token when the API is unreachable', async () => {
  const { admin, ctx, el, toasts } = load({ token: 'T1', fetchImpl: respond(503, { error: 'Request timeout' }) });
  await admin.verifySession();
  assert.strictEqual(admin.token, 'T1');
  assert.strictEqual(ctx.sessionStorage.getItem('admin_token'), 'T1');
  assert.strictEqual(el('admin-panel').style.display, 'block');
  assert.strictEqual(toasts[0][0], 'error');
});

test('verifySession drops the token on 401', async () => {
  const { admin, ctx, el } = load({ token: 'T1', fetchImpl: respond(401, { error: 'Session expired' }) });
  await admin.verifySession();
  assert.strictEqual(admin.token, null);
  assert.strictEqual(ctx.sessionStorage.getItem('admin_token'), null);
  assert.strictEqual(el('login-section').style.display, 'flex');
});

test('Refresh SOL/BTC reports stale last-good data as a failure, not success', async () => {
  const body = { success: true, stale: true, data: { sol: { price: 150 }, btc: { price: 60000 }, updatedAt: Date.now() - 3600000 } };
  const { admin, el, toasts } = load({ fetchImpl: respond(200, body) });
  await admin.refreshBenchmarks();
  const status = el('admin-flush-status');
  assert.match(status.textContent, /NOT refreshed/);
  assert.notStrictEqual(status.style.color, 'var(--green)');
  assert.strictEqual(toasts[0][0], 'warning');
});

test('Refresh SOL/BTC reports a real refresh as success', async () => {
  const body = { success: true, data: { sol: { price: 150 }, btc: { price: 60000 }, updatedAt: Date.now() } };
  const { admin, el, toasts } = load({ fetchImpl: respond(200, body) });
  await admin.refreshBenchmarks();
  assert.match(el('admin-flush-status').textContent, /refreshed — SOL/);
  assert.strictEqual(toasts[0][0], 'success');
});

test('Login reloads the tab that is still active', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ token: 'T2' }), headers: { get: () => 'T2' } });
  const { admin, el } = load({ fetchImpl });
  el('login-password').value = 'pw';
  admin.activeTab = 'curated';
  const loaded = [];
  admin.loadTab = (name) => loaded.push(name);
  await admin.login();
  assert.deepStrictEqual(loaded, ['curated']);
});

// ── New Pairs tab ───────────────────────────────────────────────────────────

const NP_MINT = 'NpMint'.padEnd(44, '1');
const npPreview = (over = {}) => ({
  public: false,
  counts: { waiting: 4, belowFloor: 120, active: 3, hidden: 1, rugged: 1, unlisted: 0, holdersChecked: 2, scoredAt: new Date().toISOString(), marketAt: new Date().toISOString() },
  credits: { today: '2026-11-12', spentToday: 8200, cap: 10000, maxCap: 10000, left: 1800, days: [{ day: '2026-11-12', total: 8200, sources: { 'newpairs:holders': 7900, 'newpairs:discover': 300 } }] },
  detectors: [{ id: 'pumpfun', lastOkAt: new Date().toISOString(), cursorTime: new Date().toISOString(), lastSource: 'free', lastError: '<b>429</b>', found: 90, unhandled: 10, missRate: 0.1 }],
  settings: { minMcap: 25000, minLiquidity: 5000, shortlistSize: 50, dailyCredits: 10000, maxDailyCredits: 10000 },
  tokens: [{
    rank: 1, mint: NP_MINT, name: '<img src=x onerror=alert(1)>', symbol: '"><script>', launchpad: 'Pump.fun', graduatedAt: new Date().toISOString(),
    score: 71.5, quality: 0.72, confidence: 0.9, risk: 0.8, terms: { growth: 0.7 }, riskParts: { wash: 1, bundle: 0.8 }, scoreState: 'holders_pending',
    marketCap: 1200000, liquidity: 80000, holders: 2100, hidden: true, rugged: false, curated: false, unlistedReason: null,
  }],
  ...over,
});

test('New Pairs: the preview escapes creator-written text and shows credits, detectors and marks', async () => {
  const { admin, el } = load({ fetchImpl: respond(200, npPreview()) });
  await admin.loadNewPairs();
  const rows = el('np-body').innerHTML;
  assert.ok(!rows.includes('<img src=x') && !rows.includes('<script>'), 'token name and ticker are text');
  assert.ok(rows.includes('>hidden<') && rows.includes('holders pending'));
  assert.ok(rows.includes('data-np="hide"') && rows.includes('data-hidden="true"') && rows.includes('>Show<'));
  assert.ok(rows.includes('bundle ×0.80'), 'the risk cell says which factor fired');
  assert.ok(rows.includes('data-np="promote"'));
  const stats = el('np-stats').innerHTML;
  assert.ok(stats.includes('82% of 10,000') && stats.includes('1,800 left'));
  assert.ok(stats.includes('class="sub warn"'), '80% of the cap or more is flagged');
  assert.ok(stats.includes('NEWPAIRS_PUBLIC'));
  const detectors = el('np-detectors-body').innerHTML;
  assert.ok(detectors.includes('10.0%') && !detectors.includes('<b>429</b>'));
  assert.ok(el('np-credits-body').innerHTML.includes('7,900'));
  assert.strictEqual(el('np-set-credits').value, 10000);
});

test('New Pairs: a curated token has no Promote button, and an empty preview says why', async () => {
  const curated = npPreview();
  curated.tokens[0].curated = true;
  const a = load({ fetchImpl: respond(200, curated) });
  await a.admin.loadNewPairs();
  assert.ok(!a.el('np-body').innerHTML.includes('data-np="promote"'));
  const b = load({ fetchImpl: respond(200, npPreview({ tokens: [] })) });
  await b.admin.loadNewPairs();
  assert.ok(b.el('np-body').innerHTML.includes('No active New Pairs tokens yet'));
});

test('New Pairs: hide sends PATCH {hidden}, promote asks first and sends POST', async () => {
  const sent = [];
  const fetchImpl = async (url, opts) => { sent.push([opts.method, url.replace('http://x', ''), opts.body]); return { ok: true, status: 200, json: async () => npPreview() }; };
  const { admin, ctx } = load({ fetchImpl });
  await admin.setNewPairHidden(NP_MINT, true);
  assert.deepStrictEqual(sent[0], ['PATCH', `/api/admin/new-pairs/${NP_MINT}`, '{"hidden":true}']);
  sent.length = 0;
  ctx.confirm = () => false;
  await admin.promoteNewPair(NP_MINT, 'Token');
  assert.deepStrictEqual(sent, [], 'declining the confirm sends nothing');
  ctx.confirm = () => true;
  await admin.promoteNewPair(NP_MINT, 'Token');
  assert.deepStrictEqual(sent[0].slice(0, 2), ['POST', `/api/admin/new-pairs/${NP_MINT}/promote`]);
});

test('New Pairs: a refused setting shows the server reason and is not reported as saved', async () => {
  const { admin, el, toasts } = load({ fetchImpl: respond(400, { error: 'dailyCredits cannot be above 10000, the limit set by NEWPAIRS_HELIUS_DAILY_CREDITS' }) });
  for (const id of ['np-set-mcap', 'np-set-liq', 'np-set-shortlist']) el(id).value = '50';
  el('np-set-credits').value = '20000';
  await admin.saveNewPairsSettings();
  assert.match(el('np-settings-status').textContent, /Not saved: dailyCredits cannot be above 10000/);
  assert.strictEqual(toasts[0][0], 'error');
});
