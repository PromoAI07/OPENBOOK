// routes/posts.js
// Posts and comments. Feed and profile walls are the Facebook side (likes).
// Community posts (tagged community_id) get up/down votes and threaded comments.
// Visibility rules and post shaping are shared (visibility.js, postview.js).

const express = require('express');
const db = require('../db');
const { requireAuth, publicUser } = require('../auth');
const { upload } = require('../upload');
const { notify } = require('../notify');
const { areFriends, canViewPost, canInteractPost } = require('../visibility');
const { decoratePost, decoratePosts, voteTally, reactionSummary } = require('../postview');
const { wilson, controversy, rankPosts } = require('../ranking');
const { isAdmin, isCommunityMod } = require('../moderation');

const router = express.Router();

// A removed post (and its comments/history) is gone for normal users; the
// author, community mods, and admins can still see it (for appeals and audit).
// Used by every view-side post endpoint so the rule cannot drift between them.
function canSeeRemovedPost(user, post) {
  if ((post.visibility || 'visible') === 'visible') return true;
  return post.user_id === user.id || isAdmin(user) || (post.community_id && isCommunityMod(user.id, post.community_id));
}

function myCommentVote(id, userId) {
  const v = db.prepare("SELECT value FROM votes WHERE target_type = 'comment' AND target_id = ? AND user_id = ?").get(id, userId);
  return v ? v.value : 0;
}
function decorateComment(c, viewerId) {
  const tally = voteTally('comment', c.id);
  // Removed comments keep their place in the thread but their text is hidden from
  // everyone except the author (who needs to see it to appeal).
  const removed = (c.visibility || 'visible') !== 'visible';
  const content = !removed || c.user_id === viewerId ? c.content : '[removed by a moderator]';
  return {
    id: c.id,
    parent_id: c.parent_id || null,
    content,
    removed,
    created_at: c.created_at,
    author: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(c.user_id)),
    score: tally.score,
    up: tally.up,
    down: tally.down,
    // ranking signals: "best" (Wilson lower bound on effective votes) is the
    // default comment sort; controversy powers the Controversial sort.
    best: wilson(tally.effUp, tally.effDown),
    controversy: controversy(tally.effUp, tally.effDown),
    myVote: myCommentVote(c.id, viewerId),
    reactions: reactionSummary('comment', c.id, viewerId),
  };
}

// News feed: your own posts plus accepted friends', excluding group and
// community posts (those have their own surfaces).
router.get('/feed', requireAuth, (req, res) => {
  const uid = req.user.id;
  const rows = db
    .prepare(
      `SELECT p.* FROM posts p
       WHERE p.group_id IS NULL AND p.community_id IS NULL
         AND (
           p.user_id = ?
           OR p.user_id IN (
             SELECT CASE WHEN requester_id = ? THEN addressee_id ELSE requester_id END
             FROM friendships
             WHERE status = 'accepted' AND (requester_id = ? OR addressee_id = ?)
           )
         )
       ORDER BY p.created_at DESC, p.id DESC
       LIMIT 100`
    )
    .all(uid, uid, uid, uid);
  res.json({ posts: decoratePosts(rows, uid) });
});

// Combined home feed (SPEC section 8): blends your network's personal posts
// (yourself plus accepted friends, the stand-in for one-directional follows until
// Phase 6 adds them) with posts from communities you have joined, ranked by the
// shared formula times the author's reach_score. Sorts: hot (default), new, top.
router.get('/feed/home', requireAuth, (req, res) => {
  const uid = req.user.id;

  // Both subqueries require visibility = 'visible' so hard-shadowed content
  // (the floor tier sets this flag) never reaches another user's feed on ANY
  // sort. Candidate limits are kept modest because ranking rarely promotes a
  // very old post over fresher ones, and each decoratePost is several queries.
  const personal = db
    .prepare(
      `SELECT p.* FROM posts p
       WHERE p.group_id IS NULL AND p.community_id IS NULL AND p.visibility = 'visible'
         AND (
           p.user_id = ?
           OR p.user_id IN (
             SELECT CASE WHEN requester_id = ? THEN addressee_id ELSE requester_id END
             FROM friendships
             WHERE status = 'accepted' AND (requester_id = ? OR addressee_id = ?)
           )
         )
       ORDER BY p.created_at DESC, p.id DESC LIMIT 80`
    )
    .all(uid, uid, uid, uid);

  const community = db
    .prepare(
      `SELECT p.* FROM posts p
       WHERE p.community_id IN (SELECT community_id FROM community_members WHERE user_id = ?)
         AND p.visibility = 'visible'
       ORDER BY p.created_at DESC, p.id DESC LIMIT 80`
    )
    .all(uid);

  const decorated = decoratePosts(personal.concat(community), uid);

  // Author reach multiplier (the graduated shadowban). Looked up here and folded
  // into the ranking only, never attached to the post, so reach stays invisible
  // to other users. Phase 4 adds the appeal flow on top of this.
  const reachCache = {};
  function reachOf(p) {
    const aid = p.author.id;
    if (reachCache[aid] === undefined) {
      const u = db.prepare('SELECT reach_score FROM users WHERE id = ?').get(aid);
      reachCache[aid] = u && u.reach_score != null ? u.reach_score : 1;
    }
    return reachCache[aid];
  }

  // Fully floored authors (reach at the shadowban floor) are excluded outright so
  // they cannot resurface by toggling the sort; the viewer still sees their OWN
  // posts (no obvious tell). Quarantined authors stay but are downranked in
  // rankPosts. SHADOW_FLOOR mirrors trust.js reachFromStanding's floor (0.05).
  const SHADOW_FLOOR = 0.05;
  const visible = decorated.filter((p) => p.author.id === uid || reachOf(p) > SHADOW_FLOOR);

  const sort = ['hot', 'new', 'top'].indexOf(req.query.sort) >= 0 ? req.query.sort : 'hot';
  const window = req.query.t || 'all';
  const ranked = rankPosts(visible, sort, window, reachOf).slice(0, 100);
  res.json({ posts: ranked, sort, window });
});

