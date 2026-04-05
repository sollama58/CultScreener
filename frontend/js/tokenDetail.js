// Token Detail Page Logic
const tokenDetail = {
  mint: null,
  token: null,
  chart: null,
  chartType: 'line',
  chartMetric: 'price', // 'price' or 'mcap'
  currentInterval: '1h',
  chartData: null,
  pools: [],

  priceRefreshInterval: null,
  freshnessInterval: null,
  lastPriceUpdate: null,
  _consecutivePriceErrors: 0, // Circuit breaker for price refresh
  _chartPreload: null, // In-flight promise for the default chart interval; reused by loadChart()
  modalChart: null,
  _modalOpen: false,
  _modalEscHandler: null,
  indicators: { vol: true, sma: false, ema: false, bb: false },
  logScale: false,
  _mainSeries: null,
  _modalMainSeries: null,
  _chartRefreshInterval: null,

  // Get refresh interval from config (with fallback)
  get refreshIntervalMs() {
    return (typeof config !== 'undefined' && config.cache?.priceRefresh) || 300000;
  },

  // Get stale threshold from config (with fallback)
  get staleThresholdMs() {
    return (typeof config !== 'undefined' && config.cache?.priceStaleThreshold) || 120000;
  },

  // Initialize
  async init() {
    this.mint = utils.getUrlParam('mint');

    if (!this.mint || !utils.isValidSolanaAddress(this.mint)) {
      this.showError('Invalid token address provided.');
      return;
    }

    this.bindEvents();

    try {
      await this.loadToken();
      this.hideLoading();

      // Yield to the browser so it can reflow the just-shown #token-content.
      // Without this, chart containers may still report 0 dimensions and LWCV
      // throws "Value is null" on createChart().
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

      this.lastPriceUpdate = Date.now();
      this.updateFreshnessDisplay();

      // Record page view (fire-and-forget, non-blocking)
      this.recordView();

      // Load additional data in parallel
      await Promise.all([
        this.loadPools(),
        sentiment.loadForToken(this.mint), // Load community sentiment
        this.loadHolderAnalytics(), // Load holder concentration data
        this.loadCuratedData() // Load DexScreener curated data (banner + socials)
      ]);

      // Start price refresh and freshness timer
      this.startPriceRefresh();
      this.startFreshnessTimer();

      // Update watchlist button once watchlist finishes loading (may still be in-flight)
      this.updateWatchlistButton();
      window.addEventListener('watchlistReady', () => this.updateWatchlistButton(), { once: true });
      window.addEventListener('walletConnected', () => {
        setTimeout(() => this.updateWatchlistButton(), 500);
      });
    } catch (error) {
      console.error('Failed to initialize token page:', error);
      this.showError('Failed to load token data. Please try again.');
    }
  },

  // Show loading state
  showLoading() {
    const loading = document.getElementById('loading-state');
    const content = document.getElementById('token-content');
    const error = document.getElementById('error-state');

    if (loading) loading.style.display = 'flex';
    if (content) content.style.display = 'none';
    if (error) error.style.display = 'none';
  },

  // Hide loading and show content
  hideLoading() {
    const loading = document.getElementById('loading-state');
    const content = document.getElementById('token-content');

    if (loading) loading.style.display = 'none';
    if (content) content.style.display = 'block';
  },

  // Show error state
  showError(message) {
    const loading = document.getElementById('loading-state');
    const content = document.getElementById('token-content');
    const error = document.getElementById('error-state');
    const errorMsg = document.getElementById('error-message');

    if (loading) loading.style.display = 'none';
    if (content) content.style.display = 'none';
    if (error) error.style.display = 'flex';
    if (errorMsg) errorMsg.textContent = message;
  },

  // Store bound event handlers for cleanup
  boundHandlers: new Map(),

  // Bind events with cleanup tracking
  bindEvents() {
    // Clear any existing handlers first (prevent memory leaks on re-init)
    this.unbindEvents();

    // Helper to track handlers for later cleanup
    const bindHandler = (element, event, handler) => {
      if (!element) return;
      element.addEventListener(event, handler);
      if (!this.boundHandlers.has(element)) {
        this.boundHandlers.set(element, []);
      }
      this.boundHandlers.get(element).push({ event, handler });
    };

    // Copy address button
    const copyBtn = document.getElementById('copy-address');
    const copyHandler = async () => {
      const copied = await utils.copyToClipboard(this.mint);
      if (copied) {
        toast.success('Address copied to clipboard');
      }
    };
    bindHandler(copyBtn, 'click', copyHandler);

    // Address click also copies
    const addressEl = document.getElementById('token-address');
    bindHandler(addressEl, 'click', copyHandler);

    // Share button
    const shareBtn = document.getElementById('share-btn');
    const shareHandler = async () => {
      const copied = await utils.copyToClipboard(window.location.href);
      if (copied) toast.success('Link copied to clipboard');
    };
    bindHandler(shareBtn, 'click', shareHandler);

    // Watchlist button
    const watchlistBtn = document.getElementById('watchlist-btn');
    const watchlistHandler = async () => {
      if (!this.mint) return;
      watchlistBtn.disabled = true;
      await watchlist.toggle(this.mint);
      this.updateWatchlistButton();
      watchlistBtn.disabled = false;
    };
    bindHandler(watchlistBtn, 'click', watchlistHandler);

    // Chart type toggle (line/candle)
    const chartTypeBtns = document.querySelectorAll('.chart-type-btn:not(.modal-type-btn)');
    const modalTypeBtns = document.querySelectorAll('.modal-type-btn');
    chartTypeBtns.forEach(btn => {
      const handler = () => {
        chartTypeBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        // Sync modal type buttons
        modalTypeBtns.forEach(b => b.classList.toggle('active', b.dataset.type === btn.dataset.type));
        this.chartType = btn.dataset.type;
        if (this.chartData) {
          this.renderChart(this.chartData);
          if (this._modalOpen) this._renderModalChart();
        }
      };
      bindHandler(btn, 'click', handler);
    });

    // Chart metric toggle (price/mcap)
    const chartMetricBtns = document.querySelectorAll('.chart-metric-btn:not(.modal-metric-btn)');
    const modalMetricBtns = document.querySelectorAll('.modal-metric-btn');
    chartMetricBtns.forEach(btn => {
      const handler = () => {
        chartMetricBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        // Sync modal metric buttons
        modalMetricBtns.forEach(b => b.classList.toggle('active', b.dataset.metric === btn.dataset.metric));
        this.chartMetric = btn.dataset.metric;

        // Update chart title
        const titleEl = document.getElementById('chart-title');
        if (titleEl) {
          titleEl.textContent = this.chartMetric === 'mcap' ? 'Market Cap Chart' : 'Price Chart';
        }
        const mt = document.getElementById('chart-modal-title');
        if (mt) mt.textContent = this.chartMetric === 'mcap' ? 'Market Cap Chart' : 'Price Chart';
        if (this.chartData) {
          this.renderChart(this.chartData);
          this.updateChartStats(this.chartData);
          if (this._modalOpen) {
            this._renderModalChart();
            this._updateModalStats(this.chartData);
          }
        }
      };
      bindHandler(btn, 'click', handler);
    });

    // Chart timeframes (page only — modal timeframes bound in _bindModalControls)
    const timeframeBtns = document.querySelectorAll('.timeframe-btn:not(.modal-timeframe-btn)');
    const modalTimeframeBtns = document.querySelectorAll('.modal-timeframe-btn');
    timeframeBtns.forEach(btn => {
      const handler = () => {
        timeframeBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.currentInterval = btn.dataset.interval;
        // Sync modal timeframe buttons
        modalTimeframeBtns.forEach(b => {
          b.classList.toggle('active', b.dataset.interval === btn.dataset.interval);
        });

        this.loadChart(this.currentInterval);
        if (this._modalOpen) this._renderModalChart();
      };
      bindHandler(btn, 'click', handler);
    });

    // Chart fit button (reset zoom)
    const fitBtn = document.getElementById('chart-fit-btn');
    if (fitBtn) {
      bindHandler(fitBtn, 'click', () => {
        if (this.chart) this.chart.timeScale().fitContent();
      });
    }

    // Chart expand button
    const expandBtn = document.getElementById('chart-expand-btn');
    if (expandBtn) {
      bindHandler(expandBtn, 'click', () => this.openChartModal());
    }

    // Indicator toggle buttons
    const indicatorBtns = document.querySelectorAll('.indicator-btn:not(.modal-indicator-btn)');
    const modalIndicatorLogBtns = document.querySelectorAll('.modal-indicator-btn[data-indicator="log"]');
    indicatorBtns.forEach(btn => {
      const handler = () => {
        const ind = btn.dataset.indicator;

        // Log scale is a separate toggle, not a regular indicator
        if (ind === 'log') {
          this.logScale = !this.logScale;
          btn.classList.toggle('active', this.logScale);
          modalIndicatorLogBtns.forEach(b =>
            b.classList.toggle('active', this.logScale)
          );
          if (this.chartData) {
            this.renderChart(this.chartData);
            if (this._modalOpen) this._renderModalChart();
          }
          return;
        }

        this.indicators[ind] = !this.indicators[ind];
        btn.classList.toggle('active', this.indicators[ind]);
        // Sync modal buttons
        document.querySelectorAll(`.modal-indicator-btn[data-indicator="${ind}"]`).forEach(b =>
          b.classList.toggle('active', this.indicators[ind])
        );
        if (this.chartData) {
          this.renderChart(this.chartData);
          if (this._modalOpen) this._renderModalChart();
        }
      };
      bindHandler(btn, 'click', handler);
    });

    // Holders refresh button — only allow if data is >1 minute stale
    const holdersRefreshBtn = document.getElementById('holders-refresh');
    const holdersRefreshHandler = () => {
      if (this._holdersRefreshing) return;
      const elapsed = this._holdersUpdatedAt ? Date.now() - this._holdersUpdatedAt : Infinity;
      if (elapsed < 60000) {
        const secs = Math.ceil((60000 - elapsed) / 1000);
        const updatedEl = document.getElementById('holders-updated');
        if (updatedEl) updatedEl.textContent = `Refresh available in ${secs}s`;
        return;
      }
      this._holdersRefreshing = true;
      this.loadHolderAnalytics(true).finally(() => {
        this._holdersRefreshing = false;
      });
    };
    bindHandler(holdersRefreshBtn, 'click', holdersRefreshHandler);

    // Share holder analytics screenshot
    const holdersShareBtn = document.getElementById('holders-share');
    bindHandler(holdersShareBtn, 'click', () => this._shareHolderAnalytics());

    // Holders expand/collapse button
    const holdersExpandBtn = document.getElementById('holders-expand');
    const holdersExpandHandler = () => {
      if (!this._holdersData) return;
      this._holdersExpanded = !this._holdersExpanded;
      const total = this._holdersData.length;
      const limit = this._holdersExpanded ? total : 10;
      this._renderHoldersTable(this._holdersData, limit);
      // Re-apply hold time data to newly rendered rows
      this._applyHoldTimesToDOM();
      if (holdersExpandBtn) {
        holdersExpandBtn.innerHTML = this._holdersExpanded
          ? 'Show Top 10 <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>'
          : `Show All ${total} <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;
      }
    };
    bindHandler(holdersExpandBtn, 'click', holdersExpandHandler);

    // Visibility change handler for pausing/resuming intervals
    this.visibilityHandler = () => {
      if (document.visibilityState === 'hidden') {
        // Page is hidden, clear intervals to save resources
        if (this.priceRefreshInterval) {
          clearInterval(this.priceRefreshInterval);
          this.priceRefreshInterval = null;
        }
        if (this.freshnessInterval) {
          clearInterval(this.freshnessInterval);
          this.freshnessInterval = null;
        }
      } else if (document.visibilityState === 'visible') {
        // Page is visible again, restart intervals if needed
        if (!this.priceRefreshInterval && this.mint) {
          this.refreshPrice(); // Immediate refresh when becoming visible
          this.startPriceRefresh();
        }
        if (!this.freshnessInterval && this.lastPriceUpdate) {
          this.updateFreshnessDisplay();
          this.startFreshnessTimer();
        }
      }
    };
    document.addEventListener('visibilitychange', this.visibilityHandler);
  },

  // Remove all bound event listeners
  unbindEvents() {
    for (const [element, handlers] of this.boundHandlers) {
      for (const { event, handler } of handlers) {
        element.removeEventListener(event, handler);
      }
    }
    this.boundHandlers.clear();

    // Remove visibility handler
    if (this.visibilityHandler) {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
    }
  },

  // Start price refresh (configurable via config.cache.priceRefresh)
  // Circuit breaker: after 3 consecutive failures, double interval (up to 10min)
  startPriceRefresh() {
    if (this.priceRefreshInterval) clearInterval(this.priceRefreshInterval);
    const baseInterval = this.refreshIntervalMs;
    const backoffMultiplier = this._consecutivePriceErrors >= 3
      ? Math.min(Math.pow(2, this._consecutivePriceErrors - 2), 5) : 1;
    const interval = Math.min(baseInterval * backoffMultiplier, 600000);
    this.priceRefreshInterval = setInterval(() => {
      if (document.visibilityState === 'visible' && typeof isRateLimited === 'function' && !isRateLimited()) {
        this.refreshPrice();
      }
    }, interval);
  },

  // Refresh just the price - uses lightweight price endpoint instead of full token data
  async refreshPrice() {
    // Show loading state while fetching
    const priceContainer = document.querySelector('.token-price-container');
    if (priceContainer) priceContainer.classList.add('price-refreshing');

    const freshnessEl = document.getElementById('price-freshness');
    let spinner = null;
    if (freshnessEl) {
      spinner = document.createElement('span');
      spinner.className = 'price-refresh-spinner';
      spinner.title = 'Refreshing price…';
      freshnessEl.appendChild(spinner);
    }

    try {
      const data = await api.tokens.getPrice(this.mint);
      if (data && data.price) {
        this.token.price = data.price;
        if (data.priceChange24h !== undefined) {
          this.token.priceChange24h = data.priceChange24h;
        }
        this.updatePriceDisplay();
        this.lastPriceUpdate = Date.now();
        this.updateFreshnessDisplay();
      }
      // Reset circuit breaker on success
      if (this._consecutivePriceErrors > 0) {
        this._consecutivePriceErrors = 0;
        this.startPriceRefresh();
      }
    } catch (error) {
      console.error('Price refresh failed:', error);
      this._consecutivePriceErrors++;
      if (this._consecutivePriceErrors >= 3) {
        this.startPriceRefresh(); // Restart with backed-off interval
      }
    } finally {
      if (priceContainer) priceContainer.classList.remove('price-refreshing');
      if (spinner) spinner.remove();
    }
  },

  // Load token data
  async loadToken() {
    const _t0 = performance.now();
    let _ok = true;
    try {
      if (config.app.debug) console.log('[TokenDetail] Loading token:', this.mint);
      this.token = await api.tokens.get(this.mint);

      if (config.app.debug) console.log('[TokenDetail] Token data received:', JSON.stringify(this.token, null, 2));

      if (!this.token) {
        throw new Error('Token not found');
      }

      const isPreview = !this.token.holders;
      this.renderToken();

      // If initial data came from list-page preview (sessionStorage seed), fetch full detail
      if (isPreview) {
        const mint = this.mint;
        api.tokens.get(mint, { fresh: true }).then(fullData => {
          if (this.mint !== mint || !fullData) return;
          this.token = fullData;
          this.renderToken();
        }).catch(() => {});
      }
    } catch (err) {
      _ok = false;
      throw err;
    } finally {
      if (typeof latencyTracker !== 'undefined') latencyTracker.record('tokenDetail.load', performance.now() - _t0, _ok, 'frontend');
    }
  },

  // Update price display only
  updatePriceDisplay() {
    // Price is now always a direct number from the API
    const price = this.token.price || 0;
    const change = this.token.priceChange24h || 0;

    if (config.app.debug) console.log('[TokenDetail] Price display:', { price, change, token: this.token });

    const changeEl = document.getElementById('price-change');
    const priceEl = document.getElementById('token-price');

    if (priceEl) priceEl.textContent = utils.formatPrice(price);
    if (changeEl) {
      changeEl.textContent = utils.formatChange(change);
      changeEl.className = `price-change-badge ${change >= 0 ? 'positive' : 'negative'}`;
    }
  },

  // Update watchlist button state
  updateWatchlistButton() {
    const btn = document.getElementById('watchlist-btn');
    if (!btn || !this.mint) return;

    const inWatchlist = typeof watchlist !== 'undefined' && watchlist.has(this.mint);
    btn.classList.toggle('active', inWatchlist);
    btn.title = inWatchlist ? 'Remove from watchlist' : 'Add to watchlist';
    const starSvg = inWatchlist
      ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`
      : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`;
    btn.innerHTML = `${starSvg} ${inWatchlist ? 'Watchlisted' : 'Watchlist'}`;
  },

  // Render token info
  renderToken() {
    const token = this.token;

    // Update page title
    document.title = `${token.name} (${token.symbol}) - CultScreener`;

    // Header info - handle different property names from various API responses
    const logoEl = document.getElementById('token-logo');
    if (logoEl) {
      logoEl.src = token.logoUri || token.logoURI || token.logo || utils.getDefaultLogo();
      logoEl.onerror = function() {
        this.src = utils.getDefaultLogo();
      };
    }

    // Update watchlist button
    this.updateWatchlistButton();

    const nameEl = document.getElementById('token-name');
    if (nameEl) nameEl.textContent = token.name || `${this.mint.slice(0, 4)}...${this.mint.slice(-4)}`;

    const symbolEl = document.getElementById('token-symbol');
    if (symbolEl) symbolEl.textContent = token.symbol || this.mint.slice(0, 5).toUpperCase();

    const addressEl = document.getElementById('token-address');
    if (addressEl) addressEl.textContent = this.mint;

    // Explorer link
    const explorerLink = document.getElementById('explorer-link');
    if (explorerLink) {
      explorerLink.href = `https://solscan.io/token/${this.mint}`;
    }

    // Bubblemaps link
    const bubblemapsLink = document.getElementById('bubblemaps-link');
    if (bubblemapsLink) {
      bubblemapsLink.href = `https://app.bubblemaps.io/sol/token/${this.mint}`;
    }

    // Price
    this.updatePriceDisplay();

    // Price high/low — populated from OHLCV in updateHeaderHighLow() once chart data loads

    // Stats
    const mcapEl = document.getElementById('stat-mcap');
    if (mcapEl) mcapEl.textContent = utils.formatNumber(token.marketCap);
    const volumeEl = document.getElementById('stat-volume');
    if (volumeEl) volumeEl.textContent = utils.formatNumber(token.volume24h);
    const liqEl = document.getElementById('stat-liquidity');
    if (liqEl) liqEl.textContent = utils.formatNumber(token.liquidity);
    const holdersEl = document.getElementById('stat-holders');
    if (holdersEl) holdersEl.textContent = typeof token.holders === 'number' ? token.holders.toLocaleString() : 'N/A';

    const supplyEl = document.getElementById('stat-supply');
    if (supplyEl) supplyEl.textContent = token.supply ? utils.formatNumber(token.supply, '') : '--';

    const circulatingEl = document.getElementById('stat-circulating');
    if (circulatingEl) circulatingEl.textContent = token.circulatingSupply ? utils.formatNumber(token.circulatingSupply, '') : '--';

    const ageEl = document.getElementById('stat-age');
    const holdersAgeEl = document.getElementById('holders-token-age');
    if (ageEl) {
      if (token.pairCreatedAt) {
        ageEl.textContent = utils.formatAge(token.pairCreatedAt);
        ageEl.title = new Date(token.pairCreatedAt).toLocaleDateString();
      } else {
        ageEl.textContent = 'N/A';
      }
    }
    // Keep Holder Analytics token age in sync (may load before full token data arrives)
    if (holdersAgeEl) {
      holdersAgeEl.textContent = token.pairCreatedAt
        ? utils.formatAge(token.pairCreatedAt)
        : 'N/A';
    }

    // Views - display initial count from token data (updated later by recordView POST)
    if (token.views != null) {
      this.updateViewCount(token.views);
    }

    // Trade links - Jupiter with proper URL format
    const jupiterLink = document.getElementById('jupiter-link');
    if (jupiterLink) {
      jupiterLink.href = `https://jup.ag/swap?sell=So11111111111111111111111111111111111111112&buy=${this.mint}`;
    }

  },

  // Load pools
  async loadPools() {
    const _t0 = performance.now();
    let _ok = true;
    const loadingEl = document.getElementById('pools-loading');
    const listEl = document.getElementById('pools-list');
    const emptyEl = document.getElementById('pools-empty');

    try {
      this.pools = await api.tokens.getPools(this.mint);

      if (loadingEl) loadingEl.style.display = 'none';

      if (!this.pools || this.pools.length === 0) {
        if (emptyEl) emptyEl.style.display = 'block';
        return;
      }

      if (listEl) {
        listEl.style.display = 'block';
        listEl.innerHTML = this.pools.slice(0, 5).map(pool => `
          <div class="pool-card">
            <div class="pool-pair">
              <span class="pool-symbols">${this.escapeHtml(pool.symbolA || '?')}/${this.escapeHtml(pool.symbolB || '?')}</span>
              <span class="pool-type">${this.escapeHtml(pool.type || 'AMM')}</span>
            </div>
            <div class="pool-stats">
              <div class="pool-stat">
                <span class="label">TVL</span>
                <span class="value">${utils.formatNumber(pool.tvl)}</span>
              </div>
              <div class="pool-stat">
                <span class="label">24h Volume</span>
                <span class="value">${utils.formatNumber(pool.volume24h)}</span>
              </div>
            </div>
          </div>
        `).join('');
      }
    } catch (error) {
      _ok = false;
      console.error('Failed to load pools:', error);
      if (loadingEl) loadingEl.style.display = 'none';
      if (emptyEl) {
        emptyEl.textContent = 'Failed to load pool data.';
        emptyEl.style.display = 'block';
      }
    } finally {
      if (typeof latencyTracker !== 'undefined') latencyTracker.record('tokenDetail.pools', performance.now() - _t0, _ok, 'frontend');
    }
  },

  async loadHolderAnalytics(fresh = false) {
    const section = document.getElementById('holders-section');
    const refreshBtn = document.getElementById('holders-refresh');

    if (fresh) {
      apiCache.clearPattern(`tokens:holders:${this.mint}`);
      apiCache.clearPattern(`tokens:hold-times:${this.mint}`);
      apiCache.clearPattern(`tokens:diamond-hands:${this.mint}`);
      this._holdTimesData = null;
      this._tokenHoldTimesData = null;
      this._holdTimesLoaded = false;
      this._diamondHandsData = null;
      this._diamondHandsLoaded = false;
      const shareBtn = document.getElementById('holders-share');
      if (shareBtn) { shareBtn.disabled = true; shareBtn.title = 'Waiting for holder data...'; }
      if (refreshBtn) refreshBtn.classList.add('spinning');
    }

    try {
      const data = await api.tokens.getHolders(this.mint, { fresh });
      if (!data) return;

      // Show the section — even on RPC errors we display a message
      if (section) section.style.display = '';

      // Show current ticker in header
      const tickerEl = document.getElementById('holders-ticker');
      if (tickerEl && this.token) {
        tickerEl.textContent = '$' + (this.token.symbol || '').toUpperCase();
      }

      // Handle RPC unavailable — show section with retry message
      if (data.error === 'rpc_unavailable' || !data.holders || data.holders.length === 0) {
        const tbody = document.getElementById('holders-tbody');
        if (tbody) {
          tbody.innerHTML = data.error === 'rpc_unavailable'
            ? '<tr><td colspan="7" style="text-align:center;padding:1.5rem;color:var(--text-muted);">Holder data temporarily unavailable. Click refresh to retry.</td></tr>'
            : '<tr><td colspan="7" style="text-align:center;padding:1.5rem;color:var(--text-muted);">No holder data available for this token.</td></tr>';
        }
        // Don't cache RPC failures in frontend
        if (data.error === 'rpc_unavailable') {
          apiCache.clearPattern(`tokens:holders:${this.mint}`);
        }
        // Hide diamond hands section if it was visible from a prior load
        const dhSection = document.getElementById('diamond-hands-section');
        if (dhSection) dhSection.style.display = 'none';
        return;
      }

      // Update "last updated" timestamp (use backend fetchedAt so it reflects real data age)
      const updatedEl = document.getElementById('holders-updated');
      if (updatedEl) {
        this._holdersUpdatedAt = data.fetchedAt || Date.now();
        const ageSec = Math.floor((Date.now() - this._holdersUpdatedAt) / 1000);
        if (ageSec < 10) updatedEl.textContent = 'Updated just now';
        else if (ageSec < 60) updatedEl.textContent = `Updated ${ageSec}s ago`;
        else if (ageSec < 3600) updatedEl.textContent = `Updated ${Math.floor(ageSec / 60)}m ago`;
        else updatedEl.textContent = `Updated ${Math.floor(ageSec / 3600)}h ago`;
        this._startHoldersTimestampTimer();
      }

      // Render concentration metrics
      const { metrics, holders } = data;
      if (metrics) {
        const t5 = document.getElementById('holders-top5');
        const t10 = document.getElementById('holders-top10');
        const t20 = document.getElementById('holders-top20');
        const avgHoldTimeEl = document.getElementById('holders-avg-hold-time');
        const tokenAgeEl = document.getElementById('holders-token-age');
        if (t5) t5.textContent = metrics.top5Pct.toFixed(1) + '%';
        if (t10) t10.textContent = metrics.top10Pct.toFixed(1) + '%';
        if (t20) t20.textContent = metrics.top20Pct.toFixed(1) + '%';
        // Avg Hold Time metric is populated by _updateAvgHoldTimeMetric after hold times load
        if (avgHoldTimeEl) avgHoldTimeEl.textContent = '...';
        if (tokenAgeEl) {
          tokenAgeEl.textContent = this.token?.pairCreatedAt
            ? utils.formatAge(this.token.pairCreatedAt)
            : 'N/A';
        }

        // Update holder count stat if it was N/A
        if (metrics.holderCount) {
          const holdersStatEl = document.getElementById('stat-holders');
          if (holdersStatEl && (holdersStatEl.textContent === 'N/A' || holdersStatEl.textContent === '--')) {
            holdersStatEl.textContent = metrics.holderCount.toLocaleString();
          }
        }

        // Color-code percentage metrics (green = distributed, red = concentrated)
        [t5, t10, t20].forEach(el => {
          if (!el) return;
          el.classList.remove('concentration-low', 'concentration-medium', 'concentration-high');
          const val = parseFloat(el.textContent);
          if (isNaN(val)) return;
          if (val > 80) el.classList.add('concentration-high');
          else if (val > 50) el.classList.add('concentration-medium');
          else el.classList.add('concentration-low');
        });

        // Render risk badge
        const riskRow = document.getElementById('holders-risk-row');
        const riskBadge = document.getElementById('holders-risk-badge');
        if (riskRow && riskBadge && metrics.riskLevel) {
          riskRow.style.display = '';
          riskBadge.textContent = metrics.riskLevel.charAt(0).toUpperCase() + metrics.riskLevel.slice(1);
          riskBadge.className = 'holders-risk-badge risk-' + metrics.riskLevel;
        }
      }

      // Render locked & burnt supply info (inside the metrics grid)
      if (data.supply) {
        const fmtAmount = (v) => v >= 1e9 ? (v / 1e9).toFixed(2) + 'B'
          : v >= 1e6 ? (v / 1e6).toFixed(2) + 'M'
          : v >= 1e3 ? (v / 1e3).toFixed(2) + 'K'
          : v.toFixed(2);

        const lockedEl = document.getElementById('holders-locked');
        if (lockedEl) {
          const lk = data.supply.locked;
          if (lk > 0) {
            lockedEl.textContent = fmtAmount(lk) + ' (' + data.supply.lockedPct.toFixed(1) + '%)';
            lockedEl.className = 'holder-metric-value concentration-low';
          } else {
            lockedEl.textContent = 'None';
            lockedEl.className = 'holder-metric-value';
          }
        }

        const burntEl = document.getElementById('holders-burnt');
        if (burntEl) {
          const bt = data.supply.burnt;
          if (bt > 0) {
            let tooltip = '';
            if (data.supply.splBurnt > 0 && data.supply.deadWalletBurnt > 0) {
              tooltip = `SPL Burn: ${fmtAmount(data.supply.splBurnt)} · Dead Wallets: ${fmtAmount(data.supply.deadWalletBurnt)}`;
            } else if (data.supply.splBurnt > 0) {
              tooltip = 'Burned via SPL burn instruction';
            } else {
              tooltip = 'Sent to dead/burn wallet addresses';
            }
            burntEl.textContent = fmtAmount(bt) + ' (' + data.supply.burntPct.toFixed(1) + '%)';
            burntEl.className = 'holder-metric-value burnt-highlight';
            burntEl.title = tooltip;
          } else if (data.supply.isPumpFun) {
            burntEl.textContent = 'None';
            burntEl.className = 'holder-metric-value';
            burntEl.title = '';
          } else {
            burntEl.textContent = 'N/A';
            burntEl.className = 'holder-metric-value holder-metric-na';
            burntEl.title = 'Burn detection only available for Pump.fun tokens';
          }
        }
      }

      // Render table
      this._holdersData = holders; // Store for expand/collapse
      const tbody = document.getElementById('holders-tbody');
      if (tbody) {
        this._holdersExpanded = false;
        this._renderHoldersTable(holders, 10);
        // Show expand button if more than 10 holders
        const expandBtn = document.getElementById('holders-expand');
        if (expandBtn && holders.length > 10) {
          expandBtn.style.display = '';
          expandBtn.innerHTML = `Show All ${holders.length} <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;
        }
      }

      // Enable share button now that holder data is rendered
      const shareBtnDone = document.getElementById('holders-share');
      if (shareBtnDone) { shareBtnDone.disabled = false; shareBtnDone.title = 'Share holder analytics'; }

      // Lazy-load hold times and diamond hands after table renders (non-blocking).
      // First call triggers backend computation; subsequent polls pick up results.
      this._loadHoldTimes();
      if (holders.length > 0) this._loadDiamondHands();
    } catch (error) {
      console.warn('[TokenDetail] Holder analytics failed:', error.message);
    } finally {
      if (refreshBtn) refreshBtn.classList.remove('spinning');
    }
  },

  // Render holder table rows with given limit
  _renderHoldersTable(holders, limit) {
    const tbody = document.getElementById('holders-tbody');
    if (!tbody) return;
    const price = this.token && this.token.price ? this.token.price : 0;
    tbody.innerHTML = holders.slice(0, limit).map(h => {
      const shortAddr = h.address.slice(0, 4) + '...' + h.address.slice(-4);
      const pct = h.percentage != null ? h.percentage.toFixed(2) + '%' : '--';
      const bal = h.balance >= 1e9 ? (h.balance / 1e9).toFixed(2) + 'B'
        : h.balance >= 1e6 ? (h.balance / 1e6).toFixed(2) + 'M'
        : h.balance >= 1e3 ? (h.balance / 1e3).toFixed(2) + 'K'
        : h.balance.toFixed(2);
      const usdVal = price > 0 ? h.balance * price : 0;
      const valStr = usdVal > 0
        ? '$' + (usdVal >= 1e6 ? (usdVal / 1e6).toFixed(2) + 'M'
          : usdVal >= 1e3 ? (usdVal / 1e3).toFixed(2) + 'K'
          : usdVal.toFixed(2))
        : '--';
      const label = h.isLP ? ' <span class="holder-label lp-label" title="Liquidity Pool">💧LP</span>'
        : h.isBurnt ? ' <span class="holder-label burnt-label" title="Burn Wallet">🔥Burn</span>'
        : '';
      const rowClass = h.isLP || h.isBurnt ? ' class="holder-excluded"' : '';
      // Show avg hold time if available. If loading is done (_holdTimesLoaded), show "--" for
      // wallets without data instead of a pulsing placeholder (prevents expand/collapse reverting).
      const holdTimeStr = (h.isLP || h.isBurnt) ? '--'
        : (this._holdTimesData && this._holdTimesData[h.address])
          ? this._formatHoldTime(this._holdTimesData[h.address])
          : this._holdTimesLoaded ? '--'
          : '<span class="hold-time-pending" data-wallet="' + h.address + '">...</span>';
      // Show token-specific hold time (how long they've held THIS token)
      const tokenHoldStr = (h.isLP || h.isBurnt) ? '--'
        : (this._tokenHoldTimesData && this._tokenHoldTimesData[h.address])
          ? this._formatHoldTime(this._tokenHoldTimesData[h.address])
          : this._holdTimesLoaded ? '--'
          : '<span class="token-hold-pending" data-wallet="' + h.address + '">...</span>';
      return `<tr${rowClass}>
        <td>${h.rank}</td>
        <td><a href="https://solscan.io/account/${h.address}" target="_blank" rel="noopener" class="holder-address" title="${h.address}">${shortAddr}</a>${label}</td>
        <td class="text-right mono">${bal}</td>
        <td class="text-right mono">${valStr}</td>
        <td class="text-right mono">${pct}</td>
        <td class="text-right mono holders-share-col">${tokenHoldStr}</td>
      </tr>`;
    }).join('');
  },

  // Keep the "Updated X ago" text ticking
  _startHoldersTimestampTimer() {
    if (this._holdersTimestampInterval) clearInterval(this._holdersTimestampInterval);
    this._holdersTimestampInterval = setInterval(() => {
      const el = document.getElementById('holders-updated');
      if (!el || !this._holdersUpdatedAt) return;
      const sec = Math.floor((Date.now() - this._holdersUpdatedAt) / 1000);
      if (sec < 10) el.textContent = 'Updated just now';
      else if (sec < 60) el.textContent = `Updated ${sec}s ago`;
      else if (sec < 3600) el.textContent = `Updated ${Math.floor(sec / 60)}m ago`;
      else el.textContent = `Updated ${Math.floor(sec / 3600)}h ago`;
    }, 10000);
  },

  // Format hold time from milliseconds to human-readable string
  _formatHoldTime(ms) {
    if (!ms || ms <= 0) return '--';
    const hours = ms / 3600000;
    if (hours < 1) return Math.round(ms / 60000) + 'm';
    if (hours < 24) return Math.round(hours) + 'h';
    const days = hours / 24;
    if (days < 30) return Math.round(days) + 'd';
    const months = days / 30;
    if (months < 12) return Math.round(months) + 'mo';
    return (days / 365).toFixed(1) + 'y';
  },

  // Lazy-load average hold times for holder wallets.
  // If the backend returns computed: false (worker still processing),
  // re-poll up to MAX_POLLS times with increasing delay to pick up results.
  async _loadHoldTimes(attempt = 0) {
    const MAX_POLLS = 8;
    // First delay is longer to give backend inline computation time to complete
    const POLL_DELAYS = [6000, 5000, 5000, 6000, 8000, 12000, 16000, 20000];

    // Cancel any in-flight polling from a previous load (e.g. refresh clicked while polling)
    if (attempt === 0) {
      if (this._holdTimesTimer) {
        clearTimeout(this._holdTimesTimer);
        this._holdTimesTimer = null;
      }
      this._holdTimesLoaded = false;
    }

    try {
      // Bypass apiCache entirely — poll directly so we always hit the backend.
      // The apiCache.getOrFetch pattern can return stale cached responses during
      // rapid polling, which prevents us from seeing newly computed data.
      console.log(`[HoldTimes] Poll ${attempt}/${MAX_POLLS} for ${this.mint.slice(0, 8)}...`);
      const data = await api.request(`/api/tokens/${this.mint}/holders/hold-times`);

      if (!data) {
        console.warn(`[HoldTimes] No data returned from API`);
        if (attempt < MAX_POLLS) {
          this._holdTimesTimer = setTimeout(() => this._loadHoldTimes(attempt + 1), POLL_DELAYS[attempt] || 10000);
        } else {
          this._holdTimesLoaded = true;
          }
        return;
      }

      const avgCount = data.holdTimes ? Object.keys(data.holdTimes).length : 0;
      const tokenCount = data.tokenHoldTimes ? Object.keys(data.tokenHoldTimes).length : 0;
      console.log(`[HoldTimes] Poll ${attempt}: computed=${data.computed}, avg=${avgCount}, token=${tokenCount}`);

      // If the backend returned no data (holders cache miss), ensure the backend
      // holders cache gets repopulated by making a fresh holders request.
      // Fire-and-forget — the next poll will find the cache populated.
      if (!data.computed && avgCount === 0 && tokenCount === 0 && attempt < 2) {
        console.log(`[HoldTimes] Empty response — refreshing backend holders cache`);
        apiCache.clearPattern(`tokens:holders:${this.mint}`);
        api.tokens.getHolders(this.mint, { fresh: true }).catch(() => {});
      }

      // Merge into existing data (re-polls add to previous results)
      if (data.holdTimes && Object.keys(data.holdTimes).length > 0) {
        this._holdTimesData = Object.assign(this._holdTimesData || {}, data.holdTimes);
      }
      if (data.tokenHoldTimes && Object.keys(data.tokenHoldTimes).length > 0) {
        this._tokenHoldTimesData = Object.assign(this._tokenHoldTimesData || {}, data.tokenHoldTimes);
      }

      // Update fresh wallets metric if available
      if (data.freshWallets && data.freshWallets.checked > 0) {
        this._updateFreshWalletsMetric(data.freshWallets);
      }

      // Fill in pending placeholders with any data we have so far
      this._applyHoldTimesToDOM();

      // Re-poll if worker is still computing and we haven't exhausted retries
      if (!data.computed && attempt < MAX_POLLS) {
        console.log(`[HoldTimes] Not computed yet, re-polling in ${POLL_DELAYS[attempt]}ms`);
        this._holdTimesTimer = setTimeout(() => this._loadHoldTimes(attempt + 1), POLL_DELAYS[attempt]);
      } else {
        // Mark loading complete so expand/collapse renders "--" instead of "..."
        this._holdTimesLoaded = true;
        // Final pass — replace any remaining placeholders with dashes
        const remaining = document.querySelectorAll('.hold-time-pending, .token-hold-pending');
        if (remaining.length > 0) {
          console.log(`[HoldTimes] Final: ${remaining.length} placeholders still pending → showing --`);
        }
        remaining.forEach(el => {
          el.textContent = '--';
          el.classList.remove('hold-time-pending', 'token-hold-pending');
        });
        this._updateAvgHoldTimeMetric();
        const totalAvg = this._holdTimesData ? Object.keys(this._holdTimesData).length : 0;
        const totalToken = this._tokenHoldTimesData ? Object.keys(this._tokenHoldTimesData).length : 0;
        console.log(`[HoldTimes] Done: ${totalAvg} avg hold times, ${totalToken} token hold times loaded`);
      }
    } catch (error) {
      console.warn('[HoldTimes] Failed:', error.message);
      // On error, keep polling if we have retries left (could be transient)
      if (attempt < MAX_POLLS) {
        console.log(`[HoldTimes] Error on poll ${attempt}, retrying in ${POLL_DELAYS[attempt]}ms`);
        this._holdTimesTimer = setTimeout(() => this._loadHoldTimes(attempt + 1), POLL_DELAYS[attempt]);
      } else {
        this._holdTimesLoaded = true;
        document.querySelectorAll('.hold-time-pending, .token-hold-pending').forEach(el => {
          el.textContent = '--';
          el.classList.remove('hold-time-pending', 'token-hold-pending');
        });
        const avgEl = document.getElementById('holders-avg-hold-time');
        if (avgEl) avgEl.textContent = '--';
      }
    }
  },

  // Apply cached hold time data to DOM placeholders and update summary metric
  _applyHoldTimesToDOM() {
    if (this._holdTimesData) {
      document.querySelectorAll('.hold-time-pending').forEach(el => {
        const wallet = el.getAttribute('data-wallet');
        if (wallet && this._holdTimesData[wallet]) {
          el.textContent = this._formatHoldTime(this._holdTimesData[wallet]);
          el.classList.remove('hold-time-pending');
        }
      });
    }
    if (this._tokenHoldTimesData) {
      document.querySelectorAll('.token-hold-pending').forEach(el => {
        const wallet = el.getAttribute('data-wallet');
        if (wallet && this._tokenHoldTimesData[wallet]) {
          el.textContent = this._formatHoldTime(this._tokenHoldTimesData[wallet]);
          el.classList.remove('token-hold-pending');
        }
      });
    }
    this._updateAvgHoldTimeMetric();
  },

  // Update the "Avg Hold Time" summary metric in the concentration metrics grid.
  // Computes the average across all top-20 wallets that have hold time data.
  _updateAvgHoldTimeMetric() {
    const el = document.getElementById('holders-avg-hold-time');
    if (!el || !this._holdTimesData) return;

    const values = Object.values(this._holdTimesData).filter(v => v > 0);
    if (values.length === 0) {
      el.textContent = '--';
      return;
    }

    const avgMs = values.reduce((sum, v) => sum + v, 0) / values.length;
    el.textContent = this._formatHoldTime(avgMs);
  },

  // Update the "Fresh Wallets" metric — wallets with first-ever tx within 24h.
  // Color-coded by percentage: green (<2%) = healthy, yellow (2-5%) = watch, red (>5%) = suspicious.
  _updateFreshWalletsMetric(freshData) {
    const el = document.getElementById('holders-fresh-wallets');
    if (!el) return;

    const { count, checked, total } = freshData;
    if (checked === 0) {
      el.textContent = '...';
      return;
    }

    const pct = checked > 0 ? (count / checked) * 100 : 0;
    el.textContent = `${count}/${total} (${pct.toFixed(0)}%)`;
    el.classList.remove('concentration-low', 'concentration-medium', 'concentration-high');
    // Percentage-based thresholds — scales with any sample size
    if (pct < 2) el.classList.add('concentration-low');        // green = healthy
    else if (pct < 5) el.classList.add('concentration-medium'); // yellow = watch
    else el.classList.add('concentration-high');                 // red = suspicious
  },

  // Share holder analytics as a screenshot image
  async _shareHolderAnalytics() {
    const graphic = document.getElementById('holders-graphic');
    if (!graphic) return;

    const btn = document.getElementById('holders-share');
    if (btn) { btn.disabled = true; btn.classList.add('spinning'); }

    // Elements we inject for the screenshot and remove after
    const injected = [];
    try {
      // Dynamically load html2canvas if not already loaded
      if (typeof html2canvas === 'undefined') {
        await new Promise((resolve, reject) => {
          const script = document.createElement('script');
          script.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
          script.onload = resolve;
          script.onerror = reject;
          document.head.appendChild(script);
        });
      }

      const esc = (s) => utils.escapeHtml(s || '');
      const tokenName = this.token?.name || '';
      const tokenSymbol = this.token?.symbol || '';
      const tokenPrice = this.token?.price ? utils.formatPrice(this.token.price, 6) : '';
      const priceChange = this.token?.priceChange24h;
      const priceChangeStr = typeof priceChange === 'number' ? `${priceChange >= 0 ? '+' : ''}${priceChange.toFixed(2)}%` : '';
      const priceColor = priceChange >= 0 ? '#10b981' : '#ef4444';
      const logoSrc = document.getElementById('token-logo')?.src || '';

      // Add padding to the graphic container for the screenshot
      graphic.style.padding = '1.25rem';

      // 1. Header bar: logo + name + price
      const header = document.createElement('div');
      header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding-bottom:0.85rem;margin-bottom:0.85rem;border-bottom:1px solid rgba(255,255,255,0.06);';
      header.innerHTML = `
        <div style="display:flex;align-items:center;gap:0.6rem;">
          ${logoSrc ? `<img src="${esc(logoSrc)}" style="width:32px;height:32px;border-radius:50%;background:#161719;" crossorigin="anonymous">` : ''}
          <div>
            <div style="font-size:1rem;font-weight:800;color:#f0f0f2;letter-spacing:-0.02em;line-height:1.2;">${esc(tokenName)}</div>
            <div style="font-size:0.7rem;font-family:'JetBrains Mono',monospace;color:#6b6b74;text-transform:uppercase;letter-spacing:0.04em;">${esc(tokenSymbol)}</div>
          </div>
        </div>
        <div style="text-align:right;">
          ${tokenPrice ? `<div style="font-size:1.1rem;font-weight:700;color:#f0f0f2;font-family:'JetBrains Mono',monospace;letter-spacing:-0.02em;">${esc(tokenPrice)}</div>` : ''}
          ${priceChangeStr ? `<div style="font-size:0.75rem;font-weight:600;color:${priceColor};font-family:'JetBrains Mono',monospace;">${esc(priceChangeStr)}</div>` : ''}
        </div>`;
      graphic.insertBefore(header, graphic.firstChild);
      injected.push(header);

      // 2. Section title
      const sectionTitle = document.createElement('div');
      sectionTitle.style.cssText = 'font-size:0.72rem;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:#6b6b74;margin-bottom:0.6rem;';
      sectionTitle.textContent = 'CONVICTION METRICS';
      graphic.insertBefore(sectionTitle, header.nextSibling);
      injected.push(sectionTitle);

      // 3. Boost watermark opacity
      const watermark = graphic.querySelector('.holders-watermark');
      if (watermark) watermark.style.opacity = '0.8';

      const canvas = await html2canvas(graphic, {
        backgroundColor: '#060607',
        scale: 2,
        useCORS: true,
        logging: false,
        scrollY: -window.scrollY,
        windowHeight: graphic.scrollHeight,
      });

      // Clean up injected elements
      injected.forEach(el => el.remove());
      graphic.style.padding = '';
      if (watermark) watermark.style.opacity = '';

      const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
      const filename = `${(tokenSymbol || tokenName || 'token').toLowerCase()}-conviction.png`;

      // Try native share
      if (navigator.share && navigator.canShare) {
        const file = new File([blob], filename, { type: 'image/png' });
        const shareData = { files: [file] };
        if (navigator.canShare(shareData)) {
          try {
            await navigator.share(shareData);
          } catch (shareErr) {
            if (shareErr.name !== 'AbortError') throw shareErr;
          }
          return;
        }
      }

      // Fallback: copy to clipboard
      if (navigator.clipboard && navigator.clipboard.write) {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        if (typeof toast !== 'undefined') toast.success('Screenshot copied to clipboard!');
      } else {
        // Last fallback: download
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        if (typeof toast !== 'undefined') toast.success('Screenshot downloaded!');
      }
    } catch (err) {
      console.error('Share conviction stats error:', err);
      if (typeof toast !== 'undefined') toast.error('Failed to capture screenshot');
    } finally {
      // Always clean up
      injected.forEach(el => { if (el.parentNode) el.remove(); });
      graphic.style.padding = '';
      const watermark = document.querySelector('#holders-graphic .holders-watermark');
      if (watermark) watermark.style.opacity = '';
      if (btn) { btn.disabled = false; btn.classList.remove('spinning'); }
    }
  },

  // Load diamond hands distribution with polling
  async _loadDiamondHands(attempt = 0) {
    const MAX_POLLS = 10;
    const POLL_DELAYS = [5000, 5000, 6000, 8000, 8000, 10000, 12000, 16000, 20000, 24000]; // 250 wallets at batch 25 ≈ 20-30s

    // Cancel any in-flight polling from a previous load
    if (attempt === 0 && this._diamondHandsTimer) {
      clearTimeout(this._diamondHandsTimer);
      this._diamondHandsTimer = null;
    }

    try {
      // Bypass apiCache — poll directly so we always get fresh data from backend
      console.log(`[DiamondHands] Poll ${attempt}/${MAX_POLLS} for ${this.mint.slice(0, 8)}...`);
      const data = await api.request(`/api/tokens/${this.mint}/holders/diamond-hands`);

      if (!data) {
        console.log(`[DiamondHands] No response`);
        this._diamondHandsLoaded = true;
        return;
      }

      // Only render once we have actual distribution data (at least some analyzed)
      if (data.distribution && data.analyzed > 0) {
        this._renderDiamondHands(data);
      }

      if (!data.computed && attempt < MAX_POLLS) {
        console.log(`[DiamondHands] ${data.analyzed || 0}/${data.totalCount || data.sampleSize} analyzed, re-polling in ${POLL_DELAYS[attempt]}ms`);
        this._diamondHandsTimer = setTimeout(() => this._loadDiamondHands(attempt + 1), POLL_DELAYS[attempt]);
      } else {
        // Final state — if still no data, hide section
        if (!data.distribution || !data.analyzed) {
          const section = document.getElementById('diamond-hands-section');
          if (section) section.style.display = 'none';
        } else {
          this._diamondHandsData = data;
        }
        this._diamondHandsLoaded = true;
        console.log(`[DiamondHands] Done: sample=${data.sampleSize}, analyzed=${data.analyzed}`);
      }
    } catch (error) {
      console.warn('[DiamondHands] Failed:', error.message);
      this._diamondHandsLoaded = true;
      this._checkAIAnalysisReady();
    }
  },

  _renderDiamondHands(data) {
    const section = document.getElementById('diamond-hands-section');
    if (!section || !data.distribution) return;

    section.style.display = '';

    // Update sample size label
    const sampleEl = document.getElementById('diamond-hands-sample');
    if (sampleEl) {
      if (data.computed) {
        sampleEl.textContent = `${data.analyzed} of ${data.sampleSize} holders`;
      } else {
        sampleEl.textContent = `${data.analyzed}/${data.totalCount || data.sampleSize} analyzed...`;
      }
    }

    // Determine token age in ms to conditionally show long-term buckets
    const tokenAgeMs = this.token?.pairCreatedAt
      ? Date.now() - new Date(this.token.pairCreatedAt).getTime()
      : 0;

    // Age-gated buckets: only show if token is old enough
    const AGE_GATED = {
      '3m': 90 * 86400000,
      '6m': 180 * 86400000,
      '9m': 270 * 86400000,
    };

    // Update each bar
    const buckets = ['6h', '24h', '3d', '1w', '1m', '3m', '6m', '9m'];
    for (const key of buckets) {
      const pct = data.distribution[key] ?? 0;
      const fillEl = document.getElementById(`dh-fill-${key}`);
      const pctEl = document.getElementById(`dh-pct-${key}`);

      // Show/hide age-gated rows
      if (AGE_GATED[key]) {
        const rowEl = document.getElementById(`dh-row-${key}`);
        if (rowEl) {
          rowEl.style.display = tokenAgeMs >= AGE_GATED[key] ? '' : 'none';
        }
      }

      if (fillEl) {
        fillEl.style.width = pct + '%';
        // Color gradient: higher % = greener (more diamond hands)
        if (pct >= 50) fillEl.className = 'diamond-bar-fill dh-high';
        else if (pct >= 20) fillEl.className = 'diamond-bar-fill dh-mid';
        else fillEl.className = 'diamond-bar-fill dh-low';
      }
      if (pctEl) {
        pctEl.textContent = pct + '%';
        // Color the percentage text to match
        pctEl.classList.remove('dh-text-high', 'dh-text-mid', 'dh-text-low');
        if (pct >= 50) pctEl.classList.add('dh-text-high');
        else if (pct >= 20) pctEl.classList.add('dh-text-mid');
        else if (pct > 0) pctEl.classList.add('dh-text-low');
      }
    }
  },

  // Load chart data
  async loadChart(interval = '1h') {
    const _t0 = performance.now();
    let _ok = true;
    const chartLoading = document.getElementById('chart-loading');
    const chartError   = document.getElementById('chart-error');
    if (chartLoading) chartLoading.style.display = 'flex';
    if (chartError)   chartError.style.display   = 'none';  // hide any previous error

    try {
      // Reuse the in-flight preload promise when loading the default 1h interval,
      // avoiding a duplicate request if loadToken() hasn't finished yet.
      const preload = (interval === '1h') ? this._chartPreload : null;
      this._chartPreload = null;

      // Try direct GeckoTerminal first, auto-fallback to backend on failure
      try {
        if (!preload && (typeof directGecko === 'undefined' || !directGecko._available)) {
          throw new Error('GeckoTerminal client not available');
        }
        this.chartData = preload
          ? await preload
          : await directGecko.getOHLCV(this.mint, interval);
      } catch (directErr) {
        // Direct GeckoTerminal failed — fall back to backend chart endpoint
        this.chartData = await api.tokens.getChart(this.mint, { interval });
      }

      this.renderChart(this.chartData);
      this.updateChartStats(this.chartData);
      this._startChartRefresh();

      // Derive 24h high/low from the 1H OHLCV data (last 24 candles = last 24 hours).
      // Only update on the initial 1H load so the header values stay anchored to 24h.
      if (interval === '1h') this.updateHeaderHighLow(this.chartData);
    } catch (error) {
      _ok = false;
      this.renderChartError(error);
    } finally {
      if (chartLoading) chartLoading.style.display = 'none';
      if (typeof latencyTracker !== 'undefined') latencyTracker.record('tokenDetail.chart', performance.now() - _t0, _ok, 'frontend');
    }
  },

  // Start auto-refresh for chart data. Short timeframes refresh every 60s, longer ones less often.
  _startChartRefresh() {
    this._stopChartRefresh();
    const intervalMap = { '5m': 30000, '15m': 45000, '1h': 60000, '4h': 120000, '1d': 300000, '1w': 600000 };
    const ms = intervalMap[this.currentInterval] || 60000;
    this._chartRefreshInterval = setInterval(() => {
      if (document.hidden) return; // Skip if tab not visible
      this._refreshChartData();
    }, ms);
  },

  _stopChartRefresh() {
    if (this._chartRefreshInterval) {
      clearInterval(this._chartRefreshInterval);
      this._chartRefreshInterval = null;
    }
  },

  // Silently fetch latest chart data and update the chart without a loading spinner.
  // Preserves the user's current zoom/scroll position.
  async _refreshChartData() {
    try {
      let newData;
      try {
        if (typeof directGecko === 'undefined' || !directGecko._available) throw new Error('skip');
        newData = await directGecko.getOHLCV(this.mint, this.currentInterval);
      } catch (_) {
        newData = await api.tokens.getChart(this.mint, { interval: this.currentInterval });
      }
      if (!newData?.data?.length) return;

      // Snapshot visible range before destroying the chart
      let savedRange = null;
      let savedModalRange = null;
      try { if (this.chart) savedRange = this.chart.timeScale().getVisibleLogicalRange(); } catch (_) {}
      try { if (this.modalChart) savedModalRange = this.modalChart.timeScale().getVisibleLogicalRange(); } catch (_) {}

      this.chartData = newData;
      this.renderChart(this.chartData);
      this.updateChartStats(this.chartData);

      // Restore zoom position (fitContent is called by renderChart, so override it)
      if (savedRange && this.chart) {
        try { this.chart.timeScale().setVisibleLogicalRange(savedRange); } catch (_) {}
      }

      if (this._modalOpen) {
        this._renderModalChart();
        this._updateModalStats(this.chartData);
        if (savedModalRange && this.modalChart) {
          try { this.modalChart.timeScale().setVisibleLogicalRange(savedModalRange); } catch (_) {}
        }
      }
    } catch (_) {
      // Silent fail — don't disrupt the user
    }
  },

  // Show chart error overlay with a retry button.
  // Does NOT fall back to the backend — callers must click Retry.
  renderChartError(error) {
    console.error('[Chart] GeckoTerminal fetch failed:', error?.message || error);

    // Remove any stale chart to free memory
    if (this.chart) {
      this._removeChart(this.chart);
      this.chart = null;
    }
    // Clear the chart container
    const chartEl = document.getElementById('price-chart');
    if (chartEl) chartEl.innerHTML = '';

    const errorEl = document.getElementById('chart-error');
    if (!errorEl) return;
    errorEl.style.display = 'flex';

    // Wire up the retry button (clone to remove any stacked listeners from previous errors)
    const retryBtn = document.getElementById('chart-retry-btn');
    if (retryBtn) {
      const fresh = retryBtn.cloneNode(true);
      retryBtn.replaceWith(fresh);
      fresh.addEventListener('click', () => {
        // Reset the availability flag so transient failures can be retried
        if (typeof directGecko !== 'undefined') directGecko._available = true;
        this.loadChart(this.currentInterval);
      });
    }
  },

  // Update chart OHLCV stats
  updateChartStats(data) {
    // Clear stats if no data
    if (!data || !data.data || !Array.isArray(data.data) || data.data.length === 0) {
      // Clear the stats display
      const statIds = ['chart-open', 'chart-high', 'chart-low', 'chart-close', 'chart-volume', 'chart-change'];
      statIds.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.textContent = '--';
      });
      return;
    }

    const allData = data.data;
    const lastCandle = allData[allData.length - 1];
    const isMcap = this.chartMetric === 'mcap';
    const supply = this.token?.supply || this.token?.circulatingSupply || 0;

    // Calculate period high/low with safeguards for empty/invalid data
    const highValues = allData.map(d => d.high || d.price || 0).filter(v => v > 0);
    const lowValues = allData.map(d => d.low || d.price || 0).filter(v => v > 0);

    // Guard against empty arrays which would cause Math.max/min to return Infinity/-Infinity
    let high = highValues.length > 0 ? Math.max(...highValues) : 0;
    let low = lowValues.length > 0 ? Math.min(...lowValues) : 0;
    let open = allData[0]?.open || allData[0]?.price || 0;
    let close = lastCandle?.close || lastCandle?.price || 0;
    const totalVolume = allData.reduce((sum, d) => sum + (d.volume || 0), 0);

    // Convert to MCAP values if needed
    if (isMcap && supply > 0) {
      high *= supply;
      low *= supply;
      open *= supply;
      close *= supply;
    }

    const formatFn = isMcap ? (v) => utils.formatNumber(v) : (v) => utils.formatPrice(v);

    const chartOpen = document.getElementById('chart-open');
    if (chartOpen) chartOpen.textContent = formatFn(open);
    const chartHigh = document.getElementById('chart-high');
    if (chartHigh) chartHigh.textContent = formatFn(high);
    const chartLow = document.getElementById('chart-low');
    if (chartLow) chartLow.textContent = formatFn(low);
    const chartClose = document.getElementById('chart-close');
    if (chartClose) chartClose.textContent = formatFn(close);
    const chartVol = document.getElementById('chart-volume');
    if (chartVol) chartVol.textContent = utils.formatNumber(totalVolume);
    const chartChange = document.getElementById('chart-change');
    if (chartChange && open > 0) {
      const pctChange = ((close - open) / open) * 100;
      chartChange.textContent = (pctChange >= 0 ? '+' : '') + pctChange.toFixed(2) + '%';
      chartChange.className = 'value ' + (pctChange >= 0 ? 'chart-change-up' : 'chart-change-down');
    } else if (chartChange) {
      chartChange.textContent = '--';
      chartChange.className = 'value';
    }
  },

  // Update the token header 24h high/low from the last 24 hourly OHLCV candles
  updateHeaderHighLow(data) {
    const highEl = document.getElementById('price-high');
    const lowEl  = document.getElementById('price-low');
    if (!highEl || !lowEl) return;
    if (!data?.data?.length) return;

    const candles = data.data.slice(-24); // last 24 hours
    const highs = candles.map(d => d.high || d.close || 0).filter(v => v > 0);
    const lows  = candles.map(d => d.low  || d.close || 0).filter(v => v > 0);

    if (highs.length > 0) highEl.textContent = utils.formatPrice(Math.max(...highs));
    if (lows.length  > 0) lowEl.textContent  = utils.formatPrice(Math.min(...lows));
  },

  // Create a TradingView Lightweight Chart instance.
  _createChart(container, isModal = false) {
    const formatValue = this.chartMetric === 'mcap'
      ? (v) => utils.formatNumber(v)
      : (v) => utils.formatPrice(v);

    // Read dimensions from the PARENT (.chart-container / .chart-modal-container)
    // which has explicit CSS height. The chart div itself may report 0 before
    // LWCV populates it.  Force a reflow first so values are up-to-date.
    const parent = container.parentElement;
    void (parent || container).offsetWidth;
    const w = (parent && parent.clientWidth) || container.clientWidth || 600;
    const h = (parent && parent.clientHeight) || container.clientHeight || 400;

    const chart = LightweightCharts.createChart(container, {
      width: w,
      height: h,
      layout: {
        background: { type: 'solid', color: 'transparent' },
        textColor: '#6b6b73',
        fontFamily: 'Inter, sans-serif',
        fontSize: 11
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { color: 'rgba(255, 255, 255, 0.04)' }
      },
      rightPriceScale: {
        borderVisible: false,
        mode: this.logScale ? LightweightCharts.PriceScaleMode.Logarithmic : LightweightCharts.PriceScaleMode.Normal,
      },
      timeScale: {
        borderVisible: false,
        timeVisible: true,
        secondsVisible: false
      },
      crosshair: {
        mode: LightweightCharts.CrosshairMode.Normal,
        vertLine: { color: 'rgba(255, 255, 255, 0.15)', style: LightweightCharts.LineStyle.Dashed, width: 1, labelBackgroundColor: 'rgba(99, 102, 241, 0.85)' },
        horzLine: { color: 'rgba(255, 255, 255, 0.15)', style: LightweightCharts.LineStyle.Dashed, width: 1, labelBackgroundColor: 'rgba(99, 102, 241, 0.85)' }
      },
      localization: {
        priceFormatter: formatValue
      },
      handleScroll: { mouseWheel: true, pressedMouseMove: isModal, horzTouchDrag: isModal, vertTouchDrag: false },
      handleScale: { axisPressedMouseMove: isModal, mouseWheel: true, pinch: true },
    });

    // Observe the PARENT container for resize — NOT the chart div itself.
    // Observing the chart div causes a feedback loop: LWCV's internal DOM
    // changes trigger ResizeObserver → applyOptions → LWCV rAF render while
    // still initializing → "Value is null" crash.  The parent has stable
    // CSS dimensions and only resizes on genuine layout changes.
    const observed = parent || container;
    let roRaf = 0;
    const ro = new ResizeObserver(() => {
      // Debounce: LWCV rendering is expensive and ResizeObserver can fire
      // in rapid bursts during layout thrashing.
      if (roRaf) return;
      roRaf = requestAnimationFrame(() => {
        roRaf = 0;
        const nw = observed.clientWidth;
        const nh = observed.clientHeight;
        if (nw > 0 && nh > 0) {
          try { chart.resize(nw, nh); } catch (_) {}
        }
      });
    });
    ro.observe(observed);
    chart._ro = ro;
    // Store a cleanup function that cancels any pending rAF
    chart._roCleanup = () => { if (roRaf) { cancelAnimationFrame(roRaf); roRaf = 0; } };

    return chart;
  },

  // Clean up a chart instance
  _removeChart(chart) {
    if (!chart) return;
    if (chart._roCleanup) { chart._roCleanup(); chart._roCleanup = null; }
    if (chart._ro) { chart._ro.disconnect(); chart._ro = null; }
    try { chart.remove(); } catch (_) {}
  },

  // ── TA Indicator Calculations ──────────────────────────

  _calcSMA(closes, times, period) {
    const result = [];
    for (let i = period - 1; i < closes.length; i++) {
      let sum = 0;
      for (let j = i - period + 1; j <= i; j++) sum += closes[j];
      result.push({ time: times[i], value: sum / period });
    }
    return result;
  },

  _calcEMA(closes, times, period) {
    if (closes.length < period) return [];
    const k = 2 / (period + 1);
    // Seed with SMA of first `period` values
    let sum = 0;
    for (let i = 0; i < period; i++) sum += closes[i];
    let ema = sum / period;
    const result = [{ time: times[period - 1], value: ema }];
    for (let i = period; i < closes.length; i++) {
      ema = closes[i] * k + ema * (1 - k);
      result.push({ time: times[i], value: ema });
    }
    return result;
  },

  _calcBollingerBands(closes, times, period = 20, mult = 2) {
    const upper = [], middle = [], lower = [];
    for (let i = period - 1; i < closes.length; i++) {
      let sum = 0;
      for (let j = i - period + 1; j <= i; j++) sum += closes[j];
      const mean = sum / period;
      let sqSum = 0;
      for (let j = i - period + 1; j <= i; j++) sqSum += (closes[j] - mean) ** 2;
      const stddev = Math.sqrt(sqSum / period);
      const t = times[i];
      upper.push({ time: t, value: mean + mult * stddev });
      middle.push({ time: t, value: mean });
      lower.push({ time: t, value: mean - mult * stddev });
    }
    return { upper, middle, lower };
  },

  // Add a simple line series to a chart
  _addLineSeries(chart, data, color, lineWidth = 1.5, lineStyle) {
    if (!data || data.length === 0) return;
    const series = chart.addSeries(LightweightCharts.LineSeries, {
      color,
      lineWidth,
      lineStyle: lineStyle || 0,
      priceScaleId: 'right',
      lastValueVisible: false,
      priceLineVisible: false,
    });
    series.setData(data);
  },

  // Add active indicators to a chart instance
  _addIndicators(chart, rawData) {
    if (!rawData || rawData.length === 0) return;
    const isMcap = this.chartMetric === 'mcap';
    const supply = this.token?.supply || this.token?.circulatingSupply || 0;

    const closes = rawData.map(d => {
      const c = d.close || d.price;
      return isMcap && supply > 0 ? c * supply : c;
    });
    const times = rawData.map(d => Math.floor((d.timestamp || d.time) / 1000));

    const hasAny = this.indicators.vol || this.indicators.sma || this.indicators.ema || this.indicators.bb;
    if (!hasAny) return;

    // Volume histogram
    if (this.indicators.vol) {
      const volSeries = chart.addSeries(LightweightCharts.HistogramSeries, {
        priceScaleId: 'volume',
        priceFormat: { type: 'volume' },
        lastValueVisible: false,
        priceLineVisible: false,
      });
      chart.priceScale('volume').applyOptions({
        scaleMargins: { top: 0.7, bottom: 0 },
      });
      volSeries.setData(rawData.map((d, i) => ({
        time: times[i],
        value: d.volume || 0,
        color: (d.close || d.price) >= (d.open || d.price)
          ? 'rgba(34, 197, 94, 0.3)' : 'rgba(239, 68, 68, 0.3)',
      })));
      // Push price series up to make room for volume
      chart.priceScale('right').applyOptions({
        scaleMargins: { top: 0.05, bottom: 0.35 },
      });
    }

    // SMA 7 + 25
    if (this.indicators.sma) {
      this._addLineSeries(chart, this._calcSMA(closes, times, 7), '#f59e0b', 1.5);
      this._addLineSeries(chart, this._calcSMA(closes, times, 25), '#3b82f6', 1.5);
    }

    // EMA 7 + 25 (dashed)
    if (this.indicators.ema) {
      this._addLineSeries(chart, this._calcEMA(closes, times, 7), '#f59e0b', 1.5, 2);
      this._addLineSeries(chart, this._calcEMA(closes, times, 25), '#3b82f6', 1.5, 2);
    }

    // Bollinger Bands (20, 2)
    if (this.indicators.bb) {
      const bb = this._calcBollingerBands(closes, times, 20, 2);
      this._addLineSeries(chart, bb.upper, '#8b5cf6', 1, 2);
      this._addLineSeries(chart, bb.middle, '#8b5cf6', 1);
      this._addLineSeries(chart, bb.lower, '#8b5cf6', 1, 2);
    }
  },

  // Render chart
  renderChart(data) {
    const container = document.getElementById('price-chart');
    if (!container) return;

    // Remove existing chart
    if (this.chart) {
      this._removeChart(this.chart);
      this.chart = null;
    }
    container.innerHTML = '';

    // Hide empty state
    const emptyEl = document.getElementById('chart-empty');
    if (emptyEl) emptyEl.style.display = 'none';

    // If no data, show placeholder
    if (!data || !data.data || data.data.length === 0) {
      this.renderEmptyChart('No chart data available');
      return;
    }

    const chartData = data.data;

    // If insufficient data points (less than 3), show new token placeholder
    if (chartData.length < 3) {
      this.renderEmptyChart('New Token! Waiting for chart data...', true);
      return;
    }

    if (this.chartType === 'candle' && chartData[0].open !== undefined) {
      this.renderCandlestickChart(container, chartData);
    } else {
      this.renderLineChart(container, chartData);
    }
  },

  // Deduplicate and sort OHLCV data by timestamp (LWCV requires unique ascending times)
  _dedup(data) {
    const seen = new Set();
    return data.filter(d => {
      const t = Math.floor((d.timestamp || d.time) / 1000);
      if (seen.has(t)) return false;
      seen.add(t);
      return true;
    }).sort((a, b) => (a.timestamp || a.time) - (b.timestamp || b.time));
  },

  // Subscribe to crosshairMove to live-update the OHLCV stats bar on hover.
  // When the crosshair leaves, stats revert to the full-period summary.
  _subscribeCrosshair(chart, rawData, isModal = false) {
    if (!chart || !rawData || rawData.length === 0) return;
    const isMcap = this.chartMetric === 'mcap';
    const supply = this.token?.supply || this.token?.circulatingSupply || 0;
    const fmt = isMcap ? (v) => utils.formatNumber(v) : (v) => utils.formatPrice(v);

    // Build a time→candle lookup for O(1) access
    const candleMap = new Map();
    for (const d of rawData) {
      const t = Math.floor((d.timestamp || d.time) / 1000);
      candleMap.set(t, d);
    }

    // Cache DOM elements once (avoids getElementById on every mouse move)
    const prefix = isModal ? 'modal-' : '';
    const elOpen   = document.getElementById(prefix + 'chart-open');
    const elHigh   = document.getElementById(prefix + 'chart-high');
    const elLow    = document.getElementById(prefix + 'chart-low');
    const elClose  = document.getElementById(prefix + 'chart-close');
    const elVolume = document.getElementById(prefix + 'chart-volume');
    const elChange = document.getElementById(prefix + 'chart-change');
    const self = this;

    chart.subscribeCrosshairMove((param) => {
      if (!param || !param.time || param.point === undefined) {
        // Crosshair left — restore full-period stats
        if (isModal) {
          self._updateModalStats(self.chartData);
        } else {
          self.updateChartStats(self.chartData);
        }
        return;
      }
      const candle = candleMap.get(param.time);
      if (!candle) return;

      let o = candle.open || candle.price || 0;
      let h = candle.high || candle.price || 0;
      let l = candle.low || candle.price || 0;
      let c = candle.close || candle.price || 0;
      if (isMcap && supply > 0) { o *= supply; h *= supply; l *= supply; c *= supply; }

      if (elOpen)   elOpen.textContent = fmt(o);
      if (elHigh)   elHigh.textContent = fmt(h);
      if (elLow)    elLow.textContent = fmt(l);
      if (elClose)  elClose.textContent = fmt(c);
      if (elVolume) elVolume.textContent = utils.formatNumber(candle.volume || 0);

      if (elChange && o > 0) {
        const pct = ((c - o) / o) * 100;
        elChange.textContent = (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%';
        elChange.className = 'value ' + (pct >= 0 ? 'chart-change-up' : 'chart-change-down');
      }
    });
  },

  // Render line chart with TradingView Lightweight Charts
  renderLineChart(container, data) {
    data = this._dedup(data);
    if (data.length === 0) return;
    const isMcap = this.chartMetric === 'mcap';
    const supply = this.token?.supply || this.token?.circulatingSupply || 0;

    const seriesData = data.map(d => ({
      time: Math.floor((d.timestamp || d.time) / 1000),
      value: isMcap && supply > 0 ? (d.close || d.price) * supply : (d.close || d.price)
    }));

    const isPositive = seriesData[seriesData.length - 1].value >= seriesData[0].value;
    let chart;
    try {
      chart = this._createChart(container, false);
    } catch (e) {
      console.warn('[Chart] createChart failed:', e.message);
      this.renderEmptyChart('Chart rendering failed — try refreshing');
      return;
    }
    const series = chart.addSeries(LightweightCharts.AreaSeries, {
      lineColor: isPositive ? '#22c55e' : '#ef4444',
      topColor: isPositive ? 'rgba(34, 197, 94, 0.15)' : 'rgba(239, 68, 68, 0.15)',
      bottomColor: 'transparent',
      lineWidth: 2,
    });
    series.setData(seriesData);
    this._addIndicators(chart, data);
    chart.timeScale().fitContent();
    this.chart = chart;
    this._mainSeries = series;
    this._subscribeCrosshair(chart, data, false);
  },

  // Render candlestick chart with TradingView Lightweight Charts
  renderCandlestickChart(container, data) {
    data = this._dedup(data);
    if (data.length === 0) return;
    const isMcap = this.chartMetric === 'mcap';
    const supply = this.token?.supply || this.token?.circulatingSupply || 0;

    const seriesData = data.map(d => {
      let o = d.open || d.price;
      let h = d.high || d.price;
      let l = d.low || d.price;
      let c = d.close || d.price;
      if (isMcap && supply > 0) { o *= supply; h *= supply; l *= supply; c *= supply; }
      return {
        time: Math.floor((d.timestamp || d.time) / 1000),
        open: o, high: h, low: l, close: c
      };
    });

    let chart;
    try {
      chart = this._createChart(container, false);
    } catch (e) {
      console.warn('[Chart] createChart failed:', e.message);
      this.renderEmptyChart('Chart rendering failed — try refreshing');
      return;
    }
    const series = chart.addSeries(LightweightCharts.CandlestickSeries, {
      upColor: '#22c55e',
      downColor: '#ef4444',
      borderUpColor: '#22c55e',
      borderDownColor: '#ef4444',
      wickUpColor: '#22c55e',
      wickDownColor: '#ef4444',
    });
    series.setData(seriesData);
    this._addIndicators(chart, data);
    chart.timeScale().fitContent();
    this.chart = chart;
    this._mainSeries = series;
    this._subscribeCrosshair(chart, data, false);
  },

  // Render empty chart placeholder
  renderEmptyChart(message = 'No chart data available', isNewToken = false) {
    const container = document.getElementById('price-chart');
    if (container) container.innerHTML = '';

    if (this.chart) {
      this._removeChart(this.chart);
      this.chart = null;
    }

    const emptyEl = document.getElementById('chart-empty');
    if (!emptyEl) return;
    emptyEl.style.display = 'flex';
    emptyEl.textContent = isNewToken ? message + ' Check back soon for price history.' : message;
    emptyEl.style.color = isNewToken ? '#60a5fa' : '#6b6b73';
  },

  // ── DexScreener Curated Data ──

  async loadCuratedData() {
    try {
      const data = await api.curated.get(this.mint);
      if (data && data.token) {
        this.renderCuratedBanner(data.token);
        this.renderCuratedSocials(data.token);
      }
    } catch { /* Token may not be curated - that's fine */ }
  },

  renderCuratedBanner(token) {
    if (!token.bannerUrl) return;
    const container = document.getElementById('token-banner');
    if (!container) return;
    container.innerHTML = `<img src="${utils.escapeHtml(token.bannerUrl)}" alt="Token banner" class="token-banner-img">`;
    container.style.display = '';
  },

  renderCuratedSocials(token) {
    if (!token.socials) return;
    const container = document.getElementById('token-socials');
    if (!container) return;
    const links = [];
    const { twitter, telegram, discord, website, tiktok } = token.socials;
    if (twitter) links.push(`<a href="${utils.escapeHtml(twitter)}" target="_blank" rel="noopener" class="social-chip"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>Twitter</a>`);
    if (telegram) links.push(`<a href="${utils.escapeHtml(telegram)}" target="_blank" rel="noopener" class="social-chip"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>Telegram</a>`);
    if (discord) links.push(`<a href="${utils.escapeHtml(discord)}" target="_blank" rel="noopener" class="social-chip"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03z"/></svg>Discord</a>`);
    if (website) links.push(`<a href="${utils.escapeHtml(website)}" target="_blank" rel="noopener" class="social-chip"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>Website</a>`);
    if (tiktok) links.push(`<a href="${utils.escapeHtml(tiktok)}" target="_blank" rel="noopener" class="social-chip">TikTok</a>`);
    if (links.length > 0) {
      container.innerHTML = links.join('');
      container.style.display = '';
    }
  },

  // Escape HTML to prevent XSS - safe in both text nodes and attribute values
  escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  },

  // Start freshness display timer (updates every second)
  startFreshnessTimer() {
    this.freshnessInterval = setInterval(() => {
      this.updateFreshnessDisplay();
    }, 1000);
  },

  // Update the price freshness display
  updateFreshnessDisplay() {
    const container = document.getElementById('price-freshness');
    if (!container || !this.lastPriceUpdate) return;

    const age = Date.now() - this.lastPriceUpdate;
    const timeUntilRefresh = Math.max(0, this.refreshIntervalMs - age);
    const isStale = age > this.staleThresholdMs;

    // Update stale class
    container.classList.toggle('stale', isStale);

    // Format "Updated X ago" text
    const freshnessText = container.querySelector('.freshness-text');
    if (freshnessText) {
      if (age < 5000) {
        freshnessText.textContent = 'Updated just now';
      } else if (age < 60000) {
        freshnessText.textContent = `Updated ${Math.floor(age / 1000)}s ago`;
      } else {
        const mins = Math.floor(age / 60000);
        freshnessText.textContent = `Updated ${mins}m ago`;
      }
    }

    // Format countdown to next refresh
    const countdown = container.querySelector('.countdown');
    if (countdown) {
      if (timeUntilRefresh > 0) {
        const mins = Math.floor(timeUntilRefresh / 60000);
        const secs = Math.floor((timeUntilRefresh % 60000) / 1000);
        countdown.textContent = mins > 0 ? `(${mins}m ${secs}s)` : `(${secs}s)`;
      } else {
        countdown.textContent = '(refreshing...)';
      }
    }
  },

  // Record page view (fire-and-forget, non-blocking)
  async recordView() {
    try {
      // Check if the API method exists (handles cached old api.js)
      if (typeof api?.tokens?.recordView !== 'function') {
        console.warn('View tracking: api.tokens.recordView not available (clear browser cache)');
        return;
      }
      const result = await api.tokens.recordView(this.mint);
      // Update display with returned view count
      if (result && result.views !== undefined) {
        this.updateViewCount(result.views);
      }
    } catch (error) {
      // Non-critical - silently fail
      console.warn('View tracking failed:', error.message);
    }
  },

  // Update the view count display
  updateViewCount(views) {
    const viewsEl = document.getElementById('stat-views');
    if (viewsEl) {
      viewsEl.textContent = views.toLocaleString();
    }
  },

  // Cleanup on page unload
  destroy() {
    // Clear all intervals
    if (this.priceRefreshInterval) {
      clearInterval(this.priceRefreshInterval);
      this.priceRefreshInterval = null;
    }
    if (this.freshnessInterval) {
      clearInterval(this.freshnessInterval);
      this.freshnessInterval = null;
    }
    if (this._holdersTimestampInterval) {
      clearInterval(this._holdersTimestampInterval);
      this._holdersTimestampInterval = null;
    }

    // Clear polling timers
    if (this._holdTimesTimer) { clearTimeout(this._holdTimesTimer); this._holdTimesTimer = null; }
    if (this._diamondHandsTimer) { clearTimeout(this._diamondHandsTimer); this._diamondHandsTimer = null; }

    // Stop chart auto-refresh
    this._stopChartRefresh();

    // Destroy chart safely
    if (this.chart) {
      try {
        this._removeChart(this.chart);
      } catch (e) {
        console.warn('Chart destruction failed:', e.message);
      }
      this.chart = null;
    }

    // Remove all event listeners
    this.unbindEvents();

    // Remove visibility handler (not tracked in boundHandlers)
    if (this.visibilityHandler) {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
    }

    // Close modal if open
    if (this._modalOpen) this.closeChartModal();
  },

  // ── Chart Expand Modal ──────────────────────────────────

  async openChartModal() {
    if (this._modalOpen) return;
    this._modalOpen = true;

    const overlay = document.getElementById('chart-modal-overlay');
    if (!overlay) return;

    this._syncModalControls();
    overlay.style.display = 'flex';
    document.body.style.overflow = 'hidden';

    // Yield so the modal container gets layout dimensions before LWCV creates the chart
    await new Promise(r => requestAnimationFrame(r));

    this._renderModalChart();
    this._bindModalControls();
  },

  closeChartModal() {
    if (!this._modalOpen) return;
    this._modalOpen = false;

    const overlay = document.getElementById('chart-modal-overlay');
    if (overlay) overlay.style.display = 'none';
    document.body.style.overflow = '';

    // Close fib settings popover if open
    const fibPop = document.getElementById('fib-settings-popover');
    if (fibPop) fibPop.remove();
    if (typeof ChartDrawTools !== 'undefined') ChartDrawTools.destroy();

    if (this.modalChart) {
      this._removeChart(this.modalChart);
      this.modalChart = null;
    }
    this._modalMainSeries = null;

    if (this._modalEscHandler) {
      document.removeEventListener('keydown', this._modalEscHandler);
      this._modalEscHandler = null;
    }
  },

  _syncModalControls() {
    document.querySelectorAll('.modal-metric-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.metric === this.chartMetric);
    });
    document.querySelectorAll('.modal-type-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.type === this.chartType);
    });
    document.querySelectorAll('.modal-timeframe-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.interval === this.currentInterval);
    });
    document.querySelectorAll('.modal-indicator-btn').forEach(btn => {
      const ind = btn.dataset.indicator;
      if (ind === 'log') {
        btn.classList.toggle('active', this.logScale);
      } else {
        btn.classList.toggle('active', this.indicators[ind]);
      }
    });
    const modalTitle = document.getElementById('chart-modal-title');
    if (modalTitle) {
      modalTitle.textContent = this.chartMetric === 'mcap' ? 'Market Cap Chart' : 'Price Chart';
    }
    if (this.chartData) this._updateModalStats(this.chartData);
  },

  _bindModalControls() {
    const self = this;

    // Close button
    const closeBtn = document.getElementById('chart-modal-close');
    if (closeBtn && !closeBtn._mBound) {
      closeBtn._mBound = true;
      closeBtn.addEventListener('click', () => self.closeChartModal());
    }

    // Background click
    const overlay = document.getElementById('chart-modal-overlay');
    if (overlay && !overlay._mBound) {
      overlay._mBound = true;
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) self.closeChartModal();
      });
    }

    // Escape key
    this._modalEscHandler = (e) => {
      if (e.key === 'Escape' && self._modalOpen) self.closeChartModal();
    };
    document.addEventListener('keydown', this._modalEscHandler);

    // Metric buttons
    document.querySelectorAll('.modal-metric-btn').forEach(btn => {
      if (btn._mBound) return;
      btn._mBound = true;
      btn.addEventListener('click', () => {
        document.querySelectorAll('.modal-metric-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        self.chartMetric = btn.dataset.metric;
        // Sync page buttons
        document.querySelectorAll('.chart-metric-btn:not(.modal-metric-btn)').forEach(b => {
          b.classList.toggle('active', b.dataset.metric === self.chartMetric);
        });

        const titleText = self.chartMetric === 'mcap' ? 'Market Cap Chart' : 'Price Chart';
        const pt = document.getElementById('chart-title');
        if (pt) pt.textContent = titleText;
        const mt = document.getElementById('chart-modal-title');
        if (mt) mt.textContent = titleText;
        if (self.chartData) {
          self.renderChart(self.chartData);
          self._renderModalChart();
          self.updateChartStats(self.chartData);
          self._updateModalStats(self.chartData);
        }
      });
    });

    // Type buttons
    document.querySelectorAll('.modal-type-btn').forEach(btn => {
      if (btn._mBound) return;
      btn._mBound = true;
      btn.addEventListener('click', () => {
        document.querySelectorAll('.modal-type-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        self.chartType = btn.dataset.type;
        // Sync page buttons
        document.querySelectorAll('.chart-type-btn:not(.modal-type-btn)').forEach(b => {
          b.classList.toggle('active', b.dataset.type === self.chartType);
        });
        if (self.chartData) {
          self.renderChart(self.chartData);
          self._renderModalChart();
        }
      });
    });

    // Timeframe buttons
    document.querySelectorAll('.modal-timeframe-btn').forEach(btn => {
      if (btn._mBound) return;
      btn._mBound = true;
      btn.addEventListener('click', () => {
        document.querySelectorAll('.modal-timeframe-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const interval = btn.dataset.interval;
        self.currentInterval = interval;
        // Sync page buttons
        document.querySelectorAll('.timeframe-btn:not(.modal-timeframe-btn)').forEach(b => {
          b.classList.toggle('active', b.dataset.interval === interval);
        });

        self._loadModalChart(interval);
      });
    });

    // Indicator toggle buttons
    document.querySelectorAll('.modal-indicator-btn').forEach(btn => {
      if (btn._mBound) return;
      btn._mBound = true;
      btn.addEventListener('click', () => {
        const ind = btn.dataset.indicator;

        // Log scale is a separate toggle
        if (ind === 'log') {
          self.logScale = !self.logScale;
          btn.classList.toggle('active', self.logScale);
          document.querySelectorAll('.indicator-btn:not(.modal-indicator-btn)[data-indicator="log"]').forEach(b =>
            b.classList.toggle('active', self.logScale)
          );
          if (self.chartData) {
            self.renderChart(self.chartData);
            self._renderModalChart();
          }
          return;
        }

        self.indicators[ind] = !self.indicators[ind];
        btn.classList.toggle('active', self.indicators[ind]);
        // Sync page buttons
        document.querySelectorAll(`.indicator-btn:not(.modal-indicator-btn)[data-indicator="${ind}"]`).forEach(b =>
          b.classList.toggle('active', self.indicators[ind])
        );
        if (self.chartData) {
          self.renderChart(self.chartData);
          self._renderModalChart();
        }
      });
    });

    // Draw tool buttons (modal only)
    const trendBtn = document.getElementById('chart-tool-trend');
    if (trendBtn && !trendBtn._mBound) {
      trendBtn._mBound = true;
      trendBtn.addEventListener('click', () => {
        if (typeof ChartDrawTools !== 'undefined') ChartDrawTools.setMode('trend');
      });
    }
    const fibBtn = document.getElementById('chart-tool-fib');
    if (fibBtn && !fibBtn._mBound) {
      fibBtn._mBound = true;
      fibBtn.addEventListener('click', () => {
        if (typeof ChartDrawTools !== 'undefined') ChartDrawTools.setMode('fib');
      });
    }
    const fibSettingsBtn = document.getElementById('chart-tool-fib-settings');
    if (fibSettingsBtn && !fibSettingsBtn._mBound) {
      fibSettingsBtn._mBound = true;
      fibSettingsBtn.addEventListener('click', () => {
        if (typeof ChartDrawTools !== 'undefined') ChartDrawTools.toggleFibSettings();
      });
    }
    const clearBtn = document.getElementById('chart-tool-clear');
    if (clearBtn && !clearBtn._mBound) {
      clearBtn._mBound = true;
      clearBtn.addEventListener('click', () => {
        if (typeof ChartDrawTools !== 'undefined') ChartDrawTools.clear();
      });
    }
    const cancelBtn = document.getElementById('chart-tool-cancel');
    if (cancelBtn && !cancelBtn._mBound) {
      cancelBtn._mBound = true;
      cancelBtn.addEventListener('click', () => {
        if (typeof ChartDrawTools !== 'undefined') ChartDrawTools._cancelDrawing();
      });
    }

    // Zoom controls
    const zoomIn = document.getElementById('chart-zoom-in');
    if (zoomIn && !zoomIn._mBound) {
      zoomIn._mBound = true;
      zoomIn.addEventListener('click', () => {
        if (!self.modalChart) return;
        const range = self.modalChart.timeScale().getVisibleLogicalRange();
        if (!range) return;
        const span = range.to - range.from;
        const shrink = span * 0.2;
        self.modalChart.timeScale().setVisibleLogicalRange({ from: range.from + shrink, to: range.to - shrink });
      });
    }
    const zoomOut = document.getElementById('chart-zoom-out');
    if (zoomOut && !zoomOut._mBound) {
      zoomOut._mBound = true;
      zoomOut.addEventListener('click', () => {
        if (!self.modalChart) return;
        const range = self.modalChart.timeScale().getVisibleLogicalRange();
        if (!range) return;
        const span = range.to - range.from;
        const grow = span * 0.2;
        self.modalChart.timeScale().setVisibleLogicalRange({ from: range.from - grow, to: range.to + grow });
      });
    }
    const zoomReset = document.getElementById('chart-zoom-reset');
    if (zoomReset && !zoomReset._mBound) {
      zoomReset._mBound = true;
      zoomReset.addEventListener('click', () => { if (self.modalChart) self.modalChart.timeScale().fitContent(); });
    }
  },

  _renderModalChart() {
    const container = document.getElementById('modal-price-chart');
    if (!container) return;

    // Destroy draw tools before re-creating chart (clears drawings on timeframe/type change)
    if (typeof ChartDrawTools !== 'undefined') ChartDrawTools.destroy();

    if (this.modalChart) {
      this._removeChart(this.modalChart);
      this.modalChart = null;
    }
    this._modalMainSeries = null;
    container.innerHTML = '';

    if (!this.chartData?.data?.length || this.chartData.data.length < 3) return;

    const chartData = this.chartData.data;
    if (this.chartType === 'candle' && chartData[0].open !== undefined) {
      this._renderModalCandlestick(container, chartData);
    } else {
      this._renderModalLine(container, chartData);
    }

    // Initialize draw tools with the new modal chart + series
    if (typeof ChartDrawTools !== 'undefined' && this.modalChart && this._modalMainSeries) {
      ChartDrawTools.init(this.modalChart, this._modalMainSeries);
    }
  },

  _renderModalLine(container, data) {
    data = this._dedup(data);
    if (data.length === 0) return;
    const isMcap = this.chartMetric === 'mcap';
    const supply = this.token?.supply || this.token?.circulatingSupply || 0;

    const seriesData = data.map(d => ({
      time: Math.floor((d.timestamp || d.time) / 1000),
      value: isMcap && supply > 0 ? (d.close || d.price) * supply : (d.close || d.price)
    }));

    const isPositive = seriesData[seriesData.length - 1].value >= seriesData[0].value;
    let chart;
    try {
      chart = this._createChart(container, true);
    } catch (e) {
      console.warn('[Modal] createChart failed:', e.message);
      return;
    }
    const series = chart.addSeries(LightweightCharts.AreaSeries, {
      lineColor: isPositive ? '#22c55e' : '#ef4444',
      topColor: isPositive ? 'rgba(34, 197, 94, 0.15)' : 'rgba(239, 68, 68, 0.15)',
      bottomColor: 'transparent',
      lineWidth: 2,
    });
    series.setData(seriesData);
    this._addIndicators(chart, data);
    chart.timeScale().fitContent();
    this.modalChart = chart;
    this._modalMainSeries = series;
    this._subscribeCrosshair(chart, data, true);
  },

  _renderModalCandlestick(container, data) {
    data = this._dedup(data);
    if (data.length === 0) return;
    const isMcap = this.chartMetric === 'mcap';
    const supply = this.token?.supply || this.token?.circulatingSupply || 0;

    const seriesData = data.map(d => {
      let o = d.open || d.price;
      let h = d.high || d.price;
      let l = d.low || d.price;
      let c = d.close || d.price;
      if (isMcap && supply > 0) { o *= supply; h *= supply; l *= supply; c *= supply; }
      return {
        time: Math.floor((d.timestamp || d.time) / 1000),
        open: o, high: h, low: l, close: c
      };
    });

    let chart;
    try {
      chart = this._createChart(container, true);
    } catch (e) {
      console.warn('[Modal] createChart failed:', e.message);
      return;
    }
    const series = chart.addSeries(LightweightCharts.CandlestickSeries, {
      upColor: '#22c55e',
      downColor: '#ef4444',
      borderUpColor: '#22c55e',
      borderDownColor: '#ef4444',
      wickUpColor: '#22c55e',
      wickDownColor: '#ef4444',
    });
    series.setData(seriesData);
    this._addIndicators(chart, data);
    chart.timeScale().fitContent();
    this.modalChart = chart;
    this._modalMainSeries = series;
    this._subscribeCrosshair(chart, data, true);
  },

  async _loadModalChart(interval) {
    try {
      // loadChart already re-renders the page chart and updates stats.
      // It also sets this.chartData, which _renderModalChart reads.
      await this.loadChart(interval);
      // Now render the modal chart with the updated data
      this._renderModalChart();
      if (this.chartData) this._updateModalStats(this.chartData);
    } catch (e) {
      console.warn('[Modal] Failed to load chart:', e.message);
    }
  },

  _updateModalStats(data) {
    if (!data?.data?.length) return;
    const allData = data.data;
    const lastCandle = allData[allData.length - 1];
    const isMcap = this.chartMetric === 'mcap';
    const supply = this.token?.supply || this.token?.circulatingSupply || 0;

    const highValues = allData.map(d => d.high || d.price || 0).filter(v => v > 0);
    const lowValues = allData.map(d => d.low || d.price || 0).filter(v => v > 0);
    let high = highValues.length > 0 ? Math.max(...highValues) : 0;
    let low = lowValues.length > 0 ? Math.min(...lowValues) : 0;
    let open = allData[0]?.open || allData[0]?.price || 0;
    let close = lastCandle?.close || lastCandle?.price || 0;
    const totalVolume = allData.reduce((sum, d) => sum + (d.volume || 0), 0);

    if (isMcap && supply > 0) { high *= supply; low *= supply; open *= supply; close *= supply; }
    const fmt = isMcap ? (v) => utils.formatNumber(v) : (v) => utils.formatPrice(v);

    const el = (id) => document.getElementById(id);
    if (el('modal-chart-open'))   el('modal-chart-open').textContent = fmt(open);
    if (el('modal-chart-high'))   el('modal-chart-high').textContent = fmt(high);
    if (el('modal-chart-low'))    el('modal-chart-low').textContent = fmt(low);
    if (el('modal-chart-close'))  el('modal-chart-close').textContent = fmt(close);
    if (el('modal-chart-volume')) el('modal-chart-volume').textContent = utils.formatNumber(totalVolume);
    const changeEl = el('modal-chart-change');
    if (changeEl && open > 0) {
      const pctChange = ((close - open) / open) * 100;
      changeEl.textContent = (pctChange >= 0 ? '+' : '') + pctChange.toFixed(2) + '%';
      changeEl.className = 'value ' + (pctChange >= 0 ? 'chart-change-up' : 'chart-change-down');
    } else if (changeEl) {
      changeEl.textContent = '--';
      changeEl.className = 'value';
    }
  }
};

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
  tokenDetail.init();
});

// Reinitialize when restored from bfcache (browser back/forward navigation).
// DOMContentLoaded does NOT fire when a page is restored from bfcache, so
// the chart and intervals remain destroyed from the pagehide handler.
window.addEventListener('pageshow', (event) => {
  if (event.persisted) {
    tokenDetail.destroy();
    tokenDetail.init();
  }
});

// Cleanup on page hide (works with bfcache, unlike beforeunload)
window.addEventListener('pagehide', () => {
  tokenDetail.destroy();
});
