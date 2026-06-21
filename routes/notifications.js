// routes/notifications.js
// List your notifications, get the unread count, and mark them all read.

const express = require('express');
const db = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();

router.get('/', requireAuth, (req, res) => {
  const rows = db
    .prepare(
      `SELECT n.*, u.name AS actor_name, u.avatar AS actor_avatar
       FROM notifications n
       JOIN users u ON u.id = n.actor_id
       WHERE n.user_id = ?
       ORDER BY n.created_at DESC, n.id DESC
       LIMIT 50`
    )
    .all(req.user.id);

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

router.get('/unread-count', requireAuth, (req, res) => {
  const count = db
    .prepare('SELECT COUNT(*) c FROM notifications WHERE user_id = ? AND is_read = 0')
    .get(req.user.id).c;
  res.json({ count });
});

router.post('/read', requireAuth, (req, res) => {
  db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?').run(req.user.id);
  res.json({ ok: true });
});

module.exports = router;
