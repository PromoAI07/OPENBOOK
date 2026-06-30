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

const cleanup = require('../media/cleanup');

const router = express.Router();

async function isMember(userId, groupId) {
  return !!(await db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?').get(groupId, userId));
}
async function roleOf(userId, groupId) {
  const r = await db.prepare('SELECT role FROM group_members WHERE group_id = ? AND user_id = ?').get(groupId, userId);
  return r ? r.role : null;
}
async function memberCount(groupId) {
  return (await db.prepare('SELECT COUNT(*) c FROM group_members WHERE group_id = ?').get(groupId)).c;
}
async function decorateGroup(g, viewerId) {
  return {
    id: g.id,
    name: g.name,
    description: g.description,
    cover: g.cover,
    privacy: g.privacy,
    created_at: g.created_at,
    memberCount: await memberCount(g.id),
    isMember: await isMember(viewerId, g.id),
    role: await roleOf(viewerId, g.id),
  };
}
// Group posts are shaped by the shared decoratePost (postview.js) so they get
// the same reactions and metadata as the rest of the app.

// My groups plus public groups to discover.
router.get('/', requireAuth, async (req, res) => {
  const uid = req.user.id;
  const mine = await db
    .prepare(
      `SELECT g.* FROM groups g JOIN group_members m ON m.group_id = g.id
       WHERE m.user_id = ? ORDER BY g.name`
    )
    .all(uid);
  const discover = await db
    .prepare(
      `SELECT * FROM groups WHERE privacy = 'public'
         AND id NOT IN (SELECT group_id FROM group_members WHERE user_id = ?)
       ORDER BY created_at DESC LIMIT 30`
    )
    .all(uid);
  res.json({
    mine: await Promise.all(mine.map((g) => decorateGroup(g, uid))),
    discover: await Promise.all(discover.map((g) => decorateGroup(g, uid))),
  });
});

// Create a group; the creator becomes its admin member.
router.post('/', requireAuth, upload.single('cover'), async (req, res) => {
  const name = (req.body.name || '').trim();
  const description = (req.body.description || '').trim();
  const privacy = req.body.privacy === 'private' ? 'private' : 'public';
  const cover = req.file ? '/uploads/' + req.file.filename : '';
  if (!name) return res.status(400).json({ error: 'A group name is required' });

  const info = await db
    .prepare('INSERT INTO groups (name, description, cover, privacy, creator_id) VALUES (?, ?, ?, ?, ?)')
    .run(name, description, cover, privacy, req.user.id);
  await db.prepare("INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, 'admin')").run(
    info.lastInsertRowid,
    req.user.id
  );
  const g = await db.prepare('SELECT * FROM groups WHERE id = ?').get(info.lastInsertRowid);
  res.json({ group: await decorateGroup(g, req.user.id) });
});

// A single group.
router.get('/:id', requireAuth, async (req, res) => {
  const g = await db.prepare('SELECT * FROM groups WHERE id = ?').get(Number(req.params.id));
  if (!g) return res.status(404).json({ error: 'Group not found' });
  // A private group reveals full metadata only to members. A non-member gets a
  // minimal stub (name + size) for the "request to join" screen, without leaking
  // the description or cover.
  if (g.privacy !== 'public' && !(await isMember(req.user.id, g.id))) {
    return res.json({ group: { id: g.id, name: g.name, description: '', cover: '', privacy: g.privacy, created_at: g.created_at, memberCount: await memberCount(g.id), isMember: false, role: null, locked: true } });
  }
  res.json({ group: await decorateGroup(g, req.user.id) });
});

// Join a group.
router.post('/:id/join', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const g = await db.prepare('SELECT * FROM groups WHERE id = ?').get(id);
  if (!g) return res.status(404).json({ error: 'Group not found' });
  if (!(await isMember(req.user.id, id))) {
    await db.prepare("INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, 'member')").run(id, req.user.id);
  }
  res.json({ ok: true });
});

// Leave a group.
router.post('/:id/leave', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  await db.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(id, req.user.id);
  res.json({ ok: true });
});

