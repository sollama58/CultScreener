// Wallet Connection Handler - Multi-Wallet Support with Cross-Tab Sync
const wallet = {
  connected: false,
  address: null,
  provider: null,
  providerName: null,
  initialized: false,

  // Supported wallets configuration
  // Order determines display priority in selection modal
  supportedWallets: [
    {
      name: 'Phantom',
      id: 'phantom',
      icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxMjgiIGhlaWdodD0iMTI4IiBmaWxsPSJub25lIj48Y2lyY2xlIGN4PSI2NCIgY3k9IjY0IiByPSI2NCIgZmlsbD0idXJsKCNhKSIvPjxwYXRoIGZpbGw9IiNmZmYiIGQ9Ik0xMTAuNSA2NC41Yy02LjQgMzIuNS0zMi41IDQ3LjUtNjIuNSA0Ny41LTEwLjQgMC0yMC45LTMuNS0yOC41LTEwLjUgMjEuMSAyLjEgNDYuOS04LjQgNTMuNS00MC41IDMuNS0xNy4xLTIuOS0zMC45LTE0LjUtMzcuNSAxNi45LTEuNyAzNy44IDcuOSA0MiAyOC41IDEuNSA3LjYgMSAxNSAwIDEyLjV6Ii8+PHBhdGggZmlsbD0iI2ZmZiIgZD0iTTc3LjUgNDFjLTEuNiA4LTYuNSAxNC41LTE0LjUgMTguNS03LjUgMy44LTE1LjMgNC4zLTIzIDIuNS04LjEtMi0xNC43LTYuOC0xOS0xNC41IDYuOCAyLjEgMTQuMyAyLjEgMjIuNS0uNSA4LjUtMi43IDE0LjctOC4yIDE4LTE2LjUgMy44LTkuNCAzLjItMTkuNS0yLTI4LjUgMTMuNiA2LjkgMjEuMyAyMC4xIDE4IDM5eiIvPjxkZWZzPjxsaW5lYXJHcmFkaWVudCBpZD0iYSIgeDE9IjY0IiB4Mj0iNjQiIHkxPSIwIiB5Mj0iMTI4IiBncmFkaWVudFVuaXRzPSJ1c2VyU3BhY2VPblVzZSI+PHN0b3Agc3RvcC1jb2xvcj0iIzUzNEJCMSIvPjxzdG9wIG9mZnNldD0iMSIgc3RvcC1jb2xvcj0iIzU1MURGNCIvPjwvbGluZWFyR3JhZGllbnQ+PC9kZWZzPjwvc3ZnPg==',
      getProvider: () => window.phantom?.solana || window.solana,
      isInstalled: () => !!(window.phantom?.solana?.isPhantom || window.solana?.isPhantom),
      downloadUrl: 'https://phantom.app/'
    },
    {
      name: 'Solflare',
      id: 'solflare',
      icon: 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTI4IiBoZWlnaHQ9IjEyOCIgdmlld0JveD0iMCAwIDEyOCAxMjgiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PGNpcmNsZSBjeD0iNjQiIGN5PSI2NCIgcj0iNjQiIGZpbGw9IiNGQzY4MUYiLz48cGF0aCBkPSJNOTIuNSA0Ni41TDY0IDgxLjVMMzUuNSA0Ni41SDkyLjVaIiBmaWxsPSJ3aGl0ZSIvPjwvc3ZnPg==',
      getProvider: () => window.solflare,
      isInstalled: () => !!window.solflare?.isSolflare,
      downloadUrl: 'https://solflare.com/'
    },
    {
      name: 'Backpack',
      id: 'backpack',
      icon: 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTI4IiBoZWlnaHQ9IjEyOCIgdmlld0JveD0iMCAwIDEyOCAxMjgiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PHJlY3Qgd2lkdGg9IjEyOCIgaGVpZ2h0PSIxMjgiIHJ4PSIyNCIgZmlsbD0iI0U0M0QzRCIvPjxwYXRoIGQ9Ik0zMiA0OEg5NlY4MEgzMlY0OFoiIGZpbGw9IndoaXRlIi8+PHBhdGggZD0iTTQ4IDMySDgwVjQ4SDQ4VjMyWiIgZmlsbD0id2hpdGUiLz48cGF0aCBkPSJNNDggODBIODBWOTZINDhWODBaIiBmaWxsPSJ3aGl0ZSIvPjwvc3ZnPg==',
      getProvider: () => window.backpack,
      isInstalled: () => !!window.backpack,
      downloadUrl: 'https://www.backpack.app/'
    },
    {
      name: 'Coinbase Wallet',
      id: 'coinbase',
      icon: 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTI4IiBoZWlnaHQ9IjEyOCIgdmlld0JveD0iMCAwIDEyOCAxMjgiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PGNpcmNsZSBjeD0iNjQiIGN5PSI2NCIgcj0iNjQiIGZpbGw9IiMwMDUyRkYiLz48cGF0aCBkPSJNNjQgMTZDMzcuNSAxNiAxNiAzNy41IDE2IDY0UzM3LjUgMTEyIDY0IDExMlMxMTIgOTAuNSAxMTIgNjRTOTAuNSAxNiA2NCAxNlpNNTIgNTJIMzJWNzZINTJWNTJaTTk2IDUySDc2Vjc2SDk2VjUyWiIgZmlsbD0id2hpdGUiLz48L3N2Zz4=',
      getProvider: () => window.coinbaseSolana,
      isInstalled: () => !!window.coinbaseSolana,
      downloadUrl: 'https://www.coinbase.com/wallet'
    },
    {
      name: 'Trust Wallet',
      id: 'trust',
      icon: 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTI4IiBoZWlnaHQ9IjEyOCIgdmlld0JveD0iMCAwIDEyOCAxMjgiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PGNpcmNsZSBjeD0iNjQiIGN5PSI2NCIgcj0iNjQiIGZpbGw9IiMzMzc1QkIiLz48cGF0aCBkPSJNNjQgMjRDNDQgMjQgMzIgNDAgMzIgNjRDMzIgODggNDQgMTA0IDY0IDEwNEM4NCAxMDQgOTYgODggOTYgNjRDOTYgNDAgODQgMjQgNjQgMjRaTTY0IDg4QzU2IDg4IDQ4IDgwIDQ4IDY0QzQ4IDQ4IDU2IDQwIDY0IDQwQzcyIDQwIDgwIDQ4IDgwIDY0QzgwIDgwIDcyIDg4IDY0IDg4WiIgZmlsbD0id2hpdGUiLz48L3N2Zz4=',
      getProvider: () => window.trustwallet?.solana,
      isInstalled: () => !!window.trustwallet?.solana,
      downloadUrl: 'https://trustwallet.com/'
    },
    {
      name: 'Brave Wallet',
      id: 'brave',
      icon: 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTI4IiBoZWlnaHQ9IjEyOCIgdmlld0JveD0iMCAwIDEyOCAxMjgiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PHJlY3Qgd2lkdGg9IjEyOCIgaGVpZ2h0PSIxMjgiIHJ4PSIyNCIgZmlsbD0iI0ZCNTQyQiIvPjxwYXRoIGQ9Ik02NCAxNkwzMiA0OFY4MEw2NCAxMTJMOTYgODBWNDhMNjQgMTZaIiBmaWxsPSJ3aGl0ZSIvPjwvc3ZnPg==',
      getProvider: () => window.braveSolana,
      isInstalled: () => !!window.braveSolana,
      downloadUrl: 'https://brave.com/wallet/'
    },
    {
      name: 'Exodus',
      id: 'exodus',
      icon: 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTI4IiBoZWlnaHQ9IjEyOCIgdmlld0JveD0iMCAwIDEyOCAxMjgiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PHJlY3Qgd2lkdGg9IjEyOCIgaGVpZ2h0PSIxMjgiIHJ4PSIyNCIgZmlsbD0iIzFEMUYyMSIvPjxwYXRoIGQ9Ik0yNCA2NEw2NCAyNEwxMDQgNjRMNjQgMTA0TDI0IDY0WiIgZmlsbD0idXJsKCNleG9kdXMtZ3JhZGllbnQpIi8+PGRlZnM+PGxpbmVhckdyYWRpZW50IGlkPSJleG9kdXMtZ3JhZGllbnQiIHgxPSIyNCIgeTE9IjI0IiB4Mj0iMTA0IiB5Mj0iMTA0IiBncmFkaWVudFVuaXRzPSJ1c2VyU3BhY2VPblVzZSI+PHN0b3Agc3RvcC1jb2xvcj0iIzhCNUNGNiIvPjxzdG9wIG9mZnNldD0iMSIgc3RvcC1jb2xvcj0iI0VDNDg5QSIvPjwvbGluZWFyR3JhZGllbnQ+PC9kZWZzPjwvc3ZnPg==',
      getProvider: () => window.exodus?.solana,
      isInstalled: () => !!window.exodus?.solana,
      downloadUrl: 'https://exodus.com/'
    }
  ],

  // BroadcastChannel for cross-tab communication
  broadcastChannel: null,

  // Get storage key (uses config if available, fallback for safety)
  _getStorageKey(key) {
    return (typeof config !== 'undefined' && config.storageKeys?.[key])
      ? config.storageKeys[key]
      : `cultscreener_${key}`;
  },

  // Get list of installed wallets
  getInstalledWallets() {
    return this.supportedWallets.filter(w => w.isInstalled());
  },

  // Get wallet config by ID
  getWalletById(id) {
    return this.supportedWallets.find(w => w.id === id);
  },

  // Get provider for a specific wallet
  getProviderFor(walletId) {
    const walletConfig = this.getWalletById(walletId);
    if (walletConfig && walletConfig.isInstalled()) {
      return walletConfig.getProvider();
    }
    return null;
  },

  // Show wallet selection modal
  showWalletSelector() {
    // Remove any existing modal
    const existingModal = document.querySelector('.wallet-selector-modal');
    if (existingModal) existingModal.remove();

    const installedWallets = this.getInstalledWallets();
    const notInstalledWallets = this.supportedWallets.filter(w => !w.isInstalled());

    const modal = document.createElement('div');
    modal.className = 'wallet-selector-modal';

    const overlay = document.createElement('div');
    overlay.className = 'wallet-selector-overlay';
    overlay.onclick = () => modal.remove();

    const content = document.createElement('div');
    content.className = 'wallet-selector-content';

    // Header
    const header = document.createElement('div');
    header.className = 'wallet-selector-header';

    const title = document.createElement('h3');
    title.textContent = 'Connect Wallet';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'wallet-selector-close';
    closeBtn.innerHTML = '&times;';
    closeBtn.onclick = () => modal.remove();

    header.appendChild(title);
    header.appendChild(closeBtn);
    content.appendChild(header);

    // Installed wallets section
    if (installedWallets.length > 0) {
      const installedSection = document.createElement('div');
      installedSection.className = 'wallet-selector-section';

      const installedLabel = document.createElement('p');
      installedLabel.className = 'wallet-selector-label';
      installedLabel.textContent = 'Detected Wallets';
      installedSection.appendChild(installedLabel);

      const walletList = document.createElement('div');
      walletList.className = 'wallet-selector-list';

      installedWallets.forEach(walletConfig => {
        const walletBtn = document.createElement('button');
        walletBtn.className = 'wallet-selector-item';
        walletBtn.onclick = async () => {
          walletBtn.disabled = true;
          walletBtn.classList.add('connecting');
          const success = await this.connectToWallet(walletConfig.id);
          if (success) {
            modal.remove();
          } else {
            walletBtn.disabled = false;
            walletBtn.classList.remove('connecting');
          }
        };

        const icon = document.createElement('img');
        icon.src = walletConfig.icon;
        icon.alt = walletConfig.name;
        icon.className = 'wallet-selector-icon';

        const name = document.createElement('span');
        name.className = 'wallet-selector-name';
        name.textContent = walletConfig.name;

        const status = document.createElement('span');
        status.className = 'wallet-selector-status';
        status.textContent = 'Detected';

        walletBtn.appendChild(icon);
        walletBtn.appendChild(name);
        walletBtn.appendChild(status);
        walletList.appendChild(walletBtn);
      });

      installedSection.appendChild(walletList);
      content.appendChild(installedSection);
    }

    // Not installed wallets section
    if (notInstalledWallets.length > 0) {
      const notInstalledSection = document.createElement('div');
      notInstalledSection.className = 'wallet-selector-section';

      const notInstalledLabel = document.createElement('p');
      notInstalledLabel.className = 'wallet-selector-label';
      notInstalledLabel.textContent = installedWallets.length > 0 ? 'Other Wallets' : 'Install a Wallet';
      notInstalledSection.appendChild(notInstalledLabel);

      const walletList = document.createElement('div');
      walletList.className = 'wallet-selector-list';

      // Show first 3 not installed, or all if none are installed
      const walletsToShow = installedWallets.length > 0
        ? notInstalledWallets.slice(0, 3)
        : notInstalledWallets;

      walletsToShow.forEach(walletConfig => {
        const walletBtn = document.createElement('button');
        walletBtn.className = 'wallet-selector-item not-installed';
        walletBtn.onclick = () => {
          window.open(walletConfig.downloadUrl, '_blank');
        };

        const icon = document.createElement('img');
        icon.src = walletConfig.icon;
        icon.alt = walletConfig.name;
        icon.className = 'wallet-selector-icon';

        const name = document.createElement('span');
        name.className = 'wallet-selector-name';
        name.textContent = walletConfig.name;

        const status = document.createElement('span');
        status.className = 'wallet-selector-status install';
        status.textContent = 'Install';

        walletBtn.appendChild(icon);
        walletBtn.appendChild(name);
        walletBtn.appendChild(status);
        walletList.appendChild(walletBtn);
      });

      notInstalledSection.appendChild(walletList);
      content.appendChild(notInstalledSection);
    }

    // No wallets detected message
    if (installedWallets.length === 0) {
      const isMobile = typeof utils !== 'undefined' && (utils.isMobile() || utils.isTouchDevice());

      if (isMobile) {
        const mobileSection = document.createElement('div');
        mobileSection.className = 'wallet-selector-section';
        mobileSection.style.cssText = 'padding: 0.75rem 0;';

        const mobileTitle = document.createElement('h4');
        mobileTitle.style.cssText = 'color: var(--text-primary); margin-bottom: 0.5rem; font-size: 0.95rem;';
        mobileTitle.textContent = 'Open in Wallet Browser';

        const mobileDesc = document.createElement('p');
        mobileDesc.style.cssText = 'color: var(--text-secondary); font-size: 0.85rem; margin-bottom: 0.75rem; line-height: 1.4;';
        mobileDesc.textContent = 'Open your wallet app (Phantom, Solflare, etc.) and use its built-in browser to visit this page.';

        mobileSection.appendChild(mobileTitle);
        mobileSection.appendChild(mobileDesc);

        const urlContainer = document.createElement('div');
        urlContainer.style.cssText = 'display: flex; align-items: center; gap: 0.5rem;';

        const urlInput = document.createElement('input');
        urlInput.type = 'text';
        urlInput.readOnly = true;
        urlInput.value = window.location.href;
        urlInput.style.cssText = 'flex: 1; padding: 0.5rem 0.75rem; border: 1px solid var(--border-color); border-radius: 6px; background: var(--bg-secondary); color: var(--text-primary); font-size: 0.8rem; outline: none; min-width: 0;';

        const copyBtn = document.createElement('button');
        copyBtn.style.cssText = 'padding: 0.5rem 0.75rem; border: 1px solid var(--border-color); border-radius: 6px; background: var(--accent-primary); color: #fff; font-size: 0.8rem; cursor: pointer; white-space: nowrap; flex-shrink: 0;';
        copyBtn.textContent = 'Copy URL';
        copyBtn.onclick = async () => {
          try {
            await navigator.clipboard.writeText(window.location.href);
            copyBtn.textContent = 'Copied!';
            setTimeout(() => { copyBtn.textContent = 'Copy URL'; }, 2000);
          } catch (_) {
            urlInput.select();
            document.execCommand('copy');
            copyBtn.textContent = 'Copied!';
            setTimeout(() => { copyBtn.textContent = 'Copy URL'; }, 2000);
          }
        };

        urlContainer.appendChild(urlInput);
        urlContainer.appendChild(copyBtn);
        mobileSection.appendChild(urlContainer);
        content.appendChild(mobileSection);
      } else {
        const helpText = document.createElement('p');
        helpText.className = 'wallet-selector-help';
        helpText.textContent = 'No Solana wallet detected. Install one of the wallets above to continue.';
        content.appendChild(helpText);
      }
    }

    modal.appendChild(overlay);
    modal.appendChild(content);
    document.body.appendChild(modal);

    // Focus trap for accessibility
    content.setAttribute('tabindex', '-1');
    content.focus();
  },

  // Connect to a specific wallet
  async connectToWallet(walletId) {
    const walletConfig = this.getWalletById(walletId);
    if (!walletConfig) {
      console.error('Unknown wallet:', walletId);
      return false;
    }

    const provider = walletConfig.getProvider();
    if (!provider) {
      console.error('Wallet not available:', walletId);
      if (typeof toast !== 'undefined') {
        toast.error(`${walletConfig.name} is not installed`);
      }
      return false;
    }

    try {
      const response = await provider.connect();
      this.connected = true;
      this.address = response.publicKey.toString();
      this.provider = provider;
      this.providerName = walletId;

      // Set up disconnect/accountChanged listeners for this provider
      this.setupWalletListeners(provider, walletId);

      this.updateUI();
      this.saveConnection();
      this.broadcastConnectionChange('connected');

      // Emit connection event
      window.dispatchEvent(new CustomEvent('walletConnected', {
        detail: { address: this.address, wallet: walletId }
      }));

      if (typeof toast !== 'undefined') {
        toast.success(`Connected to ${walletConfig.name}`);
      }

      return true;
    } catch (error) {
      console.error('Wallet connection error:', error.message);
      if (error.code === 4001 || error.message?.includes('User rejected')) {
        if (typeof toast !== 'undefined') {
          toast.warning('Connection cancelled');
        }
      } else {
        if (typeof toast !== 'undefined') {
          toast.error('Failed to connect wallet');
        }
      }
      return false;
    }
  },

  // Connect (shows wallet selector)
  async connect() {
    const installedWallets = this.getInstalledWallets();

    // If only one wallet is installed, connect directly
    if (installedWallets.length === 1) {
      return this.connectToWallet(installedWallets[0].id);
    }

    // Otherwise show selector
    this.showWalletSelector();
    return false; // Connection happens asynchronously via modal
  },

  // Disconnect wallet
  async disconnect() {
    if (this.provider) {
      try {
        await this.provider.disconnect();
      } catch (error) {
        console.error('Disconnect error:', error.message);
      }
    }

    const wasConnected = this.connected;
    this.connected = false;
    this.address = null;
    this.provider = null;
    this.providerName = null;

    this.updateUI();
    this.clearConnection();

    if (wasConnected) {
      this.broadcastConnectionChange('disconnected');
    }

    window.dispatchEvent(new CustomEvent('walletDisconnected'));

    if (wasConnected && typeof toast !== 'undefined') {
      toast.info('Wallet disconnected');
    }
  },

  // Sign message (for vote/submission verification)
  async signMessage(message) {
    if (!this.connected || !this.provider) {
      throw new Error('Wallet not connected');
    }

    const encodedMessage = new TextEncoder().encode(message);

    try {
      const { signature } = await this.provider.signMessage(encodedMessage, 'utf8');
      return {
        signature: Array.from(signature),
        address: this.address
      };
    } catch (error) {
      console.error('Sign message error:', error.message);
      if (error.code === 4001 || error.message?.includes('User rejected')) {
        throw new Error('Signature request was cancelled');
      }
      throw error;
    }
  },

  // Update UI elements
  updateUI() {
    // Header connect button
    const connectBtn = document.getElementById('connect-wallet');
    if (connectBtn) {
      if (this.connected) {
        connectBtn.innerHTML = '';

        const walletConfig = this.getWalletById(this.providerName);
        if (walletConfig) {
          const icon = document.createElement('img');
          icon.src = walletConfig.icon;
          icon.alt = walletConfig.name;
          icon.className = 'wallet-btn-icon';
          connectBtn.appendChild(icon);
        }

        const addressSpan = document.createElement('span');
        addressSpan.textContent = utils.truncateAddress(this.address);
        connectBtn.appendChild(addressSpan);

        connectBtn.classList.add('connected');
        connectBtn.onclick = () => this.showWalletMenu();
      } else {
        connectBtn.innerHTML = `
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="2" y="5" width="20" height="14" rx="2"/>
            <path d="M16 14a2 2 0 100-4 2 2 0 000 4z"/>
          </svg>
          Connect Wallet
        `;
        connectBtn.classList.remove('connected');
        connectBtn.onclick = () => this.connect();
      }
    }

  },

  // Show wallet menu (connected state)
  showWalletMenu() {
    // Remove any existing menu
    const existingMenu = document.querySelector('.wallet-menu');
    if (existingMenu) existingMenu.remove();

    const menu = document.createElement('div');
    menu.className = 'wallet-menu';

    const overlay = document.createElement('div');
    overlay.className = 'wallet-menu-overlay';
    overlay.onclick = () => menu.remove();

    const content = document.createElement('div');
    content.className = 'wallet-menu-content';

    // Header with wallet info
    const header = document.createElement('div');
    header.className = 'wallet-menu-header';

    const walletConfig = this.getWalletById(this.providerName);
    const walletInfo = document.createElement('div');
    walletInfo.className = 'wallet-menu-info';

    if (walletConfig) {
      const icon = document.createElement('img');
      icon.src = walletConfig.icon;
      icon.alt = walletConfig.name;
      icon.className = 'wallet-menu-icon';

      const walletName = document.createElement('span');
      walletName.className = 'wallet-menu-name';
      walletName.textContent = walletConfig.name;

      walletInfo.appendChild(icon);
      walletInfo.appendChild(walletName);
      header.appendChild(walletInfo);
    }

    content.appendChild(header);

    // Address
    const addressP = document.createElement('p');
    addressP.className = 'wallet-address';
    addressP.textContent = this.address;
    content.appendChild(addressP);

    // Actions
    const actions = document.createElement('div');
    actions.className = 'wallet-menu-actions';

    const copyBtn = document.createElement('button');
    copyBtn.className = 'btn btn-secondary';
    copyBtn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
      </svg>
      Copy Address
    `;
    copyBtn.onclick = async () => {
      const copied = await utils.copyToClipboard(this.address);
      if (copied) {
        copyBtn.innerHTML = `
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
          Copied!
        `;
        setTimeout(() => {
          copyBtn.innerHTML = `
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
            </svg>
            Copy Address
          `;
        }, 2000);
      }
    };

    const viewBtn = document.createElement('button');
    viewBtn.className = 'btn btn-secondary';
    viewBtn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
        <polyline points="15 3 21 3 21 9"/>
        <line x1="10" y1="14" x2="21" y2="3"/>
      </svg>
      View on Solscan
    `;
    viewBtn.onclick = () => {
      window.open(`https://solscan.io/account/${this.address}`, '_blank');
    };

    const disconnectBtn = document.createElement('button');
    disconnectBtn.className = 'btn btn-danger';
    disconnectBtn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
        <polyline points="16 17 21 12 16 7"/>
        <line x1="21" y1="12" x2="9" y2="12"/>
      </svg>
      Disconnect
    `;
    disconnectBtn.onclick = () => {
      this.disconnect();
      menu.remove();
    };

    actions.appendChild(copyBtn);
    actions.appendChild(viewBtn);
    actions.appendChild(disconnectBtn);
    content.appendChild(actions);

    menu.appendChild(overlay);
    menu.appendChild(content);
    document.body.appendChild(menu);
  },

  // Save connection to sessionStorage (privacy-conscious: cleared on browser close)
  // Note: Using sessionStorage instead of localStorage for better privacy
  saveConnection() {
    if (this.connected && this.address && this.providerName) {
      const connectionData = {
        connected: true,
        address: this.address,
        wallet: this.providerName,
        timestamp: Date.now()
      };
      sessionStorage.setItem(this._getStorageKey('walletConnection'), JSON.stringify(connectionData));
    }
    // Clear any legacy localStorage data for privacy
    this._clearLegacyStorage();
  },

  // Clear saved connection
  clearConnection() {
    sessionStorage.removeItem(this._getStorageKey('walletConnection'));
    this._clearLegacyStorage();
  },

  // Clear legacy localStorage data (migration from old version)
  _clearLegacyStorage() {
    try {
      localStorage.removeItem(this._getStorageKey('walletConnection'));
      localStorage.removeItem(this._getStorageKey('walletConnected'));
      localStorage.removeItem(this._getStorageKey('walletAddress'));
    } catch (e) {
      // Ignore errors - localStorage may not be available
    }
  },

  // Load saved connection from sessionStorage
  loadSavedConnection() {
    try {
      // First, migrate any legacy localStorage data to sessionStorage then clear it
      this._clearLegacyStorage();

      const saved = sessionStorage.getItem(this._getStorageKey('walletConnection'));
      if (saved) {
        return JSON.parse(saved);
      }
    } catch (e) {
      // Silent fail - don't log sensitive data
    }
    return null;
  },

  // Initialize BroadcastChannel for cross-tab sync
  initBroadcastChannel() {
    if (typeof BroadcastChannel === 'undefined') {
      // Cross-tab sync unavailable on older browsers without BroadcastChannel.
      // Note: sessionStorage doesn't fire 'storage' events across tabs, so no fallback is possible.
      return;
    }

    try {
      this.broadcastChannel = new BroadcastChannel('cultscreener_wallet_sync');
      this.broadcastChannel.onmessage = (event) => {
        this.handleBroadcastMessage(event.data);
      };
    } catch (e) {
      console.warn('BroadcastChannel not available:', e);
    }
  },

  // Broadcast connection change to other tabs
  // Privacy: Only broadcast connection status, not full wallet address
  broadcastConnectionChange(action) {
    const message = {
      action,
      // Use truncated address for cross-tab sync (privacy-conscious)
      addressHint: this.address ? `${this.address.slice(0, 4)}...${this.address.slice(-4)}` : null,
      wallet: this.providerName,
      timestamp: Date.now()
    };

    if (this.broadcastChannel) {
      try {
        this.broadcastChannel.postMessage(message);
      } catch (e) {
        // Silent fail - don't log broadcast errors
      }
    }
  },

  // Handle broadcast message from other tabs
  // Privacy: Now only receives addressHint (truncated), not full address
  handleBroadcastMessage(data) {
    if (!data || !data.action) return;

    if (data.action === 'connected' && data.wallet) {
      // Another tab connected - try to reconnect with same wallet
      // We no longer receive full address for privacy, so just trigger reconnect
      if (!this.connected) {
        this.silentReconnect(data.wallet);
      }
    } else if (data.action === 'disconnected') {
      // Another tab disconnected
      if (this.connected) {
        this.silentDisconnect();
      }
    }
  },

  // Handle storage change (fallback for BroadcastChannel)
  // Privacy: sessionStorage doesn't fire storage events across tabs,
  // but keeping for backwards compatibility
  handleStorageChange(newValue) {
    if (!newValue) {
      // Connection was cleared
      if (this.connected) {
        this.silentDisconnect();
      }
      return;
    }

    try {
      const data = JSON.parse(newValue);
      if (data.connected && data.wallet) {
        if (!this.connected) {
          this.silentReconnect(data.wallet);
        }
      }
    } catch (e) {
      // Silent fail - don't log parse errors
    }
  },

  // Silent reconnect (from another tab's connection)
  // onlyIfTrusted ensures the wallet only connects if the user already approved this site
  async silentReconnect(walletId) {
    const provider = this.getProviderFor(walletId);
    if (!provider) return;

    try {
      // Check if provider is already connected
      if (provider.isConnected && provider.publicKey) {
        const currentAddress = provider.publicKey.toString();
        this.connected = true;
        this.address = currentAddress;
        this.provider = provider;
        this.providerName = walletId;
        this.updateUI();
        return;
      }

      // Try silent connect (some wallets support this)
      if (provider.connect) {
        const response = await provider.connect({ onlyIfTrusted: true });
        this.connected = true;
        this.address = response.publicKey.toString();
        this.provider = provider;
        this.providerName = walletId;
        this.updateUI();
      }
    } catch (e) {
      // Silent connect failed - that's ok, user will need to manually connect
    }
  },

  // Silent disconnect (from another tab's disconnection)
  silentDisconnect() {
    this.connected = false;
    this.address = null;
    this.provider = null;
    this.providerName = null;
    this.updateUI();
    window.dispatchEvent(new CustomEvent('walletDisconnected'));
  },

  // Auto-reconnect on page load
  async autoConnect() {
    const savedConnection = this.loadSavedConnection();
    if (!savedConnection || !savedConnection.connected) return;

    // If we know which wallet was used, try to reconnect
    if (savedConnection.wallet) {
      const provider = this.getProviderFor(savedConnection.wallet);
      if (provider) {
        try {
          // Try silent connect first (doesn't prompt user)
          if (provider.connect) {
            const response = await provider.connect({ onlyIfTrusted: true });
            this.connected = true;
            this.address = response.publicKey.toString();
            this.provider = provider;
            this.providerName = savedConnection.wallet;
            this.updateUI();

            // Verify address matches
            if (this.address !== savedConnection.address) {
              // Address changed - update storage
              this.saveConnection();
              this.broadcastConnectionChange('connected');
            }

            // Dispatch walletConnected so page-level listeners can react
            window.dispatchEvent(new CustomEvent('walletConnected', {
              detail: { address: this.address, wallet: savedConnection.wallet }
            }));
            return;
          }
        } catch (e) {
          // Silent connect failed - normal if user hasn't approved this site recently
          if (typeof config !== 'undefined' && config.app?.debug) console.log('Auto-connect failed:', e.message);
        }
      }
    }

    // Fallback: Check all installed wallets
    for (const walletConfig of this.getInstalledWallets()) {
      const provider = walletConfig.getProvider();
      if (provider && provider.isConnected && provider.publicKey) {
        this.connected = true;
        this.address = provider.publicKey.toString();
        this.provider = provider;
        this.providerName = walletConfig.id;
        this.updateUI();
        this.saveConnection();

        // Dispatch walletConnected so page-level listeners can react
        window.dispatchEvent(new CustomEvent('walletConnected', {
          detail: { address: this.address, wallet: walletConfig.id }
        }));
        return;
      }
    }
  },

  // Set up wallet event listeners
  setupWalletListeners(provider, walletId) {
    if (!provider || !provider.on) return;

    // Remove existing listeners to prevent duplicates
    try {
      provider.removeAllListeners?.();
    } catch (e) {
      // Some wallets don't support removeAllListeners
    }

    provider.on('connect', () => {
      if (provider.publicKey) {
        this.connected = true;
        this.address = provider.publicKey.toString();
        this.provider = provider;
        this.providerName = walletId;
        this.updateUI();
        this.saveConnection();
        this.broadcastConnectionChange('connected');
      }
    });

    provider.on('disconnect', () => {
      this.connected = false;
      this.address = null;
      this.provider = null;
      this.providerName = null;
      this.updateUI();
      this.clearConnection();
      this.broadcastConnectionChange('disconnected');
      window.dispatchEvent(new CustomEvent('walletDisconnected'));
    });

    provider.on('accountChanged', (publicKey) => {
      if (publicKey) {
        this.address = publicKey.toString();
        this.updateUI();
        this.saveConnection();
        this.broadcastConnectionChange('connected');
        window.dispatchEvent(new CustomEvent('walletConnected', {
          detail: { address: this.address, wallet: walletId }
        }));
      } else {
        this.disconnect();
      }
    });
  },

  // Initialize
  async init() {
    // Initialize cross-tab sync
    this.initBroadcastChannel();

    // Set up connect button
    const connectBtn = document.getElementById('connect-wallet');
    if (connectBtn) {
      connectBtn.onclick = () => this.connect();
    }

    // Set up secondary connect buttons (submit page)
    const connectBtnMain = document.getElementById('connect-wallet-main');
    if (connectBtnMain) {
      connectBtnMain.onclick = () => this.connect();
    }

    const connectBtnSubmissions = document.getElementById('connect-wallet-submissions');
    if (connectBtnSubmissions) {
      connectBtnSubmissions.onclick = () => this.connect();
    }

    const disconnectBtn = document.getElementById('disconnect-wallet-btn');
    if (disconnectBtn) {
      disconnectBtn.onclick = () => this.disconnect();
    }

    // Set up listeners for all installed wallets
    for (const walletConfig of this.getInstalledWallets()) {
      const provider = walletConfig.getProvider();
      if (provider) {
        this.setupWalletListeners(provider, walletConfig.id);
      }
    }

    // Try auto-connect (await it!)
    await this.autoConnect();

    // Mark as initialized and emit ready event
    this.initialized = true;
    window.dispatchEvent(new CustomEvent('walletReady', {
      detail: { connected: this.connected, address: this.address }
    }));

    // Inject wallet selector styles
    this.injectStyles();
  },

  // Inject CSS for wallet selector
  injectStyles() {
    if (document.getElementById('cultscreener-wallet-styles')) return;

    const style = document.createElement('style');
    style.id = 'cultscreener-wallet-styles';
    style.textContent = `
      /* Wallet Button Icon */
      .wallet-btn-icon {
        width: 20px;
        height: 20px;
        border-radius: 4px;
        margin-right: 0.5rem;
      }

      /* Wallet Selector Modal */
      .wallet-selector-modal {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        z-index: 10000;
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .wallet-selector-overlay {
        position: absolute;
        inset: 0;
        background: rgba(0, 0, 0, 0.7);
        backdrop-filter: blur(4px);
      }

      .wallet-selector-content {
        position: relative;
        background: var(--bg-secondary);
        border: 1px solid var(--border-color);
        border-radius: var(--radius-lg);
        padding: 1.5rem;
        min-width: 360px;
        max-width: 90vw;
        max-height: 90vh;
        overflow-y: auto;
        animation: slideUp 0.2s ease;
      }

      .wallet-selector-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 1.5rem;
      }

      .wallet-selector-header h3 {
        margin: 0;
        font-size: 1.25rem;
        font-weight: 600;
      }

      .wallet-selector-close {
        background: none;
        border: none;
        color: var(--text-muted);
        cursor: pointer;
        font-size: 1.5rem;
        line-height: 1;
        padding: 0.25rem;
        border-radius: var(--radius-sm);
        transition: color 0.2s, background 0.2s;
      }

      .wallet-selector-close:hover {
        color: var(--text-primary);
        background: var(--bg-tertiary);
      }

      .wallet-selector-section {
        margin-bottom: 1.5rem;
      }

      .wallet-selector-section:last-child {
        margin-bottom: 0;
      }

      .wallet-selector-label {
        font-size: 0.75rem;
        font-weight: 500;
        color: var(--text-muted);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        margin-bottom: 0.75rem;
      }

      .wallet-selector-list {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
      }

      .wallet-selector-item {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        width: 100%;
        padding: 0.875rem 1rem;
        background: var(--bg-tertiary);
        border: 1px solid var(--border-color);
        border-radius: var(--radius-md);
        cursor: pointer;
        transition: all 0.2s;
        text-align: left;
      }

      .wallet-selector-item:hover {
        background: var(--bg-primary);
        border-color: var(--accent-primary);
      }

      .wallet-selector-item:disabled {
        opacity: 0.7;
        cursor: wait;
      }

      .wallet-selector-item.connecting {
        border-color: var(--accent-primary);
      }

      .wallet-selector-item.connecting .wallet-selector-status {
        color: var(--accent-primary);
      }

      .wallet-selector-item.connecting .wallet-selector-status::after {
        content: '...';
        animation: dots 1.5s infinite;
      }

      @keyframes dots {
        0%, 20% { content: '.'; }
        40% { content: '..'; }
        60%, 100% { content: '...'; }
      }

      .wallet-selector-item.not-installed {
        opacity: 0.7;
      }

      .wallet-selector-item.not-installed:hover {
        opacity: 1;
      }

      .wallet-selector-icon {
        width: 40px;
        height: 40px;
        border-radius: 8px;
        flex-shrink: 0;
      }

      .wallet-selector-name {
        flex: 1;
        font-size: 1rem;
        font-weight: 500;
        color: var(--text-primary);
      }

      .wallet-selector-status {
        font-size: 0.75rem;
        color: var(--green);
        font-weight: 500;
      }

      .wallet-selector-status.install {
        color: var(--accent-primary);
      }

      .wallet-selector-help {
        font-size: 0.875rem;
        color: var(--text-muted);
        text-align: center;
        padding: 1rem;
        background: var(--bg-tertiary);
        border-radius: var(--radius-md);
        margin-top: 1rem;
      }

      /* Wallet Menu Improvements */
      .wallet-menu-header {
        margin-bottom: 1rem;
      }

      .wallet-menu-info {
        display: flex;
        align-items: center;
        gap: 0.75rem;
      }

      .wallet-menu-icon {
        width: 32px;
        height: 32px;
        border-radius: 8px;
      }

      .wallet-menu-name {
        font-weight: 500;
        color: var(--text-primary);
      }

      .wallet-menu-actions {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        margin-top: 1rem;
      }

      .wallet-menu-actions .btn {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 0.5rem;
      }

      .btn-danger {
        background: rgba(239, 68, 68, 0.1);
        color: var(--red);
        border-color: var(--red);
      }

      .btn-danger:hover {
        background: rgba(239, 68, 68, 0.2);
      }

      /* Connected button styling */
      #connect-wallet.connected {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        background: var(--bg-tertiary);
        border-color: var(--border-color);
      }

      #connect-wallet.connected:hover {
        background: var(--bg-secondary);
        border-color: var(--accent-primary);
      }

      /* Responsive */
      @media (max-width: 480px) {
        .wallet-selector-content {
          min-width: auto;
          width: calc(100vw - 2rem);
          margin: 1rem;
        }

        .wallet-selector-icon {
          width: 32px;
          height: 32px;
        }

        .wallet-selector-item {
          padding: 0.75rem;
        }
      }
    `;
    document.head.appendChild(style);
  }
};

// Initialize wallet on DOM load
document.addEventListener('DOMContentLoaded', () => {
  // Initialize mobile optimizations (runs once globally)
  if (typeof utils !== 'undefined' && utils.initMobileOptimizations && !window._mobileOptimized) {
    utils.initMobileOptimizations();
    window._mobileOptimized = true;
  }
  wallet.init();
});
