/* CultScreener API Keys Page */
const apiKeysPage = {
  currentWallet: null,
  currentKey: null,   // Actual key — only kept in memory/sessionStorage within session
  keyMeta: null,      // Metadata (prefix, dates, etc.) — cached in localStorage

  _metaStorageKey(wallet) {
    return `cultApiKeyMeta_${wallet}`;
  },

  init() {
    this.loadSessionKey();
    this.setApiBaseUrl();
    this.bindWalletConnection();
    this.bindKeyManagement();
    this.bindApiTester();

    // Check wallet state on load
    if (wallet.connected && wallet.address) {
      this.currentWallet = wallet.address;
      this.showKeyManagement();
      this.loadCachedKeyMeta();
    } else {
      this.showConnectPrompt();
    }

    window.addEventListener('walletConnected', (e) => {
      this.currentWallet = e.detail.address;
      this.showKeyManagement();
      this.loadCachedKeyMeta();
    });

    window.addEventListener('walletDisconnected', () => {
      this.currentWallet = null;
      this.currentKey = null;
      this.keyMeta = null;
      this.showConnectPrompt();
    });
  },

  loadSessionKey() {
    // Restore key from sessionStorage so tester works within same browser session
    const saved = sessionStorage.getItem('cultApiKey');
    if (saved) {
      this.currentKey = saved;
      const testerInput = document.getElementById('tester-api-key');
      if (testerInput) testerInput.value = saved;
    }
  },

  setApiBaseUrl() {
    const base = `${config.api.baseUrl}/v1`;
    document.querySelectorAll('.api-base-url').forEach(el => {
      el.textContent = base;
    });
  },

  showConnectPrompt() {
    document.getElementById('key-not-connected').style.display = 'block';
    document.getElementById('key-management').style.display = 'none';
  },

  showKeyManagement() {
    document.getElementById('key-not-connected').style.display = 'none';
    document.getElementById('key-management').style.display = 'block';

    const walletEl = document.getElementById('wallet-address-display');
    if (walletEl && this.currentWallet) {
      const short = `${this.currentWallet.slice(0, 6)}...${this.currentWallet.slice(-4)}`;
      walletEl.textContent = short;
      walletEl.title = this.currentWallet;
    }
  },

  showLoading() {
    document.getElementById('key-loading').style.display = 'flex';
    document.getElementById('existing-key').style.display = 'none';
    document.getElementById('no-key').style.display = 'none';
    document.getElementById('key-generated').style.display = 'none';
  },

  hideLoading() {
    document.getElementById('key-loading').style.display = 'none';
  },

  bindWalletConnection() {
    document.querySelectorAll('.connect-wallet-btn').forEach(btn => {
      btn.addEventListener('click', () => wallet.connect());
    });
  },

  bindKeyManagement() {
    const on = (id, fn) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('click', fn);
    };
    on('generate-key-btn', () => this.generateKey());
    on('rotate-key-btn', () => this.rotateKey());
    on('revoke-key-btn', () => this.revokeKey());
    on('key-generated-confirm', () => this.confirmKeySaved());
    on('copy-key-btn', () => this.copyKeyToClipboard());
  },

  bindApiTester() {
    document.querySelectorAll('.tester-tab').forEach(tab => {
      tab.addEventListener('click', () => this.switchTesterTab(tab.dataset.tab));
    });

    const on = (id, fn) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('click', fn);
    };
    on('test-leaderboard-btn', () => this.testLeaderboard());
    on('test-token-btn', () => this.testToken());
  },

  // ── Key metadata: localStorage cache ─────────────────────────────────────

  loadCachedKeyMeta() {
    if (!this.currentWallet) return;
    this.showLoading();

    try {
      const raw = localStorage.getItem(this._metaStorageKey(this.currentWallet));
      if (raw) {
        this.keyMeta = JSON.parse(raw);
        this.hideLoading();
        this.showExistingKey(this.keyMeta);
        return;
      }
    } catch (e) {
      // Corrupted — fall through to no-key state
    }

    this.hideLoading();
    this.showNoKey();
  },

  saveKeyMeta(meta) {
    if (!this.currentWallet) return;
    this.keyMeta = meta;
    try {
      localStorage.setItem(this._metaStorageKey(this.currentWallet), JSON.stringify(meta));
    } catch (e) { /* storage unavailable */ }
  },

  clearKeyMeta() {
    if (!this.currentWallet) return;
    this.keyMeta = null;
    try {
      localStorage.removeItem(this._metaStorageKey(this.currentWallet));
    } catch (e) { /* ignore */ }
  },

  // ── Signing helper ────────────────────────────────────────────────────────

  async signForApi() {
    const timestamp = Date.now();
    const message = `CultScreener API Key: register for ${this.currentWallet} at ${timestamp}`;
    const sig = await wallet.signMessage(message);
    if (!sig || !sig.signature) throw new Error('Signature cancelled or failed');
    return { signature: sig.signature, signatureTimestamp: timestamp };
  },

  // ── Key operations ────────────────────────────────────────────────────────

  async generateKey() {
    if (!this.currentWallet) { api.toast.error('Wallet not connected'); return; }

    const btn = document.getElementById('generate-key-btn');
    this._setLoading(btn, true, 'Signing...');

    try {
      const { signature, signatureTimestamp } = await this.signForApi();

      const response = await api.request('/api/keys', {
        method: 'POST',
        body: JSON.stringify({ wallet: this.currentWallet, signature, signatureTimestamp })
      });

      if (response.success && response.key) {
        this.currentKey = response.key;
        sessionStorage.setItem('cultApiKey', response.key);

        this.saveKeyMeta({
          prefix: response.prefix,
          created_at: response.created_at,
          is_active: true,
          request_count: 0,
          last_used_at: null
        });

        this._prefillTesterKey(response.key);
        this.hideNoKey();
        this.showKeyDisplay();
        api.toast.success('API key generated!');
      }
    } catch (err) {
      api.toast.error(err.message || 'Failed to generate API key');
    } finally {
      this._setLoading(btn, false, 'Generate API Key');
    }
  },

  async rotateKey() {
    if (!this.currentWallet) return;
    if (!confirm('Generate a new key? Your current key will stop working immediately.')) return;

    const btn = document.getElementById('rotate-key-btn');
    this._setLoading(btn, true, 'Signing...');

    try {
      const { signature, signatureTimestamp } = await this.signForApi();

      const response = await api.request('/api/keys/rotate', {
        method: 'POST',
        body: JSON.stringify({ wallet: this.currentWallet, signature, signatureTimestamp })
      });

      if (response.success && response.key) {
        this.currentKey = response.key;
        sessionStorage.setItem('cultApiKey', response.key);

        this.saveKeyMeta({
          prefix: response.prefix,
          created_at: response.created_at,
          is_active: true,
          request_count: 0,
          last_used_at: null
        });

        this._prefillTesterKey(response.key);
        this.hideExistingKey();
        this.showKeyDisplay();
        api.toast.success('API key rotated!');
      }
    } catch (err) {
      api.toast.error(err.message || 'Failed to rotate key');
    } finally {
      this._setLoading(btn, false, 'Rotate Key');
    }
  },

  async revokeKey() {
    if (!this.currentWallet) return;
    if (!confirm('Permanently revoke your API key? Any integrations using it will break.')) return;

    const btn = document.getElementById('revoke-key-btn');
    this._setLoading(btn, true, 'Revoking...');

    try {
      const { signature, signatureTimestamp } = await this.signForApi();

      const response = await api.request('/api/keys/me', {
        method: 'DELETE',
        body: JSON.stringify({ wallet: this.currentWallet, signature, signatureTimestamp })
      });

      if (response.success) {
        this.currentKey = null;
        sessionStorage.removeItem('cultApiKey');
        this.clearKeyMeta();
        this._prefillTesterKey('');
        this.hideExistingKey();
        this.showNoKey();
        api.toast.success('API key revoked');
      }
    } catch (err) {
      api.toast.error(err.message || 'Failed to revoke key');
    } finally {
      this._setLoading(btn, false, 'Revoke Key');
    }
  },

  // ── UI state helpers ──────────────────────────────────────────────────────

  showExistingKey(meta) {
    document.getElementById('existing-key').style.display = 'block';
    document.getElementById('no-key').style.display = 'none';
    document.getElementById('key-generated').style.display = 'none';

    const set = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.textContent = val;
    };

    set('key-prefix', meta.prefix || '-');
    set('key-created', meta.created_at ? new Date(meta.created_at).toLocaleDateString() : '-');
    set('key-last-used', meta.last_used_at ? new Date(meta.last_used_at).toLocaleString() : 'Never');
    set('key-requests', typeof meta.request_count === 'number' ? meta.request_count.toLocaleString() : '0');

    const statusEl = document.getElementById('key-status');
    if (statusEl) {
      statusEl.textContent = meta.is_active !== false ? 'Active' : 'Revoked';
      statusEl.className = `status-badge ${meta.is_active !== false ? 'active' : 'inactive'}`;
    }
  },

  hideExistingKey() {
    document.getElementById('existing-key').style.display = 'none';
  },

  showNoKey() {
    document.getElementById('no-key').style.display = 'block';
    document.getElementById('existing-key').style.display = 'none';
    document.getElementById('key-generated').style.display = 'none';
  },

  hideNoKey() {
    document.getElementById('no-key').style.display = 'none';
  },

  showKeyDisplay() {
    const display = document.getElementById('key-generated');
    const value = document.getElementById('new-key-value');
    if (display) display.style.display = 'block';
    if (value && this.currentKey) value.textContent = this.currentKey;
  },

  confirmKeySaved() {
    document.getElementById('key-generated').style.display = 'none';
    if (this.keyMeta) {
      this.showExistingKey(this.keyMeta);
    } else {
      this.showNoKey();
    }
  },

  copyKeyToClipboard() {
    if (!this.currentKey) return;
    navigator.clipboard.writeText(this.currentKey).then(() => {
      const btn = document.getElementById('copy-key-btn');
      if (btn) {
        const original = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = original; }, 2000);
      }
    }).catch(() => {
      api.toast.error('Copy failed — select the key text and copy manually');
    });
  },

  // ── API Tester ────────────────────────────────────────────────────────────

  switchTesterTab(tabName) {
    document.querySelectorAll('.tester-content').forEach(c => c.classList.remove('active'));
    document.querySelectorAll('.tester-tab').forEach(t => t.classList.remove('active'));
    const content = document.getElementById(`tester-${tabName}`);
    if (content) content.classList.add('active');
    const tab = document.querySelector(`[data-tab="${tabName}"]`);
    if (tab) tab.classList.add('active');
  },

  _getTesterKey() {
    const input = document.getElementById('tester-api-key');
    const key = (input?.value || '').trim() || this.currentKey;
    if (!key) {
      api.toast.error('Paste your API key into the field above first');
      return null;
    }
    return key;
  },

  _prefillTesterKey(key) {
    const input = document.getElementById('tester-api-key');
    if (input) input.value = key;
  },

  _setLoading(btn, loading, label) {
    if (!btn) return;
    btn.disabled = loading;
    if (label) btn.textContent = loading ? label : btn.dataset.label || label;
  },

  _showResponse(prefix, data, status, ok) {
    const responseEl = document.getElementById(`${prefix}-response`);
    const contentEl = document.getElementById(`${prefix}-response-content`);
    const statusEl = document.getElementById(`${prefix}-status`);

    if (!responseEl || !contentEl) return;

    responseEl.classList.remove('hidden', 'error', 'success');
    responseEl.classList.add(ok ? 'success' : 'error');
    contentEl.textContent = JSON.stringify(data, null, 2);

    if (statusEl) {
      statusEl.textContent = `HTTP ${status}`;
      statusEl.className = `response-status-badge ${ok ? 'ok' : 'err'}`;
      statusEl.style.display = '';
    }
  },

  _showNetworkError(prefix, message) {
    const responseEl = document.getElementById(`${prefix}-response`);
    const contentEl = document.getElementById(`${prefix}-response-content`);
    const statusEl = document.getElementById(`${prefix}-status`);

    if (!responseEl || !contentEl) return;

    responseEl.classList.remove('hidden', 'success');
    responseEl.classList.add('error');
    contentEl.textContent = `Network Error: ${message}\n\nCheck that the API server is running and CORS is configured correctly.`;

    if (statusEl) {
      statusEl.textContent = 'Network Error';
      statusEl.className = 'response-status-badge err';
      statusEl.style.display = '';
    }
  },

  async testLeaderboard() {
    const key = this._getTesterKey();
    if (!key) return;

    const limit = Math.min(parseInt(document.getElementById('lb-limit')?.value) || 25, 100);
    const offset = Math.max(0, parseInt(document.getElementById('lb-offset')?.value) || 0);
    const minConviction = document.getElementById('lb-min-conviction')?.value;
    const minMcap = document.getElementById('lb-min-mcap')?.value;

    const btn = document.getElementById('test-leaderboard-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Loading...'; }

    try {
      const params = new URLSearchParams({ limit, offset });
      if (minConviction) params.append('minConviction', parseFloat(minConviction));
      if (minMcap) params.append('minMcap', parseFloat(minMcap));

      const response = await fetch(
        `${config.api.baseUrl}/v1/leaderboard?${params}`,
        { headers: { 'X-API-Key': key } }
      );
      const data = await response.json();
      this._showResponse('lb', data, response.status, response.ok);
    } catch (err) {
      this._showNetworkError('lb', err.message);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Send Request'; }
    }
  },

  async testToken() {
    const key = this._getTesterKey();
    if (!key) return;

    const mint = document.getElementById('token-mint')?.value?.trim();
    if (!mint) { api.toast.error('Enter a token mint address'); return; }

    const btn = document.getElementById('test-token-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Loading...'; }

    try {
      const response = await fetch(
        `${config.api.baseUrl}/v1/leaderboard/${encodeURIComponent(mint)}`,
        { headers: { 'X-API-Key': key } }
      );
      const data = await response.json();
      this._showResponse('token', data, response.status, response.ok);
    } catch (err) {
      this._showNetworkError('token', err.message);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Send Request'; }
    }
  }
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => apiKeysPage.init());
} else {
  apiKeysPage.init();
}
