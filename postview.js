// postview.js
// Shared shaping of a post (and its reactions/votes) for the frontend, used by
// the feed, profiles, groups, and communities so every surface returns the same
// object: reactions for the Facebook side, up/down score for the community side.
//
// Every function here reads the networked database and is async. decoratePosts
// (the batch path used by the list endpoints) resolves its per-post fields with a
// handful of set-based queries, then builds each view with Promise.all.

const db = require('./db');
const { publicUser } = require('./auth');
const { hot } = require('./ranking');

const REACTION_TYPES = ['like', 'love', 'care', 'haha', 'wow', 'sad', 'angry'];

// One pass over a target's votes giving both the raw tally (shown to users and
// used for karma) and the trust-weighted tally (used for ranking). up/down are
// raw counts; effUp/effDown sum each voter's stored weight.
async function voteTally(targetType, targetId) {
  const r = await db
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

async function postScore(postId) {
  return (await voteTally('post', postId)).score;
}
async function myPostVote(postId, userId) {
  const v = await db.prepare("SELECT value FROM votes WHERE target_type = 'post' AND target_id = ? AND user_id = ?").get(postId, userId);
  return v ? v.value : 0;
}

// Count of each reaction type on a target, the total, and the viewer's own.
async function reactionSummary(targetType, targetId, userId) {
  const rows = await db
    .prepare('SELECT type, COUNT(*) c FROM reactions WHERE target_type = ? AND target_id = ? GROUP BY type')
    .all(targetType, targetId);
  const counts = {};
  let total = 0;
  for (const r of rows) { counts[r.type] = r.c; total += r.c; }
  const mine = await db
    .prepare('SELECT type FROM reactions WHERE target_type = ? AND target_id = ? AND user_id = ?')
    .get(targetType, targetId, userId);
  return { counts, total, mine: mine ? mine.type : null };
}

// Poll data for a poll post: options with vote counts, the total, and the
// viewer's own choice (null if they have not voted).
async function pollData(postId, viewerId) {
  const opts = await db.prepare('SELECT id, text FROM poll_options WHERE post_id = ? ORDER BY position, id').all(postId);
  if (!opts.length) return null;
  const counts = await db.prepare('SELECT option_id, COUNT(*) c FROM poll_votes WHERE post_id = ? GROUP BY option_id').all(postId);
  const cmap = {};
  counts.forEach((r) => { cmap[r.option_id] = r.c; });
  let total = 0;
  const options = opts.map((o) => { const v = cmap[o.id] || 0; total += v; return { id: o.id, text: o.text, votes: v }; });
  const mine = await db.prepare('SELECT option_id FROM poll_votes WHERE post_id = ? AND user_id = ?').get(postId, viewerId);
  return { options, totalVotes: total, myVote: mine ? mine.option_id : null };
}

// Assemble the final view object from already-resolved parts. Both the single
// (decoratePost) and batch (decoratePosts) paths funnel through here so they
// always return a byte-identical shape; ranking.js and the frontend depend on
// these exact fields. Async only because poll posts load their poll data here.
async function buildPostView(post, author, commentCount, reactions, tally, community, myVote, viewerId, extra) {
  extra = extra || {};
  return {
    id: post.id,
    title: post.title || '',
    type: post.type || 'text',
    url: post.url || '',
    content: post.content,
    image: post.image,
    created_at: post.created_at,
    audience: post.audience || 'friends', // 'public' or 'friends' (personal posts)
    bg: post.bg || '',                    // colored/"imaged" text background id
    file_url: post.file_url || '',        // attached document download path
    file_name: post.file_name || '',
    poll: post.type === 'poll' ? await pollData(post.id, viewerId) : null,
    author: publicUser(author),
    commentCount,
    reactions,
    likeCount: reactions.total, // back-compat
    liked: !!reactions.mine,
    views: post.views || 0,
    score: tally.score,
    up: tally.up,
    down: tally.down,
    // trust-weighted tallies and the hot value drive ranking; harmless to send.
    effUp: tally.effUp,
    effDown: tally.effDown,
    hot: hot(tally.effUp, tally.effDown, post.created_at),
    myVote,
    community,
    community_id: post.community_id || null,
    group_id: post.group_id || null,
    locked: !!post.locked,
    pinned: !!post.pinned,
    announcement: !!post.announcement, // official site announcement (pinned, labeled)
    removed: (post.visibility || 'visible') !== 'visible',
    edited: (post.edit_count || 0) >= 2, // the first edit is free / silent
    edited_at: post.edited_at || null,
    editCount: post.edit_count || 0,
    // Content warning (sensitive-content blur), author-set on their own post.
    cw: !!post.cw,
    cwText: post.cw_text || '',
    // Saved/bookmarked + reposted by the viewer, and the total repost count.
    saved: !!extra.saved,
    reposted: !!extra.reposted,
    shareCount: extra.shareCount || 0,
    // Link preview card for the first URL in the post (text only). null if none.
    linkPreview: extra.linkPreview || null,
    // Repost context: set by the feed when this item appears because someone in
    // your network reposted it (null for a normal post).
    repostedBy: extra.repostedBy || null,
    repostComment: extra.repostComment || '',
    repostedAt: extra.repostedAt || null,
  };
}

async function decoratePost(post, viewerId) {
  const author = await db.prepare('SELECT * FROM users WHERE id = ?').get(post.user_id);
  const cc = await db.prepare('SELECT COUNT(*) c FROM comments WHERE post_id = ?').get(post.id);
  const commentCount = cc.c;
  const reactions = await reactionSummary('post', post.id, viewerId);
  const tally = await voteTally('post', post.id);

  let community = null;
  if (post.community_id) {
    const c = await db.prepare('SELECT id, name FROM communities WHERE id = ?').get(post.community_id);
    if (c) community = { id: c.id, name: c.name };
  }

  const myVote = await myPostVote(post.id, viewerId);
  const savedRow = await db.prepare('SELECT 1 FROM saves WHERE user_id = ? AND post_id = ?').get(viewerId, post.id);
  const repostedRow = await db.prepare("SELECT 1 FROM shares WHERE user_id = ? AND post_id = ? AND community_id = 0").get(viewerId, post.id);
  const sc = await db.prepare('SELECT COUNT(*) c FROM shares WHERE post_id = ?').get(post.id);
  const linkPreview = post.preview_url ? await require('./linkpreview').getPreview(post.preview_url) : null;
  return buildPostView(post, author, commentCount, reactions, tally, community, myVote, viewerId, {
    saved: !!savedRow, reposted: !!repostedRow, shareCount: sc.c, linkPreview,
  });
}

// Batch version of decoratePost: resolves every per-post field with a handful of
// set-based queries keyed by post id instead of ~7 queries per post. This is the
// N+1 fix for the list endpoints (feed, community, group, wall) which decorate up
// to ~160 posts at once. The output for each post is identical to decoratePost.
async function decoratePosts(posts, viewerId) {
  if (!posts || posts.length === 0) return [];

  const ids = posts.map((p) => p.id);
  const inPosts = ids.map(() => '?').join(','); // placeholders for target_id IN (...)

  // Authors: one SELECT over the distinct author ids.
  const authorIds = [...new Set(posts.map((p) => p.user_id))];
  const authors = new Map();
  if (authorIds.length) {
    const ph = authorIds.map(() => '?').join(',');
    for (const u of await db.prepare(`SELECT * FROM users WHERE id IN (${ph})`).all(...authorIds)) {
      authors.set(u.id, u);
    }
  }

  // Comment counts: one GROUP BY over comments.
  const commentCounts = new Map();
  for (const r of await db
    .prepare(`SELECT post_id, COUNT(*) c FROM comments WHERE post_id IN (${inPosts}) GROUP BY post_id`)
    .all(...ids)) {
    commentCounts.set(r.post_id, r.c);
  }

  // Vote tallies: one GROUP BY over votes, mirroring voteTally's columns exactly.
  const tallies = new Map();
  for (const r of await db
    .prepare(
      `SELECT target_id,
              COALESCE(SUM(value), 0)                                        AS score,
              COALESCE(SUM(CASE WHEN value = 1  THEN 1 ELSE 0 END), 0)       AS up,
              COALESCE(SUM(CASE WHEN value = -1 THEN 1 ELSE 0 END), 0)       AS down,
              COALESCE(SUM(CASE WHEN value = 1  THEN weight ELSE 0 END), 0)  AS effUp,
              COALESCE(SUM(CASE WHEN value = -1 THEN weight ELSE 0 END), 0)  AS effDown
         FROM votes WHERE target_type = 'post' AND target_id IN (${inPosts})
         GROUP BY target_id`
    )
    .all(...ids)) {
    tallies.set(r.target_id, { score: r.score, up: r.up, down: r.down, effUp: r.effUp, effDown: r.effDown });
  }

  // Reaction counts: one GROUP BY over reactions (counts + total per post).
  const reactionAgg = new Map(); // postId -> { counts, total }
  for (const r of await db
    .prepare(
      `SELECT target_id, type, COUNT(*) c FROM reactions
         WHERE target_type = 'post' AND target_id IN (${inPosts})
         GROUP BY target_id, type`
    )
    .all(...ids)) {
    let agg = reactionAgg.get(r.target_id);
    if (!agg) { agg = { counts: {}, total: 0 }; reactionAgg.set(r.target_id, agg); }
    agg.counts[r.type] = r.c;
    agg.total += r.c;
  }

  // Viewer's own reaction per post: one SELECT for this user across all posts.
  const myReaction = new Map();
  for (const r of await db
    .prepare(
      `SELECT target_id, type FROM reactions
         WHERE target_type = 'post' AND user_id = ? AND target_id IN (${inPosts})`
    )
    .all(viewerId, ...ids)) {
    myReaction.set(r.target_id, r.type);
  }

  // Viewer's own vote per post: one SELECT for this user across all posts.
  const myVotes = new Map();
  for (const r of await db
    .prepare(
      `SELECT target_id, value FROM votes
         WHERE user_id = ? AND target_type = 'post' AND target_id IN (${inPosts})`
    )
    .all(viewerId, ...ids)) {
    myVotes.set(r.target_id, r.value);
  }

  // Communities: one SELECT over the distinct community ids in this set.
  const communityIds = [...new Set(posts.map((p) => p.community_id).filter(Boolean))];
  const communities = new Map();
  if (communityIds.length) {
    const ph = communityIds.map(() => '?').join(',');
    for (const c of await db.prepare(`SELECT id, name FROM communities WHERE id IN (${ph})`).all(...communityIds)) {
      communities.set(c.id, { id: c.id, name: c.name });
    }
  }

  // Saved-by-viewer: one SELECT for this user across all posts in the set.
  const savedSet = new Set();
  for (const r of await db
    .prepare(`SELECT post_id FROM saves WHERE user_id = ? AND post_id IN (${inPosts})`)
    .all(viewerId, ...ids)) {
    savedSet.add(r.post_id);
  }

  // Reposted-by-viewer (own-feed reposts) + total repost counts per post.
  const repostedSet = new Set();
  for (const r of await db
    .prepare(`SELECT post_id FROM shares WHERE user_id = ? AND community_id = 0 AND post_id IN (${inPosts})`)
    .all(viewerId, ...ids)) {
    repostedSet.add(r.post_id);
  }
  const shareCounts = new Map();
  for (const r of await db
    .prepare(`SELECT post_id, COUNT(*) c FROM shares WHERE post_id IN (${inPosts}) GROUP BY post_id`)
    .all(...ids)) {
    shareCounts.set(r.post_id, r.c);
  }

  // Link previews: one SELECT over the distinct preview URLs in this set (cached
  // metadata only; the post route does the actual fetching).
  const previewUrls = [...new Set(posts.map((p) => p.preview_url).filter(Boolean))];
  const previews = new Map();
  if (previewUrls.length) {
    const ph = previewUrls.map(() => '?').join(',');
    for (const r of await db
      .prepare(`SELECT url, title, description, site_name, image FROM link_previews WHERE status = 'ok' AND url IN (${ph})`)
      .all(...previewUrls)) {
      previews.set(r.url, { url: r.url, title: r.title, description: r.description, siteName: r.site_name, image: r.image });
    }
  }

  return Promise.all(posts.map((post) => {
    const agg = reactionAgg.get(post.id);
    const reactions = {
      counts: agg ? agg.counts : {},
      total: agg ? agg.total : 0,
      mine: myReaction.has(post.id) ? myReaction.get(post.id) : null,
    };
    const tally = tallies.get(post.id) || { score: 0, up: 0, down: 0, effUp: 0, effDown: 0 };
    const community = post.community_id ? communities.get(post.community_id) || null : null;
    const myVote = myVotes.has(post.id) ? myVotes.get(post.id) : 0;
    return buildPostView(post, authors.get(post.user_id), commentCounts.get(post.id) || 0, reactions, tally, community, myVote, viewerId, {
      saved: savedSet.has(post.id),
      reposted: repostedSet.has(post.id),
      shareCount: shareCounts.get(post.id) || 0,
      linkPreview: post.preview_url ? (previews.get(post.preview_url) || null) : null,
    });
  }));
}

module.exports = { decoratePost, decoratePosts, voteTally, postScore, myPostVote, reactionSummary, REACTION_TYPES };
