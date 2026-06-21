// postview.js
// Shared shaping of a post and its votes/comments for the frontend, used by the
// feed, profiles, groups, and communities so every surface returns the same
// object (likes for the Facebook side, up/down score for the community side).

const db = require('./db');
const { publicUser } = require('./auth');

function postScore(postId) {
  return db.prepare("SELECT COALESCE(SUM(value), 0) s FROM votes WHERE target_type = 'post' AND target_id = ?").get(postId).s;
}
function myPostVote(postId, userId) {
  const v = db.prepare("SELECT value FROM votes WHERE target_type = 'post' AND target_id = ? AND user_id = ?").get(postId, userId);
  return v ? v.value : 0;
}

function decoratePost(post, viewerId) {
  const author = db.prepare('SELECT * FROM users WHERE id = ?').get(post.user_id);
  const likeCount = db.prepare('SELECT COUNT(*) c FROM likes WHERE post_id = ?').get(post.id).c;
  const commentCount = db.prepare('SELECT COUNT(*) c FROM comments WHERE post_id = ?').get(post.id).c;
  const liked = !!db.prepare('SELECT 1 FROM likes WHERE post_id = ? AND user_id = ?').get(post.id, viewerId);

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
    likeCount,
    liked,
    commentCount,
    score: postScore(post.id),
    myVote: myPostVote(post.id, viewerId),
    community,
    community_id: post.community_id || null,
    group_id: post.group_id || null,
  };
}

module.exports = { decoratePost, postScore, myPostVote };
