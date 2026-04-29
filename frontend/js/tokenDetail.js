// Token Detail Page Logic
const tokenDetail = {
  mint: null,
  token: null,
  pools: [],

  priceRefreshInterval: null,
  freshnessInterval: null,
  lastPriceUpdate: null,
  _consecutivePriceErrors: 0, // Circuit breaker for price refresh

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
      // Load token data first — everything else depends on this.token being populated
      await this.loadToken();
      this.hideLoading();

      // Yield to the browser so it can reflow the just-shown #token-content.
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

      this.lastPriceUpdate = Date.now();
      this.updateFreshnessDisplay();

      // Record page view (fire-and-forget, non-blocking, skip on bfcache restore)
      if (!this._viewRecorded) {
        this._viewRecorded = true;
        this.recordView();
      }

      // Phase 2: Load dependent data now that this.token is populated and content is visible.
      // These run in parallel — holder analytics needs this.token.pairCreatedAt for age-gated rows.
      const phase2 = Promise.all([
        this.loadPools(),
        this.loadHolderAnalytics(),
        this.loadDexScreenerData()
      ]).catch(() => {});

      await phase2;

      // Start price refresh and freshness timer
      this.startPriceRefresh();
      this.startFreshnessTimer();

      // Update watchlist button once watchlist finishes loading (may still be in-flight)
      this.updateWatchlistButton();
      window.addEventListener('watchlistReady', () => this.updateWatchlistButton(), { once: true });
      this._walletConnectedHandler = () => {
        setTimeout(() => this.updateWatchlistButton(), 500);
      };
      window.addEventListener('walletConnected', this._walletConnectedHandler);
    } catch (error) {
      console.error('Failed to initialize token page:', error.message);
      if (error.code === 'NOT_CURATED') {
        this.showError('This token is not available on CultScreener. Only curated tokens listed on the leaderboard can be viewed.', 'Token Not Available');
      } else {
        this.showError('Failed to load token data. Please try again.');
      }
    }
  },

  // Show skeleton loading state
  showLoading() {
    const loading = document.getElementById('loading-state');
    const content = document.getElementById('token-content');
    const error = document.getElementById('error-state');

    if (loading) loading.style.display = '';
    if (content) content.style.display = 'none';
    if (error) error.style.display = 'none';
  },

  // Hide skeleton and reveal content with animation
  hideLoading() {
    const loading = document.getElementById('loading-state');
    const content = document.getElementById('token-content');

    if (loading) loading.style.display = 'none';
    if (content) content.style.display = 'block';
  },

  // Show error state
  showError(message, title) {
    const loading = document.getElementById('loading-state');
    const content = document.getElementById('token-content');
    const error = document.getElementById('error-state');
    const errorMsg = document.getElementById('error-message');
    const errorTitle = document.getElementById('error-title');

    if (loading) loading.style.display = 'none';
    if (content) content.style.display = 'none';
    if (error) error.style.display = 'flex';
    if (errorTitle && title) errorTitle.textContent = title;
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

    // Share button — copies a share URL with rich social media previews
    const shareBtn = document.getElementById('share-btn');
    const shareHandler = async () => {
      // Use backend share route for rich social media embeds
      const shareUrl = `${config.api.baseUrl}/share/${this.mint}`;
      const copied = await utils.copyToClipboard(shareUrl);
      if (copied) toast.success('Share link copied to clipboard');
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
      console.error('Price refresh failed:', error.message);
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
      if (typeof config !== 'undefined' && config.app?.debug) console.log('[TokenDetail] Loading token:', this.mint);
      this.token = await api.tokens.get(this.mint);

      if (typeof config !== 'undefined' && config.app?.debug) console.log('[TokenDetail] Token data received:', JSON.stringify(this.token, null, 2));

      if (!this.token) {
        throw new Error('Token not found');
      }

      const isPreview = !this.token.holders;
      this.renderToken();

      // If initial data came from list-page preview (sessionStorage seed), fetch full detail
      // before Phase 2 starts so this.token.pairCreatedAt is available for diamond hands
      if (isPreview) {
        try {
          const fullData = await api.tokens.get(this.mint, { fresh: true });
          if (fullData && this.mint === this.mint) {
            this.token = fullData;
            this.renderToken();
          }
        } catch { /* Full fetch failed, continue with preview data */ }
      }
    } catch (err) {
      _ok = false;
      throw err;
    } finally {
      if (typeof latencyTracker !== 'undefined') latencyTracker.record('tokenDetail.load', performance.now() - _t0, _ok, 'frontend');
    }
  },

  // Update OG meta tags for social media previews (JS-capable crawlers)
  _updateMetaTags(token) {
    const name = token.name || token.symbol || 'Token';
    const symbol = token.symbol || '';
    const title = `${name}${symbol ? ` (${symbol})` : ''} - CultScreener`;

    const parts = [];
    if (token.price) parts.push(utils.formatPrice(token.price));
    const change = token.priceChange24h;
    if (change != null) parts.push(`${change >= 0 ? '+' : ''}${change.toFixed(2)}% 24h`);
    if (token.marketCap) parts.push(`MCap ${utils.formatNumber(token.marketCap)}`);
    const desc = parts.length > 0
      ? parts.join(' | ') + ' | CultScreener'
      : 'View token details and diamond hands conviction data on CultScreener.';

    const apiBase = (typeof config !== 'undefined' && config.api?.baseUrl) || '';
    const ogImage = `${apiBase}/share/${encodeURIComponent(this.mint)}/og-image`;
    const pageUrl = window.location.href;

    const updates = {
      'og:title': title, 'og:description': desc, 'og:image': ogImage, 'og:url': pageUrl,
      'twitter:title': title, 'twitter:description': desc, 'twitter:image': ogImage
    };

    for (const [key, value] of Object.entries(updates)) {
      const attr = key.startsWith('og:') ? 'property' : 'name';
      let el = document.querySelector(`meta[${attr}="${key}"]`);
      if (!el) {
        el = document.createElement('meta');
        el.setAttribute(attr, key);
        document.head.appendChild(el);
      }
      el.setAttribute('content', value);
    }

    // Also update description meta
    const descMeta = document.querySelector('meta[name="description"]');
    if (descMeta) descMeta.setAttribute('content', desc);
  },

  // Update price display only
  updatePriceDisplay() {
    // Price is now always a direct number from the API
    const price = this.token.price || 0;
    const change = this.token.priceChange24h || 0;

    if (typeof config !== 'undefined' && config.app?.debug) console.log('[TokenDetail] Price display:', { price, change, token: this.token });

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

    // Update page title and social media meta tags
    document.title = `${token.name} (${token.symbol}) - CultScreener`;
    this._updateMetaTags(token);

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

    // Stats — populate and remove placeholder styling
    const setStat = (id, value) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.textContent = value;
      el.classList.remove('stat-placeholder');
    };

    setStat('stat-mcap', utils.formatNumber(token.marketCap));
    setStat('stat-volume', utils.formatNumber(token.volume24h));
    setStat('stat-liquidity', utils.formatNumber(token.liquidity));

    const holdersCount = (typeof token.holders === 'number' && token.holders > 0) ? token.holders : null;
    setStat('stat-holders', holdersCount ? holdersCount.toLocaleString() : '--');
    const holdersTotalEl = document.getElementById('holders-total-count');
    if (holdersTotalEl) holdersTotalEl.textContent = holdersCount ? holdersCount.toLocaleString() : '--';

    setStat('stat-supply', token.supply ? utils.formatNumber(token.supply, '') : '--');
    setStat('stat-circulating', token.circulatingSupply ? utils.formatNumber(token.circulatingSupply, '') : '--');

    const ageEl = document.getElementById('stat-age');
    const holdersAgeEl = document.getElementById('holders-token-age');
    if (ageEl) {
      if (token.pairCreatedAt) {
        ageEl.textContent = utils.formatAge(token.pairCreatedAt);
        ageEl.title = new Date(token.pairCreatedAt).toLocaleDateString();
      } else {
        ageEl.textContent = 'N/A';
      }
      ageEl.classList.remove('stat-placeholder');
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

    // Render banner and socials from backend-cached DexScreener data if available.
    // loadDexScreenerData() in Phase 2 will refresh these from DexScreener directly.
    if (token.bannerUrl) {
      this._renderBanner(token.bannerUrl);
    }
    if (token.socials && Object.keys(token.socials).length > 0) {
      this._renderSocials(token.socials);
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
        listEl.innerHTML = this.pools.slice(0, 5).map(pool => {
          const tvl = pool.tvl != null ? utils.formatNumber(pool.tvl) : '--';
          const vol = pool.volume24h != null ? utils.formatNumber(pool.volume24h) : '--';
          return `
          <div class="pool-card">
            <div class="pool-pair">
              <span class="pool-symbols">${this.escapeHtml(pool.symbolA || '?')}/${this.escapeHtml(pool.symbolB || '?')}</span>
              <span class="pool-type">${this.escapeHtml(pool.type || 'AMM')}</span>
            </div>
            <div class="pool-stats">
              <div class="pool-stat">
                <span class="label">TVL</span>
                <span class="value">${tvl}</span>
              </div>
              <div class="pool-stat">
                <span class="label">24h Volume</span>
                <span class="value">${vol}</span>
              </div>
            </div>
          </div>`;
        }).join('');
      }
    } catch (error) {
      _ok = false;
      console.error('Failed to load pools:', error.message);
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
      // Reset Diamond Hands bars back to loading shimmer
      this._resetDiamondHandsToLoading();
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
        // Show diamond hands as unavailable
        this._showDiamondHandsUnavailable();
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

        // Update holder count in BOTH boxes (always overwrite with fresh data from holders endpoint)
        if (metrics.holderCount && metrics.holderCount > 0) {
          const count = metrics.holderCount.toLocaleString();
          const holdersStatEl = document.getElementById('stat-holders');
          if (holdersStatEl) holdersStatEl.textContent = count;
          const holdersTotalEl = document.getElementById('holders-total-count');
          if (holdersTotalEl) holdersTotalEl.textContent = count;
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
    if (!holders || holders.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:1.5rem;color:var(--text-muted);">No holder data available.</td></tr>';
      return;
    }
    const price = this.token && this.token.price ? this.token.price : 0;
    const esc = (s) => utils.escapeHtml(s);
    tbody.innerHTML = holders.slice(0, limit).map(h => {
      const addr = esc(h.address);
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
      const tokenHoldStr = (h.isLP || h.isBurnt) ? '--'
        : (this._tokenHoldTimesData && this._tokenHoldTimesData[h.address])
          ? this._formatHoldTime(this._tokenHoldTimesData[h.address])
          : this._holdTimesLoaded ? '--'
          : `<span class="token-hold-pending" data-wallet="${addr}">...</span>`;
      return `<tr${rowClass}>
        <td>${h.rank}</td>
        <td><a href="https://solscan.io/account/${addr}" target="_blank" rel="noopener" class="holder-address" title="${addr}">${shortAddr}</a>${label}</td>
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
      if (typeof config !== 'undefined' && config.app?.debug) console.log(`[HoldTimes] Poll ${attempt}/${MAX_POLLS} for ${this.mint.slice(0, 8)}...`);
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
      if (typeof config !== 'undefined' && config.app?.debug) console.log(`[HoldTimes] Poll ${attempt}: computed=${data.computed}, avg=${avgCount}, token=${tokenCount}`);

      // If the backend returned no data (holders cache miss), ensure the backend
      // holders cache gets repopulated by making a fresh holders request.
      // Fire-and-forget — the next poll will find the cache populated.
      if (!data.computed && avgCount === 0 && tokenCount === 0 && attempt < 2) {
        if (typeof config !== 'undefined' && config.app?.debug) console.log(`[HoldTimes] Empty response — refreshing backend holders cache`);
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
        if (typeof config !== 'undefined' && config.app?.debug) console.log(`[HoldTimes] Not computed yet, re-polling in ${POLL_DELAYS[attempt]}ms`);
        this._holdTimesTimer = setTimeout(() => this._loadHoldTimes(attempt + 1), POLL_DELAYS[attempt]);
      } else {
        // Mark loading complete so expand/collapse renders "--" instead of "..."
        this._holdTimesLoaded = true;
        // Final pass — replace any remaining placeholders with dashes
        const remaining = document.querySelectorAll('.hold-time-pending, .token-hold-pending');
        if (remaining.length > 0) {
          if (typeof config !== 'undefined' && config.app?.debug) console.log(`[HoldTimes] Final: ${remaining.length} placeholders still pending → showing --`);
        }
        remaining.forEach(el => {
          el.textContent = '--';
          el.classList.remove('hold-time-pending', 'token-hold-pending');
        });
        this._updateAvgHoldTimeMetric();
        const totalAvg = this._holdTimesData ? Object.keys(this._holdTimesData).length : 0;
        const totalToken = this._tokenHoldTimesData ? Object.keys(this._tokenHoldTimesData).length : 0;
        if (typeof config !== 'undefined' && config.app?.debug) console.log(`[HoldTimes] Done: ${totalAvg} avg hold times, ${totalToken} token hold times loaded`);
      }
    } catch (error) {
      console.warn('[HoldTimes] Failed:', error.message);
      // On error, keep polling if we have retries left (could be transient)
      if (attempt < MAX_POLLS) {
        if (typeof config !== 'undefined' && config.app?.debug) console.log(`[HoldTimes] Error on poll ${attempt}, retrying in ${POLL_DELAYS[attempt]}ms`);
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
    // Elements we hide during the screenshot and restore after
    const hidden = [];

    const hideEl = (el) => {
      if (!el) return;
      el._prevDisplay = el.style.display;
      el.style.display = 'none';
      hidden.push(el);
    };
    const restoreAll = () => {
      hidden.forEach(el => { el.style.display = el._prevDisplay || ''; delete el._prevDisplay; });
      hidden.length = 0;
      injected.forEach(el => { if (el.parentNode) el.remove(); });
      injected.length = 0;
      graphic.style.padding = '';
    };

    try {
      // Dynamically load html2canvas if not already loaded
      if (typeof html2canvas === 'undefined') {
        await new Promise((resolve, reject) => {
          const script = document.createElement('script');
          script.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
          script.crossOrigin = 'anonymous';
          script.onload = resolve;
          script.onerror = () => reject(new Error('Failed to load screenshot library'));
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

      // Pre-load logo as a data URL to avoid CORS issues with html2canvas
      let logoDataUrl = '';
      const logoEl = document.getElementById('token-logo');
      if (logoEl && logoEl.src && !logoEl.src.startsWith('data:')) {
        try {
          const img = new Image();
          img.crossOrigin = 'anonymous';
          await new Promise((resolve, reject) => {
            img.onload = resolve;
            img.onerror = resolve; // don't fail if logo can't load
            img.src = logoEl.src;
            setTimeout(resolve, 2000); // 2s timeout
          });
          if (img.naturalWidth > 0) {
            const c = document.createElement('canvas');
            c.width = img.naturalWidth;
            c.height = img.naturalHeight;
            c.getContext('2d').drawImage(img, 0, 0);
            try { logoDataUrl = c.toDataURL('image/png'); } catch (_) {}
          }
        } catch (_) {}
      } else if (logoEl) {
        logoDataUrl = logoEl.src; // already a data URL
      }

      // Hide share button, refresh button, and timestamp from the screenshot
      hideEl(document.getElementById('holders-share'));
      hideEl(document.getElementById('holders-refresh'));
      hideEl(document.getElementById('holders-updated'));

      // Add padding to the graphic container for the screenshot
      graphic.style.padding = '1.25rem';

      // 1. Header bar: logo + name + price
      const header = document.createElement('div');
      header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding-bottom:0.85rem;margin-bottom:0.85rem;border-bottom:1px solid rgba(255,255,255,0.06);';
      header.innerHTML = `
        <div style="display:flex;align-items:center;gap:0.6rem;">
          ${logoDataUrl ? `<img src="${logoDataUrl}" style="width:32px;height:32px;border-radius:50%;background:#161719;">` : ''}
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

      // 3. Show watermark for screenshot (hidden on normal page via CSS)
      const watermark = graphic.querySelector('.diamond-hands-watermark');
      let watermarkWasHidden = false;
      if (watermark) {
        const cs = getComputedStyle(watermark);
        watermarkWasHidden = cs.display === 'none';
        if (watermarkWasHidden) {
          watermark.style.display = 'inline-flex';
        }
      }

      const canvas = await html2canvas(graphic, {
        backgroundColor: '#060607',
        scale: 2,
        allowTaint: true,
        logging: false,
      });

      // Restore DOM state
      if (watermark && watermarkWasHidden) { watermark.style.display = ''; }
      restoreAll();

      const blob = await new Promise((resolve, reject) => {
        canvas.toBlob(b => b ? resolve(b) : reject(new Error('Canvas toBlob failed')), 'image/png');
      });
      const filename = `${(tokenSymbol || tokenName || 'token').toLowerCase()}-conviction.png`;

      // Try native share (mobile)
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
      console.error('Share conviction stats error:', err.message);
      if (typeof toast !== 'undefined') toast.error('Failed to capture screenshot');
    } finally {
      restoreAll();
      const watermark = document.querySelector('#holders-graphic .diamond-hands-watermark');
      if (watermark) watermark.style.display = '';
      if (btn) { btn.disabled = false; btn.classList.remove('spinning'); }
    }
  },

  // Load diamond hands distribution with polling
  async _loadDiamondHands(attempt = 0) {
    const MAX_POLLS = 10;
    const POLL_DELAYS = [5000, 5000, 6000, 8000, 8000, 10000, 12000, 16000, 20000, 24000]; // 250 wallets at batch 25 ≈ 20-30s

    // Cancel any in-flight polling from a previous load
    if (attempt === 0) {
      if (this._diamondHandsTimer) {
        clearTimeout(this._diamondHandsTimer);
        this._diamondHandsTimer = null;
      }
      this._diamondHandsLoaded = false;
    }

    try {
      // Bypass apiCache — poll directly so we always get fresh data from backend
      if (typeof config !== 'undefined' && config.app?.debug) console.log(`[DiamondHands] Poll ${attempt}/${MAX_POLLS} for ${this.mint.slice(0, 8)}...`);
      const data = await api.request(`/api/tokens/${this.mint}/holders/diamond-hands`);

      if (!data) {
        if (typeof config !== 'undefined' && config.app?.debug) console.log(`[DiamondHands] No response`);
        this._diamondHandsLoaded = true;
        return;
      }

      // Only render once we have actual distribution data (at least some analyzed)
      if (data.distribution && data.analyzed > 0) {
        this._renderDiamondHands(data);
      }

      if (!data.computed && attempt < MAX_POLLS) {
        if (typeof config !== 'undefined' && config.app?.debug) console.log(`[DiamondHands] ${data.analyzed || 0}/${data.totalCount || data.sampleSize} analyzed, re-polling in ${POLL_DELAYS[attempt]}ms`);
        this._diamondHandsTimer = setTimeout(() => this._loadDiamondHands(attempt + 1), POLL_DELAYS[attempt]);
      } else {
        // Final state — if still no data, show unavailable message
        if (!data.distribution || !data.analyzed) {
          this._showDiamondHandsUnavailable();
        }
        this._diamondHandsLoaded = true;
        if (typeof config !== 'undefined' && config.app?.debug) console.log(`[DiamondHands] Done: sample=${data.sampleSize}, analyzed=${data.analyzed}`);
      }
    } catch (error) {
      console.warn('[DiamondHands] Failed:', error.message);
      this._diamondHandsLoaded = true;
      this._showDiamondHandsUnavailable();
    }
  },

  _renderDiamondHands(data) {
    const section = document.getElementById('diamond-hands-section');
    if (!section || !data.distribution) return;

    section.style.display = '';

    // Store data on every successful render (not just final poll)
    this._diamondHandsData = data;

    // Update sample size label
    const sampleEl = document.getElementById('diamond-hands-sample');
    if (sampleEl) {
      if (data.computed) {
        sampleEl.textContent = `${data.analyzed} of ${data.sampleSize} holders`;
      } else {
        sampleEl.textContent = `${data.analyzed}/${data.totalCount || data.sampleSize} analyzed...`;
      }
    }

    // Determine token age in ms to conditionally show long-term buckets.
    // If pairCreatedAt is unknown, show all buckets that have data (non-zero %).
    const tokenAgeMs = this.token?.pairCreatedAt
      ? Date.now() - new Date(this.token.pairCreatedAt).getTime()
      : null;

    // Age-gated buckets: show if token is old enough OR if age is unknown but data exists
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
          const ageKnown = tokenAgeMs !== null;
          const oldEnough = ageKnown && tokenAgeMs >= AGE_GATED[key];
          const hasData = pct > 0;
          rowEl.style.display = (oldEnough || (!ageKnown && hasData)) ? '' : 'none';
        }
      }

      if (fillEl) {
        // Remove loading shimmer and set real width + color
        fillEl.classList.remove('dh-loading');
        fillEl.style.width = pct + '%';
        if (pct >= 50) fillEl.className = 'diamond-bar-fill dh-high';
        else if (pct >= 20) fillEl.className = 'diamond-bar-fill dh-mid';
        else fillEl.className = 'diamond-bar-fill dh-low';
      }
      if (pctEl) {
        pctEl.textContent = pct + '%';
        pctEl.classList.remove('dh-text-high', 'dh-text-mid', 'dh-text-low');
        if (pct >= 50) pctEl.classList.add('dh-text-high');
        else if (pct >= 20) pctEl.classList.add('dh-text-mid');
        else if (pct > 0) pctEl.classList.add('dh-text-low');
      }
    }
  },

  // Reset Diamond Hands bars back to loading shimmer state
  _resetDiamondHandsToLoading() {
    const section = document.getElementById('diamond-hands-section');
    if (!section) return;
    section.style.display = '';
    const sampleEl = document.getElementById('diamond-hands-sample');
    if (sampleEl) sampleEl.textContent = 'Analyzing holders...';
    const buckets = ['24h', '3d', '1w', '1m', '3m', '6m', '9m'];
    for (const key of buckets) {
      const fillEl = document.getElementById(`dh-fill-${key}`);
      const pctEl = document.getElementById(`dh-pct-${key}`);
      if (fillEl) {
        fillEl.className = 'diamond-bar-fill dh-loading';
        fillEl.style.width = '';
      }
      if (pctEl) {
        pctEl.textContent = '...';
        pctEl.classList.remove('dh-text-high', 'dh-text-mid', 'dh-text-low');
      }
    }
    // Re-hide age-gated rows
    ['3m', '6m', '9m'].forEach(k => {
      const row = document.getElementById(`dh-row-${k}`);
      if (row) row.style.display = 'none';
    });
  },

  // Show unavailable state for Diamond Hands (replaces loading shimmer with message)
  _showDiamondHandsUnavailable() {
    const section = document.getElementById('diamond-hands-section');
    if (!section) return;
    const sampleEl = document.getElementById('diamond-hands-sample');
    if (sampleEl) sampleEl.textContent = 'Unavailable';
    // Remove shimmer from all bars and show 0%
    document.querySelectorAll('.diamond-bar-fill.dh-loading').forEach(el => {
      el.classList.remove('dh-loading');
      el.style.width = '0';
      el.classList.add('dh-low');
    });
    document.querySelectorAll('.diamond-bar-pct').forEach(el => {
      if (el.textContent === '...') el.textContent = '--';
    });
  },

  // ── Banner & Social Links (client-side DexScreener fetch) ──

  // Fetch banner and social links directly from DexScreener API (client-side).
  // Avoids backend round-trip and fire-and-forget cache miss on first visit.
  async loadDexScreenerData() {
    if (!this.mint) return;
    try {
      const resp = await fetch(
        `https://api.dexscreener.com/tokens/v1/solana/${encodeURIComponent(this.mint)}`,
        { signal: AbortSignal.timeout(8000) }
      );
      if (!resp.ok) return;
      const pairs = await resp.json();
      if (!Array.isArray(pairs) || pairs.length === 0) return;

      const info = pairs[0].info || {};
      const socials = Array.isArray(info.socials) ? info.socials : [];
      const websites = Array.isArray(info.websites) ? info.websites : [];

      // Render banner
      if (info.header) {
        this._renderBanner(info.header);
      }

      // Render social links
      const socialMap = {};
      for (const s of socials) { if (s.type && s.url) socialMap[s.type] = s.url; }
      if (websites.length > 0 && websites[0].url) socialMap.website = websites[0].url;
      if (Object.keys(socialMap).length > 0) {
        this._renderSocials(socialMap);
      }
    } catch {
      // DexScreener unavailable — silent fail, non-critical
    }
  },

  _renderBanner(url) {
    if (!url) return;
    const container = document.getElementById('token-banner');
    if (!container) return;
    const img = new Image();
    img.onload = () => {
      container.innerHTML = `<img src="${utils.escapeHtml(url)}" alt="Token banner" class="token-banner-img">`;
      container.style.display = '';
    };
    img.onerror = () => { container.style.display = 'none'; };
    img.src = url;
  },

  _renderSocials(socials) {
    if (!socials) return;
    const container = document.getElementById('token-socials');
    if (!container) return;
    const esc = (s) => utils.escapeHtml(s);
    const links = [];
    const { twitter, telegram, discord, website, tiktok } = socials;
    if (twitter) links.push(`<a href="${esc(twitter)}" target="_blank" rel="noopener" class="social-chip"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>Twitter</a>`);
    if (telegram) links.push(`<a href="${esc(telegram)}" target="_blank" rel="noopener" class="social-chip"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>Telegram</a>`);
    if (discord) links.push(`<a href="${esc(discord)}" target="_blank" rel="noopener" class="social-chip"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03z"/></svg>Discord</a>`);
    if (website) links.push(`<a href="${esc(website)}" target="_blank" rel="noopener" class="social-chip"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>Website</a>`);
    if (tiktok) links.push(`<a href="${esc(tiktok)}" target="_blank" rel="noopener" class="social-chip">TikTok</a>`);
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
      viewsEl.classList.remove('stat-placeholder');
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

    // Remove window-level listeners to prevent accumulation on bfcache restore
    if (this._walletConnectedHandler) {
      window.removeEventListener('walletConnected', this._walletConnectedHandler);
      this._walletConnectedHandler = null;
    }

    // Remove all event listeners
    this.unbindEvents();

    // Remove visibility handler (not tracked in boundHandlers)
    if (this.visibilityHandler) {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
    }
  }
};

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
  tokenDetail.init();
});

// Reinitialize when restored from bfcache (browser back/forward navigation).
// DOMContentLoaded does NOT fire when a page is restored from bfcache, so
// intervals remain destroyed from the pagehide handler.
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
