// Watchlist Manager
const watchlist = {
  // Local cache of watchlist items (mint -> true)
  items: new Map(),
  isLoaded: false,
  isLoading: false,
  _loadFailed: false,

  // Initialize watchlist from server
  async init() {
    if (!wallet.connected || !wallet.address) {
      this.clear();
      return;
    }

    // Allow retry if previous load failed
    if (this.isLoading) return;
    if (this.isLoaded && !this._loadFailed) return;

    this.isLoading = true;
    this._loadFailed = false;

    try {
      const response = await api.watchlist.get(wallet.address);
      this.items.clear();
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

      // Notify any waiting code that watchlist is ready
      window.dispatchEvent(new CustomEvent('watchlistReady', { detail: { count: this.items.size } }));
    } catch (error) {
      console.error('Failed to load watchlist:', error);
      this._loadFailed = true;
      this.isLoaded = true; // Prevent infinite retries on hard errors
    } finally {
      this.isLoading = false;
    }
  },

  // Clear local cache
  clear() {
    this.items.clear();
    this.isLoaded = false;
    this._loadFailed = false;
    this.updateAllButtons();
    this.updateWatchlistCount();
  },

  // Check if token is in watchlist
  has(tokenMint) {
    return this.items.has(tokenMint);
  },

  // Add token to watchlist
  async add(tokenMint) {
    if (!wallet.connected || !wallet.address) {
      const connected = await wallet.connect();
      if (!connected) {
        if (typeof toast !== 'undefined') toast.warning('Connect your wallet to use watchlist');
        return false;
      }
    }

    try {
      const result = await api.watchlist.add(wallet.address, tokenMint);

      if (!result.alreadyExists) {
        this.items.set(tokenMint, { mint: tokenMint, addedAt: new Date() });
        if (typeof toast !== 'undefined') toast.success('Added to watchlist');
      }

      this.updateButton(tokenMint, true);
      this.updateWatchlistCount();
      return true;
    } catch (error) {
      if (error.message?.includes('WATCHLIST_LIMIT')) {
        if (typeof toast !== 'undefined') toast.error('Watchlist limit reached (max 100 tokens)');
      } else {
        console.error('Watchlist add error:', error);
        if (typeof toast !== 'undefined') toast.error('Failed to add to watchlist');
      }
      return false;
    }
  },

  // Remove token from watchlist
  async remove(tokenMint) {
    if (!wallet.connected || !wallet.address) return false;

    try {
      await api.watchlist.remove(wallet.address, tokenMint);
      this.items.delete(tokenMint);
      if (typeof toast !== 'undefined') toast.success('Removed from watchlist');
      this.updateButton(tokenMint, false);
      this.updateWatchlistCount();
      return true;
    } catch (error) {
      console.error('Watchlist remove error:', error);
      if (typeof toast !== 'undefined') toast.error('Failed to remove from watchlist');
      return false;
    }
  },

  // Toggle watchlist status
  async toggle(tokenMint) {
    return this.has(tokenMint)
      ? await this.remove(tokenMint)
      : await this.add(tokenMint);
  },

  // Update all watchlist buttons on page
  updateAllButtons() {
    document.querySelectorAll('[data-watchlist-token]').forEach(btn => {
      const mint = btn.dataset.watchlistToken;
      this.updateButton(mint, this.has(mint));
    });

    // Also update the token detail page watchlist button if present
    if (typeof tokenDetail !== 'undefined' && tokenDetail.updateWatchlistButton) {
      tokenDetail.updateWatchlistButton();
    }
  },

  // Update single button state
  updateButton(tokenMint, isInWatchlist) {
    document.querySelectorAll(`[data-watchlist-token="${tokenMint}"]`).forEach(btn => {
      btn.classList.toggle('active', isInWatchlist);
      btn.setAttribute('aria-pressed', isInWatchlist);
      btn.title = isInWatchlist ? 'Remove from watchlist' : 'Add to watchlist';

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

  getEmptyStarSVG() {
    return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`;
  },

  getFilledStarSVG() {
    return `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`;
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
    if (!wallet.connected || !wallet.address) return [];

    try {
      const response = await api.watchlist.get(wallet.address);
      return response?.tokens || [];
    } catch (error) {
      console.error('Failed to get watchlist:', error);
      return [];
    }
  },

  // Batch check tokens
  async checkBatch(tokenMints) {
    if (!wallet.connected || !wallet.address || tokenMints.length === 0) return {};

    try {
      const response = await api.watchlist.checkBatch(wallet.address, tokenMints);
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
  if (typeof wallet === 'undefined') return;

  window.addEventListener('walletConnected', () => {
    watchlist.isLoaded = false; // Force reload on new connection
    watchlist._loadFailed = false;
    watchlist.init();
  });

  window.addEventListener('walletDisconnected', () => {
    watchlist.clear();
  });

  // Init if wallet is already connected
  if (wallet.initialized && wallet.connected) {
    watchlist.init();
  } else {
    window.addEventListener('walletReady', (e) => {
      if (e.detail.connected) {
        watchlist.init();
      }
    }, { once: true });
  }
});
