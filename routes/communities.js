// routes/communities.js
// Reddit-style communities: subscribe to follow, but anyone can participate in
// public ones (private ones are members-only). Posts live in the shared posts
// table tagged with community_id, so votes and threaded comments reuse the
// /api/votes and /api/posts endpoints.

const express = require('express');
const db = require('../db');
const { requireAuth, publicUser } = require('../auth');
const { upload } = require('../upload');
const { decoratePost } = require('../postview');

const router = express.Router();

function isMember(userId, communityId) {
  return !!db.prepare('SELECT 1 FROM community_members WHERE community_id = ? AND user_id = ?').get(communityId, userId);
}
function roleOf(userId, communityId) {
  const r = db.prepare('SELECT role FROM community_members WHERE community_id = ? AND user_id = ?').get(communityId, userId);
  return r ? r.role : null;
}
function memberCount(communityId) {
  return db.prepare('SELECT COUNT(*) c FROM community_members WHERE community_id = ?').get(communityId).c;
}
function decorateCommunity(c, viewerId) {
  return {
    id: c.id,
    name: c.name,
    description: c.description,
    rules: c.rules,
    icon: c.icon,
    privacy: c.privacy,
    created_at: c.created_at,
    memberCount: memberCount(c.id),
    isMember: isMember(viewerId, c.id),
    role: roleOf(viewerId, c.id),
  };
}

// Communities I follow plus public ones to discover.
router.get('/', requireAuth, (req, res) => {
  const uid = req.user.id;
  const subscribed = db
    .prepare(
      `SELECT c.* FROM communities c JOIN community_members m ON m.community_id = c.id
       WHERE m.user_id = ? ORDER BY c.name`
    )
    .all(uid);
  const discover = db
    .prepare(
      `SELECT * FROM communities WHERE privacy = 'public'
         AND id NOT IN (SELECT community_id FROM community_members WHERE user_id = ?)
       ORDER BY created_at DESC LIMIT 30`
    )
    .all(uid);
  res.json({
    subscribed: subscribed.map((c) => decorateCommunity(c, uid)),
    discover: discover.map((c) => decorateCommunity(c, uid)),
  });
});

// Create a community; the creator becomes its mod.
router.post('/', requireAuth, upload.single('icon'), (req, res) => {
  const name = (req.body.name || '').trim().toLowerCase();
  const description = (req.body.description || '').trim();
  const rules = (req.body.rules || '').trim();
  const privacy = req.body.privacy === 'private' ? 'private' : 'public';
  const icon = req.file ? '/uploads/' + req.file.filename : '';
  if (!/^[a-z0-9_]{3,21}$/.test(name)) {
    return res.status(400).json({ error: 'Name must be 3-21 characters: lowercase letters, numbers, underscores' });
  }
  if (db.prepare('SELECT id FROM communities WHERE name = ?').get(name)) {
    return res.status(409).json({ error: 'That community name is taken' });
  }
  const info = db
    .prepare('INSERT INTO communities (name, description, rules, icon, privacy, creator_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run(name, description, rules, icon, privacy, req.user.id);
  db.prepare("INSERT INTO community_members (community_id, user_id, role) VALUES (?, ?, 'mod')").run(info.lastInsertRowid, req.user.id);
  const c = db.prepare('SELECT * FROM communities WHERE id = ?').get(info.lastInsertRowid);
  res.json({ community: decorateCommunity(c, req.user.id) });
});

// One community.
router.get('/:id', requireAuth, (req, res) => {
  const c = db.prepare('SELECT * FROM communities WHERE id = ?').get(Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'Community not found' });
  res.json({ community: decorateCommunity(c, req.user.id) });
});

// Subscribe / unsubscribe.
router.post('/:id/join', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT id FROM communities WHERE id = ?').get(id)) {
    return res.status(404).json({ error: 'Community not found' });
  }
  if (!isMember(req.user.id, id)) {
    db.prepare("INSERT INTO community_members (community_id, user_id, role) VALUES (?, ?, 'member')").run(id, req.user.id);
  }
  res.json({ ok: true });
});
router.post('/:id/leave', requireAuth, (req, res) => {
  db.prepare('DELETE FROM community_members WHERE community_id = ? AND user_id = ?').run(Number(req.params.id), req.user.id);
  res.json({ ok: true });
});

// Members.
router.get('/:id/members', requireAuth, (req, res) => {
  const rows = db
    .prepare(
      `SELECT u.*, m.role FROM community_members m JOIN users u ON u.id = m.user_id
       WHERE m.community_id = ? ORDER BY (m.role = 'mod') DESC, u.name`
    )
    .all(Number(req.params.id));
  res.json({ members: rows.map((u) => Object.assign(publicUser(u), { role: u.role })) });
});

// Posts in a community, sorted Top (by score) or New.
router.get('/:id/posts', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const c = db.prepare('SELECT * FROM communities WHERE id = ?').get(id);
  if (!c) return res.status(404).json({ error: 'Community not found' });
  if (c.privacy !== 'public' && !isMember(req.user.id, id)) {
    return res.json({ posts: [], locked: true });
  }
  const rows = db
    .prepare("SELECT * FROM posts WHERE community_id = ? AND visibility = 'visible' ORDER BY created_at DESC LIMIT 200")
    .all(id);
  const posts = rows.map((p) => decoratePost(p, req.user.id));
  const sort = req.query.sort === 'new' ? 'new' : 'top';
  if (sort === 'top') posts.sort((a, b) => b.score - a.score || b.id - a.id);
  res.json({ posts, locked: false, sort });
});

// Create a post in a community (public: anyone; private: members only).
router.post('/:id/posts', requireAuth, upload.single('image'), (req, res) => {
  const id = Number(req.params.id);
  const c = db.prepare('SELECT * FROM communities WHERE id = ?').get(id);
  if (!c) return res.status(404).json({ error: 'Community not found' });
  if (c.privacy !== 'public' && !isMember(req.user.id, id)) {
    return res.status(403).json({ error: 'Join this private community to post' });
  }
  const title = (req.body.title || '').trim();
  if (!title) return res.status(400).json({ error: 'A title is required' });
  let type = (req.body.type || 'text').trim();
  if (type !== 'text' && type !== 'link' && type !== 'image') type = 'text';
  const content = (req.body.content || '').trim();
  const url = (req.body.url || '').trim();
  const image = req.file ? '/uploads/' + req.file.filename : '';
  if (type === 'link' && !url) return res.status(400).json({ error: 'Add a link URL' });
  if (type === 'image' && !image) return res.status(400).json({ error: 'Add an image' });

  const info = db
    .prepare('INSERT INTO posts (user_id, community_id, title, type, content, url, image) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(req.user.id, id, title, type, content, url, image);
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(info.lastInsertRowid);
  res.json({ post: decoratePost(post, req.user.id) });
});

// Delete a community (creator/mod only). Posts go first (group_id/community_id
// are plain columns), which cascades their comments and likes.
router.delete('/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const c = db.prepare('SELECT * FROM communities WHERE id = ?').get(id);
  if (!c) return res.status(404).json({ error: 'Community not found' });
  if (roleOf(req.user.id, id) !== 'mod' && c.creator_id !== req.user.id) {
    return res.status(403).json({ error: 'Only a mod can delete this community' });
  }
  db.prepare('DELETE FROM posts WHERE community_id = ?').run(id);
  db.prepare('DELETE FROM communities WHERE id = ?').run(id);
  res.json({ ok: true });
});

module.exports = router;
