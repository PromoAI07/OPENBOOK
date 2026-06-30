// routes/shares.js
// Reposts (the Share button). A member can repost an existing post to their own
// feed so their friends and followers see it, with an optional quote comment. A
// repost points at the original (with attribution); it never copies or edits it,
// and never touches the original author's karma, standing, or reach. The original
// author is notified. (Crossposting into a community is the planned next step;
// this ships the high-value feed repost first.)

const express = require('express');
const db = require('../db');
const { requireAuth } = require('../auth');
const { notify } = require('../notify');
const { canViewPost } = require('../visibility');

const router = express.Router();

async function shareCount(postId) {
  const r = await db.prepare('SELECT COUNT(*) c FROM shares WHERE post_id = ?').get(postId);
  return r.c;
}

// Repost a post to your own feed (optionally with a comment). Idempotent: a repeat
// repost just updates the comment instead of erroring.
router.post('/:postId', requireAuth, async (req, res) => {
  const postId = Number(req.params.postId);
  const comment = String(req.body.comment || '').trim().slice(0, 1000);
  const post = await db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  if ((post.visibility || 'visible') !== 'visible') return res.status(403).json({ error: 'This post is not available' });
  if (!await canViewPost(req.user.id, post)) return res.status(403).json({ error: 'You cannot repost this' });
  // Only repost something anyone could already see, so a repost can never leak a post
  // past its audience: a PUBLIC personal post, or a post in a PUBLIC community. Friends-
  // only personal posts, group posts, and posts in private communities are refused. (A
  // member viewing a private-community post passes canViewPost above, so that check alone
  // is not enough here.)
  let repostable;
  if (post.group_id) {
    repostable = false;
  } else if (post.community_id) {
    const c = await db.prepare('SELECT privacy FROM communities WHERE id = ?').get(post.community_id);
    repostable = !!(c && c.privacy === 'public');
  } else {
    repostable = post.audience === 'public';
  }
  if (!repostable) {
    return res.status(403).json({ error: 'Only public posts can be reposted.' });
  }

  const info = await db
    .prepare('INSERT OR IGNORE INTO shares (user_id, post_id, community_id, comment) VALUES (?, ?, 0, ?)')
    .run(req.user.id, postId, comment);
  if (!info.changes) {
    await db.prepare('UPDATE shares SET comment = ? WHERE user_id = ? AND post_id = ? AND community_id = 0')
      .run(comment, req.user.id, postId);
    return res.json({ ok: true, reposted: true, shareCount: await shareCount(postId) });
  }
  if (post.user_id !== req.user.id) await notify(post.user_id, req.user.id, 'repost', postId);
  res.json({ ok: true, reposted: true, shareCount: await shareCount(postId) });
});

// Undo a repost.
router.delete('/:postId', requireAuth, async (req, res) => {
  const postId = Number(req.params.postId);
  await db.prepare('DELETE FROM shares WHERE user_id = ? AND post_id = ? AND community_id = 0').run(req.user.id, postId);
  res.json({ ok: true, reposted: false, shareCount: await shareCount(postId) });
});

module.exports = router;
