// routes/notifications.js
// List your notifications, get the unread count, and mark them all read.

const express = require('express');
const db = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();

// A block must hide the blocked user's identity everywhere, including notifications
// created BEFORE the block. notify() already suppresses NEW cross-block bells; this
// subquery drops any historical row whose actor is now blocked (either direction) at
// read time, so the tray never shows their name, avatar, or a link to their content.
// Block-only (not mute): a mute is a feed hide and is not meant to suppress bells.
const BLOCK_FILTER =
  'actor_id NOT IN (SELECT blocked_id FROM blocks WHERE blocker_id = ? ' +
  'UNION SELECT blocker_id FROM blocks WHERE blocked_id = ?)';

router.get('/', requireAuth, async (req, res) => {
  const rows = await db
    .prepare(
      `SELECT n.*, u.name AS actor_name, u.avatar AS actor_avatar
       FROM notifications n
       JOIN users u ON u.id = n.actor_id
       WHERE n.user_id = ? AND n.${BLOCK_FILTER}
       ORDER BY n.created_at DESC, n.id DESC
       LIMIT 50`
    )
    .all(req.user.id, req.user.id, req.user.id);

  const notifications = rows.map((n) => ({
    id: n.id,
    type: n.type,
    post_id: n.post_id,
    is_read: !!n.is_read,
    created_at: n.created_at,
    actor: { id: n.actor_id, name: n.actor_name, avatar: n.actor_avatar || '' },
  }));
  res.json({ notifications });
});

router.get('/unread-count', requireAuth, async (req, res) => {
  const count = (await db
    .prepare('SELECT COUNT(*) c FROM notifications WHERE user_id = ? AND is_read = 0 AND ' + BLOCK_FILTER)
    .get(req.user.id, req.user.id, req.user.id)).c;
  res.json({ count });
});

router.post('/read', requireAuth, async (req, res) => {
  await db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?').run(req.user.id);
  res.json({ ok: true });
});

module.exports = router;
