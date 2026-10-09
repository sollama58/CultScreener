/* global api, apiCache, utils, convictionPage, tokenTable */

const techPage = {
  tokens: [],
  _searchTimeout: null,
  _loaded: false,
  _loading: false,
  _loadFailed: false,

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
      const result = await tokenTable.loadBoard();
      const allTokens = result.tokens; // a fresh array, not the shared cached one
      const filtered = allTokens.filter(t => t.techCoin);
      // Shuffle for random order
      for (let i = filtered.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [filtered[i], filtered[j]] = [filtered[j], filtered[i]];
      }
      this.tokens = filtered;
      this._loadFailed = false;

      if (statusEl) {
        statusEl.textContent = this.tokens.length > 0
          ? `${this.tokens.length} TECH COIN${this.tokens.length !== 1 ? 'S' : ''}`
          : 'NO TECH COINS';
        statusEl.parentElement.classList.remove('loading', 'error');
      }

      this.render();
    } catch (err) {
      // mainViewTabs reloads on the next tab click while this is set.
      this._loadFailed = true;
      if (statusEl) {
        statusEl.textContent = 'ERROR';
        statusEl.parentElement.classList.remove('loading');
        statusEl.parentElement.classList.add('error');
      }
      tbody.innerHTML = `
        <tr class="empty-row">
          <td colspan="6">
            <div class="empty-state">
              <span>Failed to load tech coins. Select the tab again to retry.</span>
            </div>
          </td>
        </tr>
      `;
    } finally {
      this._loading = false;
    }
  },

  render() {
    // Keep the load error up (a search would replace it with "Nothing here yet").
    if (this._loadFailed) return;
    const tbody = document.getElementById('tech-table-body');
    if (!tbody) return;
    tokenTable.bind(tbody);

    const search = document.getElementById('tech-search');
    const query = search ? search.value.trim().toLowerCase() : '';

    const filtered = query
      ? this.tokens.filter(t =>
          (t.name || '').toLowerCase().includes(query) ||
          (t.symbol || '').toLowerCase().includes(query)
        )
      : this.tokens;

    if (filtered.length === 0) {
      tbody.innerHTML = query
        ? tokenTable.emptyRow(6, 'No matches', 'No tech coins match your search.')
        : tokenTable.emptyRow(6, 'Nothing here yet', 'No tech coins have been added yet. Use the admin panel to tag tokens as Tech Coins.');
      return;
    }

    tbody.innerHTML = filtered.map((token, index) => {
      if (!tokenTable.mintOf(token)) return '';
      return `
        <tr ${tokenTable.rowAttrs(token)}>
          ${tokenTable.rankCell(index + 1, { plain: true })}
          ${tokenTable.tokenCell(token)}
          <td class="cell-price num">${utils.formatPrice(token.price, 6)}${tokenTable.athStack(token)}</td>
          <td class="cell-mcap num">${utils.formatNumber(token.marketCap, '$')}</td>
          <td class="cell-ath-pct">${tokenTable.athCell(token)}</td>
          <td class="cell-updated">${tokenTable.holders(token)}</td>
        </tr>`;
    }).join('');
  }
};
