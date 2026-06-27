// routes/moderation.js
// Phase 3/4: reporting, removal/restore, lock, pin, community bans, the public
// mod log, and appeals. Confirmed moderator/admin removals lower the author's
// standing (trust.js then shrinks their reach), the author is notified, and they
// can appeal. Every public-facing action is written to the mod log.

const express = require('express');
const db = require('../db');
const { requireAuth, publicUser } = require('../auth');
const { notify } = require('../notify');
const { recordStandingEvent } = require('../trust');
const {
  VIOLATION_PENALTY, isAdmin, isCommunityMod,
  canModeratePost, canModerateComment, logModAction,
} = require('../moderation');

const router = express.Router();

const REPORT_REASONS = ['spam', 'harassment', 'hate', 'violence', 'sexual', 'illegal', 'misinfo', 'other'];

// Resolve a target to its author + community context.
async function resolveTarget(targetType, targetId) {
  if (targetType === 'post') {
    const p = await db.prepare('SELECT * FROM posts WHERE id = ?').get(targetId);
    return p ? { post: p, authorId: p.user_id, communityId: p.community_id || null } : null;
  }
  if (targetType === 'comment') {
    const c = await db.prepare('SELECT * FROM comments WHERE id = ?').get(targetId);
    if (!c) return null;
    const p = await db.prepare('SELECT * FROM posts WHERE id = ?').get(c.post_id);
    return { comment: c, post: p, authorId: c.user_id, communityId: p ? p.community_id || null : null };
  }
  if (targetType === 'reel') {
    const r = await db.prepare('SELECT * FROM reels WHERE id = ?').get(targetId);
    return r ? { reel: r, authorId: r.user_id, communityId: null } : null;
  }
  return null;
}

// ---- Reports ----
router.post('/reports', requireAuth, async (req, res) => {
  const targetType = req.body.targetType;
  const targetId = Number(req.body.targetId);
  const reasonCode = REPORT_REASONS.includes(req.body.reasonCode) ? req.body.reasonCode : 'other';
  const detail = (req.body.detail || '').toString().slice(0, 500);
  if (!['post', 'comment', 'reel'].includes(targetType) || !targetId) {
    return res.status(400).json({ error: 'Invalid report target' });
  }
  const t = await resolveTarget(targetType, targetId);
  if (!t) return res.status(404).json({ error: 'Content not found' });
  if (t.authorId === req.user.id) return res.status(400).json({ error: 'You cannot report your own content' });
  await db.prepare('INSERT INTO reports (reporter_id, target_type, target_id, reason_code, detail) VALUES (?, ?, ?, ?, ?)')
    .run(req.user.id, targetType, targetId, reasonCode, detail);
  res.json({ ok: true });
});

// Open reports the current user may handle: admins see all, community mods see
// reports for content in their communities.
router.get('/reports', requireAuth, async (req, res) => {
  const admin = isAdmin(req.user);
  const rows = await db.prepare("SELECT * FROM reports WHERE status = 'open' ORDER BY created_at DESC LIMIT 200").all();
  const out = [];
  for (const r of rows) {
    const t = await resolveTarget(r.target_type, r.target_id);
    if (!t) continue;
    if (!admin && !(t.communityId && await isCommunityMod(req.user.id, t.communityId))) continue;
    out.push({
      id: r.id,
      targetType: r.target_type,
      targetId: r.target_id,
      reasonCode: r.reason_code,
      detail: r.detail,
      created_at: r.created_at,
      communityId: t.communityId,
      author: publicUser(await db.prepare('SELECT * FROM users WHERE id = ?').get(t.authorId)),
      preview: (t.post ? (t.post.title || t.post.content) : t.comment ? t.comment.content : t.reel ? t.reel.caption : '') || '',
      removed: (t.post && t.post.visibility !== 'visible') || (t.comment && t.comment.visibility !== 'visible'),
    });
  }
  res.json({ reports: out, isAdmin: admin });
});

// Dismiss a report a moderator judges not actionable (scoped like the queue).
router.post('/reports/:id/dismiss', requireAuth, async (req, res) => {
  const r = await db.prepare('SELECT * FROM reports WHERE id = ?').get(Number(req.params.id));
  if (!r) return res.status(404).json({ error: 'Report not found' });
  const t = await resolveTarget(r.target_type, r.target_id);
  const allowed = isAdmin(req.user) || (t && t.communityId && await isCommunityMod(req.user.id, t.communityId));
  if (!allowed) return res.status(403).json({ error: 'Not allowed' });
  await db.prepare("UPDATE reports SET status = 'dismissed' WHERE id = ?").run(r.id);
  res.json({ ok: true });
});