// Discover feed: public content from across OpenBook (every public community),
// for finding people and communities you do not already follow. Personal posts
// stay friends-only, so this is public-community content only. Ranked by the same
// hot * reach formula, shadowbanned authors excluded. This is the surface that an
// interest-based personalization layer will plug into as volume grows.
router.get('/feed/discover', requireAuth, (req, res) => {
  const uid = req.user.id;
  const rows = db
    .prepare(
      `SELECT p.* FROM posts p
       JOIN communities c ON c.id = p.community_id
       WHERE c.privacy = 'public' AND p.visibility = 'visible'
       ORDER BY p.created_at DESC, p.id DESC LIMIT 200`
    )
    .all();
  const decorated = decoratePosts(rows, uid);

  const reachCache = {};
  function reachOf(p) {
    const aid = p.author.id;
    if (reachCache[aid] === undefined) {
      const u = db.prepare('SELECT reach_score FROM users WHERE id = ?').get(aid);
      reachCache[aid] = u && u.reach_score != null ? u.reach_score : 1;
    }
    return reachCache[aid];
  }
  const SHADOW_FLOOR = 0.05;
  const visible = decorated.filter((p) => p.author.id === uid || reachOf(p) > SHADOW_FLOOR);

  const sort = ['hot', 'new', 'top'].indexOf(req.query.sort) >= 0 ? req.query.sort : 'hot';
  const window = req.query.t || 'all';
  const ranked = rankPosts(visible, sort, window, reachOf).slice(0, 100);
  res.json({ posts: ranked, sort, window });
});

// A user's wall (their plain posts only).
router.get('/user/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!areFriends(req.user.id, id)) {
    return res.json({ posts: [], locked: true });
  }
  const rows = db
    .prepare('SELECT * FROM posts WHERE user_id = ? AND group_id IS NULL AND community_id IS NULL ORDER BY created_at DESC, id DESC')
    .all(id);
  res.json({ posts: decoratePosts(rows, req.user.id), locked: false });
});

// A single post (used by the community post detail view). Opening someone else's
// post counts as a view (a simple opens-based metric for the author's analytics).
router.get('/:id', requireAuth, (req, res) => {
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(Number(req.params.id));
  if (!post) return res.status(404).json({ error: 'Post not found' });
  if (!canViewPost(req.user.id, post)) {
    return res.status(403).json({ error: 'You cannot view this post' });
  }
  if (!canSeeRemovedPost(req.user, post)) return res.status(404).json({ error: 'This post has been removed' });

  const visible = (post.visibility || 'visible') === 'visible';
  if (visible && post.user_id !== req.user.id) {
    db.prepare('UPDATE posts SET views = views + 1 WHERE id = ?').run(post.id);
    post.views = (post.views || 0) + 1;
  }
  res.json({ post: decoratePost(post, req.user.id) });
});

// Create a plain (Facebook-style) post with text and/or an image.
router.post('/', requireAuth, upload.single('image'), (req, res) => {
  const content = (req.body.content || '').trim();
  const image = req.file ? '/uploads/' + req.file.filename : '';
  if (!content && !image) {
    return res.status(400).json({ error: 'Write something or add a photo' });
  }
  const info = db
    .prepare('INSERT INTO posts (user_id, content, image) VALUES (?, ?, ?)')
    .run(req.user.id, content, image);
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(info.lastInsertRowid);
  res.json({ post: decoratePost(post, req.user.id) });
});

