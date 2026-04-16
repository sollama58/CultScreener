// API Configuration - uses config.js (must be loaded first)
const API_BASE_URL = (typeof config !== 'undefined' && config.api?.baseUrl)
  ? config.api.baseUrl
  : (window.location.hostname === 'localhost' ? 'http://localhost:3000' : '');

// Frontend Cache - reduces API calls and improves responsiveness
// TTLs are configurable via config.js (config.cache.*)
const apiCache = {
  cache: new Map(),
  accessOrder: new Map(), // LRU via Map insertion order (O(1) delete + re-insert)
  inFlight: new Map(),         // Deduplication for fresh (non-stale) fetches
  bgRefreshing: new Set(),     // Tracks keys with an in-flight background stale refresh
  maxSize: 500,    // Increased from 100 for better cache hit rates

  // Cache TTLs in milliseconds - pulled from config.js with fallback defaults
  // Priority: Community updates (submissions) are primary, price/volume is secondary
  get TTL() {
    const c = (typeof config !== 'undefined' && config.cache) ? config.cache : {};
    return {
      tokenList: c.tokenListTTL || 120000,
      tokenDetail: c.tokenDetailTTL || 300000,
      search: c.searchTTL || 120000,
      pools: c.poolsTTL || 300000,
      submissions: c.submissionsTTL || 30000,
      price: c.priceTTL || 300000
    };
  },

  // Generate cache key
  key(endpoint, params = {}) {
    const paramStr = Object.keys(params).sort()
      .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
      .join('&');
    return `${endpoint}${paramStr ? '?' + paramStr : ''}`;
  },

  // Update access order for LRU — O(1) via Map delete + re-insert
  touchAccessOrder(key) {
    this.accessOrder.delete(key);
    this.accessOrder.set(key, 1);
  },

  // Get cached value if fresh
  get(key) {
    const entry = this.cache.get(key);
    if (!entry) return null;

    const age = Date.now() - entry.timestamp;
    if (age > entry.ttl) {
      this.cache.delete(key);
      this.accessOrder.delete(key);
      return null;
    }

    // Update access order (LRU touch)
    this.touchAccessOrder(key);

    return {
      data: entry.data,
      age: age,
      fresh: age < entry.ttl / 2 // Consider "fresh" if less than half TTL
    };
  },

  // Set cache entry with proper LRU eviction
  set(key, data, ttl) {
    this.cache.set(key, {
      data: data,
      timestamp: Date.now(),
      ttl: ttl
    });

    // Update access order
    this.touchAccessOrder(key);

    // LRU eviction: remove least recently used entries when over limit
    while (this.cache.size > this.maxSize && this.accessOrder.size > 0) {
      const lruKey = this.accessOrder.keys().next().value; // First key = oldest
      this.accessOrder.delete(lruKey);
      this.cache.delete(lruKey);
    }
  },

  // Get or fetch with stale-while-revalidate pattern
  async getOrFetch(key, fetchFn, ttl, allowStale = true) {
    const cached = this.get(key);

    // Return fresh cache immediately
    if (cached && cached.fresh) {
      return cached.data;
    }

    // If stale cache exists and allowStale, return it and refresh in background
    if (cached && allowStale) {
      // Deduplicate background refreshes — skip if one is already running for this key
      if (!this.bgRefreshing.has(key)) {
        this.bgRefreshing.add(key);
        fetchFn().then(data => {
          if (data) this.set(key, data, ttl);
        }).catch(error => {
          if (typeof config !== 'undefined' && config.app?.debug) {
            console.warn(`[Cache] Background refresh failed for ${key}:`, error.message);
          }
        }).finally(() => {
          this.bgRefreshing.delete(key);
        });
      }
      return cached.data;
    }

    // No cache or stale not allowed — deduplicate concurrent callers for the same key
    if (this.inFlight.has(key)) {
      return this.inFlight.get(key);
    }
    const fetchPromise = fetchFn().then(data => {
      if (data) this.set(key, data, ttl);
      return data;
    }).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, fetchPromise);
    return fetchPromise;
  },

  // Clear specific cache entries by pattern
  clearPattern(pattern) {
    for (const key of this.cache.keys()) {
      if (key.includes(pattern)) {
        this.cache.delete(key);
        this.accessOrder.delete(key);
      }
    }
  },

  // Clear all cache
  clear() {
    this.cache.clear();
    this.accessOrder.clear();
  }
};

