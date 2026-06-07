/* global api, apiCache, utils */

const versusPage = {
  tokens: [],
  benchmarks: { sol: null, btc: null },
  _loaded: false,
  _loading: false,
  _searchTimeout: null,
  _sortField: 'vsSol',
  _sortDir: 'desc',

  init() {
    if (this._loaded) return;
    this._loaded = true;
    this.bindSearch();
    this.bindSortHeaders();
    this.loadData();
  },

  bindSearch() {
    const search = document.getElementById('versus-search');
    if (!search) return;
    search.addEventListener('input', () => {
      clearTimeout(this._searchTimeout);
      this._searchTimeout = setTimeout(() => this.render(), 300);
    });
  },

  bindSortHeaders() {
    const table = document.getElementById('versus-table');
    if (!table) return;
    table.querySelectorAll('th[data-sort]').forEach(th => {
      th.style.cursor = 'pointer';
      th.addEventListener('click', () => {
        const field = th.dataset.sort;
        if (this._sortField === field) {
          this._sortDir = this._sortDir === 'desc' ? 'asc' : 'desc';
        } else {
          this._sortField = field;
          this._sortDir = 'desc';
        }
        this.updateSortIndicators();
        this.render();
      });
    });
    this.updateSortIndicators();
  },

  updateSortIndicators() {
    const table = document.getElementById('versus-table');
    if (!table) return;
    table.querySelectorAll('th[data-sort]').forEach(th => {
      const arrow = th.querySelector('.sort-arrow');
      th.classList.remove('active-sort');
      if (arrow) arrow.className = 'sort-arrow';
      if (th.dataset.sort === this._sortField) {
        th.classList.add('active-sort');
        if (arrow) arrow.classList.add(this._sortDir);
      }
    });
  },

  async loadData() {
    const tbody = document.getElementById('versus-table-body');
    const statusEl = document.getElementById('versus-status-text');
    if (!tbody || this._loading) return;
    this._loading = true;

    if (statusEl) {
      statusEl.textContent = 'LOADING...';
      statusEl.parentElement.classList.add('loading');
    }

    tbody.innerHTML = `
      <tr class="loading-row">
        <td colspan="8">
          <div class="loading-state">
            <div class="loading-spinner"></div>
            <span>Fetching performance data...</span>
          </div>
        </td>
      </tr>
    `;

    try {
      const [leaderboard, benchmarks] = await Promise.all([
        api.tokens.leaderboardConviction({ limit: 100, offset: 0 }),
        api.tokens.benchmarks()
      ]);

      this.benchmarks = benchmarks || { sol: null, btc: null };
      this.tokens = [...(leaderboard?.tokens || [])];

      this.renderBenchmarkBar();
      this.renderPodium();
      this.render();

      if (statusEl) {
        const solPct = this.benchmarks.sol?.priceChange24h;
        statusEl.textContent = solPct != null
          ? `SOL ${solPct >= 0 ? '+' : ''}${solPct.toFixed(2)}% 24h`
          : 'LIVE';
        statusEl.parentElement.classList.remove('loading', 'error');
      }
    } catch (err) {
      console.error('[versusPage] load error:', err);
      if (statusEl) {
        statusEl.textContent = 'ERROR';
        statusEl.parentElement.classList.remove('loading');
        statusEl.parentElement.classList.add('error');
      }
      tbody.innerHTML = `
        <tr class="empty-row">
          <td colspan="8">
            <div class="empty-state">
              <span>Failed to load performance data. Please try again.</span>
            </div>
          </td>
        </tr>
      `;
    } finally {
      this._loading = false;
    }
  },

  renderBenchmarkBar() {
    const bar = document.getElementById('versus-benchmark-bar');
    if (!bar) return;

    const fmt = (v) => {
      if (v == null) return '<span class="vs-na">--</span>';
      const sign = v >= 0 ? '+' : '';
      const cls = v >= 0 ? 'vs-pos' : 'vs-neg';
      return `<span class="${cls}">${sign}${v.toFixed(2)}%</span>`;
    };

    const solPrice = this.benchmarks.sol?.price;
    const btcPrice = this.benchmarks.btc?.price;
    const solPct   = this.benchmarks.sol?.priceChange24h;
    const btcPct   = this.benchmarks.btc?.priceChange24h;

    bar.innerHTML = `
      <div class="benchmark-pill">
        <span class="benchmark-label">SOL</span>
        <span class="benchmark-price">${solPrice != null ? utils.formatPrice(solPrice, 2) : '--'}</span>
        <span class="benchmark-change">${fmt(solPct)}</span>
      </div>
      <div class="benchmark-divider"></div>
      <div class="benchmark-pill">
        <span class="benchmark-label">BTC</span>
        <span class="benchmark-price">${btcPrice != null ? utils.formatPrice(btcPrice, 2) : '--'}</span>
        <span class="benchmark-change">${fmt(btcPct)}</span>
      </div>
    `;
  },

  // Returns the tokens sorted by the current sort field, optionally filtered by search
  _getSorted(filterQuery) {
    const solPct = this.benchmarks.sol?.priceChange24h ?? null;
    const btcPct = this.benchmarks.btc?.priceChange24h ?? null;

    let list = this.tokens.map(t => ({
      ...t,
      _vsSol: (t.priceChange24h != null && solPct != null) ? t.priceChange24h - solPct : null,
      _vsBtc: (t.priceChange24h != null && btcPct != null) ? t.priceChange24h - btcPct : null,
    }));

    if (filterQuery) {
      const q = filterQuery.toLowerCase();
      list = list.filter(t =>
        (t.name || '').toLowerCase().includes(q) ||
        (t.symbol || '').toLowerCase().includes(q)
      );
    }

    const dir = this._sortDir === 'asc' ? 1 : -1;
    list.sort((a, b) => {
      let va, vb;
      switch (this._sortField) {
        case 'vsSol':     va = a._vsSol ?? -Infinity;   vb = b._vsSol ?? -Infinity;   break;
        case 'vsBtc':     va = a._vsBtc ?? -Infinity;   vb = b._vsBtc ?? -Infinity;   break;
        case 'change24h': va = a.priceChange24h ?? -Infinity; vb = b.priceChange24h ?? -Infinity; break;
        case 'mcap':      va = a.marketCap || 0;         vb = b.marketCap || 0;         break;
        case 'holders':   va = a.holders || 0;           vb = b.holders || 0;           break;
        default: return 0;
      }
      return (va - vb) * dir;
    });

    return list;
  },

  renderPodium() {
    const podium = document.getElementById('versus-podium');
    if (!podium) return;

    const sorted = this._getSorted(null);
    const top3 = sorted.filter(t => t._vsSol != null).slice(0, 3);

    if (top3.length === 0) {
      podium.style.display = 'none';
      return;
    }

    const defaultLogo = utils.getDefaultLogo();
    const medals = ['🥇', '🥈', '🥉'];
    const labelClass = ['podium-gold', 'podium-silver', 'podium-bronze'];

    // Order: 2nd | 1st | 3rd for visual podium layout
    const displayOrder = [top3[1], top3[0], top3[2]].filter(Boolean);
    const displayMedals = top3[1] ? [medals[1], medals[0], medals[2]] : [medals[0], medals[2]].filter((_, i) => displayOrder[i]);
    const displayClass  = top3[1] ? [labelClass[1], labelClass[0], labelClass[2]] : [labelClass[0], labelClass[2]].filter((_, i) => displayOrder[i]);

    podium.style.display = 'flex';
    podium.innerHTML = displayOrder.map((token, i) => {
      const sign = token._vsSol >= 0 ? '+' : '';
      const logoSrc = utils.escapeHtml(token.logoUri || token.logoURI || defaultLogo);
      const safeName = utils.escapeHtml(token.name || token.symbol || '');
      const safeAddr = utils.escapeHtml(token.mintAddress || token.address || '');
      return `
        <div class="podium-card ${displayClass[i]}" onclick="window.location.href='token.html?mint=${safeAddr}'" style="cursor:pointer;">
          <div class="podium-medal">${displayMedals[i]}</div>
          <img class="podium-logo" src="${logoSrc}" alt="${utils.escapeHtml(token.symbol || '')}"
               onerror="this.onerror=null;this.src='${utils.escapeHtml(defaultLogo)}'">
          <div class="podium-name">${safeName}</div>
          <div class="podium-vs ${token._vsSol >= 0 ? 'vs-pos' : 'vs-neg'}">
            ${sign}${token._vsSol.toFixed(2)}% vs SOL
          </div>
          <div class="podium-raw ${token.priceChange24h >= 0 ? 'vs-pos' : 'vs-neg'}">
            ${token.priceChange24h >= 0 ? '+' : ''}${(token.priceChange24h || 0).toFixed(2)}% 24h
          </div>
        </div>
      `;
    }).join('');
  },

  render() {
    const tbody = document.getElementById('versus-table-body');
    if (!tbody) return;

    const search = document.getElementById('versus-search');
    const query = search ? search.value.trim() : '';
    const sorted = this._getSorted(query);

    if (sorted.length === 0) {
      tbody.innerHTML = `
        <tr class="empty-row">
          <td colspan="8">
            <div class="empty-state">
              <span style="font-size:1.5rem;margin-bottom:0.5rem;opacity:0.4;">NO DATA</span>
              <span>${query ? 'No tokens match your search.' : 'No tokens with price data yet.'}</span>
            </div>
          </td>
        </tr>
      `;
      return;
    }

    const defaultLogo = utils.getDefaultLogo();
    const solPct = this.benchmarks.sol?.priceChange24h ?? null;
    const btcPct = this.benchmarks.btc?.priceChange24h ?? null;

    tbody.innerHTML = sorted.map((token, index) => {
      const address = token.mintAddress || token.address || '';
      if (!address) return '';

      const safeAddress = utils.escapeHtml(address);
      const safeLogo    = utils.escapeHtml(token.logoUri || token.logoURI || defaultLogo);
      const safeName    = utils.escapeHtml(token.name || `${address.slice(0, 4)}...${address.slice(-4)}`);
      const safeSymbol  = utils.escapeHtml(token.symbol || address.slice(0, 5).toUpperCase());

      // 24h % change
      const raw = token.priceChange24h;
      const rawHtml = raw != null
        ? `<span class="mono-num ${raw >= 0 ? 'vs-pos' : 'vs-neg'}">${raw >= 0 ? '+' : ''}${raw.toFixed(2)}%</span>`
        : '<span class="vs-na">--</span>';

      // vs SOL
      const vsSol = token._vsSol;
      const vsSolHtml = vsSol != null
        ? `<span class="mono-num ${vsSol >= 0 ? 'vs-pos' : 'vs-neg'} vs-badge">${vsSol >= 0 ? '+' : ''}${vsSol.toFixed(2)}%</span>`
        : (solPct == null ? '<span class="vs-na">--</span>' : '<span class="vs-na">no data</span>');

      // vs BTC
      const vsBtc = token._vsBtc;
      const vsBtcHtml = vsBtc != null
        ? `<span class="mono-num ${vsBtc >= 0 ? 'vs-pos' : 'vs-neg'}">${vsBtc >= 0 ? '+' : ''}${vsBtc.toFixed(2)}%</span>`
        : (btcPct == null ? '<span class="vs-na">--</span>' : '<span class="vs-na">no data</span>');

      const mcapStr    = utils.formatNumber(token.marketCap, '$');
      const holdersHtml = token.holders
        ? `<span class="mono-num">${token.holders.toLocaleString()}</span>`
        : '<span class="vs-na">--</span>';

      const dist = token.conviction || {};
      const distHtml = Object.keys(dist).length > 0
        ? this.renderMiniBars(dist)
        : '<span class="vs-na">--</span>';

      return `
        <tr class="token-row terminal-row" data-mint="${safeAddress}">
          <td class="cell-rank">${index + 1}</td>
          <td class="cell-token cell-token-clickable" data-navigate="${safeAddress}">
            <div class="token-cell">
              <img class="token-logo" src="${safeLogo}" alt="${safeSymbol}" loading="lazy"
                   onerror="this.onerror=null;this.src='${utils.escapeHtml(defaultLogo)}'">
              <div class="token-info">
                <span class="token-name">${safeName}</span>
                <span class="token-symbol-cell">${safeSymbol}</span>
              </div>
            </div>
          </td>
          <td class="cell-change" data-navigate="${safeAddress}">${rawHtml}</td>
          <td class="cell-vs-sol" data-navigate="${safeAddress}">${vsSolHtml}</td>
          <td class="cell-vs-btc" data-navigate="${safeAddress}">${vsBtcHtml}</td>
          <td class="cell-mcap mono-num" data-navigate="${safeAddress}">${mcapStr}</td>
          <td class="cell-updated" data-navigate="${safeAddress}">${holdersHtml}</td>
          <td class="cell-dist" data-navigate="${safeAddress}">${distHtml}</td>
        </tr>
      `;
    }).join('');

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
  }
};
