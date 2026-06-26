// routes/admin.js
// Platform-admin endpoints. Right now this is just supporter-tier management, so
// tiers can be granted and tested before any payment rail exists (and so the
// referral system and billing can reuse grantTier). Admin status comes from the
// is_admin flag (set via the ADMIN_EMAILS env, see db.js).

const express = require('express');
const db = require('../db');
const { requireAuth } = require('../auth');
const { isAdmin } = require('../moderation');
const { grantTier, revokeTier } = require('../entitlements');
const { logger } = require('../logger');

const router = express.Router();

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'You need to log in first' });
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Admins only' });
  next();
}

// Grant or change a user's supporter tier. days omitted/0 = permanent.
router.post('/grant', requireAuth, requireAdmin, (req, res) => {
  const userId = Number(req.body.userId);
  const tier = Number(req.body.tier);
  const days = req.body.days == null ? 0 : Number(req.body.days);
  if (!userId || !(tier >= 0 && tier <= 3)) {
    return res.status(400).json({ error: 'userId and tier (0 to 3) are required' });
  }
  const target = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
  if (!target) return res.status(404).json({ error: 'User not found' });
  const entitlements = grantTier(userId, tier, days, 'admin_grant:' + req.user.id);
  logger.info({ admin: req.user.id, userId, tier, days }, 'admin granted supporter tier');
  res.json({ ok: true, entitlements });
});

// Clear a user's supporter status.
router.post('/revoke', requireAuth, requireAdmin, (req, res) => {
  const userId = Number(req.body.userId);
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const entitlements = revokeTier(userId, 'admin_revoke:' + req.user.id);
  logger.info({ admin: req.user.id, userId }, 'admin revoked supporter tier');
  res.json({ ok: true, entitlements });
});

// Owner analytics: signups, usage, time on platform, top entry pages + buttons.
// Aggregate only; computed live from the users + analytics_events tables.
const HEARTBEAT_SEC = 20; // client sends a heartbeat every ~20s while visible
router.get('/analytics', requireAuth, requireAdmin, (req, res) => {
  const one = (sql, ...a) => db.prepare(sql).get(...a);
  const many = (sql, ...a) => db.prepare(sql).all(...a);

  const totalUsers = one('SELECT COUNT(*) c FROM users').c;
  const newUsers24h = one("SELECT COUNT(*) c FROM users WHERE created_at >= datetime('now','-1 day')").c;
  const newUsers7d = one("SELECT COUNT(*) c FROM users WHERE created_at >= datetime('now','-7 days')").c;
  const signupsByDay = many(
    "SELECT date(created_at) d, COUNT(*) c FROM users WHERE created_at >= datetime('now','-14 days') GROUP BY d ORDER BY d DESC"
  );

  const activeUsers7d = one(
    "SELECT COUNT(DISTINCT user_id) c FROM analytics_events WHERE user_id IS NOT NULL AND created_at >= datetime('now','-7 days')"
  ).c;
  const totalPageviews = one("SELECT COUNT(*) c FROM analytics_events WHERE type='pageview'").c;
  const totalClicks = one("SELECT COUNT(*) c FROM analytics_events WHERE type='click'").c;
  const totalSessions = one("SELECT COUNT(DISTINCT session_id) c FROM analytics_events WHERE session_id != ''").c;

  // Average time on platform per session: average heartbeats/session * interval.
  const avgHb = one(
    "SELECT AVG(hb) a FROM (SELECT session_id, COUNT(*) hb FROM analytics_events WHERE type='heartbeat' AND session_id != '' AND created_at >= datetime('now','-30 days') GROUP BY session_id)"
  ).a;
  const avgSessionSec = avgHb ? Math.round(avgHb * HEARTBEAT_SEC) : 0;

  const topPages = many(
    "SELECT label, COUNT(*) c FROM analytics_events WHERE type='pageview' AND label != '' GROUP BY label ORDER BY c DESC LIMIT 10"
  );
  // Entry pages: the first page viewed in each session (SQLite bare-column min).
  const entryPages = many(
    "SELECT label, COUNT(*) c FROM (SELECT session_id, label, MIN(created_at) t FROM analytics_events WHERE type='pageview' AND session_id != '' GROUP BY session_id) GROUP BY label ORDER BY c DESC LIMIT 10"
  );
  const topButtons = many(
    "SELECT label, COUNT(*) c FROM analytics_events WHERE type='click' AND label != '' GROUP BY label ORDER BY c DESC LIMIT 10"
  );

  const supporters = one('SELECT COUNT(*) c FROM users WHERE supporter_tier > 0').c;
  const qualifiedReferrals = one("SELECT COUNT(*) c FROM referrals WHERE status='qualified'").c;

  res.json({
    totals: { totalUsers, newUsers24h, newUsers7d, activeUsers7d, totalPageviews, totalClicks, totalSessions, avgSessionSec, supporters, qualifiedReferrals },
    signupsByDay,
    topPages,
    entryPages,
    topButtons,
  });
});

// Current supporters (admin view).
router.get('/supporters', requireAuth, requireAdmin, (req, res) => {
  const supporters = db.prepare(
    'SELECT id, name, email, supporter_tier, supporter_since, supporter_expires ' +
    'FROM users WHERE supporter_tier > 0 ORDER BY supporter_tier DESC, supporter_since DESC'
  ).all();
  res.json({ supporters });
});

module.exports = router;
