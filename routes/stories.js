// routes/stories.js
// Stories are photos that disappear after 24 hours. We return active stories
// from you and your friends, grouped per person, plus a way to post one.

const express = require('express');
const db = require('../db');
const { requireAuth, publicUser } = require('../auth');
const { upload } = require('../upload');

const router = express.Router();

// Active stories (last 24 hours) from self and accepted friends, grouped by user.
router.get('/', requireAuth, (req, res) => {
  const uid = req.user.id;
  const rows = db
    .prepare(
      `SELECT s.* FROM stories s
       WHERE (
           s.user_id = ?
           OR s.user_id IN (
             SELECT CASE WHEN requester_id = ? THEN addressee_id ELSE requester_id END
             FROM friendships
             WHERE status = 'accepted' AND (requester_id = ? OR addressee_id = ?)
           )
         )
         AND s.created_at >= datetime('now', '-1 day')
       ORDER BY s.created_at ASC`
    )
    .all(uid, uid, uid, uid);

  const groups = {};
  const order = [];
  for (const s of rows) {
    if (!groups[s.user_id]) {
      groups[s.user_id] = [];
      order.push(s.user_id);
    }
    groups[s.user_id].push({
      id: s.id,
      image: s.image,
      caption: s.caption,
      created_at: s.created_at,
    });
  }

  const result = order.map((userId) => ({
    user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(userId)),
    stories: groups[userId],
  }));
  res.json({ groups: result });
});

// Post a new story (a photo plus an optional caption).
router.post('/', requireAuth, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'A photo is required for a story' });
  const caption = (req.body.caption || '').trim();
  const url = '/uploads/' + req.file.filename;
  const info = db
    .prepare('INSERT INTO stories (user_id, image, caption) VALUES (?, ?, ?)')
    .run(req.user.id, url, caption);
  const s = db.prepare('SELECT * FROM stories WHERE id = ?').get(info.lastInsertRowid);
  res.json({ story: { id: s.id, image: s.image, caption: s.caption, created_at: s.created_at } });
});

module.exports = router;
