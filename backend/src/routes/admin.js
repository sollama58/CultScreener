const express = require('express');
const router = express.Router();
const db = require('../services/database');
const { cache } = require('../services/cache');
const {
  asyncHandler, requireDatabase, validateAdminSession,
  verifyAdminPassword, generateAdminSessionToken,
  ADMIN_SESSION_DURATION_MS
} = require('../middleware/validation');
const { veryStrictLimiter, strictLimiter } = require('../middleware/rateLimit');

router.use(requireDatabase);

// ==========================================
// Authentication
// ==========================================

router.post('/login', veryStrictLimiter, asyncHandler(async (req, res) => {
  const { password } = req.body;
  if (!password || typeof password !== 'string') {
    return res.status(400).json({ error: 'Password is required' });
  }

  const valid = await verifyAdminPassword(password);
  if (!valid) {
    return res.status(401).json({ error: 'Invalid password' });
  }

  const token = generateAdminSessionToken();
  const expiresAt = new Date(Date.now() + ADMIN_SESSION_DURATION_MS);

  await db.createAdminSession(token, expiresAt, req.ip, req.headers['user-agent']);

  res.cookie('admin_session', token, {
    maxAge: ADMIN_SESSION_DURATION_MS,
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    path: '/'
  });

  res.json({ success: true, token, expiresAt: expiresAt.toISOString() });
}));

// All routes below require valid admin session
router.use(validateAdminSession);

router.post('/logout', asyncHandler(async (req, res) => {
  const token = req.cookies?.admin_session || req.header('X-Admin-Session');
  if (token) {
    await db.deleteAdminSession(token);
  }
  res.clearCookie('admin_session', { path: '/' });
  res.json({ success: true });
}));

// ==========================================
// Dashboard Stats
// ==========================================

router.get('/stats', asyncHandler(async (req, res) => {
  const stats = await db.getAdminStats();
  res.json(stats);
}));

// ==========================================
// Conviction Maintenance
// ==========================================

router.post('/flush-failed-wallets', strictLimiter, asyncHandler(async (req, res) => {
  const { cache } = require('../services/cache');

  // Scan for wallet cache keys with -1 sentinel values (failed lookups)
  // and delete them so the next conviction refresh re-attempts with the ATA fallback.
  let flushed = 0;
  let scanned = 0;

  try {
    // Scan wallet-hold-time, wallet-token-hold, and wallet-age keys
    const patterns = ['wallet-hold-time:*', 'wallet-token-hold:*', 'wallet-age:*'];

    for (const pattern of patterns) {
      const keys = await cache.scanKeys(pattern);
      scanned += keys.length;

      for (const key of keys) {
        const val = await cache.get(key);
        if (val === -1 || val === null) {
          await cache.delete(key);
          flushed++;
        }
      }
    }

    // Also clear diamond-hands distribution caches so they recompute
    const dhKeys = await cache.scanKeys('diamond-hands:*');
    for (const key of dhKeys) {
      await cache.delete(key);
      flushed++;
    }

    // Clear holder-metrics-pending flags so recomputation isn't blocked
    const pendingKeys = await cache.scanKeys('holder-metrics-pending:*');
    for (const key of pendingKeys) {
      await cache.delete(key);
      flushed++;
    }

    console.log(`[Admin] Flushed ${flushed} failed wallet caches (scanned ${scanned} keys)`);
    res.json({ success: true, flushed, scanned });
  } catch (err) {
    console.error('[Admin] Flush failed wallet caches error:', err.message);
    res.status(500).json({ error: 'Failed to flush caches' });
  }
}));

