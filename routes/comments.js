// routes/comments.js
// Deleting a comment. You can delete your own comment, or any comment on your post.

const express = require('express');
const db = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();

router.delete('/:id', requireAuth, (req, res) => {
  const c = db.prepare('SELECT * FROM comments WHERE id = ?').get(Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'Comment not found' });

  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(c.post_id);
  const canDelete = c.user_id === req.user.id || (post && post.user_id === req.user.id);
  if (!canDelete) return res.status(403).json({ error: 'Not allowed' });

  db.prepare('DELETE FROM comments WHERE id = ?').run(c.id);
  res.json({ ok: true });
});

module.exports = router;