// ---- Remove / restore (posts and comments) ----
async function applyRemoval(req, res, restore) {
  const targetType = req.body.targetType;
  const targetId = Number(req.body.targetId);
  const reason = (req.body.reason || '').toString().slice(0, 300);
  if (!['post', 'comment'].includes(targetType) || !targetId) {
    return res.status(400).json({ error: 'Invalid target' });
  }
  const t = await resolveTarget(targetType, targetId);
  if (!t) return res.status(404).json({ error: 'Content not found' });

  const allowed = targetType === 'post'
    ? await canModeratePost(req.user, t.post)
    : await canModerateComment(req.user, t.comment, t.post);
  if (!allowed) return res.status(403).json({ error: 'You are not allowed to moderate this' });

  // Idempotency guard: treat this as a state transition. If the content is
  // already in the requested state, do nothing (no second standing penalty, no
  // duplicate log, no extra notification). This is what keeps "one confirmed
  // removal = exactly one standing change" true and stops a mod from stacking
  // penalties or minting standing by repeating remove/restore.
  const curVis = (targetType === 'post' ? t.post.visibility : t.comment.visibility) || 'visible';
  const wasVisible = curVis === 'visible';
  if (wasVisible === restore) return res.json({ ok: true, changed: false });

  const newVis = restore ? 'visible' : 'removed';
  if (targetType === 'post') await db.prepare('UPDATE posts SET visibility = ? WHERE id = ?').run(newVis, targetId);
  else await db.prepare('UPDATE comments SET visibility = ? WHERE id = ?').run(newVis, targetId);

  // A standing penalty (and notification + appeal trail) applies only to genuine
  // moderator/admin actions against someone else, and is reversed on restore.
  // A post owner tidying a comment on their own non-community thread is not a
  // platform violation, so it carries no standing impact and stays a private log.
  const isModeratorAction = isAdmin(req.user) || (t.communityId && await isCommunityMod(req.user.id, t.communityId));
  if (t.authorId !== req.user.id && isModeratorAction) {
    await recordStandingEvent(
      t.authorId,
      restore ? VIOLATION_PENALTY : -VIOLATION_PENALTY,
      restore ? 'removal_reversed' : 'content_removed' + (reason ? ':' + reason : '')
    );
    await notify(t.authorId, req.user.id, restore ? 'mod_restored' : 'mod_removed', targetType === 'post' ? targetId : (t.post ? t.post.id : null));
  }
  await logModAction(req.user.id, (restore ? 'restore_' : 'remove_') + targetType, targetType, targetId, t.communityId, reason, isModeratorAction ? 1 : 0);
  if (!restore) {
    await db.prepare("UPDATE reports SET status = 'resolved' WHERE target_type = ? AND target_id = ? AND status = 'open'").run(targetType, targetId);
  }
  res.json({ ok: true, changed: true });
}
router.post('/remove', requireAuth, (req, res) => applyRemoval(req, res, false));
router.post('/restore', requireAuth, (req, res) => applyRemoval(req, res, true));

// ---- Lock / pin a post ----
router.post('/lock', requireAuth, async (req, res) => {
  const postId = Number(req.body.postId);
  const locked = req.body.locked ? 1 : 0;
  const post = await db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  if (!(await canModeratePost(req.user, post)) && post.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Not allowed' });
  }
  await db.prepare('UPDATE posts SET locked = ? WHERE id = ?').run(locked, postId);
  // Only a genuine mod/admin lock is public; an author locking their own thread
  // is a private action and must not appear in the community's public mod log.
  const isModeratorAction = isAdmin(req.user) || (post.community_id && await isCommunityMod(req.user.id, post.community_id));
  await logModAction(req.user.id, locked ? 'lock' : 'unlock', 'post', postId, post.community_id || null, '', isModeratorAction ? 1 : 0);
  res.json({ ok: true, locked: !!locked });
});
router.post('/pin', requireAuth, async (req, res) => {
  const postId = Number(req.body.postId);
  const pinned = req.body.pinned ? 1 : 0;
  const post = await db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  if (!(await canModeratePost(req.user, post))) return res.status(403).json({ error: 'Only a community mod can pin' });
  await db.prepare('UPDATE posts SET pinned = ? WHERE id = ?').run(pinned, postId);
  await logModAction(req.user.id, pinned ? 'pin' : 'unpin', 'post', postId, post.community_id || null, '', 1);
  res.json({ ok: true, pinned: !!pinned });
});

