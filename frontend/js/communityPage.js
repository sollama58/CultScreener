/* global api, utils, wallet, watchlist */

const communityPage = {
  // Bumped on every loadMyWatchlist call so a slower, older call cannot re-render.
  _wlGen: 0,

  init() {
    // Bind connect wallet button (replaces inline onclick for CSP compliance)
    const connectBtn = document.getElementById('watchlist-connect-btn');
    if (connectBtn) connectBtn.addEventListener('click', () => { if (typeof wallet !== 'undefined') wallet.connect(); });

    this.loadMyWatchlist();
    this.loadWatchlistLeaderboard();

    // On walletConnected the wallet's own list comes from watchlist.js (watchlistReady);
    // this call only shows the loading state, it does not fetch.
    window.addEventListener('walletConnected', () => this.loadMyWatchlist());
    window.addEventListener('walletDisconnected', () => this.loadMyWatchlist());
    // Fires when a phone paired over Mobile Connect confirms which wallet it belongs to.
    window.addEventListener('walletLinked', () => this.loadMyWatchlist());
    window.addEventListener('watchlistReady', () => this.loadMyWatchlist());
  },

  // ── Personal Watchlist ────────────────────────

  async loadMyWatchlist() {
    const connectEl = document.getElementById('my-watchlist-connect');
    const contentEl = document.getElementById('my-watchlist-content');
    const tbody = document.getElementById('my-watchlist-body');
    if (!connectEl || !contentEl || !tbody) return;

    // viewerAddress rather than address: a phone linked from a desktop has no wallet of its own
    // but is entitled to see this wallet's watchlist. Reading is all this does.
    const gen = ++this._wlGen;
    const viewer = typeof wallet !== 'undefined' ? wallet.viewerAddress?.() : null;
    if (!viewer) {
      connectEl.style.display = '';
      contentEl.style.display = 'none';
      return;
    }

    connectEl.style.display = 'none';
    contentEl.style.display = '';
    tbody.innerHTML = '<tr><td colspan="5"><div class="loading-state"><div class="loading-spinner"></div><span>Loading your watchlist...</span></div></td></tr>';

    try {
      // A connected wallet's list is already loaded by watchlist.js: reuse it instead of a
      // second GET. Only a linked phone (no wallet of its own) or a failed load asks the API.
      const ownWallet = typeof watchlist !== 'undefined' && wallet.connected && viewer === wallet.address;
      let tokens;
      if (ownWallet && (watchlist.isLoading || !watchlist.isLoaded)) {
        // watchlistReady re-runs this on success; on failure isLoading clears without an
        // event, so check back until it settles.
        if (!watchlist.isLoading) watchlist.init();
        const waitForLoad = () => {
          if (gen !== this._wlGen) return;
          if (watchlist.isLoading) { setTimeout(waitForLoad, 300); return; }
          this.loadMyWatchlist();
        };
        setTimeout(waitForLoad, 300);
        return;
      }
      if (ownWallet && !watchlist._loadFailed) {
        tokens = [...watchlist.items.values()];
      } else {
        const data = await api.watchlist.get(viewer);
        if (gen !== this._wlGen) return;
        tokens = data?.tokens || [];
      }

      if (tokens.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5"><div class="empty-state" style="padding:1.5rem;">Your watchlist is empty. Visit token pages and click the star to add tokens.</div></td></tr>';
        return;
      }

      let enriched = {};
      try {
        const mints = tokens.map(t => t.mint);
        const batchData = await api.tokens.getBatch(mints);
        if (Array.isArray(batchData)) {
          batchData.forEach(t => { if (t) enriched[t.address || t.mintAddress] = t; });
        }
      } catch (_) {}
      if (gen !== this._wlGen) return;

      const defaultLogo = utils.getDefaultLogo();
      // Removing needs the wallet itself (a signed request); a linked phone can only read,
      // so it gets no Remove button rather than one that silently does nothing.
      const canEdit = !!(wallet.connected && wallet.address === viewer);
      tbody.innerHTML = tokens.map((token, i) => {
        const mint = token.mint || '';
        const d = enriched[mint] || {};
        const name = utils.escapeHtml(d.name || token.name || mint.slice(0, 8));
        const symbol = utils.escapeHtml(d.symbol || token.symbol || '');
        const logo = utils.escapeHtml(utils.proxyImageUrl(d.logoUri || d.logoURI || token.logoUri) || defaultLogo);
        const price = utils.formatPrice(d.price, 6);
        const mcap = utils.formatNumber(d.marketCap, '$');

        return `
          <tr class="token-row" style="cursor:pointer" data-mint="${utils.escapeHtml(mint)}">
            <td class="cell-rank">${i + 1}</td>
            <td class="cell-token">
              <div class="token-cell">
                <img class="token-logo" src="${logo}" alt="${symbol}" loading="lazy" data-fallback="${defaultLogo}">
                <div class="token-info">
                  <span class="token-name">${name}</span>
                  <span class="token-symbol-cell">${symbol}</span>
                </div>
              </div>
            </td>
            <td class="cell-price mono-num">${price}</td>
            <td class="cell-mcap mono-num">${mcap}</td>
            <td class="text-right">${canEdit ? `<button class="action-btn danger" data-remove-wl="${utils.escapeHtml(mint)}">Remove</button>` : ''}</td>
          </tr>`;
      }).join('');

      this.bindRowClicks(tbody);
      utils.bindImageFallbacks(tbody);
      this.markKing(tbody);

      tbody.querySelectorAll('[data-remove-wl]').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const mint = btn.dataset.removeWl;
          btn.disabled = true;
          btn.textContent = '...';
          const removed = await watchlist.remove(mint);
          if (!removed) {
            btn.disabled = false;
            btn.textContent = 'Remove';
            return;
          }
          // Drop just this row and renumber, instead of reloading the whole list
          btn.closest('tr')?.remove();
          const rows = tbody.querySelectorAll('.token-row[data-mint]');
          if (rows.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5"><div class="empty-state" style="padding:1.5rem;">Your watchlist is empty. Visit token pages and click the star to add tokens.</div></td></tr>';
          } else {
            rows.forEach((row, i) => { const rank = row.querySelector('.cell-rank'); if (rank) rank.textContent = i + 1; });
          }
        });
      });
    } catch (err) {
      console.error('My watchlist error:', err.message);
      tbody.innerHTML = '<tr><td colspan="5"><div class="empty-state">Failed to load watchlist</div></td></tr>';
    }
  },

  // ── Global Watchlist Leaderboard ──────────────

  async loadWatchlistLeaderboard() {
    const tbody = document.getElementById('watchlist-leaderboard-body');
    if (!tbody) return;

    tbody.innerHTML = '<tr><td colspan="5"><div class="loading-state"><div class="loading-spinner"></div><span>Loading...</span></div></td></tr>';

    try {
      const result = await api.tokens.leaderboardWatchlist({ limit: 50 });
      const tokens = result.tokens || result || [];

      if (tokens.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5"><div class="empty-state">No watchlisted tokens yet</div></td></tr>';
        return;
      }

      const defaultLogo = utils.getDefaultLogo();
      tbody.innerHTML = tokens.map((token, i) => {
        const address = token.mintAddress || token.address || token.mint_address || '';
        const safeLogo = utils.escapeHtml(utils.proxyImageUrl(token.logoUri || token.logo_uri) || defaultLogo);
        const safeName = utils.escapeHtml(token.name || address.slice(0, 8));
        const safeSymbol = utils.escapeHtml(token.symbol || '');
        const price = utils.formatPrice(token.price, 6);
        const mcap = utils.formatNumber(token.marketCap || token.market_cap, '$');
        const count = token.watchlistCount || token.watchlist_count || 0;

        return `
          <tr class="token-row" style="cursor:pointer" data-mint="${utils.escapeHtml(address)}">
            <td class="cell-rank">${i + 1}</td>
            <td class="cell-token">
              <div class="token-cell">
                <img class="token-logo" src="${safeLogo}" alt="${safeSymbol}" loading="lazy" data-fallback="${defaultLogo}">
                <div class="token-info">
                  <span class="token-name">${safeName}</span>
                  <span class="token-symbol-cell">${safeSymbol}</span>
                </div>
              </div>
            </td>
            <td class="cell-price mono-num">${price}</td>
            <td class="cell-mcap mono-num">${mcap}</td>
            <td class="mono-num text-right">${count}</td>
          </tr>`;
      }).join('');

      this.bindRowClicks(tbody);
      utils.bindImageFallbacks(tbody);
      this.markKing(tbody);
    } catch (err) {
      console.error('Watchlist leaderboard error:', err.message);
      tbody.innerHTML = '<tr><td colspan="5"><div class="empty-state">Failed to load leaderboard</div></td></tr>';
    }
  },

  // King of the Pill chip after the King's name (same request the home page shares)
  markKing(tbody) {
    if (typeof api === 'undefined' || !api.kingOfPill) return;
    api.kingOfPill().then(king => {
      if (!king) return;
      tbody.querySelectorAll('.token-row[data-mint] .token-name').forEach(name => {
        const row = name.closest('.token-row');
        if (row.dataset.mint === king.mintAddress && !name.querySelector('.tt-king')) {
          name.insertAdjacentHTML('beforeend', ' <span class="tt-tag tt-king" title="King of the Pill">💊</span>');
        }
      });
    });
  },

  bindRowClicks(tbody) {
    tbody.querySelectorAll('.token-row[data-mint]').forEach(row => {
      row.addEventListener('click', () => {
        const mint = row.dataset.mint;
        if (mint) window.location.href = `token.html?mint=${encodeURIComponent(mint)}`;
      });
    });
  }
};

document.addEventListener('DOMContentLoaded', () => communityPage.init());