// Latency Tracker - records per-endpoint API and frontend operation durations (rolling window)
// Used by the admin dashboard to surface slow endpoints and operations for debugging
const latencyTracker = {
  WINDOW_SIZE: 100, // Keep last 100 samples per endpoint

  data: new Map(), // normalized endpoint → { samples: number[], count: number, errors: number, type: string }

  // Strip query params and replace long token addresses / numeric IDs with :id
  normalize(endpoint) {
    let path = endpoint.split('?')[0];
    // Replace base58 Solana addresses (32+ chars) and long hex strings with :id
    path = path.replace(/\/[A-Za-z0-9]{32,}/g, '/:id');
    // Replace trailing numeric IDs (e.g. /submissions/42)
    path = path.replace(/\/\d+$/g, '/:id');
    return path;
  },

  record(endpoint, durationMs, success = true, type = 'api') {
    const key = this.normalize(endpoint);
    if (!this.data.has(key)) {
      this.data.set(key, { samples: [], count: 0, errors: 0, type });
    }
    const entry = this.data.get(key);
    entry.count++;
    if (!success) entry.errors++;
    entry.samples.push(Math.round(durationMs));
    if (entry.samples.length > this.WINDOW_SIZE) {
      entry.samples.shift();
    }
  },

  // Return per-endpoint summary sorted by call count (descending)
  getSummary() {
    const results = [];
    for (const [key, entry] of this.data) {
      if (entry.samples.length === 0) continue;
      const sorted = [...entry.samples].sort((a, b) => a - b);
      const n = sorted.length;
      const avg = Math.round(sorted.reduce((s, v) => s + v, 0) / n);
      const p95 = sorted[Math.min(Math.floor(n * 0.95), n - 1)];
      results.push({
        endpoint: key,
        type: entry.type || 'api',
        count: entry.count,
        errors: entry.errors,
        avg,
        p95,
        min: sorted[0],
        max: sorted[n - 1],
        last: entry.samples[entry.samples.length - 1]
      });
    }
    return results.sort((a, b) => b.count - a.count);
  }
};

// Default request timeout — must exceed server-side REQUEST_TIMEOUT (30s) so the server
// gets a chance to respond with an error rather than the client aborting first.
const DEFAULT_REQUEST_TIMEOUT = (typeof config !== 'undefined' && config.api?.timeout) || 35000;

// Global 429 rate-limit awareness: when set, auto-refresh and background requests should back off
let _rateLimitedUntil = 0;
function isRateLimited() { return Date.now() < _rateLimitedUntil; }

