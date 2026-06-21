// routes/posts.js
// The heart of the feed: create posts, the news feed, a user's posts,
// delete, like/unlike, and comments on a post.

const express = require('express');
const db = require('../db');
const { requireAuth, publicUser } = require('../auth');
const { upload } = require('../upload');
const { notify } = require('../notify');

const router = express.Router();

// True if the viewer may see a user's posts: themselves, or an accepted friend.
// This keeps post visibility consistent with the friends-only news feed.
function canSeePosts(viewerId, ownerId) {
  if (viewerId === ownerId) return true;
  const row = db.prepare(
    "SELECT 1 FROM friendships WHERE status = 'accepted' AND ((requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?))"
  ).get(viewerId, ownerId, ownerId, viewerId);
  return !!row;
}

function isGroupMember(viewerId, groupId) {
  return !!db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?').get(groupId, viewerId);
}

// Can the viewer READ this post and its comments? Group posts follow the
// group's privacy; normal posts follow the friends-or-owner rule.
function canViewPost(viewerId, post) {
  if (post.group_id) {
    const g = db.prepare('SELECT privacy FROM groups WHERE id = ?').get(post.group_id);
    if (!g) return false;
    if (g.privacy === 'public') return true;
    return isGroupMember(viewerId, post.group_id);
  }
  return canSeePosts(viewerId, post.user_id);
}

// Can the viewer INTERACT (like / comment)? Group posts require membership;
// normal posts require the friends-or-owner relationship.
function canInteractPost(viewerId, post) {
  if (post.group_id) return isGroupMember(viewerId, post.group_id);
  return canSeePosts(viewerId, post.user_id);
}

// Turn a raw post row into the shape the frontend wants, including author,
// like and comment counts, and whether the current user liked it.
function decoratePost(post, currentUserId) {
  const author = db.prepare('SELECT * FROM users WHERE id = ?').get(post.user_id);
  const likeCount = db.prepare('SELECT COUNT(*) c FROM likes WHERE post_id = ?').get(post.id).c;
  const commentCount = db
    .prepare('SELECT COUNT(*) c FROM comments WHERE post_id = ?')
    .get(post.id).c;
  const liked = !!db
    .prepare('SELECT 1 FROM likes WHERE post_id = ? AND user_id = ?')
    .get(post.id, currentUserId);
  return {
    id: post.id,
    content: post.content,
    image: post.image,
    created_at: post.created_at,
    author: publicUser(author),
    likeCount,
    commentCount,
    liked,
  };
}

// News feed: your own posts plus those of your accepted friends, newest first.
router.get('/feed', requireAuth, (req, res) => {
  const uid = req.user.id;
  const rows = db
    .prepare(
      `SELECT p.* FROM posts p
       WHERE p.group_id IS NULL
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

// All posts by one user (their profile wall).
router.get('/user/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!canSeePosts(req.user.id, id)) {
    return res.json({ posts: [], locked: true });
  }
  const rows = db
    .prepare('SELECT * FROM posts WHERE user_id = ? AND group_id IS NULL ORDER BY created_at DESC, id DESC')
    .all(id);
  res.json({ posts: rows.map((p) => decoratePost(p, req.user.id)), locked: false });
});

// Create a post with text and/or an image.
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

// Toggle a like on a post.
router.post('/:id/like', requireAuth, (req, res) => {
  const postId = Number(req.params.id);
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  if (!canInteractPost(req.user.id, post)) {
    return res.status(403).json({ error: 'You cannot react to this post' });
  }

  const existing = db
    .prepare('SELECT 1 FROM likes WHERE post_id = ? AND user_id = ?')
    .get(postId, req.user.id);

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

// List comments on a post.
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
  const comments = rows.map((c) => ({
    id: c.id,
    content: c.content,
    created_at: c.created_at,
    author: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(c.user_id)),
  }));
  res.json({ comments });
});

// Add a comment to a post.
router.post('/:id/comments', requireAuth, (req, res) => {
  const postId = Number(req.params.id);
  const content = (req.body.content || '').trim();
  if (!content) return res.status(400).json({ error: 'Comment cannot be empty' });

  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  if (!canInteractPost(req.user.id, post)) {
    return res.status(403).json({ error: 'You cannot comment on this post' });
  }

  const info = db
    .prepare('INSERT INTO comments (post_id, user_id, content) VALUES (?, ?, ?)')
    .run(postId, req.user.id, content);
  notify(post.user_id, req.user.id, 'comment', postId);

  const c = db.prepare('SELECT * FROM comments WHERE id = ?').get(info.lastInsertRowid);
  res.json({
    comment: {
      id: c.id,
      content: c.content,
      created_at: c.created_at,
      author: publicUser(req.user),
    },
  });
});

module.exports = router;
