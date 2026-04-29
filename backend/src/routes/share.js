// Theme-enabled share routes
const express = require('express');
const router = express.Router();
const sharp = require('sharp');
const db = require('../services/database');
const { cache, TTL } = require('../services/cache');

// Frontend URL for redirects
const FRONTEND_URL = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',')[0].trim()
  : 'https://cultscreener.com';

// Solana address format
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Escape HTML entities to prevent XSS in injected meta tags
 */
function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Format price for display
 */
function fmtPrice(price) {
  if (!price || price === 0) return null;
  if (price >= 1) return '$' + price.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (price >= 0.01) return '$' + price.toFixed(4);
  if (price >= 0.0001) return '$' + price.toFixed(6);
  return '$' + price.toExponential(2);
}

/**
 * Format market cap for display
 */
function fmtMcap(mcap) {
  if (!mcap) return null;
  if (mcap >= 1e9) return '$' + (mcap / 1e9).toFixed(2) + 'B';
  if (mcap >= 1e6) return '$' + (mcap / 1e6).toFixed(2) + 'M';
  if (mcap >= 1e3) return '$' + (mcap / 1e3).toFixed(1) + 'K';
  return '$' + Math.round(mcap);
}

/**
 * Generates the SVG preview for a token
 */
function generateTokenSvg(token, mint, theme = 'default') {
  const name = esc(token?.name || token?.symbol || 'Unknown Token');
  const symbol = esc(token?.symbol || '');
  const price = fmtPrice(token?.price) || '--';
  const mcap = fmtMcap(token?.market_cap || token?.marketCap) || '--';
  const change = token?.price_change_24h ?? token?.priceChange24h ?? null;
  const conviction = token?.conviction_1m ?? token?.conviction1m ?? null;
  const holders = token?.holder_count || token?.holders || null;

  const changeStr = change !== null ? `${change >= 0 ? '+' : ''}${change.toFixed(2)}%` : '--';
  const convictionStr = conviction !== null ? `${Math.round(conviction)}%` : '--';
  const holdersStr = holders ? holders.toLocaleString() : '--';

  // Truncate long names
  const displayName = name.length > 24 ? name.slice(0, 22) + '..' : name;
  const mintShort = mint.slice(0, 6) + '...' + mint.slice(-4);
  const convBarWidth = conviction !== null ? Math.min(100, Math.max(0, Math.round(conviction))) : 0;

  // Theme support
  let bg = '#09090b';
  let accent = '#ff5722';
  let secondary = '#ff8c00';
  let textPrimary = '#f0f0f2';
  let textSecondary = '#6b6b74';
  let glowColor = 'rgba(255,87,34,0.04)';

  if (theme === 'cyber') {
      bg = '#050505';
      accent = '#00f2ff'; // Cyan
      secondary = '#ff00ff'; // Magenta
      textPrimary = '#ffffff';
      glowColor = 'rgba(0,242,255,0.08)';
  } else if (theme === 'emerald') {
      bg = '#060a09';
      accent = '#10b981';
      secondary = '#34d399';
      glowColor = 'rgba(16,185,129,0.08)';
  }

  const changeColor = change !== null ? (change >= 0 ? '#10b981' : '#ef4444') : '#a0a0a8';
  const convBarColor = convBarWidth >= 50 ? accent : convBarWidth >= 20 ? secondary : '#3a3a42';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="bgGrad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${bg}"/>
      <stop offset="100%" stop-color="#000000"/>
    </linearGradient>
    <linearGradient id="accentGrad" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="${accent}"/>
      <stop offset="100%" stop-color="${secondary}"/>
    </linearGradient>
  </defs>

  <!-- Background -->
  <rect width="1200" height="630" fill="url(#bgGrad)"/>

  <!-- Subtle top glow -->
  <ellipse cx="600" cy="0" rx="700" ry="250" fill="${glowColor}"/>

  <!-- Border -->
  <rect x="1" y="1" width="1198" height="628" rx="16" ry="16" fill="none" stroke="${glowColor}" stroke-width="1"/>

  <!-- Header bar -->
  <rect x="0" y="0" width="1200" height="80" rx="16" ry="16" fill="rgba(255,255,255,0.02)"/>
  <rect x="0" y="64" width="1200" height="16" fill="rgba(255,255,255,0.02)"/>
  <line x1="40" y1="80" x2="1160" y2="80" stroke="rgba(255,255,255,0.04)" stroke-width="1"/>

  <!-- CultScreener branding -->
  <text x="52" y="50" font-family="Inter,-apple-system,BlinkMacSystemFont,sans-serif" font-size="22" font-weight="900" fill="${textPrimary}">Cult<tspan fill="${accent}">Screener</tspan></text>

  <!-- Flame icon -->
  <g transform="translate(230, 28) scale(0.85)">
    <path d="M12 23c-4.97 0-8-3.03-8-7 0-2.22.98-4.12 2.5-5.5C5.5 8 5 5.5 7 3c1 2 3 3.5 5 4 0-2 1-4 3-6 .5 2 1 4 1 6 2-1 3.5-2.5 4-4 0 3-1 5.5-2.5 7.5C19.02 11.88 20 13.78 20 16c0 3.97-3.03 7-8 7z" fill="${accent}"/>
  </g>

  <!-- "Diamond Hands Terminal" subtitle -->
  <text x="1148" y="48" font-family="Inter,-apple-system,sans-serif" font-size="14" font-weight="500" fill="${textSecondary}" text-anchor="end">Diamond Hands Terminal</text>

  <!-- Token name + symbol -->
  <text x="52" y="155" font-family="Inter,-apple-system,sans-serif" font-size="48" font-weight="800" fill="${textPrimary}">${displayName}</text>
  ${symbol ? `<text x="52" y="190" font-family="Inter,-apple-system,sans-serif" font-size="20" font-weight="500" fill="${textSecondary}">${symbol} · ${mintShort}</text>` : `<text x="52" y="190" font-family="'JetBrains Mono',monospace" font-size="18" fill="${textSecondary}">${mintShort}</text>`}

  <!-- Price -->
  <text x="52" y="275" font-family="Inter,-apple-system,sans-serif" font-size="56" font-weight="800" fill="${textPrimary}">${esc(price)}</text>

  <!-- 24h change badge -->
  <rect x="52" y="295" width="${changeStr.length * 14 + 24}" height="32" rx="8" fill="rgba(255,255,255,0.05)"/>
  <text x="64" y="317" font-family="Inter,-apple-system,sans-serif" font-size="16" font-weight="700" fill="${changeColor}">${esc(changeStr)} 24h</text>

  <!-- Stats row -->
  <!-- MCap -->
  <text x="52" y="400" font-family="Inter,-apple-system,sans-serif" font-size="13" font-weight="600" fill="${textSecondary}" text-transform="uppercase" letter-spacing="1">MARKET CAP</text>
  <text x="52" y="430" font-family="Inter,-apple-system,sans-serif" font-size="28" font-weight="700" fill="${textPrimary}">${esc(mcap)}</text>

  <!-- Holders -->
  <text x="340" y="400" font-family="Inter,-apple-system,sans-serif" font-size="13" font-weight="600" fill="${textSecondary}" letter-spacing="1">HOLDERS</text>
  <text x="340" y="430" font-family="Inter,-apple-system,sans-serif" font-size="28" font-weight="700" fill="${textPrimary}">${esc(holdersStr)}</text>

  <!-- Diamond Hands conviction section -->
  <text x="620" y="400" font-family="Inter,-apple-system,sans-serif" font-size="13" font-weight="600" fill="${accent}" letter-spacing="1">DIAMOND HANDS (1M+)</text>
  <text x="620" y="430" font-family="Inter,-apple-system,sans-serif" font-size="28" font-weight="800" fill="${convBarColor}">${esc(convictionStr)}</text>

  <!-- Conviction bar -->
  <rect x="620" y="448" width="530" height="10" rx="5" fill="rgba(255,255,255,0.04)"/>
  <rect x="620" y="448" width="${Math.round(convBarWidth * 5.3)}" height="10" rx="5" fill="url(#accentGrad)"/>

  <!-- Bottom branding -->
  <line x1="40" y1="545" x2="1160" y2="545" stroke="rgba(255,255,255,0.04)" stroke-width="1"/>
  <text x="52" y="580" font-family="Inter,-apple-system,sans-serif" font-size="16" font-weight="600" fill="${textSecondary}">cultscreener.com</text>
  <text x="1148" y="580" font-family="Inter,-apple-system,sans-serif" font-size="14" font-weight="500" fill="${textSecondary}" text-anchor="end">Powered by ASDFASDFA</text>

  <!-- Accent line at bottom -->
  <rect x="0" y="624" width="1200" height="6" fill="url(#accentGrad)" opacity="0.5"/>
</svg>`;
}

/**
 * GET /share/:mint
 * Serves a minimal HTML page with dynamic OG meta tags for social media crawlers.
 * Browsers get redirected to the real token page on the frontend.
 */
router.get('/:mint', async (req, res) => {
  const { mint } = req.params;
  const theme = req.query.theme || 'default';

  if (!MINT_RE.test(mint)) {
    return res.redirect(302, FRONTEND_URL);
  }

  // Fetch token data (try cache first, then DB)
  let token = null;
  try {
    const cached = await cache.get(`token:${mint}`) || await cache.get(`batch:${mint}`);
    if (cached) {
      token = cached;
    } else {
      token = await db.getToken(mint);
    }
  } catch (_) {}

  const name = token?.name || token?.symbol || 'Unknown Token';
  const symbol = token?.symbol || '';
  const price = fmtPrice(token?.price);
  const mcap = fmtMcap(token?.market_cap || token?.marketCap);
  const change = token?.price_change_24h ?? token?.priceChange24h ?? null;
  const conviction = token?.conviction_1m ?? token?.conviction1m ?? null;

  // Build title
  let title = symbol ? `${name} (${symbol})` : name;
  title += ' - CultScreener';

  // Build description
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
  const ogImageUrl = `${req.protocol}://${req.get('host')}/share/${encodeURIComponent(mint)}/og-image${themeQuery}`;
  // Twitter requires PNG for cards — point to our dynamic PNG generator
  const twitterImageUrl = `${req.protocol}://${req.get('host')}/share/${encodeURIComponent(mint)}/twitter-image.png${themeQuery}`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300'); // 5 min cache

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

<!-- Twitter Card (Twitter/X) -->
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
 * Generates a dynamic SVG preview card for social media embeds.
 * Returns SVG with Content-Type image/svg+xml (works on Discord, Telegram, Facebook).
 */
router.get('/:mint/og-image', async (req, res) => {
  const { mint } = req.params;
  const theme = req.query.theme || 'default';

  if (!MINT_RE.test(mint)) {
    return res.status(400).send('Invalid mint');
  }

  // Fetch token data
  let token = null;
  try {
    const cached = await cache.get(`token:${mint}`) || await cache.get(`batch:${mint}`);
    if (cached) {
      token = cached;
    } else {
      token = await db.getToken(mint);
    }
  } catch (_) {}

  const svg = generateTokenSvg(token, mint, theme);

  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=600'); // 10 min cache
  res.send(svg);
});

/**
 * GET /share/:mint/twitter-image.png
 * Generates a dynamic PNG preview card for Twitter (which doesn't support SVG).
 */
router.get('/:mint/twitter-image.png', async (req, res) => {
  const { mint } = req.params;
  const theme = req.query.theme || 'default';

  if (!MINT_RE.test(mint)) {
    return res.status(400).send('Invalid mint');
  }

  // Fetch token data
  let token = null;
  try {
    const cached = await cache.get(`token:${mint}`) || await cache.get(`batch:${mint}`);
    if (cached) {
      token = cached;
    } else {
      token = await db.getToken(mint);
    }
  } catch (_) {}

  const svg = generateTokenSvg(token, mint, theme);

  try {
    // Convert SVG to PNG using sharp
    const pngBuffer = await sharp(Buffer.from(svg))
      .png()
      .toBuffer();

    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=600'); // 10 min cache
    res.send(pngBuffer);
  } catch (err) {
    console.error('[Share] PNG generation failed:', err.message);
    // Fallback to static banner if PNG generation fails
    res.redirect(`${FRONTEND_URL}/CultScreenerBanner.jpg`);
  }
});

module.exports = router;
