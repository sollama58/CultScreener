/* CultScreener Admin Panel */

const admin = {
  token: null,
  activeTab: 'dashboard',

  init() {
    this.token = localStorage.getItem('cultscreener_admin_session');
    if (this.token) {
      this.verifySession();
    } else {
      this.showLogin();
    }
    this.bindLogin();
    this.bindTabs();
    document.getElementById('logout-btn').addEventListener('click', () => this.logout());
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
    const password = input.value.trim();
    if (!password) return;

    errEl.style.display = 'none';
    try {
      const data = await this.request('/api/admin/login', {
        method: 'POST',
        body: JSON.stringify({ password }),
        noAuth: true
      });
      this.token = data.token;
      localStorage.setItem('cultscreener_admin_session', data.token);
      input.value = '';
      this.showPanel();
      this.loadTab('dashboard');
    } catch (err) {
      errEl.textContent = err.message || 'Login failed';
      errEl.style.display = 'block';
    }
  },

  async logout() {
    try { await this.request('/api/admin/logout', { method: 'POST' }); } catch (_) {}
    this.token = null;
    localStorage.removeItem('cultscreener_admin_session');
    this.showLogin();
  },

  async verifySession() {
    try {
      await this.request('/api/admin/stats');
      this.showPanel();
      this.loadTab('dashboard');
    } catch {
      this.token = null;
      localStorage.removeItem('cultscreener_admin_session');
      this.showLogin();
    }
  },

  showLogin() {
    document.getElementById('login-section').style.display = 'flex';
    document.getElementById('admin-panel').style.display = 'none';
    document.getElementById('login-password').focus();
  },

  showPanel() {
    document.getElementById('login-section').style.display = 'none';
    document.getElementById('admin-panel').style.display = 'block';
  },

  // ── Request helper ────────────────────────────

  async request(endpoint, opts = {}) {
    const url = config.api.baseUrl + endpoint;
    const headers = { 'Content-Type': 'application/json' };
    if (!opts.noAuth && this.token) {
      headers['X-Admin-Session'] = this.token;
    }
    const res = await fetch(url, {
      method: opts.method || 'GET',
      headers,
      body: opts.body || undefined,
      credentials: 'include'
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
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
      case 'health': this.loadHealth(); break;
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
      console.error('Stats load error:', err);
    }
  },

  // ── Curated Tokens ────────────────────────────

  async loadCurated() {
    const tbody = document.getElementById('curated-table-body');
    try {
      const { tokens } = await this.request('/api/admin/curated');
      if (!tokens || tokens.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty-msg">No curated tokens</td></tr>';
        return;
      }
      tbody.innerHTML = tokens.map(t => {
        const mint = this.esc(t.mintAddress || '');
        const name = this.esc(t.name || t.symbol || mint.slice(0, 8));
        const socials = t.socials || {};
        const socialLinks = Object.entries(socials).filter(([, v]) => v).map(([k]) => k).join(', ') || '--';
        const added = t.addedAt ? new Date(t.addedAt).toLocaleDateString() : '--';
        return `<tr>
          <td>${name}</td>
          <td class="mono truncate" title="${mint}">${mint.slice(0, 6)}...${mint.slice(-4)}</td>
          <td>${socialLinks}</td>
          <td>${added}</td>
          <td><button class="action-btn danger" onclick="admin.removeCurated('${mint}')">Remove</button></td>
        </tr>`;
      }).join('');
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="5" class="empty-msg">${this.esc(err.message)}</td></tr>`;
    }

    // Bind add button
    const addBtn = document.getElementById('curated-add-btn');
    addBtn.onclick = async () => {
      const input = document.getElementById('curated-mint-input');
      const mint = input.value.trim();
      if (!mint) return;
      try {
        await this.request('/api/admin/curated', { method: 'POST', body: JSON.stringify({ mintAddress: mint }) });
        input.value = '';
        this.loadCurated();
        if (typeof toast !== 'undefined') toast.success('Token added');
      } catch (err) {
        if (typeof toast !== 'undefined') toast.error(err.message);
      }
    };

    // Bind refresh all
    const refreshBtn = document.getElementById('curated-refresh-btn');
    refreshBtn.onclick = async () => {
      refreshBtn.disabled = true;
      refreshBtn.textContent = 'Refreshing...';
      try {
        // Use the existing curated refresh endpoint (needs X-Admin-Password)
        // Since we're session-based, just reload curated data
        await this.request('/api/admin/curated'); // Reload
        this.loadCurated();
        if (typeof toast !== 'undefined') toast.success('Refreshed');
      } catch (err) {
        if (typeof toast !== 'undefined') toast.error(err.message);
      } finally {
        refreshBtn.disabled = false;
        refreshBtn.textContent = 'Refresh All DexScreener';
      }
    };
  },

  async removeCurated(mint) {
    if (!confirm('Remove this token from curated list?')) return;
    try {
      await this.request(`/api/admin/curated/${mint}`, { method: 'DELETE' });
      this.loadCurated();
      if (typeof toast !== 'undefined') toast.success('Token removed');
    } catch (err) {
      if (typeof toast !== 'undefined') toast.error(err.message);
    }
  },

  // ── Announcements ─────────────────────────────

  async loadAnnouncements() {
    const tbody = document.getElementById('ann-table-body');
    try {
      const { announcements } = await this.request('/api/admin/announcements');
      if (!announcements || announcements.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty-msg">No announcements</td></tr>';
        return;
      }
      tbody.innerHTML = announcements.map(a => {
        const typeBadge = { info: 'badge-blue', warning: 'badge-yellow', success: 'badge-green', error: 'badge-red' };
        const activeClass = a.is_active || a.isActive ? 'badge-green' : 'badge-gray';
        return `<tr>
          <td>${this.esc(a.title)}</td>
          <td><span class="badge ${typeBadge[a.type] || 'badge-blue'}">${a.type}</span></td>
          <td><span class="badge ${activeClass}">${(a.is_active || a.isActive) ? 'Active' : 'Inactive'}</span></td>
          <td>${a.created_at ? new Date(a.created_at).toLocaleDateString() : '--'}</td>
          <td class="actions-cell">
            <button class="action-btn" onclick="admin.toggleAnnouncement(${a.id}, ${!(a.is_active || a.isActive)})">${(a.is_active || a.isActive) ? 'Disable' : 'Enable'}</button>
            <button class="action-btn danger" onclick="admin.deleteAnnouncement(${a.id})">Delete</button>
          </td>
        </tr>`;
      }).join('');
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="5" class="empty-msg">${this.esc(err.message)}</td></tr>`;
    }

    // Bind create
    document.getElementById('ann-create-btn').onclick = async () => {
      const title = document.getElementById('ann-title').value.trim();
      const message = document.getElementById('ann-message').value.trim();
      const type = document.getElementById('ann-type').value;
      if (!title || !message) { if (typeof toast !== 'undefined') toast.error('Title and message required'); return; }
      try {
        await this.request('/api/admin/announcements', { method: 'POST', body: JSON.stringify({ title, message, type }) });
        document.getElementById('ann-title').value = '';
        document.getElementById('ann-message').value = '';
        this.loadAnnouncements();
        if (typeof toast !== 'undefined') toast.success('Announcement created');
      } catch (err) {
        if (typeof toast !== 'undefined') toast.error(err.message);
      }
    };
  },

  async toggleAnnouncement(id, isActive) {
    try {
      await this.request(`/api/admin/announcements/${id}`, { method: 'PATCH', body: JSON.stringify({ isActive }) });
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

    // Bind filter change
    document.getElementById('bugs-status-filter').onchange = () => this.loadBugReports();

    try {
      const data = await this.request(`/api/admin/bug-reports?status=${status}&limit=50`);
      const reports = data.reports || [];
      if (reports.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="empty-msg">No bug reports</td></tr>';
        return;
      }
      const statusBadge = { new: 'badge-red', acknowledged: 'badge-yellow', resolved: 'badge-green', dismissed: 'badge-gray' };
      tbody.innerHTML = reports.map(r => `<tr>
        <td class="mono">${r.id}</td>
        <td>${this.esc(r.category)}</td>
        <td class="truncate" title="${this.esc(r.description)}">${this.esc(r.description?.slice(0, 60))}</td>
        <td><span class="badge ${statusBadge[r.status] || 'badge-gray'}">${r.status}</span></td>
        <td>${r.created_at ? new Date(r.created_at).toLocaleDateString() : '--'}</td>
        <td class="actions-cell">
          <select class="action-btn" onchange="admin.updateBugStatus(${r.id}, this.value)" style="background:var(--bg-tertiary);color:var(--text-secondary);border:1px solid var(--border-color);border-radius:var(--radius-xs);padding:0.2rem 0.4rem;font-size:0.72rem;">
            ${['new', 'acknowledged', 'resolved', 'dismissed'].map(s => `<option value="${s}" ${s === r.status ? 'selected' : ''}>${s}</option>`).join('')}
          </select>
          <button class="action-btn danger" onclick="admin.deleteBugReport(${r.id})">Delete</button>
        </td>
      </tr>`).join('');
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="6" class="empty-msg">${this.esc(err.message)}</td></tr>`;
    }
  },

  async updateBugStatus(id, status) {
    try {
      await this.request(`/api/admin/bug-reports/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
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

    document.getElementById('subs-status-filter').onchange = () => this.loadSubmissions();

    try {
      const data = await this.request(`/api/admin/submissions?status=${status}&limit=50`);
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
          <td class="mono truncate" title="${this.esc(mint)}">${mint.slice(0, 6)}...${mint.slice(-4)}</td>
          <td>${this.esc(s.type || s.submission_type || '--')}</td>
          <td class="truncate" title="${this.esc(s.content || s.url || '')}">${this.esc((s.content || s.url || '').slice(0, 40))}</td>
          <td><span class="badge ${statusBadge[s.status] || 'badge-gray'}">${s.status}</span></td>
          <td>${s.created_at ? new Date(s.created_at).toLocaleDateString() : '--'}</td>
          <td class="actions-cell">
            ${isPending ? `<button class="action-btn success" onclick="admin.reviewSubmission(${s.id}, 'approved')">Approve</button>
            <button class="action-btn danger" onclick="admin.reviewSubmission(${s.id}, 'rejected')">Reject</button>` : '--'}
          </td>
        </tr>`;
      }).join('');
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="7" class="empty-msg">${this.esc(err.message)}</td></tr>`;
    }
  },

  async reviewSubmission(id, status) {
    try {
      await this.request(`/api/admin/submissions/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
      this.loadSubmissions();
      this.loadStats();
      if (typeof toast !== 'undefined') toast.success(`Submission ${status}`);
    } catch (err) {
      if (typeof toast !== 'undefined') toast.error(err.message);
    }
  },

  // ── System Health ─────────────────────────────

  async loadHealth() {
    const grid = document.getElementById('health-grid');
    try {
      const h = await this.request('/health/detailed');
      const checks = h.checks || {};

      const card = (title, status, details) => {
        const dot = status === 'ok' ? 'ok' : status === 'warning' || status === 'degraded' ? 'warn' : 'err';
        return `<div class="health-card">
          <h3><span class="health-dot ${dot}"></span>${title}</h3>
          <div class="health-detail">${details}</div>
        </div>`;
      };

      const uptime = h.uptime ? `${Math.floor(h.uptime / 3600)}h ${Math.floor((h.uptime % 3600) / 60)}m` : '--';

      grid.innerHTML = [
        card('Overview', h.status, `Status: <strong>${h.status}</strong><br>Uptime: ${uptime}<br>Version: ${h.version || '--'}`),
        card('Database', checks.database?.status, `Healthy: ${checks.database?.healthy}<br>Latency: ${checks.database?.connectionTime || '--'}`),
        card('Solana RPC', checks.solana_rpc?.status, `Healthy: ${checks.solana_rpc?.healthy}<br>Endpoint: ${checks.solana_rpc?.currentEndpoint || '--'}/${checks.solana_rpc?.totalEndpoints || '--'}<br>Fallback: ${checks.solana_rpc?.usingFallback ? 'Yes' : 'No'}`),
        card('Cache', checks.cache?.status, `Type: ${checks.cache?.type || '--'}<br>Healthy: ${checks.cache?.healthy}`),
        card('Job Queue', checks.job_queue?.status, `Initialized: ${checks.job_queue?.initialized}<br>Worker Active: ${checks.job_queue?.workerActive}<br>Buffer: ${checks.job_queue?.viewBufferSize || 0}`),
        card('Memory', checks.memory?.status, `Heap: ${checks.memory?.heapUsedMB || '--'} / ${checks.memory?.heapTotalMB || '--'} MB<br>RSS: ${checks.memory?.rssMB || '--'} MB`),
        card('Circuit Breakers', checks.circuit_breakers?.status,
          checks.circuit_breakers ? Object.entries(checks.circuit_breakers).filter(([k]) => k !== 'status').map(([k, v]) => `${k}: ${v?.state || '--'} (${v?.failures || 0} failures)`).join('<br>') : '--'
        ),
      ].join('');
    } catch (err) {
      grid.innerHTML = `<div class="empty-msg">${this.esc(err.message)}</div>`;
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
