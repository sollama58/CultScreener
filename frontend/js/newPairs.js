/* global api, utils, tokenTable */
// New Pairs tab: tokens that graduated from a launchpad in the last 3, 7 or 14 days, ranked by
// the finder's score (backend newPairScore.js). One request per window (GET /api/new-pairs);
// search, filters and sorting work on the loaded rows.
//
// Every number has an age. The API sends the time each family of data was read (market, holder
// count, top-50 holder check) and the Updated column shows all three, re-drawn every minute so
// an open tab does not keep saying "2m" for an hour.
//
// The tab button ships hidden. The API answers 404 NEWPAIRS_DISABLED until NEWPAIRS_PUBLIC is
// turned on, and mainViewTabs.js shows the tab only after probe() got a list.
//
// Token names, tickers, logos and launchpad labels are creator-written text: everything goes
// through tokenTable.esc before it reaches innerHTML.

const newPairsPage = {
  MIN: 60 * 1000,
  HOUR: 60 * 60 * 1000,

  window: '7d',
  sort: 'score',
  launchpad: '',
  checkedOnly: false,
  showRugged: false, // rugged tokens stay in the data, hidden until asked for

  data: null,
  tokens: [],
  _searchTimeout: null,
  _loaded: false,
  _loading: false,
  _loadFailed: false,
  _probe: null,
  _tick: null,
  _tipFor: null,

  // [amber after, grey after]. Market and holder counts are re-read every 10 minutes, the
  // top-50 check about every 12 hours and it stops counting toward the score at 36.
  AGE_RULES: {
    market: [30 * 60 * 1000, 2 * 60 * 60 * 1000],
    holders: [30 * 60 * 1000, 2 * 60 * 60 * 1000],
    top50: [14 * 60 * 60 * 1000, 36 * 60 * 60 * 1000],
  },
  AGE_LABELS: { market: ['Mkt', 'Price, market cap, liquidity and volume'], holders: ['Hold', 'Holder count'], top50: ['Top50', 'Top-50 holder check'] },

  TERMS: [
    ['growth', 'Holder growth'], ['steady', 'Steady growth'], ['base', 'Holder base'], ['breadth', 'Buyer breadth'],
    ['retention', 'Retention'], ['spread', 'Spread'], ['dev', 'Dev holding'],
    ['activity', 'Activity'], ['trend', 'Price trend'], ['pressure', 'Buy pressure'],
  ],
  TOP50_TERMS: ['retention', 'spread', 'dev'],
  RISK_REASONS: {
    wash: 'volume looks wash-traded',
    sybil: 'many dust or never-bought holder wallets',
    whale: 'one wallet holds a large share',
    bundle: 'top holders with equal-size bags',
    rug: 'down 80% from its peak, or liquidity under the floor',
  },
  SORTS: {
    score: t => t.score,
    newest: t => (t.graduatedAt ? new Date(t.graduatedAt).getTime() : null),
    mcap: t => t.marketCap,
    holders: t => t.holders,
    growth: t => t.holdersChange24h,
  },

  // ── Pure helpers (no DOM; covered by newPairs.test.js) ──────────────────────────────────

  ageMs(at, now) {
    if (!at) return null;
    const ms = now - new Date(at).getTime();
    return isFinite(ms) ? Math.max(0, ms) : null;
  },

  /** 'none' (never read) | 'fresh' | 'amber' | 'old' */
  ageState(kind, at, now) {
    const ms = this.ageMs(at, now);
    if (ms == null) return 'none';
    const [amber, old] = this.AGE_RULES[kind];
    return ms > old ? 'old' : ms > amber ? 'amber' : 'fresh';
  },

  ageText(at, now) {
    const ms = this.ageMs(at, now);
    if (ms == null) return '--';
    const minutes = Math.floor(ms / this.MIN);
    if (minutes < 1) return '<1m';
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 48) return `${hours}h`;
    return `${Math.floor(hours / 24)}d`;
  },

  /** The oldest-looking of the three, for the one dot a phone shows. */
  worstState(token, now) {
    const at = token.at || {};
    const order = ['fresh', 'amber', 'old'];
    let worst = 0;
    ['market', 'holders', 'top50'].forEach(kind => {
      const s = this.ageState(kind, at[kind], now);
      // A token that has had no top-50 check says so in its score; a missing market read is old.
      const i = s === 'none' ? (kind === 'top50' ? 0 : 2) : order.indexOf(s);
      if (i > worst) worst = i;
    });
    return order[worst];
  },

  /** Filter and sort the loaded rows. Nulls sort last whatever the key. */
  view(tokens, opts = {}) {
    const q = (opts.query || '').trim().toLowerCase();
    const key = this.SORTS[opts.sort] || this.SORTS.score;
    return tokens.filter(t => {
      if (t.rugged && !opts.showRugged) return false;
      if (opts.checkedOnly && t.scoreState === 'holders_pending') return false;
      if (opts.launchpad && t.launchpad !== opts.launchpad) return false;
      if (!q) return true;
      return (t.name || '').toLowerCase().includes(q) || (t.symbol || '').toLowerCase().includes(q) ||
        (t.mint || '').toLowerCase().includes(q);
    }).map((t, i) => ({ t, i, k: key(t) })).sort((a, b) => {
      const an = a.k == null || !isFinite(a.k);
      const bn = b.k == null || !isFinite(b.k);
      if (an !== bn) return an ? 1 : -1;
      if (!an && a.k !== b.k) return b.k - a.k;
      return a.i - b.i;
    }).map(x => x.t);
  },

  launchpads(tokens) {
    const seen = new Map();
    tokens.forEach(t => { if (t.launchpad) seen.set(t.launchpad, (seen.get(t.launchpad) || 0) + 1); });
    return [...seen.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).map(e => e[0]);
  },

  /** 24h holder change (% a day) as the shared velocity levels: two arrows from 10%, one from 1%. */
  velocityLevel(pct) {
    if (pct == null || !isFinite(pct)) return null;
    if (pct >= 10) return 2;
    if (pct >= 1) return 1;
    if (pct <= -10) return -2;
    if (pct <= -1) return -1;
    return 0;
  },

  /**
   * The score, taken apart. score = 100 × quality × confidence × risk, where quality is the
   * weighted mean of the terms that have data. Returns plain data; tipHtml draws it.
   */
  breakdown(token, weights) {
    const terms = token.terms || {};
    const w = weights || {};
    const lines = [];
    const missing = [];
    let points = 0;
    let available = 0;
    this.TERMS.forEach(([key, label]) => {
      const value = terms[key];
      const weight = typeof w[key] === 'number' ? w[key] * 100 : null;
      if (typeof value !== 'number' || !isFinite(value)) { missing.push({ key, label }); return; }
      const got = weight == null ? null : value * weight;
      if (got != null) { points += got; available += weight; }
      lines.push({ key, label, value, weight, points: got });
    });
    const reasons = Object.keys(this.RISK_REASONS)
      .filter(k => typeof (token.riskParts || {})[k] === 'number' && token.riskParts[k] < 1)
      .map(k => ({ key: k, factor: token.riskParts[k], reason: this.RISK_REASONS[k] }));
    return {
      lines, missing, points, available,
      quality: available > 0 ? points / available : null,
      confidence: token.confidence, risk: token.risk, reasons,
      waitingTop50: missing.some(m => this.TOP50_TERMS.includes(m.key)),
    };
  },

  // ── Markup ──────────────────────────────────────────────────────────────────────────────

  num(v, digits) {
    return Number(v).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  },

  pctCell(value, digits = 1) {
    if (value == null || !isFinite(value)) return tokenTable.dash();
    return `<span class="num">${Number(value).toFixed(digits)}%</span>`;
  },

  tokenCell(token, now) {
    const esc = v => tokenTable.esc(v);
    const mint = token.mint || '';
    const fallback = utils.getDefaultLogo();
    const logo = utils.proxyImageUrl(token.logo) || fallback;
    const name = token.name || `${mint.slice(0, 4)}...${mint.slice(-4)}`;
    const symbol = token.symbol || mint.slice(0, 5).toUpperCase();
    let tags = '';
    if (token.emergingCult) tags += '<span class="tt-tag" title="Emerging Cult">🔨</span>';
    else if (token.curated) tags += '<span class="np-chip np-chip--curated" title="Curated on HolDEX: opens the full token page">Curated</span>';
    if (token.rugged) tags += '<span class="np-chip np-chip--rugged" title="Down 80% from its peak since bonding, or liquidity under the floor">Rugged</span>';
    const pad = token.launchpad ? `<span class="np-pad">${esc(token.launchpad)}</span>` : '';
    return `
      <td class="cell-token">
        <div class="tt-token">
          <img class="tt-logo" src="${esc(logo)}" alt="" width="32" height="32" loading="lazy" decoding="async" data-fallback="${esc(fallback)}">
          <div class="tt-token-text">
            <div class="tt-name-line"><span class="tt-name">${esc(name)}</span>${tags}</div>
            <div class="np-sub"><span class="tt-symbol">$${esc(symbol)}</span>${pad}${this.bondedChip(token, now)}</div>
          </div>
        </div>
      </td>`;
  },

  bondedChip(token, now) {
    if (!token.graduatedAt) return '';
    const date = new Date(token.graduatedAt);
    if (!isFinite(date.getTime())) return '';
    const tip = `Left the bonding curve ${date.toLocaleString()}`;
    return `<span class="tt-age np-bonded" data-bonded="${tokenTable.esc(token.graduatedAt)}" title="${tokenTable.esc(tip)}">bonded ${this.ageText(token.graduatedAt, now)}</span>`;
  },

  scoreCell(token) {
    if (token.score == null) return `<td class="np-cell-score">${tokenTable.dash()}</td>`;
    const pending = token.scoreState === 'holders_pending';
    const stale = token.scoreState === 'holders_stale';
    const note = pending ? 'holders pending' : stale ? 'holders stale' : '';
    const width = Math.max(0, Math.min(100, Number(token.score)));
    return `
      <td class="np-cell-score">
        <button type="button" class="np-score${pending ? ' np-score--pending' : ''}${stale ? ' np-score--stale' : ''}" aria-label="Score ${this.num(token.score, 1)}${note ? `, ${note}` : ''}. Show how it is built." aria-describedby="newpairs-tip">
          <span class="np-score-num num">${this.num(token.score, 1)}</span>
          <span class="np-score-bar"><i style="width:${width.toFixed(0)}%"></i></span>
          ${note ? `<span class="np-score-note">${note}</span>` : ''}
        </button>
      </td>`;
  },

  holdersCell(token) {
    if (!token.holders) return tokenTable.dash();
    const pct = token.holdersChange24h;
    const level = this.velocityLevel(pct);
    const known = level != null;
    const tone = !known || level === 0 ? 'flat' : level > 0 ? 'up' : 'down';
    const sign = pct > 0 ? '+' : '';
    const tip = known
      ? `${tokenTable.VELOCITY_WORDS[level]}: ${sign}${Number(pct).toFixed(1)}% holders a day`
      : 'Not enough holder history for a 24h trend yet';
    const glyph = tokenTable.VELOCITY_GLYPHS[known ? level : 0];
    const change = known ? `<span class="np-chg ${tone}">${sign}${Number(pct).toFixed(Math.abs(pct) >= 100 ? 0 : 1)}%</span>` : '';
    return `<span class="tt-holders"><svg class="tt-vel ${tone}${known ? '' : ' none'}" viewBox="0 0 12 12" width="12" height="12" role="img" aria-label="${tokenTable.esc(tip)}"><title>${tokenTable.esc(tip)}</title>${glyph}</svg><span class="num">${Number(token.holders).toLocaleString()}</span></span>${change}`;
  },

  /** The inside of the Updated cell: three age chips (desktop) and one dot (phones). */
  agesInner(at, now) {
    at = at || {};
    const chips = ['market', 'holders', 'top50'].map(kind => {
      const state = this.ageState(kind, at[kind], now);
      const [short, long] = this.AGE_LABELS[kind];
      const tip = state === 'none' ? `${long}: not read yet` : `${long}: read ${this.ageText(at[kind], now)} ago`;
      return `<span class="np-age np-age--${state}" title="${tokenTable.esc(tip)}"><b>${short}</b>${this.ageText(at[kind], now)}</span>`;
    }).join('');
    const worst = this.worstState({ at }, now);
    const words = { fresh: 'Data is fresh', amber: 'Some data is getting old', old: 'Some data is old' }[worst];
    const dotTip = `${words}: market ${this.ageText(at.market, now)}, holders ${this.ageText(at.holders, now)}, top 50 ${this.ageText(at.top50, now)}`;
    return `${chips}<span class="np-dot np-dot--${worst}" role="img" aria-label="${tokenTable.esc(dotTip)}" title="${tokenTable.esc(dotTip)}"></span>`;
  },

  rowHtml(token, rank, now, opts = {}) {
    if (!token.mint) return '';
    const esc = v => tokenTable.esc(v);
    const at = token.at || {};
    const retention = token.retention12h == null ? null : token.retention12h * 100;
    return `
      <tr class="token-row tt-row np-row${token.rugged ? ' np-row--rugged' : ''}" data-mint="${esc(token.mint)}"${token.curated ? ' data-curated="1"' : ''} tabindex="0">
        ${tokenTable.rankCell(rank, { plain: !opts.ranked })}
        ${this.tokenCell(token, now)}
        ${this.scoreCell(token)}
        <td class="cell-mcap num">${utils.formatNumber(token.marketCap, '$')}</td>
        <td class="np-cell-liq num">${utils.formatNumber(token.liquidity, '$')}</td>
        <td class="np-cell-holders">${this.holdersCell(token)}</td>
        <td class="np-cell-top10" title="Share of supply held by the 10 largest wallets, pools and burn addresses left out">${this.pctCell(token.top10Pct)}</td>
        <td class="np-cell-ret" title="Share of the top holders that were still holding 12 hours later">${this.pctCell(retention, 0)}</td>
        <td class="np-cell-vol num">${utils.formatNumber(token.volume24h, '$')}</td>
        <td class="np-cell-ages"><span class="np-ages" data-market="${esc(at.market || '')}" data-holders="${esc(at.holders || '')}" data-top50="${esc(at.top50 || '')}">${this.agesInner(at, now)}</span></td>
      </tr>`;
  },

  tipHtml(token, weights, now) {
    const esc = v => tokenTable.esc(v);
    const b = this.breakdown(token, weights);
    const f2 = v => (v == null || !isFinite(v) ? '--' : Number(v).toFixed(2));
    const f1 = v => (v == null || !isFinite(v) ? '--' : Number(v).toFixed(1));
    const at = token.at || {};
    const rows = b.lines.map(l => `
      <tr><th scope="row">${esc(l.label)}</th><td>${f2(l.value)}</td><td>${l.weight == null ? '' : `× ${f1(l.weight).replace(/\.0$/, '')}`}</td><td>${l.points == null ? '' : `= ${f1(l.points)}`}</td></tr>`).join('');
    const missing = b.missing.length
      ? `<p class="np-tip-note">Not counted yet: ${esc(b.missing.map(m => m.label).join(', '))}${b.waitingTop50 ? ' (waiting for a top-50 holder check)' : ''}.</p>`
      : '';
    const quality = b.quality == null ? '' :
      `<p>Quality <b>${f2(b.quality)}</b> <span class="np-tip-dim">${f1(b.points)} of ${f1(b.available).replace(/\.0$/, '')} points that have data</span></p>`;
    const confidence = `<p>× Confidence <b>${f2(b.confidence)}</b> <span class="np-tip-dim">${b.confidence != null && b.confidence < 1 ? 'young token, full weight 72 hours after bonding' : 'bonded 72 hours or more ago'}</span></p>`;
    const risk = `<p>× Risk <b>${f2(b.risk)}</b> <span class="np-tip-dim">${b.reasons.length ? esc(b.reasons.map(r => `${r.reason} (×${f2(r.factor)})`).join('; ')) : 'no flags'}</span></p>`;
    return `
      <div class="np-tip-head"><b>Score ${token.score == null ? '--' : f1(token.score)}</b><span>${esc(token.symbol ? `$${token.symbol}` : '')}</span></div>
      <table class="np-tip-terms"><tbody>${rows}</tbody></table>
      ${missing}${quality}${confidence}${risk}
      <p class="np-tip-ages">Market ${this.ageText(at.market, now)} ago · holders ${this.ageText(at.holders, now)} ago · top 50 ${at.top50 ? `${this.ageText(at.top50, now)} ago` : 'not checked yet'}</p>`;
  },

  metaText(data, shown, now) {
    if (!data) return '';
    const days = { '3d': 3, '7d': 7, '14d': 14 }[data.window] || 7;
    const parts = [`${shown} of ${data.total} tokens bonded in the last ${days} days`];
    const floors = data.floors || {};
    if (floors.marketCap || floors.liquidity) {
      parts.push(`above ${utils.formatNumber(floors.marketCap, '$')} market cap and ${utils.formatNumber(floors.liquidity, '$')} liquidity`);
    }
    if (data.total > data.shown) parts.push(`best ${data.shown} loaded`);
    if (data.rugged) parts.push(`${data.rugged} rugged`);
    parts.push(data.scoredAt ? `scored ${this.ageText(data.scoredAt, now)} ago` : 'not scored yet');
    return parts.join(' · ');
  },

  // ── Page ────────────────────────────────────────────────────────────────────────────────

  /** True when the API serves the list (NEWPAIRS_PUBLIC on). The answer is kept for init(). */
  probe() {
    if (!this._probe) {
      this._probe = api.newPairs.list(this.window).then(d => !!(d && Array.isArray(d.tokens)), () => false);
    }
    return this._probe;
  },

  init() {
    if (this._loaded) return;
    this._loaded = true;
    this.bind();
    this.loadData();
    // Ages move on without a request; only while the tab is the one on screen.
    this._tick = setInterval(() => this.refreshAges(), this.MIN);
  },

  bind() {
    const $ = id => document.getElementById(id);
    const search = $('newpairs-search');
    if (search) {
      search.addEventListener('input', () => {
        clearTimeout(this._searchTimeout);
        this._searchTimeout = setTimeout(() => this.render(), 300);
      });
    }
    document.querySelectorAll('.np-window').forEach(btn => {
      btn.addEventListener('click', () => {
        if (this._loading || btn.dataset.window === this.window) return;
        this.window = btn.dataset.window;
        this.loadData();
      });
    });
    const sort = $('newpairs-sort');
    if (sort) sort.addEventListener('change', () => { this.sort = sort.value; this.render(); });
    const pad = $('newpairs-launchpad');
    if (pad) pad.addEventListener('change', () => { this.launchpad = pad.value; this.render(); });
    const toggle = (id, prop) => {
      const el = $(id);
      if (!el) return;
      el.addEventListener('click', () => {
        this[prop] = !this[prop];
        el.classList.toggle('active', this[prop]);
        el.setAttribute('aria-pressed', this[prop] ? 'true' : 'false');
        this.render();
      });
    };
    toggle('newpairs-checked', 'checkedOnly');
    toggle('newpairs-rugged', 'showRugged');
    this.bindTable($('newpairs-table-body'));
  },

  // One listener set for the table body: rows open the token's page (the full page for a
  // curated token, the lite page for the rest), the score opens its breakdown.
  bindTable(tbody) {
    if (!tbody || tbody._npBound) return;
    tbody._npBound = true;
    const open = (e) => {
      const row = e.target.closest('tr[data-mint]');
      if (!row || !tbody.contains(row) || e.target.closest('a, button, input')) return;
      const page = row.dataset.curated ? 'token.html' : 'pair.html';
      const url = `${page}?mint=${encodeURIComponent(row.dataset.mint)}`;
      if (e.metaKey || e.ctrlKey) window.open(url, '_blank', 'noopener');
      else window.location.href = url;
    };
    const scoreOf = e => (e.target.closest ? e.target.closest('.np-score') : null);
    tbody.addEventListener('click', (e) => {
      const btn = scoreOf(e);
      if (!btn) return open(e);
      if (this._tipFor === btn && this._tipPinned) this.hideTip();
      else this.showTip(btn, true);
    });
    tbody.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.hideTip();
      else if (e.key === 'Enter') open(e);
    });
    tbody.addEventListener('pointerover', (e) => {
      const btn = scoreOf(e);
      if (btn && e.pointerType === 'mouse' && !this._tipPinned) this.showTip(btn, false);
    });
    tbody.addEventListener('pointerout', (e) => {
      if (scoreOf(e) && e.pointerType === 'mouse' && !this._tipPinned) this.hideTip();
    });
    tbody.addEventListener('focusin', (e) => { const btn = scoreOf(e); if (btn && !this._tipPinned) this.showTip(btn, false); });
    tbody.addEventListener('focusout', (e) => { if (scoreOf(e) && !this._tipPinned) this.hideTip(); });
    tbody.addEventListener('error', (e) => {
      if (e.target && e.target.tagName === 'IMG') utils.handleImageError(e.target);
    }, true);
    document.addEventListener('click', (e) => {
      if (this._tipFor && !e.target.closest('.np-score, #newpairs-tip')) this.hideTip();
    });
    window.addEventListener('scroll', () => this.hideTip(), { passive: true });
  },

  showTip(btn, pinned) {
    const tip = document.getElementById('newpairs-tip');
    const row = btn.closest('tr[data-mint]');
    const token = row && this.tokens.find(t => t.mint === row.dataset.mint);
    if (!tip || !token) return;
    tip.innerHTML = this.tipHtml(token, this.data && this.data.weights, Date.now());
    tip.hidden = false;
    this._tipFor = btn;
    this._tipPinned = !!pinned;
    // Fixed to the viewport: under the score, or above it when there is no room below.
    const r = btn.getBoundingClientRect();
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    const left = Math.max(8, Math.min(r.left, vw - w - 8));
    const below = r.bottom + 6;
    const top = below + h > vh - 8 && r.top - h - 6 > 8 ? r.top - h - 6 : below;
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
  },

  hideTip() {
    const tip = document.getElementById('newpairs-tip');
    if (tip) tip.hidden = true;
    this._tipFor = null;
    this._tipPinned = false;
  },

  setStatus(text, state) {
    const el = document.getElementById('newpairs-status-text');
    if (!el) return;
    el.textContent = text;
    el.parentElement.classList.remove('loading', 'error');
    if (state) el.parentElement.classList.add(state);
  },

  async loadData() {
    const tbody = document.getElementById('newpairs-table-body');
    if (!tbody || this._loading) return;
    this._loading = true;
    this.hideTip();
    const wanted = this.window;
    document.querySelectorAll('.np-window').forEach(btn => {
      const on = btn.dataset.window === wanted;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    this.setStatus('LOADING...', 'loading');
    tbody.innerHTML = `
      <tr class="loading-row">
        <td colspan="10">
          <div class="loading-state">
            <div class="loading-spinner"></div>
            <span>Loading new pairs...</span>
          </div>
        </td>
      </tr>`;

    try {
      const data = await api.newPairs.list(wanted);
      this.data = data;
      this.tokens = (data && data.tokens) || [];
      this._loadFailed = false;
      this.renderLaunchpads();
      this.render();
    } catch (err) {
      // mainViewTabs reloads on the next tab click while this is set.
      this._loadFailed = true;
      this.setStatus('ERROR', 'error');
      const meta = document.getElementById('newpairs-meta');
      if (meta) meta.textContent = '';
      tbody.innerHTML = tokenTable.emptyRow(10, 'Could not load new pairs', 'Select the tab again to retry.');
    } finally {
      this._loading = false;
    }
  },

  renderLaunchpads() {
    const select = document.getElementById('newpairs-launchpad');
    if (!select) return;
    const pads = this.launchpads(this.tokens);
    if (this.launchpad && !pads.includes(this.launchpad)) this.launchpad = '';
    select.innerHTML = '<option value="">All launchpads</option>' +
      pads.map(p => `<option value="${tokenTable.esc(p)}">${tokenTable.esc(p)}</option>`).join('');
    select.value = this.launchpad;
  },

  render() {
    // Keep the load error up (a search would replace it with "No matches").
    if (this._loadFailed) return;
    const tbody = document.getElementById('newpairs-table-body');
    if (!tbody || !this.data) return;
    this.hideTip();
    const now = Date.now();
    const search = document.getElementById('newpairs-search');
    const query = search ? search.value : '';
    const rows = this.view(this.tokens, {
      query, sort: this.sort, launchpad: this.launchpad, checkedOnly: this.checkedOnly, showRugged: this.showRugged,
    });

    this.setStatus(rows.length ? `${rows.length} PAIR${rows.length !== 1 ? 'S' : ''}` : 'NO PAIRS');
    const meta = document.getElementById('newpairs-meta');
    if (meta) meta.textContent = this.metaText(this.data, rows.length, now);
    const table = tbody.closest('table');
    if (table) table.dataset.sort = this.sort;

    if (rows.length === 0) {
      const filtered = query.trim() || this.launchpad || this.checkedOnly;
      const hiddenRugged = !this.showRugged && this.tokens.some(t => t.rugged);
      tbody.innerHTML = filtered
        ? tokenTable.emptyRow(10, 'No matches', 'No new pair matches the search and filters.')
        : tokenTable.emptyRow(10, 'Nothing here yet', hiddenRugged
          ? 'Every token in this window is marked rugged. Turn on "Show rugged" to see them.'
          : 'No token that bonded in this window is above the floors yet.');
      return;
    }
    // The top-3 highlight means "best score"; under any other order it is a plain row number.
    const ranked = this.sort === 'score';
    tbody.innerHTML = rows.map((t, i) => this.rowHtml(t, i + 1, now, { ranked })).join('');
  },

  /** Re-draw every age on screen from the stored read times. No request. */
  refreshAges() {
    const panel = document.getElementById('view-newpairs');
    if (!panel || panel.style.display === 'none' || !this.data || this._loadFailed) return;
    const now = Date.now();
    panel.querySelectorAll('.np-ages').forEach(el => {
      el.innerHTML = this.agesInner({ market: el.dataset.market, holders: el.dataset.holders, top50: el.dataset.top50 }, now);
    });
    panel.querySelectorAll('.np-bonded').forEach(el => { el.textContent = `bonded ${this.ageText(el.dataset.bonded, now)}`; });
    const meta = document.getElementById('newpairs-meta');
    if (meta) meta.textContent = this.metaText(this.data, panel.querySelectorAll('tr.np-row').length, now);
  },
};
