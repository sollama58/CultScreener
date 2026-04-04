// Watchlist Manager
const watchlist = {
  // Local cache of watchlist items (mint -> true)
  items: new Map(),
  isLoaded: false,
  isLoading: false,

  // Initialize watchlist from server
  async init() {
    if (!wallet.connected) {
      this.clear();
      return;
    }

    if (this.isLoading || this.isLoaded) return;
    this.isLoading = true;
    const _t0 = performance.now();
    let _ok = true;

    try {
      const response = await api.watchlist.get(wallet.address);
      this.items.clear();
      // Guard against null/undefined response or missing tokens array
      const tokens = response?.tokens || [];
      if (Array.isArray(tokens)) {
        tokens.forEach(token => {
          if (token && token.mint) {
            this.items.set(token.mint, token);
          }
        });
      }
      this.isLoaded = true;
      this.updateAllButtons();
      this.updateWatchlistCount();
    } catch (error) {
      _ok = false;
      console.error('Failed to load watchlist:', error);
      // Mark as loaded even on error to prevent infinite retries
      this.isLoaded = true;
    } finally {
      this.isLoading = false;
      if (typeof latencyTracker !== 'undefined') latencyTracker.record('watchlist.init', performance.now() - _t0, _ok, 'frontend');
    }
  },

  // Clear local cache
  clear() {
    this.items.clear();
    this.isLoaded = false;
    this.updateAllButtons();
    this.updateWatchlistCount();
  },

  // Check if token is in watchlist
  has(tokenMint) {
    return this.items.has(tokenMint);
  },

  // Add token to watchlist
  async add(tokenMint) {
    if (!wallet.connected) {
      const connected = await wallet.connect();
      if (!connected) {
        toast.warning('Connect your wallet to use watchlist');
        return false;
      }
    }

    try {
      const result = await api.watchlist.add(wallet.address, tokenMint);

      if (!result.alreadyExists) {
        this.items.set(tokenMint, { mint: tokenMint, addedAt: new Date() });
        toast.success('Added to watchlist');
      }

      this.updateButton(tokenMint, true);
      this.updateWatchlistCount();
      return true;
    } catch (error) {
      if (error.message?.includes('WATCHLIST_LIMIT')) {
        toast.error('Watchlist limit reached (max 100 tokens)');
      } else {
        toast.error('Failed to add to watchlist');
      }
      return false;
    }
  },

  // Remove token from watchlist
  async remove(tokenMint) {
    if (!wallet.connected) return false;

    try {
      await api.watchlist.remove(wallet.address, tokenMint);
      this.items.delete(tokenMint);
      toast.success('Removed from watchlist');
      this.updateButton(tokenMint, false);
      this.updateWatchlistCount();

      // If on watchlist filter, refresh the list
      if (typeof tokenList !== 'undefined' && tokenList.currentFilter === 'watchlist') {
        tokenList.loadTokens();
      }

      return true;
    } catch (error) {
      toast.error('Failed to remove from watchlist');
      return false;
    }
  },

  // Toggle watchlist status
  async toggle(tokenMint) {
    const _t0 = performance.now();
    let _ok = true;
    try {
      const result = this.has(tokenMint)
        ? await this.remove(tokenMint)
        : await this.add(tokenMint);
      _ok = result !== false;
      return result;
    } catch (err) {
      _ok = false;
      throw err;
    } finally {
      if (typeof latencyTracker !== 'undefined') latencyTracker.record('watchlist.toggle', performance.now() - _t0, _ok, 'frontend');
    }
  },

  // Update all watchlist buttons on page
  updateAllButtons() {
    document.querySelectorAll('[data-watchlist-token]').forEach(btn => {
      const mint = btn.dataset.watchlistToken;
      this.updateButton(mint, this.has(mint));
    });
  },

  // Update single button state
  updateButton(tokenMint, isInWatchlist) {
    document.querySelectorAll(`[data-watchlist-token="${tokenMint}"]`).forEach(btn => {
      btn.classList.toggle('active', isInWatchlist);
      btn.setAttribute('aria-pressed', isInWatchlist);
      btn.title = isInWatchlist ? 'Remove from watchlist' : 'Add to watchlist';

      // Update icon if using star icons
      const icon = btn.querySelector('.watchlist-icon');
      if (icon) {
        icon.innerHTML = isInWatchlist ? this.getFilledStarSVG() : this.getEmptyStarSVG();
      }
    });
  },

  // Update watchlist count in header
  updateWatchlistCount() {
    const countEl = document.getElementById('watchlist-count');
    if (countEl) {
      const count = this.items.size;
      countEl.textContent = count;
      countEl.style.display = count > 0 ? 'inline-flex' : 'none';
    }
  },

  // Get empty star SVG
  getEmptyStarSVG() {
    return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
    </svg>`;
  },

  // Get filled star SVG
  getFilledStarSVG() {
    return `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2">
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
    </svg>`;
  },

  // Create watchlist button element
  createButton(tokenMint, size = 'normal') {
    const isInWatchlist = this.has(tokenMint);
    const btn = document.createElement('button');
    btn.className = `watchlist-btn ${size === 'small' ? 'watchlist-btn-sm' : ''} ${isInWatchlist ? 'active' : ''}`;
    btn.dataset.watchlistToken = tokenMint;
    btn.setAttribute('aria-pressed', isInWatchlist);
    btn.title = isInWatchlist ? 'Remove from watchlist' : 'Add to watchlist';

    btn.innerHTML = `<span class="watchlist-icon">${isInWatchlist ? this.getFilledStarSVG() : this.getEmptyStarSVG()}</span>`;

    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      btn.disabled = true;
      await this.toggle(tokenMint);
      btn.disabled = false;
    });

    return btn;
  },

  // Get watchlist tokens for display
  async getTokensWithData() {
    if (!wallet.connected) return [];

    try {
      const response = await api.watchlist.get(wallet.address);
      // Guard against null/undefined response
      return response?.tokens || [];
    } catch (error) {
      console.error('Failed to get watchlist:', error);
      return [];
    }
  },

  // Batch check tokens (useful when loading token list)
  async checkBatch(tokenMints) {
    if (!wallet.connected || tokenMints.length === 0) return {};

    try {
      const response = await api.watchlist.checkBatch(wallet.address, tokenMints);
      // Update local cache with results
      Object.entries(response?.watchlist || {}).forEach(([mint, inWatchlist]) => {
        if (inWatchlist) {
          this.items.set(mint, { mint });
        }
      });
      return response?.watchlist || {};
    } catch (error) {
      console.error('Failed to batch check watchlist:', error);
      return {};
    }
  }
};

// Initialize watchlist when wallet connects
document.addEventListener('DOMContentLoaded', () => {
  if (typeof wallet !== 'undefined') {
    // Listen for wallet connection via CustomEvent (works with both single-wallet and multi-wallet selector)
    window.addEventListener('walletConnected', () => {
      watchlist.init();
    });

    window.addEventListener('walletDisconnected', () => {
      watchlist.clear();
    });

    // Init if already connected (wallet may already be initialized)
    if (wallet.initialized && wallet.connected) {
      watchlist.init();
    } else {
      // Wait for wallet to be ready
      window.addEventListener('walletReady', (e) => {
        if (e.detail.connected) {
          watchlist.init();
        }
      }, { once: true });
    }
  }
});
