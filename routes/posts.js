// routes/posts.js
// Posts and comments. Feed and profile walls are the Facebook side (likes).
// Community posts (tagged community_id) get up/down votes and threaded comments.
// Visibility rules and post shaping are shared (visibility.js, postview.js).

const express = require('express');
const db = require('../db');
const { requireAuth, publicUser } = require('../auth');
const { upload, fileUpload } = require('../upload');
const { notify } = require('../notify');
const { areFriends, canViewPost, canInteractPost } = require('../visibility');
const { decoratePost, decoratePosts, voteTally, reactionSummary } = require('../postview');
const { wilson, controversy, rankPosts } = require('../ranking');
const { isAdmin, isCommunityMod } = require('../moderation');
const { trustRateLimit } = require('../antisybil');

const cleanup = require('../media/cleanup');

const router = express.Router();

// A removed post (and its comments/history) is gone for normal users; the
// author, community mods, and admins can still see it (for appeals and audit).
// Used by every view-side post endpoint so the rule cannot drift between them.
async function canSeeRemovedPost(user, post) {
  if ((post.visibility || 'visible') === 'visible') return true;
  return post.user_id === user.id || isAdmin(user) || (post.community_id && await isCommunityMod(user.id, post.community_id));
}

// Author reach multipliers for a set of decorated posts, fetched in ONE query
// (WHERE id IN ...) instead of a separate lookup per author. Returns a synchronous
// reachOf(post) -> number so the ranking/filter code stays unchanged. Reach is
// folded into ranking only, never attached to a post, so it stays invisible to
// other users. Feeds cap candidates well under SQLite's IN-list limit.
async function buildReachOf(decorated) {
  const ids = [...new Set(decorated.map((p) => p.author.id))];
  const reach = {};
  if (ids.length) {
    const placeholders = ids.map(() => '?').join(',');
    const rows = await db.prepare('SELECT id, reach_score FROM users WHERE id IN (' + placeholders + ')').all(...ids);
    for (const r of rows) reach[r.id] = r.reach_score != null ? r.reach_score : 1;
  }
  return (p) => (reach[p.author.id] !== undefined ? reach[p.author.id] : 1);
}

async function myCommentVote(id, userId) {
  const v = await db.prepare("SELECT value FROM votes WHERE target_type = 'comment' AND target_id = ? AND user_id = ?").get(id, userId);
  return v ? v.value : 0;
}
async function decorateComment(c, viewerId) {
  const tally = await voteTally('comment', c.id);
  // Removed comments keep their place in the thread but their text is hidden from
  // everyone except the author (who needs to see it to appeal).
  const removed = (c.visibility || 'visible') !== 'visible';
  const content = !removed || c.user_id === viewerId ? c.content : '[removed by a moderator]';
  return {
    id: c.id,
    parent_id: c.parent_id || null,
    content,
    removed,
    edited: !!c.edited,
    edited_at: c.edited_at || null,
    created_at: c.created_at,
    author: publicUser(await db.prepare('SELECT * FROM users WHERE id = ?').get(c.user_id)),
    score: tally.score,
    up: tally.up,
    down: tally.down,
    // ranking signals: "best" (Wilson lower bound on effective votes) is the
    // default comment sort; controversy powers the Controversial sort.
    best: wilson(tally.effUp, tally.effDown),
    controversy: controversy(tally.effUp, tally.effDown),
    myVote: await myCommentVote(c.id, viewerId),
    reactions: await reactionSummary('comment', c.id, viewerId),
  };
}

