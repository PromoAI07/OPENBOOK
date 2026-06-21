// routes/messages.js
// REST side of chat: list conversations and load the history with one person.
// Sending happens live over Socket.IO (see sockets.js).

const express = require('express');
const db = require('../db');
const { requireAuth, publicUser } = require('../auth');

const router = express.Router();

// One row per person you have chatted with, newest conversation first.
router.get('/conversations', requireAuth, (req, res) => {
  const uid = req.user.id;
  const partners = db
    .prepare(
      `SELECT DISTINCT CASE WHEN sender_id = ? THEN recipient_id ELSE sender_id END AS pid
       FROM messages
       WHERE sender_id = ? OR recipient_id = ?`
    )
    .all(uid, uid, uid);

  const conversations = partners.map((p) => {
    const last = db
      .prepare(
        `SELECT * FROM messages
         WHERE (sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?)
         ORDER BY created_at DESC, id DESC LIMIT 1`
      )
      .get(uid, p.pid, p.pid, uid);
    const unreadCount = db
      .prepare('SELECT COUNT(*) c FROM messages WHERE sender_id = ? AND recipient_id = ? AND is_read = 0')
      .get(p.pid, uid).c;
    return {
      user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(p.pid)),
      lastMessage: last
        ? { content: last.content, created_at: last.created_at, mine: last.sender_id === uid }
        : null,
      unreadCount,
    };
  });

  conversations.sort((a, b) => {
    const ta = a.lastMessage ? a.lastMessage.created_at : '';
    const tb = b.lastMessage ? b.lastMessage.created_at : '';
    return tb.localeCompare(ta);
  });

  res.json({ conversations });
});

// Total unread messages across all conversations (for the top bar badge).
router.get('/unread-count', requireAuth, (req, res) => {
  const count = db
    .prepare('SELECT COUNT(*) c FROM messages WHERE recipient_id = ? AND is_read = 0')
    .get(req.user.id).c;
  res.json({ count });
});

// Full history with one person. Loading it marks their messages to you as read.
router.get('/:userId', requireAuth, (req, res) => {
  const uid = req.user.id;
  const other = Number(req.params.userId);
  const partner = db.prepare('SELECT * FROM users WHERE id = ?').get(other);
  if (!partner) return res.status(404).json({ error: 'User not found' });

  const rows = db
    .prepare(
      `SELECT * FROM messages
       WHERE (sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?)
       ORDER BY created_at ASC, id ASC LIMIT 200`
    )
    .all(uid, other, other, uid);

  db.prepare('UPDATE messages SET is_read = 1 WHERE sender_id = ? AND recipient_id = ?').run(
    other,
    uid
  );

  const messages = rows.map((m) => ({
    id: m.id,
    content: m.content,
    created_at: m.created_at,
    mine: m.sender_id === uid,
    sender_id: m.sender_id,
    recipient_id: m.recipient_id,
  }));
  res.json({ messages, user: publicUser(partner) });
});

module.exports = router;
