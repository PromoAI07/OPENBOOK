// routes/friends.js
// Friend requests and the friend graph: list friends, incoming requests,
// suggestions, send/accept/decline a request, and unfriend.

const express = require('express');
const db = require('../db');
const { requireAuth, publicUser } = require('../auth');
const { notify } = require('../notify');
const presence = require('../presence');

const router = express.Router();

// Your accepted friends.
router.get('/', requireAuth, async (req, res) => {
  const uid = req.user.id;
  const rows = await db
    .prepare(
      `SELECT u.* FROM friendships f
       JOIN users u ON u.id = CASE WHEN f.requester_id = ? THEN f.addressee_id ELSE f.requester_id END
       WHERE f.status = 'accepted' AND (f.requester_id = ? OR f.addressee_id = ?)
       ORDER BY u.name`
    )
    .all(uid, uid, uid);
  // Attach live online state so the contacts list shows a green dot only when the
  // person actually has an open connection (grey otherwise).
  res.json({ users: rows.map((u) => Object.assign(publicUser(u), { online: presence.isOnline(u.id) })) });
});

// Incoming pending requests (people who want to be your friend).
router.get('/requests', requireAuth, async (req, res) => {
  const rows = await db
    .prepare(
      `SELECT u.* FROM friendships f
       JOIN users u ON u.id = f.requester_id
       WHERE f.addressee_id = ? AND f.status = 'pending'
       ORDER BY f.created_at DESC`
    )
    .all(req.user.id);
  res.json({ users: rows.map(publicUser) });
});

// People you are not connected to yet.
router.get('/suggestions', requireAuth, async (req, res) => {
  const uid = req.user.id;
  const rows = await db
    .prepare(
      `SELECT * FROM users
       WHERE id != ?
         AND email NOT IN ('ghost@deleted.openbook.local', 'system@openbook.local')
         AND id NOT IN (
           SELECT CASE WHEN requester_id = ? THEN addressee_id ELSE requester_id END
           FROM friendships
           WHERE requester_id = ? OR addressee_id = ?
         )
       ORDER BY RANDOM() LIMIT 12`
    )
    .all(uid, uid, uid, uid);
  res.json({ users: rows.map(publicUser) });
});

// Send a friend request.
router.post('/request/:id', requireAuth, async (req, res) => {
  const target = Number(req.params.id);
  if (target === req.user.id) return res.status(400).json({ error: 'You cannot add yourself' });

  const targetUser = await db.prepare('SELECT id, email FROM users WHERE id = ?').get(target);
  if (!targetUser) return res.status(404).json({ error: 'User not found' });
  // The automated OpenBook account and the [deleted] ghost are not people: you follow
  // OpenBook, you do not friend it, and the ghost is internal. Block the request so it
  // never sits pending forever.
  if (targetUser.email === 'ghost@deleted.openbook.local' || targetUser.email === 'system@openbook.local') {
    return res.status(400).json({ error: 'This is an automated OpenBook account, not a person. You can follow it instead.' });
  }

  const existing = await db
    .prepare(
      'SELECT * FROM friendships WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)'
    )
    .get(req.user.id, target, target, req.user.id);
  if (existing) return res.status(409).json({ error: 'A request already exists' });

  await db.prepare(
    "INSERT INTO friendships (requester_id, addressee_id, status) VALUES (?, ?, 'pending')"
  ).run(req.user.id, target);
  await notify(target, req.user.id, 'friend_request', null);
  res.json({ ok: true });
});

// Accept a request from a given user.
router.post('/accept/:id', requireAuth, async (req, res) => {
  const requester = Number(req.params.id);
  const f = await db
    .prepare(
      "SELECT * FROM friendships WHERE requester_id = ? AND addressee_id = ? AND status = 'pending'"
    )
    .get(requester, req.user.id);
  if (!f) return res.status(404).json({ error: 'No pending request from this user' });

  await db.prepare("UPDATE friendships SET status = 'accepted' WHERE id = ?").run(f.id);
  await notify(requester, req.user.id, 'friend_accept', null);
  res.json({ ok: true });
});

// Decline a pending request.
router.post('/decline/:id', requireAuth, async (req, res) => {
  const requester = Number(req.params.id);
  await db.prepare(
    "DELETE FROM friendships WHERE requester_id = ? AND addressee_id = ? AND status = 'pending'"
  ).run(requester, req.user.id);
  res.json({ ok: true });
});

// Unfriend someone (works whichever direction the original request went).
router.delete('/:id', requireAuth, async (req, res) => {
  const other = Number(req.params.id);
  await db.prepare(
    'DELETE FROM friendships WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)'
  ).run(req.user.id, other, other, req.user.id);
  res.json({ ok: true });
});

module.exports = router;