router.post('/refresh-holder-counts', strictLimiter, asyncHandler(async (req, res) => {
  const { cache, keys } = require('../services/cache');
  const solanaService = require('../services/solana');

  // Collect all token mints: curated + leaderboard
  const mintSet = new Set();
  try {
    const curated = await db.getCuratedTokens();
    curated.forEach(t => { if (t.mintAddress || t.mint_address) mintSet.add(t.mintAddress || t.mint_address); });
  } catch (_) {}

  try {
    const { tokens } = await db.getTopConvictionTokens(100, 0, {});
    tokens.forEach(t => { if (t.mint_address) mintSet.add(t.mint_address); });
  } catch (_) {}

  const mints = [...mintSet];
  let updated = 0;
  let failed = 0;
  const results = {};

  // Clear ALL old holder count caches first so stale data isn't served
  for (const mint of mints) {
    await cache.delete(`holder-total:${mint}`).catch(() => {});
    await cache.delete(keys.holderCount(mint)).catch(() => {});
  }

  // Fetch fresh counts from Solscan
  for (const mint of mints) {
    try {
      const count = await solanaService.getTokenHolderCount(mint);
      if (count && count > 0) {
        await cache.set(`holder-total:${mint}`, count, 86400000);
        await cache.set(keys.holderCount(mint), count, 86400000);
        results[mint] = count;
        updated++;
      } else {
        failed++;
      }
    } catch {
      failed++;
    }
    // Rate limit Solscan: 500ms between calls
    if (updated + failed < mints.length) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  // Clear all caches that display holder counts so new data appears immediately
  try {
    // Leaderboard cache
    const lbKeys = await cache.scanKeys('leaderboard:conviction:*');
    for (const key of lbKeys) await cache.delete(key);
    // Token detail page caches
    for (const mint of mints) {
      await cache.delete(`token:${mint}`).catch(() => {});
      await cache.delete(`holder-analytics:${mint}`).catch(() => {});
    }
  } catch (_) {}

  console.log(`[Admin] Refreshed holder counts from Solscan: ${updated} updated, ${failed} failed, ${mints.length} total`);
  res.json({ success: true, updated, failed, total: mints.length });
}));

// ==========================================
// Curated Tokens (session-based proxy)
// ==========================================

router.get('/curated', asyncHandler(async (req, res) => {
  const tokens = await db.getCuratedTokens();
  res.json({ tokens });
}));

router.post('/curated', strictLimiter, asyncHandler(async (req, res) => {
  const { mintAddress } = req.body;
  if (!mintAddress || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mintAddress)) {
    return res.status(400).json({ error: 'Invalid mint address' });
  }

  await db.addCuratedToken(mintAddress);

  // Enrich with DexScreener data
  try {
    const axios = require('axios');
    const response = await axios.get(
      `https://api.dexscreener.com/tokens/v1/solana/${encodeURIComponent(mintAddress)}`,
      { timeout: 10000 }
    );
    const pairs = response.data;
    if (Array.isArray(pairs) && pairs.length > 0) {
      const info = pairs[0].info || {};
      const socials = Array.isArray(info.socials) ? info.socials : [];
      const websites = Array.isArray(info.websites) ? info.websites : [];
      const findSocial = (type) => { const e = socials.find(s => s.type === type); return e ? e.url : null; };
      await db.updateCuratedTokenDexScreener(mintAddress, {
        bannerUrl: info.header || null,
        socials: {
          twitter: findSocial('twitter'),
          telegram: findSocial('telegram'),
          discord: findSocial('discord'),
          website: websites.length > 0 ? websites[0].url : null
        }
      });
    }
  } catch (_) { /* DexScreener enrichment is non-critical */ }

  // Trigger conviction analysis in the background so the token
  // appears on the main leaderboard after holder data is computed
  try {
    const http = require('http');
    const PORT = process.env.PORT || 3000;
    const url = `http://127.0.0.1:${PORT}/api/tokens/${encodeURIComponent(mintAddress)}/holders/diamond-hands`;
    const triggerReq = http.get(url, (r) => { r.resume(); });
    triggerReq.on('error', () => {});
    triggerReq.setTimeout(15000, () => triggerReq.destroy());
  } catch (_) { /* non-critical */ }

  const token = await db.getCuratedToken(mintAddress);
  res.status(201).json({ success: true, token });
}));

