// moderation.js
// Phase 3 permission helpers for distributed moderation (see SPEC.md section 6).
// Three layers, most power at the edges: post creators moderate their own
// threads, community mods moderate their community, platform admins handle only
// sitewide issues. Confirmed removals lower standing (the SPEC's one allowed
// driver of standing); votes never do.

const db = require('./db');

// Standing points removed from an author when their content is confirmed-removed
// by a moderator/admin. trust.js maps the resulting standing onto a graduated
// reach multiplier, so repeated violations shrink reach (Phase 4 shadowban).
const VIOLATION_PENALTY = 25;

function isAdmin(user) {
  return !!(user && user.is_admin);
}

function communityRoleOf(userId, communityId) {
  if (!communityId) return null;
  const m = db.prepare('SELECT role FROM community_members WHERE community_id = ? AND user_id = ?').get(communityId, userId);
  if (m) return m.role;
  const c = db.prepare('SELECT creator_id FROM communities WHERE id = ?').get(communityId);
  if (c && c.creator_id === userId) return 'mod';
  return null;
}
function isCommunityMod(userId, communityId) {
  return communityRoleOf(userId, communityId) === 'mod';
}

// Can this user moderate a POST (remove / lock / pin)? A community mod of its
// community, or a platform admin. (A user deleting their own post uses the
// existing delete route; that is ownership, not moderation.)
function canModeratePost(user, post) {
  if (isAdmin(user)) return true;
  if (post.community_id) return isCommunityMod(user.id, post.community_id);
  return false;
}

// Can this user remove a COMMENT? Admin, the community mod (if the comment's post
// is in a community), or the owner of the post it sits on (creator controls).
function canModerateComment(user, comment, post) {
  if (isAdmin(user)) return true;
  if (post && post.community_id && isCommunityMod(user.id, post.community_id)) return true;
  if (post && post.user_id === user.id) return true;
  return false;
}

function logModAction(actorId, action, targetType, targetId, communityId, reason, isPublic) {
  db.prepare(
    'INSERT INTO mod_actions (actor_id, action, target_type, target_id, community_id, reason, is_public) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(actorId, action, targetType, targetId, communityId || null, reason || '', isPublic ? 1 : 0);
}

module.exports = {
  VIOLATION_PENALTY,
  isAdmin,
  communityRoleOf,
  isCommunityMod,
  canModeratePost,
  canModerateComment,
  logModAction,
};
