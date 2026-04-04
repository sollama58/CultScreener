/* global api, utils */

const communityPage = {
  activeTab: 'watchlist',

  init() {
    this.bindTabs();
    this.loadTab('watchlist');
  },

  bindTabs() {
    document.querySelectorAll('.community-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        const tabName = tab.dataset.tab;
        if (tabName === this.activeTab) return;

        // Update tab buttons
        document.querySelectorAll('.community-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');

        // Update tab content
        document.querySelectorAll('.community-tab-content').forEach(c => c.style.display = 'none');
        const content = document.getElementById(`tab-${tabName}`);
        if (content) content.style.display = '';

        this.activeTab = tabName;
        this.loadTab(tabName);
      });
    });
  },

  async loadTab(tabName) {
    if (tabName === 'watchlist') {
      await this.loadWatchlistLeaderboard();
    } else if (tabName === 'sentiment') {
      await this.loadSentimentLeaderboard();
    }
  },

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
          </tr>
        `;
      }).join('');

      this.bindRowClicks(tbody);
    } catch (err) {
      console.error('Watchlist leaderboard error:', err);
      tbody.innerHTML = '<tr><td colspan="5"><div class="empty-state">Failed to load leaderboard</div></td></tr>';
    }
  },

  async loadSentimentLeaderboard() {
    const tbody = document.getElementById('sentiment-leaderboard-body');
    if (!tbody) return;

    tbody.innerHTML = '<tr><td colspan="7"><div class="loading-state"><div class="loading-spinner"></div><span>Loading...</span></div></td></tr>';

    try {
      const result = await api.tokens.leaderboardSentiment({ limit: 50 });
      const tokens = result.tokens || result || [];

      if (tokens.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state">No sentiment votes yet</div></td></tr>';
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
        const bullish = token.bullish || 0;
        const bearish = token.bearish || 0;
        const score = token.score || token.sentimentScore || 0;

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
            <td class="mono-num" style="color: var(--green)">${bullish}</td>
            <td class="mono-num" style="color: var(--red)">${bearish}</td>
            <td class="mono-num" style="color: ${score >= 0 ? 'var(--green)' : 'var(--red)'}">${score >= 0 ? '+' : ''}${score}</td>
          </tr>
        `;
      }).join('');

      this.bindRowClicks(tbody);
    } catch (err) {
      console.error('Sentiment leaderboard error:', err);
      tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state">Failed to load leaderboard</div></td></tr>';
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
