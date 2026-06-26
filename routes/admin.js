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

// Current supporters (admin view).
router.get('/supporters', requireAuth, requireAdmin, (req, res) => {
  const supporters = db.prepare(
    'SELECT id, name, email, supporter_tier, supporter_since, supporter_expires ' +
    'FROM users WHERE supporter_tier > 0 ORDER BY supporter_tier DESC, supporter_since DESC'
  ).all();
  res.json({ supporters });
});

module.exports = router;
