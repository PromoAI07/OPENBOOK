// visibility.js
// Shared authorization rules for who can see and interact with a post. Used by
// posts, comments, votes, communities, and groups so the rules never drift.
//
// - Normal posts: author or accepted friend.
// - Group posts: public group = anyone logged in; private = members only.
// - Community posts: public community = anyone logged in; private = members only.
//   (Communities are subscribe-to-follow but open to participate when public,
//   Reddit-style. Groups require joining to post, Facebook-style.)

const db = require('./db');

function areFriends(viewerId, ownerId) {
  if (viewerId === ownerId) return true;
  return !!db
    .prepare(
      "SELECT 1 FROM friendships WHERE status = 'accepted' AND ((requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?))"
    )
    .get(viewerId, ownerId, ownerId, viewerId);
}

function isGroupMember(viewerId, groupId) {
  return !!db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?').get(groupId, viewerId);
}

function isCommunityMember(viewerId, communityId) {
  return !!db.prepare('SELECT 1 FROM community_members WHERE community_id = ? AND user_id = ?').get(communityId, viewerId);
}

function isCommunityBanned(viewerId, communityId) {
  return !!db.prepare('SELECT 1 FROM community_bans WHERE community_id = ? AND user_id = ?').get(communityId, viewerId);
}

function canViewPost(viewerId, post) {
  if (post.community_id) {
    const c = db.prepare('SELECT privacy FROM communities WHERE id = ?').get(post.community_id);
    if (!c) return false;
    return c.privacy === 'public' || isCommunityMember(viewerId, post.community_id);
  }
  if (post.group_id) {
    const g = db.prepare('SELECT privacy FROM groups WHERE id = ?').get(post.group_id);
    if (!g) return false;
    return g.privacy === 'public' || isGroupMember(viewerId, post.group_id);
  }
  // Personal post: public posts are visible to anyone; friends-only posts are
  // visible to the author and accepted friends.
  if (post.audience === 'public') return true;
  return areFriends(viewerId, post.user_id);
}

function canInteractPost(viewerId, post) {
  // Removed posts take no new interaction at all. (Locks block new COMMENTS only,
  // not votes/reactions, so the lock check lives in the comment route, not here.)
  if (post.visibility && post.visibility !== 'visible') return false;
  if (post.community_id) {
    const c = db.prepare('SELECT privacy FROM communities WHERE id = ?').get(post.community_id);
    if (!c) return false;
    if (isCommunityBanned(viewerId, post.community_id)) return false; // banned from this community
    return c.privacy === 'public' || isCommunityMember(viewerId, post.community_id);
  }
  if (post.group_id) return isGroupMember(viewerId, post.group_id);
  // Public personal posts can be reacted to / commented on by anyone; friends-only
  // posts stay friends + author.
  if (post.audience === 'public') return true;
  return areFriends(viewerId, post.user_id);
}

module.exports = { areFriends, isGroupMember, isCommunityMember, isCommunityBanned, canViewPost, canInteractPost };