// Members of a group (admins first).
router.get('/:id/members', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const g = await db.prepare('SELECT privacy FROM groups WHERE id = ?').get(id);
  if (!g) return res.status(404).json({ error: 'Group not found' });
  // A private group never exposes its member roster to non-members.
  if (g.privacy !== 'public' && !(await isMember(req.user.id, id))) {
    return res.json({ members: [], locked: true });
  }
  const rows = await db
    .prepare(
      `SELECT u.*, m.role FROM group_members m JOIN users u ON u.id = m.user_id
       WHERE m.group_id = ? ORDER BY (m.role = 'admin') DESC, u.name`
    )
    .all(id);
  // A block hides the two parties from each other in the roster too (block-only: a muted
  // member still appears, since mute is only a feed preference).
  const blocked = await require('../relations').blockedIds(req.user.id);
  const members = rows
    .filter((u) => u.id === req.user.id || !blocked.has(u.id))
    .map((u) => Object.assign(publicUser(u), { role: u.role }));
  res.json({ members });
});

// Posts in a group (public groups are readable by anyone; private require membership).
router.get('/:id/posts', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const g = await db.prepare('SELECT * FROM groups WHERE id = ?').get(id);
  if (!g) return res.status(404).json({ error: 'Group not found' });
  if (g.privacy !== 'public' && !(await isMember(req.user.id, id))) {
    return res.json({ posts: [], locked: true });
  }
  const rows = await db
    .prepare('SELECT * FROM posts WHERE group_id = ? ORDER BY created_at DESC, id DESC LIMIT 100')
    .all(id);
  // Honor the block cutoff (and mute) in the group feed, like the home feed does.
  const hidden = await require('../relations').feedHiddenIds(req.user.id);
  const posts = (await decoratePosts(rows, req.user.id))
    .filter((p) => p.author.id === req.user.id || !hidden.has(p.author.id));
  res.json({ posts, locked: false });
});

// Post into a group (members only).
router.post('/:id/posts', requireAuth, trustRateLimit('post'), upload.single('image'), async (req, res) => {
  const id = Number(req.params.id);
  const g = await db.prepare('SELECT * FROM groups WHERE id = ?').get(id);
  if (!g) return res.status(404).json({ error: 'Group not found' });
  if (!(await isMember(req.user.id, id))) return res.status(403).json({ error: 'Join the group to post' });

  const content = (req.body.content || '').trim();
  const image = req.file ? '/uploads/' + req.file.filename : '';
  if (!content && !image) return res.status(400).json({ error: 'Write something or add a photo' });

  const info = await db
    .prepare('INSERT INTO posts (user_id, content, image, group_id) VALUES (?, ?, ?, ?)')
    .run(req.user.id, content, image, id);
  // Group posts are member-only (never world-visible), so gate the mention fan-out to
  // friends and never blast the author's followers about a post they cannot see.
  require('../mentions').processMentions(req.user.id, content, info.lastInsertRowid, { audience: 'friends' }).catch(() => {});
  const post = await db.prepare('SELECT * FROM posts WHERE id = ?').get(info.lastInsertRowid);
  res.json({ post: await decoratePost(post, req.user.id) });
});

// Delete a group (admin only). Group posts are removed first since group_id is a
// plain column, then the group cascade clears its membership.
router.delete('/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const g = await db.prepare('SELECT * FROM groups WHERE id = ?').get(id);
  if (!g) return res.status(404).json({ error: 'Group not found' });
  if ((await roleOf(req.user.id, id)) !== 'admin') {
    return res.status(403).json({ error: 'Only an admin can delete this group' });
  }
  const imgs = await db.prepare("SELECT image, user_id FROM posts WHERE group_id = ? AND image <> ''").all(id);
  await db.prepare('DELETE FROM posts WHERE group_id = ?').run(id);
  await db.prepare('DELETE FROM groups WHERE id = ?').run(id);
  for (const m of imgs) await cleanup.deleteMedia(m.image, m.user_id);
  if (g.cover) await cleanup.deleteMedia(g.cover, g.creator_id);
  res.json({ ok: true });
});

module.exports = router;
