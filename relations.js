// relations.js
// Safety relationships between users: BLOCK (a full two-way cutoff) and MUTE (a soft
// one-way hide), plus the helpers the rest of the app uses to enforce them.
//
//   block(a, b)  -> a blocks b. Removes any friendship + follows between them (both
//                   directions), so a block also un-friends and un-follows.
//   isBlocked(a, b) -> true if EITHER a blocked b OR b blocked a. Used to refuse DMs,
//                   friend requests, follows, and mention notifications, and to lock the
//                   profile + wall, in either direction.
//   mute(a, b)   -> a mutes b. b's posts drop out of a's feeds only; b is not cut off
//                   and is never told.
//   feedHiddenIds(viewerId) -> the set of author ids to hide from the viewer's feeds:
//                   everyone the viewer blocked, everyone who blocked the viewer, and
//                   everyone the viewer muted.

const db = require('./db');

async function isBlocked(a, b) {
  if (!a || !b || a === b) return false;
  const r = await db.prepare(
    'SELECT 1 AS x FROM blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?) LIMIT 1'
  ).get(a, b, b, a);
  return !!r;
}

// Did viewer specifically block target (viewer is the blocker)? Used for UI state.
async function iBlocked(viewer, target) {
  const r = await db.prepare('SELECT 1 AS x FROM blocks WHERE blocker_id = ? AND blocked_id = ?').get(viewer, target);
  return !!r;
}
async function iMuted(viewer, target) {
  const r = await db.prepare('SELECT 1 AS x FROM mutes WHERE muter_id = ? AND muted_id = ?').get(viewer, target);
  return !!r;
}

async function block(blocker, blocked) {
  if (!blocker || !blocked || blocker === blocked) return false;
  // A block writes the block row AND severs any friendship + follows both ways (you
  // cannot be blocked and still friends/following). Run all three as ONE atomic write
  // transaction so a concurrent friend-accept or follow cannot interleave between the
  // statements and leave a half-applied block (block row written but a follow re-created).
  await db.batch([
    { sql: 'INSERT OR IGNORE INTO blocks (blocker_id, blocked_id) VALUES (?, ?)', args: [blocker, blocked] },
    { sql: 'DELETE FROM friendships WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)', args: [blocker, blocked, blocked, blocker] },
    { sql: 'DELETE FROM follows WHERE (follower_id = ? AND followee_id = ?) OR (follower_id = ? AND followee_id = ?)', args: [blocker, blocked, blocked, blocker] },
  ], 'write');
  return true;
}
async function unblock(blocker, blocked) {
  await db.prepare('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?').run(blocker, blocked);
  return true; // unblocking does NOT restore the severed friendship/follow
}
async function mute(muter, muted) {
  if (!muter || !muted || muter === muted) return false;
  await db.prepare('INSERT OR IGNORE INTO mutes (muter_id, muted_id) VALUES (?, ?)').run(muter, muted);
  return true;
}
async function unmute(muter, muted) {
  await db.prepare('DELETE FROM mutes WHERE muter_id = ? AND muted_id = ?').run(muter, muted);
  return true;
}

// Author ids blocked in EITHER direction (no mutes). Use this where a BLOCK must hide
// someone but a MUTE must not: rosters, people search, and notifications. Mute is a
// one-way feed hide, so a muted person stays discoverable and can still notify; only a
// block makes the pair invisible to each other.
async function blockedIds(viewerId) {
  const set = new Set();
  try {
    const rows = await db.prepare(
      'SELECT blocked_id AS id FROM blocks WHERE blocker_id = ? ' +
      'UNION SELECT blocker_id AS id FROM blocks WHERE blocked_id = ?'
    ).all(viewerId, viewerId);
    rows.forEach((r) => set.add(r.id));
  } catch (e) {}
  return set;
}

// Author ids to hide from a viewer's feeds: blocked (either direction) + muted by viewer.
async function feedHiddenIds(viewerId) {
  const set = new Set();
  try {
    const rows = await db.prepare(
      'SELECT blocked_id AS id FROM blocks WHERE blocker_id = ? ' +
      'UNION SELECT blocker_id AS id FROM blocks WHERE blocked_id = ? ' +
      'UNION SELECT muted_id AS id FROM mutes WHERE muter_id = ?'
    ).all(viewerId, viewerId, viewerId);
    rows.forEach((r) => set.add(r.id));
  } catch (e) {}
  return set;
}

// Can the viewer see this owner's social graph (friends / followers / following)? Mirrors
// the profile-visibility gate AND a block: owner always; otherwise blocked -> no, private
// -> no, friends-only -> friends only, public -> yes.
async function canSeeSocialGraph(viewerId, ownerId) {
  if (viewerId === ownerId) return true;
  if (await isBlocked(viewerId, ownerId)) return false;
  const u = await db.prepare('SELECT profile_visibility FROM users WHERE id = ?').get(ownerId);
  const vis = (u && u.profile_visibility) || 'public';
  if (vis === 'public') return true;
  if (vis === 'private') return false;
  const f = await db.prepare(
    "SELECT 1 FROM friendships WHERE status = 'accepted' AND ((requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?))"
  ).get(viewerId, ownerId, ownerId, viewerId);
  return !!f;
}

async function listBlocked(viewerId) {
  return (await db.prepare('SELECT blocked_id AS id FROM blocks WHERE blocker_id = ? ORDER BY created_at DESC').all(viewerId)).map((r) => r.id);
}
async function listMuted(viewerId) {
  return (await db.prepare('SELECT muted_id AS id FROM mutes WHERE muter_id = ? ORDER BY created_at DESC').all(viewerId)).map((r) => r.id);
}

module.exports = { isBlocked, iBlocked, iMuted, block, unblock, mute, unmute, blockedIds, feedHiddenIds, canSeeSocialGraph, listBlocked, listMuted };
