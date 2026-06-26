// routes/reels.js
// Reels: short vertical videos with a public discovery feed (everyone's reels,
// newest first), likes, simple comments, and a view counter. Unlike the main
// feed this is intentionally NOT friends-only: discovery is the whole point.

const express = require('express');
const db = require('../db');
const { requireAuth, publicUser } = require('../auth');
const { videoUpload } = require('../upload');
const { notify } = require('../notify');
const { trustRateLimit } = require('../antisybil');

const router = express.Router();

function likeInfo(reelId, userId) {
  const count = db
    .prepare("SELECT COUNT(*) c FROM reactions WHERE target_type = 'reel' AND target_id = ?")
    .get(reelId).c;
  const mine = db
    .prepare("SELECT 1 FROM reactions WHERE target_type = 'reel' AND target_id = ? AND user_id = ?")
    .get(reelId, userId);
  return { likeCount: count, liked: !!mine };
}

function decorateReel(r, viewerId) {
  const commentCount = db.prepare('SELECT COUNT(*) c FROM reel_comments WHERE reel_id = ?').get(r.id).c;
  const li = likeInfo(r.id, viewerId);
  return {
    id: r.id,
    video: r.video,
    caption: r.caption,
    views: r.views,
    created_at: r.created_at,
    author: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(r.user_id)),
    commentCount,
    likeCount: li.likeCount,
    liked: li.liked,
    mine: r.user_id === viewerId,
  };
}

// Discovery feed: the newest reels from everyone.
router.get('/', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM reels ORDER BY created_at DESC, id DESC LIMIT 60').all();
  res.json({ reels: rows.map((r) => decorateReel(r, req.user.id)) });
});

// Post a reel (a video plus an optional caption).
router.post('/', requireAuth, trustRateLimit('post'), videoUpload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose a video to post' });
  const caption = (req.body.caption || '').trim();
  const video = '/uploads/' + req.file.filename;
  const info = db
    .prepare('INSERT INTO reels (user_id, video, caption) VALUES (?, ?, ?)')
    .run(req.user.id, video, caption);
  const reel = db.prepare('SELECT * FROM reels WHERE id = ?').get(info.lastInsertRowid);
  res.json({ reel: decorateReel(reel, req.user.id) });
});

// Toggle a like on a reel (stored as a 'like' reaction on a 'reel' target).
router.post('/:id/like', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const reel = db.prepare('SELECT * FROM reels WHERE id = ?').get(id);
  if (!reel) return res.status(404).json({ error: 'Reel not found' });
  const existing = db
    .prepare("SELECT 1 FROM reactions WHERE user_id = ? AND target_type = 'reel' AND target_id = ?")
    .get(req.user.id, id);
  if (existing) {
    db.prepare("DELETE FROM reactions WHERE user_id = ? AND target_type = 'reel' AND target_id = ?")
      .run(req.user.id, id);
  } else {
    db.prepare("INSERT INTO reactions (user_id, target_type, target_id, type) VALUES (?, 'reel', ?, 'like')")
      .run(req.user.id, id);
    if (reel.user_id !== req.user.id) notify(reel.user_id, req.user.id, 'reaction', null);
  }
  res.json(likeInfo(id, req.user.id));
});

// Count a view (best effort; no auth-tied dedupe, it is a vanity counter).
router.post('/:id/view', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  db.prepare('UPDATE reels SET views = views + 1 WHERE id = ?').run(id);
  const r = db.prepare('SELECT views FROM reels WHERE id = ?').get(id);
  res.json({ views: r ? r.views : 0 });
});

// Comments on a reel.
router.get('/:id/comments', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const rows = db
    .prepare('SELECT * FROM reel_comments WHERE reel_id = ? ORDER BY created_at ASC, id ASC')
    .all(id);
  res.json({
    comments: rows.map((c) => ({
      id: c.id,
      content: c.content,
      created_at: c.created_at,
      author: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(c.user_id)),
    })),
  });
});

router.post('/:id/comments', requireAuth, trustRateLimit('comment'), (req, res) => {
  const id = Number(req.params.id);
  const content = (req.body.content || '').trim();
  if (!content) return res.status(400).json({ error: 'Comment cannot be empty' });
  const reel = db.prepare('SELECT * FROM reels WHERE id = ?').get(id);
  if (!reel) return res.status(404).json({ error: 'Reel not found' });
  const info = db
    .prepare('INSERT INTO reel_comments (reel_id, user_id, content) VALUES (?, ?, ?)')
    .run(id, req.user.id, content);
  if (reel.user_id !== req.user.id) notify(reel.user_id, req.user.id, 'comment', null);
  const c = db.prepare('SELECT * FROM reel_comments WHERE id = ?').get(info.lastInsertRowid);
  res.json({
    comment: {
      id: c.id,
      content: c.content,
      created_at: c.created_at,
      author: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(c.user_id)),
    },
  });
});

// Delete your own reel.
router.delete('/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const reel = db.prepare('SELECT * FROM reels WHERE id = ?').get(id);
  if (!reel) return res.status(404).json({ error: 'Reel not found' });
  if (reel.user_id !== req.user.id) return res.status(403).json({ error: 'You can only delete your own reels' });
  db.prepare('DELETE FROM reels WHERE id = ?').run(id);
  db.prepare("DELETE FROM reactions WHERE target_type = 'reel' AND target_id = ?").run(id);
  res.json({ ok: true });
});

module.exports = router;
