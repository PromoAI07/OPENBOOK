// routes/users.js
// Profiles: view a profile, edit your own, upload avatar and cover, search people.

const express = require('express');
const db = require('../db');
const { requireAuth, publicUser } = require('../auth');
const { upload } = require('../upload');
const { entitlementsFor, storageLimitBytes } = require('../entitlements');

const bcrypt = require('bcryptjs');
const cleanup = require('../media/cleanup');

const router = express.Router();

// Parse a SQLite UTC timestamp to epoch ms.
function tms(ts) {
  if (!ts) return Date.now();
  const iso = ts.indexOf('T') >= 0 ? ts : ts.replace(' ', 'T') + 'Z';
  const ms = Date.parse(iso);
  return isNaN(ms) ? Date.now() : ms;
}

// Escalating cooldown before each successive display-name change, in days. The
// first change is measured from signup; later ones from the previous change.
// 1st after 30 days, 2nd after 3 months, 3rd after another 3 months, then yearly.
const NAME_CHANGE_WAIT_DAYS = [30, 90, 90, 365];

// When is this user next allowed to change their display name? Returns epoch ms.
async function nextNameChangeAt(userId, createdAt) {
  const hist = await db
    .prepare('SELECT changed_at FROM name_history WHERE user_id = ? ORDER BY changed_at DESC, id DESC')
    .all(userId);
  const count = hist.length;
  const waitDays = NAME_CHANGE_WAIT_DAYS[Math.min(count, NAME_CHANGE_WAIT_DAYS.length - 1)];
  const anchor = count === 0 ? createdAt : hist[0].changed_at;
  return tms(anchor) + waitDays * 86400000;
}

// Search people by name (or list recent users when no query).
router.get('/', requireAuth, async (req, res) => {
  const q = (req.query.q || '').trim();
  let rows;
  if (q) {
    rows = await db
      .prepare('SELECT * FROM users WHERE name LIKE ? AND id != ? ORDER BY name LIMIT 30')
      .all('%' + q + '%', req.user.id);
  } else {
    rows = await db
      .prepare('SELECT * FROM users WHERE id != ? ORDER BY created_at DESC LIMIT 30')
      .all(req.user.id);
  }
  res.json({ users: rows.map(publicUser) });
});

// Update your own name and bio. The bio is always free to edit; the display name
// is rate-limited, and each change leaves a public trail in name_history.
router.put('/me', requireAuth, async (req, res) => {
  const name = (req.body.name || '').trim();
  const bio = (req.body.bio || '').trim();
  if (!name) return res.status(400).json({ error: 'Your name cannot be empty' });

  const cur = await db.prepare('SELECT name, created_at FROM users WHERE id = ?').get(req.user.id);

  if (name !== cur.name) {
    const allowedAt = await nextNameChangeAt(req.user.id, cur.created_at);
    if (Date.now() < allowedAt) {
      const when = new Date(allowedAt).toISOString().slice(0, 10);
      return res.status(429).json({
        error: 'Name changes are limited to keep identities stable. You can change your name again on ' + when + '.',
        nextAllowedAt: allowedAt,
      });
    }
    await db.prepare('INSERT INTO name_history (user_id, old_name) VALUES (?, ?)').run(req.user.id, cur.name);
    await db.prepare('UPDATE users SET name = ?, bio = ? WHERE id = ?').run(name, bio, req.user.id);
  } else {
    await db.prepare('UPDATE users SET bio = ? WHERE id = ?').run(bio, req.user.id);
  }

  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json({ user: publicUser(user) });
});

// Upload a new avatar.
router.post('/me/avatar', requireAuth, upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image was uploaded' });
  const url = '/uploads/' + req.file.filename;
  const prev = await db.prepare('SELECT avatar FROM users WHERE id = ?').get(req.user.id);
  await db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(url, req.user.id);
  // The replaced avatar is no longer referenced anywhere; delete its bytes.
  if (prev && prev.avatar && prev.avatar !== url) await cleanup.deleteMedia(prev.avatar, req.user.id);
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json({ user: publicUser(user) });
});

// Upload a new cover photo.
router.post('/me/cover', requireAuth, upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image was uploaded' });
  const url = '/uploads/' + req.file.filename;
  const prev = await db.prepare('SELECT cover FROM users WHERE id = ?').get(req.user.id);
  await db.prepare('UPDATE users SET cover = ? WHERE id = ?').run(url, req.user.id);
  if (prev && prev.cover && prev.cover !== url) await cleanup.deleteMedia(prev.cover, req.user.id);
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json({ user: publicUser(user) });
});

