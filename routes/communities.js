// routes/communities.js
// Reddit-style communities: subscribe to follow, but anyone can participate in
// public ones (private ones are members-only). Posts live in the shared posts
// table tagged with community_id, so votes and threaded comments reuse the
// /api/votes and /api/posts endpoints.

const express = require('express');
const db = require('../db');
const { requireAuth, publicUser } = require('../auth');
const { upload } = require('../upload');
const { decoratePost, decoratePosts } = require('../postview');
const { rankPosts, SORTS } = require('../ranking');
const { trustRateLimit } = require('../antisybil');

const cleanup = require('../media/cleanup');

const router = express.Router();

async function isMember(userId, communityId) {
  return !!(await db.prepare('SELECT 1 FROM community_members WHERE community_id = ? AND user_id = ?').get(communityId, userId));
}
async function isBanned(userId, communityId) {
  return !!(await db.prepare('SELECT 1 FROM community_bans WHERE community_id = ? AND user_id = ?').get(communityId, userId));
}
async function roleOf(userId, communityId) {
  const r = await db.prepare('SELECT role FROM community_members WHERE community_id = ? AND user_id = ?').get(communityId, userId);
  return r ? r.role : null;
}
async function memberCount(communityId) {
  return (await db.prepare('SELECT COUNT(*) c FROM community_members WHERE community_id = ?').get(communityId)).c;
}
async function decorateCommunity(c, viewerId) {
  return {
    id: c.id,
    name: c.name,
    description: c.description,
    rules: c.rules,
    icon: c.icon,
    privacy: c.privacy,
    created_at: c.created_at,
    memberCount: await memberCount(c.id),
    isMember: await isMember(viewerId, c.id),
    role: await roleOf(viewerId, c.id),
  };
}

// Communities I follow plus public ones to discover.
router.get('/', requireAuth, async (req, res) => {
  const uid = req.user.id;
  const subscribed = await db
    .prepare(
      `SELECT c.* FROM communities c JOIN community_members m ON m.community_id = c.id
       WHERE m.user_id = ? ORDER BY c.name`
    )
    .all(uid);
  const discover = await db
    .prepare(
      `SELECT * FROM communities WHERE privacy = 'public'
         AND id NOT IN (SELECT community_id FROM community_members WHERE user_id = ?)
       ORDER BY created_at DESC LIMIT 30`
    )
    .all(uid);
  res.json({
    subscribed: await Promise.all(subscribed.map((c) => decorateCommunity(c, uid))),
    discover: await Promise.all(discover.map((c) => decorateCommunity(c, uid))),
  });
});

// Create a community; the creator becomes its mod.
router.post('/', requireAuth, upload.single('icon'), async (req, res) => {
  const name = (req.body.name || '').trim().toLowerCase();
  const description = (req.body.description || '').trim();
  const rules = (req.body.rules || '').trim();
  const privacy = req.body.privacy === 'private' ? 'private' : 'public';
  const icon = req.file ? '/uploads/' + req.file.filename : '';
  if (!/^[a-z0-9_]{3,21}$/.test(name)) {
    return res.status(400).json({ error: 'Name must be 3-21 characters: lowercase letters, numbers, underscores' });
  }
  if (await db.prepare('SELECT id FROM communities WHERE name = ?').get(name)) {
    return res.status(409).json({ error: 'That community name is taken' });
  }
  const info = await db
    .prepare('INSERT INTO communities (name, description, rules, icon, privacy, creator_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run(name, description, rules, icon, privacy, req.user.id);
  await db.prepare("INSERT INTO community_members (community_id, user_id, role) VALUES (?, ?, 'mod')").run(info.lastInsertRowid, req.user.id);
  const c = await db.prepare('SELECT * FROM communities WHERE id = ?').get(info.lastInsertRowid);
  res.json({ community: await decorateCommunity(c, req.user.id) });
});

// One community.
router.get('/:id', requireAuth, async (req, res) => {
  const c = await db.prepare('SELECT * FROM communities WHERE id = ?').get(Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'Community not found' });
  // A private community reveals full metadata only to members. A non-member gets a
  // minimal stub (name + size) so the UI can show a "request to join" screen,
  // without leaking the description, rules, or icon.
  if (c.privacy !== 'public' && !(await isMember(req.user.id, c.id))) {
    return res.json({ community: { id: c.id, name: c.name, description: '', rules: '', icon: '', privacy: c.privacy, created_at: c.created_at, memberCount: await memberCount(c.id), isMember: false, role: null, locked: true } });
  }
  res.json({ community: await decorateCommunity(c, req.user.id) });
});

// Subscribe / unsubscribe.
router.post('/:id/join', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!(await db.prepare('SELECT id FROM communities WHERE id = ?').get(id))) {
    return res.status(404).json({ error: 'Community not found' });
  }
  if (await isBanned(req.user.id, id)) return res.status(403).json({ error: 'You are banned from this community' });
  if (!(await isMember(req.user.id, id))) {
    await db.prepare("INSERT INTO community_members (community_id, user_id, role) VALUES (?, ?, 'member')").run(id, req.user.id);
  }
  res.json({ ok: true });
});
router.post('/:id/leave', requireAuth, async (req, res) => {
  await db.prepare('DELETE FROM community_members WHERE community_id = ? AND user_id = ?').run(Number(req.params.id), req.user.id);
  res.json({ ok: true });
});

