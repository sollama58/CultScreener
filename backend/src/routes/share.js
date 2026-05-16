const express = require('express');
const router = express.Router();
const sharp = require('sharp');
const db = require('../services/database');
const { cache, TTL } = require('../services/cache');

const FRONTEND_URL = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',')[0].trim()
  : 'https://cultscreener.com';

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function fmtPrice(price) {
  if (!price || price === 0) return null;
  if (price >= 1) return '$' + price.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (price >= 0.01) return '$' + price.toFixed(4);
  if (price >= 0.0001) return '$' + price.toFixed(6);
  return '$' + price.toExponential(2);
}

function fmtMcap(mcap) {
  if (!mcap) return null;
  if (mcap >= 1e9) return '$' + (mcap / 1e9).toFixed(2) + 'B';
  if (mcap >= 1e6) return '$' + (mcap / 1e6).toFixed(2) + 'M';
  if (mcap >= 1e3) return '$' + (mcap / 1e3).toFixed(1) + 'K';
  return '$' + Math.round(mcap);
}

async function fetchToken(mint) {
  try {
    const cached = await cache.get(`token:${mint}`) || await cache.get(`batch:${mint}`);
    if (cached) return cached;
    return await db.getToken(mint);
  } catch (_) {
    return null;
  }
}

const THEMES = {
  default: {
    bg: '#09090b',
    bgEnd: '#0f1012',
    accent: '#ff5722',
    secondary: '#ff8c00',
    textPrimary: '#f0f0f2',
    textSecondary: '#6b6b74',
    glowColor: 'rgba(255,87,34,0.04)',
    fireStart: '#ff4500',
    fireEnd: '#ff8c00',
  },
  cyber: {
    bg: '#0a0a1a',
    bgEnd: '#0d0d2a',
    accent: '#00f2ff',
    secondary: '#7b61ff',
    textPrimary: '#e0f7ff',
    textSecondary: '#5a7a8a',
    glowColor: 'rgba(0,242,255,0.04)',
    fireStart: '#00c8ff',
    fireEnd: '#7b61ff',
  },
  emerald: {
    bg: '#0a0f0a',
    bgEnd: '#0d1a0d',
    accent: '#10b981',
    secondary: '#34d399',
    textPrimary: '#e0fff0',
    textSecondary: '#5a8a6a',
    glowColor: 'rgba(16,185,129,0.04)',
    fireStart: '#059669',
    fireEnd: '#34d399',
  },
};

