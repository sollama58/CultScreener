/* global api, utils, newPairsPage */
// Lite page for a New Pairs token that HolDEX has not curated (pair.html?mint=<mint>).
//
// One request, GET /api/new-pairs/:mint, which the server answers from Postgres and a
// one-minute cache. Everything on the page is drawn from that payload: the header, the score
// taken apart, the stored holder and market-cap readings, and the top 50 holders from the last
// holder check. There is no wallet connect, no price polling and no chart or holder request
// here, so nothing a visitor does on this page can make the server call Helius or any other
// upstream. Curated tokens have the full page; this one redirects to it.
//
// Every block says how old its data is, and the ages are re-drawn each minute.
//
// Names, tickers, logos and launchpad labels are creator-written text and go through esc().
// The age limits, age wording and score maths are newPairsPage's (js/newPairs.js), so the tab
// and this page cannot disagree.

const pairDetail = {
  mint: null,
  data: null,
  _tick: null,

  esc(v) {
    return utils.escapeHtml(v == null ? '' : String(v));
  },

  // ── Pure pieces (covered by pairDetail.test.js) ─────────────────────────────────────────

  /** "Read 4m ago", coloured by how old that is for this kind of data. Re-drawn by tick(). */
  age(kind, at, now, prefix = 'Read') {
    const state = newPairsPage.ageState(kind, at, now);
    const text = state === 'none' ? 'Not read yet' : `${prefix} ${newPairsPage.ageText(at, now)} ago`;
    return `<span class="pd-age pd-age--${state}" data-kind="${kind}" data-at="${this.esc(at || '')}" data-prefix="${this.esc(prefix)}">${text}</span>`;
  },

  pct(v, digits = 1) {
    return v == null || !isFinite(v) ? '--' : `${Number(v).toFixed(digits)}%`;
  },

  signed(v, digits = 1) {
    if (v == null || !isFinite(v)) return '<span class="pd-dim">--</span>';
    const tone = v > 0 ? 'up' : v < 0 ? 'down' : 'flat';
    return `<span class="pd-chg ${tone}">${v > 0 ? '+' : ''}${Number(v).toFixed(digits)}%</span>`;
  },

  /**
   * One series as an SVG line. points: [{t, v}] oldest first; readings without a value are
   * skipped. Returns null when there are fewer than two, so the caller can say so instead of
   * drawing a dot.
   */
  line(points, w = 600, h = 120, pad = 4) {
    const pts = (points || []).filter(p => p && isFinite(p.t) && p.v != null && isFinite(p.v));
    if (pts.length < 2) return null;
    const t0 = pts[0].t;
    const t1 = pts[pts.length - 1].t;
    let min = Infinity;
    let max = -Infinity;
    pts.forEach(p => { if (p.v < min) min = p.v; if (p.v > max) max = p.v; });
    const spanT = t1 - t0 || 1;
    const spanV = max - min || 1;
    const x = p => pad + ((p.t - t0) / spanT) * (w - 2 * pad);
    // A flat series sits in the middle rather than on the floor
    const y = p => (max === min ? h / 2 : pad + (1 - (p.v - min) / spanV) * (h - 2 * pad));
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p).toFixed(1)} ${y(p).toFixed(1)}`).join(' ');
    return { d, min, max, first: pts[0], last: pts[pts.length - 1], count: pts.length, w, h };
  },

  chart(title, points, format, now) {
    const l = this.line(points);
    if (!l) {
      return `<div class="pd-chart"><div class="pd-chart-head"><h3>${title}</h3></div><p class="tp-empty">Not enough readings yet. One is stored about every hour for the first three days, then every three hours.</p></div>`;
    }
    const change = l.first.v > 0 ? (l.last.v / l.first.v - 1) * 100 : null;
    return `
      <div class="pd-chart">
        <div class="pd-chart-head"><h3>${title}</h3><span class="num">${format(l.last.v)} ${this.signed(change)}</span></div>
        <svg viewBox="0 0 ${l.w} ${l.h}" preserveAspectRatio="none" role="img" aria-label="${title}: ${l.count} readings, from ${format(l.first.v)} to ${format(l.last.v)}"><path d="${l.d}"/></svg>
        <div class="pd-chart-foot"><span>${newPairsPage.ageText(new Date(l.first.t).toISOString(), now)} ago</span><span>low ${format(l.min)} · high ${format(l.max)} · ${l.count} readings</span>${this.age('reading', new Date(l.last.t).toISOString(), now, 'Last reading')}</div>
      </div>`;
  },

  heroHtml(t, now) {
    const esc = v => this.esc(v);
    const fallback = utils.getDefaultLogo();
    const logo = utils.proxyImageUrl(t.logo) || fallback;
    const name = t.name || utils.truncateAddress(t.mint);
    const chips = [];
    if (t.launchpad) chips.push(`<span class="tp-pill">${esc(t.launchpad)}</span>`);
    if (t.graduatedAt) chips.push(`<span class="tp-pill" title="${esc(new Date(t.graduatedAt).toLocaleString())}">Bonded <span class="pd-rel" data-at="${esc(t.graduatedAt)}">${newPairsPage.ageText(t.graduatedAt, now)}</span> ago</span>`);
    if (t.rugged) chips.push('<span class="tp-pill pd-pill-bad" title="Down 80% from its peak since bonding, or liquidity under the floor">Rugged</span>');
    const m = encodeURIComponent(t.mint);
    return `
      <section class="tp-panel tp-hero">
        <div class="tp-hero-top">
          <div class="tp-identity">
            <img id="pair-logo" class="tp-logo" src="${esc(logo)}" data-fallback="${esc(fallback)}" alt="" width="56" height="56">
            <div class="tp-identity-text">
              <div class="tp-name-row"><h1>${esc(name)}</h1>${t.symbol ? `<span class="tp-symbol">$${esc(t.symbol)}</span>` : ''}</div>
              <div class="tp-address-row">
                <span class="tp-address num">${esc(t.mint)}</span>
                <button type="button" id="pair-copy" class="tp-icon-btn" title="Copy address" aria-label="Copy address">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                </button>
              </div>
              <div class="pd-chips">${chips.join('')}</div>
            </div>
          </div>
          <div class="tp-price-block">
            <div class="tp-price-row"><span class="tp-price num">${utils.formatPrice(t.price, 6)}</span>${this.signed(t.priceChange24h)}</div>
            <div class="pd-age-line">${this.age('market', t.at && t.at.market, now)}</div>
          </div>
        </div>
        <div class="tp-actions">
          <a href="https://jup.ag/swap/SOL-${m}" target="_blank" rel="noopener" class="tp-btn tp-btn-primary">Trade on Jupiter</a>
          <a href="https://solscan.io/token/${m}" target="_blank" rel="noopener" class="tp-btn">Solscan</a>
          <a href="https://app.bubblemaps.io/sol/token/${m}" target="_blank" rel="noopener" class="tp-btn">Bubblemaps</a>
        </div>
      </section>
      <p class="pd-notice"><strong>Not curated by HolDEX.</strong> This token was found automatically because it left a launchpad's bonding curve in the last 14 days. The score is a reading of its holder data, not an endorsement, and new tokens can go to zero.</p>`;
  },

  kpisHtml(t, now) {
    const at = t.at || {};
    const kpi = (label, value, age) => `
      <div class="tp-panel tp-kpi"><span class="tp-eyebrow">${label}</span><span class="tp-kpi-value num">${value}</span>${age}</div>`;
    const holders = t.holders ? Number(t.holders).toLocaleString() : '--';
    return `<div class="tp-kpis">
      ${kpi('Market cap', utils.formatNumber(t.marketCap, '$'), this.age('market', at.market, now))}
      ${kpi('24h volume', utils.formatNumber(t.volume24h, '$'), this.age('market', at.market, now))}
      ${kpi('Liquidity', utils.formatNumber(t.liquidity, '$'), this.age('market', at.market, now))}
      ${kpi('Holders', `${holders} ${this.signed(t.holdersChange24h)}`, this.age('holders', at.holders, now))}
    </div>`;
  },

  scoreHtml(t, weights, now) {
    const b = newPairsPage.breakdown(t, weights);
    const f2 = v => (v == null || !isFinite(v) ? '--' : Number(v).toFixed(2));
    const f1 = v => (v == null || !isFinite(v) ? '--' : Number(v).toFixed(1));
    const state = { holders_pending: 'Top 50 holders not checked yet, so retention, spread and dev holding are not in this score.', holders_stale: 'The last top-50 holder check is over 14 hours old.' }[t.scoreState] || '';
    const rows = b.lines.map(l => `
      <tr>
        <th scope="row">${this.esc(l.label)}</th>
        <td class="pd-bar-cell"><span class="pd-bar"><i style="width:${Math.round(Math.max(0, Math.min(1, l.value)) * 100)}%"></i></span></td>
        <td class="num">${f2(l.value)}</td>
        <td class="num pd-dim">${l.weight == null ? '' : `× ${f1(l.weight).replace(/\.0$/, '')}`}</td>
        <td class="num">${l.points == null ? '' : f1(l.points)}</td>
      </tr>`).join('');
    const missing = b.missing.map(m => `
      <tr class="pd-row-missing"><th scope="row">${this.esc(m.label)}</th><td colspan="4">${newPairsPage.TOP50_TERMS.includes(m.key) ? 'waiting for a top-50 holder check' : 'not enough data yet'}</td></tr>`).join('');
    const reasons = b.reasons.length
      ? this.esc(b.reasons.map(r => `${r.reason} (×${f2(r.factor)})`).join('; '))
      : 'no flags';
    return `
      <section class="tp-panel">
        <div class="tp-section-head">
          <div><span class="tp-eyebrow">Emerging cult score</span><h2>How the score is built</h2></div>
          ${this.age('market', t.at && t.at.scored, now, 'Scored')}
        </div>
        <div class="pd-score-top">
          <span class="pd-score num">${t.score == null ? '--' : f1(t.score)}</span>
          <span class="pd-score-of">of 100${t.rank ? ` · #${Number(t.rank)} among tokens bonded in the last 14 days` : ''}</span>
        </div>
        ${state ? `<p class="pd-state">${state}</p>` : ''}
        <table class="pd-terms">
          <thead><tr><th scope="col">Signal</th><th scope="col"></th><th scope="col">Value</th><th scope="col">Weight</th><th scope="col">Points</th></tr></thead>
          <tbody>${rows}${missing}</tbody>
        </table>
        <dl class="pd-mults">
          <div><dt>Quality</dt><dd class="num">${f2(b.quality)}</dd><dd class="pd-dim">${b.quality == null ? '' : `${f1(b.points)} of ${f1(b.available).replace(/\.0$/, '')} points that have data`}</dd></div>
          <div><dt>× Confidence</dt><dd class="num">${f2(b.confidence)}</dd><dd class="pd-dim">${b.confidence != null && b.confidence < 1 ? 'young token; full weight 72 hours after bonding' : 'bonded 72 hours or more ago'}</dd></div>
          <div><dt>× Risk</dt><dd class="num">${f2(b.risk)}</dd><dd class="pd-dim">${reasons}</dd></div>
        </dl>
      </section>`;
  },

  trendHtml(series, now) {
    const s = series || [];
    return `
      <section class="tp-panel">
        <div class="tp-section-head"><div><span class="tp-eyebrow">Since bonding</span><h2>Holders and market cap</h2></div></div>
        ${this.chart('Holders', s.map(p => ({ t: p.t, v: p.holders })), v => Math.round(v).toLocaleString(), now)}
        ${this.chart('Market cap', s.map(p => ({ t: p.t, v: p.marketCap })), v => utils.formatNumber(v, '$'), now)}
      </section>`;
  },

  holdersHtml(t, top, samples, now) {
    top = top || {};
    const list = top.holders || [];
    const head = `
        <div class="tp-section-head">
          <div><span class="tp-eyebrow">Top 50 holders</span><h2>Who holds it</h2></div>
          ${this.age('top50', top.sampledAt, now, 'Checked')}
        </div>`;
    if (!list.length) {
      return `<section class="tp-panel">${head}<p class="tp-empty">The top 50 holders have not been checked yet. Only the 50 best-scoring new pairs are checked, about every 12 hours.</p></section>`;
    }
    const compared = top.previousSampledAt
      ? `Changes are since the check before, ${newPairsPage.ageText(top.previousSampledAt, now)} ago.`
      : 'This is the first check, so there is nothing to compare with yet.';
    const stat = (label, value) => `<div><dt>${label}</dt><dd class="num">${value}</dd></div>`;
    const rows = list.map(h => `
      <tr>
        <td class="num pd-dim">${Number(h.rank)}</td>
        <td><a class="num" href="https://solscan.io/account/${encodeURIComponent(h.wallet)}" target="_blank" rel="noopener">${this.esc(utils.truncateAddress(h.wallet, 4, 4))}</a>${h.isNew ? ' <span class="pd-new">new</span>' : ''}</td>
        <td class="num text-right">${this.pct(h.pct, 2)}</td>
        <td class="num text-right">${h.isNew ? '<span class="pd-dim">--</span>' : this.signed(h.changePct)}</td>
      </tr>`).join('');
    const exited = (top.exited || []).length
      ? `<p class="pd-exited"><strong>Left the top holders since the check before:</strong> ${top.exited.map(w => `<a class="num" href="https://solscan.io/account/${encodeURIComponent(w)}" target="_blank" rel="noopener">${this.esc(utils.truncateAddress(w, 4, 4))}</a>`).join(', ')}</p>`
      : '';
    const history = (samples || []).filter(s => s.complete).slice(0, 8);
    const historyRows = history.map(s => `
      <tr><td>${newPairsPage.ageText(s.at, now)} ago</td><td class="num text-right">${s.holders == null ? '--' : Number(s.holders).toLocaleString()}</td><td class="num text-right">${this.pct(s.top10Pct)}</td><td class="num text-right">${this.pct(s.top50Pct)}</td><td class="num text-right">${s.retention12h == null ? '--' : this.pct(s.retention12h * 100, 0)}</td></tr>`).join('');
    return `
      <section class="tp-panel">
        ${head}
        <dl class="pd-stats">
          ${stat('Top 10 hold', this.pct(t.top10Pct))}
          ${stat('Top 50 hold', this.pct(t.top50Pct))}
          ${stat('Dev holds', this.pct(t.devPct))}
          ${stat('Still holding after 12h', t.retention12h == null ? '--' : this.pct(t.retention12h * 100, 0))}
        </dl>
        <p class="pd-note">Share of supply. Pools, the bonding curve and burn addresses are left out. ${compared}</p>
        <div class="pd-table-wrap">
          <table class="pd-holders">
            <thead><tr><th scope="col">#</th><th scope="col">Wallet</th><th scope="col" class="text-right">Share</th><th scope="col" class="text-right">Change</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        ${exited}
        ${history.length > 1 ? `
        <h3 class="pd-subhead">Earlier checks</h3>
        <div class="pd-table-wrap"><table class="pd-holders">
          <thead><tr><th scope="col">Checked</th><th scope="col" class="text-right">Holders</th><th scope="col" class="text-right">Top 10</th><th scope="col" class="text-right">Top 50</th><th scope="col" class="text-right">Retention</th></tr></thead>
          <tbody>${historyRows}</tbody>
        </table></div>` : ''}
      </section>`;
  },

  pageHtml(payload, now) {
    const t = payload.token;
    return `
      ${this.heroHtml(t, now)}
      ${this.kpisHtml(t, now)}
      <div class="tp-columns pd-columns">
        <div class="tp-stack">${this.scoreHtml(t, payload.weights, now)}${this.trendHtml(payload.series, now)}</div>
        <div class="tp-stack">${this.holdersHtml(t, payload.topHolders, payload.samples, now)}</div>
      </div>`;
  },

  // ── Page ────────────────────────────────────────────────────────────────────────────────

  show(id) {
    ['pair-loading', 'pair-error', 'pair-content'].forEach(k => {
      const el = document.getElementById(k);
      if (el) el.style.display = k === id ? '' : 'none';
    });
  },

  fail(title, message) {
    const t = document.getElementById('pair-error-title');
    const m = document.getElementById('pair-error-message');
    if (t) t.textContent = title;
    if (m) m.textContent = message;
    this.show('pair-error');
  },

  async init() {
    const mint = new URLSearchParams(window.location.search).get('mint') || '';
    if (!utils.isValidSolanaAddress(mint)) return this.fail('Token not found', 'This link has no valid token address.');
    this.mint = mint;
    let payload;
    try {
      payload = await api.newPairs.token(mint);
    } catch (err) {
      if (err && err.code === 'NOT_LISTED') {
        return this.fail('Not in New Pairs', 'This token is not listed. Tokens leave the list 14 days after bonding, or when they fall under the market cap and liquidity floors.');
      }
      if (err && err.code === 'NEWPAIRS_DISABLED') return this.fail('Not available yet', 'New Pairs is not open yet.');
      return this.fail('Could not load this token', 'Please try again in a moment.');
    }
    // A curated token has the full page
    if (payload && payload.curated) {
      window.location.replace(`token.html?mint=${encodeURIComponent(mint)}`);
      return;
    }
    if (!payload || !payload.token) return this.fail('Could not load this token', 'Please try again in a moment.');
    this.data = payload;
    const root = document.getElementById('pair-content');
    root.innerHTML = this.pageHtml(payload, Date.now());
    const t = payload.token;
    // textContent, so a creator-written name cannot inject markup into the title either
    document.title = `${t.symbol ? `$${t.symbol}` : (t.name || 'Token')} - New Pairs - HolDEX`;
    const copy = document.getElementById('pair-copy');
    if (copy) copy.addEventListener('click', () => utils.copyToClipboard(mint));
    const logo = document.getElementById('pair-logo');
    if (logo) logo.addEventListener('error', () => utils.handleImageError(logo, logo.dataset.fallback));
    this.show('pair-content');
    this._tick = setInterval(() => this.tick(), 60 * 1000);
  },

  /** Re-draw every age on the page from its stored time. No request. */
  tick() {
    const now = Date.now();
    document.querySelectorAll('#pair-content .pd-age').forEach(el => {
      const at = el.dataset.at || null;
      const state = newPairsPage.ageState(el.dataset.kind, at, now);
      el.className = `pd-age pd-age--${state}`;
      el.textContent = state === 'none' ? 'Not read yet' : `${el.dataset.prefix} ${newPairsPage.ageText(at, now)} ago`;
    });
    document.querySelectorAll('#pair-content .pd-rel').forEach(el => { el.textContent = newPairsPage.ageText(el.dataset.at, now); });
  },
};

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => pairDetail.init());
}
