/* global api, apiCache, utils, tokenTable */

const convictionPage = {
  currentPage: 1,
  pageSize: 25,
  totalItems: 0,
  tokens: [],
  _allTokens: [],
  _searchTimeout: null,
  _sortField: 'rank',
  _sortDir: 'asc',
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
    // A linked phone resolves its identity a beat after load, same as an auto-connected wallet.
    window.addEventListener('walletLinked', () => {
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
        // Watchlist needs an identity - a connected wallet, or a phone linked from a desktop.
        if (tier === 'watchlist') {
          if (typeof wallet === 'undefined' || !wallet.viewerAddress()) {
            if (typeof toast !== 'undefined') toast.info('Connect your wallet to view watchlist');
            if (typeof wallet !== 'undefined') wallet.connect();
            return;
          }
        }

        container.querySelectorAll('[data-tier]').forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        this._activeTier = tier;
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

  _shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  },

  sortAndRender() {
    const field = this._sortField;
    const dir = this._sortDir === 'asc' ? 1 : -1;

    // Price changes sort tokens without one last in either direction.
    const changeKey = { change24h: 'priceChange24h', change7d: 'priceChange7d', change30d: 'priceChange30d' }[field];
    if (changeKey) {
      const val = t => (t[changeKey] != null && isFinite(t[changeKey]) ? t[changeKey] : null);
      this._allTokens.sort((a, b) => {
        const va = val(a), vb = val(b);
        if (va == null || vb == null) return (va == null) - (vb == null);
        return (va - vb) * dir;
      });
    } else if (field !== 'rank') {
      this._allTokens.sort((a, b) => {
        let va, vb;
        switch (field) {
          case 'mcap': va = a.marketCap ?? 0; vb = b.marketCap ?? 0; break;
          case 'holders': va = a.holders || 0; vb = b.holders || 0; break;
          default: return 0;
        }
        return (va - vb) * dir;
      });
    }

    const offset = (this.currentPage - 1) * this.pageSize;
    this.tokens = this._allTokens.slice(offset, offset + this.pageSize);
    this.render();
  },

  getFilters() {
    const params = {};
    const search = document.getElementById('conviction-search');
    const mcap = document.getElementById('conviction-mcap');
    const minSample = document.getElementById('conviction-min-sample');

    if (search && search.value.trim()) params.search = search.value.trim();
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
    const mcap = document.getElementById('conviction-mcap');
    const minSample = document.getElementById('conviction-min-sample');
    const resetBtn = document.getElementById('conviction-filter-reset');

    if (search) search.value = '';
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
    if (!tbody) return;

    // If already loading, queue a reload so filter/tier changes aren't silently dropped
    if (this._loading) {
      this._pendingReload = true;
      return;
    }

    this._loading = true;
    this._pendingReload = false;

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
        <td colspan="8">
          <div class="loading-state">
            <div class="loading-spinner"></div>
            <span>Scanning blockchain data...</span>
          </div>
        </td>
      </tr>
    `;

    try {
      // Watchlist mode: fetch user's watchlisted tokens instead of leaderboard
      // viewerAddress covers a phone linked from a desktop as well as a connected wallet -
      // the watchlist tab is a read, and a linked phone is entitled to it.
      const wlViewer = typeof wallet !== 'undefined' ? wallet.viewerAddress?.() : null;
      if (this._activeTier === 'watchlist' && wlViewer) {
        const wlData = await api.watchlist.get(wlViewer);
        const wlTokens = wlData?.tokens || [];

        // Map watchlist tokens to the same shape as conviction leaderboard
        this._allTokens = wlTokens.map(t => ({
          mintAddress: t.mint,
          address: t.mint,
          name: t.name || `${t.mint.slice(0, 4)}...${t.mint.slice(-4)}`,
          symbol: t.symbol || '',
          logoUri: t.logoUri || t.logo_uri || null,
          price: null,
          marketCap: null,
          conviction1m: 0,
          conviction: {},
          sampleSize: 0,
          convictionUpdatedAt: null,
          addedAt: t.addedAt
        }));
        const { search: wlSearch } = this.getFilters();
        if (wlSearch) {
          const q = wlSearch.toLowerCase();
          this._allTokens = this._allTokens.filter(t =>
            (t.name || '').toLowerCase().includes(q) ||
            (t.symbol || '').toLowerCase().includes(q) ||
            (t.mintAddress || '').toLowerCase().includes(q)
          );
        }
        this._shuffle(this._allTokens);
        this._allTokens.forEach((t, i) => { t._originalIndex = i; });
        this.totalItems = this._allTokens.length;

        // Enrich with batch price data if tokens exist
        if (this._allTokens.length > 0) {
          try {
            const mints = this._allTokens.map(t => t.mintAddress);
            const batchData = await api.tokens.getBatch(mints);
            if (Array.isArray(batchData)) {
              const dataMap = {};
              batchData.forEach(t => { if (t) dataMap[t.address || t.mintAddress] = t; });
              this._allTokens.forEach(t => {
                const d = dataMap[t.mintAddress];
                if (d) {
                  t.price = d.price || null;
                  t.marketCap = d.marketCap || null;
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

          // Price changes, holders and holder velocity come with the leaderboard (curated
          // tokens only, usually already in the client cache).
          try {
            const board = await api.tokens.leaderboardConviction({ limit: 100, offset: 0 });
            const byMint = {};
            (board?.tokens || []).forEach(t => { byMint[t.mintAddress] = t; });
            this._allTokens.forEach(t => {
              const b = byMint[t.mintAddress];
              if (!b) return;
              t.priceChange24h = b.priceChange24h;
              t.priceChange7d = b.priceChange7d;
              t.priceChange30d = b.priceChange30d;
              t.holders = b.holders || t.holders;
              t.holderVelocity = b.holderVelocity;
              t.pairCreatedAt = t.pairCreatedAt || b.pairCreatedAt;
              t.convictionUpdatedAt = t.convictionUpdatedAt || b.convictionUpdatedAt;
            });
          } catch (_) { /* leaderboard enrichment non-critical */ }
        }
      } else {
        // Fetch all tokens, shuffle client-side for random order
        const params = { limit: 100, offset: 0, ...this.getFilters() };
        const result = await api.tokens.leaderboardConviction(params);
        const all = [...(result.tokens || [])]; // clone to avoid mutating the cached array

        this._shuffle(all);
        all.forEach((t, i) => { t._originalIndex = i; });
        this._allTokens = all;
        this.totalItems = all.length;

        // If some tokens are missing holder counts, schedule a silent re-fetch
        const missingHolders = all.some(t => !t.holders);
        if (missingHolders && !this._holderRefreshPending) {
          this._holderRefreshPending = true;
          setTimeout(() => {
            this._holderRefreshPending = false;
            if (!this._loading) {
              apiCache.clearPattern('tokens:leaderboard:conviction');
              this.loadData();
            }
          }, 8000);
        }
      }

      this.sortAndRender();
      this.updateTerminalStats();
      this.updatePagination();

      if (statusEl) {
        statusEl.textContent = 'LIVE';
        statusEl.parentElement.classList.remove('loading', 'error');
      }
    } catch (error) {
      _ok = false;
      console.error('Conviction load error:', error.message);
      if (statusEl) {
        statusEl.textContent = 'ERROR';
        statusEl.parentElement.classList.remove('loading');
        statusEl.parentElement.classList.add('error');
      }
      tbody.innerHTML = `
        <tr class="empty-row">
          <td colspan="8">
            <div class="empty-state">
              <span>Failed to load terminal data. Please try again.</span>
            </div>
          </td>
        </tr>
      `;
    } finally {
      this._loading = false;
      if (typeof latencyTracker !== 'undefined') latencyTracker.record('conviction.loadData', performance.now() - _t0, _ok, 'frontend');
      // If a filter/tier change arrived while we were loading, process it now
      if (this._pendingReload) {
        this._pendingReload = false;
        this.loadData();
      }
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
    tokenTable.bind(tbody);

    if (!this.tokens || this.tokens.length === 0) {
      const isWatchlist = this._activeTier === 'watchlist';
      tbody.innerHTML = isWatchlist
        ? tokenTable.emptyRow(8, 'Your watchlist is empty', 'Visit token pages and click the star to add tokens.')
        : tokenTable.emptyRow(8, 'No tokens match', 'Adjust the filters, or visit token pages to trigger analysis.');
      return;
    }

    const offset = (this.currentPage - 1) * this.pageSize;


    tbody.innerHTML = this.tokens.map((token, index) => {
      if (!tokenTable.mintOf(token)) return '';
      return `
        <tr ${tokenTable.rowAttrs(token)}>
          ${tokenTable.rankCell(offset + index + 1)}
          ${tokenTable.tokenCell(token)}
          <td class="cell-mcap num">${utils.formatNumber(token.marketCap, '$')}<span class="tt-mcap-chg">${tokenTable.change(token.priceChange24h, '24h')}</span></td>
          <td class="cell-chg">${tokenTable.change(token.priceChange24h, '24h')}</td>
          <td class="cell-chg cell-chg-long">${tokenTable.change(token.priceChange7d, '7d')}</td>
          <td class="cell-chg cell-chg-long">${tokenTable.change(token.priceChange30d, '30d')}</td>
          <td class="cell-updated">${tokenTable.holdersWithVelocity(token)}</td>
          <td class="cell-dist">${tokenTable.dhCell(token)}</td>
        </tr>`;
    }).join('');
  },

  goToPage(page) {
    const totalPages = Math.max(1, Math.ceil(this.totalItems / this.pageSize));
    if (page < 1 || page > totalPages) return;
    this.currentPage = page;
    this.sortAndRender();
    this.updatePagination();
    this.updateTerminalStats();
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