// Delete one of your own posts.
router.delete('/:id', requireAuth, (req, res) => {
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(Number(req.params.id));
  if (!post) return res.status(404).json({ error: 'Post not found' });
  if (post.user_id !== req.user.id) {
    return res.status(403).json({ error: 'You can only delete your own posts' });
  }
  db.prepare('DELETE FROM posts WHERE id = ?').run(post.id);
  // Close any open reports for this now-deleted post so they do not orphan.
  db.prepare("UPDATE reports SET status = 'resolved' WHERE target_type = 'post' AND target_id = ? AND status = 'open'").run(post.id);
  res.json({ ok: true });
});

// Edit your own post. The first edit is free (silent, no marker, no history);
// every edit after that saves the previous version and shows an edited badge.
router.put('/:id', requireAuth, (req, res) => {
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(Number(req.params.id));
  if (!post) return res.status(404).json({ error: 'Post not found' });
  if (post.user_id !== req.user.id) {
    return res.status(403).json({ error: 'You can only edit your own posts' });
  }

  const content = (req.body.content || '').trim();
  // Community posts have a title; plain posts keep their (empty) title.
  let title = post.title;
  if (post.community_id && req.body.title !== undefined) title = (req.body.title || '').trim();

  if (post.community_id) {
    if (!title) return res.status(400).json({ error: 'A title is required' });
  } else if (!content && !post.image) {
    return res.status(400).json({ error: 'A post cannot be empty' });
  }

  if ((post.edit_count || 0) === 0) {
    db.prepare('UPDATE posts SET content = ?, title = ?, edit_count = 1 WHERE id = ?').run(content, title, post.id);
  } else {
    db.prepare('INSERT INTO post_edits (post_id, title, content) VALUES (?, ?, ?)').run(post.id, post.title, post.content);
    db.prepare("UPDATE posts SET content = ?, title = ?, edit_count = edit_count + 1, edited_at = datetime('now') WHERE id = ?").run(content, title, post.id);
  }

  const updated = db.prepare('SELECT * FROM posts WHERE id = ?').get(post.id);
  res.json({ post: decoratePost(updated, req.user.id) });
});

// Edit history (only after the free first edit, so 2+ edits). Anyone who can
// view the post can see what it said before.
router.get('/:id/history', requireAuth, (req, res) => {
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(Number(req.params.id));
  if (!post) return res.status(404).json({ error: 'Post not found' });
  if (!canViewPost(req.user.id, post)) {
    return res.status(403).json({ error: 'You cannot view this post' });
  }
  if (!canSeeRemovedPost(req.user, post)) return res.status(404).json({ error: 'This post has been removed' });
  if ((post.edit_count || 0) < 2) return res.json({ versions: [], current: null });
  const rows = db
    .prepare('SELECT title, content, replaced_at FROM post_edits WHERE post_id = ? ORDER BY replaced_at DESC, id DESC')
    .all(post.id);
  res.json({
    versions: rows,
    current: { title: post.title, content: post.content, edited_at: post.edited_at },
  });
});

// List comments on a post (flat list with parent_id; the frontend nests them).
router.get('/:id/comments', requireAuth, (req, res) => {
  const postId = Number(req.params.id);
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  if (!canViewPost(req.user.id, post)) {
    return res.status(403).json({ error: 'You cannot view comments on this post' });
  }
  if (!canSeeRemovedPost(req.user, post)) return res.status(404).json({ error: 'This post has been removed' });
  const rows = db
    .prepare('SELECT * FROM comments WHERE post_id = ? ORDER BY created_at ASC, id ASC')
    .all(postId);
  res.json({ comments: rows.map((c) => decorateComment(c, req.user.id)) });
});

// Add a comment (optionally a reply to another comment via parent_id).
router.post('/:id/comments', requireAuth, (req, res) => {
  const postId = Number(req.params.id);
  const content = (req.body.content || '').trim();
  if (!content) return res.status(400).json({ error: 'Comment cannot be empty' });

  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  if (post.locked) return res.status(403).json({ error: 'This thread is locked' });
  if (!canInteractPost(req.user.id, post)) {
    return res.status(403).json({ error: 'You cannot comment on this post' });
  }

  let parentId = null;
  if (req.body.parentId) {
    const parent = db.prepare('SELECT * FROM comments WHERE id = ?').get(Number(req.body.parentId));
    if (!parent || parent.post_id !== postId) {
      return res.status(400).json({ error: 'Invalid reply target' });
    }
    parentId = parent.id;
    if (parent.user_id !== req.user.id) notify(parent.user_id, req.user.id, 'comment', postId);
  }

  const info = db
    .prepare('INSERT INTO comments (post_id, user_id, content, parent_id) VALUES (?, ?, ?, ?)')
    .run(postId, req.user.id, content, parentId);
  if (post.user_id !== req.user.id) notify(post.user_id, req.user.id, 'comment', postId);

  const c = db.prepare('SELECT * FROM comments WHERE id = ?').get(info.lastInsertRowid);
  res.json({ comment: decorateComment(c, req.user.id) });
});

module.exports = router;
