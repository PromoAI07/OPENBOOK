// moderation.js
// Phase 3 permission helpers for distributed moderation (see SPEC.md section 6).
// Three layers, most power at the edges: post creators moderate their own
// threads, community mods moderate their community, platform admins handle only
// sitewide issues. Confirmed removals lower standing (the SPEC's one allowed
// driver of standing); votes never do.
//
// Every helper that reads roles/communities from the (networked) database is
// async; only isAdmin (a pure flag check on an already-loaded user) stays sync.

const db = require('./db');
const crypto = require('crypto');
const { logger } = require('./logger');
const { QUARANTINE_AT } = require('./trust');

// Standing points removed from an author when their content is confirmed-removed
// by a moderator/admin. trust.js maps the resulting standing onto a graduated
// reach multiplier, so repeated violations shrink reach (Phase 4 shadowban).
const VIOLATION_PENALTY = 25;

// Karma-weighted flagging (Phase 3). When the trusted flag weight on a piece of
// content crosses this threshold it is auto-hidden PENDING REVIEW. Tunable via
// env without a deploy.
const FLAG_AUTOHIDE_THRESHOLD = Number(process.env.FLAG_AUTOHIDE_THRESHOLD || 3);

function isAdmin(user) {
  return !!(user && user.is_admin);
}

// A reporter's flag weight, proportional to their Account Standing, and capped
// hard for brand-new / low-trust accounts so a swarm of fresh sockpuppets can
// never brigade real content down. A trusted, high-standing member carries real
// weight; a quarantined or floored account carries almost none. This is the
// anti-brigade core: weight scales with earned trust, not with raw numbers.
function flagWeight(user) {
  const s = (user && user.standing == null) ? 100 : (user ? user.standing : 100);
  const tl = (user && user.trust_level) || 0;
  let w;
  if (s >= 150) w = 2.0;            // trusted, above baseline
  else if (s >= 100) w = 1.0;       // baseline
  else if (s >= QUARANTINE_AT) w = 0.3; // 50..99, sliding toward quarantine
  else w = 0.05;                    // quarantined / floored: near zero
  if (tl <= 0) w = Math.min(w, 0.25);   // brand-new accounts cannot brigade
  else if (tl === 1) w = Math.min(w, 0.6);
  return Math.round(w * 100) / 100;
}

// A single shared "OpenBook" system account, used as the actor for automated
// mod-log entries (auto-hide, jury outcomes) so the public ledger always has a
// real, non-personal actor. Created lazily, reused forever. It cannot log in
// (its password hash is random and not a bcrypt hash, so no password matches).
let _systemId = null;
async function systemUserId() {
  if (_systemId) return _systemId;
  const SYS_EMAIL = 'system@openbook.local';
  const u = await db.prepare('SELECT id FROM users WHERE email = ?').get(SYS_EMAIL);
  if (u) { _systemId = u.id; return u.id; }
  const info = await db.prepare(
    "INSERT INTO users (name, email, password_hash, email_verified, bio) VALUES ('OpenBook', ?, ?, 1, 'Automated platform actions.')"
  ).run(SYS_EMAIL, 'x' + crypto.randomBytes(24).toString('hex'));
  _systemId = info.lastInsertRowid;
  return _systemId;
}

async function currentVisibility(targetType, targetId) {
  if (targetType === 'post') {
    const r = await db.prepare('SELECT visibility FROM posts WHERE id = ?').get(targetId);
    return r ? (r.visibility || 'visible') : null;
  }
  if (targetType === 'comment') {
    const r = await db.prepare('SELECT visibility FROM comments WHERE id = ?').get(targetId);
    return r ? (r.visibility || 'visible') : null;
  }
  if (targetType === 'reel') {
    const r = await db.prepare('SELECT visibility FROM reels WHERE id = ?').get(targetId);
    return r ? (r.visibility || 'visible') : null;
  }
  return 'visible';
}
async function setContentVisibility(targetType, targetId, vis) {
  if (targetType === 'post') await db.prepare('UPDATE posts SET visibility = ? WHERE id = ?').run(vis, targetId);
  else if (targetType === 'comment') await db.prepare('UPDATE comments SET visibility = ? WHERE id = ?').run(vis, targetId);
  else if (targetType === 'reel') await db.prepare('UPDATE reels SET visibility = ? WHERE id = ?').run(vis, targetId);
}

