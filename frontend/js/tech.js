/* global api, apiCache, utils, convictionPage */

const techPage = {
  tokens: [],
  _searchTimeout: null,
  _loaded: false,

  init() {
    if (this._loaded) return;
    this._loaded = true;
    this.bindSearch();
    this.loadData();
  },

  bindSearch() {
    const search = document.getElementById('tech-search');
    if (!search) return;
    search.addEventListener('input', () => {
      clearTimeout(this._searchTimeout);
      this._searchTimeout = setTimeout(() => this.render(), 300);
    });
  },

  async loadData() {
    const tbody = document.getElementById('tech-table-body');
    const statusEl = document.getElementById('tech-status-text');
    if (!tbody || this._loading) return;
    this._loading = true;

    if (statusEl) {
      statusEl.textContent = 'LOADING...';
      statusEl.parentElement.classList.add('loading');
    }

    tbody.innerHTML = `
      <tr class="loading-row">
        <td colspan="6">
          <div class="loading-state">
            <div class="loading-spinner"></div>
            <span>Loading tech coins...</span>
          </div>
        </td>
      </tr>
    `;

    try {
      const result = await api.tokens.leaderboardConviction({ limit: 100, offset: 0 });
      const allTokens = [...(result?.tokens || [])]; // clone to avoid mutating shared cache
      const filtered = allTokens.filter(t => t.techCoin);
      // Shuffle for random order
      for (let i = filtered.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [filtered[i], filtered[j]] = [filtered[j], filtered[i]];
      }
      this.tokens = filtered;

      if (statusEl) {
        statusEl.textContent = this.tokens.length > 0
          ? `${this.tokens.length} TECH COIN${this.tokens.length !== 1 ? 'S' : ''}`
          : 'NO TECH COINS';
        statusEl.parentElement.classList.remove('loading', 'error');
      }

      this.render();
    } catch (err) {
      if (statusEl) {
        statusEl.textContent = 'ERROR';
        statusEl.parentElement.classList.remove('loading');
        statusEl.parentElement.classList.add('error');
      }
      tbody.innerHTML = `
        <tr class="empty-row">
          <td colspan="6">
            <div class="empty-state">
              <span>Failed to load tech coins. Please try again.</span>
            </div>
          </td>
        </tr>
      `;
    } finally {
      this._loading = false;
    }
  },

  render() {
    const tbody = document.getElementById('tech-table-body');
    if (!tbody) return;

    const search = document.getElementById('tech-search');
    const query = search ? search.value.trim().toLowerCase() : '';

    const filtered = query
      ? this.tokens.filter(t =>
          (t.name || '').toLowerCase().includes(query) ||
          (t.symbol || '').toLowerCase().includes(query)
        )
      : this.tokens;

    if (filtered.length === 0) {
      tbody.innerHTML = `
        <tr class="empty-row">
          <td colspan="6">
            <div class="empty-state">
              <span style="font-size:1.5rem;margin-bottom:0.5rem;opacity:0.4;">NO TECH COINS</span>
              <span>${query ? 'No tech coins match your search.' : 'No tech coins have been added yet. Use the admin panel to tag tokens as Tech Coins.'}</span>
            </div>
          </td>
        </tr>
      `;
      return;
    }

    const defaultLogo = utils.getDefaultLogo();

    tbody.innerHTML = filtered.map((token, index) => {
      const address = token.mintAddress || token.address || '';
      if (!address) return '';

      const safeAddress = utils.escapeHtml(address);
      const safeLogo = utils.escapeHtml(token.logoUri || token.logoURI || defaultLogo);
      const safeName = utils.escapeHtml(token.name || `${address.slice(0, 4)}...${address.slice(-4)}`);
      const safeSymbol = utils.escapeHtml(token.symbol || address.slice(0, 5).toUpperCase());

      const techBadge = '<span class="cult-hammer" title="Tech Coin">🤖</span>';

      const holdersHtml = token.holders
        ? `<span class="mono-num">${token.holders.toLocaleString()}</span>`
        : '<span style="color:var(--text-dim)">--</span>';

      const priceStr = utils.formatPrice(token.price, 6);
      const mcapStr = utils.formatNumber(token.marketCap, '$');

      let athPctHtml = '<span style="color:var(--text-dim)">--</span>';
      if (token.mcapAtAdded != null && token.mcapAtAdded > 0 && token.mcapAth != null) {
        const pct = ((token.mcapAth - token.mcapAtAdded) / token.mcapAtAdded) * 100;
        const sign = pct >= 0 ? '+' : '';
        const color = pct >= 0 ? 'var(--green)' : 'var(--red)';
        const athStr = utils.formatNumber(token.mcapAth, '$');
        athPctHtml = `<span class="mono-num" style="color:${color}" title="ATH MCap: ${athStr}">${sign}${pct.toFixed(0)}%</span>`;
      }

      return `
        <tr class="token-row terminal-row" data-mint="${safeAddress}">
          <td class="cell-rank">${index + 1}</td>
          <td class="cell-token cell-token-clickable" data-navigate="${safeAddress}">
            <div class="token-cell">
              <img class="token-logo" src="${safeLogo}" alt="${safeSymbol}" loading="lazy">
              <div class="token-info">
                <div class="table-name-line">
                  <span class="token-name">${safeName}</span>${techBadge}
                </div>
                <span class="token-symbol-cell">${safeSymbol}</span>
              </div>
            </div>
          </td>
          <td class="cell-price mono-num" data-navigate="${safeAddress}">${priceStr}</td>
          <td class="cell-mcap mono-num" data-navigate="${safeAddress}">${mcapStr}</td>
          <td class="cell-ath-pct" data-navigate="${safeAddress}">${athPctHtml}</td>
          <td class="cell-updated" data-navigate="${safeAddress}">${holdersHtml}</td>
        </tr>
      `;
    }).join('');

    // Click navigation — same URL pattern as conviction.js
    tbody.querySelectorAll('[data-navigate]').forEach(el => {
      el.addEventListener('click', () => {
        const mint = el.dataset.navigate;
        if (mint) window.location.href = `token.html?mint=${encodeURIComponent(mint)}`;
      });
      el.style.cursor = 'pointer';
    });

    // Logo error fallback
    const safeDefaultLogo = defaultLogo;
    tbody.querySelectorAll('.token-logo').forEach(img => {
      img.addEventListener('error', function () {
        if (this.src !== safeDefaultLogo) this.src = safeDefaultLogo;
      });
    });
  }
};
