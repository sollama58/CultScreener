/* global api, utils */
// Shared row markup and behaviour for the home page token tables (Diamond Hands, Tech, Emerging,
// Performance, vs SOL). Each view used to build its own token cell, distribution bars and click
// handling, and bound one listener per cell on every render (seven per row, 700 on a full page).
// Rows now carry data-mint and one delegated listener per table opens the token page.

const tokenTable = {
  // Past this, a score is old enough that the reader should be told before trusting it. The worker
  // re-stores every curated token's score hourly, so a day without one means it has fallen behind.
  STALE_CONVICTION_MS: 24 * 60 * 60 * 1000,

  esc(v) {
    return utils.escapeHtml(v == null ? '' : String(v));
  },

  mintOf(token) {
    return token.mintAddress || token.address || '';
  },

  // Token cell: logo, name with tag badges, $SYMBOL underneath.
  tokenCell(token, opts = {}) {
    const address = this.mintOf(token);
    const fallback = utils.getDefaultLogo();
    const logo = utils.proxyImageUrl(token.logoUri || token.logoURI) || fallback;
    const name = token.name || `${address.slice(0, 4)}...${address.slice(-4)}`;
    const symbol = token.symbol || address.slice(0, 5).toUpperCase();
    const badges = opts.badges === false ? '' : this.badges(token);
    return `
      <td class="cell-token">
        <div class="tt-token">
          <img class="tt-logo" src="${this.esc(logo)}" alt="" width="32" height="32" loading="lazy" decoding="async" data-fallback="${this.esc(fallback)}">
          <div class="tt-token-text">
            <div class="tt-name-line"><span class="tt-name">${this.esc(name)}</span>${badges}</div>
            <span class="tt-symbol">$${this.esc(symbol)}</span>
          </div>
        </div>
      </td>`;
  },

  // King of the Pill: the banner's featured token gets a pill chip first after its name in
  // every table. The mint arrives from one shared request (api.kingOfPill); rows rendered
  // before it lands are patched by markKing, later renders include it from badges().
  _king: null,

  isKing(mint) {
    return !!(this._king && mint && this._king.mintAddress === mint);
  },

  kingChip() {
    return '<span class="tt-tag tt-king" title="King of the Pill">💊</span>';
  },

  markKing(root = document) {
    root.querySelectorAll('.tt-king').forEach(el => {
      const row = el.closest('tr[data-mint]');
      if (!row || !this.isKing(row.dataset.mint)) el.remove();
    });
    if (!this._king) return;
    const sel = `tr[data-mint="${(window.CSS && CSS.escape) ? CSS.escape(this._king.mintAddress) : this._king.mintAddress}"] .tt-name`;
    root.querySelectorAll(sel).forEach(name => {
      if (!name.parentElement.querySelector('.tt-king')) name.insertAdjacentHTML('afterend', this.kingChip());
    });
  },

  badges(token) {
    let html = '';
    if (this.isKing(this.mintOf(token))) html += this.kingChip();
    if (token.emergingCult) html += '<span class="tt-tag" title="Emerging Cult">🔨</span>';
    if (token.techCoin) html += '<span class="tt-tag" title="Tech Coin">🤖</span>';
    html += this.ageChip(token);
    return html;
  },

  // Token age chip after the name: compact age (5h, 12d, 3mo, 1y), launch date on hover.
  ageChip(token) {
    const short = utils.formatAgeShort(token.pairCreatedAt);
    if (!short) return '';
    const date = new Date(token.pairCreatedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    return `<span class="tt-age" title="${this.esc(`Token age ${utils.formatAge(token.pairCreatedAt)} · launched ${date}`)}">${this.esc(short)}</span>`;
  },

  // plain: a row number for a list in random order (Tech, Emerging), without the top-3 highlight
  // that would present a random pick as #1.
  rankCell(rank, opts = {}) {
    const top = !opts.plain && rank <= 3;
    return `<td class="cell-rank"><span class="tt-rank${top ? ' tt-rank-top' : ''}">${rank}</span></td>`;
  },

  dash() {
    return '<span class="tt-na">--</span>';
  },

  // Signed percent. pill: tinted chip for the column a view is about.
  pct(value, opts = {}) {
    if (value == null || !isFinite(value)) return this.dash();
    const tone = value >= 0 ? 'up' : 'down';
    const digits = opts.digits != null ? opts.digits : 2;
    const text = `${value >= 0 ? '+' : ''}${value.toFixed(digits)}%`;
    const title = opts.title ? ` title="${this.esc(opts.title)}"` : '';
    return `<span class="tt-pct ${tone}${opts.pill ? ' tt-pill' : ''}"${title}>${text}</span>`;
  },

  athPct(token) {
    if (token.mcapAtAdded == null || !(token.mcapAtAdded > 0) || token.mcapAth == null) return null;
    return ((token.mcapAth - token.mcapAtAdded) / token.mcapAtAdded) * 100;
  },

  athCell(token) {
    const pct = this.athPct(token);
    if (pct == null) return this.dash();
    return this.pct(pct, { digits: 0, pill: true, title: `ATH MCap: ${utils.formatNumber(token.mcapAth, '$')}` });
  },

  // The ATH pill again, under the price: phones hide the ATH column (styles.css, max-width 768px)
  // and home.css shows this copy there instead. Nothing when the token has no ATH figure.
  athStack(token) {
    if (this.athPct(token) == null) return '';
    return `<span class="tt-ath-stack">${this.athCell(token)}</span>`;
  },

  holders(token) {
    return token.holders ? `<span class="num">${Number(token.holders).toLocaleString()}</span>` : this.dash();
  },

  // Price change column (Diamond Hands 24h/7d/30d): plain signed percent, whole numbers once
  // the move is three digits so a pump doesn't widen the column.
  change(value, label) {
    if (value == null || !isFinite(value)) {
      return `<span class="tt-na" title="${this.esc(`No ${label} price history yet`)}">--</span>`;
    }
    return this.pct(value, { digits: Math.abs(value) >= 100 ? 0 : 1, title: `${label} price change` });
  },

  // Holder count with a velocity mark from the 24h holder change (holderCounts.holderVelocity on
  // the server): two arrows fast, one arrow moving, a dash for flat. A token without a snapshot
  // about a day back gets the dash drawn fainter.
  VELOCITY_GLYPHS: {
    2: '<path d="M2.5 5.5 6 2l3.5 3.5M2.5 10 6 6.5l3.5 3.5"/>',
    1: '<path d="M2.5 7.75 6 4.25l3.5 3.5"/>',
    0: '<path d="M3 6h6"/>',
    '-1': '<path d="M2.5 4.25 6 7.75l3.5-3.5"/>',
    '-2': '<path d="M2.5 2 6 5.5 9.5 2M2.5 6.5 6 10l3.5-3.5"/>',
  },
  VELOCITY_WORDS: { 2: 'Rising fast', 1: 'Rising', 0: 'Flat', '-1': 'Falling', '-2': 'Falling fast' },

  velocity(token) {
    const v = token.holderVelocity || {};
    const known = Number.isInteger(v.level) && this.VELOCITY_GLYPHS[v.level] != null;
    const level = known ? v.level : 0;
    const tone = level > 0 ? 'up' : level < 0 ? 'down' : 'flat';
    let tip;
    if (known) {
      const sign = v.delta > 0 ? '+' : '';
      tip = `${this.VELOCITY_WORDS[level]}: ${sign}${Number(v.delta).toLocaleString()} holders (${sign}${v.pct}%) in ${v.hours}h`;
    } else {
      tip = 'Not enough holder history for a 24h trend yet';
    }
    return `<svg class="tt-vel ${tone}${known ? '' : ' none'}" viewBox="0 0 12 12" width="12" height="12" role="img" aria-label="${this.esc(tip)}"><title>${this.esc(tip)}</title>${this.VELOCITY_GLYPHS[level]}</svg>`;
  },

  holdersWithVelocity(token) {
    if (!token.holders) return this.dash();
    return `<span class="tt-holders">${this.velocity(token)}<span class="num">${Number(token.holders).toLocaleString()}</span></span>`;
  },

  // Diamond hands cell: the share of holders who have held 3 months or more, with the 1 month+
  // share beside it, over one bar on a fixed 0-100% scale split by how long holders have held.
  // The buckets are cumulative ("held at least X"), so each segment is the difference between
  // neighbouring buckets; whatever is left at the right is holders under a day.
  //
  // A token younger than 3 months cannot have 3-month holders, so it gets "Newer token" instead of
  // a 0%. Pool creation is the age we have; a migrated token's pool can be younger than the token,
  // so any 3-month holders at all overrule it.
  DH_SEGMENTS: [
    { key: '3m', label: '3mo+', tone: 's5' },
    { key: '1m', label: '1-3mo', tone: 's4' },
    { key: '1w', label: '1w-1mo', tone: 's3' },
    { key: '24h', label: '1d-1w', tone: 's2' },
  ],
  NEW_TOKEN_MS: 90 * 24 * 60 * 60 * 1000,

  pctOf(dist, key) {
    const v = dist[key];
    return typeof v === 'number' && isFinite(v) ? Math.min(100, Math.max(0, v)) : null;
  },

  isNewerToken(token, dist) {
    if (this.pctOf(dist, '3m') > 0) return false;
    const created = token.pairCreatedAt ? new Date(token.pairCreatedAt).getTime() : NaN;
    return isFinite(created) && Date.now() - created < this.NEW_TOKEN_MS;
  },

  dhCell(token) {
    const dist = token.conviction || {};
    const has = this.DH_SEGMENTS.some(seg => this.pctOf(dist, seg.key) != null);
    if (!has) return this.dash();

    const updatedAt = token.convictionUpdatedAt;
    const ageMs = updatedAt ? Date.now() - new Date(updatedAt).getTime() : null;
    const hasAge = ageMs != null && isFinite(ageMs) && ageMs >= 0;
    const stale = hasAge && ageMs > this.STALE_CONVICTION_MS;
    const newer = this.isNewerToken(token, dist);

    let prev = 0;
    const tips = [];
    const segs = this.DH_SEGMENTS.map(seg => {
      const v = this.pctOf(dist, seg.key);
      if (v == null) return '';
      const w = Math.max(0, v - prev);
      prev = Math.max(prev, v);
      tips.push(`${seg.label}: ${w.toFixed(1)}%`);
      return w > 0 ? `<i class="tt-dh-seg ${seg.tone}" style="width:${w.toFixed(1)}%"></i>` : '';
    }).join('');
    tips.push(`under 1d: ${Math.max(0, 100 - prev).toFixed(1)}%`);
    if (hasAge) tips.push(`Scored ${utils.formatAge(updatedAt)} ago${stale ? ' (stale)' : ''}`);

    const m3 = this.pctOf(dist, '3m');
    const m1 = this.pctOf(dist, '1m');
    let top;
    if (newer) {
      const age = utils.formatAge(token.pairCreatedAt);
      top = `<span class="tt-dh-new">Newer token</span><span class="tt-dh-sub">${this.esc(age)} old</span>`;
      tips.unshift('Under 3 months old, so nobody can have held 3 months yet');
    } else {
      top = `<span class="tt-dh-num">${m3 == null ? '--' : `${Math.round(m3)}%`}</span>`
        + (m1 != null ? `<span class="tt-dh-sub">${Math.round(m1)}% 1mo+</span>` : '');
    }

    // Not the bare "stale" class: styles.css section 30 stamps a STALE label on anything carrying it.
    const cls = `tt-dh${newer ? ' tt-dh--new' : ''}${stale ? ' tt-dh--stale' : ''}`;
    return `<div class="${cls}" title="${this.esc(tips.join('\n'))}">
          <div class="tt-dh-top">${top}</div>
          <div class="tt-dh-bar">${segs}</div>
        </div>`;
  },

  emptyRow(colspan, title, message) {
    return `
      <tr class="empty-row">
        <td colspan="${colspan}">
          <div class="tt-empty">
            <strong>${this.esc(title)}</strong>
            <span>${this.esc(message)}</span>
          </div>
        </td>
      </tr>`;
  },

  // One listener per table body: open the token page for the clicked row, with Enter for keyboard
  // users, and retry or swap broken logos (error does not bubble, so it is caught on the way
  // down). Safe to call on every render.
  bind(tbody) {
    if (!tbody || tbody._ttBound) return;
    tbody._ttBound = true;
    const open = (e) => {
      const row = e.target.closest('tr[data-mint]');
      if (!row || !tbody.contains(row)) return;
      if (e.target.closest('a, button, input')) return;
      const mint = row.dataset.mint;
      if (!mint) return;
      if (e.metaKey || e.ctrlKey) {
        window.open(`token.html?mint=${encodeURIComponent(mint)}`, '_blank', 'noopener');
      } else {
        window.location.href = `token.html?mint=${encodeURIComponent(mint)}`;
      }
    };
    tbody.addEventListener('click', open);
    tbody.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(e); });
    tbody.addEventListener('error', (e) => {
      const img = e.target;
      if (img && img.tagName === 'IMG') utils.handleImageError(img);
    }, true);
  },

  rowAttrs(token) {
    return `class="token-row tt-row" data-mint="${this.esc(this.mintOf(token))}" tabindex="0"`;
  },

  // Sortable column headers that keyboards can reach: each <th> is focusable and Enter or Space
  // sorts like a click. setSortState puts aria-sort on the active one for screen readers.
  bindSortHeader(th, onSort) {
    th.tabIndex = 0;
    th.addEventListener('click', onSort);
    th.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      onSort();
    });
  },

  setSortState(th, dir) {
    if (dir) th.setAttribute('aria-sort', dir === 'asc' ? 'ascending' : 'descending');
    else th.removeAttribute('aria-sort');
  },

  // Every curated token on the conviction leaderboard. The server caps a page at 100 rows, so a
  // single page silently dropped every token past the 100th once more were curated; this reads
  // the following pages until it has `total`. The first page is the same cached request all the
  // home tabs share. options.fresh bypasses the client cache (api.tokens.leaderboardConviction).
  BOARD_PAGE: 100,
  BOARD_MAX_PAGES: 20,

  async loadBoard(options = {}) {
    const page = this.BOARD_PAGE;
    const first = await api.tokens.leaderboardConviction({ limit: page, offset: 0 }, options);
    const tokens = [...(first?.tokens || [])]; // copy: the cached array is shared
    const total = Number(first?.total) || 0;
    const rest = [];
    for (let offset = page; offset < total && offset < page * this.BOARD_MAX_PAGES; offset += page) {
      rest.push(api.tokens.leaderboardConviction({ limit: page, offset }, options));
    }
    if (rest.length) {
      // Rows can shift between pages while scores update; keep each mint once.
      const seen = new Set(tokens.map(t => t.mintAddress));
      (await Promise.all(rest)).forEach(r => (r?.tokens || []).forEach(t => {
        if (seen.has(t.mintAddress)) return;
        seen.add(t.mintAddress);
        tokens.push(t);
      }));
    }
    return { tokens, total: Math.max(total, tokens.length) };
  },
};

if (typeof api !== 'undefined' && api.kingOfPill) {
  api.kingOfPill().then(token => { tokenTable._king = token; tokenTable.markKing(); });
}
