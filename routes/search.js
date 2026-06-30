// routes/search.js
// Combined search across people, communities, and posts. Uses escaped LIKE
// matching, which is robust on the networked libSQL database; an FTS5 index can be
// layered on later as volume grows. Results respect post visibility, the
// graduated shadowban, and blocks/mutes.

const express = require('express');
const db = require('../db');
const { requireAuth, publicUser } = require('../auth');
const { decoratePosts } = require('../postview');

const router = express.Router();

// Escape LIKE wildcards so a literal % or _ in the query is matched literally.
// Paired with ESCAPE '\' in every LIKE below.
function likeArg(q) {
  return '%' + String(q).replace(/[\\%_]/g, (c) => '\\' + c) + '%';
}

router.get('/', requireAuth, async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 100);
  if (q.length < 2) return res.json({ q, people: [], communities: [], posts: [] });
  const like = likeArg(q);
  const uid = req.user.id;

  // A block makes the two parties undiscoverable to each other (block-only: a muted user
  // stays searchable, since mute only hides their posts from the feed).
  const blocked = await require('../relations').blockedIds(uid);

  // People: by display name or @username (excluding the internal sentinel accounts).
  const people = (await db
    .prepare(
      "SELECT * FROM users WHERE (name LIKE ? ESCAPE '\\' OR username LIKE ? ESCAPE '\\') " +
      "AND email NOT IN ('ghost@deleted.openbook.local','system@openbook.local') " +
      "ORDER BY karma DESC, id ASC LIMIT 12"
    )
    .all(like, like)).filter((u) => !blocked.has(u.id)).map(publicUser);

  // Communities: by name or description (public ones first). A private community only
  // surfaces to its own members, so a non-member cannot discover it by search.
  const communities = await db
    .prepare(
      "SELECT id, name, description, privacy FROM communities " +
      "WHERE (name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\') " +
      "AND (privacy = 'public' OR id IN (SELECT community_id FROM community_members WHERE user_id = ?)) " +
      "ORDER BY (privacy = 'public') DESC, id DESC LIMIT 12"
    )
    .all(like, like, uid);

  // Posts: public personal posts and posts in public communities, visible only.
  const rows = await db
    .prepare(
      `SELECT p.* FROM posts p
       LEFT JOIN communities c ON c.id = p.community_id
       WHERE p.visibility = 'visible' AND p.group_id IS NULL AND p.announcement = 0
         AND (p.title LIKE ? ESCAPE '\\' OR p.content LIKE ? ESCAPE '\\')
         AND (
           (p.community_id IS NULL AND p.audience = 'public')
           OR (p.community_id IS NOT NULL AND c.privacy = 'public')
         )
       ORDER BY p.created_at DESC, p.id DESC LIMIT 40`
    )
    .all(like, like);
  const hidden = await require('../relations').feedHiddenIds(uid);
  const posts = (await decoratePosts(rows, uid)).filter((p) => !hidden.has(p.author.id)).slice(0, 20);

  res.json({ q, people, communities, posts });
});

module.exports = router;