// API Client
const api = {
  // Generic fetch wrapper with timeout and exponential backoff retry logic
  async request(endpoint, options = {}) {
    const url = `${API_BASE_URL}${endpoint}`;
    const maxRetries = options.retries || (typeof config !== 'undefined' ? config.api?.retries : 2) || 2;
    const timeout = options.timeout || DEFAULT_REQUEST_TIMEOUT;
    const _t0 = performance.now();
    let lastError;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      // Create AbortController for request timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      try {
        const headers = {
          'Content-Type': 'application/json',
          ...options.headers
        };

        const response = await fetch(url, {
          ...options,
          signal: controller.signal,
          headers
        });

        clearTimeout(timeoutId);

        // Parse JSON safely — non-JSON responses (HTML error pages) won't crash
        let data;
        try {
          data = await response.json();
        } catch (parseError) {
          if (!response.ok) {
            const error = new Error(`HTTP ${response.status}`);
            error.status = response.status;
            throw error;
          }
          throw new Error('Invalid JSON response from server');
        }

        if (!response.ok) {
          // Check for Retry-After header on 429/503 errors
          const retryAfter = response.headers.get('Retry-After');
          const error = new Error(data.error || `HTTP ${response.status}`);
          error.status = response.status;
          error.code = data.code;
          error.retryAfter = retryAfter ? parseInt(retryAfter) : null;
          throw error;
        }

        latencyTracker.record(endpoint, performance.now() - _t0, true);
        return data;
      } catch (error) {
        clearTimeout(timeoutId);

        // Handle abort (timeout)
        if (error.name === 'AbortError') {
          lastError = new Error(`Request timed out after ${timeout}ms`);
          lastError.code = 'TIMEOUT';
        } else {
          lastError = error;
        }

        // Don't retry on 4xx errors (client errors) except 429 (rate limit)
        if (error.status >= 400 && error.status < 500 && error.status !== 429) {
          break;
        }
        // Global 429/503 awareness: suppress background fetches for the retry-after window
        if (error.status === 429 || error.status === 503) {
          const wasAlreadyLimited = isRateLimited();
          const backoff = (error.retryAfter || 60) * 1000;
          _rateLimitedUntil = Math.max(_rateLimitedUntil, Date.now() + backoff);
          // Show toast once when rate limiting first kicks in (not on every retry)
          if (!wasAlreadyLimited && typeof toast !== 'undefined') {
            toast.warning('Server is busy — data may be delayed. Retrying automatically.');
          }
        }

        if (attempt < maxRetries - 1) {
          // Use Retry-After header if available, otherwise exponential backoff
          let delay;
          if (error.retryAfter) {
            delay = Math.min(error.retryAfter * 1000, 30000);
          } else {
            // Exponential backoff with jitter to prevent thundering herd
            const baseDelay = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s...
            const jitter = Math.random() * 1000; // 0-1s random jitter
            delay = Math.min(baseDelay + jitter, 30000); // Cap at 30s
          }
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }

    // Don't log full error details in production console
    if (typeof config !== 'undefined' && config.app?.debug) {
      console.error(`API Error (${endpoint}):`, lastError.message);
    }
    latencyTracker.record(endpoint, performance.now() - _t0, false);
    throw lastError;
  },

  // Health check
  async health() {
    return this.request('/health');
  },

  async healthDetailed() {
    return this.request('/health/detailed');
  },

  // Token endpoints - with frontend caching for responsiveness
  tokens: {
    async list(params = {}) {
      const query = new URLSearchParams(params).toString();
      const endpoint = `/api/tokens${query ? `?${query}` : ''}`;
      const cacheKey = apiCache.key('tokens:list', params);

      // Don't use stale cache for pagination - user expects fresh data when changing pages
      // Only use stale-while-revalidate for same-page refreshes (offset=0 or not specified)
      const offset = parseInt(params.offset) || 0;
      const allowStale = offset === 0;

      return apiCache.getOrFetch(
        cacheKey,
        () => api.request(endpoint),
        apiCache.TTL.tokenList,
        allowStale
      );
    },

    async get(mint, options = {}) {
      const cacheKey = `tokens:detail:${mint}`;
      const skipCache = options.fresh === true;

      if (!skipCache) {
        const cached = apiCache.get(cacheKey);
        if (cached) return cached.data;

        // Seed cache from sessionStorage preview (set by list page on click-through)
        // so the first get() returns instantly; full data replaces on next fetch
        try {
          const raw = sessionStorage.getItem('token_preview');
          if (raw) {
            // Always clear on read — prevents stale previews from persisting
            sessionStorage.removeItem('token_preview');
            const parsed = JSON.parse(raw);
            if (parsed && parsed.mint === mint && parsed.ts && Date.now() - parsed.ts < 30000) {
              apiCache.set(cacheKey, parsed.data, 5000); // 5s — just long enough for initial render
              return parsed.data;
            }
          }
        } catch (_) {}
      }

      const data = await api.request(`/api/tokens/${mint}`);
      apiCache.set(cacheKey, data, apiCache.TTL.tokenDetail);
      return data;
    },

    async getPrice(mint) {
      const cacheKey = `tokens:price:${mint}`;

      return apiCache.getOrFetch(
        cacheKey,
        () => api.request(`/api/tokens/${mint}/price`),
        apiCache.TTL.price,
        true
      );
    },

    async search(query, { dexFilter = false } = {}) {
      const dexParam = dexFilter ? '&dex=1' : '';
      const cacheKey = `tokens:search:${query.toLowerCase()}${dexParam}`;

      return apiCache.getOrFetch(
        cacheKey,
        () => api.request(`/api/tokens/search?q=${encodeURIComponent(query)}${dexParam}`),
        apiCache.TTL.search,
        true
      );
    },

    // Batch fetch multiple tokens in one request (optimized for watchlist)
    // Reduces N individual requests to 1 batch request
    async getBatch(mints) {
      if (!mints || mints.length === 0) {
        return [];
      }

      // For small batches, still use batch endpoint for consistency
      // but check cache first for each token
      const uncached = [];
      const cachedResults = [];

      for (const mint of mints) {
        // Check both detail cache (full data) and batch cache (partial data)
        const detail = apiCache.get(`tokens:detail:${mint}`);
        const batch = apiCache.get(`tokens:batch:${mint}`);
        if (detail) {
          cachedResults.push(detail.data);
        } else if (batch) {
          cachedResults.push(batch.data);
        } else {
          uncached.push(mint);
        }
      }

      // If all cached, return immediately
      if (uncached.length === 0) {
        // Return in original order
        return mints.map(mint => cachedResults.find(t => t.address === mint || t.mintAddress === mint)).filter(Boolean);
      }

      // Fetch uncached tokens via batch endpoint
      try {
        const batchData = await api.request('/api/tokens/batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mints: uncached })
        });

        // Cache each result under a batch-specific key to avoid polluting the
        // detail cache (batch tokens lack liquidity, holders, supply, age, etc.)
        for (const token of batchData) {
          if (token && (token.address || token.mintAddress)) {
            apiCache.set(`tokens:batch:${token.address || token.mintAddress}`, token, apiCache.TTL.tokenDetail);
          }
        }

        // Combine cached and fetched, maintaining original order
        const allResults = [...cachedResults, ...batchData];
        return mints.map(mint => allResults.find(t => t.address === mint || t.mintAddress === mint)).filter(Boolean);
      } catch (error) {
        console.error('Batch token fetch failed:', error.message);
        // Fallback: return whatever we had cached
        return cachedResults;
      }
    },

    async getPools(mint) {
      const cacheKey = `tokens:pools:${mint}`;

      return apiCache.getOrFetch(
        cacheKey,
        async () => {
          try {
            return await api.request(`/api/tokens/${mint}/pools`);
          } catch (error) {
            console.warn('Pools endpoint not available:', error.message);
            return [];
          }
        },
        apiCache.TTL.pools,
        true
      );
    },

    async getHolders(mint, { fresh = false } = {}) {
      const cacheKey = `tokens:holders:${mint}`;
      const url = fresh ? `/api/tokens/${mint}/holders?fresh=true` : `/api/tokens/${mint}/holders`;
      return apiCache.getOrFetch(
        cacheKey,
        () => api.request(url),
        apiCache.TTL.pools, // reuse pools TTL (5min)
        true
      );
    },

    async getHolderHoldTimes(mint) {
      const cacheKey = `tokens:hold-times:${mint}`;
      return apiCache.getOrFetch(
        cacheKey,
        () => api.request(`/api/tokens/${mint}/holders/hold-times`),
        30000,  // Short 30s TTL — this is polled frequently for freshness
        false   // Never return stale data — we need fresh computed status
      );
    },

    async getDiamondHands(mint) {
      const cacheKey = `tokens:diamond-hands:${mint}`;
      return apiCache.getOrFetch(
        cacheKey,
        () => api.request(`/api/tokens/${mint}/holders/diamond-hands`),
        30000,
        false
      );
    },

    async getHolderBalance(mint, wallet) {
      // Don't cache holder balances - need fresh data for voting
      return api.request(`/api/tokens/${mint}/holder/${wallet}`);
    },

    // Record a page view for a token (fire-and-forget, non-blocking)
    async recordView(mint) {
      try {
        return await api.request(`/api/tokens/${mint}/view`, { method: 'POST' });
      } catch (error) {
        // Non-critical - silently fail
        console.warn('View tracking failed:', error.message);
        return { views: 0 };
      }
    },

    // Get view count for a token
    async getViews(mint) {
      try {
        return await api.request(`/api/tokens/${mint}/views`);
      } catch (error) {
        return { views: 0 };
      }
    },

    // Invalidate cache for a specific token
    invalidateCache(mint) {
      apiCache.clearPattern(`tokens:detail:${mint}`);
    },

    // Community leaderboards
    async leaderboardWatchlist(params = {}) {
      const query = new URLSearchParams(params).toString();
      const cacheKey = `tokens:leaderboard:watchlist:${query}`;
      return apiCache.getOrFetch(
        cacheKey,
        () => api.request(`/api/tokens/leaderboard/watchlist?${query}`),
        apiCache.TTL.tokenList,
        true
      );
    },

    async leaderboardConviction(params = {}) {
      const query = new URLSearchParams(params).toString();
      const cacheKey = `tokens:leaderboard:conviction:${query}`;
      return apiCache.getOrFetch(
        cacheKey,
        () => api.request(`/api/tokens/leaderboard/conviction?${query}`),
        apiCache.TTL.tokenList,
        true
      );
    }
  },

  // Watchlist endpoints
  watchlist: {
    async get(wallet) {
      return api.request(`/api/watchlist/${wallet}`);
    },

    async add(wallet, tokenMint) {
      return api.request('/api/watchlist', {
        method: 'POST',
        body: JSON.stringify({ wallet, tokenMint })
      });
    },

    async remove(wallet, tokenMint) {
      return api.request('/api/watchlist', {
        method: 'DELETE',
        body: JSON.stringify({ wallet, tokenMint })
      });
    },

    async check(wallet, tokenMint) {
      return api.request('/api/watchlist/check', {
        method: 'POST',
        body: JSON.stringify({ wallet, tokenMint })
      });
    },

    async checkBatch(wallet, tokenMints) {
      return api.request('/api/watchlist/check-batch', {
        method: 'POST',
        body: JSON.stringify({ wallet, tokenMints })
      });
    },

    async getCount(wallet) {
      return api.request(`/api/watchlist/${wallet}/count`);
    }
  },

  // Sentiment endpoints
  sentiment: {
    async get(mint, wallet) {
      const query = wallet ? `?wallet=${wallet}` : '';
      return api.request(`/api/sentiment/${mint}${query}`);
    },
    async cast(mint, sentimentType, wallet) {
      return api.request(`/api/sentiment/${mint}`, {
        method: 'POST',
        body: JSON.stringify({ wallet, sentimentType })
      });
    }
  },

  // Curated token list endpoints
  curated: {
    async list() {
      const cacheKey = 'curated:list';
      return apiCache.getOrFetch(
        cacheKey,
        () => api.request('/api/curated'),
        apiCache.TTL.tokenList,
        true
      );
    },
    async get(mint) {
      return api.request(`/api/curated/${mint}`);
    }
  }
};

