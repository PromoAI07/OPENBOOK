// postview.js
// Shared shaping of a post (and its reactions/votes) for the frontend, used by
// the feed, profiles, groups, and communities so every surface returns the same
// object: reactions for the Facebook side, up/down score for the community side.

const db = require('./db');
const { publicUser } = require('./auth');

const REACTION_TYPES = ['like', 'love', 'care', 'haha', 'wow', 'sad', 'angry'];

function postScore(postId) {
  return db.prepare("SELECT COALESCE(SUM(value), 0) s FROM votes WHERE target_type = 'post' AND target_id = ?").get(postId).s;
}
function myPostVote(postId, userId) {
  const v = db.prepare("SELECT value FROM votes WHERE target_type = 'post' AND target_id = ? AND user_id = ?").get(postId, userId);
  return v ? v.value : 0;
}

// Count of each reaction type on a target, the total, and the viewer's own.
function reactionSummary(targetType, targetId, userId) {
  const rows = db
    .prepare('SELECT type, COUNT(*) c FROM reactions WHERE target_type = ? AND target_id = ? GROUP BY type')
    .all(targetType, targetId);
  const counts = {};
  let total = 0;
  for (const r of rows) { counts[r.type] = r.c; total += r.c; }
  const mine = db
    .prepare('SELECT type FROM reactions WHERE target_type = ? AND target_id = ? AND user_id = ?')
    .get(targetType, targetId, userId);
  return { counts, total, mine: mine ? mine.type : null };
}

function decoratePost(post, viewerId) {
  const author = db.prepare('SELECT * FROM users WHERE id = ?').get(post.user_id);
  const commentCount = db.prepare('SELECT COUNT(*) c FROM comments WHERE post_id = ?').get(post.id).c;
  const reactions = reactionSummary('post', post.id, viewerId);

  let community = null;
  if (post.community_id) {
    const c = db.prepare('SELECT id, name FROM communities WHERE id = ?').get(post.community_id);
    if (c) community = { id: c.id, name: c.name };
  }

  return {
    id: post.id,
    title: post.title || '',
    type: post.type || 'text',
    url: post.url || '',
    content: post.content,
    image: post.image,
    created_at: post.created_at,
    author: publicUser(author),
    commentCount,
    reactions,
    likeCount: reactions.total, // back-compat
    liked: !!reactions.mine,
    score: postScore(post.id),
    myVote: myPostVote(post.id, viewerId),
    community,
    community_id: post.community_id || null,
    group_id: post.group_id || null,
    edited: (post.edit_count || 0) >= 2, // the first edit is free / silent
    edited_at: post.edited_at || null,
    editCount: post.edit_count || 0,
  };
}

module.exports = { decoratePost, postScore, myPostVote, reactionSummary, REACTION_TYPES };
