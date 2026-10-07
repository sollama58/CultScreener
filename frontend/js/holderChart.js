// Token page "Holders" panel: holder count history drawn with TradingView Lightweight Charts
// (the same vendored library as the price chart modal, loaded on demand). Data comes from
// /api/tokens/:mint/holder-count, one point per full holder snapshot (backend
// services/holderCounts.js). Points before HolDEX's first snapshot count are estimates from
// older daily counts and are drawn dashed.
const holderChart = (() => {
  const PREFS_KEY = 'holdex.holderChart.v1';
  const RANGES = ['24h', '7d', '30d', '90d', 'all'];
  const CHANGE_KEYS = [['24h', '24H'], ['7d', '7D'], ['30d', '30D']];

  let st = null; // { mint, range, hideDust, data, chart, LWC, series, root }

  function loadPrefs() {
    try {
      const p = JSON.parse(localStorage.getItem(PREFS_KEY) || 'null');
      if (p && typeof p === 'object') return { range: RANGES.includes(p.range) ? p.range : '7d', hideDust: !!p.hideDust };
    } catch { /* storage blocked */ }
    return { range: '7d', hideDust: false };
  }
  function savePrefs() {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify({ range: st.range, hideDust: st.hideDust })); } catch { /* ignore */ }
  }

  function loadLib() {
    if (typeof tokenChart !== 'undefined' && tokenChart.loadLib) return tokenChart.loadLib();
    if (window.LightweightCharts) return Promise.resolve(window.LightweightCharts);
    return Promise.reject(new Error('Chart library unavailable'));
  }

  // ── Formatting ─────────────────────────────────────────────────────────
  function fmtCount(v) {
    if (v == null || !isFinite(v)) return '--';
    return Math.round(v).toLocaleString();
  }
  function fmtAxis(v) {
    const a = Math.abs(v);
    if (a >= 1e6) return `${+(v / 1e6).toFixed(2)}M`;
    if (a >= 1e4) return `${+(v / 1e3).toFixed(1)}K`;
    return Math.round(v).toLocaleString();
  }
  function fmtTime(t) {
    return new Date(t * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  function fmtTick(t, tickType) {
    const d = new Date(t * 1000);
    if (tickType === 0) return String(d.getFullYear());
    if (tickType === 1) return d.toLocaleString(undefined, { month: 'short' });
    if (tickType === 2) return d.toLocaleString(undefined, { month: 'short', day: 'numeric' });
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }
  function ago(t) {
    const s = Math.max(0, Date.now() / 1000 - t);
    if (s < 90) return 'just now';
    if (s < 5400) return `${Math.round(s / 60)}m ago`;
    if (s < 172800) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86400)}d ago`;
  }
  function cssVar(name, fallback) {
    try { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback; } catch { return fallback; }
  }
  function $(id) { return document.getElementById(id); }

  function metric() {
    const real = st.data?.series?.real;
    const hasReal = !!(real && (real.actual.length || real.est.length) && st.data.current?.real != null);
    return st.hideDust && hasReal ? 'real' : 'holders';
  }

  // ── Header numbers ─────────────────────────────────────────────────────
  function renderTop() {
    const d = st.data;
    const cur = d?.current;
    const m = metric();
    const nowEl = $('hc-now');
    const subEl = $('hc-now-sub');
    if (nowEl) {
      const v = cur ? (m === 'real' ? cur.real : cur.holders) : null;
      nowEl.textContent = v == null ? '--' : `${fmtCount(v)}${cur.complete === false ? '+' : ''}`;
    }
    if (subEl) {
      if (!cur) subEl.textContent = 'Waiting for the first holder snapshot';
      else {
        const parts = [`Updated ${ago(cur.at)}`];
        if (cur.complete === false) parts.push('lower bound, too many holders to count in full');
        if (m === 'holders' && cur.dust != null && cur.dust > 0) parts.push(`${fmtCount(cur.dust)} hold under $${d.dustUsd}`);
        subEl.textContent = parts.join(' · ');
      }
    }
    const ch = $('hc-changes');
    if (ch) {
      const changes = d?.series?.[m]?.changes || {};
      ch.innerHTML = CHANGE_KEYS.map(([k, label]) => {
        const c = changes[k];
        if (!c) {
          return `<div class="hc-change"><span class="hc-change-label">${label}</span><span class="hc-change-value">--</span></div>`;
        }
        const up = c.delta >= 0;
        const cls = c.delta === 0 ? '' : up ? 'hc-up' : 'hc-down';
        const sign = up ? '+' : '';
        const tilde = c.approx ? '~' : '';
        const title = c.approx ? ' title="Estimated: compared with an older daily count from before per-snapshot tracking"' : '';
        return `<div class="hc-change"${title}>
          <span class="hc-change-label">${label}${c.approx ? ' <span class="hc-est-tag">est</span>' : ''}</span>
          <span class="hc-change-value ${cls}">${tilde}${sign}${c.delta.toLocaleString()}</span>
          ${c.pct != null ? `<span class="hc-change-pct ${cls}">${sign}${c.pct.toFixed(2)}%</span>` : ''}
        </div>`;
      }).join('');
    }
    const dust = $('hc-dust');
    if (dust) {
      const ready = d?.current?.real != null;
      dust.disabled = !ready;
      dust.checked = ready && st.hideDust;
      const lbl = $('hc-dust-label');
      if (lbl) lbl.textContent = `Hide dust (under $${d?.dustUsd ?? 1})`;
      const wrap = dust.closest('.hc-toggle');
      if (wrap) wrap.title = ready ? 'Leave out wallets holding less than this, at the price when each count was taken' : 'Available from the next holder snapshot';
    }
    const note = $('hc-note');
    if (note) {
      const hrs = d?.refreshHours || 4;
      const est = d?.series?.[m]?.est?.length > 0;
      note.textContent = `Unique wallets holding the token; burn and LP wallets excluded. Counted from a full holder snapshot about every ${hrs}h.` +
        (est ? ' Dashed: estimated from older daily counts.' : '');
    }
  }

  function setMsg(text) {
    const el = $('hc-msg');
    if (!el) return;
    el.hidden = !text;
    el.textContent = text || '';
  }

  // ── Chart ──────────────────────────────────────────────────────────────
  function buildChart(LWC) {
    const el = $('hc-chart');
    const grid = cssVar('--grid', '#232735');
    const axis = cssVar('--axis', '#343a4b');
    const chart = LWC.createChart(el, {
      autoSize: true,
      layout: {
        background: { type: 'solid', color: 'transparent' },
        textColor: cssVar('--ink-2', '#aab1c2'),
        fontFamily: cssVar('--mono', 'JetBrains Mono, monospace'),
        fontSize: 11,
        attributionLogo: false,
      },
      grid: { vertLines: { visible: false }, horzLines: { color: grid } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.15, bottom: 0.08 } },
      timeScale: { borderColor: axis, timeVisible: true, secondsVisible: false, rightOffset: 2, fixLeftEdge: true, fixRightEdge: true, tickMarkFormatter: fmtTick },
      crosshair: { mode: 1, vertLine: { labelVisible: false }, horzLine: { labelVisible: true } },
      handleScroll: { vertTouchDrag: false },
      handleScale: { axisPressedMouseMove: { price: false } },
      localization: { priceFormatter: fmtAxis, timeFormatter: fmtTime },
    });
    const brandA = cssVar('--brand-a', '#8b5cf6');
    const brandB = cssVar('--brand-b', '#3b82f6');
    const fmt = { type: 'custom', formatter: fmtAxis, minMove: 1 };
    const est = chart.addSeries(LWC.LineSeries, {
      color: cssVar('--muted', '#868da0'), lineWidth: 2, lineStyle: 2, priceFormat: fmt,
      lastValueVisible: false, priceLineVisible: false, crosshairMarkerRadius: 3,
    });
    const actual = chart.addSeries(LWC.AreaSeries, {
      lineColor: brandB, topColor: hexA(brandA, 0.38), bottomColor: hexA(brandA, 0.02), lineWidth: 2,
      priceFormat: fmt, priceLineVisible: false, crosshairMarkerRadius: 4,
    });
    chart.subscribeCrosshairMove(renderLegend);
    st.chart = chart;
    st.LWC = LWC;
    st.series = { actual, est };
  }

  function hexA(color, alpha) {
    const m = /^#([0-9a-f]{6})$/i.exec(color.trim());
    if (!m) return color;
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }

  function seriesData() {
    const s = st.data?.series?.[metric()] || { actual: [], est: [] };
    const warn = cssVar('--warn', '#fab219');
    const actual = s.actual.map(([time, value, complete]) => (complete
      ? { time, value }
      : { time, value, lineColor: warn, topColor: hexA(warn, 0.25), bottomColor: hexA(warn, 0.02) }));
    const est = s.est.map(([time, value]) => ({ time, value }));
    // Join the dashed estimate onto the first real point so the line is continuous
    if (est.length && actual.length && actual[0].time > est[est.length - 1].time) est.push({ time: actual[0].time, value: actual[0].value });
    return { actual, est, caps: s.actual.filter(p => !p[2]).map(p => p[0]) };
  }

  function draw() {
    if (!st.chart) return;
    const { actual, est, caps } = seriesData();
    st.caps = new Set(caps);
    st.estTimes = new Set(est.map(p => p.time));
    st.series.actual.setData(actual);
    st.series.est.setData(est);
    const n = actual.length + est.length;
    if (n === 0) setMsg('No holder history yet. The first count lands with the next holder snapshot.');
    else if (actual.length + est.length === 1) setMsg('One count so far. The line fills in as snapshots arrive.');
    else setMsg('');
    st.chart.timeScale().fitContent();
    renderLegend(null);
    setShotEnabled(n > 0);
  }

  function renderLegend(param) {
    const el = $('hc-legend');
    if (!el || !st.series) return;
    let t = null, v = null, isEst = false;
    if (param && param.time != null && param.seriesData) {
      const a = param.seriesData.get(st.series.actual);
      const e = param.seriesData.get(st.series.est);
      if (a) { t = a.time; v = a.value; }
      else if (e) { t = e.time; v = e.value; isEst = true; }
    }
    if (t == null) { el.innerHTML = ''; el.hidden = true; return; }
    el.hidden = false;
    const capped = st.caps?.has(t);
    el.innerHTML = `<span class="hc-legend-time">${fmtTime(t)}</span> <b>${isEst ? '~' : ''}${fmtCount(v)}${capped ? '+' : ''}</b> ${metric() === 'real' ? 'holders over dust' : 'holders'}${isEst ? ' <span class="hc-est-tag">est</span>' : ''}${capped ? ' <span class="hc-est-tag">lower bound</span>' : ''}`;
  }

  // ── Data ───────────────────────────────────────────────────────────────
  async function fetchRange(range) {
    const key = `${st.mint}:${range}`;
    const hit = st.cache.get(key);
    if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.data;
    const data = await api.request(`/api/tokens/${encodeURIComponent(st.mint)}/holder-count?range=${range}`, { retries: 1, timeout: 20000 });
    st.cache.set(key, { at: Date.now(), data });
    return data;
  }

  async function show(range) {
    st.range = range;
    savePrefs();
    st.root.querySelectorAll('.hc-range button').forEach(b => b.classList.toggle('on', b.dataset.range === range));
    const me = st;
    const seq = ++me.seq;
    const stale = () => st !== me || seq !== me.seq; // destroyed, or a newer range click won
    if (!me.data) setMsg('Loading holder history…');
    try {
      const data = await fetchRange(range);
      if (stale()) return;
      me.data = data;
      renderTop();
      if (!me.chart) {
        const LWC = await loadLib();
        if (stale()) return;
        if (!me.chart) buildChart(LWC);
      }
      draw();
    } catch (err) {
      if (stale()) return;
      console.warn('[HolderChart]', err);
      if (!st.data) {
        renderTop();
        setMsg('Holder history is unavailable right now.');
      }
    }
  }

  // Chart image (js/chartShot.js): the chart as shown, with the range and current count
  function makeShot() {
    const m = metric();
    const cur = st.data?.current;
    const v = cur ? (m === 'real' ? cur.real : cur.holders) : null;
    const rangeLabel = st.range === 'all' ? 'All time' : st.range.toUpperCase();
    const ch = st.data?.series?.[m]?.changes?.[st.range === '24h' ? '24h' : st.range === '7d' ? '7d' : '30d'];
    const chText = ch ? `  ${ch.delta >= 0 ? '+' : ''}${ch.delta.toLocaleString()}${ch.pct != null ? ` (${ch.delta >= 0 ? '+' : ''}${ch.pct.toFixed(2)}%)` : ''}` : '';
    return chartShot.capture(st.chart, {
      title: `${m === 'real' ? 'Holders over $' + (st.data?.dustUsd ?? 1) : 'Holders'} · ${rangeLabel}`,
      detail: v == null ? '' : `${fmtCount(v)}${cur.complete === false ? '+' : ''}${chText}`,
      accent: ch ? (ch.delta >= 0 ? cssVar('--good-ink', '#4ade80') : cssVar('--bad-ink', '#ff8080')) : undefined,
    });
  }
  function setShotEnabled(on) {
    st?.root.querySelectorAll('[data-shot]').forEach(b => { b.disabled = !on; });
  }

  function onClick(e) {
    const shot = e.target.closest('[data-shot]');
    if (shot) {
      if (!st.chart || typeof chartShot === 'undefined') return;
      if (shot.dataset.shot === 'copy') chartShot.copy(makeShot, 'holders');
      else chartShot.download(makeShot, 'holders');
      return;
    }
    const b = e.target.closest('.hc-range button');
    if (b && b.dataset.range && b.dataset.range !== st.range) show(b.dataset.range);
  }
  function onChange(e) {
    if (e.target.id !== 'hc-dust') return;
    st.hideDust = e.target.checked;
    savePrefs();
    renderTop();
    draw();
  }

  /** Load the panel for a mint. Safe to call again (e.g. after navigation). */
  function load(mint) {
    const root = $('holder-trend-section');
    if (!root || !mint) return Promise.resolve();
    if (st && st.mint === mint) return show(st.range);
    destroy();
    const prefs = loadPrefs();
    st = { mint, root, range: prefs.range, hideDust: prefs.hideDust, data: null, chart: null, series: null, cache: new Map(), seq: 0 };
    root.style.display = '';
    root.addEventListener('click', onClick);
    root.addEventListener('change', onChange);
    return show(st.range);
  }

  function destroy() {
    if (!st) return;
    st.root.removeEventListener('click', onClick);
    st.root.removeEventListener('change', onChange);
    try { st.chart?.remove(); } catch { /* already gone */ }
    st = null;
  }

  return { load, destroy, _test: { fmtAxis, fmtCount } };
})();