// ---- Community ban / unban ----
router.post('/community/:id/ban', requireAuth, async (req, res) => {
  const communityId = Number(req.params.id);
  const userId = Number(req.body.userId);
  const reason = (req.body.reason || '').toString().slice(0, 300);
  if (!(await isCommunityMod(req.user.id, communityId)) && !isAdmin(req.user)) {
    return res.status(403).json({ error: 'Only a community mod can ban' });
  }
  if (!(await db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId))) return res.status(404).json({ error: 'User not found' });
  await db.prepare('INSERT OR IGNORE INTO community_bans (community_id, user_id, reason) VALUES (?, ?, ?)').run(communityId, userId, reason);
  await db.prepare('DELETE FROM community_members WHERE community_id = ? AND user_id = ?').run(communityId, userId);
  await logModAction(req.user.id, 'ban', 'user', userId, communityId, reason, 1);
  await notify(userId, req.user.id, 'mod_removed', null);
  res.json({ ok: true });
});
router.post('/community/:id/unban', requireAuth, async (req, res) => {
  const communityId = Number(req.params.id);
  const userId = Number(req.body.userId);
  if (!(await isCommunityMod(req.user.id, communityId)) && !isAdmin(req.user)) {
    return res.status(403).json({ error: 'Only a community mod can unban' });
  }
  await db.prepare('DELETE FROM community_bans WHERE community_id = ? AND user_id = ?').run(communityId, userId);
  await logModAction(req.user.id, 'unban', 'user', userId, communityId, '', 1);
  res.json({ ok: true });
});

// ---- Public mod log (transparency) ----
router.get('/community/:id/log', requireAuth, async (req, res) => {
  const communityId = Number(req.params.id);
  const rows = await db.prepare("SELECT * FROM mod_actions WHERE community_id = ? AND is_public = 1 ORDER BY created_at DESC LIMIT 100").all(communityId);
  res.json({
    log: await Promise.all(rows.map(async (r) => ({
      id: r.id,
      action: r.action,
      targetType: r.target_type,
      targetId: r.target_id,
      reason: r.reason,
      created_at: r.created_at,
      actor: publicUser(await db.prepare('SELECT * FROM users WHERE id = ?').get(r.actor_id)),
    }))),
  });
});

// ---- Appeals (no secret-forever shadowbans) ----
router.post('/appeals', requireAuth, async (req, res) => {
  const modActionId = req.body.modActionId ? Number(req.body.modActionId) : null;
  const message = (req.body.message || '').toString().slice(0, 1000);
  if (!message) return res.status(400).json({ error: 'Add a message explaining your appeal' });
  // Link the appeal to the specific content so a reversal can restore it.
  const targetType = ['post', 'comment'].includes(req.body.targetType) ? req.body.targetType : null;
  const targetId = req.body.targetId ? Number(req.body.targetId) : null;
  await db.prepare('INSERT INTO appeals (user_id, mod_action_id, message, target_type, target_id) VALUES (?, ?, ?, ?, ?)')
    .run(req.user.id, modActionId, message, targetType, targetId);
  res.json({ ok: true });
});
router.get('/appeals', requireAuth, async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Admins only' });
  const rows = await db.prepare("SELECT * FROM appeals WHERE status = 'open' ORDER BY created_at DESC LIMIT 100").all();
  res.json({
    appeals: await Promise.all(rows.map(async (a) => ({
      id: a.id,
      message: a.message,
      modActionId: a.mod_action_id,
      created_at: a.created_at,
      user: publicUser(await db.prepare('SELECT * FROM users WHERE id = ?').get(a.user_id)),
    }))),
  });
});
router.post('/appeals/:id/resolve', requireAuth, async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Admins only' });
  const id = Number(req.params.id);
  const decision = req.body.decision === 'reversed' ? 'reversed' : 'upheld';
  const a = await db.prepare('SELECT * FROM appeals WHERE id = ?').get(id);
  if (!a) return res.status(404).json({ error: 'Appeal not found' });
  await db.prepare('UPDATE appeals SET status = ? WHERE id = ?').run(decision, id);

  // A reversal actually undoes the action: restore the linked content and credit
  // back the standing it cost. Guarded on the content still being removed, so it
  // is idempotent and cannot double-credit or stack with a manual restore.
  if (decision === 'reversed' && a.target_type && a.target_id) {
    const t = await resolveTarget(a.target_type, a.target_id);
    if (t) {
      const curVis = (a.target_type === 'post' ? t.post && t.post.visibility : t.comment && t.comment.visibility) || 'visible';
      if (curVis !== 'visible') {
        if (a.target_type === 'post') await db.prepare("UPDATE posts SET visibility = 'visible' WHERE id = ?").run(a.target_id);
        else await db.prepare("UPDATE comments SET visibility = 'visible' WHERE id = ?").run(a.target_id);
        if (t.authorId) await recordStandingEvent(t.authorId, VIOLATION_PENALTY, 'appeal_reversed');
        await logModAction(req.user.id, 'restore_' + a.target_type, a.target_type, a.target_id, t.communityId, 'appeal reversed', t.communityId ? 1 : 0);
      }
    }
  }
  await notify(a.user_id, req.user.id, decision === 'reversed' ? 'mod_restored' : 'mod_removed', null);
  res.json({ ok: true, decision });
});

module.exports = router;