// Save the focal point (CSS object-position, e.g. "50% 30%") for the avatar and/or
// cover, so the chosen part of each photo stays visible (drag to reposition).
router.post('/me/photo-position', requireAuth, async (req, res) => {
  const re = /^\d{1,3}(\.\d+)?% \d{1,3}(\.\d+)?%$/;
  const sets = [];
  const vals = [];
  if (typeof req.body.avatarPos === 'string' && re.test(req.body.avatarPos)) { sets.push('avatar_pos = ?'); vals.push(req.body.avatarPos); }
  if (typeof req.body.coverPos === 'string' && re.test(req.body.coverPos)) { sets.push('cover_pos = ?'); vals.push(req.body.coverPos); }
  if (!sets.length) return res.status(400).json({ error: 'Nothing valid to update' });
  vals.push(req.user.id);
  await db.prepare('UPDATE users SET ' + sets.join(', ') + ' WHERE id = ?').run(...vals);
  const u = await db.prepare('SELECT avatar_pos, cover_pos FROM users WHERE id = ?').get(req.user.id);
  res.json({ avatarPos: u.avatar_pos, coverPos: u.cover_pos });
});

// Delete your account and everything in it. This is the "100% control" promise in
// its strongest form: it wipes your uploaded media from storage (and purges the
// CDN), then deletes your user row, which cascades your posts, comments, messages,
// friendships, votes, sessions, and the rest. Irreversible, so the current
// password is required to confirm. This route is exempt from the email gate (it
// lives under /users/me) so even an unverified account can be removed.
router.delete('/me', requireAuth, async (req, res, next) => {
  try {
    const password = String((req.body && req.body.password) || '');
    if (!password) return res.status(400).json({ error: 'Enter your password to confirm.' });
    const row = await db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
    if (!row || !bcrypt.compareSync(password, row.password_hash)) {
      return res.status(403).json({ error: 'That password is not correct.' });
    }
    await cleanup.wipeUserMedia(req.user.id);
    await db.prepare('DELETE FROM users WHERE id = ?').run(req.user.id); // cascades the rest
    res.clearCookie('tb_session');
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Your own transparency dashboard: the two reputation scores (karma vs standing)
// plus your activity counts. reach_score is deliberately NOT included (the
// graduated shadowban stays silent, even to the account owner).
router.get('/me/stats', requireAuth, async (req, res) => {
  const id = req.user.id;
  const u = await db.prepare('SELECT karma, standing, trust_level, created_at, supporter_tier, supporter_since, supporter_expires FROM users WHERE id = ?').get(id);
  const posts = (await db.prepare('SELECT COUNT(*) c FROM posts WHERE user_id = ?').get(id)).c;
  const comments = (await db.prepare('SELECT COUNT(*) c FROM comments WHERE user_id = ?').get(id)).c;
  const communities = (await db.prepare('SELECT COUNT(*) c FROM community_members WHERE user_id = ?').get(id)).c;
  const friends = (await db
    .prepare("SELECT COUNT(*) c FROM friendships WHERE status = 'accepted' AND (requester_id = ? OR addressee_id = ?)")
    .get(id, id)).c;
  const reactionsReceived = (await db
    .prepare(
      `SELECT COUNT(*) c FROM reactions r
       WHERE (r.target_type = 'post'    AND r.target_id IN (SELECT id FROM posts    WHERE user_id = ?))
          OR (r.target_type = 'comment' AND r.target_id IN (SELECT id FROM comments WHERE user_id = ?))`
    )
    .get(id, id)).c;
  res.json({
    trust: {
      karma: u.karma || 0,
      standing: u.standing == null ? 100 : u.standing,
      trustLevel: u.trust_level || 0,
    },
    stats: { posts, comments, communities, friends, reactionsReceived },
    storage: { usedBytes: await cleanup.usageBytes(id), capBytes: storageLimitBytes(u) },
    supporter: entitlementsFor(u),
    created_at: u.created_at,
  });
});

// Content analytics for the logged-in user: how their posts and reels are doing.
router.get('/me/analytics', requireAuth, async (req, res) => {
  const id = req.user.id;
  const postViews = (await db.prepare('SELECT COALESCE(SUM(views), 0) v FROM posts WHERE user_id = ?').get(id)).v;
  const reelViews = (await db.prepare('SELECT COALESCE(SUM(views), 0) v FROM reels WHERE user_id = ?').get(id)).v;
  const likesReceived = (await db
    .prepare(
      `SELECT COUNT(*) c FROM reactions r
       WHERE (r.target_type = 'post'    AND r.target_id IN (SELECT id FROM posts    WHERE user_id = ?))
          OR (r.target_type = 'comment' AND r.target_id IN (SELECT id FROM comments WHERE user_id = ?))
          OR (r.target_type = 'reel'    AND r.target_id IN (SELECT id FROM reels    WHERE user_id = ?))`
    )
    .get(id, id, id)).c;
  const postComments = (await db
    .prepare('SELECT COUNT(*) c FROM comments WHERE user_id != ? AND post_id IN (SELECT id FROM posts WHERE user_id = ?)')
    .get(id, id)).c;
  const reelComments = (await db
    .prepare('SELECT COUNT(*) c FROM reel_comments WHERE user_id != ? AND reel_id IN (SELECT id FROM reels WHERE user_id = ?)')
    .get(id, id)).c;
  const netVotes = (await db
    .prepare(
      `SELECT COALESCE(SUM(value), 0) s FROM votes
       WHERE (target_type = 'post'    AND target_id IN (SELECT id FROM posts    WHERE user_id = ?))
          OR (target_type = 'comment' AND target_id IN (SELECT id FROM comments WHERE user_id = ?))`
    )
    .get(id, id)).s;

  const topPosts = await Promise.all((await db
    .prepare('SELECT id, title, content, type, community_id, views FROM posts WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 10')
    .all(id))
    .map(async (p) => ({
      id: p.id,
      label: (p.title || (p.content || '').slice(0, 60) || (p.type === 'image' ? '(photo)' : '(post)')),
      community: !!p.community_id,
      views: p.views || 0,
      likes: (await db.prepare("SELECT COUNT(*) c FROM reactions WHERE target_type = 'post' AND target_id = ?").get(p.id)).c,
      comments: (await db.prepare('SELECT COUNT(*) c FROM comments WHERE post_id = ?').get(p.id)).c,
    })));

  const reels = await Promise.all((await db
    .prepare('SELECT id, caption, views FROM reels WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 10')
    .all(id))
    .map(async (r) => ({
      id: r.id,
      label: (r.caption || '(reel)').slice(0, 60),
      views: r.views || 0,
      likes: (await db.prepare("SELECT COUNT(*) c FROM reactions WHERE target_type = 'reel' AND target_id = ?").get(r.id)).c,
      comments: (await db.prepare('SELECT COUNT(*) c FROM reel_comments WHERE reel_id = ?').get(r.id)).c,
    })));

  res.json({
    totals: {
      views: postViews + reelViews,
      likesReceived,
      commentsReceived: postComments + reelComments,
      netVotes,
    },
    topPosts,
    reels,
  });
});

// View one profile, with counts and the friendship status from your point of view.
router.get('/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const postsCount = (await db.prepare('SELECT COUNT(*) c FROM posts WHERE user_id = ?').get(id)).c;
  const friendsCount = (await db
    .prepare(
      "SELECT COUNT(*) c FROM friendships WHERE status = 'accepted' AND (requester_id = ? OR addressee_id = ?)"
    )
    .get(id, id)).c;

  let friendStatus = 'none';
  if (id === req.user.id) {
    friendStatus = 'self';
  } else {
    const f = await db
      .prepare(
        'SELECT * FROM friendships WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)'
      )
      .get(req.user.id, id, id, req.user.id);
    if (f) {
      if (f.status === 'accepted') friendStatus = 'friends';
      else if (f.requester_id === req.user.id) friendStatus = 'requested'; // I sent the request
      else friendStatus = 'incoming'; // they sent it to me
    }
  }

  // Public trail of previous display names, newest first.
  const nameHistory = await db
    .prepare('SELECT old_name AS name, changed_at FROM name_history WHERE user_id = ? ORDER BY changed_at DESC, id DESC')
    .all(id);
  // Only the owner is told when they may next change their name.
  const nextNameChange = id === req.user.id ? await nextNameChangeAt(id, user.created_at) : null;

  res.json({ user: publicUser(user), postsCount, friendsCount, friendStatus, nameHistory, nextNameChange });
});

// A user's accepted friends.
router.get('/:id/friends', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const rows = await db
    .prepare(
      `SELECT u.* FROM friendships f
       JOIN users u ON u.id = CASE WHEN f.requester_id = ? THEN f.addressee_id ELSE f.requester_id END
       WHERE f.status = 'accepted' AND (f.requester_id = ? OR f.addressee_id = ?)
       ORDER BY u.name`
    )
    .all(id, id, id);
  res.json({ users: rows.map(publicUser) });
});

module.exports = router;
