/**
 * My Watchlist on community.html (run with: node --test frontend/js/communityPage.test.js).
 * A phone linked over Mobile Connect can read the wallet's watchlist but cannot edit it
 * (watchlist.remove needs a connected wallet), so it must not get Remove buttons.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, 'communityPage.js'), 'utf8');

function render(walletState) {
  const els = {};
  const el = id => (els[id] = els[id] || { style: {}, innerHTML: '', querySelectorAll: () => [] });
  const ctx = {
    console,
    document: { getElementById: el, addEventListener() {} },
    window: { addEventListener() {} },
    wallet: { ...walletState, viewerAddress() { return this.address || this.linkedAddress || null; } },
    // A connected wallet's list comes from watchlist.js's cache (already loaded here)
    watchlist: {
      remove: async () => false, isLoaded: true, isLoading: false, _loadFailed: false,
      items: new Map([['M1', { mint: 'M1', name: 'One', symbol: 'ONE' }]])
    },
    api: { watchlist: { get: async () => ({ tokens: [{ mint: 'M1', name: 'One', symbol: 'ONE' }] }) }, tokens: { getBatch: async () => [] } },
    utils: {
      escapeHtml: s => String(s), proxyImageUrl: u => u, getDefaultLogo: () => 'x.svg',
      formatPrice: () => '-', formatNumber: () => '-', bindImageFallbacks() {}
    }
  };
  vm.createContext(ctx);
  vm.runInContext(SRC + '\nthis.communityPage = communityPage;', ctx);
  ctx.communityPage.markKing = () => {};
  return ctx.communityPage.loadMyWatchlist().then(() => els);
}

test('a linked phone sees its watchlist without Remove buttons', async () => {
  const els = await render({ connected: false, address: null, linkedAddress: 'W1' });
  const html = Object.values(els).map(e => e.innerHTML).join('');
  assert.match(html, /One/);
  assert.doesNotMatch(html, /data-remove-wl/);
});

test('a connected wallet gets Remove buttons', async () => {
  const els = await render({ connected: true, address: 'W1', linkedAddress: null });
  const html = Object.values(els).map(e => e.innerHTML).join('');
  assert.match(html, /data-remove-wl="M1"/);
});
