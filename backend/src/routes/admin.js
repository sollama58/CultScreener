const express = require('express');
const router = express.Router();
const db = require('../services/database');
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
    httpOnly: false,
    secure: process.env.NODE_ENV === 'production',
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
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });

  const result = await db.updateAnnouncement(id, req.body);
  if (!result) return res.status(404).json({ error: 'Announcement not found' });
  res.json({ success: true, announcement: result });
}));

router.delete('/announcements/:id', strictLimiter, asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });

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
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });

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
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });

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
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });

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
