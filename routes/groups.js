// routes/groups.js
// Groups: create, browse, join/leave, members, and posting inside a group.
// Group posts live in the shared posts table tagged with group_id, so likes and
// comments reuse the existing /api/posts endpoints.

const express = require('express');
const db = require('../db');
const { requireAuth, publicUser } = require('../auth');
const { upload } = require('../upload');
const { decoratePost, decoratePosts } = require('../postview');
const { trustRateLimit } = require('../antisybil');

const router = express.Router();

function isMember(userId, groupId) {
  return !!db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?').get(groupId, userId);
}
function roleOf(userId, groupId) {
  const r = db.prepare('SELECT role FROM group_members WHERE group_id = ? AND user_id = ?').get(groupId, userId);
  return r ? r.role : null;
}
function memberCount(groupId) {
  return db.prepare('SELECT COUNT(*) c FROM group_members WHERE group_id = ?').get(groupId).c;
}
function decorateGroup(g, viewerId) {
  return {
    id: g.id,
    name: g.name,
    description: g.description,
    cover: g.cover,
    privacy: g.privacy,
    created_at: g.created_at,
    memberCount: memberCount(g.id),
    isMember: isMember(viewerId, g.id),
    role: roleOf(viewerId, g.id),
  };
}
// Group posts are shaped by the shared decoratePost (postview.js) so they get
// the same reactions and metadata as the rest of the app.

// My groups plus public groups to discover.
router.get('/', requireAuth, (req, res) => {
  const uid = req.user.id;
  const mine = db
    .prepare(
      `SELECT g.* FROM groups g JOIN group_members m ON m.group_id = g.id
       WHERE m.user_id = ? ORDER BY g.name`
    )
    .all(uid);
  const discover = db
    .prepare(
      `SELECT * FROM groups WHERE privacy = 'public'
         AND id NOT IN (SELECT group_id FROM group_members WHERE user_id = ?)
       ORDER BY created_at DESC LIMIT 30`
    )
    .all(uid);
  res.json({
    mine: mine.map((g) => decorateGroup(g, uid)),
    discover: discover.map((g) => decorateGroup(g, uid)),
  });
});

// Create a group; the creator becomes its admin member.
router.post('/', requireAuth, upload.single('cover'), (req, res) => {
  const name = (req.body.name || '').trim();
  const description = (req.body.description || '').trim();
  const privacy = req.body.privacy === 'private' ? 'private' : 'public';
  const cover = req.file ? '/uploads/' + req.file.filename : '';
  if (!name) return res.status(400).json({ error: 'A group name is required' });

  const info = db
    .prepare('INSERT INTO groups (name, description, cover, privacy, creator_id) VALUES (?, ?, ?, ?, ?)')
    .run(name, description, cover, privacy, req.user.id);
  db.prepare("INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, 'admin')").run(
    info.lastInsertRowid,
    req.user.id
  );
  const g = db.prepare('SELECT * FROM groups WHERE id = ?').get(info.lastInsertRowid);
  res.json({ group: decorateGroup(g, req.user.id) });
});

// A single group.
router.get('/:id', requireAuth, (req, res) => {
  const g = db.prepare('SELECT * FROM groups WHERE id = ?').get(Number(req.params.id));
  if (!g) return res.status(404).json({ error: 'Group not found' });
  res.json({ group: decorateGroup(g, req.user.id) });
});

// Join a group.
router.post('/:id/join', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const g = db.prepare('SELECT * FROM groups WHERE id = ?').get(id);
  if (!g) return res.status(404).json({ error: 'Group not found' });
  if (!isMember(req.user.id, id)) {
    db.prepare("INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, 'member')").run(id, req.user.id);
  }
  res.json({ ok: true });
});

// Leave a group.
router.post('/:id/leave', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  db.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(id, req.user.id);
  res.json({ ok: true });
});

// Members of a group (admins first).
router.get('/:id/members', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const rows = db
    .prepare(
      `SELECT u.*, m.role FROM group_members m JOIN users u ON u.id = m.user_id
       WHERE m.group_id = ? ORDER BY (m.role = 'admin') DESC, u.name`
    )
    .all(id);
  res.json({ members: rows.map((u) => Object.assign(publicUser(u), { role: u.role })) });
});

// Posts in a group (public groups are readable by anyone; private require membership).
router.get('/:id/posts', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const g = db.prepare('SELECT * FROM groups WHERE id = ?').get(id);
  if (!g) return res.status(404).json({ error: 'Group not found' });
  if (g.privacy !== 'public' && !isMember(req.user.id, id)) {
    return res.json({ posts: [], locked: true });
  }
  const rows = db
    .prepare('SELECT * FROM posts WHERE group_id = ? ORDER BY created_at DESC, id DESC LIMIT 100')
    .all(id);
  res.json({ posts: decoratePosts(rows, req.user.id), locked: false });
});

// Post into a group (members only).
router.post('/:id/posts', requireAuth, trustRateLimit('post'), upload.single('image'), (req, res) => {
  const id = Number(req.params.id);
  const g = db.prepare('SELECT * FROM groups WHERE id = ?').get(id);
  if (!g) return res.status(404).json({ error: 'Group not found' });
  if (!isMember(req.user.id, id)) return res.status(403).json({ error: 'Join the group to post' });

  const content = (req.body.content || '').trim();
  const image = req.file ? '/uploads/' + req.file.filename : '';
  if (!content && !image) return res.status(400).json({ error: 'Write something or add a photo' });

  const info = db
    .prepare('INSERT INTO posts (user_id, content, image, group_id) VALUES (?, ?, ?, ?)')
    .run(req.user.id, content, image, id);
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(info.lastInsertRowid);
  res.json({ post: decoratePost(post, req.user.id) });
});

// Delete a group (admin only). Group posts are removed first since group_id is a
// plain column, then the group cascade clears its membership.
router.delete('/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const g = db.prepare('SELECT * FROM groups WHERE id = ?').get(id);
  if (!g) return res.status(404).json({ error: 'Group not found' });
  if (roleOf(req.user.id, id) !== 'admin') {
    return res.status(403).json({ error: 'Only an admin can delete this group' });
  }
  db.prepare('DELETE FROM posts WHERE group_id = ?').run(id);
  db.prepare('DELETE FROM groups WHERE id = ?').run(id);
  res.json({ ok: true });
});

module.exports = router;
