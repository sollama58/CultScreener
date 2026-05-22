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
  // Share
  // ---------------------------------------------------------------------------

  /**
   * Share the performance leaderboard URL — uses Web Share API on mobile,
   * falls back to clipboard copy, matching the share button pattern used
   * across the rest of the app.
   */
  async share() {
    const shareUrl = window.location.origin + '/';
    const sortLabel = this.sortField === 'ath'
      ? 'ATH % since listing'
      : 'Current % since listing';
    const title = '🔥 CultScreener Performance Leaderboard';
    const text  = `Top performers sorted by ${sortLabel} — CultScreener`;

    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ title, text, url: shareUrl });
        return;
      } catch (e) {
        if (e.name === 'AbortError') return;
      }
    }

    // Clipboard fallback
    const copied = await utils.copyToClipboard(shareUrl);
    if (copied && typeof toast !== 'undefined') {
      toast.success('Share link copied to clipboard');
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
