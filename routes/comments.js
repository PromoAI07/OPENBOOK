// routes/comments.js
// Editing and deleting a comment. You can edit your own comment, and delete your own
// comment or any comment on your post.

const express = require('express');
const db = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();

// Edit your own comment. Sets an "edited" mark. A moderator-removed comment cannot be
// edited, and editing does NOT re-run @mention notifications (so it cannot be used to
// re-spam a mention).
router.put('/:id', requireAuth, async (req, res) => {
  const content = (req.body.content || '').trim();
  if (!content) return res.status(400).json({ error: 'Comment cannot be empty' });
  const c = await db.prepare('SELECT * FROM comments WHERE id = ?').get(Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'Comment not found' });
  if (c.user_id !== req.user.id) return res.status(403).json({ error: 'You can only edit your own comment' });
  if ((c.visibility || 'visible') !== 'visible') return res.status(403).json({ error: 'This comment was removed and cannot be edited' });
  await db.prepare("UPDATE comments SET content = ?, edited = 1, edited_at = datetime('now') WHERE id = ?").run(content, c.id);
  const updated = await db.prepare('SELECT * FROM comments WHERE id = ?').get(c.id);
  res.json({ ok: true, content: updated.content, edited: true, edited_at: updated.edited_at });
});

router.delete('/:id', requireAuth, async (req, res) => {
  const c = await db.prepare('SELECT * FROM comments WHERE id = ?').get(Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'Comment not found' });

  const post = await db.prepare('SELECT * FROM posts WHERE id = ?').get(c.post_id);
  const canDelete = c.user_id === req.user.id || (post && post.user_id === req.user.id);
  if (!canDelete) return res.status(403).json({ error: 'Not allowed' });

  // Collect this comment and all nested replies, then remove them and any
  // votes on them so no orphans are left behind.
  const ids = (await db
    .prepare(
      `WITH RECURSIVE sub(id) AS (
         SELECT ?
         UNION ALL
         SELECT cc.id FROM comments cc JOIN sub ON cc.parent_id = sub.id
       )
       SELECT id FROM sub`
    )
    .all(c.id))
    .map((r) => r.id);

  const delVotes = db.prepare("DELETE FROM votes WHERE target_type = 'comment' AND target_id = ?");
  const delComment = db.prepare('DELETE FROM comments WHERE id = ?');
  for (const id of ids) {
    await delVotes.run(id);
    await delComment.run(id);
  }
  res.json({ ok: true, removed: ids.length });
});

module.exports = router;