// Members.
router.get('/:id/members', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const c = await db.prepare('SELECT privacy FROM communities WHERE id = ?').get(id);
  if (!c) return res.status(404).json({ error: 'Community not found' });
  // A private community never exposes its member roster to non-members.
  if (c.privacy !== 'public' && !(await isMember(req.user.id, id))) {
    return res.json({ members: [], locked: true });
  }
  const rows = await db
    .prepare(
      `SELECT u.*, m.role FROM community_members m JOIN users u ON u.id = m.user_id
       WHERE m.community_id = ? ORDER BY (m.role = 'mod') DESC, u.name`
    )
    .all(id);
  // A block hides the two parties from each other in the roster too (block-only: a muted
  // member is a feed preference, not a cutoff, so they still appear).
  const blocked = await require('../relations').blockedIds(req.user.id);
  const members = rows
    .filter((u) => u.id === req.user.id || !blocked.has(u.id))
    .map((u) => Object.assign(publicUser(u), { role: u.role }));
  res.json({ members });
});

// Posts in a community, sorted Hot (default), New, Top (day/week/all), or
// Controversial. The ranking math is shared and published in ranking.js.
router.get('/:id/posts', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const c = await db.prepare('SELECT * FROM communities WHERE id = ?').get(id);
  if (!c) return res.status(404).json({ error: 'Community not found' });
  if (c.privacy !== 'public' && !(await isMember(req.user.id, id))) {
    return res.json({ posts: [], locked: true });
  }
  // Pull a candidate set newest-first, then rank in code and trim. The limit is
  // modest because each post costs several queries to decorate and ranking
  // rarely promotes a very old post over fresher, higher-scoring ones.
  const rows = await db
    .prepare("SELECT * FROM posts WHERE community_id = ? AND visibility = 'visible' ORDER BY created_at DESC, id DESC LIMIT 150")
    .all(id);
  const decorated = await decoratePosts(rows, req.user.id);

  // Phase 4: community listings also multiply rank by the author's reach_score
  // and drop fully floored (shadowbanned) authors, except for the author's own
  // view. reach is folded into ranking only, never exposed on the post.
  const reachCache = {};
  async function reachOf(p) {
    const aid = p.author.id;
    if (reachCache[aid] === undefined) {
      const u = await db.prepare('SELECT reach_score FROM users WHERE id = ?').get(aid);
      reachCache[aid] = u && u.reach_score != null ? u.reach_score : 1;
    }
    return reachCache[aid];
  }
  // Hide posts by anyone the viewer blocked (either direction) or muted, exactly like
  // the home feed (routes/posts.js): the community feed must honor the block cutoff too.
  const hidden = await require('../relations').feedHiddenIds(req.user.id);
  const SHADOW_FLOOR = 0.05;
  const visiblePosts = [];
  for (const p of decorated) {
    if (p.author.id !== req.user.id && hidden.has(p.author.id)) continue;
    if (p.author.id === req.user.id || (await reachOf(p)) > SHADOW_FLOOR) visiblePosts.push(p);
  }

  // rankPosts is synchronous and calls reachOf internally; the loop above has
  // already warmed reachCache for every visible author, so this sync reader
  // resolves from the cache without another await.
  const reachSync = (p) => reachCache[p.author.id];

  const sort = SORTS.indexOf(req.query.sort) >= 0 ? req.query.sort : 'hot';
  const window = req.query.t || 'all';
  const ranked = rankPosts(visiblePosts, sort, window, reachSync).slice(0, 200);
  // Pinned posts float to the top (stable sort preserves rank order within groups).
  ranked.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
  res.json({ posts: ranked, locked: false, sort, window });
});

// Create a post in a community (public: anyone; private: members only).
router.post('/:id/posts', requireAuth, trustRateLimit('post'), upload.single('image'), async (req, res) => {
  const id = Number(req.params.id);
  const c = await db.prepare('SELECT * FROM communities WHERE id = ?').get(id);
  if (!c) return res.status(404).json({ error: 'Community not found' });
  if (await isBanned(req.user.id, id)) return res.status(403).json({ error: 'You are banned from this community' });
  if (c.privacy !== 'public' && !(await isMember(req.user.id, id))) {
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
  // Only http(s) links: blocks javascript:/data: schemes from being stored and
  // later rendered into an href (defense in depth alongside the client safeHref).
  if (type === 'link' && !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: 'Link must start with http:// or https://' });
  }
  if (type === 'image' && !image) return res.status(400).json({ error: 'Add an image' });

  const info = await db
    .prepare('INSERT INTO posts (user_id, community_id, title, type, content, url, image) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(req.user.id, id, title, type, content, url, image);
  // A post in a public community is world-visible; a private community's posts are not,
  // so gate the mention fan-out accordingly (private -> friends only, no follower blast).
  require('../mentions').processMentions(req.user.id, content, info.lastInsertRowid, { audience: c.privacy === 'public' ? 'public' : 'friends' }).catch(() => {});
  const post = await db.prepare('SELECT * FROM posts WHERE id = ?').get(info.lastInsertRowid);
  res.json({ post: await decoratePost(post, req.user.id) });
});

// Delete a community (creator/mod only). Posts go first (group_id/community_id
// are plain columns), which cascades their comments and likes.
router.delete('/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const c = await db.prepare('SELECT * FROM communities WHERE id = ?').get(id);
  if (!c) return res.status(404).json({ error: 'Community not found' });
  if ((await roleOf(req.user.id, id)) !== 'mod' && c.creator_id !== req.user.id) {
    return res.status(403).json({ error: 'Only a mod can delete this community' });
  }
  const imgs = await db.prepare("SELECT image, user_id FROM posts WHERE community_id = ? AND image <> ''").all(id);
  await db.prepare('DELETE FROM posts WHERE community_id = ?').run(id);
  await db.prepare('DELETE FROM communities WHERE id = ?').run(id);
  for (const m of imgs) await cleanup.deleteMedia(m.image, m.user_id);
  if (c.icon) await cleanup.deleteMedia(c.icon, c.creator_id);
  res.json({ ok: true });
});

module.exports = router;
