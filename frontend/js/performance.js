/**
 * performance.js
 * CultScreener — Performance Leaderboard Page Module
 *
 * Displays token performance since listing, sortable by ATH % or current %.
 * Provides a Canvas-based share card export.
 */

const performancePage = {

  /** @type {Array} All fetched tokens (filtered to those with valid mcapAtAdded) */
  tokens: [],

  /** @type {'ath'|'current'} Active sort field */
  sortField: 'ath',

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------

  /**
   * Bind UI controls and kick off the initial data load.
   * Called from HTML once the DOM is ready.
   */
  init() {
    // Sort buttons
    const btnAth     = document.getElementById('perf-sort-ath');
    const btnCurrent = document.getElementById('perf-sort-current');

    if (btnAth) {
      btnAth.addEventListener('click', () => this.setSortField('ath'));
    }
    if (btnCurrent) {
      btnCurrent.addEventListener('click', () => this.setSortField('current'));
    }

    // Share button
    const btnShare = document.getElementById('perf-share-btn');
    if (btnShare) {
      btnShare.addEventListener('click', () => this.share());
    }

    // Set initial active button state
    this._updateSortButtons();

    // Load data
    this.loadData();
  },

  // ---------------------------------------------------------------------------
  // Data loading
  // ---------------------------------------------------------------------------

  /**
   * Fetch leaderboard data, filter, store, and render.
   */
  async loadData() {
    this._showLoading(true);
    this._setStatusText('Loading…');

    try {
      const data = await api.tokens.leaderboardConviction({ limit: 100, offset: 0 });

      // Accept either a plain array or an object with a tokens/data property
      const raw = Array.isArray(data) ? data : (data.tokens || data.data || []);

      // Keep only tokens that have a valid listing mcap
      this.tokens = raw.filter(
        t => t.mcapAtAdded != null && t.mcapAtAdded > 0
      );

      this._showLoading(false);
      this.render();

      const count = this.tokens.length;
      this._setStatusText(`${count} token${count !== 1 ? 's' : ''} tracked`);
    } catch (err) {
      console.error('[performancePage] loadData error:', err);
      this._showLoading(false);
      this._setStatusText('Failed to load data');
      this._showEmpty(true);
    }
  },

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  /**
   * Sort tokens by the active sort field and render rows into #perf-table-body.
   */
  render() {
    const tbody = document.getElementById('perf-table-body');
    if (!tbody) return;

    if (!this.tokens.length) {
      this._showEmpty(true);
      return;
    }
    this._showEmpty(false);

    const sorted = this._getSortedTokens();

    tbody.innerHTML = sorted.map((token, index) => {
      const rank = index + 1;

      // Percentages
      const athPct     = this._athPct(token);
      const currentPct = this._currentPct(token);

      const athPctHtml     = this._pctHtml(athPct, true);
      const currentPctHtml = this._pctHtml(currentPct, false);

      // Logo
      const logo     = utils.escapeHtml(token.logoUri || '');
      const fallback = utils.escapeHtml(utils.getDefaultLogo ? utils.getDefaultLogo() : '');
      const name     = utils.escapeHtml(token.name   || '—');
      const symbol   = utils.escapeHtml(token.symbol || '');
      const mint     = utils.escapeHtml(token.mintAddress || token.address || '');
      const emergingBadge = token.emergingCult
        ? '<span class="cult-hammer" title="Emerging Cult">🛠️</span>'
        : '';

      // MCap values
      const currentMcap = token.marketCap ? utils.formatNumber(token.marketCap) : '—';

      return `
        <tr class="perf-row" data-mint="${mint}" style="cursor:pointer;">
          <td class="perf-rank">${rank}</td>
          <td class="perf-token-cell">
            <img
              class="perf-logo"
              src="${logo}"
              alt="${symbol}"
              onerror="this.src='${fallback}'"
            />
            <div class="perf-token-info">
              <div class="table-name-line">
                <span class="perf-token-name">${name}</span>${emergingBadge}
              </div>
              <span class="perf-token-symbol">${symbol}</span>
            </div>
          </td>
          <td class="perf-ath-pct">${athPctHtml}</td>
          <td class="perf-current-pct">${currentPctHtml}</td>
          <td class="perf-mcap">${currentMcap}</td>
        </tr>
      `;
    }).join('');

    // Row click → token page
    tbody.querySelectorAll('.perf-row').forEach(row => {
      row.addEventListener('click', () => {
        const mint = row.dataset.mint;
        if (mint) {
          window.location.href = 'token.html?mint=' + encodeURIComponent(mint);
        }
      });
    });
  },

  // ---------------------------------------------------------------------------
  // Sort
  // ---------------------------------------------------------------------------

  /**
   * Change the active sort field, update button states, and re-render.
   * @param {'ath'|'current'} field
   */
  setSortField(field) {
    this.sortField = field;
    this._updateSortButtons();
    this.render();
  },

  // ---------------------------------------------------------------------------
  // Share (screenshot)
  // ---------------------------------------------------------------------------

  async share() {
    const btn = document.getElementById('perf-share-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Capturing…'; }

    try {
      // Lazily load html2canvas (same pattern as token detail page)
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

      const top10 = this._getSortedTokens().slice(0, 10);
      // Pre-fetch logos as data URIs before building the graphic so html2canvas
      // never has to deal with cross-origin image requests at capture time.
      await this._buildShareGraphic(top10);

      const graphic = document.getElementById('perf-share-graphic');
      const canvas = await html2canvas(graphic, {
        backgroundColor: '#0d0e11',
        scale: 2,
        logging: false,
      });

      const blob = await new Promise((resolve, reject) => {
        canvas.toBlob(b => b ? resolve(b) : reject(new Error('Canvas toBlob failed')), 'image/png');
      });

      const sortSlug = this.sortField === 'ath' ? 'ath' : 'current';
      const filename = `cultscreener-performance-top10-${sortSlug}.png`;

      // Try native share with file (mobile)
      if (navigator.share && navigator.canShare) {
        const file = new File([blob], filename, { type: 'image/png' });
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title: 'CultScreener Performance Top 10' });
          return;
        }
      }

      // Fallback: trigger download
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
      console.error('[performancePage] share error:', err);
      if (typeof toast !== 'undefined') toast.error('Screenshot failed — try again');
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg> Screenshot Top 10`; }
    }
  },

  async _buildShareGraphic(tokens) {
    const graphic = document.getElementById('perf-share-graphic');
    if (!graphic) return;

    const isAth = this.sortField === 'ath';
    const sortLabel = isAth ? 'ATH % since Listing' : 'Current % since Listing';
    const now = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

    // Pre-fetch all logos as PNG data URIs via the backend image proxy.
    // The proxy fetches server-side (no CORS restriction) and re-serves with
    // Access-Control-Allow-Origin: *, so drawImage never taints the canvas.
    const logoDataUris = await Promise.all(
      tokens.map(t => this._logoToDataUri(t.logoUri || '', t.symbol))
    );

    const rows = tokens.map((token, i) => {
      const athPct  = this._athPct(token);
      const curPct  = this._currentPct(token);

      const fmtPct = (pct, cls) => pct === null
        ? `<td class="psg-pct psg-na">—</td>`
        : `<td class="psg-pct ${pct >= 0 ? 'psg-positive' : 'psg-negative'} ${cls}">${this._formatPct(pct)}</td>`;

      const hammer  = token.emergingCult ? '<span class="psg-hammer">🛠️</span>' : '';
      const name    = (token.name   || '').replace(/</g, '&lt;');
      const symbol  = (token.symbol || '').replace(/</g, '&lt;');
      const logoSrc = logoDataUris[i]; // already a data URI — no crossOrigin needed
      const logoHtml = `<img class="psg-token-logo" src="${logoSrc}" alt="${symbol}">`;

      return `<tr>
        <td class="psg-rank">${i + 1}</td>
        <td>
          <div class="psg-token-cell">
            ${logoHtml}
            <div>
              <div style="display:flex;align-items:center;gap:5px;">
                <span class="psg-token-name">${name}</span>${hammer}
              </div>
              <span class="psg-token-symbol">${symbol}</span>
            </div>
          </div>
        </td>
        ${fmtPct(athPct, '')}
        ${fmtPct(curPct, 'psg-pct-current')}
      </tr>`;
    }).join('');

    graphic.innerHTML = `
      <div class="psg-header">
        <div class="psg-brand">
          <div>
            <div class="psg-logo">Cult<span>Screener</span></div>
            <div class="psg-subtitle">Performance Leaderboard · Top 10</div>
            <div class="psg-powered-by">Powered by <strong>ASDFASDFA</strong></div>
          </div>
        </div>
        <div class="psg-sort-label">${sortLabel}</div>
      </div>
      <table class="psg-table">
        <thead>
          <tr>
            <th style="width:32px">#</th>
            <th>Token</th>
            <th class="right">ATH %</th>
            <th class="right">Current %</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="psg-footer">
        <span class="psg-url">cultscreener.com</span>
        <span class="psg-ts">${now}</span>
      </div>
    `;

    // Even though srcs are data URIs, browsers decode them asynchronously.
    // Wait for every img to be ready before returning so html2canvas sees
    // fully decoded pixel data, not blank placeholders.
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

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Return tokens sorted by the active sortField.
   * @returns {Array}
   */
  _getSortedTokens() {
    const tokens = [...this.tokens];

    if (this.sortField === 'ath') {
      return tokens.sort((a, b) => {
        const pctA = this._athPct(a);
        const pctB = this._athPct(b);
        // Tokens with no ATH data go to the end
        if (pctA === null && pctB === null) return 0;
        if (pctA === null) return 1;
        if (pctB === null) return -1;
        return pctB - pctA;
      });
    }

    // 'current'
    return tokens.sort((a, b) => {
      const pctA = this._currentPct(a);
      const pctB = this._currentPct(b);
      if (pctA === null && pctB === null) return 0;
      if (pctA === null) return 1;
      if (pctB === null) return -1;
      return pctB - pctA;
    });
  },

  /**
   * Compute ATH % since listing, or null if data is unavailable.
   * @param {Object} token
   * @returns {number|null}
   */
  _athPct(token) {
    if (!token.mcapAth || !token.mcapAtAdded || token.mcapAtAdded <= 0) return null;
    return (token.mcapAth - token.mcapAtAdded) / token.mcapAtAdded * 100;
  },

  /**
   * Compute current MCap % since listing, or null if data is unavailable.
   * @param {Object} token
   * @returns {number|null}
   */
  _currentPct(token) {
    if (!token.marketCap || !token.mcapAtAdded || token.mcapAtAdded <= 0) return null;
    return (token.marketCap - token.mcapAtAdded) / token.mcapAtAdded * 100;
  },

  /**
   * Format a percentage value as "+X,XXX%" with commas. Handles large numbers.
   * @param {number} pct
   * @returns {string}
   */
  _formatPct(pct) {
    const abs    = Math.abs(pct);
    const sign   = pct >= 0 ? '+' : '−';
    const numStr = abs.toLocaleString('en-US', { maximumFractionDigits: 0 });
    return `${sign}${numStr}%`;
  },

  /**
   * Return an HTML string for a percentage cell, colored green/red/grey.
   * @param {number|null} pct
   * @param {boolean}     isAth  — if true, grey out when null (no ATH data)
   * @returns {string}
   */
  _pctHtml(pct, isAth) {
    if (pct === null) {
      return `<span class="pct-na">—</span>`;
    }
    const cls = pct >= 0 ? 'pct-positive' : 'pct-negative';
    return `<span class="${cls}">${this._formatPct(pct)}</span>`;
  },

  /**
   * Toggle the active class on sort buttons.
   */
  _updateSortButtons() {
    const btnAth     = document.getElementById('perf-sort-ath');
    const btnCurrent = document.getElementById('perf-sort-current');

    if (btnAth) {
      btnAth.classList.toggle('active', this.sortField === 'ath');
    }
    if (btnCurrent) {
      btnCurrent.classList.toggle('active', this.sortField === 'current');
    }
  },

  /**
   * Show or hide the loading indicator, and hide/show the table.
   * @param {boolean} show
   */
  _showLoading(show) {
    const el = document.getElementById('perf-loading');
    if (el) el.style.display = show ? '' : 'none';

    const wrap = document.getElementById('perf-table-wrap');
    if (wrap && !show) wrap.style.display = '';
  },

  /**
   * Show or hide the empty state element, and toggle the table accordingly.
   * @param {boolean} show
   */
  _showEmpty(show) {
    const el = document.getElementById('perf-empty');
    if (el) el.style.display = show ? '' : 'none';

    const wrap = document.getElementById('perf-table-wrap');
    if (wrap) wrap.style.display = show ? 'none' : '';
  },

  /**
   * Update the status text span.
   * @param {string} text
   */
  _setStatusText(text) {
    const el = document.getElementById('perf-status');
    if (el) el.textContent = text;
  },

  /**
   * Fetch a remote image and return it as a data URI so html2canvas can render
   * it without any cross-origin restrictions. Falls back to a letter-avatar SVG
   * if the URL is missing, times out, or the server lacks CORS headers.
   *
   * Strategy: try with crossOrigin='anonymous' first (works when the CDN sets
   * Access-Control-Allow-Origin). If the canvas would be tainted (no CORS header
   * on the server), the drawImage call throws a SecurityError and we fall through
   * to the letter avatar.
   */
  async _logoToDataUri(url, symbol) {
    const avatar = this._letterAvatar(symbol);
    if (!url) return avatar;

    // Route through our own backend proxy so CORS is never an issue —
    // the server fetches the image and re-serves it with Access-Control-Allow-Origin: *.
    const proxied = `/api/image-proxy?url=${encodeURIComponent(url)}`;

    return new Promise((resolve) => {
      const img = new Image();

      const timer = setTimeout(() => {
        img.onload = img.onerror = null;
        resolve(avatar);
      }, 6000);

      img.onload = () => {
        clearTimeout(timer);
        try {
          const c = document.createElement('canvas');
          c.width = 30; c.height = 30;
          const ctx = c.getContext('2d');
          ctx.beginPath();
          ctx.arc(15, 15, 15, 0, Math.PI * 2);
          ctx.clip();
          ctx.drawImage(img, 0, 0, 30, 30);
          resolve(c.toDataURL('image/png'));
        } catch (_) {
          resolve(avatar);
        }
      };

      img.onerror = () => { clearTimeout(timer); resolve(avatar); };
      img.src = proxied;
    });
  },

  /** Return a PNG data URI (canvas-drawn) showing the first letter of the symbol.
   *  Using canvas PNG instead of SVG because html2canvas cannot render SVG data URIs. */
  _letterAvatar(symbol) {
    const s = (symbol || '?').charAt(0).toUpperCase();
    const c = document.createElement('canvas');
    c.width = 30; c.height = 30;
    const ctx = c.getContext('2d');
    ctx.beginPath();
    ctx.arc(15, 15, 15, 0, Math.PI * 2);
    ctx.fillStyle = '#1a1c22';
    ctx.fill();
    ctx.fillStyle = '#ff5722';
    ctx.font = 'bold 14px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(s, 15, 16);
    return c.toDataURL('image/png');
  },
};
