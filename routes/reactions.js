// routes/reactions.js
// Facebook-style reactions (like, love, care, haha, wow, sad, angry) on posts
// and comments. A user has at most one reaction per target. Reacting with the
// same type again removes it; a different type replaces it.

const express = require('express');
const db = require('../db');
const { requireAuth } = require('../auth');
const { canInteractPost } = require('../visibility');
const { reactionSummary, REACTION_TYPES } = require('../postview');
const { notify } = require('../notify');

const router = express.Router();

router.post('/', requireAuth, (req, res) => {
  const targetType = req.body.targetType;
  const targetId = Number(req.body.targetId);
  const type = req.body.type;
  if (targetType !== 'post' && targetType !== 'comment') {
    return res.status(400).json({ error: 'Invalid target' });
  }
  if (!REACTION_TYPES.includes(type)) {
    return res.status(400).json({ error: 'Invalid reaction' });
  }
  if (!targetId) return res.status(400).json({ error: 'Invalid target' });

  // Resolve the underlying post for permission and the content author.
  let post;
  let authorId;
  let notifyPostId;
  if (targetType === 'post') {
    post = db.prepare('SELECT * FROM posts WHERE id = ?').get(targetId);
    if (!post) return res.status(404).json({ error: 'Post not found' });
    authorId = post.user_id;
    notifyPostId = post.id;
  } else {
    const comment = db.prepare('SELECT * FROM comments WHERE id = ?').get(targetId);
    if (!comment) return res.status(404).json({ error: 'Comment not found' });
    authorId = comment.user_id;
    post = db.prepare('SELECT * FROM posts WHERE id = ?').get(comment.post_id);
    if (!post) return res.status(404).json({ error: 'Post not found' });
    notifyPostId = post.id;
  }
  if (!canInteractPost(req.user.id, post)) {
    return res.status(403).json({ error: 'You cannot react here' });
  }

  const existing = db
    .prepare('SELECT type FROM reactions WHERE user_id = ? AND target_type = ? AND target_id = ?')
    .get(req.user.id, targetType, targetId);

  if (existing && existing.type === type) {
    db.prepare('DELETE FROM reactions WHERE user_id = ? AND target_type = ? AND target_id = ?')
      .run(req.user.id, targetType, targetId);
  } else if (existing) {
    db.prepare("UPDATE reactions SET type = ?, created_at = datetime('now') WHERE user_id = ? AND target_type = ? AND target_id = ?")
      .run(type, req.user.id, targetType, targetId);
  } else {
    db.prepare('INSERT INTO reactions (user_id, target_type, target_id, type) VALUES (?, ?, ?, ?)')
      .run(req.user.id, targetType, targetId, type);
    if (authorId !== req.user.id) notify(authorId, req.user.id, 'reaction', notifyPostId);
  }

  res.json(reactionSummary(targetType, targetId, req.user.id));
});

module.exports = router;
