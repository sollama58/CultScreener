// Drawing tools for the token chart modal (tokenChart.js): trendlines and Fibonacci retracements.
// Lightweight Charts has no drawing tools of its own, so this draws them as a series primitive
// on the main price series. Points are stored as { t: unix seconds, p: USD price } so a drawing
// stays put across timeframes and the Price/MCap switch, and is saved per token in localStorage.
const chartDrawings = (() => {
  const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
  const FIB_COLORS = ['#868da0', '#ff8080', '#fab219', '#4ade80', '#3fb6c6', '#3987e5', '#868da0'];
  const TREND_COLOR = '#b9a6ff';
  const SELECT_COLOR = '#ffffff';
  const MAX_DRAWINGS = 60;

  // ── Time <-> logical index ─────────────────────────────────────────────
  // Logical indexes are fractional bar positions. Mapping through the candle list (instead of
  // timeToCoordinate, which needs an exact bar) lets a point drawn on 15m candles sit in the
  // right place on 1h candles, and lets points sit past either end of the data.
  function timeToLogical(candles, tfSec, t) {
    const n = candles.length;
    if (!n) return null;
    if (t <= candles[0].time) return (t - candles[0].time) / tfSec;
    if (t >= candles[n - 1].time) return n - 1 + (t - candles[n - 1].time) / tfSec;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (candles[mid].time <= t) lo = mid; else hi = mid;
    }
    const span = candles[hi].time - candles[lo].time || tfSec;
    return lo + (t - candles[lo].time) / span;
  }
  function logicalToTime(candles, tfSec, l) {
    const n = candles.length;
    if (!n || l == null || !isFinite(l)) return null;
    if (l <= 0) return Math.round(candles[0].time + l * tfSec);
    if (l >= n - 1) return Math.round(candles[n - 1].time + (l - (n - 1)) * tfSec);
    const i = Math.floor(l);
    return Math.round(candles[i].time + (l - i) * (candles[i + 1].time - candles[i].time));
  }

  function distToSegment(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    let u = len2 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
    u = Math.max(0, Math.min(1, u));
    return Math.hypot(px - (x1 + u * dx), py - (y1 + u * dy));
  }

  function fibPrice(d, level) {
    // TradingView convention: level 1 at the first point, level 0 at the second
    return d.p2.p + (d.p1.p - d.p2.p) * level;
  }

  function loadStored(key) {
    try {
      const arr = JSON.parse(localStorage.getItem(key) || '[]');
      if (!Array.isArray(arr)) return [];
      const ok = pt => pt && isFinite(pt.t) && isFinite(pt.p) && pt.p > 0;
      return arr.filter(d => d && (d.type === 'trend' || d.type === 'fib') && ok(d.p1) && ok(d.p2)).slice(-MAX_DRAWINGS);
    } catch { return []; }
  }

  /**
   * @param {Object} opts
   * @param {string} opts.storageKey - localStorage key for this token's drawings
   * @param {() => Array} opts.getCandles - current candles (ascending, values already scaled)
   * @param {() => number} opts.getTfSeconds - seconds per candle
   * @param {() => number} opts.getFactor - display multiplier (1 for price, supply for MCap)
   * @param {(ctrl) => void} opts.onChange - tool/selection/drawings changed
   * @param {(n: number) => string} opts.formatValue - price label formatter
   */
  function create(opts) {
    let drawings = loadStored(opts.storageKey);
    let tool = null;        // 'trend' | 'fib' | null
    let pending = null;     // first point while placing
    let hover = null;       // latest pointer point, for the live preview
    let selectedId = null;
    let chart = null, series = null, requestUpdate = null;

    function save() {
      try {
        if (drawings.length) localStorage.setItem(opts.storageKey, JSON.stringify(drawings));
        else localStorage.removeItem(opts.storageKey);
      } catch { /* storage blocked: drawings last for this visit */ }
    }
    function changed() {
      if (requestUpdate) requestUpdate();
      opts.onChange?.(ctrl);
    }

    // CSS-pixel position of a stored point, or null when the chart can't place it
    function toXY(pt) {
      if (!chart || !series) return null;
      const l = timeToLogical(opts.getCandles(), opts.getTfSeconds(), pt.t);
      if (l == null) return null;
      const x = chart.timeScale().logicalToCoordinate(l);
      const y = series.priceToCoordinate(pt.p * opts.getFactor());
      if (x == null || y == null || !isFinite(x) || !isFinite(y)) return null;
      return { x, y };
    }
    function fromXY(point) {
      if (!chart || !series || !point) return null;
      const l = chart.timeScale().coordinateToLogical(point.x);
      const price = series.coordinateToPrice(point.y);
      if (l == null || price == null || !(price > 0)) return null;
      const t = logicalToTime(opts.getCandles(), opts.getTfSeconds(), l);
      if (t == null) return null;
      return { t, p: price / opts.getFactor() };
    }

    // ── Rendering ────────────────────────────────────────────────────────
    function drawAll(ctx, hr, vr, size) {
      const items = drawings.map(d => ({ d, sel: d.id === selectedId }));
      if (pending && hover && tool) items.push({ d: { id: '_preview', type: tool, p1: pending, p2: hover }, sel: false, preview: true });
      for (const it of items) {
        const a = toXY(it.d.p1), b = toXY(it.d.p2);
        if (!a || !b) continue;
        if (it.d.type === 'trend') drawTrend(ctx, hr, vr, a, b, it);
        else drawFib(ctx, hr, vr, a, b, it, size);
      }
      // First point of a drawing in progress (all a phone shows until the second tap)
      if (pending && tool) {
        const p = toXY(pending);
        if (p) handle(ctx, hr, vr, p, TREND_COLOR);
      }
    }
    function handle(ctx, hr, vr, p, color) {
      ctx.beginPath();
      ctx.arc(p.x * hr, p.y * vr, 4.5 * hr, 0, Math.PI * 2);
      ctx.fillStyle = '#07080c';
      ctx.fill();
      ctx.lineWidth = 1.5 * hr;
      ctx.strokeStyle = color;
      ctx.stroke();
    }
    function drawTrend(ctx, hr, vr, a, b, it) {
      ctx.save();
      ctx.lineWidth = (it.sel ? 2.5 : 2) * hr;
      ctx.strokeStyle = TREND_COLOR;
      if (it.preview) ctx.setLineDash([6 * hr, 4 * hr]);
      ctx.beginPath();
      ctx.moveTo(a.x * hr, a.y * vr);
      ctx.lineTo(b.x * hr, b.y * vr);
      ctx.stroke();
      ctx.restore();
      if (it.sel || it.preview) { handle(ctx, hr, vr, a, it.sel ? SELECT_COLOR : TREND_COLOR); handle(ctx, hr, vr, b, it.sel ? SELECT_COLOR : TREND_COLOR); }
    }
    function drawFib(ctx, hr, vr, a, b, it) {
      const left = Math.min(a.x, b.x), right = Math.max(a.x, b.x);
      const fontPx = Math.round(10.5 * vr);
      ctx.save();
      ctx.font = `${fontPx}px 'JetBrains Mono', ui-monospace, monospace`;
      ctx.textBaseline = 'bottom';
      const ys = FIB_LEVELS.map(lv => {
        const y = series.priceToCoordinate(fibPrice(it.d, lv) * opts.getFactor());
        return y == null ? null : y;
      });
      // Shaded bands between neighbouring levels
      for (let i = 0; i < FIB_LEVELS.length - 1; i++) {
        if (ys[i] == null || ys[i + 1] == null) continue;
        ctx.globalAlpha = it.preview ? 0.05 : 0.08;
        ctx.fillStyle = FIB_COLORS[i + 1];
        const top = Math.min(ys[i], ys[i + 1]);
        ctx.fillRect(left * hr, top * vr, (right - left) * hr, Math.abs(ys[i + 1] - ys[i]) * vr);
      }
      ctx.globalAlpha = 1;
      FIB_LEVELS.forEach((lv, i) => {
        const y = ys[i];
        if (y == null) return;
        ctx.strokeStyle = FIB_COLORS[i];
        ctx.lineWidth = (it.sel ? 1.5 : 1) * hr;
        if (it.preview) ctx.setLineDash([5 * hr, 4 * hr]); else ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(left * hr, Math.round(y * vr) + 0.5);
        ctx.lineTo(right * hr, Math.round(y * vr) + 0.5);
        ctx.stroke();
        if (right - left > 50) {
          ctx.fillStyle = FIB_COLORS[i];
          ctx.fillText(`${lv} (${opts.formatValue(fibPrice(it.d, lv) * opts.getFactor())})`, left * hr + 4 * hr, y * vr - 2 * vr);
        }
      });
      // Diagonal from the first point to the second, as TradingView shows it
      ctx.setLineDash([3 * hr, 3 * hr]);
      ctx.strokeStyle = 'rgba(170,177,194,0.5)';
      ctx.lineWidth = 1 * hr;
      ctx.beginPath();
      ctx.moveTo(a.x * hr, a.y * vr);
      ctx.lineTo(b.x * hr, b.y * vr);
      ctx.stroke();
      ctx.restore();
      if (it.sel || it.preview) { handle(ctx, hr, vr, a, it.sel ? SELECT_COLOR : TREND_COLOR); handle(ctx, hr, vr, b, it.sel ? SELECT_COLOR : TREND_COLOR); }
    }

    class DrawingsPrimitive {
      constructor() {
        const renderer = {
          draw: target => target.useBitmapCoordinateSpace(scope =>
            drawAll(scope.context, scope.horizontalPixelRatio, scope.verticalPixelRatio, scope.bitmapSize))
        };
        this._views = [{ renderer: () => renderer, zOrder: () => 'top' }];
      }
      attached(p) { requestUpdate = p.requestUpdate; }
      detached() { requestUpdate = null; }
      updateAllViews() {}
      paneViews() { return this._views; }
    }

    // ── Hit testing (CSS px) ─────────────────────────────────────────────
    function hitTest(point, tol) {
      for (let i = drawings.length - 1; i >= 0; i--) {
        const d = drawings[i];
        const a = toXY(d.p1), b = toXY(d.p2);
        if (!a || !b) continue;
        if (d.type === 'trend') {
          if (distToSegment(point.x, point.y, a.x, a.y, b.x, b.y) <= tol) return d;
        } else {
          const ys = FIB_LEVELS.map(lv => series.priceToCoordinate(fibPrice(d, lv) * opts.getFactor())).filter(y => y != null);
          if (!ys.length) continue;
          const left = Math.min(a.x, b.x) - tol, right = Math.max(a.x, b.x) + tol;
          const top = Math.min(...ys) - tol, bottom = Math.max(...ys) + tol;
          if (point.x >= left && point.x <= right && point.y >= top && point.y <= bottom) return d;
        }
      }
      return null;
    }

    const ctrl = {
      get tool() { return tool; },
      get selectedId() { return selectedId; },
      get count() { return drawings.length; },
      get placing() { return !!pending; },

      // Attach to the main series; tokenChart.js rebuilds series on every render
      attach(c, s) {
        chart = c;
        series = s;
        s.attachPrimitive(new DrawingsPrimitive());
      },
      detach() { chart = null; series = null; requestUpdate = null; },

      setTool(next) {
        tool = tool === next ? null : next;
        pending = null;
        hover = null;
        if (tool) selectedId = null;
        changed();
      },
      cancel() {
        if (!tool && !selectedId) return false;
        tool = null; pending = null; hover = null; selectedId = null;
        changed();
        return true;
      },

      // Returns true when the click was used for drawing or selection
      handleClick(param, isTouch) {
        if (!param?.point || (param.paneIndex != null && param.paneIndex !== 0)) return false;
        if (tool) {
          const pt = fromXY(param.point);
          if (!pt) return true;
          if (!pending) { pending = pt; hover = pt; changed(); return true; }
          if (pt.t === pending.t && Math.abs(pt.p - pending.p) / pending.p < 1e-9) return true; // same spot twice
          const d = { id: `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, type: tool, p1: pending, p2: pt };
          drawings.push(d);
          if (drawings.length > MAX_DRAWINGS) drawings = drawings.slice(-MAX_DRAWINGS);
          save();
          tool = null; pending = null; hover = null;
          selectedId = d.id;
          changed();
          return true;
        }
        const hit = hitTest(param.point, isTouch ? 16 : 7);
        const next = hit ? hit.id : null;
        if (next !== selectedId) { selectedId = next; changed(); }
        return !!hit;
      },
      handleMove(param) {
        if (!tool || !pending) return;
        const pt = param?.point && (param.paneIndex == null || param.paneIndex === 0) ? fromXY(param.point) : null;
        if (pt) { hover = pt; if (requestUpdate) requestUpdate(); }
      },
      deleteSelected() {
        if (!selectedId) return false;
        drawings = drawings.filter(d => d.id !== selectedId);
        selectedId = null;
        save();
        changed();
        return true;
      },
      clearAll() {
        if (!drawings.length) return;
        drawings = [];
        selectedId = null;
        save();
        changed();
      }
    };
    return ctrl;
  }

  return { create, FIB_LEVELS, _test: { timeToLogical, logicalToTime, distToSegment, fibPrice } };
})();
