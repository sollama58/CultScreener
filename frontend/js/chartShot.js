// Chart screenshots: a Lightweight Charts canvas framed with the token's logo, name and ticker
// on top (plus a King of the Pill chip when the token wears the crown) and holdex.live
// branding, copied to the clipboard or downloaded as a PNG.
// Used by the Holders panel (holderChart.js) and the chart modal (tokenChart.js); its copy,
// download and drawing helpers also serve the King of the Pill share image (kotpShot.js).
const chartShot = (() => {
  const BRAND_ICON = 'icons/icon.svg';
  const SITE = 'holdex.live';

  function cssVar(name, fallback) {
    try { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback; } catch { return fallback; }
  }

  function loadImage(src, crossOrigin) {
    return new Promise(resolve => {
      if (!src) return resolve(null);
      const img = new Image();
      if (crossOrigin) img.crossOrigin = 'anonymous';
      const timer = setTimeout(() => resolve(null), 6000);
      img.onload = () => { clearTimeout(timer); resolve(img); };
      img.onerror = () => { clearTimeout(timer); resolve(null); };
      img.src = src;
    });
  }

  // The hero logo, re-read with CORS so the canvas stays exportable. The image proxy sends
  // Access-Control-Allow-Origin: *; anything else (a data: placeholder) loads as is.
  async function tokenLogo() {
    const t = (typeof tokenDetail !== 'undefined' && tokenDetail.token) || {};
    const raw = t.logoUri || t.logoURI || t.logo || '';
    const hero = document.getElementById('token-logo')?.getAttribute('src') || '';
    const candidates = [];
    if (hero && !hero.startsWith('data:image/svg')) candidates.push(hero);
    if (raw && typeof utils !== 'undefined' && utils.proxyImageUrl) candidates.push(utils.proxyImageUrl(raw));
    for (const src of candidates) {
      const img = await loadImage(src, !src.startsWith('data:'));
      if (img && img.naturalWidth > 0) return img;
    }
    return null;
  }

  function tokenText() {
    const t = (typeof tokenDetail !== 'undefined' && tokenDetail.token) || {};
    const name = t.name || document.getElementById('token-name')?.textContent?.trim() || 'Token';
    let symbol = t.symbol || document.getElementById('token-symbol')?.textContent?.trim() || '';
    symbol = symbol.replace(/^\$/, '');
    return { name, symbol };
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function fitText(ctx, text, maxW) {
    if (ctx.measureText(text).width <= maxW) return text;
    let s = text;
    while (s.length > 1 && ctx.measureText(`${s}…`).width > maxW) s = s.slice(0, -1);
    return `${s}…`;
  }

  /**
   * Compose the image.
   * @param {object} chart Lightweight Charts IChartApi
   * @param {{title: string, detail?: string, accent?: string}} opts
   *   title: what the chart shows ("Holders", "Price · 1h"); detail: the headline value
   * @returns {Promise<Blob>}
   */
  // The chart as drawn, at the screen's pixel density. Built from the chart's own canvases
  // (panes, price axes, time axis) placed where they sit on screen: the library's
  // takeScreenshot() mixes pixel densities between panes and axes on high-DPI screens.
  function snapshot(chart) {
    const el = chart.chartElement();
    const er = el.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const out = document.createElement('canvas');
    out.width = Math.round(er.width * dpr);
    out.height = Math.round(er.height * dpr);
    const ctx = out.getContext('2d');
    for (const cv of el.querySelectorAll('canvas')) {
      const r = cv.getBoundingClientRect();
      if (!r.width || !r.height || !cv.width || !cv.height) continue;
      ctx.drawImage(cv, (r.left - er.left) * dpr, (r.top - er.top) * dpr, r.width * dpr, r.height * dpr);
    }
    return { shot: out, scale: dpr };
  }

  // legend: [{label, color, dashed?}] drawn as a key above the chart so every line is named
  async function capture(chart, { title = '', detail = '', accent, legend = [] } = {}) {
    // No crosshair in the picture; give the chart a frame to redraw without it
    try { chart.clearCrosshairPosition(); } catch { /* older API */ }
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const { shot, scale } = snapshot(chart);
    const s = Math.max(1, scale);
    const k = v => Math.round(v * s);
    const minW = k(480);
    const pad = k(28);
    const headH = k(76);
    const footH = k(44);
    const chartW = Math.max(shot.width, minW - pad * 2);
    const W = chartW + pad * 2;
    const legH = legend.length ? k(28) : 0;
    const H = pad + headH + k(10) + legH + shot.height + footH;

    const [logo, brand] = await Promise.all([tokenLogo(), loadImage(BRAND_ICON, false)]);
    const font = cssVar('--font', 'Inter, system-ui, sans-serif');
    const mono = cssVar('--mono', 'ui-monospace, monospace');
    const ink = cssVar('--ink', '#eef0f6');
    const ink2 = cssVar('--ink-2', '#aab1c2');
    const muted = cssVar('--muted', '#868da0');
    const brandA = cssVar('--brand-a', '#8b5cf6');
    const brandB = cssVar('--brand-b', '#3b82f6');

    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const ctx = c.getContext('2d');

    // Background: page color with a faint brand glow, then a panel behind the chart
    ctx.fillStyle = cssVar('--page', '#07080c');
    ctx.fillRect(0, 0, W, H);
    const glow = ctx.createRadialGradient(W * 0.1, 0, 0, W * 0.1, 0, W * 0.7);
    glow.addColorStop(0, 'rgba(139, 92, 246, 0.16)');
    glow.addColorStop(1, 'rgba(139, 92, 246, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = cssVar('--surface-solid', '#11131a');
    roundRect(ctx, k(12), pad + headH, W - k(24), shot.height + legH + k(20), k(14));
    ctx.fill();

    // Header: logo, name, $TICKER, title line
    const logoSize = k(52);
    const ly = pad + (headH - logoSize) / 2 - k(6);
    ctx.save();
    ctx.beginPath();
    ctx.arc(pad + logoSize / 2, ly + logoSize / 2, logoSize / 2, 0, Math.PI * 2);
    ctx.closePath();
    if (logo) {
      ctx.clip();
      ctx.drawImage(logo, pad, ly, logoSize, logoSize);
    } else {
      ctx.fillStyle = cssVar('--surface-2', '#171a23');
      ctx.fill();
      const { symbol, name } = tokenText();
      ctx.fillStyle = ink2;
      ctx.font = `700 ${k(22)}px ${font}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText((symbol || name || '?').slice(0, 1).toUpperCase(), pad + logoSize / 2, ly + logoSize / 2 + k(1));
    }
    ctx.restore();

    const { name, symbol } = tokenText();
    const tx = pad + logoSize + k(14);
    const narrow = W < k(640);
    const brandW = narrow ? 0 : k(170);
    const textMax = W - tx - pad - brandW;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = ink;
    ctx.font = `700 ${k(24)}px ${font}`;
    const nameText = fitText(ctx, name, textMax * 0.7);
    ctx.fillText(nameText, tx, ly + k(23));
    const nameW = ctx.measureText(nameText).width;
    if (symbol) {
      ctx.fillStyle = muted;
      ctx.font = `600 ${k(16)}px ${mono}`;
      ctx.fillText(fitText(ctx, `$${symbol}`, Math.max(k(40), textMax - nameW - k(10))), tx + nameW + k(10), ly + k(23));
    }
    // King of the Pill chip after the ticker, when this token wears the crown
    if (typeof tokenDetail !== 'undefined' && tokenDetail.isKingOfPill && tokenDetail.isKingOfPill()) {
      const symW = symbol ? ctx.measureText(fitText(ctx, `$${symbol}`, Math.max(k(40), textMax - nameW - k(10)))).width + k(10) : 0;
      const cx = tx + nameW + symW + k(12);
      ctx.font = `700 ${k(12)}px ${font}`;
      const roomW = W - pad - brandW - cx;
      const full = '💊 King of the Pill';
      const label = ctx.measureText(full).width + k(18) <= roomW ? full : '💊 King';
      const chipW = ctx.measureText(label).width + k(18);
      if (chipW <= roomW) {
        const chipH = k(22);
        const cy = ly + k(23) - chipH + k(4);
        ctx.fillStyle = 'rgba(245, 158, 11, 0.16)';
        roundRect(ctx, cx, cy, chipW, chipH, chipH / 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(245, 158, 11, 0.55)';
        ctx.lineWidth = Math.max(1, k(1));
        ctx.stroke();
        ctx.fillStyle = '#fde68a';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, cx + k(9), cy + chipH / 2 + k(1));
        ctx.textBaseline = 'alphabetic';
      }
    }

    ctx.font = `500 ${k(15)}px ${font}`;
    ctx.fillStyle = ink2;
    const titleText = fitText(ctx, title, textMax);
    ctx.fillText(titleText, tx, ly + k(48));
    if (detail) {
      const tw = ctx.measureText(titleText).width;
      ctx.font = `700 ${k(15)}px ${mono}`;
      ctx.fillStyle = accent || ink;
      ctx.fillText(fitText(ctx, detail, Math.max(0, textMax - tw - k(12))), tx + tw + k(12), ly + k(48));
    }

    // Brand, top right (in the footer on narrow images)
    const bIcon = k(30);
    if (!narrow) {
    ctx.font = `700 ${k(17)}px ${font}`;
    const siteW = ctx.measureText(SITE).width;
    const bx = W - pad - siteW;
    const by = ly + logoSize / 2 - k(4);
    if (brand) ctx.drawImage(brand, bx - bIcon - k(8), by - bIcon / 2, bIcon, bIcon);
    const grad = ctx.createLinearGradient(bx, 0, bx + siteW, 0);
    grad.addColorStop(0, brandA);
    grad.addColorStop(1, brandB);
    ctx.fillStyle = grad;
    ctx.textBaseline = 'middle';
    ctx.fillText(SITE, bx, by);
    }

    // Chart
    ctx.drawImage(shot, pad + (chartW - shot.width) / 2, pad + headH + k(10) + legH);

    // Legend key: a short line in each series' color, then its name
    if (legend.length) {
      let lx = pad + k(6);
      const lyMid = pad + headH + k(10) + legH / 2;
      ctx.font = `600 ${k(13)}px ${font}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      for (const item of legend) {
        ctx.strokeStyle = item.color;
        ctx.lineWidth = k(3);
        ctx.setLineDash(item.dashed ? [k(4), k(4)] : []);
        ctx.beginPath();
        ctx.moveTo(lx, lyMid);
        ctx.lineTo(lx + k(20), lyMid);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = ink2;
        ctx.fillText(item.label, lx + k(28), lyMid);
        lx += k(28) + ctx.measureText(item.label).width + k(22);
      }
    }

    // Footer
    ctx.textBaseline = 'middle';
    ctx.font = `500 ${k(12)}px ${font}`;
    ctx.fillStyle = muted;
    const fy = H - footH / 2;
    const when = new Date().toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    ctx.textAlign = 'left';
    ctx.fillText(`${when} · Charts by TradingView`, pad, fy);
    ctx.textAlign = 'right';
    if (narrow && brand) ctx.drawImage(brand, W - pad - ctx.measureText(SITE).width - k(22), fy - k(9), k(18), k(18));
    ctx.fillText(narrow ? SITE : `Holder analytics for Solana tokens · ${SITE}`, W - pad, fy);

    return new Promise((resolve, reject) => c.toBlob(b => (b ? resolve(b) : reject(new Error('Could not export the image'))), 'image/png'));
  }

  function filename(kind, token) {
    const { symbol, name } = token || tokenText();
    const base = (symbol || name || 'token').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'token';
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    return `holdex-${base}-${kind}-${stamp}.png`;
  }

  function saveBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  function note(kind, text) {
    if (typeof toast !== 'undefined' && toast[kind]) toast[kind](text);
  }

  /**
   * Copy the image to the clipboard. The clipboard write starts inside the click (Safari
   * requires it) with the image still rendering. Without image clipboard support, downloads.
   * opts: {what: 'Chart image', token: {name, symbol}} for images that are not of the token page's token
   */
  async function copy(make, kind, { what = 'Chart image', token } = {}) {
    const canClip = typeof ClipboardItem !== 'undefined' && navigator.clipboard && navigator.clipboard.write;
    const pending = make();
    if (canClip) {
      try {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': pending })]);
        note('success', `${what} copied`);
        return;
      } catch (err) {
        console.warn('[chartShot] clipboard write failed:', err?.message);
      }
    }
    try {
      saveBlob(await pending, filename(kind, token));
      note('success', canClip ? 'Copy is blocked here, so the image was downloaded' : `${what} downloaded`);
    } catch (err) {
      console.warn('[chartShot]', err);
      note('error', `Could not create the ${what.toLowerCase()}`);
    }
  }

  async function download(make, kind, { what = 'Chart image', token } = {}) {
    try {
      saveBlob(await make(), filename(kind, token));
      note('success', `${what} downloaded`);
    } catch (err) {
      console.warn('[chartShot]', err);
      note('error', `Could not create the ${what.toLowerCase()}`);
    }
  }

  const ICONS = {
    copy: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    download: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
  };

  // Drawing helpers shared with the King of the Pill share image (kotpShot.js)
  const draw = { cssVar, loadImage, roundRect, fitText, BRAND_ICON, SITE };

  return { capture, copy, download, ICONS, draw, filename, _test: { filename } };
})();
