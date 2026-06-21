// routes/votes.js
// Up/down voting on posts and comments. Votes are stored as rows (never just a
// counter) so tallies can be re-run and audited. Casting the same vote again
// clears it. A vote changes the content author's karma via the audit trail,
// except for self-votes. Standing is never touched here (votes are not
// punishment), which is the core OpenBook rule.

const express = require('express');
const db = require('../db');
const { requireAuth } = require('../auth');
const { canInteractPost } = require('../visibility');
const { recordKarmaEvent, refreshTrustLevel } = require('../trust');
const { trustWeight } = require('../ranking');

const router = express.Router();

function scoreOf(targetType, targetId) {
  return db
    .prepare('SELECT COALESCE(SUM(value), 0) s FROM votes WHERE target_type = ? AND target_id = ?')
    .get(targetType, targetId).s;
}

router.post('/', requireAuth, (req, res) => {
  const targetType = req.body.targetType;
  const targetId = Number(req.body.targetId);
  const value = Number(req.body.value);
  if (targetType !== 'post' && targetType !== 'comment') {
    return res.status(400).json({ error: 'Invalid target' });
  }
  if (value !== 1 && value !== -1 && value !== 0) {
    return res.status(400).json({ error: 'Invalid vote' });
  }
  if (!targetId) return res.status(400).json({ error: 'Invalid target' });

  // Resolve the underlying post (for permission) and the content author.
  let post;
  let authorId;
  if (targetType === 'post') {
    post = db.prepare('SELECT * FROM posts WHERE id = ?').get(targetId);
    if (!post) return res.status(404).json({ error: 'Post not found' });
    authorId = post.user_id;
  } else {
    const comment = db.prepare('SELECT * FROM comments WHERE id = ?').get(targetId);
    if (!comment) return res.status(404).json({ error: 'Comment not found' });
    authorId = comment.user_id;
    post = db.prepare('SELECT * FROM posts WHERE id = ?').get(comment.post_id);
    if (!post) return res.status(404).json({ error: 'Post not found' });
  }
  if (!canInteractPost(req.user.id, post)) {
    return res.status(403).json({ error: 'You cannot vote here' });
  }

  const existing = db
    .prepare('SELECT value FROM votes WHERE user_id = ? AND target_type = ? AND target_id = ?')
    .get(req.user.id, targetType, targetId);
  const oldValue = existing ? existing.value : 0;
  const effective = value === oldValue ? 0 : value; // same arrow again = clear

  // The vote carries the voter's current trust weight so ranking can resist
  // brigades (a new account's vote barely moves the rank). Recompute the level
  // first so the weight is fresh; standing is never touched by voting.
  const tl = refreshTrustLevel(req.user.id);
  const weight = trustWeight(tl);

  if (effective === 0) {
    db.prepare('DELETE FROM votes WHERE user_id = ? AND target_type = ? AND target_id = ?')
      .run(req.user.id, targetType, targetId);
  } else if (existing) {
    db.prepare("UPDATE votes SET value = ?, weight = ?, created_at = datetime('now') WHERE user_id = ? AND target_type = ? AND target_id = ?")
      .run(effective, weight, req.user.id, targetType, targetId);
  } else {
    db.prepare('INSERT INTO votes (user_id, target_type, target_id, value, weight) VALUES (?, ?, ?, ?, ?)')
      .run(req.user.id, targetType, targetId, effective, weight);
  }

  if (authorId !== req.user.id) {
    const delta = effective - oldValue;
    if (delta !== 0) recordKarmaEvent(authorId, delta, targetType + '_vote');
  }

  res.json({ score: scoreOf(targetType, targetId), myVote: effective });
});

module.exports = router;
