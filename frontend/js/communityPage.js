/* global api, utils, wallet, watchlist */

const communityPage = {
  init() {
    // Bind connect wallet button (replaces inline onclick for CSP compliance)
    const connectBtn = document.getElementById('watchlist-connect-btn');
    if (connectBtn) connectBtn.addEventListener('click', () => { if (typeof wallet !== 'undefined') wallet.connect(); });

    this.loadMyWatchlist();
    this.loadWatchlistLeaderboard();

    window.addEventListener('walletConnected', () => this.loadMyWatchlist());
    window.addEventListener('walletDisconnected', () => this.loadMyWatchlist());
    window.addEventListener('watchlistReady', () => this.loadMyWatchlist());
  },

  // ── Personal Watchlist ────────────────────────

  async loadMyWatchlist() {
    const connectEl = document.getElementById('my-watchlist-connect');
    const contentEl = document.getElementById('my-watchlist-content');
    const tbody = document.getElementById('my-watchlist-body');
    if (!connectEl || !contentEl || !tbody) return;

    if (typeof wallet === 'undefined' || !wallet.connected || !wallet.address) {
      connectEl.style.display = '';
      contentEl.style.display = 'none';
      return;
    }

    connectEl.style.display = 'none';
    contentEl.style.display = '';
    tbody.innerHTML = '<tr><td colspan="5"><div class="loading-state"><div class="loading-spinner"></div><span>Loading your watchlist...</span></div></td></tr>';

    try {
      const data = await api.watchlist.get(wallet.address);
      const tokens = data?.tokens || [];

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

      const defaultLogo = utils.getDefaultLogo();
      tbody.innerHTML = tokens.map((token, i) => {
        const mint = token.mint || '';
        const d = enriched[mint] || {};
        const name = utils.escapeHtml(d.name || token.name || mint.slice(0, 8));
        const symbol = utils.escapeHtml(d.symbol || token.symbol || '');
        const logo = utils.escapeHtml(d.logoUri || d.logoURI || token.logoUri || defaultLogo);
        const price = utils.formatPrice(d.price, 6);
        const mcap = utils.formatNumber(d.marketCap, '$');

        return `
          <tr class="token-row" style="cursor:pointer" data-mint="${utils.escapeHtml(mint)}">
            <td class="cell-rank">${i + 1}</td>
            <td class="cell-token">
              <div class="token-cell">
                <img class="token-logo" src="${logo}" alt="${symbol}" loading="lazy" data-fallback="${defaultLogo}" onerror="this.onerror=null;this.src=this.dataset.fallback">
                <div class="token-info">
                  <span class="token-name">${name}</span>
                  <span class="token-symbol-cell">${symbol}</span>
                </div>
              </div>
            </td>
            <td class="cell-price mono-num">${price}</td>
            <td class="cell-mcap mono-num">${mcap}</td>
            <td><button class="action-btn danger" data-remove-wl="${utils.escapeHtml(mint)}" onclick="event.stopPropagation();">Remove</button></td>
          </tr>`;
      }).join('');

      this.bindRowClicks(tbody);

      tbody.querySelectorAll('[data-remove-wl]').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const mint = btn.dataset.removeWl;
          btn.disabled = true;
          btn.textContent = '...';
          await watchlist.remove(mint);
          this.loadMyWatchlist();
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
        const safeLogo = utils.escapeHtml(token.logoUri || token.logo_uri || defaultLogo);
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
                <img class="token-logo" src="${safeLogo}" alt="${safeSymbol}" loading="lazy" data-fallback="${defaultLogo}" onerror="this.onerror=null;this.src=this.dataset.fallback">
                <div class="token-info">
                  <span class="token-name">${safeName}</span>
                  <span class="token-symbol-cell">${safeSymbol}</span>
                </div>
              </div>
            </td>
            <td class="cell-price mono-num">${price}</td>
            <td class="cell-mcap mono-num">${mcap}</td>
            <td class="mono-num">${count}</td>
          </tr>`;
      }).join('');

      this.bindRowClicks(tbody);
    } catch (err) {
      console.error('Watchlist leaderboard error:', err.message);
      tbody.innerHTML = '<tr><td colspan="5"><div class="empty-state">Failed to load leaderboard</div></td></tr>';
    }
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
