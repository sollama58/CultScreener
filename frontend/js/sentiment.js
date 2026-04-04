// Community Sentiment Module
// Bullish/Bearish voting per token — any connected wallet can vote

(function injectSentimentCSS() {
  if (document.getElementById('sentiment-styles')) return;
  const style = document.createElement('style');
  style.id = 'sentiment-styles';
  style.textContent = `
    .sentiment-header-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 1rem;
    }
    .sentiment-section-title {
      font-size: 1rem;
      font-weight: 600;
      color: var(--text-primary);
    }
    .sentiment-percent {
      font-size: 0.85rem;
      font-weight: 600;
      color: var(--text-primary);
    }
    .sentiment-percent.bullish { color: #22c55e; }
    .sentiment-percent.bearish { color: #ef4444; }
    .sentiment-bar-wrap {
      width: 100%;
      height: 6px;
      background: var(--bg-tertiary);
      border-radius: 3px;
      overflow: hidden;
      margin-bottom: 0.85rem;
    }
    .sentiment-bar-fill {
      height: 100%;
      background: linear-gradient(90deg, #22c55e, #16a34a);
      border-radius: 3px;
      transition: width 0.4s ease;
      min-width: 0;
    }
    .sentiment-bar-fill.bearish-dominant {
      background: linear-gradient(90deg, #ef4444, #dc2626);
    }
    .sentiment-footer-row {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      flex-wrap: wrap;
    }
    .sentiment-actions {
      display: flex;
      gap: 0.5rem;
    }
    .sentiment-btn {
      display: flex;
      align-items: center;
      gap: 0.3rem;
      padding: 0.3rem 0.7rem;
      border-radius: var(--radius-sm);
      border: 1px solid var(--border-subtle);
      background: var(--bg-tertiary);
      color: var(--text-secondary);
      cursor: pointer;
      font-size: 0.82rem;
      font-weight: 500;
      transition: all 0.15s ease;
      white-space: nowrap;
    }
    .sentiment-btn:hover {
      border-color: var(--border-default);
      color: var(--text-primary);
    }
    .sentiment-btn.bullish.active {
      border-color: #22c55e;
      color: #22c55e;
      background: rgba(34, 197, 94, 0.08);
      box-shadow: 0 0 0 1px #22c55e33;
    }
    .sentiment-btn.bearish.active {
      border-color: #ef4444;
      color: #ef4444;
      background: rgba(239, 68, 68, 0.08);
      box-shadow: 0 0 0 1px #ef444433;
    }
    .sentiment-btn-count {
      font-size: 0.78rem;
      opacity: 0.8;
    }
    .sentiment-counts {
      font-size: 0.78rem;
      color: var(--text-muted);
    }
    .sentiment-hint {
      font-size: 0.78rem;
      color: var(--text-muted);
      margin: 0;
      margin-left: auto;
    }
    .sentiment-hint a {
      color: var(--accent);
      cursor: pointer;
      text-decoration: none;
    }
    .sentiment-hint a:hover { text-decoration: underline; }
  `;
  document.head.appendChild(style);
})();

