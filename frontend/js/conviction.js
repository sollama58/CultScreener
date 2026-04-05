/* global api, apiCache, utils */

const convictionPage = {
  currentPage: 1,
  pageSize: 25,
  totalItems: 0,
  tokens: [],
  _searchTimeout: null,
  _sortField: 'conviction',
  _sortDir: 'desc',
  _activeTier: 'all',
  _activeMcap: null,

  init() {
    this.bindPagination();
    this.bindFilters();
    this.bindQuickFilters();
    this.bindSortHeaders();
    this.bindFiltersToggle();
    this.loadData();

    // If user connects wallet while on watchlist filter, reload
    window.addEventListener('walletConnected', () => {
      if (this._activeTier === 'watchlist') this.loadData();
    });
    window.addEventListener('walletDisconnected', () => {
      if (this._activeTier === 'watchlist') {
        this._activeTier = 'all';
        const container = document.getElementById('terminal-quick-filters');
        if (container) {
          container.querySelectorAll('[data-tier]').forEach(p => p.classList.remove('active'));
          const allPill = container.querySelector('[data-tier="all"]');
          if (allPill) allPill.classList.add('active');
        }
        this.loadData();
      }
    });
  },

  bindFiltersToggle() {
    const btn = document.getElementById('filters-toggle');
    const panel = document.getElementById('filters-panel');
    if (!btn || !panel) return;

    btn.addEventListener('click', () => {
      const isOpen = panel.style.display !== 'none';
      panel.style.display = isOpen ? 'none' : '';
      btn.classList.toggle('active', !isOpen);
    });
  },

  bindPagination() {
    const prev = document.getElementById('conviction-prev');
    const next = document.getElementById('conviction-next');
    if (prev) prev.addEventListener('click', () => this.goToPage(this.currentPage - 1));
    if (next) next.addEventListener('click', () => this.goToPage(this.currentPage + 1));
  },

  bindFilters() {
    const search = document.getElementById('conviction-search');
    const minPct = document.getElementById('conviction-min-pct');
    const minPctVal = document.getElementById('conviction-min-pct-val');
    const minSample = document.getElementById('conviction-min-sample');
    const resetBtn = document.getElementById('conviction-filter-reset');

    if (search) {
      search.addEventListener('input', () => {
        clearTimeout(this._searchTimeout);
        this._searchTimeout = setTimeout(() => this.applyFilters(), 350);
      });
      // Focus search on / key
      document.addEventListener('keydown', (e) => {
        if (e.key === '/' && document.activeElement !== search) {
          e.preventDefault();
          search.focus();
        }
      });
    }
    if (minPct) {
      minPct.addEventListener('input', () => {
        if (minPctVal) minPctVal.textContent = `${minPct.value}%`;
      });
      minPct.addEventListener('change', () => this.applyFilters());
    }
    if (minSample) minSample.addEventListener('change', () => this.applyFilters());
    if (resetBtn) resetBtn.addEventListener('click', () => this.resetFilters());
  },

  bindQuickFilters() {
    const container = document.getElementById('terminal-quick-filters');
    if (!container) return;

    container.addEventListener('click', (e) => {
      const pill = e.target.closest('.terminal-pill');
      if (!pill) return;

      const tier = pill.dataset.tier;
      const mcap = pill.dataset.mcap;

      if (tier) {
        // Watchlist requires wallet connection
        if (tier === 'watchlist') {
          if (typeof wallet === 'undefined' || !wallet.connected) {
            if (typeof toast !== 'undefined') toast.info('Connect your wallet to view watchlist');
            if (typeof wallet !== 'undefined') wallet.connect();
            return;
          }
        }

        // Tier pills are exclusive within their group
        container.querySelectorAll('[data-tier]').forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        this._activeTier = tier;

        // Set the min conviction slider based on tier (skip for watchlist)
        if (tier !== 'watchlist') {
          const minPct = document.getElementById('conviction-min-pct');
          const minPctVal = document.getElementById('conviction-min-pct-val');
          const tierMap = { all: 0, elite: 75, high: 50, mid: 25, low: 0 };
          if (minPct) {
            minPct.value = tierMap[tier] || 0;
            if (minPctVal) minPctVal.textContent = `${minPct.value}%`;
          }
        }
        // For "low" tier, we need special handling (maxConviction)
        this.applyFilters();
      }

      if (mcap) {
        // MCap pills toggle
        const isActive = pill.classList.contains('active');
        container.querySelectorAll('[data-mcap]').forEach(p => p.classList.remove('active'));

        const mcapSelect = document.getElementById('conviction-mcap');
        if (isActive) {
          // Deactivate
          this._activeMcap = null;
          if (mcapSelect) mcapSelect.value = '';
        } else {
          pill.classList.add('active');
          this._activeMcap = mcap;
          const mcapMap = {
            micro: '0-100000',
            small: '100000-1000000',
            mid: '1000000-10000000',
            large: '10000000-'
          };
          if (mcapSelect) mcapSelect.value = mcapMap[mcap] || '';
        }
        this.applyFilters();
      }
    });
  },

  bindSortHeaders() {
    document.querySelectorAll('.terminal-table th.sortable').forEach(th => {
      th.addEventListener('click', () => {
        const field = th.dataset.sort;
        if (this._sortField === field) {
          this._sortDir = this._sortDir === 'desc' ? 'asc' : 'desc';
        } else {
          this._sortField = field;
          this._sortDir = 'desc';
        }
        this.updateSortIndicators();
        this.sortAndRender();
      });
    });
  },

  updateSortIndicators() {
    document.querySelectorAll('.terminal-table th.sortable').forEach(th => {
      const arrow = th.querySelector('.sort-arrow');
      th.classList.remove('active-sort');
      if (arrow) {
        arrow.classList.remove('asc', 'desc');
      }
      if (th.dataset.sort === this._sortField) {
        th.classList.add('active-sort');
        if (arrow) arrow.classList.add(this._sortDir);
      }
    });
  },

  sortAndRender() {
    const field = this._sortField;
    const dir = this._sortDir === 'asc' ? 1 : -1;

    this.tokens.sort((a, b) => {
      let va, vb;
      switch (field) {
        case 'rank': return (a._originalIndex - b._originalIndex) * dir; // Preserve or reverse server order
        case 'price': va = a.price || 0; vb = b.price || 0; break;
        case 'mcap': va = a.marketCap || 0; vb = b.marketCap || 0; break;
        case 'conviction': va = a.conviction1m || 0; vb = b.conviction1m || 0; break;
        case 'holders': va = a.holders || 0; vb = b.holders || 0; break;
        default: return 0;
      }
      return (va - vb) * dir;
    });
    this.render();
  },

  getFilters() {
    const params = {};
    const search = document.getElementById('conviction-search');
    const minPct = document.getElementById('conviction-min-pct');
    const mcap = document.getElementById('conviction-mcap');
    const minSample = document.getElementById('conviction-min-sample');

    if (search && search.value.trim()) params.search = search.value.trim();
    if (minPct && parseInt(minPct.value) > 0) params.minConviction = minPct.value;
    if (mcap && mcap.value) {
      const [min, max] = mcap.value.split('-');
      if (min) params.minMcap = min;
      if (max) params.maxMcap = max;
    }
    if (minSample && minSample.value) params.minSample = minSample.value;
    return params;
  },

  applyFilters() {
    this.currentPage = 1;
    this.loadData();
    const resetBtn = document.getElementById('conviction-filter-reset');
    const hasFilters = Object.keys(this.getFilters()).length > 0 || this._activeTier !== 'all' || this._activeMcap;
    if (resetBtn) resetBtn.style.display = hasFilters ? '' : 'none';
  },

  resetFilters() {
    const search = document.getElementById('conviction-search');
    const minPct = document.getElementById('conviction-min-pct');
    const minPctVal = document.getElementById('conviction-min-pct-val');
    const mcap = document.getElementById('conviction-mcap');
    const minSample = document.getElementById('conviction-min-sample');
    const resetBtn = document.getElementById('conviction-filter-reset');

    if (search) search.value = '';
    if (minPct) { minPct.value = 0; if (minPctVal) minPctVal.textContent = '0%'; }
    if (mcap) mcap.value = '';
    if (minSample) minSample.value = '';
    if (resetBtn) resetBtn.style.display = 'none';

    // Reset pills
    this._activeTier = 'all';
    this._activeMcap = null;
    const container = document.getElementById('terminal-quick-filters');
    if (container) {
      container.querySelectorAll('.terminal-pill').forEach(p => p.classList.remove('active'));
      const allPill = container.querySelector('[data-tier="all"]');
      if (allPill) allPill.classList.add('active');
    }

    this.currentPage = 1;
    this.loadData();
  },

  async loadData() {
    const tbody = document.getElementById('conviction-table-body');
    if (!tbody || this._loading) return;
    this._loading = true;

    const statusEl = document.getElementById('terminal-status-text');
    if (statusEl) {
      statusEl.textContent = 'LOADING...';
      statusEl.parentElement.classList.remove('error');
      statusEl.parentElement.classList.add('loading');
    }

    const _t0 = performance.now();
    let _ok = true;

    tbody.innerHTML = `
      <tr class="loading-row">
        <td colspan="7">
          <div class="loading-state">
            <div class="loading-spinner"></div>
            <span>Scanning blockchain data...</span>
          </div>
        </td>
      </tr>
    `;

    try {
      // Watchlist mode: fetch user's watchlisted tokens instead of leaderboard
      if (this._activeTier === 'watchlist' && typeof wallet !== 'undefined' && wallet.connected) {
        const wlData = await api.watchlist.get(wallet.address);
        const wlTokens = wlData?.tokens || [];

        // Map watchlist tokens to the same shape as conviction leaderboard
        this.tokens = wlTokens.map(t => ({
          mintAddress: t.mint,
          address: t.mint,
          name: t.name || `${t.mint.slice(0, 4)}...${t.mint.slice(-4)}`,
          symbol: t.symbol || '',
          logoUri: t.logoUri || t.logo_uri || null,
          price: 0,
          marketCap: 0,
          conviction1m: 0,
          conviction: {},
          sampleSize: 0,
          convictionUpdatedAt: null,
          addedAt: t.addedAt
        }));
        this.totalItems = this.tokens.length;

        // Enrich with batch price data if tokens exist
        if (this.tokens.length > 0) {
          try {
            const mints = this.tokens.map(t => t.mintAddress);
            const batchData = await api.tokens.getBatch(mints);
            if (Array.isArray(batchData)) {
              const dataMap = {};
              batchData.forEach(t => { if (t) dataMap[t.address || t.mintAddress] = t; });
              this.tokens.forEach(t => {
                const d = dataMap[t.mintAddress];
                if (d) {
                  t.price = d.price || 0;
                  t.marketCap = d.marketCap || 0;
                  t.conviction1m = d.conviction1m || 0;
                  t.conviction = d.conviction || {};
                  t.sampleSize = d.sampleSize || 0;
                  t.name = d.name || t.name;
                  t.symbol = d.symbol || t.symbol;
                  t.logoUri = d.logoUri || d.logoURI || t.logoUri;
                }
              });
            }
          } catch (_) { /* batch enrichment non-critical */ }
        }
      } else {
        // Normal conviction leaderboard
        const params = {
          limit: this.pageSize,
          offset: (this.currentPage - 1) * this.pageSize,
          ...this.getFilters()
        };

        const result = await api.tokens.leaderboardConviction(params);
        this.tokens = result.tokens || [];
        this.totalItems = result.total || 0;

        // Client-side filter for "low" tier (< 25%)
        if (this._activeTier === 'low') {
          this.tokens = this.tokens.filter(t => (t.conviction1m || 0) < 25);
        }
      }

      // Tag original index for rank-based sorting
      this.tokens.forEach((t, i) => { t._originalIndex = i; });

      this.updateTerminalStats();
      this.sortAndRender();
      this.updatePagination();

      if (statusEl) {
        statusEl.textContent = 'LIVE';
        statusEl.parentElement.classList.remove('loading', 'error');
      }
    } catch (error) {
      _ok = false;
      console.error('Conviction load error:', error);
      if (statusEl) {
        statusEl.textContent = 'ERROR';
        statusEl.parentElement.classList.remove('loading');
        statusEl.parentElement.classList.add('error');
      }
      tbody.innerHTML = `
        <tr class="empty-row">
          <td colspan="7">
            <div class="empty-state">
              <span>Failed to load terminal data. Please try again.</span>
            </div>
          </td>
        </tr>
      `;
    } finally {
      this._loading = false;
      if (typeof latencyTracker !== 'undefined') latencyTracker.record('conviction.loadData', performance.now() - _t0, _ok, 'frontend');
    }
  },

  updateTerminalStats() {
    const totalEl = document.getElementById('stat-total');
    const avgEl = document.getElementById('stat-avg-conviction');
    const pageEl = document.getElementById('stat-page');
    const showingEl = document.getElementById('stat-showing');
    const totalPages = Math.max(1, Math.ceil(this.totalItems / this.pageSize));

    if (totalEl) totalEl.textContent = this.totalItems.toLocaleString();
    if (pageEl) pageEl.textContent = `${this.currentPage}/${totalPages}`;

    const start = (this.currentPage - 1) * this.pageSize + 1;
    const end = Math.min(this.currentPage * this.pageSize, this.totalItems);
    if (showingEl) showingEl.textContent = this.totalItems > 0 ? `${start}-${end}` : '0';

    if (avgEl && this.tokens.length > 0) {
      const avg = this.tokens.reduce((sum, t) => sum + (t.conviction1m || 0), 0) / this.tokens.length;
      avgEl.textContent = `${avg.toFixed(1)}%`;
      avgEl.className = 'terminal-stat-value';
      if (avg >= 50) avgEl.classList.add('stat-high');
      else if (avg >= 25) avgEl.classList.add('stat-mid');
      else avgEl.classList.add('stat-low');
    } else if (avgEl) {
      avgEl.textContent = '--';
    }
  },

  render() {
    const tbody = document.getElementById('conviction-table-body');
    if (!tbody) return;

    if (!this.tokens || this.tokens.length === 0) {
      const isWatchlist = this._activeTier === 'watchlist';
      const emptyMsg = isWatchlist
        ? 'Your watchlist is empty. Visit token pages and click the star to add tokens.'
        : 'No tokens match current filters. Adjust filters or visit token pages to trigger analysis.';
      tbody.innerHTML = `
        <tr class="empty-row">
          <td colspan="7">
            <div class="empty-state">
              <span style="font-size: 1.5rem; margin-bottom: 0.5rem; opacity: 0.4;">${isWatchlist ? 'EMPTY WATCHLIST' : 'NO DATA'}</span>
              <span>${emptyMsg}</span>
            </div>
          </td>
        </tr>
      `;
      return;
    }

    const defaultLogo = utils.getDefaultLogo();
    const offset = (this.currentPage - 1) * this.pageSize;

    tbody.innerHTML = this.tokens.map((token, index) => {
      const rank = offset + index + 1;
      const address = token.mintAddress || token.address || '';
      if (!address) return '';

      const safeAddress = utils.escapeHtml(address);
      const safeLogo = utils.escapeHtml(token.logoUri || token.logoURI || defaultLogo);
      const safeName = utils.escapeHtml(token.name || `${address.slice(0, 4)}...${address.slice(-4)}`);
      const safeSymbol = utils.escapeHtml(token.symbol || address.slice(0, 5).toUpperCase());

      // Conviction percentage
      const conviction1m = token.conviction1m != null ? token.conviction1m : 0;
      const convictionClass = conviction1m >= 75 ? 'conviction-elite'
        : conviction1m >= 50 ? 'conviction-high'
        : conviction1m >= 25 ? 'conviction-medium'
        : 'conviction-low';

      // Conviction tier badge
      const tierBadge = conviction1m >= 75 ? '<span class="tier-badge tier-elite">ELITE</span>'
        : conviction1m >= 50 ? '<span class="tier-badge tier-high">HIGH</span>'
        : conviction1m >= 25 ? '<span class="tier-badge tier-mid">MID</span>'
        : '<span class="tier-badge tier-low">LOW</span>';

      // Mini bar distribution
      const dist = token.conviction || {};
      const barsHtml = this.renderMiniBars(dist);

      // Holders count
      const holdersHtml = token.holders
        ? `<span class="mono-num">${token.holders.toLocaleString()}</span>`
        : '<span style="color:var(--text-dim)">--</span>';

      // Format price with color
      const priceStr = utils.formatPrice(token.price, 6);
      const mcapStr = utils.formatNumber(token.marketCap, '$');

      return `
        <tr class="token-row terminal-row" data-mint="${safeAddress}">
          <td class="cell-rank">${rank}</td>
          <td class="cell-token cell-token-clickable" data-navigate="${safeAddress}">
            <div class="token-cell">
              <img class="token-logo" src="${safeLogo}" alt="${safeSymbol}" loading="lazy">
              <div class="token-info">
                <span class="token-name">${safeName}</span>
                <span class="token-symbol-cell">${safeSymbol}</span>
              </div>
            </div>
          </td>
          <td class="cell-price mono-num" data-navigate="${safeAddress}">${priceStr}</td>
          <td class="cell-mcap mono-num" data-navigate="${safeAddress}">${mcapStr}</td>
          <td class="cell-conviction ${convictionClass}" data-navigate="${safeAddress}">
            <div class="conviction-cell">
              <span class="conviction-pct">${conviction1m.toFixed(1)}%</span>
              ${tierBadge}
            </div>
          </td>
          <td class="cell-conviction-bars" data-navigate="${safeAddress}">${barsHtml}</td>
          <td class="cell-updated" data-navigate="${safeAddress}">${holdersHtml}</td>
        </tr>
      `;
    }).join('');

    // Logo fallbacks
    const defaultLogoSrc = defaultLogo;
    tbody.querySelectorAll('.token-logo').forEach(img => {
      img.onerror = function() { this.onerror = null; this.src = defaultLogoSrc; };
    });

    // Click navigation
    tbody.querySelectorAll('[data-navigate]').forEach(el => {
      el.addEventListener('click', () => {
        const mint = el.dataset.navigate;
        if (mint) window.location.href = `token.html?mint=${encodeURIComponent(mint)}`;
      });
      el.style.cursor = 'pointer';
    });
  },

  renderMiniBars(dist) {
    const buckets = [
      { key: '6h', label: '6h' },
      { key: '24h', label: '24h' },
      { key: '3d', label: '3d' },
      { key: '1w', label: '1w' },
      { key: '1m', label: '1m' }
    ];
    const maxH = 28;

    return `<div class="conviction-mini-bars terminal-bars">${buckets.map(b => {
      const val = dist[b.key] || 0;
      const h = Math.max(1, Math.round((val / 100) * maxH));
      const colorClass = val >= 50 ? 'bar-high' : val >= 25 ? 'bar-mid' : 'bar-low';
      return `<div class="conviction-mini-bar" title="${b.label}: ${val.toFixed(1)}%">
        <div class="conviction-mini-fill ${colorClass}" style="height:${h}px"></div>
        <span class="conviction-mini-label">${b.label}</span>
      </div>`;
    }).join('')}</div>`;
  },

  goToPage(page) {
    const totalPages = Math.max(1, Math.ceil(this.totalItems / this.pageSize));
    if (page < 1 || page > totalPages) return;
    this.currentPage = page;
    this.loadData();
    document.querySelector('.conviction-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  },

  updatePagination() {
    const paginationEl = document.getElementById('conviction-pagination');
    const totalPages = Math.max(1, Math.ceil(this.totalItems / this.pageSize));

    if (totalPages <= 1) {
      if (paginationEl) paginationEl.style.display = 'none';
      return;
    }

    if (paginationEl) paginationEl.style.display = 'flex';

    const prev = document.getElementById('conviction-prev');
    const next = document.getElementById('conviction-next');
    if (prev) prev.disabled = this.currentPage <= 1;
    if (next) next.disabled = this.currentPage >= totalPages;

    const tabsContainer = document.getElementById('conviction-page-tabs');
    if (tabsContainer) {
      const pages = [];
      const maxVisible = 5;
      let start = Math.max(1, this.currentPage - Math.floor(maxVisible / 2));
      let end = Math.min(totalPages, start + maxVisible - 1);
      if (end - start < maxVisible - 1) {
        start = Math.max(1, end - maxVisible + 1);
      }

      if (start > 1) {
        pages.push(`<button class="page-tab" data-page="1">1</button>`);
        if (start > 2) pages.push(`<span class="page-ellipsis">...</span>`);
      }
      for (let i = start; i <= end; i++) {
        pages.push(`<button class="page-tab${i === this.currentPage ? ' active' : ''}" data-page="${i}">${i}</button>`);
      }
      if (end < totalPages) {
        if (end < totalPages - 1) pages.push(`<span class="page-ellipsis">...</span>`);
        pages.push(`<button class="page-tab" data-page="${totalPages}">${totalPages}</button>`);
      }

      tabsContainer.innerHTML = pages.join('');
      tabsContainer.querySelectorAll('.page-tab').forEach(btn => {
        btn.addEventListener('click', () => this.goToPage(parseInt(btn.dataset.page)));
      });
    }

    const pageInfo = document.getElementById('conviction-page-info');
    if (pageInfo) pageInfo.textContent = `Page ${this.currentPage} of ${totalPages}`;
  }
};

document.addEventListener('DOMContentLoaded', () => convictionPage.init());