// Toast notification system
// Styles are now in config.js (cultscreener-shared-styles) to prevent duplication
const toast = {
  container: null,

  init() {
    if (this.container) return;

    this.container = document.createElement('div');
    this.container.id = 'toast-container';
    this.container.className = 'toast-container';
    document.body.appendChild(this.container);
    // Styles are injected by config.js - no duplicate injection needed
  },

  show(message, type = 'info', duration = 4000) {
    this.init();

    const icons = {
      success: '✓',
      error: '✕',
      info: 'ℹ',
      warning: '⚠'
    };

    const toastEl = document.createElement('div');
    toastEl.className = `toast ${type}`;

    // Build toast using DOM methods for XSS safety
    const iconSpan = document.createElement('span');
    iconSpan.className = 'toast-icon';
    iconSpan.textContent = icons[type] || icons.info;

    const messageSpan = document.createElement('span');
    messageSpan.className = 'toast-message';
    messageSpan.textContent = message; // Safe: textContent escapes HTML

    const closeBtn = document.createElement('button');
    closeBtn.className = 'toast-close';
    closeBtn.textContent = '×';
    closeBtn.onclick = () => toastEl.remove();

    toastEl.appendChild(iconSpan);
    toastEl.appendChild(messageSpan);
    toastEl.appendChild(closeBtn);

    this.container.appendChild(toastEl);

    if (duration > 0) {
      setTimeout(() => {
        toastEl.classList.add('hiding');
        setTimeout(() => toastEl.remove(), 300);
      }, duration);
    }

    return toastEl;
  },

  success(message, duration) { return this.show(message, 'success', duration); },
  error(message, duration) { return this.show(message, 'error', duration); },
  info(message, duration) { return this.show(message, 'info', duration); },
  warning(message, duration) { return this.show(message, 'warning', duration); }
};

