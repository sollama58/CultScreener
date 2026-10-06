/* global utils */
// Shared row markup and behaviour for the home page token tables (Diamond Hands, Tech, Emerging,
// Performance, vs SOL). Each view used to build its own token cell, distribution bars and click
// handling, and bound one listener per cell on every render (seven per row, 700 on a full page).
// Rows now carry data-mint and one delegated listener per table opens the token page.

const tokenTable = {
  BUCKETS: ['6h', '24h', '3d', '1w', '1m'],

  // Past this, a score is old enough that the reader should be told before trusting it.
  STALE_CONVICTION_MS: 7 * 24 * 60 * 60 * 1000,

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

  badges(token) {
    let html = '';
    if (token.emergingCult) html += '<span class="tt-tag" title="Emerging Cult">🔨</span>';
    if (token.techCoin) html += '<span class="tt-tag" title="Tech Coin">🤖</span>';
    return html;
  },

  rankCell(rank) {
    return `<td class="cell-rank"><span class="tt-rank${rank <= 3 ? ' tt-rank-top' : ''}">${rank}</span></td>`;
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

  holders(token) {
    return token.holders ? `<span class="num">${Number(token.holders).toLocaleString()}</span>` : this.dash();
  },

  // The domain the bars are drawn against, derived from the rows actually on screen.
  //
  // Drawn against a fixed 0-100 scale, a table sorted by conviction put every bar in the top 2px.
  // The floor keeps that fix from overcorrecting: below a 10-point spread the scale stays 10 points
  // wide and the bars stay close together, which is the truth.
  scale(tokens) {
    const MIN_SPAN = 10;
    let lo = Infinity;
    let hi = -Infinity;
    (tokens || []).forEach(t => {
      const dist = (t && t.conviction) || {};
      this.BUCKETS.forEach(k => {
        const v = dist[k];
        if (typeof v === 'number' && isFinite(v)) {
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      });
    });
    if (!isFinite(lo) || !isFinite(hi)) return { base: 0, span: 100 };
    const span = Math.max(hi - lo, MIN_SPAN);
    return { base: Math.max(0, hi - span), span };
  },

  // Five bars, one per hold-time bucket (6h -> 1m). Height and tone track the same position on the
  // page's scale; the exact percentage is in each bar's tooltip and the bucket names are in the
  // column header, not repeated on every row.
  distBars(token, scale) {
    const dist = token.conviction || {};
    if (Object.keys(dist).length === 0) return this.dash();
    const s = (scale && scale.span > 0) ? scale : { base: 0, span: 100 };
    const updatedAt = token.convictionUpdatedAt;
    const ageMs = updatedAt ? Date.now() - new Date(updatedAt).getTime() : null;
    const hasAge = ageMs != null && isFinite(ageMs) && ageMs >= 0;
    const stale = hasAge && ageMs > this.STALE_CONVICTION_MS;
    const title = hasAge ? ` title="Scored ${this.esc(utils.formatAge(updatedAt))} ago${stale ? ' (stale)' : ''}"` : '';
    const bars = this.BUCKETS.map(k => {
      const val = typeof dist[k] === 'number' ? dist[k] : 0;
      const pos = Math.min(1, Math.max(0, (val - s.base) / s.span));
      const tone = pos >= 0.66 ? 'hi' : pos >= 0.33 ? 'mid' : 'lo';
      const h = Math.max(8, Math.round(pos * 100));
      return `<i class="tt-bar ${tone}" style="height:${h}%" title="${k}: ${val.toFixed(1)}%"></i>`;
    }).join('');
    return `<div class="tt-bars${stale ? ' stale' : ''}"${title}>${bars}</div>`;
  },

  // Header label for the distribution column: the first and last bucket names, spanning the bars.
  distHeader() {
    return '<span class="tt-dist-head">Conviction<span class="tt-dist-legend"><i>6h</i><i>1m</i></span></span>';
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
};
