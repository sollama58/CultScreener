/* CultScreener Admin Panel */

const admin = {
  activeTab: 'dashboard',
  _boundTabs: false,

  init() {
    this.bindLogin();
    this.bindTabs();
    this.bindCuratedActions();
    this.bindAnnouncementActions();
    this.bindFilterActions();
    this.bindMaintenanceActions();
    this.bindWhitelistActions();
    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) logoutBtn.addEventListener('click', () => this.logout());

    // Always attempt session verification — the httpOnly cookie is sent automatically
    this.verifySession();
  },

  // ── Auth ──────────────────────────────────────

  bindLogin() {
    const btn = document.getElementById('login-btn');
    const input = document.getElementById('login-password');
    btn.addEventListener('click', () => this.login());
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.login(); });
  },

  async login() {
    const input = document.getElementById('login-password');
    const errEl = document.getElementById('login-error');
    const btn = document.getElementById('login-btn');
    const password = input.value.trim();
    if (!password) return;

    errEl.style.display = 'none';
    btn.disabled = true;
    btn.textContent = 'Signing in...';
    try {
      const data = await this.request('/api/admin/login', {
        method: 'POST',
        body: JSON.stringify({ password }),
        noAuth: true
      });
      input.value = '';
      this.showPanel();
      this.loadTab('dashboard');
    } catch (err) {
      errEl.textContent = err.message || 'Login failed';
      errEl.style.display = 'block';
    } finally {
      btn.disabled = false;
      btn.textContent = 'Sign In';
    }
  },

  async logout() {
    try { await this.request('/api/admin/logout', { method: 'POST' }); } catch (_) {}
    this.showLogin();
  },

  async verifySession() {
    try {
      await this.request('/api/admin/stats');
      this.showPanel();
      this.loadTab('dashboard');
    } catch {
      this.showLogin();
    }
  },

  showLogin() {
    document.getElementById('login-section').style.display = 'flex';
    document.getElementById('admin-panel').style.display = 'none';
    setTimeout(() => document.getElementById('login-password').focus(), 100);
  },

  showPanel() {
    document.getElementById('login-section').style.display = 'none';
    document.getElementById('admin-panel').style.display = 'block';
  },

  // ── Request helper ────────────────────────────

  async request(endpoint, opts = {}) {
    const url = config.api.baseUrl + endpoint;
    const headers = { 'Content-Type': 'application/json' };
    const res = await fetch(url, {
      method: opts.method || 'GET',
      headers,
      body: opts.body || undefined,
      credentials: 'include', // sends the httpOnly admin_session cookie automatically
      cache: 'no-store'
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401 && !opts.noAuth) {
        this.showLogin();
      }
      const err = new Error(data.error || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  },

  // ── Tabs ──────────────────────────────────────

  bindTabs() {
    document.querySelectorAll('.admin-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        const name = tab.dataset.tab;
        if (name === this.activeTab) return;
        document.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
        const panel = document.getElementById(`tab-${name}`);
        if (panel) panel.classList.add('active');
        this.activeTab = name;
        this.loadTab(name);
      });
    });
  },

  loadTab(name) {
    switch (name) {
      case 'dashboard': this.loadStats(); break;
      case 'curated': this.loadCurated(); break;
      case 'announcements': this.loadAnnouncements(); break;
      case 'bugs': this.loadBugReports(); break;
      case 'submissions': this.loadSubmissions(); break;
      case 'whitelist': this.loadWhitelist(); break;
      case 'health': this.loadHealth(); break;
    }
  },

  // ── One-time action bindings ──────────────────
  // These are bound once at init, not re-bound on every tab load

  bindCuratedActions() {
    const addBtn = document.getElementById('curated-add-btn');
    const refreshBtn = document.getElementById('curated-refresh-btn');
    const mintInput = document.getElementById('curated-mint-input');
    if (addBtn) addBtn.addEventListener('click', () => this.addCuratedToken());
    if (refreshBtn) refreshBtn.addEventListener('click', () => this.refreshAllCurated());
    if (mintInput) mintInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.addCuratedToken();
    });
  },

  bindAnnouncementActions() {
    const btn = document.getElementById('ann-create-btn');
    if (btn) btn.addEventListener('click', () => this.createAnnouncement());
  },

  bindFilterActions() {
    const bugsFilter = document.getElementById('bugs-status-filter');
    const subsFilter = document.getElementById('subs-status-filter');
    if (bugsFilter) bugsFilter.addEventListener('change', () => this.loadBugReports());
    if (subsFilter) subsFilter.addEventListener('change', () => this.loadSubmissions());
  },

  bindMaintenanceActions() {
    const flushBtn = document.getElementById('admin-flush-wallets');
    const refreshBtn = document.getElementById('admin-refresh-holders');
    const wipeBtn = document.getElementById('admin-wipe-token');
    if (flushBtn) flushBtn.addEventListener('click', () => this.flushFailedWallets());
    if (refreshBtn) refreshBtn.addEventListener('click', () => this.refreshHolderCounts());
    if (wipeBtn) wipeBtn.addEventListener('click', () => this.wipeTokenCache());
  },

  async flushFailedWallets() {
    const btn = document.getElementById('admin-flush-wallets');
    const status = document.getElementById('admin-flush-status');
    btn.disabled = true;
    btn.textContent = 'Flushing...';
    status.textContent = '';

    try {
      const data = await this.request('/api/admin/flush-failed-wallets', { method: 'POST' });
      status.textContent = `Done: ${data.flushed} failed entries cleared (${data.scanned} scanned). Next conviction refresh will re-attempt.`;
      status.style.color = 'var(--green)';
      if (typeof toast !== 'undefined') toast.success(`Flushed ${data.flushed} failed wallet caches`);
    } catch (err) {
      status.textContent = `Error: ${err.message}`;
      status.style.color = 'var(--red)';
      if (typeof toast !== 'undefined') toast.error(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Flush Failed Wallet Caches';
    }
  },

  async refreshHolderCounts() {
    const btn = document.getElementById('admin-refresh-holders');
    const status = document.getElementById('admin-flush-status');
    btn.disabled = true;
    btn.textContent = 'Refreshing...';
    status.textContent = '';

    try {
      const data = await this.request('/api/admin/refresh-holder-counts', { method: 'POST' });
      status.textContent = `Done: ${data.updated} updated, ${data.failed} failed out of ${data.total} tokens.`;
      status.style.color = 'var(--green)';
      if (typeof toast !== 'undefined') toast.success(`Refreshed ${data.updated} holder counts`);
    } catch (err) {
      status.textContent = `Error: ${err.message}`;
      status.style.color = 'var(--red)';
      if (typeof toast !== 'undefined') toast.error(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Refresh All Holder Counts';
    }
  },

  async wipeTokenCache() {
    const btn = document.getElementById('admin-wipe-token');
    const input = document.getElementById('wipe-mint-input');
    const status = document.getElementById('admin-wipe-status');
    const mint = input.value.trim();

    if (!mint || mint.length < 32 || mint.length > 44) {
      status.textContent = 'Please enter a valid mint address (32-44 characters).';
      status.style.color = 'var(--red)';
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Wiping...';
    status.textContent = '';

    try {
      const data = await this.request('/api/admin/wipe-token-cache', {
        method: 'POST',
        body: JSON.stringify({ mint })
      });
      status.textContent = `Done: ${data.deleted} cache entries wiped for ${data.mint.slice(0, 8)}...`;
      status.style.color = 'var(--green)';
      input.value = '';
      if (typeof toast !== 'undefined') toast.success(`Wiped ${data.deleted} cache entries for token`);
    } catch (err) {
      status.textContent = `Error: ${err.message}`;
      status.style.color = 'var(--red)';
      if (typeof toast !== 'undefined') toast.error(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Wipe Cache';
    }
  },

  // ── Dashboard ─────────────────────────────────

  async loadStats() {
    try {
      const s = await this.request('/api/admin/stats');
      this.setText('stat-tokens', s.tokens);
      this.setText('stat-watchlist', s.watchlistEntries);
      this.setText('stat-votes', s.votes);
      this.setText('stat-pending', s.submissions?.pending);
      this.setText('stat-approved', s.submissions?.approved);
      this.setText('stat-bugs', s.bugReports);
      this.setText('stat-recent-subs', s.recentSubmissions);
      this.setText('stat-recent-votes', s.recentVotes);
    } catch (err) {
      console.error('Stats load error:', err.message);
    }
  },

  // ── Curated Tokens ────────────────────────────

  async loadCurated() {
    const tbody = document.getElementById('curated-table-body');
    tbody.innerHTML = '<tr><td colspan="5" class="empty-msg">Loading...</td></tr>';
    try {
      const data = await this.request('/api/admin/curated');
      const tokens = data.tokens || [];
      if (tokens.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty-msg">No curated tokens yet. Add one above.</td></tr>';
        return;
      }
      tbody.innerHTML = tokens.map(t => {
        const mint = this.esc(t.mintAddress || '');
        const name = this.esc(t.name || t.symbol || '');
        const displayName = name || `${mint.slice(0, 6)}...${mint.slice(-4)}`;
        const socials = t.socials || {};
        const socialLinks = Object.entries(socials).filter(([, v]) => v).map(([k]) => k).join(', ') || '--';
        const added = t.addedAt ? new Date(t.addedAt).toLocaleDateString() : '--';
        return `<tr>
          <td title="${name}">${displayName}</td>
          <td class="mono truncate" title="${mint}">${mint.slice(0, 6)}...${mint.slice(-4)}</td>
          <td>${socialLinks}</td>
          <td>${added}</td>
          <td><button class="action-btn danger" data-remove-mint="${mint}">Remove</button></td>
        </tr>`;
      }).join('');

      // Bind remove buttons via delegation
      tbody.querySelectorAll('[data-remove-mint]').forEach(btn => {
        btn.addEventListener('click', () => this.removeCurated(btn.dataset.removeMint));
      });
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="5" class="empty-msg">Error: ${this.esc(err.message)}</td></tr>`;
    }
  },

  async addCuratedToken() {
    const input = document.getElementById('curated-mint-input');
    const btn = document.getElementById('curated-add-btn');
    const mint = input.value.trim();
    if (!mint) return;

    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) {
      if (typeof toast !== 'undefined') toast.error('Invalid Solana address format');
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Adding...';
    try {
      await this.request('/api/admin/curated', {
        method: 'POST',
        body: JSON.stringify({ mintAddress: mint })
      });
      input.value = '';
      this.loadCurated();
      if (typeof toast !== 'undefined') toast.success('Token added to curated list');
    } catch (err) {
      if (typeof toast !== 'undefined') toast.error(err.message || 'Failed to add token');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Add Token';
    }
  },

  async refreshAllCurated() {
    const btn = document.getElementById('curated-refresh-btn');
    btn.disabled = true;
    btn.textContent = 'Refreshing...';
    try {
      await this.request('/api/admin/curated/refresh', { method: 'POST' });
      this.loadCurated();
      if (typeof toast !== 'undefined') toast.success('DexScreener data refreshed');
    } catch (err) {
      if (typeof toast !== 'undefined') toast.error(err.message || 'Refresh failed');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Refresh All DexScreener';
    }
  },

  async removeCurated(mint) {
    if (!confirm('Remove this token from curated list?')) return;
    try {
      // Optimistic UI: immediately remove the row
      const btn = document.querySelector(`[data-remove-mint="${CSS.escape(mint)}"]`);
      if (btn) {
        const row = btn.closest('tr');
        if (row) row.remove();
      }

      const result = await this.request(`/api/admin/curated/${encodeURIComponent(mint)}`, { method: 'DELETE' });
      if (result.success) {
        if (typeof toast !== 'undefined') toast.success('Token removed');
      } else {
        if (typeof toast !== 'undefined') toast.error('Failed to remove token');
      }
      // Always reload the full list from the server to sync state
      await this.loadCurated();
    } catch (err) {
      if (typeof toast !== 'undefined') toast.error(err.message);
      // Reload on error too in case the row was optimistically removed
      await this.loadCurated();
    }
  },

  // ── Announcements ─────────────────────────────

  async loadAnnouncements() {
    const tbody = document.getElementById('ann-table-body');
    tbody.innerHTML = '<tr><td colspan="5" class="empty-msg">Loading...</td></tr>';
    try {
      const data = await this.request('/api/admin/announcements');
      const announcements = data.announcements || [];
      if (announcements.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty-msg">No announcements</td></tr>';
        return;
      }
      tbody.innerHTML = announcements.map(a => {
        const typeBadge = { info: 'badge-blue', warning: 'badge-yellow', success: 'badge-green', error: 'badge-red' };
        const isActive = !!(a.is_active ?? a.isActive);
        return `<tr>
          <td>${this.esc(a.title)}</td>
          <td><span class="badge ${typeBadge[a.type] || 'badge-blue'}">${a.type}</span></td>
          <td><span class="badge ${isActive ? 'badge-green' : 'badge-gray'}">${isActive ? 'Active' : 'Inactive'}</span></td>
          <td>${a.created_at ? new Date(a.created_at).toLocaleDateString() : '--'}</td>
          <td class="actions-cell">
            <button class="action-btn" data-toggle-ann="${a.id}" data-active="${isActive}">${isActive ? 'Disable' : 'Enable'}</button>
            <button class="action-btn danger" data-delete-ann="${a.id}">Delete</button>
          </td>
        </tr>`;
      }).join('');

      tbody.querySelectorAll('[data-toggle-ann]').forEach(btn => {
        btn.addEventListener('click', () => this.toggleAnnouncement(
          parseInt(btn.dataset.toggleAnn),
          btn.dataset.active !== 'true'
        ));
      });
      tbody.querySelectorAll('[data-delete-ann]').forEach(btn => {
        btn.addEventListener('click', () => this.deleteAnnouncement(parseInt(btn.dataset.deleteAnn)));
      });
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="5" class="empty-msg">Error: ${this.esc(err.message)}</td></tr>`;
    }
  },

  async createAnnouncement() {
    const title = document.getElementById('ann-title').value.trim();
    const message = document.getElementById('ann-message').value.trim();
    const type = document.getElementById('ann-type').value;
    const expiresRaw = document.getElementById('ann-expires').value;
    const expiresAt = expiresRaw ? new Date(expiresRaw).toISOString() : null;
    if (!title || !message) {
      if (typeof toast !== 'undefined') toast.error('Title and message required');
      return;
    }
    try {
      await this.request('/api/admin/announcements', {
        method: 'POST',
        body: JSON.stringify({ title, message, type, expiresAt })
      });
      document.getElementById('ann-title').value = '';
      document.getElementById('ann-message').value = '';
      document.getElementById('ann-expires').value = '';
      this.loadAnnouncements();
      if (typeof toast !== 'undefined') toast.success('Announcement created');
    } catch (err) {
      if (typeof toast !== 'undefined') toast.error(err.message);
    }
  },

  async toggleAnnouncement(id, isActive) {
    try {
      await this.request(`/api/admin/announcements/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive })
      });
      this.loadAnnouncements();
    } catch (err) {
      if (typeof toast !== 'undefined') toast.error(err.message);
    }
  },

  async deleteAnnouncement(id) {
    if (!confirm('Delete this announcement?')) return;
    try {
      await this.request(`/api/admin/announcements/${id}`, { method: 'DELETE' });
      this.loadAnnouncements();
    } catch (err) {
      if (typeof toast !== 'undefined') toast.error(err.message);
    }
  },

  // ── Bug Reports ───────────────────────────────

  async loadBugReports() {
    const tbody = document.getElementById('bugs-table-body');
    const status = document.getElementById('bugs-status-filter').value;
    tbody.innerHTML = '<tr><td colspan="6" class="empty-msg">Loading...</td></tr>';

    try {
      const data = await this.request(`/api/admin/bug-reports?status=${encodeURIComponent(status)}&limit=50`);
      const reports = data.reports || [];
      if (reports.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="empty-msg">No bug reports</td></tr>';
        return;
      }
      const statusBadge = { new: 'badge-red', acknowledged: 'badge-yellow', resolved: 'badge-green', dismissed: 'badge-gray' };
      tbody.innerHTML = reports.map(r => `<tr>
        <td class="mono">${r.id}</td>
        <td>${this.esc(r.category)}</td>
        <td class="truncate" title="${this.esc(r.description)}">${this.esc((r.description || '').slice(0, 60))}</td>
        <td><span class="badge ${statusBadge[r.status] || 'badge-gray'}">${r.status}</span></td>
        <td>${r.created_at ? new Date(r.created_at).toLocaleDateString() : '--'}</td>
        <td class="actions-cell">
          <select class="action-btn" data-bug-status="${r.id}" style="background:var(--bg-tertiary);color:var(--text-secondary);border:1px solid var(--border-color);border-radius:var(--radius-xs);padding:0.2rem 0.4rem;font-size:0.72rem;">
            ${['new', 'acknowledged', 'resolved', 'dismissed'].map(s => `<option value="${s}" ${s === r.status ? 'selected' : ''}>${s}</option>`).join('')}
          </select>
          <button class="action-btn danger" data-delete-bug="${r.id}">Delete</button>
        </td>
      </tr>`).join('');

      tbody.querySelectorAll('[data-bug-status]').forEach(sel => {
        sel.addEventListener('change', () => this.updateBugStatus(parseInt(sel.dataset.bugStatus), sel.value));
      });
      tbody.querySelectorAll('[data-delete-bug]').forEach(btn => {
        btn.addEventListener('click', () => this.deleteBugReport(parseInt(btn.dataset.deleteBug)));
      });
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="6" class="empty-msg">Error: ${this.esc(err.message)}</td></tr>`;
    }
  },

  async updateBugStatus(id, status) {
    try {
      await this.request(`/api/admin/bug-reports/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status })
      });
      if (typeof toast !== 'undefined') toast.success('Status updated');
    } catch (err) {
      if (typeof toast !== 'undefined') toast.error(err.message);
      this.loadBugReports();
    }
  },

  async deleteBugReport(id) {
    if (!confirm('Delete this bug report?')) return;
    try {
      await this.request(`/api/admin/bug-reports/${id}`, { method: 'DELETE' });
      this.loadBugReports();
    } catch (err) {
      if (typeof toast !== 'undefined') toast.error(err.message);
    }
  },

  // ── Submissions ───────────────────────────────

  async loadSubmissions() {
    const tbody = document.getElementById('subs-table-body');
    const status = document.getElementById('subs-status-filter').value;
    tbody.innerHTML = '<tr><td colspan="7" class="empty-msg">Loading...</td></tr>';

    try {
      const data = await this.request(`/api/admin/submissions?status=${encodeURIComponent(status)}&limit=50`);
      const submissions = data.submissions || [];
      if (submissions.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" class="empty-msg">No submissions</td></tr>';
        return;
      }
      const statusBadge = { pending: 'badge-yellow', approved: 'badge-green', rejected: 'badge-red' };
      tbody.innerHTML = submissions.map(s => {
        const mint = s.token_mint || s.tokenMint || '';
        const isPending = (s.status === 'pending');
        return `<tr>
          <td class="mono">${s.id}</td>
          <td class="mono truncate" title="${this.esc(mint)}">${mint ? mint.slice(0, 6) + '...' + mint.slice(-4) : '--'}</td>
          <td>${this.esc(s.type || s.submission_type || '--')}</td>
          <td class="truncate" title="${this.esc(s.content || s.url || '')}">${this.esc((s.content || s.url || '').slice(0, 40))}</td>
          <td><span class="badge ${statusBadge[s.status] || 'badge-gray'}">${s.status}</span></td>
          <td>${s.created_at ? new Date(s.created_at).toLocaleDateString() : '--'}</td>
          <td class="actions-cell">
            ${isPending ? `<button class="action-btn success" data-approve-sub="${s.id}">Approve</button>
            <button class="action-btn danger" data-reject-sub="${s.id}">Reject</button>` : '--'}
          </td>
        </tr>`;
      }).join('');

      tbody.querySelectorAll('[data-approve-sub]').forEach(btn => {
        btn.addEventListener('click', () => this.reviewSubmission(parseInt(btn.dataset.approveSub), 'approved'));
      });
      tbody.querySelectorAll('[data-reject-sub]').forEach(btn => {
        btn.addEventListener('click', () => this.reviewSubmission(parseInt(btn.dataset.rejectSub), 'rejected'));
      });
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="7" class="empty-msg">Error: ${this.esc(err.message)}</td></tr>`;
    }
  },

  async reviewSubmission(id, status) {
    try {
      await this.request(`/api/admin/submissions/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status })
      });
      this.loadSubmissions();
      this.loadStats();
      if (typeof toast !== 'undefined') toast.success(`Submission ${status}`);
    } catch (err) {
      if (typeof toast !== 'undefined') toast.error(err.message);
    }
  },

  // ── Utility Whitelist ─────────────────────────

  bindWhitelistActions() {
    const addBtn = document.getElementById('wl-add-btn');
    const walletInput = document.getElementById('wl-wallet-input');
    if (addBtn) addBtn.addEventListener('click', () => this.addWhitelistedWallet());
    if (walletInput) walletInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.addWhitelistedWallet();
    });
  },

  async loadWhitelist() {
    const tbody = document.getElementById('wl-table-body');
    tbody.innerHTML = '<tr><td colspan="4" class="empty-msg">Loading...</td></tr>';
    try {
      const data = await this.request('/api/admin/whitelist');
      const wallets = data.wallets || [];
      if (wallets.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" class="empty-msg">No whitelisted wallets.</td></tr>';
        return;
      }
      tbody.innerHTML = wallets.map(w => `<tr>
        <td class="mono" title="${this.esc(w.wallet_address)}">${this.esc(w.wallet_address)}</td>
        <td>${this.esc(w.note || '--')}</td>
        <td>${w.added_at ? new Date(w.added_at).toLocaleDateString() : '--'}</td>
        <td><button class="action-btn danger" data-remove-wallet="${this.esc(w.wallet_address)}">Remove</button></td>
      </tr>`).join('');

      tbody.querySelectorAll('[data-remove-wallet]').forEach(btn => {
        btn.addEventListener('click', () => this.removeWhitelistedWallet(btn.dataset.removeWallet));
      });
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="4" class="empty-msg">Error: ${this.esc(err.message)}</td></tr>`;
    }
  },

  async addWhitelistedWallet() {
    const walletInput = document.getElementById('wl-wallet-input');
    const noteInput = document.getElementById('wl-note-input');
    const btn = document.getElementById('wl-add-btn');
    const status = document.getElementById('wl-status');
    const wallet = walletInput.value.trim();
    const note = noteInput.value.trim();

    if (!wallet || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet)) {
      status.textContent = 'Invalid Solana wallet address.';
      status.style.color = 'var(--red)';
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Adding...';
    status.textContent = '';
    try {
      await this.request('/api/admin/whitelist', {
        method: 'POST',
        body: JSON.stringify({ wallet, note: note || undefined })
      });
      walletInput.value = '';
      noteInput.value = '';
      status.textContent = 'Wallet added to whitelist.';
      status.style.color = 'var(--green)';
      this.loadWhitelist();
      if (typeof toast !== 'undefined') toast.success('Wallet whitelisted');
    } catch (err) {
      status.textContent = `Error: ${err.message}`;
      status.style.color = 'var(--red)';
      if (typeof toast !== 'undefined') toast.error(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Add Wallet';
    }
  },

  async removeWhitelistedWallet(wallet) {
    if (!confirm(`Remove ${wallet.slice(0, 8)}... from whitelist?`)) return;
    try {
      await this.request(`/api/admin/whitelist/${encodeURIComponent(wallet)}`, { method: 'DELETE' });
      this.loadWhitelist();
      if (typeof toast !== 'undefined') toast.success('Wallet removed from whitelist');
    } catch (err) {
      if (typeof toast !== 'undefined') toast.error(err.message);
    }
  },

  // ── System Health ─────────────────────────────

  async loadHealth() {
    const grid = document.getElementById('health-grid');
    grid.innerHTML = '<div class="empty-msg">Loading health data...</div>';
    try {
      const h = await this.request('/health/detailed');
      const checks = h.checks || {};

      const card = (title, status, details) => {
        const dot = status === 'ok' ? 'ok' : status === 'warning' || status === 'degraded' ? 'warn' : 'err';
        return `<div class="health-card">
          <h3><span class="health-dot ${dot}"></span>${this.esc(title)}</h3>
          <div class="health-detail">${details}</div>
        </div>`;
      };

      const uptime = h.uptime ? `${Math.floor(h.uptime / 3600)}h ${Math.floor((h.uptime % 3600) / 60)}m` : '--';

      grid.innerHTML = [
        card('Overview', h.status, `Status: <strong>${this.esc(h.status)}</strong><br>Uptime: ${uptime}<br>Version: ${this.esc(h.version || '--')}`),
        card('Database', checks.database?.status, `Healthy: ${checks.database?.healthy}<br>Latency: ${checks.database?.connectionTime || '--'}`),
        card('Solana RPC', checks.solana_rpc?.status, `Healthy: ${checks.solana_rpc?.healthy}<br>Endpoint: ${checks.solana_rpc?.currentEndpoint || '--'}/${checks.solana_rpc?.totalEndpoints || '--'}<br>Fallback: ${checks.solana_rpc?.usingFallback ? 'Yes' : 'No'}`),
        card('Cache', checks.cache?.status, `Type: ${checks.cache?.type || '--'}<br>Healthy: ${checks.cache?.healthy}`),
        card('Job Queue', checks.job_queue?.status, `Initialized: ${checks.job_queue?.initialized}<br>Worker Active: ${checks.job_queue?.workerActive}<br>Buffer: ${checks.job_queue?.viewBufferSize || 0}`),
        card('Memory', checks.memory?.status, `Heap: ${checks.memory?.heapUsedMB || '--'} / ${checks.memory?.heapTotalMB || '--'} MB<br>RSS: ${checks.memory?.rssMB || '--'} MB`),
        card('Circuit Breakers', checks.circuit_breakers?.status,
          checks.circuit_breakers ? Object.entries(checks.circuit_breakers)
            .filter(([k]) => k !== 'status')
            .map(([k, v]) => `${this.esc(k)}: ${this.esc(v?.state || '--')} (${v?.failures || 0} failures)`)
            .join('<br>') : '--'
        ),
      ].join('');
    } catch (err) {
      grid.innerHTML = `<div class="empty-msg">Error: ${this.esc(err.message)}</div>`;
    }
  },

  // ── Utilities ─────────────────────────────────

  esc(str) {
    if (str === null || str === undefined) return '';
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
  },

  setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val != null ? val : '--';
  }
};

document.addEventListener('DOMContentLoaded', () => admin.init());
