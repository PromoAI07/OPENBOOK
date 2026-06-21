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
const { decoratePost } = require('../postview');

const router = express.Router();

function commentScore(id) {
  return db.prepare("SELECT COALESCE(SUM(value), 0) s FROM votes WHERE target_type = 'comment' AND target_id = ?").get(id).s;
}
function myCommentVote(id, userId) {
  const v = db.prepare("SELECT value FROM votes WHERE target_type = 'comment' AND target_id = ? AND user_id = ?").get(id, userId);
  return v ? v.value : 0;
}
function decorateComment(c, viewerId) {
  return {
    id: c.id,
    parent_id: c.parent_id || null,
    content: c.content,
    created_at: c.created_at,
    author: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(c.user_id)),
    score: commentScore(c.id),
    myVote: myCommentVote(c.id, viewerId),
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
  res.json({ posts: rows.map((p) => decoratePost(p, uid)) });
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
  res.json({ posts: rows.map((p) => decoratePost(p, req.user.id)), locked: false });
});

// A single post (used by the community post detail view).
router.get('/:id', requireAuth, (req, res) => {
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(Number(req.params.id));
  if (!post) return res.status(404).json({ error: 'Post not found' });
  if (!canViewPost(req.user.id, post)) {
    return res.status(403).json({ error: 'You cannot view this post' });
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
  res.json({ ok: true });
});

// Toggle a like (Facebook side).
router.post('/:id/like', requireAuth, (req, res) => {
  const postId = Number(req.params.id);
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  if (!canInteractPost(req.user.id, post)) {
    return res.status(403).json({ error: 'You cannot react to this post' });
  }

  const existing = db.prepare('SELECT 1 FROM likes WHERE post_id = ? AND user_id = ?').get(postId, req.user.id);
  let liked;
  if (existing) {
    db.prepare('DELETE FROM likes WHERE post_id = ? AND user_id = ?').run(postId, req.user.id);
    liked = false;
  } else {
    db.prepare('INSERT INTO likes (post_id, user_id) VALUES (?, ?)').run(postId, req.user.id);
    liked = true;
    notify(post.user_id, req.user.id, 'like', postId);
  }
  const likeCount = db.prepare('SELECT COUNT(*) c FROM likes WHERE post_id = ?').get(postId).c;
  res.json({ liked, likeCount });
});

// List comments on a post (flat list with parent_id; the frontend nests them).
router.get('/:id/comments', requireAuth, (req, res) => {
  const postId = Number(req.params.id);
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  if (!canViewPost(req.user.id, post)) {
    return res.status(403).json({ error: 'You cannot view comments on this post' });
  }
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
