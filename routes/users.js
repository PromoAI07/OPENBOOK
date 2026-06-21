// routes/users.js
// Profiles: view a profile, edit your own, upload avatar and cover, search people.

const express = require('express');
const db = require('../db');
const { requireAuth, publicUser } = require('../auth');
const { upload } = require('../upload');

const router = express.Router();

// Search people by name (or list recent users when no query).
router.get('/', requireAuth, (req, res) => {
  const q = (req.query.q || '').trim();
  let rows;
  if (q) {
    rows = db
      .prepare('SELECT * FROM users WHERE name LIKE ? AND id != ? ORDER BY name LIMIT 30')
      .all('%' + q + '%', req.user.id);
  } else {
    rows = db
      .prepare('SELECT * FROM users WHERE id != ? ORDER BY created_at DESC LIMIT 30')
      .all(req.user.id);
  }
  res.json({ users: rows.map(publicUser) });
});

// Update your own name and bio.
router.put('/me', requireAuth, (req, res) => {
  const name = (req.body.name || '').trim();
  const bio = (req.body.bio || '').trim();
  if (!name) return res.status(400).json({ error: 'Your name cannot be empty' });
  db.prepare('UPDATE users SET name = ?, bio = ? WHERE id = ?').run(name, bio, req.user.id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json({ user: publicUser(user) });
});

// Upload a new avatar.
router.post('/me/avatar', requireAuth, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image was uploaded' });
  const url = '/uploads/' + req.file.filename;
  db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(url, req.user.id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json({ user: publicUser(user) });
});

// Upload a new cover photo.
router.post('/me/cover', requireAuth, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image was uploaded' });
  const url = '/uploads/' + req.file.filename;
  db.prepare('UPDATE users SET cover = ? WHERE id = ?').run(url, req.user.id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json({ user: publicUser(user) });
});

// Your own transparency dashboard: the two reputation scores (karma vs standing)
// plus your activity counts. reach_score is deliberately NOT included (the
// graduated shadowban stays silent, even to the account owner).
router.get('/me/stats', requireAuth, (req, res) => {
  const id = req.user.id;
  const u = db.prepare('SELECT karma, standing, trust_level, created_at FROM users WHERE id = ?').get(id);
  const posts = db.prepare('SELECT COUNT(*) c FROM posts WHERE user_id = ?').get(id).c;
  const comments = db.prepare('SELECT COUNT(*) c FROM comments WHERE user_id = ?').get(id).c;
  const communities = db.prepare('SELECT COUNT(*) c FROM community_members WHERE user_id = ?').get(id).c;
  const friends = db
    .prepare("SELECT COUNT(*) c FROM friendships WHERE status = 'accepted' AND (requester_id = ? OR addressee_id = ?)")
    .get(id, id).c;
  const reactionsReceived = db
    .prepare(
      `SELECT COUNT(*) c FROM reactions r
       WHERE (r.target_type = 'post'    AND r.target_id IN (SELECT id FROM posts    WHERE user_id = ?))
          OR (r.target_type = 'comment' AND r.target_id IN (SELECT id FROM comments WHERE user_id = ?))`
    )
    .get(id, id).c;
  res.json({
    trust: {
      karma: u.karma || 0,
      standing: u.standing == null ? 100 : u.standing,
      trustLevel: u.trust_level || 0,
    },
    stats: { posts, comments, communities, friends, reactionsReceived },
    created_at: u.created_at,
  });
});

// View one profile, with counts and the friendship status from your point of view.
router.get('/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const postsCount = db.prepare('SELECT COUNT(*) c FROM posts WHERE user_id = ?').get(id).c;
  const friendsCount = db
    .prepare(
      "SELECT COUNT(*) c FROM friendships WHERE status = 'accepted' AND (requester_id = ? OR addressee_id = ?)"
    )
    .get(id, id).c;

  let friendStatus = 'none';
  if (id === req.user.id) {
    friendStatus = 'self';
  } else {
    const f = db
      .prepare(
        'SELECT * FROM friendships WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)'
      )
      .get(req.user.id, id, id, req.user.id);
    if (f) {
      if (f.status === 'accepted') friendStatus = 'friends';
      else if (f.requester_id === req.user.id) friendStatus = 'requested'; // I sent the request
      else friendStatus = 'incoming'; // they sent it to me
    }
  }

  res.json({ user: publicUser(user), postsCount, friendsCount, friendStatus });
});

// A user's accepted friends.
router.get('/:id/friends', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const rows = db
    .prepare(
      `SELECT u.* FROM friendships f
       JOIN users u ON u.id = CASE WHEN f.requester_id = ? THEN f.addressee_id ELSE f.requester_id END
       WHERE f.status = 'accepted' AND (f.requester_id = ? OR f.addressee_id = ?)
       ORDER BY u.name`
    )
    .all(id, id, id);
  res.json({ users: rows.map(publicUser) });
});

module.exports = router;
