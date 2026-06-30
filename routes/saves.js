// routes/saves.js
// Saved posts (private bookmarks). Each member keeps their own list; it is never
// shown to anyone else and never affects the author, ranking, or reputation.

const express = require('express');
const db = require('../db');
const { requireAuth } = require('../auth');
const { decoratePosts } = require('../postview');
const { canViewPost } = require('../visibility');

const router = express.Router();

// Save a post.
router.post('/:postId', requireAuth, async (req, res) => {
  const postId = Number(req.params.postId);
  const post = await db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  if (!await canViewPost(req.user.id, post)) return res.status(403).json({ error: 'You cannot save this post' });
  await db.prepare('INSERT OR IGNORE INTO saves (user_id, post_id) VALUES (?, ?)').run(req.user.id, postId);
  res.json({ ok: true, saved: true });
});

// Unsave a post.
router.delete('/:postId', requireAuth, async (req, res) => {
  const postId = Number(req.params.postId);
  await db.prepare('DELETE FROM saves WHERE user_id = ? AND post_id = ?').run(req.user.id, postId);
  res.json({ ok: true, saved: false });
});

// List my saved posts (most recently saved first). Posts I can no longer view
// (deleted, or now hidden from me) are silently filtered out.
router.get('/', requireAuth, async (req, res) => {
  const rows = await db
    .prepare(
      `SELECT p.* FROM saves s JOIN posts p ON p.id = s.post_id
       WHERE s.user_id = ? ORDER BY s.created_at DESC LIMIT 200`
    )
    .all(req.user.id);
  const viewable = [];
  for (const p of rows) { if (await canViewPost(req.user.id, p)) viewable.push(p); }
  res.json({ posts: await decoratePosts(viewable, req.user.id) });
});

module.exports = router;