const sentiment = {
  currentMint: null,
  userVote: null,
  tally: { bullish: 0, bearish: 0, score: 0 },
  _casting: false,
  _bound: false,

  // Bind event listeners (CSP-safe, replaces inline onclick handlers)
  bindEvents() {
    if (this._bound) return;
    this._bound = true;

    const bullishBtn = document.getElementById('sentiment-bullish-btn');
    const bearishBtn = document.getElementById('sentiment-bearish-btn');
    const connectLink = document.getElementById('sentiment-connect-link');

    if (bullishBtn) bullishBtn.addEventListener('click', () => this.castVote('bullish'));
    if (bearishBtn) bearishBtn.addEventListener('click', () => this.castVote('bearish'));
    if (connectLink) {
      connectLink.addEventListener('click', (e) => {
        e.preventDefault();
        if (typeof wallet !== 'undefined') wallet.connect();
      });
    }
  },

  async loadForToken(mint) {
    this.currentMint = mint;
    this.userVote = null;
    this.tally = { bullish: 0, bearish: 0, score: 0 };

    const section = document.getElementById('sentiment-section');
    if (!section) return;
    section.style.display = '';

    // Bind click handlers on first load
    this.bindEvents();

    try {
      const walletAddr = (typeof wallet !== 'undefined' && wallet.connected) ? wallet.address : null;
      const data = await api.sentiment.get(mint, walletAddr);
      this.tally = data.tally || { bullish: 0, bearish: 0, score: 0 };
      this.userVote = data.userVote || null;
      this.updateUI();
    } catch (err) {
      // Non-fatal — section stays visible with zero state
      this.updateUI();
    }
  },

  async castVote(sentimentType) {
    if (this._casting) return;

    // Require wallet
    if (typeof wallet === 'undefined' || !wallet.connected) {
      if (typeof wallet !== 'undefined') {
        const connected = await wallet.connect();
        if (!connected) {
          if (typeof toast !== 'undefined') toast.warning('Connect your wallet to vote');
          return;
        }
        // Re-load to get user's existing vote now that wallet is connected
        if (this.currentMint) await this.loadForToken(this.currentMint);
      } else {
        if (typeof toast !== 'undefined') toast.warning('Connect your wallet to vote');
        return;
      }
    }

    this._casting = true;

    // Optimistic update
    const prevVote = this.userVote;
    const prevTally = { ...this.tally };

    if (this.userVote === sentimentType) {
      // Toggle off
      this.userVote = null;
      this.tally = {
        bullish: Math.max(0, this.tally.bullish - (sentimentType === 'bullish' ? 1 : 0)),
        bearish: Math.max(0, this.tally.bearish - (sentimentType === 'bearish' ? 1 : 0)),
        score: this.tally.score - (sentimentType === 'bullish' ? 1 : -1)
      };
    } else if (this.userVote === null) {
      // New vote
      this.userVote = sentimentType;
      this.tally = {
        bullish: this.tally.bullish + (sentimentType === 'bullish' ? 1 : 0),
        bearish: this.tally.bearish + (sentimentType === 'bearish' ? 1 : 0),
        score: this.tally.score + (sentimentType === 'bullish' ? 1 : -1)
      };
    } else {
      // Switch vote
      const wasBullish = this.userVote === 'bullish';
      this.userVote = sentimentType;
      this.tally = {
        bullish: this.tally.bullish + (wasBullish ? -1 : 1),
        bearish: this.tally.bearish + (wasBullish ? 1 : -1),
        score: this.tally.score + (sentimentType === 'bullish' ? 2 : -2)
      };
    }
    this.updateUI();

    try {
      const result = await api.sentiment.cast(this.currentMint, sentimentType, wallet.address);
      // Confirm with server values
      this.tally = result.tally || this.tally;
      this.userVote = result.action === 'removed' ? null : sentimentType;
      this.updateUI();
    } catch (err) {
      // Revert optimistic update
      this.userVote = prevVote;
      this.tally = prevTally;
      this.updateUI();
      if (typeof toast !== 'undefined') {
        toast.error('Failed to record vote — please try again');
      }
    } finally {
      this._casting = false;
    }
  },

  updateUI() {
    const bullishBtn = document.getElementById('sentiment-bullish-btn');
    const bearishBtn = document.getElementById('sentiment-bearish-btn');
    const bullishCount = document.getElementById('sentiment-bullish-count');
    const bearishCount = document.getElementById('sentiment-bearish-count');
    const barFill = document.getElementById('sentiment-bar-fill');
    const percentEl = document.getElementById('sentiment-percent');
    const countsEl = document.getElementById('sentiment-counts');
    const hintEl = document.getElementById('sentiment-hint');

    if (!bullishBtn || !bearishBtn) return;

    const { bullish, bearish } = this.tally;
    const total = bullish + bearish;

    // Bar fill
    if (barFill) {
      const pct = total > 0 ? Math.round((bullish / total) * 100) : 50;
      barFill.style.width = `${pct}%`;
      barFill.classList.toggle('bearish-dominant', bullish < bearish);
    }

    // Percent label
    if (percentEl) {
      if (total === 0) {
        percentEl.textContent = 'No votes yet';
        percentEl.className = 'sentiment-percent';
      } else {
        const bPct = Math.round((bullish / total) * 100);
        const dominant = bullish >= bearish ? 'Bullish' : 'Bearish';
        const dispPct = bullish >= bearish ? bPct : 100 - bPct;
        percentEl.textContent = `${dispPct}% ${dominant}`;
        percentEl.className = `sentiment-percent ${bullish >= bearish ? 'bullish' : 'bearish'}`;
      }
    }

    // Counts
    if (countsEl) {
      countsEl.textContent = total > 0
        ? `${bullish} Bullish · ${bearish} Bearish`
        : 'Be the first to vote';
    }

    // Button counts
    if (bullishCount) bullishCount.textContent = bullish;
    if (bearishCount) bearishCount.textContent = bearish;

    // Active states
    bullishBtn.classList.toggle('active', this.userVote === 'bullish');
    bearishBtn.classList.toggle('active', this.userVote === 'bearish');

    // Hint text
    if (hintEl) {
      const connected = typeof wallet !== 'undefined' && wallet.connected;
      hintEl.style.display = connected ? 'none' : '';
    }
  }
};
