// routes/friends.js
// Friend requests and the friend graph: list friends, incoming requests,
// suggestions, send/accept/decline a request, and unfriend.

const express = require('express');
const db = require('../db');
const { requireAuth, publicUser } = require('../auth');
const { notify } = require('../notify');

const router = express.Router();

// Your accepted friends.
router.get('/', requireAuth, (req, res) => {
  const uid = req.user.id;
  const rows = db
    .prepare(
      `SELECT u.* FROM friendships f
       JOIN users u ON u.id = CASE WHEN f.requester_id = ? THEN f.addressee_id ELSE f.requester_id END
       WHERE f.status = 'accepted' AND (f.requester_id = ? OR f.addressee_id = ?)
       ORDER BY u.name`
    )
    .all(uid, uid, uid);
  res.json({ users: rows.map(publicUser) });
});

// Incoming pending requests (people who want to be your friend).
router.get('/requests', requireAuth, (req, res) => {
  const rows = db
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
router.get('/suggestions', requireAuth, (req, res) => {
  const uid = req.user.id;
  const rows = db
    .prepare(
      `SELECT * FROM users
       WHERE id != ?
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
router.post('/request/:id', requireAuth, (req, res) => {
  const target = Number(req.params.id);
  if (target === req.user.id) return res.status(400).json({ error: 'You cannot add yourself' });

  const targetUser = db.prepare('SELECT id FROM users WHERE id = ?').get(target);
  if (!targetUser) return res.status(404).json({ error: 'User not found' });

  const existing = db
    .prepare(
      'SELECT * FROM friendships WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)'
    )
    .get(req.user.id, target, target, req.user.id);
  if (existing) return res.status(409).json({ error: 'A request already exists' });

  db.prepare(
    "INSERT INTO friendships (requester_id, addressee_id, status) VALUES (?, ?, 'pending')"
  ).run(req.user.id, target);
  notify(target, req.user.id, 'friend_request', null);
  res.json({ ok: true });
});

// Accept a request from a given user.
router.post('/accept/:id', requireAuth, (req, res) => {
  const requester = Number(req.params.id);
  const f = db
    .prepare(
      "SELECT * FROM friendships WHERE requester_id = ? AND addressee_id = ? AND status = 'pending'"
    )
    .get(requester, req.user.id);
  if (!f) return res.status(404).json({ error: 'No pending request from this user' });

  db.prepare("UPDATE friendships SET status = 'accepted' WHERE id = ?").run(f.id);
  notify(requester, req.user.id, 'friend_accept', null);
  res.json({ ok: true });
});

// Decline a pending request.
router.post('/decline/:id', requireAuth, (req, res) => {
  const requester = Number(req.params.id);
  db.prepare(
    "DELETE FROM friendships WHERE requester_id = ? AND addressee_id = ? AND status = 'pending'"
  ).run(requester, req.user.id);
  res.json({ ok: true });
});

// Unfriend someone (works whichever direction the original request went).
router.delete('/:id', requireAuth, (req, res) => {
  const other = Number(req.params.id);
  db.prepare(
    'DELETE FROM friendships WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)'
  ).run(req.user.id, other, other, req.user.id);
  res.json({ ok: true });
});

module.exports = router;
