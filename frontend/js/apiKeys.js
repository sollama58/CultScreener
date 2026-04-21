/* CultScreener API Keys Page */

const apiKeysPage = {
  currentWallet: null,
  currentKey: null,
  apiBaseUrl: config.api.baseUrl,

  init() {
    this.bindWalletConnection();
    this.bindKeyManagement();
    this.bindApiTester();
    this.setApiBaseUrl();

    // Check if wallet is already connected
    const connectedWallet = wallet.getConnected();
    if (connectedWallet) {
      this.currentWallet = connectedWallet;
      this.showKeyManagement();
      this.loadExistingKey();
    } else {
      this.showConnectPrompt();
    }

    // Listen for wallet changes
    window.addEventListener('walletConnected', (e) => {
      this.currentWallet = e.detail.address;
      this.showKeyManagement();
      this.loadExistingKey();
    });

    window.addEventListener('walletDisconnected', () => {
      this.currentWallet = null;
      this.showConnectPrompt();
    });
  },

  setApiBaseUrl() {
    const el = document.getElementById('api-base-url');
    if (el) {
      el.textContent = `${this.apiBaseUrl}/v1`;
    }
  },

  showConnectPrompt() {
    const notConnected = document.getElementById('key-not-connected');
    const management = document.getElementById('key-management');
    if (notConnected) notConnected.style.display = 'block';
    if (management) management.style.display = 'none';

    const testerAuth = document.getElementById('tester-authenticated');
    const testerNoAuth = document.getElementById('tester-not-authenticated');
    if (testerAuth) testerAuth.style.display = 'none';
    if (testerNoAuth) testerNoAuth.style.display = 'block';
  },

  showKeyManagement() {
    const notConnected = document.getElementById('key-not-connected');
    const management = document.getElementById('key-management');
    if (notConnected) notConnected.style.display = 'none';
    if (management) management.style.display = 'block';

    const walletInput = document.getElementById('key-wallet');
    if (walletInput && this.currentWallet) {
      walletInput.value = this.currentWallet;
    }
  },

  bindWalletConnection() {
    const connectBtn = document.getElementById('connect-for-key');
    if (connectBtn) {
      connectBtn.addEventListener('click', () => wallet.showWalletModal());
    }
  },

  bindKeyManagement() {
    const generateBtn = document.getElementById('generate-key-btn');
    const rotateBtn = document.getElementById('rotate-key-btn');
    const revokeBtn = document.getElementById('revoke-key-btn');
    const confirmedBtn = document.getElementById('key-generated-confirm');
    const copyBtn = document.getElementById('copy-key-btn');

    if (generateBtn) generateBtn.addEventListener('click', () => this.generateKey());
    if (rotateBtn) rotateBtn.addEventListener('click', () => this.rotateKey());
    if (revokeBtn) revokeBtn.addEventListener('click', () => this.revokeKey());
    if (confirmedBtn) confirmedBtn.addEventListener('click', () => this.hideKeyDisplay());
    if (copyBtn) copyBtn.addEventListener('click', () => this.copyKeyToClipboard());
  },

  bindApiTester() {
    // Tab switching
    const tabs = document.querySelectorAll('.tester-tab');
    tabs.forEach(tab => {
      tab.addEventListener('click', () => this.switchTesterTab(tab.dataset.tab));
    });

    // Leaderboard tester
    const lbBtn = document.getElementById('test-leaderboard-btn');
    if (lbBtn) lbBtn.addEventListener('click', () => this.testLeaderboard());

    // Token tester
    const tokenBtn = document.getElementById('test-token-btn');
    if (tokenBtn) tokenBtn.addEventListener('click', () => this.testToken());
  },

  async generateKey() {
    if (!this.currentWallet) {
      api.toast.error('Wallet not connected');
      return;
    }

    const generateBtn = document.getElementById('generate-key-btn');
    if (generateBtn) generateBtn.disabled = true;
    if (generateBtn) generateBtn.textContent = 'Signing...';

    try {
      const timestamp = Date.now();
      const message = `CultScreener API Key: register for ${this.currentWallet} at ${timestamp}`;

      const sig = await wallet.signMessage(message);
      if (!sig || !sig.signature) {
        api.toast.error('Failed to sign message');
        return;
      }

      const response = await api.request('/api/keys', {
        method: 'POST',
        body: JSON.stringify({
          wallet: this.currentWallet,
          signature: sig.signature,
          signatureTimestamp: timestamp
        })
      });

      if (response.success && response.key) {
        this.currentKey = response.key;
        this.hideNoKey();
        this.showKeyDisplay();
        this.showTesterAuthenticated();

        // Hide tester not authenticated
        const testerNoAuth = document.getElementById('tester-not-authenticated');
        if (testerNoAuth) testerNoAuth.style.display = 'none';

        api.toast.success('API key generated successfully!');
      }
    } catch (err) {
      api.toast.error(err.message || 'Failed to generate API key');
    } finally {
      if (generateBtn) {
        generateBtn.disabled = false;
        generateBtn.textContent = 'Generate API Key';
      }
    }
  },

  async rotateKey() {
    if (!this.currentWallet) return;

    const confirmed = confirm('Generate a new API key? Your old key will stop working.');
    if (!confirmed) return;

    const rotateBtn = document.getElementById('rotate-key-btn');
    if (rotateBtn) rotateBtn.disabled = true;
    if (rotateBtn) rotateBtn.textContent = 'Rotating...';

    try {
      const timestamp = Date.now();
      const message = `CultScreener API Key: register for ${this.currentWallet} at ${timestamp}`;

      const sig = await wallet.signMessage(message);
      if (!sig || !sig.signature) {
        api.toast.error('Failed to sign message');
        return;
      }

      const response = await api.request('/api/keys/rotate', {
        method: 'POST',
        body: JSON.stringify({
          wallet: this.currentWallet,
          signature: sig.signature,
          signatureTimestamp: timestamp
        })
      });

      if (response.success && response.key) {
        this.currentKey = response.key;
        this.hideExistingKey();
        this.showKeyDisplay();
        api.toast.success('API key rotated successfully!');
      }
    } catch (err) {
      api.toast.error(err.message || 'Failed to rotate API key');
    } finally {
      if (rotateBtn) {
        rotateBtn.disabled = false;
        rotateBtn.textContent = 'Rotate Key';
      }
    }
  },

  async revokeKey() {
    if (!this.currentWallet) return;

    const confirmed = confirm('Revoke your API key? This action cannot be undone.');
    if (!confirmed) return;

    const revokeBtn = document.getElementById('revoke-key-btn');
    if (revokeBtn) revokeBtn.disabled = true;
    if (revokeBtn) revokeBtn.textContent = 'Revoking...';

    try {
      const timestamp = Date.now();
      const message = `CultScreener API Key: register for ${this.currentWallet} at ${timestamp}`;

      const sig = await wallet.signMessage(message);
      if (!sig || !sig.signature) {
        api.toast.error('Failed to sign message');
        return;
      }

      const response = await api.request('/api/keys/me', {
        method: 'DELETE',
        body: JSON.stringify({
          wallet: this.currentWallet,
          signature: sig.signature,
          signatureTimestamp: timestamp
        })
      });

      if (response.success) {
        this.currentKey = null;
        this.hideExistingKey();
        this.showNoKey();
        this.hideTesterAuthenticated();

        // Show tester not authenticated
        const testerNoAuth = document.getElementById('tester-not-authenticated');
        if (testerNoAuth) testerNoAuth.style.display = 'block';

        api.toast.success('API key revoked');
      }
    } catch (err) {
      api.toast.error(err.message || 'Failed to revoke API key');
    } finally {
      if (revokeBtn) {
        revokeBtn.disabled = false;
        revokeBtn.textContent = 'Revoke Key';
      }
    }
  },

  async loadExistingKey() {
    if (!this.currentWallet) return;

    try {
      const response = await api.request(`/api/keys/me?wallet=${encodeURIComponent(this.currentWallet)}`);

      if (response.found && response.prefix) {
        this.hideNoKey();
        this.hideKeyDisplay();
        this.showExistingKey(response);
        this.showTesterAuthenticated();

        // Hide tester not authenticated
        const testerNoAuth = document.getElementById('tester-not-authenticated');
        if (testerNoAuth) testerNoAuth.style.display = 'none';
      } else {
        this.hideExistingKey();
        this.showNoKey();
        this.hideTesterAuthenticated();

        // Show tester not authenticated
        const testerNoAuth = document.getElementById('tester-not-authenticated');
        if (testerNoAuth) testerNoAuth.style.display = 'block';
      }
    } catch (err) {
      console.error('Failed to load API key:', err);
      this.showNoKey();
    }
  },

  showExistingKey(keyInfo) {
    const existing = document.getElementById('existing-key');
    if (existing) existing.style.display = 'block';

    if (document.getElementById('key-prefix')) {
      document.getElementById('key-prefix').textContent = keyInfo.prefix || '-';
    }
    if (document.getElementById('key-created')) {
      document.getElementById('key-created').textContent = keyInfo.created_at
        ? new Date(keyInfo.created_at).toLocaleDateString()
        : '-';
    }
    if (document.getElementById('key-last-used')) {
      document.getElementById('key-last-used').textContent = keyInfo.last_used_at
        ? new Date(keyInfo.last_used_at).toLocaleString()
        : 'Never';
    }
    if (document.getElementById('key-requests')) {
      document.getElementById('key-requests').textContent = keyInfo.request_count || '0';
    }
  },

  hideExistingKey() {
    const existing = document.getElementById('existing-key');
    if (existing) existing.style.display = 'none';
  },

  showNoKey() {
    const noKey = document.getElementById('no-key');
    if (noKey) noKey.style.display = 'block';
  },

  hideNoKey() {
    const noKey = document.getElementById('no-key');
    if (noKey) noKey.style.display = 'none';
  },

  showKeyDisplay() {
    const display = document.getElementById('key-generated');
    const value = document.getElementById('new-key-value');
    if (display) display.style.display = 'block';
    if (value && this.currentKey) {
      value.textContent = this.currentKey;
    }
  },

  hideKeyDisplay() {
    const display = document.getElementById('key-generated');
    if (display) display.style.display = 'none';
    this.loadExistingKey();
  },

  copyKeyToClipboard() {
    if (!this.currentKey) return;

    navigator.clipboard.writeText(this.currentKey).then(() => {
      api.toast.success('API key copied to clipboard');
    }).catch(() => {
      api.toast.error('Failed to copy to clipboard');
    });
  },

  showTesterAuthenticated() {
    const auth = document.getElementById('tester-authenticated');
    if (auth) auth.style.display = 'block';
  },

  hideTesterAuthenticated() {
    const auth = document.getElementById('tester-authenticated');
    if (auth) auth.style.display = 'none';
  },

  switchTesterTab(tabName) {
    // Hide all tabs
    const contents = document.querySelectorAll('.tester-content');
    contents.forEach(c => c.classList.remove('active'));

    // Remove active from all buttons
    const tabs = document.querySelectorAll('.tester-tab');
    tabs.forEach(t => t.classList.remove('active'));

    // Show selected tab
    const selectedContent = document.getElementById(`tester-${tabName}`);
    if (selectedContent) selectedContent.classList.add('active');

    // Highlight selected button
    const selectedTab = document.querySelector(`[data-tab="${tabName}"]`);
    if (selectedTab) selectedTab.classList.add('active');
  },

  async testLeaderboard() {
    if (!this.currentKey) {
      api.toast.error('No API key available');
      return;
    }

    const limit = document.getElementById('lb-limit')?.value || 25;
    const offset = document.getElementById('lb-offset')?.value || 0;
    const minConviction = document.getElementById('lb-min-conviction')?.value;
    const minMcap = document.getElementById('lb-min-mcap')?.value;

    const btn = document.getElementById('test-leaderboard-btn');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Testing...';
    }

    try {
      const params = new URLSearchParams({
        limit: Math.min(parseInt(limit) || 25, 100),
        offset: Math.max(0, parseInt(offset) || 0)
      });
      if (minConviction) params.append('minConviction', parseFloat(minConviction));
      if (minMcap) params.append('minMcap', parseFloat(minMcap));

      const response = await fetch(
        `${this.apiBaseUrl}/v1/leaderboard?${params.toString()}`,
        {
          headers: { 'X-API-Key': this.currentKey }
        }
      );

      const data = await response.json();
      const responseEl = document.getElementById('lb-response');
      const contentEl = document.getElementById('lb-response-content');

      if (responseEl && contentEl) {
        responseEl.classList.remove('hidden', 'error', 'success');
        responseEl.classList.add(response.ok ? 'success' : 'error');
        contentEl.textContent = JSON.stringify(data, null, 2);
        responseEl.classList.remove('hidden');
      }
    } catch (err) {
      const responseEl = document.getElementById('lb-response');
      const contentEl = document.getElementById('lb-response-content');

      if (responseEl && contentEl) {
        responseEl.classList.remove('hidden');
        responseEl.classList.add('error');
        contentEl.textContent = `Error: ${err.message}`;
      }
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Test Leaderboard Endpoint';
      }
    }
  },

  async testToken() {
    if (!this.currentKey) {
      api.toast.error('No API key available');
      return;
    }

    const mint = document.getElementById('token-mint')?.value?.trim();
    if (!mint) {
      api.toast.error('Enter a token mint address');
      return;
    }

    const btn = document.getElementById('test-token-btn');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Testing...';
    }

    try {
      const response = await fetch(
        `${this.apiBaseUrl}/v1/leaderboard/${encodeURIComponent(mint)}`,
        {
          headers: { 'X-API-Key': this.currentKey }
        }
      );

      const data = await response.json();
      const responseEl = document.getElementById('token-response');
      const contentEl = document.getElementById('token-response-content');

      if (responseEl && contentEl) {
        responseEl.classList.remove('hidden', 'error', 'success');
        responseEl.classList.add(response.ok ? 'success' : 'error');
        contentEl.textContent = JSON.stringify(data, null, 2);
        responseEl.classList.remove('hidden');
      }
    } catch (err) {
      const responseEl = document.getElementById('token-response');
      const contentEl = document.getElementById('token-response-content');

      if (responseEl && contentEl) {
        responseEl.classList.remove('hidden');
        responseEl.classList.add('error');
        contentEl.textContent = `Error: ${err.message}`;
      }
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Get Token Conviction';
      }
    }
  }
};

// Initialize when page loads
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => apiKeysPage.init());
} else {
  apiKeysPage.init();
}