router.delete('/curated/:mint', strictLimiter, asyncHandler(async (req, res) => {
  const { mint } = req.params;
  if (!mint || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) {
    return res.status(400).json({ error: 'Invalid mint address' });
  }
  const result = await db.removeCuratedToken(mint);
  if (!result) return res.status(404).json({ error: 'Token not found in curated list' });

  // Invalidate all caches that could contain this token
  try {
    await Promise.all([
      cache.clearPattern('list:*'),
      cache.clearPattern('search:*'),
      cache.delete(`token:${mint}`),
      cache.delete(`price:${mint}`),
      cache.delete(`pools:${mint}`),
      cache.delete(`holders:${mint}`),
      cache.delete(`batch:${mint}`),
      cache.clearPattern(`*${mint}*`),
    ]);
  } catch (_) { /* cache clear is non-critical */ }

  res.json({ success: true });
}));

router.post('/curated/refresh', strictLimiter, asyncHandler(async (req, res) => {
  const tokens = await db.getCuratedTokens();
  const results = { updated: 0, failed: 0, total: tokens.length };
  const axios = require('axios');

  for (let i = 0; i < tokens.length; i++) {
    const mint = tokens[i].mintAddress || tokens[i].mint_address;
    try {
      const response = await axios.get(
        `https://api.dexscreener.com/tokens/v1/solana/${encodeURIComponent(mint)}`,
        { timeout: 10000 }
      );
      const pairs = response.data;
      if (Array.isArray(pairs) && pairs.length > 0) {
        const info = pairs[0].info || {};
        const socials = Array.isArray(info.socials) ? info.socials : [];
        const websites = Array.isArray(info.websites) ? info.websites : [];
        const findSocial = (type) => { const e = socials.find(s => s.type === type); return e ? e.url : null; };
        await db.updateCuratedTokenDexScreener(mint, {
          bannerUrl: info.header || null,
          socials: { twitter: findSocial('twitter'), telegram: findSocial('telegram'), discord: findSocial('discord'), website: websites.length > 0 ? websites[0].url : null }
        });
        results.updated++;
      } else {
        results.failed++;
      }
    } catch {
      results.failed++;
    }
    // Rate limit: 1 second between DexScreener calls
    if (i < tokens.length - 1) await new Promise(r => setTimeout(r, 1000));
  }
  res.json({ success: true, ...results });
}));

// ==========================================
// Announcements
// ==========================================

router.get('/announcements', asyncHandler(async (req, res) => {
  try {
    const announcements = await db.getAllAnnouncements();
    res.json({ announcements });
  } catch {
    res.json({ announcements: [] });
  }
}));

router.post('/announcements', strictLimiter, asyncHandler(async (req, res) => {
  const { title, message, type, expiresAt } = req.body;
  if (!title || typeof title !== 'string' || title.length > 200) {
    return res.status(400).json({ error: 'Title is required (max 200 chars)' });
  }
  if (!message || typeof message !== 'string' || message.length > 2000) {
    return res.status(400).json({ error: 'Message is required (max 2000 chars)' });
  }
  const validTypes = ['info', 'warning', 'success', 'error'];
  const safeType = validTypes.includes(type) ? type : 'info';

  const announcement = await db.createAnnouncement({
    title: title.trim(),
    message: message.trim(),
    type: safeType,
    expiresAt: expiresAt || null
  });
  res.status(201).json({ success: true, announcement });
}));

