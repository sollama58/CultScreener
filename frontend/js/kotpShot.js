// King of the Pill share image: the King on its own, or the King on a podium with the two
// runners-up from today's Diamond Hands scores. Drawn on a canvas in the same style as the
// chart images (chartShot.js, whose drawing, copy and download helpers it reuses) and opened
// from the Share button beside the banner (kotp.js).
const kotpShot = (() => {
  const W = 1200;
  const H = 675;
  const GOLD = '#f59e0b';
  const GOLD_INK = '#fde68a';
  const RANKS = [
    { fill: 'rgba(245, 158, 11, 0.18)', stroke: 'rgba(245, 158, 11, 0.7)', ink: '#fde68a' },
    { fill: 'rgba(203, 213, 225, 0.12)', stroke: 'rgba(203, 213, 225, 0.55)', ink: '#e2e8f0' },
    { fill: 'rgba(217, 119, 6, 0.12)', stroke: 'rgba(205, 127, 50, 0.6)', ink: '#f2b27a' },
  ];

  const d = () => chartShot.draw;

  function label(t) {
    return { name: t.name || t.symbol || 'Token', symbol: (t.symbol || '').replace(/^\$/, '') };
  }

  // Through the image proxy with CORS so the canvas stays exportable (see chartShot.tokenLogo)
  async function logoOf(t) {
    const raw = t.logoUri || '';
    const src = raw && typeof utils !== 'undefined' && utils.proxyImageUrl ? utils.proxyImageUrl(raw) : null;
    if (!src) return null;
    const img = await d().loadImage(src, !src.startsWith('data:'));
    return img && img.naturalWidth > 0 ? img : null;
  }

  /** The King and up to two runners-up, from the /api/tokens/king-of-pill payload. */
  function entries(token) {
    const king = { ...token, score: token.kotp?.score ?? null };
    const runners = (token.kotp?.contenders || []).slice(0, 2);
    return { king, runners };
  }

  function hasRunners(token) {
    return entries(token).runners.length > 0;
  }

  // A crown centred on (cx, baseY), w wide: five points over a band, in a gold gradient
  function crown(ctx, cx, baseY, w) {
    const h = w * 0.62;
    const x0 = cx - w / 2;
    const top = baseY - h;
    ctx.save();
    ctx.shadowColor = 'rgba(245, 158, 11, 0.55)';
    ctx.shadowBlur = w * 0.35;
    const g = ctx.createLinearGradient(0, top, 0, baseY);
    g.addColorStop(0, '#fff3c4');
    g.addColorStop(0.45, '#fbbf24');
    g.addColorStop(1, '#b45309');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(x0, baseY);
    ctx.lineTo(x0, top + h * 0.28);
    ctx.lineTo(x0 + w * 0.22, top + h * 0.62);
    ctx.lineTo(cx, top);
    ctx.lineTo(x0 + w * 0.78, top + h * 0.62);
    ctx.lineTo(x0 + w, top + h * 0.28);
    ctx.lineTo(x0 + w, baseY);
    ctx.closePath();
    ctx.fill();
    ctx.shadowBlur = 0;
    // Jewels on the band and the tips
    ctx.fillStyle = '#fff7d6';
    for (const [jx, jy, r] of [[x0, top + h * 0.28, 0.07], [cx, top, 0.08], [x0 + w, top + h * 0.28, 0.07]]) {
      ctx.beginPath();
      ctx.arc(jx, jy, w * r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = 'rgba(124, 45, 18, 0.55)';
    ctx.fillRect(x0, baseY - h * 0.2, w, h * 0.06);
    ctx.restore();
  }

  // A round logo with a coloured ring; the first letter on a disc when there is no logo
  function avatar(ctx, img, t, cx, cy, r, ring, ringW, glow) {
    const { cssVar } = d();
    ctx.save();
    if (glow) {
      ctx.shadowColor = glow;
      ctx.shadowBlur = r * 0.6;
    }
    ctx.beginPath();
    ctx.arc(cx, cy, r + ringW, 0, Math.PI * 2);
    ctx.fillStyle = ring;
    ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.closePath();
    ctx.fillStyle = cssVar('--surface-2', '#171a23');
    ctx.fill();
    if (img) {
      ctx.clip();
      ctx.drawImage(img, cx - r, cy - r, r * 2, r * 2);
    } else {
      const { name, symbol } = label(t);
      ctx.fillStyle = cssVar('--ink-2', '#aab1c2');
      ctx.font = `700 ${Math.round(r * 0.9)}px ${cssVar('--font', 'Inter, system-ui, sans-serif')}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText((symbol || name || '?').slice(0, 1).toUpperCase(), cx, cy + r * 0.04);
    }
    ctx.restore();
  }

  function goldRing(ctx, cx, cy, r) {
    const g = ctx.createLinearGradient(cx - r, cy - r, cx + r, cy + r);
    g.addColorStop(0, '#fde68a');
    g.addColorStop(0.5, '#f59e0b');
    g.addColorStop(1, '#b45309');
    return g;
  }

  // A rounded pill with centred text; returns its width. align: 'center' | 'left'
  function chip(ctx, text, x, y, { font, fill, stroke, ink, padX = 16, h = 40, align = 'center' }) {
    ctx.font = font;
    const w = ctx.measureText(text).width + padX * 2;
    const left = align === 'center' ? x - w / 2 : x;
    ctx.fillStyle = fill;
    d().roundRect(ctx, left, y, w, h, h / 2);
    ctx.fill();
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    ctx.fillStyle = ink;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, left + padX, y + h / 2 + 1);
    return w;
  }

  // Chips side by side, centred on cx as a row
  function chipRow(ctx, items, cx, y, opts) {
    if (!items.length) return;
    const gap = 12;
    ctx.font = opts.font;
    const widths = items.map(it => ctx.measureText(it.text).width + (opts.padX || 16) * 2);
    let x = cx - (widths.reduce((a, b) => a + b, 0) + gap * (items.length - 1)) / 2;
    items.forEach((it, i) => {
      chip(ctx, it.text, x, y, { ...opts, ...it, align: 'left' });
      x += widths[i] + gap;
    });
  }

  function fmtScore(v) {
    return v == null ? null : Number(v).toFixed(1);
  }

  function fmtChange(v) {
    if (v == null || !Number.isFinite(Number(v))) return null;
    const n = Number(v);
    return `${n >= 0 ? '+' : ''}${n.toFixed(2)}% 24h`;
  }

  function background(ctx) {
    const { cssVar } = d();
    ctx.fillStyle = cssVar('--page', '#07080c');
    ctx.fillRect(0, 0, W, H);
    const gold = ctx.createRadialGradient(W / 2, H * 0.32, 0, W / 2, H * 0.32, W * 0.55);
    gold.addColorStop(0, 'rgba(245, 158, 11, 0.20)');
    gold.addColorStop(1, 'rgba(245, 158, 11, 0)');
    ctx.fillStyle = gold;
    ctx.fillRect(0, 0, W, H);
    const brand = ctx.createRadialGradient(W * 0.08, H, 0, W * 0.08, H, W * 0.6);
    brand.addColorStop(0, 'rgba(139, 92, 246, 0.16)');
    brand.addColorStop(1, 'rgba(139, 92, 246, 0)');
    ctx.fillStyle = brand;
    ctx.fillRect(0, 0, W, H);
    // A thin gold frame
    ctx.strokeStyle = 'rgba(245, 158, 11, 0.28)';
    ctx.lineWidth = 2;
    d().roundRect(ctx, 14, 14, W - 28, H - 28, 22);
    ctx.stroke();
  }

  function header(ctx, brandImg, subtitle) {
    const { cssVar, SITE } = d();
    const font = cssVar('--font', 'Inter, system-ui, sans-serif');
    // Brand, top left
    const by = 66;
    if (brandImg) ctx.drawImage(brandImg, 48, by - 20, 40, 40);
    ctx.font = `700 24px ${font}`;
    const siteW = ctx.measureText(SITE).width;
    const grad = ctx.createLinearGradient(100, 0, 100 + siteW, 0);
    grad.addColorStop(0, cssVar('--brand-a', '#8b5cf6'));
    grad.addColorStop(1, cssVar('--brand-b', '#3b82f6'));
    ctx.fillStyle = grad;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(SITE, 100, by);
    // Title chip, top right
    ctx.font = `800 17px ${font}`;
    const title = '💊 KING OF THE PILL';
    const tw = ctx.measureText(title).width + 36;
    chip(ctx, title, W - 48 - tw, by - 21, {
      font: `800 17px ${font}`, fill: 'rgba(245, 158, 11, 0.16)', stroke: 'rgba(245, 158, 11, 0.6)',
      ink: GOLD_INK, padX: 18, h: 42, align: 'left',
    });
    if (subtitle) {
      ctx.font = `500 16px ${font}`;
      ctx.fillStyle = cssVar('--ink-2', '#aab1c2');
      ctx.textAlign = 'right';
      ctx.fillText(subtitle, W - 48, by + 40);
    }
  }

  function footer(ctx, note) {
    const { cssVar, SITE } = d();
    const font = cssVar('--font', 'Inter, system-ui, sans-serif');
    const fy = H - 46;
    ctx.font = `500 15px ${font}`;
    ctx.fillStyle = cssVar('--muted', '#868da0');
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    const when = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    ctx.fillText(note ? `${when} · ${note}` : when, 48, fy);
    ctx.textAlign = 'right';
    ctx.fillText(`Holder analytics for Solana tokens · ${SITE}`, W - 48, fy);
  }

  function drawKing(ctx, king, logo) {
    const { cssVar, fitText } = d();
    const font = cssVar('--font', 'Inter, system-ui, sans-serif');
    const mono = cssVar('--mono', 'ui-monospace, monospace');
    const cx = W / 2;
    const cy = 268;
    const r = 96;
    crown(ctx, cx, cy - r - 18, 108);
    avatar(ctx, logo, king, cx, cy, r, goldRing(ctx, cx, cy, r), 7, 'rgba(245, 158, 11, 0.6)');

    const { name, symbol } = label(king);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = cssVar('--ink', '#f3f5fa');
    ctx.font = `800 58px ${font}`;
    ctx.fillText(fitText(ctx, name, W - 200), cx, 440);
    if (symbol) {
      ctx.font = `600 26px ${mono}`;
      ctx.fillStyle = cssVar('--muted', '#868da0');
      ctx.fillText(fitText(ctx, `$${symbol}`, W - 300), cx, 482);
    }

    const k = king.kotp || {};
    const items = [];
    const score = fmtScore(king.score);
    if (score) items.push({ text: `Diamond Hands score ${score}`, fill: 'rgba(245, 158, 11, 0.16)', stroke: 'rgba(245, 158, 11, 0.55)', ink: GOLD_INK });
    if (k.reignDay) items.push({ text: `Day ${k.reignDay} of its reign`, fill: 'rgba(255, 255, 255, 0.06)', stroke: 'rgba(255, 255, 255, 0.14)', ink: cssVar('--ink-2', '#aab1c2') });
    const chg = fmtChange(king.priceChange24h);
    if (chg) {
      const up = Number(king.priceChange24h) >= 0;
      items.push({ text: chg, fill: up ? 'rgba(34, 197, 94, 0.12)' : 'rgba(239, 68, 68, 0.12)',
                   stroke: up ? 'rgba(74, 222, 128, 0.45)' : 'rgba(255, 128, 128, 0.45)',
                   ink: up ? cssVar('--good-ink', '#4ade80') : cssVar('--bad-ink', '#ff8080') });
    }
    chipRow(ctx, items, cx, 520, { font: `700 18px ${font}`, h: 44, padX: 18 });
  }

  // King in the middle on the tallest block, #2 on the left, #3 on the right
  function drawPodium(ctx, king, runners, logos) {
    const { cssVar, fitText, roundRect } = d();
    const font = cssVar('--font', 'Inter, system-ui, sans-serif');
    const mono = cssVar('--mono', 'ui-monospace, monospace');
    const baseY = 584;
    const colW = 340;
    const slots = [
      { t: king, img: logos[0], rank: 1, cx: W / 2, r: 76, blockTop: 452, nameSize: 34 },
      runners[0] && { t: runners[0], img: logos[1], rank: 2, cx: W / 2 - colW, r: 56, blockTop: 482, nameSize: 26 },
      runners[1] && { t: runners[1], img: logos[2], rank: 3, cx: W / 2 + colW, r: 56, blockTop: 506, nameSize: 26 },
    ].filter(Boolean);

    for (const s of slots) {
      const st = RANKS[s.rank - 1];
      const bw = s.rank === 1 ? 300 : 260;
      // Podium block with its rank
      const g = ctx.createLinearGradient(0, s.blockTop, 0, baseY);
      g.addColorStop(0, st.fill);
      g.addColorStop(1, 'rgba(255, 255, 255, 0.02)');
      ctx.fillStyle = g;
      roundRect(ctx, s.cx - bw / 2, s.blockTop, bw, baseY - s.blockTop, 14);
      ctx.fill();
      ctx.strokeStyle = st.stroke;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = st.ink;
      ctx.font = `800 ${s.rank === 1 ? 48 : 40}px ${font}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(s.rank), s.cx, s.blockTop + (baseY - s.blockTop) / 2 + 4);

      // Score chip just above the block, then ticker, name and logo above that
      const score = fmtScore(s.t.score);
      const chipH = s.rank === 1 ? 38 : 32;
      const chipY = s.blockTop - chipH - 14;
      if (score) {
        chip(ctx, `Score ${score}`, s.cx, chipY, {
          font: `700 ${s.rank === 1 ? 17 : 15}px ${font}`, fill: st.fill, stroke: st.stroke, ink: st.ink,
          padX: 14, h: chipH,
        });
      }
      const { name, symbol } = label(s.t);
      let y = (score ? chipY : s.blockTop) - 16;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      if (symbol) {
        ctx.font = `600 ${s.rank === 1 ? 20 : 17}px ${mono}`;
        ctx.fillStyle = cssVar('--muted', '#868da0');
        ctx.fillText(fitText(ctx, `$${symbol}`, colW - 40), s.cx, y);
        y -= s.rank === 1 ? 32 : 28;
      }
      ctx.font = `800 ${s.nameSize}px ${font}`;
      ctx.fillStyle = cssVar('--ink', '#f3f5fa');
      ctx.fillText(fitText(ctx, name, colW - 40), s.cx, y);
      const cy = y - s.nameSize - s.r - 4;
      if (s.rank === 1) crown(ctx, s.cx, cy - s.r - 14, 84);
      const ring = s.rank === 1 ? goldRing(ctx, s.cx, cy, s.r) : st.stroke;
      avatar(ctx, s.img, s.t, s.cx, cy, s.r, ring, s.rank === 1 ? 6 : 4, s.rank === 1 ? 'rgba(245, 158, 11, 0.55)' : null);
    }
  }

  /**
   * Draw the share image.
   * @param {object} token the /api/tokens/king-of-pill token
   * @param {'king'|'podium'} mode
   * @param {number} [scale] output pixels per layout pixel
   * @returns {Promise<HTMLCanvasElement>}
   */
  async function render(token, mode = 'king', scale = 2) {
    const { king, runners } = entries(token);
    const podium = mode === 'podium' && runners.length > 0;
    const list = podium ? [king, ...runners] : [king];
    const [brand, ...logos] = await Promise.all([d().loadImage(d().BRAND_ICON, false), ...list.map(logoOf)]);

    const c = document.createElement('canvas');
    c.width = W * scale;
    c.height = H * scale;
    const ctx = c.getContext('2d');
    ctx.scale(scale, scale);
    background(ctx);
    const auto = token.kotp?.mode === 'auto';
    header(ctx, brand, podium ? "Today's top Diamond Hands scores" : (auto ? 'Strongest Diamond Hands on HolDEX' : ''));
    if (podium) drawPodium(ctx, king, runners, logos);
    else drawKing(ctx, king, logos[0]);
    footer(ctx, auto ? 'Scores update daily' : '');
    return c;
  }

  function toBlob(canvas) {
    return new Promise((resolve, reject) =>
      canvas.toBlob(b => (b ? resolve(b) : reject(new Error('Could not export the image'))), 'image/png'));
  }

  return { render, toBlob, hasRunners, W, H, _test: { entries, fmtChange, fmtScore } };
})();
