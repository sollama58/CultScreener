/**
 * API Keys page regressions (run with: node --test frontend/js/apiKeys.test.js).
 * - Notices go through the global `toast` from api.js; `api.toast` does not exist.
 * - A wallet whose key was made in another browser gets 409 on Generate; the page must
 *   switch to the existing-key state so Rotate/Revoke are reachable.
 * - A cached key that no longer exists on the server (404 on Rotate/Revoke) drops back to "no key".
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, 'apiKeys.js'), 'utf8');

function load({ requestError, blockSession = false }) {
  const els = new Map();
  const el = (id) => {
    if (!els.has(id)) els.set(id, { id, style: {}, textContent: '', value: '', dataset: {}, addEventListener() {}, classList: { add() {}, remove() {} } });
    return els.get(id);
  };
  const store = () => {
    const m = new Map();
    return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) };
  };
  const toasts = [];
  const ctx = {
    console,
    document: { readyState: 'complete', getElementById: el, querySelectorAll: () => [], querySelector: () => null, addEventListener() {} },
    window: { addEventListener() {} },
    localStorage: store(),
    sessionStorage: blockSession
      ? { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('SecurityError'); }, removeItem() { throw new Error('SecurityError'); } }
      : store(),
    confirm: () => true,
    config: { api: { baseUrl: 'http://x' } },
    wallet: { connected: true, address: 'W1', signMessage: async () => ({ signature: [1] }) },
    api: { request: async () => { throw requestError; } },
    toast: { error: m => toasts.push(['error', m]), success: m => toasts.push(['success', m]), info: m => toasts.push(['info', m]) }
  };
  vm.createContext(ctx);
  vm.runInContext(SRC + '\nthis.apiKeysPage = apiKeysPage;', ctx);
  return { page: ctx.apiKeysPage, el, toasts, ctx };
}

function httpError(status, code, message) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}

test('Generate on a wallet that already has a key shows the existing-key state', async () => {
  const { page, el, toasts } = load({ requestError: httpError(409, 'KEY_CREATE_FAILED', 'Failed to create API key') });
  assert.strictEqual(el('no-key').style.display, 'block');
  await page.generateKey();
  assert.strictEqual(el('existing-key').style.display, 'block');
  assert.strictEqual(el('no-key').style.display, 'none');
  assert.strictEqual(toasts[0][0], 'info');
});

test('Generate errors other than 409 are shown as an error notice', async () => {
  const { page, toasts } = load({ requestError: httpError(400, 'SIGNATURE_EXPIRED', 'Signature expired') });
  await page.generateKey();
  assert.deepStrictEqual(toasts, [['error', 'Signature expired']]);
});

test('Rotate of a key that no longer exists drops back to "no key"', async () => {
  const { page, el, toasts, ctx } = load({ requestError: httpError(404, 'NOT_FOUND', 'Not found') });
  page.saveKeyMeta({ prefix: 'cult_x', is_active: true });
  page.showExistingKey(page.keyMeta);
  await page.rotateKey();
  assert.strictEqual(el('no-key').style.display, 'block');
  assert.strictEqual(el('existing-key').style.display, 'none');
  assert.strictEqual(ctx.localStorage.getItem('cultApiKeyMeta_W1'), null);
  assert.strictEqual(toasts[0][0], 'info');
});

test('Validation messages use the global toast', () => {
  const { page, toasts } = load({ requestError: new Error('unused') });
  page.currentKey = null;
  assert.strictEqual(page._getTesterKey(), null);
  assert.strictEqual(toasts[0][0], 'error');
});

test('Refresh details loads the key from the server (POST /api/keys/me)', async () => {
  const { page, el, ctx } = load({ requestError: new Error('unused') });
  const calls = [];
  ctx.api.request = async (endpoint, opts) => {
    calls.push([endpoint, opts.method]);
    return { found: true, prefix: 'cult_abc', created_at: '2026-01-02T00:00:00Z', last_used_at: '2026-02-03T00:00:00Z', request_count: 42, is_active: true };
  };
  page.saveKeyMeta({ prefix: null, created_at: null, is_active: true, request_count: null, last_used_at: null, unknown: true });
  await page.refreshKeyMeta();
  assert.deepStrictEqual(calls, [['/api/keys/me', 'POST']]);
  assert.strictEqual(el('existing-key').style.display, 'block');
  assert.strictEqual(el('key-prefix').textContent, 'cult_abc');
  assert.strictEqual(el('key-requests').textContent, (42).toLocaleString());
  assert.strictEqual(JSON.parse(ctx.localStorage.getItem('cultApiKeyMeta_W1')).request_count, 42);
});

test('Refresh details of a wallet with no key drops back to "no key"', async () => {
  const { page, el, ctx } = load({ requestError: new Error('unused') });
  ctx.api.request = async () => ({ found: false });
  page.saveKeyMeta({ prefix: 'cult_x', is_active: true });
  await page.refreshKeyMeta();
  assert.strictEqual(el('no-key').style.display, 'block');
  assert.strictEqual(ctx.localStorage.getItem('cultApiKeyMeta_W1'), null);
});

test('Blocked session storage does not stop the page from loading', () => {
  const { page } = load({ requestError: new Error('unused'), blockSession: true });
  assert.ok(page);
});
