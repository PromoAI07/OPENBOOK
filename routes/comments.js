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

  // Collect this comment and all nested replies, then remove them and any
  // votes on them so no orphans are left behind.
  const ids = db
    .prepare(
      `WITH RECURSIVE sub(id) AS (
         SELECT ?
         UNION ALL
         SELECT cc.id FROM comments cc JOIN sub ON cc.parent_id = sub.id
       )
       SELECT id FROM sub`
    )
    .all(c.id)
    .map((r) => r.id);

  const delVotes = db.prepare("DELETE FROM votes WHERE target_type = 'comment' AND target_id = ?");
  const delComment = db.prepare('DELETE FROM comments WHERE id = ?');
  for (const id of ids) {
    delVotes.run(id);
    delComment.run(id);
  }
  res.json({ ok: true, removed: ids.length });
});

module.exports = router;