// Utility functions
const utils = {
  // Escape HTML to prevent XSS attacks - USE THIS for any user-generated content
  // Encodes <, >, &, " and ' so the result is safe in both text nodes and attribute values
  escapeHtml(text) {
    if (text === null || text === undefined) return '';
    const div = document.createElement('div');
    div.textContent = String(text);
    return div.innerHTML
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  },

  // Pending data indicator (timer icon) - shown when data hasn't been fetched yet
  pendingIndicator: '<span class="data-pending" title="Click to load price data"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg></span>',

  // Format currency with smart decimals
  // showPending: if true, shows timer icon for $0 values instead of "$0.00"
  formatPrice(price, decimals = 6, showPending = false) {
    if (!price || price === 0) {
      return showPending ? this.pendingIndicator : '$0.00';
    }

    const num = Number(price);
    if (isNaN(num)) return showPending ? this.pendingIndicator : '$0.00';

    if (num < 0.000001) {
      return `$${num.toExponential(2)}`;
    }

    if (num < 0.0001) {
      return `$${num.toFixed(8)}`;
    }

    if (num < 0.01) {
      return `$${num.toFixed(decimals)}`;
    }

    if (num < 1) {
      return `$${num.toFixed(4)}`;
    }

    if (num < 1000) {
      return `$${num.toFixed(2)}`;
    }

    return `$${num.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    })}`;
  },

  // Format large numbers with suffix
  // showPending: if true, shows timer icon for $0/null values
  formatNumber(num, prefix = '$', showPending = false) {
    if (!num && num !== 0) return showPending ? this.pendingIndicator : '--';

    const n = Number(num);
    if (isNaN(n)) return showPending ? this.pendingIndicator : '--';

    // Show pending for zero values when flag is set
    if (n === 0 && showPending) return this.pendingIndicator;

    if (n >= 1e12) return `${prefix}${(n / 1e12).toFixed(2)}T`;
    if (n >= 1e9) return `${prefix}${(n / 1e9).toFixed(2)}B`;
    if (n >= 1e6) return `${prefix}${(n / 1e6).toFixed(2)}M`;
    if (n >= 1e3) return `${prefix}${(n / 1e3).toFixed(2)}K`;

    return `${prefix}${n.toFixed(2)}`;
  },

  // Format percentage change
  // showPending: if true, shows timer icon for null/undefined values
  formatChange(change, showPending = false) {
    if (change === null || change === undefined) return showPending ? this.pendingIndicator : '--';

    const num = Number(change);
    if (isNaN(num)) return showPending ? this.pendingIndicator : '--';

    const formatted = Math.abs(num).toFixed(2);
    const prefix = num >= 0 ? '+' : '-';
    return `${prefix}${formatted}%`;
  },

  // Truncate address
  truncateAddress(address, start = 4, end = 4) {
    if (!address) return '';
    if (address.length <= start + end + 3) return address;
    return `${address.slice(0, start)}...${address.slice(-end)}`;
  },

  // Copy to clipboard with feedback
  async copyToClipboard(text, showToast = true) {
    try {
      await navigator.clipboard.writeText(text);
      if (showToast) {
        toast.success('Copied to clipboard!');
      }
      return true;
    } catch {
      if (showToast) {
        toast.error('Failed to copy');
      }
      return false;
    }
  },

  // Debounce function
  debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
      const later = () => {
        clearTimeout(timeout);
        func(...args);
      };
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    };
  },

  // Throttle function
  throttle(func, limit) {
    let inThrottle;
    return function(...args) {
      if (!inThrottle) {
        func.apply(this, args);
        inThrottle = true;
        setTimeout(() => inThrottle = false, limit);
      }
    };
  },

  // Get URL parameter
  getUrlParam(name) {
    const params = new URLSearchParams(window.location.search);
    return params.get(name);
  },

  // Set URL parameter without reload
  setUrlParam(name, value) {
    const url = new URL(window.location);
    if (value) {
      url.searchParams.set(name, value);
    } else {
      url.searchParams.delete(name);
    }
    window.history.replaceState({}, '', url);
  },

  // Format relative time
  formatTimeAgo(date) {
    const now = new Date();
    const d = new Date(date);
    const seconds = Math.floor((now - d) / 1000);

    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;

    return d.toLocaleDateString();
  },

  // Format age duration (without "ago" suffix — suitable for stat labels)
  formatAge(date) {
    const now = new Date();
    const d = new Date(date);
    const seconds = Math.floor((now - d) / 1000);

    if (seconds < 0) return 'N/A';
    if (seconds < 60) return '< 1m';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
    const days = Math.floor(seconds / 86400);
    if (days < 30) return `${days}d`;
    if (days < 365) return `${Math.floor(days / 30)}mo`;
    const years = Math.floor(days / 365);
    const remainingMonths = Math.floor((days % 365) / 30);
    return remainingMonths > 0 ? `${years}y ${remainingMonths}mo` : `${years}y`;
  },

  // Validate Solana address
  isValidSolanaAddress(address) {
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
  },

  // Validate URL
  isValidUrl(string) {
    try {
      const url = new URL(string);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  },

  // Default token logo - URL encoded to work safely in HTML attributes
  getDefaultLogo() {
    return 'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2032%2032%22%3E%3Ccircle%20cx%3D%2216%22%20cy%3D%2216%22%20r%3D%2216%22%20fill%3D%22%231c1c21%22%2F%3E%3Ctext%20x%3D%2216%22%20y%3D%2221%22%20text-anchor%3D%22middle%22%20fill%3D%22%236b6b73%22%20font-size%3D%2214%22%3E%3F%3C%2Ftext%3E%3C%2Fsvg%3E';
  },

  // Create element with attributes
  createElement(tag, attrs = {}, children = []) {
    const el = document.createElement(tag);
    Object.entries(attrs).forEach(([key, value]) => {
      if (key === 'className') el.className = value;
      else if (key === 'innerHTML') el.innerHTML = value;
      else if (key.startsWith('on')) el.addEventListener(key.slice(2).toLowerCase(), value);
      else el.setAttribute(key, value);
    });
    children.forEach(child => {
      if (typeof child === 'string') el.appendChild(document.createTextNode(child));
      else if (child) el.appendChild(child);
    });
    return el;
  },

  // Mobile/Touch Device Detection
  isTouchDevice() {
    return (('ontouchstart' in window) ||
      (navigator.maxTouchPoints > 0) ||
      (navigator.msMaxTouchPoints > 0));
  },

  // Check if device is mobile based on screen width
  isMobile() {
    return window.innerWidth <= 768;
  },

  // Check if device is in landscape orientation
  isLandscape() {
    return window.innerWidth > window.innerHeight;
  },

  // Add touch feedback class on touch
  addTouchFeedback(element, activeClass = 'touch-active') {
    if (!element || !this.isTouchDevice()) return;

    element.addEventListener('touchstart', () => {
      element.classList.add(activeClass);
    }, { passive: true });

    element.addEventListener('touchend', () => {
      setTimeout(() => element.classList.remove(activeClass), 100);
    }, { passive: true });

    element.addEventListener('touchcancel', () => {
      element.classList.remove(activeClass);
    }, { passive: true });
  },

  // Prevent double-tap zoom on specific element
  preventDoubleTapZoom(element) {
    if (!element) return;
    let lastTap = 0;
    element.addEventListener('touchend', (e) => {
      const now = Date.now();
      if (now - lastTap < 300) {
        e.preventDefault();
      }
      lastTap = now;
    }, { passive: false });
  },

  // Initialize mobile optimizations
  initMobileOptimizations() {
    // Add touch class to body if touch device
    if (this.isTouchDevice()) {
      document.body.classList.add('touch-device');
    }

    // Update on orientation change
    window.addEventListener('orientationchange', () => {
      document.body.classList.toggle('landscape', this.isLandscape());
    });

    // Set initial orientation class
    document.body.classList.toggle('landscape', this.isLandscape());

    // Handle viewport height changes (iOS Safari address bar)
    const setVh = () => {
      const vh = window.innerHeight * 0.01;
      document.documentElement.style.setProperty('--vh', `${vh}px`);
    };
    setVh();
    window.addEventListener('resize', this.debounce(setVh, 100));

    // Initialize table scroll indicators
    this.initTableScrollIndicators();

    // Initialize hamburger menu
    this.initHamburgerMenu();
  },

  // Hamburger menu for mobile navigation.
  // Dropdown is appended to <body> with position:fixed.
  // (overflow-x:hidden was removed from html/body so position:fixed works.)
  initHamburgerMenu() {
    if (this._hamburgerInitialized) return;
    const hamburger = document.getElementById('nav-hamburger');
    const headerNav = document.getElementById('main-nav');
    if (!hamburger || !headerNav) return;
    this._hamburgerInitialized = true;

    // Build dropdown from scratch — avoids .nav class to prevent style conflicts
    const dropdown = document.createElement('div');
    dropdown.className = 'mobile-nav-menu';
    dropdown.setAttribute('role', 'navigation');
    dropdown.setAttribute('aria-label', 'Mobile navigation');

    // Copy links from the header nav
    headerNav.querySelectorAll('.nav-link').forEach(link => {
      const a = document.createElement('a');
      a.href = link.href;
      a.className = 'mobile-nav-link';
      a.textContent = link.textContent.trim();
      if (link.classList.contains('active')) a.classList.add('active');
      dropdown.appendChild(a);
    });

    // Move the real wallet button into the dropdown (only on mobile)
    const walletBtn = document.getElementById('connect-wallet');
    if (walletBtn && window.matchMedia('(max-width: 768px)').matches) {
      const wrapper = document.createElement('div');
      wrapper.className = 'mobile-nav-wallet';
      wrapper.appendChild(walletBtn);
      dropdown.appendChild(wrapper);
    }

    document.body.appendChild(dropdown);

    const closeMobileNav = () => {
      dropdown.classList.remove('open');
      hamburger.classList.remove('active');
      hamburger.setAttribute('aria-expanded', 'false');
    };

    const openMobileNav = () => {
      dropdown.classList.add('open');
      hamburger.classList.add('active');
      hamburger.setAttribute('aria-expanded', 'true');
    };

    hamburger.addEventListener('click', (e) => {
      e.stopPropagation();
      if (dropdown.classList.contains('open')) {
        closeMobileNav();
      } else {
        openMobileNav();
      }
    });

    // Close menu when a link is clicked
    dropdown.querySelectorAll('.mobile-nav-link').forEach(link => {
      link.addEventListener('click', closeMobileNav);
    });

    // Close when clicking outside
    document.addEventListener('click', (e) => {
      if (dropdown.classList.contains('open') &&
          !dropdown.contains(e.target) && !hamburger.contains(e.target)) {
        closeMobileNav();
      }
    });

    // Close on Escape
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && dropdown.classList.contains('open')) {
        closeMobileNav();
      }
    });

    // Store references
    this._mobileDropdown = dropdown;
    this._closeMobileNav = closeMobileNav;
  },

  // Handle horizontal scroll indicators for tables
  initTableScrollIndicators() {
    const setupScrollIndicator = (wrapper) => {
      const checkScroll = () => {
        const isAtEnd = wrapper.scrollLeft + wrapper.clientWidth >= wrapper.scrollWidth - 5;
        wrapper.classList.toggle('scroll-end', isAtEnd);
      };

      wrapper.addEventListener('scroll', this.debounce(checkScroll, 50), { passive: true });
      // Check initial state
      checkScroll();
    };

    // Setup for existing table wrappers
    document.querySelectorAll('.token-table-container').forEach(setupScrollIndicator);

    // Observe for dynamically added table wrappers
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === 1) {
            if (node.classList?.contains('token-table-wrapper')) {
              setupScrollIndicator(node);
            }
            node.querySelectorAll?.('.token-table-container').forEach(setupScrollIndicator);
          }
        });
      });
    });

    // Scope observer to main content area instead of document.body to reduce mutation noise
    const observeTarget = document.querySelector('main') || document.querySelector('.content') || document.body;
    observer.observe(observeTarget, { childList: true, subtree: true });
  }
};

// Loading state manager
const loading = {
  show(element, text = 'Loading...') {
    if (!element) return;
    element.dataset.originalContent = element.innerHTML;
    // Escape text to prevent XSS if callers ever pass dynamic content
    const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    element.innerHTML = `
      <div class="loading-state">
        <div class="loading-spinner"></div>
        <span>${escaped}</span>
      </div>
    `;
    element.classList.add('is-loading');
  },

  hide(element) {
    if (!element) return;
    if (element.dataset.originalContent) {
      element.innerHTML = element.dataset.originalContent;
      delete element.dataset.originalContent;
    }
    element.classList.remove('is-loading');
  }
};

// Initialize hamburger menu as soon as DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  utils.initHamburgerMenu();
});

// Export for modules (if using)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { api, apiCache, utils, toast, loading };
}
