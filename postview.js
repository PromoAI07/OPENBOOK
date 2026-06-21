// postview.js
// Shared shaping of a post (and its reactions/votes) for the frontend, used by
// the feed, profiles, groups, and communities so every surface returns the same
// object: reactions for the Facebook side, up/down score for the community side.

const db = require('./db');
const { publicUser } = require('./auth');
const { hot } = require('./ranking');

const REACTION_TYPES = ['like', 'love', 'care', 'haha', 'wow', 'sad', 'angry'];

// One pass over a target's votes giving both the raw tally (shown to users and
// used for karma) and the trust-weighted tally (used for ranking). up/down are
// raw counts; effUp/effDown sum each voter's stored weight.
function voteTally(targetType, targetId) {
  const r = db
    .prepare(
      `SELECT
         COALESCE(SUM(value), 0)                                        AS score,
         COALESCE(SUM(CASE WHEN value = 1  THEN 1 ELSE 0 END), 0)       AS up,
         COALESCE(SUM(CASE WHEN value = -1 THEN 1 ELSE 0 END), 0)       AS down,
         COALESCE(SUM(CASE WHEN value = 1  THEN weight ELSE 0 END), 0)  AS effUp,
         COALESCE(SUM(CASE WHEN value = -1 THEN weight ELSE 0 END), 0)  AS effDown
       FROM votes WHERE target_type = ? AND target_id = ?`
    )
    .get(targetType, targetId);
  return { score: r.score, up: r.up, down: r.down, effUp: r.effUp, effDown: r.effDown };
}

function postScore(postId) {
  return voteTally('post', postId).score;
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
  const tally = voteTally('post', post.id);

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
    score: tally.score,
    up: tally.up,
    down: tally.down,
    // trust-weighted tallies and the hot value drive ranking; harmless to send.
    effUp: tally.effUp,
    effDown: tally.effDown,
    hot: hot(tally.effUp, tally.effDown, post.created_at),
    myVote: myPostVote(post.id, viewerId),
    community,
    community_id: post.community_id || null,
    group_id: post.group_id || null,
    edited: (post.edit_count || 0) >= 2, // the first edit is free / silent
    edited_at: post.edited_at || null,
    editCount: post.edit_count || 0,
  };
}

module.exports = { decoratePost, voteTally, postScore, myPostVote, reactionSummary, REACTION_TYPES };