function generateTokenSvg(token, mint, theme = 'default') {
  const t = THEMES[theme] || THEMES.default;

  const name = esc(token?.name || token?.symbol || 'Unknown Token');
  const symbol = esc(token?.symbol || '');
  const price = fmtPrice(token?.price) || '--';
  const mcap = fmtMcap(token?.market_cap || token?.marketCap) || '--';
  const change = token?.price_change_24h ?? token?.priceChange24h ?? null;
  const conviction = token?.conviction_1m ?? token?.conviction1m ?? null;
  const holders = token?.holder_count || token?.holders || null;

  const changeStr = change !== null ? `${change >= 0 ? '+' : ''}${change.toFixed(2)}%` : '--';
  const changeColor = change !== null ? (change >= 0 ? '#10b981' : '#ef4444') : '#a0a0a8';
  const convictionStr = conviction !== null ? `${Math.round(conviction)}%` : '--';
  const holdersStr = holders ? holders.toLocaleString() : '--';

  const displayName = name.length > 24 ? name.slice(0, 22) + '..' : name;
  const mintShort = mint.slice(0, 6) + '...' + mint.slice(-4);

  const convBarWidth = conviction !== null ? Math.min(100, Math.max(0, Math.round(conviction))) : 0;
  const convBarColor = convBarWidth >= 50 ? t.accent : convBarWidth >= 20 ? t.secondary : '#3a3a42';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${t.bg}"/>
      <stop offset="100%" stop-color="${t.bgEnd}"/>
    </linearGradient>
    <linearGradient id="fire" x1="0" y1="1" x2="0" y2="0">
      <stop offset="0%" stop-color="${t.fireStart}"/>
      <stop offset="100%" stop-color="${t.fireEnd}"/>
    </linearGradient>
    <linearGradient id="convGrad" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="${t.fireStart}"/>
      <stop offset="100%" stop-color="${t.accent}"/>
    </linearGradient>
  </defs>

  <rect width="1200" height="630" fill="url(#bg)"/>
  <ellipse cx="600" cy="0" rx="700" ry="250" fill="${t.glowColor}"/>
  <rect x="1" y="1" width="1198" height="628" rx="16" ry="16" fill="none" stroke="${t.accent}22" stroke-width="1"/>

  <!-- Header -->
  <rect x="0" y="0" width="1200" height="80" rx="16" ry="16" fill="rgba(255,255,255,0.02)"/>
  <rect x="0" y="64" width="1200" height="16" fill="rgba(255,255,255,0.02)"/>
  <line x1="40" y1="80" x2="1160" y2="80" stroke="rgba(255,255,255,0.04)" stroke-width="1"/>

  <text x="52" y="50" font-family="Inter,-apple-system,BlinkMacSystemFont,sans-serif" font-size="22" font-weight="800" fill="${t.textPrimary}">Cult<tspan fill="url(#fire)">Screener</tspan></text>
  <g transform="translate(230, 28) scale(0.85)">
    <path d="M12 23c-4.97 0-8-3.03-8-7 0-2.22.98-4.12 2.5-5.5C5.5 8 5 5.5 7 3c1 2 3 3.5 5 4 0-2 1-4 3-6 .5 2 1 4 1 6 2-1 3.5-2.5 4-4 0 3-1 5.5-2.5 7.5C19.02 11.88 20 13.78 20 16c0 3.97-3.03 7-8 7z" fill="url(#fire)"/>
  </g>
  <text x="1148" y="48" font-family="Inter,-apple-system,sans-serif" font-size="14" font-weight="500" fill="${t.textSecondary}" text-anchor="end">Diamond Hands Terminal</text>

  <!-- Token -->
  <text x="52" y="155" font-family="Inter,-apple-system,sans-serif" font-size="48" font-weight="700" fill="${t.textPrimary}">${displayName}</text>
  ${symbol ? `<text x="52" y="190" font-family="Inter,-apple-system,sans-serif" font-size="20" font-weight="500" fill="${t.textSecondary}">${symbol} · ${mintShort}</text>` : `<text x="52" y="190" font-family="monospace" font-size="18" fill="${t.textSecondary}">${mintShort}</text>`}

  <!-- Price -->
  <text x="52" y="275" font-family="Inter,-apple-system,sans-serif" font-size="56" font-weight="800" fill="${t.textPrimary}">${esc(price)}</text>

  <!-- 24h change -->
  <rect x="52" y="295" width="${changeStr.length * 14 + 24}" height="32" rx="8" fill="${change !== null && change >= 0 ? 'rgba(16,185,129,0.12)' : 'rgba(239,68,68,0.12)'}"/>
  <text x="64" y="317" font-family="Inter,-apple-system,sans-serif" font-size="16" font-weight="700" fill="${changeColor}">${esc(changeStr)} 24h</text>

  <!-- Stats -->
  <text x="52" y="400" font-family="Inter,-apple-system,sans-serif" font-size="13" font-weight="600" fill="${t.textSecondary}" letter-spacing="1">MARKET CAP</text>
  <text x="52" y="430" font-family="Inter,-apple-system,sans-serif" font-size="28" font-weight="700" fill="#a0a0a8">${esc(mcap)}</text>

  <text x="340" y="400" font-family="Inter,-apple-system,sans-serif" font-size="13" font-weight="600" fill="${t.textSecondary}" letter-spacing="1">HOLDERS</text>
  <text x="340" y="430" font-family="Inter,-apple-system,sans-serif" font-size="28" font-weight="700" fill="#a0a0a8">${esc(holdersStr)}</text>

  <text x="620" y="400" font-family="Inter,-apple-system,sans-serif" font-size="13" font-weight="600" fill="${t.accent}" letter-spacing="1">DIAMOND HANDS (1M+)</text>
  <text x="620" y="430" font-family="Inter,-apple-system,sans-serif" font-size="28" font-weight="800" fill="${conviction !== null && conviction >= 50 ? t.accent : conviction !== null && conviction >= 20 ? t.secondary : '#a0a0a8'}">${esc(convictionStr)}</text>

  <!-- Conviction bar -->
  <rect x="620" y="448" width="530" height="10" rx="5" fill="rgba(255,255,255,0.04)"/>
  <rect x="620" y="448" width="${Math.round(convBarWidth * 5.3)}" height="10" rx="5" fill="${convBarColor}"/>

  <!-- Footer -->
  <line x1="40" y1="545" x2="1160" y2="545" stroke="rgba(255,255,255,0.04)" stroke-width="1"/>
  <text x="52" y="580" font-family="Inter,-apple-system,sans-serif" font-size="16" font-weight="600" fill="#45454d">cultscreener.com</text>
  <text x="1148" y="580" font-family="Inter,-apple-system,sans-serif" font-size="14" font-weight="500" fill="#45454d" text-anchor="end">Solana Diamond Hands Terminal</text>

  <rect x="0" y="624" width="1200" height="6" fill="url(#fire)" opacity="0.5"/>
</svg>`;
}

/**
 * GET /share/:mint
 * Serves dynamic OG meta tags for social media crawlers.
 * Browsers get redirected to the real token page.
 */
router.get('/:mint', async (req, res) => {
  const { mint } = req.params;
  const theme = req.query.theme || 'default';

  if (!MINT_RE.test(mint)) {
    return res.redirect(302, FRONTEND_URL);
  }

  const token = await fetchToken(mint);

  const name = token?.name || token?.symbol || 'Unknown Token';
  const symbol = token?.symbol || '';
  const price = fmtPrice(token?.price);
  const mcap = fmtMcap(token?.market_cap || token?.marketCap);
  const change = token?.price_change_24h ?? token?.priceChange24h ?? null;
  const conviction = token?.conviction_1m ?? token?.conviction1m ?? null;

  let title = symbol ? `${name} (${symbol})` : name;
  title += ' - CultScreener';

  const parts = [];
  if (price) parts.push(price);
  if (change !== null) {
    const sign = change >= 0 ? '+' : '';
    parts.push(`${sign}${change.toFixed(2)}% 24h`);
  }
  if (mcap) parts.push(`MCap ${mcap}`);
  if (conviction !== null) parts.push(`Diamond Hands ${Math.round(conviction)}%`);

  let description = parts.length > 0
    ? parts.join(' | ')
    : 'View token details, price charts, holder analytics, and diamond hands conviction data.';
  description += ' | CultScreener - Solana Diamond Hands Terminal';

  const themeParam = theme !== 'default' ? `&theme=${encodeURIComponent(theme)}` : '';
  const tokenPageUrl = `${FRONTEND_URL}/token.html?mint=${encodeURIComponent(mint)}${themeParam}`;

  const themeQuery = theme !== 'default' ? `?theme=${encodeURIComponent(theme)}` : '';
  const apiBaseUrl = process.env.API_BASE_URL || `${req.protocol}://api.cultscreener.com`;
  const ogImageUrl = `${apiBaseUrl}/share/${encodeURIComponent(mint)}/og-image${themeQuery}`;
  const twitterImageUrl = `${apiBaseUrl}/share/${encodeURIComponent(mint)}/twitter-image.png${themeQuery}`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300');

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">

<!-- Open Graph (Discord, Telegram, Facebook) -->
<meta property="og:type" content="website">
<meta property="og:site_name" content="CultScreener">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:image" content="${esc(ogImageUrl)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:url" content="${esc(tokenPageUrl)}">

<!-- Twitter Card (X) -->
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${esc(twitterImageUrl)}">

<!-- Redirect browsers to the real page -->
<meta http-equiv="refresh" content="0; url=${esc(tokenPageUrl)}">
<link rel="canonical" href="${esc(tokenPageUrl)}">
</head>
<body>
<p>Redirecting to <a href="${esc(tokenPageUrl)}">${esc(title)}</a>...</p>
<script>window.location.replace(${JSON.stringify(tokenPageUrl)});</script>
</body>
</html>`);
});

/**
 * GET /share/:mint/og-image
 * Returns SVG preview card (Discord, Telegram, Facebook).
 */
router.get('/:mint/og-image', async (req, res) => {
  const { mint } = req.params;
  const theme = req.query.theme || 'default';

  if (!MINT_RE.test(mint)) {
    return res.status(400).send('Invalid mint');
  }

  const token = await fetchToken(mint);
  const svg = generateTokenSvg(token, mint, theme);

  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=600');
  res.send(svg);
});

/**
 * GET /share/:mint/twitter-image.png
 * Converts the SVG card to PNG for Twitter/X compatibility.
 * X does not support SVG in twitter:image meta tags.
 */
router.get('/:mint/twitter-image.png', async (req, res) => {
  const { mint } = req.params;
  const theme = req.query.theme || 'default';

  if (!MINT_RE.test(mint)) {
    return res.status(400).send('Invalid mint');
  }

  const token = await fetchToken(mint);
  const svg = generateTokenSvg(token, mint, theme);

  try {
    const png = await sharp(Buffer.from(svg)).png().toBuffer();
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=600');
    res.send(png);
  } catch (err) {
    console.error('PNG generation failed:', err.message);
    res.status(500).send('Image generation failed');
  }
});

module.exports = router;
