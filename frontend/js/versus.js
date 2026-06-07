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
    const btnShare = document.getElementById('versus-share-btn');
    if (btnShare) btnShare.addEventListener('click', () => this.share());
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
  },

  async share() {
    const btn = document.getElementById('versus-share-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Capturing…'; }

    try {
      if (typeof html2canvas === 'undefined') {
        await Promise.race([
          new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
            s.crossOrigin = 'anonymous';
            s.onload = resolve;
            s.onerror = () => reject(new Error('Failed to load screenshot library'));
            document.head.appendChild(s);
          }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 8000))
        ]);
      }

      const sorted = this._getSorted(null);
      const top3 = sorted.filter(t => t._vsSol != null).slice(0, 3);
      if (top3.length === 0) {
        if (typeof toast !== 'undefined') toast.error('No data to share yet');
        return;
      }

      await this._buildShareGraphic(top3);

      const graphic = document.getElementById('versus-share-graphic');
      const canvas = await html2canvas(graphic, {
        backgroundColor: '#0d0e11',
        scale: 2,
        logging: false,
      });

      const blob = await new Promise((resolve, reject) => {
        canvas.toBlob(b => b ? resolve(b) : reject(new Error('Canvas toBlob failed')), 'image/png');
      });

      const filename = 'cultscreener-vs-sol-top3.png';

      if (navigator.share && navigator.canShare) {
        const file = new File([blob], filename, { type: 'image/png' });
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title: 'CultScreener — Top 3 vs SOL' });
          return;
        }
      }

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 5000);

      if (typeof toast !== 'undefined') toast.success('Screenshot saved!');
    } catch (err) {
      console.error('[versusPage] share error:', err);
      if (typeof toast !== 'undefined') toast.error('Screenshot failed — try again');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg> Share Top 3`;
      }
    }
  },

  async _buildShareGraphic(top3) {
    const graphic = document.getElementById('versus-share-graphic');
    if (!graphic) return;

    const now = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

    const logoDataUris = await Promise.all(
      top3.map(t => this._logoToDataUri(t.logoUri || t.logoURI || '', t.symbol))
    );

    const fmtPct = (v) => {
      if (v == null) return '--';
      const sign = v >= 0 ? '+' : '';
      return `${sign}${v.toFixed(2)}%`;
    };

    const solPct = this.benchmarks.sol?.priceChange24h;
    const btcPct = this.benchmarks.btc?.priceChange24h;
    const solPrice = this.benchmarks.sol?.price;
    const btcPrice = this.benchmarks.btc?.price;

    const benchHtml = `
      <div class="vsg-benchmarks">
        <div class="vsg-bench-pill">
          <span class="vsg-bench-name">SOL</span>
          <span class="vsg-bench-price">${solPrice != null ? '$' + solPrice.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '--'}</span>
          <span class="vsg-bench-chg ${solPct == null ? '' : solPct >= 0 ? 'pos' : 'neg'}">${solPct != null ? fmtPct(solPct) : '--'} 24h</span>
        </div>
        <div class="vsg-bench-pill">
          <span class="vsg-bench-name">BTC</span>
          <span class="vsg-bench-price">${btcPrice != null ? '$' + btcPrice.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 }) : '--'}</span>
          <span class="vsg-bench-chg ${btcPct == null ? '' : btcPct >= 0 ? 'pos' : 'neg'}">${btcPct != null ? fmtPct(btcPct) : '--'} 24h</span>
        </div>
      </div>
    `;

    const medals = ['🥇', '🥈', '🥉'];
    const cardClass = ['gold', 'silver', 'bronze'];
    // Visual podium order: 2nd | 1st | 3rd — build slots then drop any undefined slots
    const slots = [
      { token: top3[1], logo: logoDataUris[1], medal: medals[1], cls: cardClass[1] },
      { token: top3[0], logo: logoDataUris[0], medal: medals[0], cls: cardClass[0] },
      { token: top3[2], logo: logoDataUris[2], medal: medals[2], cls: cardClass[2] },
    ].filter(s => s.token != null);

    const cardsHtml = slots.map(({ token, logo, medal, cls }) => {
      const vsSol = token._vsSol;
      const rawChg = token.priceChange24h;
      const safeName = (token.name || token.symbol || '').replace(/</g, '&lt;').slice(0, 14);
      const safeSym = (token.symbol || '').replace(/</g, '&lt;');
      return `
        <div class="vsg-card ${cls}">
          <div class="vsg-medal">${medal}</div>
          <img class="vsg-logo-img" src="${logo}" alt="${safeSym}">
          <span class="vsg-token-name">${safeName}</span>
          <span class="vsg-token-symbol">${safeSym}</span>
          <span class="vsg-vs-sol ${vsSol >= 0 ? 'pos' : 'neg'}">${fmtPct(vsSol)}</span>
          <span class="vsg-vs-sol-label">vs SOL</span>
          <span class="vsg-raw-chg">${rawChg != null ? fmtPct(rawChg) + ' 24h' : '--'}</span>
        </div>
      `;
    }).join('');

    graphic.innerHTML = `
      <div class="vsg-header">
        <div>
          <div class="vsg-logo">Cult<span>Screener</span></div>
          <div class="vsg-subtitle">Top 3 Performers vs SOL</div>
          <div class="vsg-powered-by">Powered by <strong>ASDFASDFA</strong></div>
        </div>
        <div class="vsg-date">${now}</div>
      </div>
      ${benchHtml}
      <div class="vsg-podium-area">${cardsHtml}</div>
      <div class="vsg-footer">
        <span class="vsg-url">cultscreener.com</span>
        <span class="vsg-ts">via CultScreener</span>
      </div>
    `;

    const domImgs = [...graphic.querySelectorAll('img')];
    if (domImgs.length) {
      await Promise.all(domImgs.map(img =>
        img.complete ? Promise.resolve() :
        new Promise(resolve => {
          img.addEventListener('load',  resolve, { once: true });
          img.addEventListener('error', resolve, { once: true });
          setTimeout(resolve, 2000);
        })
      ));
    }
  },

  async _logoToDataUri(url, symbol) {
    const avatar = this._letterAvatar(symbol);
    if (!url) return avatar;

    const apiBase = (typeof API_BASE_URL !== 'undefined') ? API_BASE_URL : '';
    const proxied = `${apiBase}/api/image-proxy?url=${encodeURIComponent(url)}`;

    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';

      const timer = setTimeout(() => {
        img.onload = img.onerror = null;
        resolve(avatar);
      }, 6000);

      img.onload = () => {
        clearTimeout(timer);
        try {
          const c = document.createElement('canvas');
          c.width = 36; c.height = 36;
          const ctx = c.getContext('2d');
          ctx.beginPath();
          ctx.arc(18, 18, 18, 0, Math.PI * 2);
          ctx.clip();
          ctx.drawImage(img, 0, 0, 36, 36);
          resolve(c.toDataURL('image/png'));
        } catch (_) {
          resolve(avatar);
        }
      };

      img.onerror = () => { clearTimeout(timer); resolve(avatar); };
      img.src = proxied;
    });
  },

  _letterAvatar(symbol) {
    const s = (symbol || '?').charAt(0).toUpperCase();
    const c = document.createElement('canvas');
    c.width = 36; c.height = 36;
    const ctx = c.getContext('2d');
    ctx.beginPath();
    ctx.arc(18, 18, 18, 0, Math.PI * 2);
    ctx.fillStyle = '#1a1c22';
    ctx.fill();
    ctx.fillStyle = '#ff5722';
    ctx.font = 'bold 16px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(s, 18, 19);
    return c.toDataURL('image/png');
  },
};
