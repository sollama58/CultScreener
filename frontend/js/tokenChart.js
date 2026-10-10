// Token page chart modal: candlestick chart drawn with TradingView Lightweight Charts
// (vendored in js/vendor, loaded the first time the modal opens). Candles come from our own
// /api/tokens/:mint/ohlcv endpoint, which caches GeckoTerminal's OHLCV for the token's top pool.
const tokenChart = (() => {
  const LIB_SRC = 'js/vendor/lightweight-charts-5.2.1.js';
  const PREFS_KEY = 'holdex.tokenChart.v1';
  const REFRESH_MS = 60 * 1000;
  const TIMEFRAMES = [
    { id: '1m', label: '1m', seconds: 60 },
    { id: '5m', label: '5m', seconds: 300 },
    { id: '15m', label: '15m', seconds: 900 },
    { id: '1h', label: '1h', seconds: 3600 },
    { id: '4h', label: '4h', seconds: 14400 },
    { id: '1d', label: '1D', seconds: 86400 },
    { id: '1w', label: '1W', seconds: 604800 }
  ];
  const INDICATORS = [
    { id: 'vol', label: 'Volume', title: 'Volume bars' },
    { id: 'ma20', label: 'MA 20', title: '20-period simple moving average' },
    { id: 'ema50', label: 'EMA 50', title: '50-period exponential moving average' },
    { id: 'bb', label: 'BB 20', title: 'Bollinger Bands (20, 2)' },
    { id: 'rsi', label: 'RSI 14', title: 'Relative Strength Index (14)' },
    { id: 'holders', label: 'Holders', title: 'Holder count on the left scale (one point per holder snapshot)' }
  ];
  // Holders line look: color, opacity, and whether it rides on the price chart or gets its own pane
  const HOLDERS_SWATCHES = ['#22d3ee', '#60a5fa', '#a78bfa', '#f472b6', '#fb923c', '#facc15', '#4ade80', '#f1f5f9'];
  const DEFAULT_HSTYLE = { color: '#22d3ee', opacity: 1, pane: 'overlay' };
  const DEFAULT_PREFS = { tf: '15m', unit: 'price', style: 'candles', log: false, ind: { vol: true, ma20: false, ema50: false, bb: false, rsi: false, holders: false }, hstyle: DEFAULT_HSTYLE };

  let libPromise = null;
  let state = null; // live modal state; null while closed

  // ── Prefs (per-viewer convenience only) ────────────────────────────────
  function loadPrefs() {
    try {
      const saved = JSON.parse(localStorage.getItem(PREFS_KEY) || 'null');
      if (saved && typeof saved === 'object') {
        return { ...DEFAULT_PREFS, ...saved, ind: { ...DEFAULT_PREFS.ind, ...(saved.ind || {}) }, hstyle: normalizeHStyle(saved.hstyle) };
      }
    } catch { /* storage blocked or bad JSON */ }
    return { ...DEFAULT_PREFS, ind: { ...DEFAULT_PREFS.ind }, hstyle: { ...DEFAULT_HSTYLE } };
  }
  // Stored values are only a convenience: anything unexpected falls back to the default
  function normalizeHStyle(h) {
    const out = { ...DEFAULT_HSTYLE };
    if (!h || typeof h !== 'object') return out;
    if (typeof h.color === 'string' && /^#[0-9a-f]{6}$/i.test(h.color)) out.color = h.color.toLowerCase();
    const op = Number(h.opacity);
    if (isFinite(op)) out.opacity = Math.min(1, Math.max(0.1, Math.round(op * 100) / 100));
    if (h.pane === 'overlay' || h.pane === 'pane') out.pane = h.pane;
    return out;
  }
  function hexToRgba(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }
  function holdersColor(prefs) {
    const h = prefs.hstyle;
    return h.opacity >= 1 ? h.color : hexToRgba(h.color, h.opacity);
  }
  function savePrefs(prefs) {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* ignore */ }
  }

  // ── Library loader ─────────────────────────────────────────────────────
  function loadLib() {
    if (window.LightweightCharts) return Promise.resolve(window.LightweightCharts);
    if (libPromise) return libPromise;
    libPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = LIB_SRC;
      s.async = true;
      s.onload = () => window.LightweightCharts ? resolve(window.LightweightCharts) : reject(new Error('Chart library failed to load'));
      s.onerror = () => { libPromise = null; s.remove(); reject(new Error('Chart library failed to load')); };
      document.head.appendChild(s);
    });
    return libPromise;
  }

  // ── Formatting ─────────────────────────────────────────────────────────
  const SUBSCRIPT = '₀₁₂₃₄₅₆₇₈₉';
  function toSubscript(n) { return String(n).split('').map(d => SUBSCRIPT[+d] || d).join(''); }

  // Memecoin prices run to 10+ decimals; collapse long zero runs as 0.0₅1234 like DEX screeners do
  function fmtValue(v) {
    if (v == null || !isFinite(v)) return '--';
    const sign = v < 0 ? '-' : '';
    const a = Math.abs(v);
    if (a === 0) return '0';
    if (a >= 1e9) return `${sign}${(a / 1e9).toFixed(2)}B`;
    if (a >= 1e6) return `${sign}${(a / 1e6).toFixed(2)}M`;
    if (a >= 1e4) return `${sign}${(a / 1e3).toFixed(2)}K`;
    if (a >= 1) return sign + a.toLocaleString(undefined, { maximumFractionDigits: a >= 10 ? 2 : 4 });
    let zeros = Math.max(0, -Math.floor(Math.log10(a)) - 1);
    let scaled = zeros >= 4 ? Math.round(a * Math.pow(10, zeros + 4)) : 0;
    // Rounding can carry into a fifth digit (0.0000999997 -> 10000): that is one zero fewer
    if (scaled >= 10000) { zeros -= 1; scaled = Math.round(scaled / 10); }
    if (zeros >= 4) {
      const digits = scaled.toString().slice(0, 4).replace(/0+$/, '') || '0';
      return `${sign}0.0${toSubscript(zeros)}${digits}`;
    }
    return sign + a.toPrecision(4).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  }
  function fmtVolume(v) {
    if (v == null || !isFinite(v)) return '--';
    if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
    if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
    if (v >= 1e3) return `${(v / 1e3).toFixed(2)}K`;
    return v.toFixed(0);
  }
  function fmtPct(p) {
    if (p == null || !isFinite(p)) return '';
    return `${p >= 0 ? '+' : ''}${p.toFixed(2)}%`;
  }
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // Lightweight Charts draws times in UTC; format them in the viewer's own time zone
  function fmtTimeFull(t) {
    const d = new Date(t * 1000);
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  function fmtTick(t, tickType) {
    const d = new Date(t * 1000);
    // TickMarkType: 0 Year, 1 Month, 2 DayOfMonth, 3 Time, 4 TimeWithSeconds
    // Lightweight Charts places Year/Month/Day ticks on UTC boundaries, so label those
    // in UTC too: in local time a tick on Oct 1 00:00 UTC reads "Sep" west of UTC.
    // Time-of-day ticks stay in the viewer's zone, like the crosshair label.
    if (tickType === 0) return String(d.getUTCFullYear());
    if (tickType === 1) return d.toLocaleString(undefined, { month: 'short', timeZone: 'UTC' });
    if (tickType === 2) return d.toLocaleString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }

  function cssVar(name, fallback) {
    try {
      const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return v || fallback;
    } catch { return fallback; }
  }

  // ── Indicator math ─────────────────────────────────────────────────────
  function sma(candles, n) {
    const out = [];
    let sum = 0;
    for (let i = 0; i < candles.length; i++) {
      sum += candles[i].close;
      if (i >= n) sum -= candles[i - n].close;
      if (i >= n - 1) out.push({ time: candles[i].time, value: sum / n });
    }
    return out;
  }
  function ema(candles, n) {
    const out = [];
    if (candles.length < n) return out;
    const k = 2 / (n + 1);
    let prev = 0;
    for (let i = 0; i < n; i++) prev += candles[i].close;
    prev /= n;
    out.push({ time: candles[n - 1].time, value: prev });
    for (let i = n; i < candles.length; i++) {
      prev = candles[i].close * k + prev * (1 - k);
      out.push({ time: candles[i].time, value: prev });
    }
    return out;
  }
  function bollinger(candles, n = 20, mult = 2) {
    const upper = [], lower = [], mid = [];
    for (let i = n - 1; i < candles.length; i++) {
      let sum = 0;
      for (let j = i - n + 1; j <= i; j++) sum += candles[j].close;
      const mean = sum / n;
      let sq = 0;
      for (let j = i - n + 1; j <= i; j++) sq += (candles[j].close - mean) ** 2;
      const sd = Math.sqrt(sq / n);
      const time = candles[i].time;
      mid.push({ time, value: mean });
      upper.push({ time, value: mean + mult * sd });
      lower.push({ time, value: Math.max(0, mean - mult * sd) });
    }
    return { upper, mid, lower };
  }
  // Wilder's RSI
  function rsi(candles, n = 14) {
    const out = [];
    if (candles.length <= n) return out;
    let gain = 0, loss = 0;
    for (let i = 1; i <= n; i++) {
      const d = candles[i].close - candles[i - 1].close;
      if (d >= 0) gain += d; else loss -= d;
    }
    gain /= n; loss /= n;
    const val = () => (loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss));
    out.push({ time: candles[n].time, value: val() });
    for (let i = n + 1; i < candles.length; i++) {
      const d = candles[i].close - candles[i - 1].close;
      gain = (gain * (n - 1) + Math.max(d, 0)) / n;
      loss = (loss * (n - 1) + Math.max(-d, 0)) / n;
      out.push({ time: candles[i].time, value: val() });
    }
    return out;
  }

  // GeckoTerminal sends newest first and can repeat a bucket; sort ascending and keep the last copy
  function normalizeCandles(raw, factor) {
    const byTime = new Map();
    for (const c of raw || []) {
      const time = Math.floor(Number(c.timestamp) / 1000);
      const o = Number(c.open), h = Number(c.high), l = Number(c.low), cl = Number(c.close);
      if (!time || ![o, h, l, cl].every(v => isFinite(v) && v > 0)) continue;
      byTime.set(time, {
        time,
        open: o * factor,
        high: h * factor,
        low: l * factor,
        close: cl * factor,
        volume: Number(c.volume) || 0
      });
    }
    return [...byTime.values()].sort((a, b) => a.time - b.time);
  }

  // Price scale step: about four significant digits below the smallest visible value
  // Holder count at each candle: the latest count taken by the candle's close. Counts come
  // every few hours, so this is a step line; candles before the first count get none.
  function holdersPerCandle(candles, points, tfSec) {
    const out = [];
    let i = 0, cur = null;
    for (const c of candles) {
      while (i < points.length && points[i][0] <= c.time + tfSec) { cur = points[i][1]; i++; }
      if (cur != null) out.push({ time: c.time, value: cur });
    }
    return out;
  }

  function minMoveFor(candles) {
    let min = Infinity;
    for (const c of candles) if (c.low > 0 && c.low < min) min = c.low;
    if (!isFinite(min)) return 0.01;
    return Math.min(0.01, Math.pow(10, Math.floor(Math.log10(min)) - 3));
  }

  // ── Modal shell ────────────────────────────────────────────────────────
  function seg(name, items, current, label) {
    return `<div class="tp-seg" role="group" aria-label="${esc(label)}" data-seg="${name}">${items.map(it =>
      `<button type="button" data-val="${esc(it.id)}" class="${it.id === current ? 'on' : ''}" aria-pressed="${it.id === current}"${it.disabled ? ' disabled' : ''}${it.title ? ` title="${esc(it.title)}"` : ''}>${esc(it.label)}</button>`
    ).join('')}</div>`;
  }

  function shellHtml(info, prefs, canMcap) {
    // No inline onerror: the site CSP refuses inline handlers. open() attaches it.
    const logo = info.logo ? `<img class="tc-logo" src="${esc(info.logo)}" alt="" width="28" height="28">` : '';
    return `
      <div class="tc-modal" role="dialog" aria-modal="true" aria-labelledby="tc-title">
        <div class="tc-head">
          <div class="tc-title-wrap">
            ${logo}
            <div>
              <div class="tc-title" id="tc-title">${esc(info.symbol ? '$' + info.symbol : info.name || 'Token')} <span class="tc-title-sub">${esc(info.name && info.symbol && info.name.toLowerCase() !== info.symbol.toLowerCase() ? info.name : '')}</span></div>
              <div class="tc-last"><span class="tc-last-value num" id="tc-last">--</span> <span class="tc-last-change num" id="tc-change"></span></div>
            </div>
          </div>
          <div class="tc-head-tools">
            ${typeof chartShot !== 'undefined' ? `
            <button type="button" class="tc-close" data-shot="copy" title="Copy chart image" aria-label="Copy chart image">${chartShot.ICONS.copy}</button>
            <button type="button" class="tc-close" data-shot="download" title="Download chart image" aria-label="Download chart image">${chartShot.ICONS.download}</button>` : ''}
            <button type="button" class="tc-close" id="tc-close" aria-label="Close chart">&times;</button>
          </div>
        </div>
        <div class="tc-toolbar">
          ${seg('tf', TIMEFRAMES, prefs.tf, 'Timeframe')}
          <div class="tc-toolbar-more">
          ${seg('unit', [{ id: 'price', label: 'Price' }, { id: 'mcap', label: 'MCap', disabled: !canMcap, title: canMcap ? 'Market cap (price × supply)' : 'Market cap needs supply data' }], prefs.unit, 'Value')}
          ${seg('style', [{ id: 'candles', label: 'Candles' }, { id: 'line', label: 'Line' }], prefs.style, 'Chart style')}
          <div class="tc-toggles" role="group" aria-label="Indicators">
            ${INDICATORS.map(ind => `<button type="button" class="tc-chip${prefs.ind[ind.id] ? ' on' : ''}" data-ind="${ind.id}" aria-pressed="${!!prefs.ind[ind.id]}" title="${esc(ind.title)}">${esc(ind.label)}</button>${ind.id === 'holders' ? hstyleBtnHtml(prefs) : ''}`).join('')}
            <button type="button" class="tc-chip${prefs.log ? ' on' : ''}" data-log aria-pressed="${!!prefs.log}" title="Logarithmic price scale">Log</button>
            <button type="button" class="tc-chip" data-fit title="Show all candles">Reset</button>
          </div>
          </div>
        </div>
        ${hstylePanelHtml(prefs)}
        <div class="tc-legend num" id="tc-legend" aria-live="off"></div>
        <div class="tc-body">
          <div class="tc-rail" role="toolbar" aria-label="Drawing tools">
            <button type="button" class="tc-tool" data-draw="trend" aria-pressed="false" title="Trendline: click two points">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="5" y1="19" x2="19" y2="5"/><circle cx="5" cy="19" r="2" fill="currentColor"/><circle cx="19" cy="5" r="2" fill="currentColor"/></svg>
              <span>Trend</span>
            </button>
            <button type="button" class="tc-tool" data-draw="fib" aria-pressed="false" title="Fibonacci retracement: click the start, then the end of a move">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="4" x2="21" y2="4"/><line x1="3" y1="9" x2="21" y2="9" opacity=".7"/><line x1="3" y1="13" x2="21" y2="13" opacity=".7"/><line x1="3" y1="16.5" x2="21" y2="16.5" opacity=".7"/><line x1="3" y1="20" x2="21" y2="20"/></svg>
              <span>Fib</span>
            </button>
            <span class="tc-rail-gap"></span>
            <button type="button" class="tc-tool" data-del disabled title="Delete the selected drawing (Delete key)">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
              <span>Delete</span>
            </button>
            <button type="button" class="tc-tool" data-clear disabled title="Remove all drawings on this token">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              <span>Clear</span>
            </button>
          </div>
          <div class="tc-chart-wrap">
            <div class="tc-chart" id="tc-chart"></div>
            <div class="tc-hint" id="tc-hint" hidden></div>
            <div class="tc-overlay-msg" id="tc-msg"><div class="tc-spinner" aria-hidden="true"></div><span>Loading chart...</span></div>
          </div>
        </div>
        <div class="tc-foot">
          <span>Candles from the token's top pool via GeckoTerminal. Times in your local time zone.</span>
          <a href="https://www.tradingview.com/lightweight-charts/" target="_blank" rel="noopener">Charting by TradingView</a>
        </div>
      </div>`;
  }

  function hstyleBtnHtml(prefs) {
    return `<button type="button" class="tc-chip tc-hstyle-btn" data-hstyle-toggle aria-expanded="false" aria-controls="tc-hstyle"${prefs.ind.holders ? '' : ' hidden'} title="Holders line color, transparency and placement" aria-label="Holders line style"><i class="tc-hstyle-dot" style="background:${holdersColor(prefs)}" aria-hidden="true"></i><svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`;
  }
  function hstylePanelHtml(prefs) {
    const h = prefs.hstyle;
    const pct = Math.round(h.opacity * 100);
    return `
        <div class="tc-hstyle" id="tc-hstyle" role="group" aria-label="Holders line style" hidden>
          <div class="tc-hstyle-row">
            <span class="tc-hstyle-label">Color</span>
            <div class="tc-swatches">
              ${HOLDERS_SWATCHES.map(c => `<button type="button" class="tc-swatch${c === h.color ? ' on' : ''}" data-hcolor="${c}" style="--sw:${c}" aria-pressed="${c === h.color}" aria-label="Color ${c}" title="${c}"></button>`).join('')}
              <label class="tc-swatch tc-swatch-custom${HOLDERS_SWATCHES.includes(h.color) ? '' : ' on'}" title="Pick any color">
                <input type="color" data-hcolor-input value="${esc(h.color)}" aria-label="Custom color">
              </label>
            </div>
          </div>
          <div class="tc-hstyle-row">
            <label class="tc-hstyle-label" for="tc-hopacity">Opacity</label>
            <input type="range" id="tc-hopacity" class="tc-hrange" data-hopacity min="10" max="100" step="5" value="${pct}">
            <span class="tc-hstyle-val num" id="tc-hopacity-val">${pct}%</span>
          </div>
          <div class="tc-hstyle-row">
            <span class="tc-hstyle-label">Placement</span>
            ${seg('hpane', [{ id: 'overlay', label: 'On chart', title: 'Draw the holder count over the price chart' }, { id: 'pane', label: 'Own pane', title: 'Draw the holder count in a separate pane under the price chart' }], h.pane, 'Holders placement')}
          </div>
        </div>`;
  }

  function tokenInfo() {
    const t = (typeof tokenDetail !== 'undefined' && tokenDetail.token) || {};
    const mint = (typeof tokenDetail !== 'undefined' && tokenDetail.mint) || utils.getUrlParam('mint');
    const price = Number(t.price);
    const mcap = Number(t.marketCap || t.mcap);
    // Implied circulating supply, so the chart can switch to market cap like the KPI card
    const supplyFactor = price > 0 && mcap > 0 ? mcap / price : null;
    return {
      mint,
      name: t.name || '',
      symbol: t.symbol || '',
      // Reuse the hero logo, which already went through the image proxy and fallbacks
      logo: document.getElementById('token-logo')?.getAttribute('src') || '',
      supplyFactor
    };
  }

  function setMsg(text, { loading = false, retry = false } = {}) {
    const el = state?.root.querySelector('#tc-msg');
    if (!el) return;
    if (!text) { el.hidden = true; return; }
    el.hidden = false;
    el.innerHTML = `${loading ? '<div class="tc-spinner" aria-hidden="true"></div>' : ''}<span>${esc(text)}</span>${retry ? '<button type="button" class="tp-btn" data-retry>Try again</button>' : ''}`;
  }

  // ── Chart building ─────────────────────────────────────────────────────
  function buildChart(LWC) {
    const el = state.root.querySelector('#tc-chart');
    const ink2 = cssVar('--ink-2', '#aab1c2');
    const grid = cssVar('--grid', '#232735');
    const axis = cssVar('--axis', '#343a4b');
    const chart = LWC.createChart(el, {
      autoSize: true,
      layout: {
        background: { type: 'solid', color: 'transparent' },
        textColor: ink2,
        fontFamily: cssVar('--mono', 'JetBrains Mono, monospace'),
        fontSize: 11,
        attributionLogo: true,
        panes: { separatorColor: axis, separatorHoverColor: 'rgba(255,255,255,0.08)' }
      },
      grid: { vertLines: { color: grid }, horzLines: { color: grid } },
      rightPriceScale: { borderColor: axis },
      timeScale: { borderColor: axis, timeVisible: true, secondsVisible: false, rightOffset: 4, tickMarkFormatter: fmtTick },
      crosshair: { mode: 0 },
      localization: { priceFormatter: fmtValue, timeFormatter: fmtTimeFull }
    });
    state.chart = chart;
    state.LWC = LWC;
    state.series = {};
    chart.subscribeCrosshairMove(param => renderLegend(param));
    bindDrawPointer(el, chart);
  }

  // Drawing input. Lightweight Charts' own click events drop a second click that lands soon
  // after the first (it waits to see a double click), so taps and clicks are read straight
  // from pointer events on the chart instead.
  function bindDrawPointer(el, chart) {
    let down = null;
    const toParam = e => {
      const r = el.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      let paneW = r.width, paneH = r.height;
      try { paneW = chart.timeScale().width(); paneH = chart.paneSize(0).height; } catch { /* use the box */ }
      if (x < 0 || y < 0 || x > paneW || y > paneH) return null; // price scale, time axis or RSI pane
      return { point: { x, y }, paneIndex: 0 };
    };
    el.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      down = { x: e.clientX, y: e.clientY, at: Date.now(), id: e.pointerId };
    });
    el.addEventListener('pointerup', e => {
      const d = down;
      down = null;
      if (!d || d.id !== e.pointerId || !state?.draw) return;
      // A tap or click, not the end of a pan
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 8 || Date.now() - d.at > 700) return;
      const param = toParam(e);
      if (param) state.draw.handleClick(param, e.pointerType === 'touch');
    });
    el.addEventListener('pointercancel', () => { down = null; });
    el.addEventListener('pointermove', e => {
      if (!state?.draw?.placing || e.pointerType === 'touch') return;
      const param = toParam(e);
      if (param) state.draw.handleMove(param);
    });
  }

  function isCoarse() {
    try { return window.matchMedia('(pointer: coarse)').matches; } catch { return false; }
  }

  // ── Drawing tools (chartDrawings.js) ───────────────────────────────────
  function tfSeconds() {
    return (TIMEFRAMES.find(t => t.id === state?.prefs.tf) || TIMEFRAMES[2]).seconds;
  }
  function displayFactor() {
    return state?.prefs.unit === 'mcap' && state.info.supplyFactor ? state.info.supplyFactor : 1;
  }
  function createDrawings(mint) {
    if (typeof chartDrawings === 'undefined') return null;
    return chartDrawings.create({
      storageKey: `holdex.tokenChart.drawings.${mint}`,
      getCandles: () => state?.candles || [],
      getTfSeconds: tfSeconds,
      getFactor: displayFactor,
      formatValue: fmtValue,
      onChange: renderDrawTools
    });
  }
  function renderDrawTools() {
    if (!state) return;
    const d = state.draw;
    const root = state.root;
    root.querySelectorAll('[data-draw]').forEach(b => {
      const on = !!d && d.tool === b.dataset.draw;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    });
    const del = root.querySelector('[data-del]');
    const clr = root.querySelector('[data-clear]');
    if (del) del.disabled = !d?.selectedId;
    if (clr) clr.disabled = !d?.count;
    const hint = root.querySelector('#tc-hint');
    if (!hint) return;
    const verb = isCoarse() ? 'Tap' : 'Click';
    let text = '';
    if (d?.tool === 'trend') text = d.placing ? `${verb} the second point` : `${verb} the start of the trendline`;
    else if (d?.tool === 'fib') text = d.placing ? `${verb} the end of the move (level 0)` : `${verb} the start of the move (level 1)`;
    else if (d?.selectedId) text = 'Drawing selected. Delete removes it.';
    hint.textContent = text;
    hint.hidden = !text;
    root.querySelector('.tc-chart-wrap')?.classList.toggle('is-drawing', !!d?.tool);
  }

  function clearSeries() {
    const { chart, series } = state;
    state.draw?.detach();
    for (const key of Object.keys(series)) {
      try { chart.removeSeries(series[key]); } catch { /* already gone */ }
    }
    state.series = {};
    // Drop the RSI pane (removing its series leaves an empty pane behind)
    try { while (chart.panes().length > 1) chart.removePane(chart.panes().length - 1); } catch { /* older API */ }
  }

  function render(fit) {
    if (!state?.chart) return;
    const { chart, LWC, prefs, raw } = state;
    const factor = prefs.unit === 'mcap' && state.info.supplyFactor ? state.info.supplyFactor : 1;
    const prevLen = state.candles.length;
    const candles = normalizeCandles(raw, factor);
    state.candles = candles;
    let prevRange = fit ? null : chart.timeScale().getVisibleLogicalRange();
    // A refresh that adds candles keeps the view pinned to the newest one, as long as it was in view
    if (prevRange && prevLen && candles.length > prevLen && prevRange.to >= prevLen - 1) {
      const added = candles.length - prevLen;
      prevRange = { from: prevRange.from + added, to: prevRange.to + added };
    }

    clearSeries();
    if (candles.length === 0) {
      setMsg('No trades in this timeframe yet.');
      renderHeader();
      return;
    }
    setMsg(null);

    const up = cssVar('--good-ink', '#4ade80');
    const down = cssVar('--bad-ink', '#ff8080');
    const priceFormat = { type: 'custom', formatter: fmtValue, minMove: factor === 1 ? minMoveFor(candles) : 0.01 };
    chart.priceScale('right').applyOptions({ mode: prefs.log ? 1 : 0, scaleMargins: { top: 0.08, bottom: prefs.ind.vol ? 0.22 : 0.06 } });

    if (prefs.style === 'line') {
      const s = chart.addSeries(LWC.AreaSeries, {
        lineColor: cssVar('--brand-b', '#3b82f6'),
        topColor: 'rgba(59,130,246,0.28)',
        bottomColor: 'rgba(59,130,246,0)',
        lineWidth: 2,
        priceFormat
      });
      s.setData(candles.map(c => ({ time: c.time, value: c.close })));
      state.series.main = s;
    } else {
      const s = chart.addSeries(LWC.CandlestickSeries, {
        upColor: up, downColor: down, borderUpColor: up, borderDownColor: down, wickUpColor: up, wickDownColor: down,
        priceFormat
      });
      s.setData(candles.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })));
      state.series.main = s;
    }
    state.draw?.attach(chart, state.series.main);

    if (prefs.ind.vol) {
      const v = chart.addSeries(LWC.HistogramSeries, {
        priceScaleId: 'vol',
        priceFormat: { type: 'custom', formatter: fmtVolume, minMove: 1 },
        lastValueVisible: false,
        priceLineVisible: false
      });
      v.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      v.setData(candles.map(c => ({ time: c.time, value: c.volume, color: c.close >= c.open ? 'rgba(74,222,128,0.35)' : 'rgba(255,128,128,0.35)' })));
      state.series.vol = v;
    }

    const line = (color, data, extra = {}) => {
      const s = chart.addSeries(LWC.LineSeries, { color, lineWidth: 1.5, priceFormat, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false, ...extra });
      s.setData(data);
      return s;
    };
    if (prefs.ind.ma20) state.series.ma20 = line('#fab219', sma(candles, 20));
    if (prefs.ind.ema50) state.series.ema50 = line('#c084fc', ema(candles, 50));
    if (prefs.ind.bb) {
      const bb = bollinger(candles, 20, 2);
      state.series.bbU = line('rgba(57,135,229,0.8)', bb.upper);
      state.series.bbM = line('rgba(57,135,229,0.45)', bb.mid, { lineStyle: 2 });
      state.series.bbL = line('rgba(57,135,229,0.8)', bb.lower);
    }
    // The holder pane sits right under the price chart, RSI below it (holders are added first:
    // a series can only open the pane right after the last one)
    const holderPane = prefs.ind.holders && prefs.hstyle.pane === 'pane' && state.holders?.length
      ? holdersPerCandle(candles, state.holders, tfSeconds()) : null;
    const holdersInPane = !!holderPane?.length;
    const showHolders = prefs.ind.holders && state.holders?.length;
    // Phones have no room for a second axis: the overlay line gets its own hidden scale and
    // the legend carries the number. In its own pane the line uses that pane's right axis.
    const holderAxis = !holdersInPane && holderAxisFits();
    chart.priceScale('left').applyOptions({ visible: !!showHolders && holderAxis, borderVisible: false, scaleMargins: { top: 0.08, bottom: prefs.ind.vol ? 0.22 : 0.06 } });
    if (showHolders) {
      const data = holderPane || holdersPerCandle(candles, state.holders, tfSeconds());
      if (data.length) {
        const h = chart.addSeries(LWC.LineSeries, {
          priceScaleId: holdersInPane ? 'right' : holderAxis ? 'left' : 'holders', color: holdersColor(prefs), lineWidth: 2, lineType: 1, lastValueVisible: true, priceLineVisible: false,
          crosshairMarkerVisible: false, priceFormat: { type: 'custom', formatter: fmtVolume, minMove: 1 }
        }, holdersInPane ? 1 : 0);
        if (holdersInPane) h.priceScale().applyOptions({ scaleMargins: { top: 0.12, bottom: 0.08 } });
        else if (!holderAxis) h.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: prefs.ind.vol ? 0.22 : 0.06 } });
        h.setData(data);
        state.series.holders = h;
      }
    } else if (prefs.ind.holders && state.holders == null) {
      fetchHolders();
    }
    if (prefs.ind.rsi) {
      const rsiPane = holdersInPane ? 2 : 1;
      const r = chart.addSeries(LWC.LineSeries, {
        color: '#b9a6ff', lineWidth: 1.5, priceLineVisible: false,
        priceFormat: { type: 'price', precision: 1, minMove: 0.1 },
        autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } })
      }, rsiPane);
      r.setData(rsi(candles, 14));
      r.createPriceLine({ price: 70, color: 'rgba(255,128,128,0.5)', lineWidth: 1, lineStyle: 2, axisLabelVisible: false });
      r.createPriceLine({ price: 30, color: 'rgba(74,222,128,0.5)', lineWidth: 1, lineStyle: 2, axisLabelVisible: false });
      state.series.rsi = r;
    }

    try {
      const panes = chart.panes();
      panes[0].setStretchFactor(1);
      for (let i = 1; i < panes.length; i++) panes[i].setStretchFactor(holdersInPane && i === 1 ? 0.32 : 0.28);
    } catch { /* ignore */ }

    if (prevRange) chart.timeScale().setVisibleLogicalRange(prevRange);
    else showRecent();
    renderHeader();
    renderLegend(null);
  }

  function holderAxisFits() {
    return (state.root.querySelector('#tc-chart')?.clientWidth || 0) >= 600;
  }
  function holdersInOwnPane() {
    return !!state.series.holders && state.prefs.hstyle.pane === 'pane';
  }

  // Open on the most recent ~150 candles; Reset zooms out to everything we have
  function showRecent() {
    const n = state.candles.length;
    if (n > 150) state.chart.timeScale().setVisibleLogicalRange({ from: n - 150, to: n + 4 });
    else state.chart.timeScale().fitContent();
  }

  function renderHeader() {
    const lastEl = state.root.querySelector('#tc-last');
    const chEl = state.root.querySelector('#tc-change');
    const c = state.candles;
    if (!c || c.length === 0) { lastEl.textContent = '--'; chEl.textContent = ''; return; }
    const last = c[c.length - 1].close;
    const first = c[0].open;
    lastEl.textContent = `$${fmtValue(last)}`;
    const pct = first > 0 ? ((last - first) / first) * 100 : null;
    const tf = TIMEFRAMES.find(t => t.id === state.prefs.tf);
    const spanLabel = tf ? spanText(c.length * tf.seconds) : '';
    chEl.textContent = pct == null ? '' : `${fmtPct(pct)} ${spanLabel}`;
    chEl.className = `tc-last-change num ${pct >= 0 ? 'is-good' : 'is-bad'}`;
  }
  function spanText(sec) {
    if (sec >= 86400 * 2) return `over ${Math.round(sec / 86400)}d`;
    if (sec >= 3600 * 2) return `over ${Math.round(sec / 3600)}h`;
    return `over ${Math.round(sec / 60)}m`;
  }

  function renderLegend(param) {
    const el = state?.root.querySelector('#tc-legend');
    if (!el || !state.candles?.length) { if (el) el.innerHTML = ''; return; }
    let c = null;
    if (param && param.time != null) c = state.candles.find(x => x.time === param.time);
    if (!c) c = state.candles[state.candles.length - 1];
    const cls = c.close >= c.open ? 'is-good' : 'is-bad';
    const chg = c.open > 0 ? ((c.close - c.open) / c.open) * 100 : null;
    // Each part is its own span: the legend is a flex row, which would drop the space after "O"
    const parts = [
      `<span class="tc-lg-time">${esc(fmtTimeFull(c.time))}</span>`,
      `<span>O&nbsp;<b class="${cls}">${fmtValue(c.open)}</b></span>`,
      `<span>H&nbsp;<b class="${cls}">${fmtValue(c.high)}</b></span>`,
      `<span>L&nbsp;<b class="${cls}">${fmtValue(c.low)}</b></span>`,
      `<span>C&nbsp;<b class="${cls}">${fmtValue(c.close)}</b></span>`,
      chg != null ? `<span><b class="${cls}">${fmtPct(chg)}</b></span>` : '',
      `<span>Vol&nbsp;<b>$${fmtVolume(c.volume)}</b></span>`
    ];
    const p = state.prefs.ind;
    const pick = key => {
      const s = state.series[key];
      if (!s || !param?.seriesData) return null;
      const d = param.seriesData.get(s);
      return d && d.value != null ? d.value : null;
    };
    // Holders stays named in the legend while not hovering: the latest count
    const holdersNow = () => {
      const s = state.series.holders;
      if (!s) return null;
      const v = param?.seriesData ? pick('holders') : null;
      if (v != null) return v;
      const all = s.data();
      return all.length ? all[all.length - 1].value : null;
    };
    if (param?.seriesData) {
      if (p.ma20 && pick('ma20') != null) parts.push(`<span class="tc-lg-ma">MA20&nbsp;${fmtValue(pick('ma20'))}</span>`);
      if (p.ema50 && pick('ema50') != null) parts.push(`<span class="tc-lg-ema">EMA50&nbsp;${fmtValue(pick('ema50'))}</span>`);
      if (p.rsi && pick('rsi') != null) parts.push(`<span class="tc-lg-rsi">RSI&nbsp;${pick('rsi').toFixed(1)}</span>`);
    }
    // Text keeps the full color so it stays readable when the line itself is faint
    const hs = state.prefs.hstyle;
    if (p.holders && holdersNow() != null) parts.push(`<span class="tc-lg-holders" style="color:${hs.color}"><i class="tc-lg-key" style="background:${holdersColor(state.prefs)}" aria-hidden="true"></i>Holders&nbsp;${Math.round(holdersNow()).toLocaleString()}</span>`);
    if (p.holders && state.holders && !state.series.holders) parts.push(`<span class="tc-lg-holders" style="color:${hs.color}">Holders: no count in this range yet</span>`);
    el.innerHTML = parts.filter(Boolean).join('<span class="tc-lg-gap"></span>');
  }

  // ── Data ───────────────────────────────────────────────────────────────
  const FULL_LIMIT = 1000;
  const TAIL_LIMIT = 100;

  // Background refreshes fetch only the newest TAIL_LIMIT candles and fold them into the
  // ones we have (newer values win, same FULL_LIMIT window). Returns null when the tail
  // does not reach back to our newest candle, so the caller reloads the full window.
  // The tail is served from its own server cache entry, which can be older than the one
  // the full window came from (hour/day TTL is 5 min): a tail that ends before our newest
  // candle is ignored, and a tail candle with less volume than ours is an earlier snapshot
  // of the same bucket, so ours is kept.
  function mergeTail(raw, tail) {
    if (!tail.length) return raw;
    const ts = (c) => Number(c.timestamp);
    const newest = raw.reduce((m, c) => Math.max(m, ts(c) || 0), 0);
    const oldestTail = tail.reduce((m, c) => Math.min(m, ts(c) || Infinity), Infinity);
    const newestTail = tail.reduce((m, c) => Math.max(m, ts(c) || 0), 0);
    if (!(oldestTail <= newest)) return null;
    if (newestTail < newest) return raw;
    const byTime = new Map();
    for (const c of raw) byTime.set(ts(c), c);
    for (const c of tail) {
      const have = byTime.get(ts(c));
      if (have && (Number(c.volume) || 0) < (Number(have.volume) || 0)) continue;
      byTime.set(ts(c), c);
    }
    return [...byTime.values()].sort((a, b) => ts(a) - ts(b)).slice(-FULL_LIMIT);
  }

  async function fetchCandles({ quiet = false, full = false } = {}) {
    if (!state) return;
    const owner = state;
    const tf = state.prefs.tf;
    const seq = ++state.fetchSeq;
    // Closed, reopened, or a newer timeframe was picked while this request was in flight
    const stale = () => state !== owner || seq !== owner.fetchSeq;
    const tail = quiet && !full && state.lastTf === tf && state.raw.length > 0;
    if (!quiet) setMsg('Loading chart...', { loading: true });
    try {
      const limit = tail ? TAIL_LIMIT : FULL_LIMIT;
      const res = await api.request(`/api/tokens/${encodeURIComponent(state.info.mint)}/ohlcv?interval=${tf}&limit=${limit}`, { retries: 2, timeout: 20000 });
      if (stale()) return;
      const data = Array.isArray(res?.data) ? res.data : [];
      if (tail) {
        const merged = mergeTail(state.raw, data);
        if (!merged) return fetchCandles({ quiet: true, full: true });
        if (merged === state.raw) return; // nothing new
        state.raw = merged;
      } else {
        state.raw = data;
      }
      const fit = state.lastTf !== tf;
      state.lastTf = tf;
      render(fit);
    } catch (err) {
      if (stale()) return;
      if (quiet && state.candles?.length) return; // keep the chart we have on a failed background refresh
      const msg = err?.code === 'NOT_CURATED'
        ? 'Charts are available for listed tokens only.'
        : 'Could not load chart data right now.';
      setMsg(msg, { retry: err?.code !== 'NOT_CURATED' });
    }
  }

  // Holder count history for the Holders overlay, fetched once per open
  async function fetchHolders() {
    if (!state || state.holdersLoading) return;
    const owner = state;
    owner.holdersLoading = true;
    try {
      const res = await api.request(`/api/tokens/${encodeURIComponent(owner.info.mint)}/holder-count?range=all`, { retries: 1, timeout: 20000 });
      const s = res?.series?.holders || {};
      const pts = [...(s.est || []), ...(s.actual || [])].map(p => [p[0], p[1]]).sort((a, b) => a[0] - b[0]);
      if (state !== owner) return;
      owner.holders = pts;
    } catch {
      if (state !== owner) return;
      owner.holders = [];
    } finally {
      owner.holdersLoading = false;
    }
    if (state === owner) render(false);
  }

  function scheduleRefresh() {
    clearInterval(state.refreshTimer);
    state.refreshTimer = setInterval(() => {
      if (document.visibilityState === 'visible') fetchCandles({ quiet: true });
    }, REFRESH_MS);
  }

  // ── Open / close ───────────────────────────────────────────────────────
  async function open() {
    if (state) return;
    const info = tokenInfo();
    if (!info.mint) return;
    const prefs = loadPrefs();
    if (!TIMEFRAMES.some(t => t.id === prefs.tf)) prefs.tf = DEFAULT_PREFS.tf;
    if (prefs.unit === 'mcap' && !info.supplyFactor) prefs.unit = 'price';

    const root = document.createElement('div');
    root.className = 'tc-overlay';
    root.id = 'tc-overlay';
    root.innerHTML = shellHtml(info, prefs, !!info.supplyFactor);
    const logoImg = root.querySelector('.tc-logo');
    if (logoImg) logoImg.addEventListener('error', () => logoImg.remove(), { once: true });
    document.body.appendChild(root);
    document.body.classList.add('tc-open');
    state = { root, info, prefs, raw: [], candles: [], fetchSeq: 0, lastTf: null, chart: null, series: {}, opener: document.activeElement };
    state.draw = createDrawings(info.mint);
    renderDrawTools();
    requestAnimationFrame(() => root.classList.add('tc-overlay--visible'));

    root.addEventListener('click', onClick);
    root.addEventListener('input', onInput);
    root.addEventListener('change', onInput);
    document.addEventListener('keydown', onKey);
    root.querySelector('#tc-close').focus();

    try {
      const LWC = await loadLib();
      if (!state || state.root !== root) return;
      buildChart(LWC);
      await fetchCandles();
      if (state && state.root === root) scheduleRefresh();
    } catch (err) {
      if (state && state.root === root) setMsg('Could not load the chart. Check your connection and try again.', { retry: true });
    }
  }

  function close() {
    if (!state) return;
    const { root, chart, refreshTimer, opener } = state;
    clearInterval(refreshTimer);
    document.removeEventListener('keydown', onKey);
    try { chart?.remove(); } catch { /* ignore */ }
    root.remove();
    document.body.classList.remove('tc-open');
    state = null;
    if (opener && typeof opener.focus === 'function') opener.focus();
  }

  function onKey(e) {
    if (!state) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      // First Escape closes the style panel or drops the active tool or selection; the next one closes
      if (!state.root.querySelector('#tc-hstyle')?.hidden) { setHStyleOpen(false); return; }
      if (!state.draw?.cancel()) close();
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && state.draw?.selectedId) {
      e.preventDefault();
      state.draw.deleteSelected();
      return;
    }
    // Keep Tab inside the dialog
    if (e.key === 'Tab') {
      const f = [...state.root.querySelectorAll('button:not([disabled]):not([hidden]), a[href], input:not([disabled])')].filter(x => x.offsetParent !== null);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }

  function setSegOn(name, val) {
    state.root.querySelectorAll(`[data-seg="${name}"] button`).forEach(b => {
      const on = b.dataset.val === val;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    });
  }

  function onClick(e) {
    if (!state) return;
    if (e.target === state.root) { close(); return; }
    const t = e.target.closest('button');
    if (!t || t.disabled) return;
    if (t.id === 'tc-close') { close(); return; }
    if (t.hasAttribute('data-retry')) {
      if (state.chart) fetchCandles();
      else { const s = state; close(); if (s) open(); }
      return;
    }
    if (!state.chart) return;
    if (t.dataset.shot) {
      if (!state.candles?.length) return;
      const make = () => {
        const tf = TIMEFRAMES.find(x => x.id === state.prefs.tf);
        const unit = state.prefs.unit === 'mcap' ? 'Market cap' : 'Price';
        const last = state.candles[state.candles.length - 1].close;
        const chg = state.root.querySelector('#tc-change')?.textContent?.trim() || '';
        const up = !chg.startsWith('-');
        return chartShot.capture(state.chart, {
          title: `${unit} · ${tf ? tf.label : ''} candles`,
          detail: `$${fmtValue(last)}${chg ? `  ${chg}` : ''}`,
          accent: chg ? cssVar(up ? '--good-ink' : '--bad-ink', up ? '#4ade80' : '#ff8080') : undefined,
          legend: state.series.holders ? [
            { label: `${unit} (right axis)`, color: cssVar('--good-ink', '#4ade80') },
            { label: `Holders${holdersInOwnPane() ? ' (lower pane)' : holderAxisFits() ? ' (left axis)' : ''}`, color: holdersColor(state.prefs) },
          ] : [],
        });
      };
      if (t.dataset.shot === 'copy') chartShot.copy(make, 'chart');
      else chartShot.download(make, 'chart');
      return;
    }
    if (t.hasAttribute('data-hstyle-toggle')) { setHStyleOpen(state.root.querySelector('#tc-hstyle').hidden); return; }
    if (t.dataset.hcolor) { setHStyle({ color: t.dataset.hcolor }, true); return; }
    if (t.closest('[data-seg="hpane"]')) {
      if (state.prefs.hstyle.pane === t.dataset.val) return;
      setSegOn('hpane', t.dataset.val);
      setHStyle({ pane: t.dataset.val }, true);
      render(false);
      return;
    }
    if (t.dataset.draw) { state.draw?.setTool(t.dataset.draw); return; }
    if (t.hasAttribute('data-del')) { state.draw?.deleteSelected(); return; }
    if (t.hasAttribute('data-clear')) {
      if (state.draw?.count && window.confirm('Remove all drawings on this token?')) state.draw.clearAll();
      return;
    }
    const segEl = t.closest('[data-seg]');
    if (segEl) {
      const name = segEl.dataset.seg;
      const val = t.dataset.val;
      if (state.prefs[name] === val) return;
      state.prefs[name] = val;
      setSegOn(name, val);
      savePrefs(state.prefs);
      if (name === 'tf') fetchCandles();
      else render(name === 'unit');
      return;
    }
    if (t.dataset.ind) {
      const id = t.dataset.ind;
      state.prefs.ind[id] = !state.prefs.ind[id];
      t.classList.toggle('on', state.prefs.ind[id]);
      t.setAttribute('aria-pressed', String(state.prefs.ind[id]));
      if (id === 'holders') {
        const btn = state.root.querySelector('[data-hstyle-toggle]');
        if (btn) btn.hidden = !state.prefs.ind.holders;
        if (!state.prefs.ind.holders) setHStyleOpen(false);
      }
      savePrefs(state.prefs);
      render(false);
      return;
    }
    if (t.hasAttribute('data-log')) {
      state.prefs.log = !state.prefs.log;
      t.classList.toggle('on', state.prefs.log);
      t.setAttribute('aria-pressed', String(state.prefs.log));
      savePrefs(state.prefs);
      state.chart.priceScale('right').applyOptions({ mode: state.prefs.log ? 1 : 0 });
      return;
    }
    if (t.hasAttribute('data-fit')) {
      state.chart.timeScale().fitContent();
    }
  }

  // ── Holders line style ─────────────────────────────────────────────────
  function setHStyleOpen(open) {
    const panel = state.root.querySelector('#tc-hstyle');
    const btn = state.root.querySelector('[data-hstyle-toggle]');
    if (!panel) return;
    panel.hidden = !open;
    btn?.setAttribute('aria-expanded', String(open));
    btn?.classList.toggle('on', open);
  }
  // Color and opacity restyle the live line in place; placement needs a re-render (caller)
  function setHStyle(patch, save) {
    const h = state.prefs.hstyle = normalizeHStyle({ ...state.prefs.hstyle, ...patch });
    const color = holdersColor(state.prefs);
    state.series.holders?.applyOptions({ color });
    const root = state.root;
    root.querySelectorAll('[data-hcolor]').forEach(b => {
      const on = b.dataset.hcolor === h.color;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    });
    const custom = root.querySelector('.tc-swatch-custom');
    custom?.classList.toggle('on', !HOLDERS_SWATCHES.includes(h.color));
    const input = root.querySelector('[data-hcolor-input]');
    if (input && input.value.toLowerCase() !== h.color) input.value = h.color;
    const dot = root.querySelector('.tc-hstyle-dot');
    if (dot) dot.style.background = color;
    const val = root.querySelector('#tc-hopacity-val');
    if (val) val.textContent = `${Math.round(h.opacity * 100)}%`;
    if (save) savePrefs(state.prefs);
    renderLegend(null);
  }
  function onInput(e) {
    if (!state) return;
    const t = e.target;
    const save = e.type === 'change';
    if (t.hasAttribute('data-hopacity')) setHStyle({ opacity: Number(t.value) / 100 }, save);
    else if (t.hasAttribute('data-hcolor-input')) setHStyle({ color: t.value }, save);
  }

  // ── Preview card on the page ───────────────────────────────────────────
  // Last 48 hourly closes drawn as a sparkline. Uses the 100-candle cache entry, so it costs at
  // most one GeckoTerminal call per token every few minutes across all visitors.
  function sparkPath(values, w, h, pad) {
    const min = Math.min(...values), max = Math.max(...values);
    const span = max - min || max || 1;
    const step = values.length > 1 ? w / (values.length - 1) : 0;
    return values.map((v, i) => {
      const x = i * step;
      const y = pad + (h - pad * 2) * (1 - (v - min) / span);
      return `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
  }
  function drawPlaceholderSpark(svg) {
    // Decorative candles while loading, or when there's no data to draw
    const bars = [38, 30, 34, 24, 28, 20, 26, 16, 22, 14, 18, 10];
    svg.innerHTML = bars.map((y, i) => {
      const x = 12 + i * 24;
      const up = i % 3 !== 1;
      const color = up ? 'rgba(74,222,128,0.35)' : 'rgba(255,128,128,0.35)';
      return `<line x1="${x}" y1="${y - 8}" x2="${x}" y2="${y + 26}" stroke="${color}" stroke-width="1.5"/><rect x="${x - 5}" y="${y}" width="10" height="16" rx="1.5" fill="${color}"/>`;
    }).join('');
  }
  async function loadPreview() {
    const svg = document.getElementById('chart-cta-spark');
    const label = document.getElementById('chart-cta-range');
    const mint = utils.getUrlParam('mint');
    if (!svg || !mint) return;
    drawPlaceholderSpark(svg);
    try {
      const res = await api.request(`/api/tokens/${encodeURIComponent(mint)}/ohlcv?interval=1h&limit=100`, { retries: 1, timeout: 20000 });
      const candles = normalizeCandles(res?.data, 1).slice(-48);
      if (candles.length < 2) return;
      const closes = candles.map(c => c.close);
      const first = candles[0].open || closes[0];
      const last = closes[closes.length - 1];
      const pct = first > 0 ? ((last - first) / first) * 100 : 0;
      const color = pct >= 0 ? '#4ade80' : '#ff8080';
      const W = 300, H = 72;
      const line = sparkPath(closes, W, H, 6);
      svg.innerHTML = `
        <defs><linearGradient id="tc-spark-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${color}" stop-opacity="0.28"/><stop offset="100%" stop-color="${color}" stop-opacity="0"/>
        </linearGradient></defs>
        <path d="${line} L${W},${H} L0,${H} Z" fill="url(#tc-spark-fill)"/>
        <path d="${line}" fill="none" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>`;
      if (label) {
        const hours = Math.round((candles[candles.length - 1].time - candles[0].time) / 3600) + 1;
        label.textContent = `${hours}h ${fmtPct(pct)}`;
        label.style.color = color;
      }
    } catch { /* keep the placeholder; the card still opens the chart */ }
  }

  function init() {
    const btn = document.getElementById('chart-btn');
    if (btn) btn.addEventListener('click', open);
    const cta = document.getElementById('chart-cta');
    if (cta) {
      cta.addEventListener('click', open);
      loadPreview();
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  return { open, close, loadLib, _test: { fmtTick, fmtValue, sma, ema, rsi, bollinger, normalizeCandles, mergeTail, normalizeHStyle, hexToRgba } };
})();
