// routes/follows.js
// One-directional follows: you follow someone to see their PUBLIC posts in your
// home feed without a mutual friendship. Separate from the friend graph, and it
// never grants access to friends-only content (that still requires friendship).

const express = require('express');
const db = require('../db');
const { requireAuth, publicUser } = require('../auth');
const { notify } = require('../notify');

const router = express.Router();

// Follow a user.
router.post('/:id', requireAuth, async (req, res) => {
  const target = Number(req.params.id);
  if (!target || target === req.user.id) return res.status(400).json({ error: 'You cannot follow yourself' });
  if (!(await db.prepare('SELECT 1 FROM users WHERE id = ?').get(target))) {
    return res.status(404).json({ error: 'User not found' });
  }
  // INSERT OR IGNORE makes a repeat follow a no-op (the PK is the pair), so we
  // only notify when a NEW edge is actually created.
  const info = await db
    .prepare('INSERT OR IGNORE INTO follows (follower_id, followee_id) VALUES (?, ?)')
    .run(req.user.id, target);
  if (info.changes) await notify(target, req.user.id, 'follow', null);
  res.json({ ok: true, following: true });
});

// Unfollow a user.
router.delete('/:id', requireAuth, async (req, res) => {
  const target = Number(req.params.id);
  await db.prepare('DELETE FROM follows WHERE follower_id = ? AND followee_id = ?').run(req.user.id, target);
  res.json({ ok: true, following: false });
});

// Who follows this user.
router.get('/:id/followers', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const rows = await db
    .prepare('SELECT u.* FROM follows f JOIN users u ON u.id = f.follower_id WHERE f.followee_id = ? ORDER BY f.created_at DESC LIMIT 200')
    .all(id);
  res.json({ users: rows.map(publicUser) });
});

// Who this user follows.
router.get('/:id/following', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const rows = await db
    .prepare('SELECT u.* FROM follows f JOIN users u ON u.id = f.followee_id WHERE f.follower_id = ? ORDER BY f.created_at DESC LIMIT 200')
    .all(id);
  res.json({ users: rows.map(publicUser) });
});

module.exports = router;