router.patch('/announcements/:id', strictLimiter, asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id) || id < 1) return res.status(400).json({ error: 'Invalid ID' });

  // Validate fields consistent with POST endpoint
  const updates = {};
  if (req.body.title !== undefined) {
    if (typeof req.body.title !== 'string' || req.body.title.length === 0 || req.body.title.length > 200) {
      return res.status(400).json({ error: 'Title must be 1-200 characters' });
    }
    updates.title = req.body.title.trim();
  }
  if (req.body.message !== undefined) {
    if (typeof req.body.message !== 'string' || req.body.message.length === 0 || req.body.message.length > 2000) {
      return res.status(400).json({ error: 'Message must be 1-2000 characters' });
    }
    updates.message = req.body.message.trim();
  }
  if (req.body.type !== undefined) {
    const validTypes = ['info', 'warning', 'success', 'error'];
    if (!validTypes.includes(req.body.type)) {
      return res.status(400).json({ error: `Type must be one of: ${validTypes.join(', ')}` });
    }
    updates.type = req.body.type;
  }
  if (req.body.isActive !== undefined) updates.isActive = req.body.isActive;
  if (req.body.expiresAt !== undefined) updates.expiresAt = req.body.expiresAt;

  const result = await db.updateAnnouncement(id, updates);
  if (!result) return res.status(404).json({ error: 'Announcement not found' });
  res.json({ success: true, announcement: result });
}));

router.delete('/announcements/:id', strictLimiter, asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id) || id < 1) return res.status(400).json({ error: 'Invalid ID' });

  const result = await db.deleteAnnouncement(id);
  if (!result) return res.status(404).json({ error: 'Announcement not found' });
  res.json({ success: true });
}));

// ==========================================
// Bug Reports
// ==========================================

router.get('/bug-reports', asyncHandler(async (req, res) => {
  const status = req.query.status || 'all';
  const limit = Math.min(100, parseInt(req.query.limit) || 50);
  const offset = parseInt(req.query.offset) || 0;

  try {
    const [reports, counts] = await Promise.all([
      db.getAllBugReports({ status, limit, offset }),
      db.getBugReportCounts()
    ]);
    res.json({ ...reports, counts });
  } catch {
    res.json({ reports: [], total: 0, counts: {} });
  }
}));

router.patch('/bug-reports/:id', strictLimiter, asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id) || id < 1) return res.status(400).json({ error: 'Invalid ID' });

  const validStatuses = ['new', 'acknowledged', 'resolved', 'dismissed'];
  if (req.body.status && !validStatuses.includes(req.body.status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  const result = await db.updateBugReportStatus(id, req.body);
  if (!result) return res.status(404).json({ error: 'Bug report not found' });
  res.json({ success: true, report: result });
}));

router.delete('/bug-reports/:id', strictLimiter, asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id) || id < 1) return res.status(400).json({ error: 'Invalid ID' });

  const result = await db.deleteBugReport(id);
  if (!result) return res.status(404).json({ error: 'Bug report not found' });
  res.json({ success: true });
}));

// ==========================================
// Submissions
// ==========================================

router.get('/submissions', asyncHandler(async (req, res) => {
  const status = req.query.status || undefined;
  const limit = Math.min(100, parseInt(req.query.limit) || 50);
  const offset = parseInt(req.query.offset) || 0;
  const sortBy = req.query.sortBy || 'created_at';
  const sortOrder = req.query.sortOrder === 'ASC' ? 'ASC' : 'DESC';
  const tokenMint = req.query.tokenMint || undefined;

  try {
    const result = await db.getAllSubmissions({ status, tokenMint, limit, offset, sortBy, sortOrder });
    res.json(result);
  } catch {
    res.json({ submissions: [], total: 0 });
  }
}));

router.patch('/submissions/:id', strictLimiter, asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id) || id < 1) return res.status(400).json({ error: 'Invalid ID' });

  const validStatuses = ['approved', 'rejected', 'pending'];
  if (!req.body.status || !validStatuses.includes(req.body.status)) {
    return res.status(400).json({ error: 'Valid status required (approved, rejected, pending)' });
  }

  const result = await db.updateSubmissionStatus(id, req.body.status);
  if (!result) return res.status(404).json({ error: 'Submission not found' });

  db.invalidateAdminStatsCache();
  res.json({ success: true, submission: result });
}));

module.exports = router;