// News feed: your own posts plus accepted friends', excluding group and
// community posts (those have their own surfaces).
router.get('/feed', requireAuth, async (req, res) => {
  const uid = req.user.id;
  const rows = await db
    .prepare(
      `SELECT p.* FROM posts p
       WHERE p.group_id IS NULL AND p.community_id IS NULL AND p.announcement = 0
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
  res.json({ posts: await decoratePosts(rows, uid) });
});

// Combined home feed (SPEC section 8): blends your network's personal posts
// (yourself plus accepted friends, the stand-in for one-directional follows until
// Phase 6 adds them) with posts from communities you have joined, ranked by the
// shared formula times the author's reach_score. Sorts: hot (default), new, top.
router.get('/feed/home', requireAuth, async (req, res) => {
  const uid = req.user.id;

  // Both subqueries require visibility = 'visible' so hard-shadowed content
  // (the floor tier sets this flag) never reaches another user's feed on ANY
  // sort. Candidate limits are kept modest because ranking rarely promotes a
  // very old post over fresher ones, and each decoratePost is several queries.
  const personal = await db
    .prepare(
      `SELECT p.* FROM posts p
       WHERE p.group_id IS NULL AND p.community_id IS NULL AND p.visibility = 'visible' AND p.announcement = 0
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

  const community = await db
    .prepare(
      `SELECT p.* FROM posts p
       WHERE p.community_id IN (SELECT community_id FROM community_members WHERE user_id = ?)
         AND p.visibility = 'visible' AND p.announcement = 0
       ORDER BY p.created_at DESC, p.id DESC LIMIT 80`
    )
    .all(uid);

  // Posts from people you FOLLOW (one-directional). Only their PUBLIC posts: a
  // follow never exposes friends-only content. Friends are already covered above;
  // dedupe below removes any overlap.
  const followed = await db
    .prepare(
      `SELECT p.* FROM posts p
       WHERE p.group_id IS NULL AND p.community_id IS NULL AND p.visibility = 'visible' AND p.announcement = 0
         AND p.audience = 'public'
         AND p.user_id IN (SELECT followee_id FROM follows WHERE follower_id = ?)
       ORDER BY p.created_at DESC, p.id DESC LIMIT 80`
    )
    .all(uid);

  // Merge candidates and dedupe by post id (a friend you also follow, etc.).
  const seen = new Set();
  const candidates = personal.concat(community).concat(followed).filter((p) => {
    if (seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  });
  const decorated = await decoratePosts(candidates, uid);

  // Author reach multiplier (the graduated shadowban). Looked up here and folded
  // into the ranking only, never attached to the post, so reach stays invisible
  // to other users. Phase 4 adds the appeal flow on top of this.
  const reachOf = await buildReachOf(decorated);

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

// Pinned site announcements: posts the founder/admin flagged as official
// announcements, shown clearly labeled at the top of the feed. Kept OUT of the
// ranked feeds, so this is a transparent pin, never a hidden feed boost.
router.get('/feed/announcements', requireAuth, async (req, res) => {
  const rows = await db
    .prepare("SELECT * FROM posts WHERE announcement = 1 AND visibility = 'visible' ORDER BY created_at DESC, id DESC LIMIT 10")
    .all();
  res.json({ posts: await decoratePosts(rows, req.user.id) });
});

// Discover feed: public content from across OpenBook, for finding people and
// communities you do not already follow. Includes BOTH public personal posts
// (audience = 'public') from anyone AND posts in public communities. Friends-only
// personal posts and private community/group posts are excluded. Ranked by the
// same hot * reach formula, shadowbanned authors excluded. This is the surface an
// interest-based personalization layer will plug into as volume grows.
router.get('/feed/discover', requireAuth, async (req, res) => {
  const uid = req.user.id;
  const rows = await db
    .prepare(
      `SELECT p.* FROM posts p
       LEFT JOIN communities c ON c.id = p.community_id
       WHERE p.visibility = 'visible' AND p.group_id IS NULL AND p.announcement = 0
         AND (
           (p.community_id IS NULL AND p.audience = 'public')
           OR (p.community_id IS NOT NULL AND c.privacy = 'public')
         )
       ORDER BY p.created_at DESC, p.id DESC LIMIT 200`
    )
    .all();
  const decorated = await decoratePosts(rows, uid);

  const reachOf = await buildReachOf(decorated);

  const SHADOW_FLOOR = 0.05;
  const visible = decorated.filter((p) => p.author.id === uid || reachOf(p) > SHADOW_FLOOR);

  const sort = ['hot', 'new', 'top'].indexOf(req.query.sort) >= 0 ? req.query.sort : 'hot';
  const window = req.query.t || 'all';
  const ranked = rankPosts(visible, sort, window, reachOf).slice(0, 100);
  res.json({ posts: ranked, sort, window });
});

// A user's wall (their plain posts only). Friends and the owner see everything;
// anyone else sees only this person's PUBLIC posts. (No longer fully locked: a
// stranger can see public posts on a profile, matching the public Discover feed.)
router.get('/user/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const friend = await areFriends(req.user.id, id); // also true when viewing yourself
  // Profile visibility gate (mirrors the profile route): a private profile shows
  // no wall to anyone but the owner; a friends-only profile shows none to non-friends.
  const target = await db.prepare('SELECT profile_visibility FROM users WHERE id = ?').get(id);
  const vis = (target && target.profile_visibility) || 'public';
  if (id !== req.user.id && (vis === 'private' || (vis === 'friends' && !friend))) {
    return res.json({ posts: [], locked: true });
  }
  const rows = friend
    ? await db
        .prepare('SELECT * FROM posts WHERE user_id = ? AND group_id IS NULL AND community_id IS NULL ORDER BY created_at DESC, id DESC')
        .all(id)
    : await db
        .prepare("SELECT * FROM posts WHERE user_id = ? AND group_id IS NULL AND community_id IS NULL AND audience = 'public' ORDER BY created_at DESC, id DESC")
        .all(id);
  res.json({ posts: await decoratePosts(rows, req.user.id), locked: false });
});

// A single post (used by the community post detail view). Opening someone else's
// post counts as a view (a simple opens-based metric for the author's analytics).
router.get('/:id', requireAuth, async (req, res) => {
  const post = await db.prepare('SELECT * FROM posts WHERE id = ?').get(Number(req.params.id));
  if (!post) return res.status(404).json({ error: 'Post not found' });
  if (!await canViewPost(req.user.id, post)) {
    return res.status(403).json({ error: 'You cannot view this post' });
  }
  if (!await canSeeRemovedPost(req.user, post)) return res.status(404).json({ error: 'This post has been removed' });

  const visible = (post.visibility || 'visible') === 'visible';
  if (visible && post.user_id !== req.user.id) {
    await db.prepare('UPDATE posts SET views = views + 1 WHERE id = ?').run(post.id);
    post.views = (post.views || 0) + 1;
  }
  res.json({ post: await decoratePost(post, req.user.id) });
});

// Create a plain (Facebook-style) post with text and/or an image. The trust
// rate limiter runs before the upload is parsed so spam is rejected cheaply.
router.post('/', requireAuth, trustRateLimit('post'), upload.single('image'), async (req, res) => {
  const content = (req.body.content || '').trim();
  const image = req.file ? '/uploads/' + req.file.filename : '';
  // Audience choice from the composer: 'public' (anyone, shows in Discover) or
  // 'friends'. Default public so Discover stays lively; anything not exactly
  // 'friends' is treated as public.
  const audience = req.body.audience === 'friends' ? 'friends' : 'public';
  // Colored/"imaged" text background (only for text-only posts, never with an image).
  const bg = String(req.body.bg || '').slice(0, 24).replace(/[^a-z0-9-]/gi, '');
  // Attached file: a previously-uploaded /uploads/<key> from POST /upload-file.
  const fileUrl = /^\/uploads\/[A-Za-z0-9._-]+$/.test(req.body.fileUrl || '') ? req.body.fileUrl : '';
  const fileName = fileUrl ? String(req.body.fileName || 'file').slice(0, 200) : '';
  // Poll options (composer sends a JSON array of strings).
  let pollOptions = [];
  if (req.body.pollOptions) {
    try {
      const arr = JSON.parse(req.body.pollOptions);
      if (Array.isArray(arr)) pollOptions = arr.map((s) => String(s).trim()).filter(Boolean).slice(0, 8);
    } catch (e) { /* ignore malformed poll */ }
  }
  const isPoll = pollOptions.length >= 2;

  if (!content && !image && !fileUrl && !isPoll) {
    return res.status(400).json({ error: 'Write something, or add a photo, file, or poll' });
  }
  const type = isPoll ? 'poll' : 'text';
  const info = await db
    .prepare('INSERT INTO posts (user_id, content, image, audience, bg, file_url, file_name, type, media_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(req.user.id, content, image, audience, image ? '' : bg, fileUrl, fileName, type, (req.file && req.file.mediaHash) || '');
  const postId = info.lastInsertRowid;
  if (isPoll) {
    const ins = db.prepare('INSERT INTO poll_options (post_id, text, position) VALUES (?, ?, ?)');
    for (let i = 0; i < pollOptions.length; i++) await ins.run(postId, pollOptions[i].slice(0, 120), i);
  }
  const post = await db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
  // Notify anyone @mentioned (and @friends / @everyone). Fire-and-forget so the post
  // returns immediately; the fan-out is deduped, capped, and visibility-gated by the
  // post's audience inside processMentions.
  require('../mentions').processMentions(req.user.id, content, postId, { audience: audience }).catch(() => {});
  res.json({ post: await decoratePost(post, req.user.id) });
});

// Upload a file attachment for a post (documents etc.). Returns a stable
// /uploads/<key> the composer then includes when creating the post. Rate-limited
// like other content creation.
router.post('/upload-file', requireAuth, trustRateLimit('post'), fileUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file was uploaded' });
  res.json({ url: '/uploads/' + req.file.filename, name: req.file.originalname || 'file' });
});

// Vote (or change your vote) on a poll. One vote per user per poll.
router.post('/:id/poll/vote', requireAuth, async (req, res) => {
  const postId = Number(req.params.id);
  const optionId = Number(req.body.optionId);
  const post = await db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
  if (!post || post.type !== 'poll') return res.status(404).json({ error: 'Poll not found' });
  if (!await canViewPost(req.user.id, post)) return res.status(403).json({ error: 'You cannot vote on this poll' });
  const opt = await db.prepare('SELECT id FROM poll_options WHERE id = ? AND post_id = ?').get(optionId, postId);
  if (!opt) return res.status(400).json({ error: 'Invalid option' });
  await db.prepare(
    "INSERT INTO poll_votes (post_id, user_id, option_id) VALUES (?, ?, ?) " +
    "ON CONFLICT(post_id, user_id) DO UPDATE SET option_id = excluded.option_id, created_at = datetime('now')"
  ).run(postId, req.user.id, optionId);
  res.json({ poll: (await decoratePost(await db.prepare('SELECT * FROM posts WHERE id = ?').get(postId), req.user.id)).poll });
});

// Delete one of your own posts.
router.delete('/:id', requireAuth, async (req, res) => {
  const post = await db.prepare('SELECT * FROM posts WHERE id = ?').get(Number(req.params.id));
  if (!post) return res.status(404).json({ error: 'Post not found' });
  if (post.user_id !== req.user.id) {
    return res.status(403).json({ error: 'You can only delete your own posts' });
  }
  await db.prepare('DELETE FROM posts WHERE id = ?').run(post.id);
  // The bytes go too, not just the row: this is the "you can truly delete" promise.
  if (post.image) await cleanup.deleteMedia(post.image, post.user_id);
  if (post.file_url) await cleanup.deleteMedia(post.file_url, post.user_id);
  // Close any open reports for this now-deleted post so they do not orphan.
  await db.prepare("UPDATE reports SET status = 'resolved' WHERE target_type = 'post' AND target_id = ? AND status = 'open'").run(post.id);
  res.json({ ok: true });
});

// Edit your own post. The first edit is free (silent, no marker, no history);
// every edit after that saves the previous version and shows an edited badge.
router.put('/:id', requireAuth, async (req, res) => {
  const post = await db.prepare('SELECT * FROM posts WHERE id = ?').get(Number(req.params.id));
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
    await db.prepare('UPDATE posts SET content = ?, title = ?, edit_count = 1 WHERE id = ?').run(content, title, post.id);
  } else {
    await db.prepare('INSERT INTO post_edits (post_id, title, content) VALUES (?, ?, ?)').run(post.id, post.title, post.content);
    await db.prepare("UPDATE posts SET content = ?, title = ?, edit_count = edit_count + 1, edited_at = datetime('now') WHERE id = ?").run(content, title, post.id);
  }

  const updated = await db.prepare('SELECT * FROM posts WHERE id = ?').get(post.id);
  res.json({ post: await decoratePost(updated, req.user.id) });
});

// Edit history (only after the free first edit, so 2+ edits). Anyone who can
// view the post can see what it said before.
router.get('/:id/history', requireAuth, async (req, res) => {
  const post = await db.prepare('SELECT * FROM posts WHERE id = ?').get(Number(req.params.id));
  if (!post) return res.status(404).json({ error: 'Post not found' });
  if (!await canViewPost(req.user.id, post)) {
    return res.status(403).json({ error: 'You cannot view this post' });
  }
  if (!await canSeeRemovedPost(req.user, post)) return res.status(404).json({ error: 'This post has been removed' });
  if ((post.edit_count || 0) < 2) return res.json({ versions: [], current: null });
  const rows = await db
    .prepare('SELECT title, content, replaced_at FROM post_edits WHERE post_id = ? ORDER BY replaced_at DESC, id DESC')
    .all(post.id);
  res.json({
    versions: rows,
    current: { title: post.title, content: post.content, edited_at: post.edited_at },
  });
});

// List comments on a post (flat list with parent_id; the frontend nests them).
router.get('/:id/comments', requireAuth, async (req, res) => {
  const postId = Number(req.params.id);
  const post = await db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  if (!await canViewPost(req.user.id, post)) {
    return res.status(403).json({ error: 'You cannot view comments on this post' });
  }
  if (!await canSeeRemovedPost(req.user, post)) return res.status(404).json({ error: 'This post has been removed' });
  const rows = await db
    .prepare('SELECT * FROM comments WHERE post_id = ? ORDER BY created_at ASC, id ASC')
    .all(postId);
  res.json({ comments: await Promise.all(rows.map((c) => decorateComment(c, req.user.id))) });
});

// Add a comment (optionally a reply to another comment via parent_id).
router.post('/:id/comments', requireAuth, trustRateLimit('comment'), async (req, res) => {
  const postId = Number(req.params.id);
  const content = (req.body.content || '').trim();
  if (!content) return res.status(400).json({ error: 'Comment cannot be empty' });

  const post = await db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  if (post.locked) return res.status(403).json({ error: 'This thread is locked' });
  if (!await canInteractPost(req.user.id, post)) {
    return res.status(403).json({ error: 'You cannot comment on this post' });
  }

  let parentId = null;
  if (req.body.parentId) {
    const parent = await db.prepare('SELECT * FROM comments WHERE id = ?').get(Number(req.body.parentId));
    if (!parent || parent.post_id !== postId) {
      return res.status(400).json({ error: 'Invalid reply target' });
    }
    parentId = parent.id;
    if (parent.user_id !== req.user.id) await notify(parent.user_id, req.user.id, 'comment', postId);
  }

  const info = await db
    .prepare('INSERT INTO comments (post_id, user_id, content, parent_id) VALUES (?, ?, ?, ?)')
    .run(postId, req.user.id, content, parentId);
  if (post.user_id !== req.user.id) await notify(post.user_id, req.user.id, 'comment', postId);
  // Notify anyone @mentioned in the comment (links back to this post). A comment is only
  // as visible as its post, so pass the post's audience so a friends-only thread never
  // notifies someone who cannot open it.
  require('../mentions').processMentions(req.user.id, content, postId, { audience: post.audience }).catch(() => {});

  const c = await db.prepare('SELECT * FROM comments WHERE id = ?').get(info.lastInsertRowid);
  res.json({ comment: await decorateComment(c, req.user.id) });
});

module.exports = router;