// Sum the weighted OPEN flags on a target and auto-hide it (pending review) when
// they cross the threshold. SOFT on purpose: it hides the content for review,
// writes the exact math to the PUBLIC mod log, and never touches the author's
// standing. Only a confirmed human or jury decision changes standing, so flagging
// can never directly destroy someone's reputation. Returns a summary the caller
// (and the Phase 4 jury trigger) can act on.
async function evaluateAndAutoHide(targetType, targetId, communityId) {
  const agg = await db.prepare(
    "SELECT COALESCE(SUM(weight),0) w, COUNT(*) c FROM reports WHERE target_type = ? AND target_id = ? AND status = 'open'"
  ).get(targetType, targetId);
  const weight = Math.round(agg.w * 100) / 100;
  const out = { hidden: false, weight, count: agg.c, threshold: FLAG_AUTOHIDE_THRESHOLD };
  if (weight < FLAG_AUTOHIDE_THRESHOLD) return out;
  if (targetType !== 'post' && targetType !== 'comment') return out; // reels have no visibility column
  const cur = await currentVisibility(targetType, targetId);
  if (cur !== 'visible') { out.already = true; return out; }

  const top = await db.prepare(
    "SELECT reason_code, COUNT(*) n FROM reports WHERE target_type = ? AND target_id = ? AND status = 'open' GROUP BY reason_code ORDER BY n DESC LIMIT 1"
  ).get(targetType, targetId);
  const reason = top ? top.reason_code : 'other';
  await setContentVisibility(targetType, targetId, 'auto_hidden');
  const math = 'Auto-hidden pending review: weighted community flags ' + weight.toFixed(2) +
    ' reached the ' + FLAG_AUTOHIDE_THRESHOLD.toFixed(2) + ' threshold across ' + agg.c +
    ' report(s). Most-cited rule: ' + reason + '. No standing was changed.';
  const sys = await systemUserId();
  await db.prepare(
    "INSERT INTO mod_actions (actor_id, action, target_type, target_id, community_id, reason, is_public) VALUES (?, 'auto_hide', ?, ?, ?, ?, 1)"
  ).run(sys, targetType, targetId, communityId || null, math);
  // Phase 4: convene a community jury to decide Keep/Remove on this auto-hide.
  // Lazy require avoids a load-time cycle (jury.js leans on this module).
  try { await require('./jury').convene(targetType, targetId, communityId, reason); }
  catch (e) { logger.warn({ err: e }, 'jury convene failed'); }
  out.hidden = true; out.reason = reason; out.math = math;
  return out;
}

async function communityRoleOf(userId, communityId) {
  if (!communityId) return null;
  const m = await db.prepare('SELECT role FROM community_members WHERE community_id = ? AND user_id = ?').get(communityId, userId);
  if (m) return m.role;
  const c = await db.prepare('SELECT creator_id FROM communities WHERE id = ?').get(communityId);
  if (c && c.creator_id === userId) return 'mod';
  return null;
}
async function isCommunityMod(userId, communityId) {
  return (await communityRoleOf(userId, communityId)) === 'mod';
}

// Can this user moderate a POST (remove / lock / pin)? A community mod of its
// community, or a platform admin. (A user deleting their own post uses the
// existing delete route; that is ownership, not moderation.)
async function canModeratePost(user, post) {
  if (isAdmin(user)) return true;
  if (post.community_id) return isCommunityMod(user.id, post.community_id);
  return false;
}

// Can this user remove a COMMENT? Admin, the community mod (if the comment's post
// is in a community), or the owner of the post it sits on (creator controls).
async function canModerateComment(user, comment, post) {
  if (isAdmin(user)) return true;
  if (post && post.community_id && (await isCommunityMod(user.id, post.community_id))) return true;
  if (post && post.user_id === user.id) return true;
  return false;
}

async function logModAction(actorId, action, targetType, targetId, communityId, reason, isPublic) {
  await db.prepare(
    'INSERT INTO mod_actions (actor_id, action, target_type, target_id, community_id, reason, is_public) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(actorId, action, targetType, targetId, communityId || null, reason || '', isPublic ? 1 : 0);
}

module.exports = {
  VIOLATION_PENALTY,
  FLAG_AUTOHIDE_THRESHOLD,
  isAdmin,
  communityRoleOf,
  isCommunityMod,
  canModeratePost,
  canModerateComment,
  logModAction,
  flagWeight,
  systemUserId,
  currentVisibility,
  setContentVisibility,
  evaluateAndAutoHide,
};
