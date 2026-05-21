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
              <span class="perf-token-name">${name}</span>
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
  // Share (Canvas)
  // ---------------------------------------------------------------------------

  /**
   * Draw a 1200×675 share card with the top-10 performers and download it as PNG.
   */
  async share() {
    const btnShare = document.getElementById('perf-share-btn');

    // Show loading state on button
    let originalText = '';
    if (btnShare) {
      originalText = btnShare.textContent;
      btnShare.textContent = 'Generating…';
      btnShare.disabled = true;
    }

    try {
      // Wait for web fonts so Inter / system fonts are available
      await document.fonts.ready;

      const W = 1200;
      const H = 675;

      const canvas  = document.createElement('canvas');
      canvas.width  = W;
      canvas.height = H;
      const ctx     = canvas.getContext('2d');

      const sorted = this._getSortedTokens();
      const top10  = sorted.slice(0, 10);

      // ------------------------------------------------------------------
      // 1. Background
      // ------------------------------------------------------------------
      ctx.fillStyle = '#09090b';
      ctx.fillRect(0, 0, W, H);

      // ------------------------------------------------------------------
      // 2. Dot grid
      // ------------------------------------------------------------------
      ctx.fillStyle = 'rgba(255,255,255,0.04)';
      const DOT_SPACING = 40;
      for (let x = DOT_SPACING; x < W; x += DOT_SPACING) {
        for (let y = DOT_SPACING; y < H; y += DOT_SPACING) {
          ctx.beginPath();
          ctx.arc(x, y, 1, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // ------------------------------------------------------------------
      // 3. Top accent bar (y=0, h=5)
      // ------------------------------------------------------------------
      const accentGrad = ctx.createLinearGradient(0, 0, W, 0);
      accentGrad.addColorStop(0,    '#ff4500');
      accentGrad.addColorStop(0.5,  '#ff5722');
      accentGrad.addColorStop(1,    '#ff8c00');
      ctx.fillStyle = accentGrad;
      ctx.fillRect(0, 0, W, 5);

      // ------------------------------------------------------------------
      // 4. Header area (y=5 to y=75)
      // ------------------------------------------------------------------

      // Left: "🔥 CultScreener"
      ctx.font         = 'bold 26px Inter, system-ui, sans-serif';
      ctx.fillStyle    = '#ffffff';
      ctx.textAlign    = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText('🔥 CultScreener', 48, 42);

      // Right top: "TOP PERFORMERS"
      ctx.font         = '700 11px Inter, system-ui, sans-serif';
      ctx.fillStyle    = '#ff5722';
      ctx.textAlign    = 'right';
      ctx.textBaseline = 'alphabetic';
      ctx.letterSpacing = '0.1em'; // may not work in all browsers but harmless
      ctx.fillText('TOP PERFORMERS', 1152, 30);

      // Right bottom: subtitle
      ctx.font      = '11px Inter, system-ui, sans-serif';
      ctx.fillStyle = '#6b7280';
      ctx.fillText('Since Listing  •  cultscreener.com', 1152, 50);

      // Reset letter spacing
      ctx.letterSpacing = '0em';

      // ------------------------------------------------------------------
      // 5. Thin separator at y=75
      // ------------------------------------------------------------------
      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.lineWidth   = 1;
      ctx.beginPath();
      ctx.moveTo(0, 75);
      ctx.lineTo(W, 75);
      ctx.stroke();

      // ------------------------------------------------------------------
      // 6. Title block (y=75 to y=130)
      // ------------------------------------------------------------------

      // "Performance Leaderboard"
      ctx.font         = 'bold 32px Inter, system-ui, sans-serif';
      ctx.fillStyle    = '#ffffff';
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText('Performance Leaderboard', W / 2, 115);

      // Sub-label
      const sortLabel = this.sortField === 'ath'
        ? 'Sorted by ATH % since listing'
        : 'Sorted by Current % since listing';
      ctx.font      = '13px Inter, system-ui, sans-serif';
      ctx.fillStyle = '#6b7280';
      ctx.fillText(sortLabel, W / 2, 133);

      // ------------------------------------------------------------------
      // 7. Column header row (y=130 to y=158)
      // ------------------------------------------------------------------
      ctx.font         = '700 10px Inter, system-ui, sans-serif';
      ctx.fillStyle    = '#4b5563';
      ctx.textBaseline = 'middle';
      const COL_HDR_Y  = 144;

      ctx.textAlign = 'left';
      ctx.fillText('RANK',         52,   COL_HDR_Y);
      ctx.fillText('TOKEN',        120,  COL_HDR_Y);
      ctx.fillText('LISTED MCAP',  460,  COL_HDR_Y);
      ctx.fillText('ATH MCAP',     620,  COL_HDR_Y);
      ctx.fillText('ATH %',        790,  COL_HDR_Y);
      ctx.fillText('CURRENT MCAP', 910,  COL_HDR_Y);

      ctx.textAlign = 'right';
      ctx.fillText('VS LISTING',   1148, COL_HDR_Y);

      // Separator under headers
      ctx.strokeStyle = 'rgba(255,255,255,0.06)';
      ctx.lineWidth   = 1;
      ctx.beginPath();
      ctx.moveTo(0, 158);
      ctx.lineTo(W, 158);
      ctx.stroke();

      // ------------------------------------------------------------------
      // 8. Token rows (y starting at 158, each 48px)
      // ------------------------------------------------------------------
      const ROW_START  = 158;
      const ROW_HEIGHT = 48;

      top10.forEach((token, i) => {
        const rowY   = ROW_START + i * ROW_HEIGHT;
        const rowMid = rowY + ROW_HEIGHT / 2;

        // Alternating background
        if (i % 2 === 0) {
          ctx.fillStyle = 'rgba(255,255,255,0.02)';
          ctx.fillRect(0, rowY, W, ROW_HEIGHT);
        }

        // --- Rank circle ---
        const rankX = 70;
        ctx.beginPath();
        ctx.arc(rankX, rowMid, 13, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,87,34,0.15)';
        ctx.fill();

        ctx.font         = 'bold 11px Inter, system-ui, sans-serif';
        ctx.fillStyle    = '#ff5722';
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(i + 1), rankX, rowMid);

        // --- Token name + symbol ---
        const nameMaxW = 160;
        const nameY    = rowMid - 7;
        const symY     = rowMid + 8;

        // Clip name to avoid overflow
        ctx.save();
        ctx.beginPath();
        ctx.rect(120, rowY, nameMaxW, ROW_HEIGHT);
        ctx.clip();

        ctx.font         = 'bold 13px Inter, system-ui, sans-serif';
        ctx.fillStyle    = '#ffffff';
        ctx.textAlign    = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(token.name || '—', 120, nameY);

        ctx.font      = '11px Inter, system-ui, sans-serif';
        ctx.fillStyle = '#6b7280';
        ctx.fillText(token.symbol || '', 120, symY);

        ctx.restore();

        // --- Listed MCap ---
        ctx.font         = '12px "Roboto Mono", "Courier New", monospace';
        ctx.fillStyle    = '#9ca3af';
        ctx.textAlign    = 'left';
        ctx.textBaseline = 'middle';
        const listedMcap = token.mcapAtAdded
          ? utils.formatNumber(token.mcapAtAdded, '$')
          : '—';
        ctx.fillText(listedMcap, 460, rowMid);

        // --- ATH MCap ---
        ctx.fillStyle = '#d1d5db';
        const athMcap = token.mcapAth
          ? utils.formatNumber(token.mcapAth, '$')
          : '—';
        ctx.fillText(athMcap, 620, rowMid);

        // --- ATH % ---
        const athPct = this._athPct(token);
        ctx.font         = 'bold 15px Inter, system-ui, sans-serif';
        ctx.textAlign    = 'left';
        ctx.textBaseline = 'middle';
        if (athPct === null) {
          ctx.fillStyle = '#6b7280';
          ctx.fillText('—', 790, rowMid);
        } else {
          ctx.fillStyle = athPct >= 0 ? '#10b981' : '#ef4444';
          ctx.fillText(this._formatPct(athPct), 790, rowMid);
        }

        // --- Current MCap ---
        ctx.font         = '12px "Roboto Mono", "Courier New", monospace';
        ctx.fillStyle    = '#9ca3af';
        ctx.textAlign    = 'left';
        ctx.textBaseline = 'middle';
        const currentMcap = token.marketCap
          ? utils.formatNumber(token.marketCap, '$')
          : '—';
        ctx.fillText(currentMcap, 910, rowMid);

        // --- VS Listing % ---
        const curPct = this._currentPct(token);
        ctx.font         = 'bold 13px Inter, system-ui, sans-serif';
        ctx.textAlign    = 'right';
        ctx.textBaseline = 'middle';
        if (curPct === null) {
          ctx.fillStyle = '#6b7280';
          ctx.fillText('—', 1148, rowMid);
        } else {
          ctx.fillStyle = curPct >= 0 ? '#10b981' : '#ef4444';
          ctx.fillText(this._formatPct(curPct), 1148, rowMid);
        }

        // Row separator
        ctx.strokeStyle = 'rgba(255,255,255,0.04)';
        ctx.lineWidth   = 1;
        ctx.beginPath();
        ctx.moveTo(24, rowY + ROW_HEIGHT);
        ctx.lineTo(W - 24, rowY + ROW_HEIGHT);
        ctx.stroke();
      });

      // ------------------------------------------------------------------
      // 9. Footer
      // ------------------------------------------------------------------

      // Thin line at y=643
      ctx.strokeStyle = 'rgba(255,255,255,0.06)';
      ctx.lineWidth   = 1;
      ctx.beginPath();
      ctx.moveTo(0, 643);
      ctx.lineTo(W, 643);
      ctx.stroke();

      // Footer text centered
      ctx.font         = '11px Inter, system-ui, sans-serif';
      ctx.fillStyle    = '#4b5563';
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('cultscreener.com  •  Live Solana Token Analytics', W / 2, 659);

      // ------------------------------------------------------------------
      // 10. Download
      // ------------------------------------------------------------------
      const link    = document.createElement('a');
      link.download = 'cultscreener-performance.png';
      link.href     = canvas.toDataURL('image/png');
      link.click();

    } catch (err) {
      console.error('[performancePage] share error:', err);
    } finally {
      // Restore share button
      if (btnShare) {
        btnShare.textContent = originalText;
        btnShare.disabled    = false;
      }
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
};
