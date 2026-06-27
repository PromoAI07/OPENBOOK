// jury.js
// Phase 4: the community jury (decentralized moderation). When flagged content
// is auto-hidden by karma-weighted flags, an odd-sized panel of randomly chosen,
// pristine-standing, established members is convened to decide Keep or Remove.
// The majority verdict executes automatically and the full case file (ballot
// breakdown + outcome) is published to the public mod log. Jurors are anonymous
// and never see who flagged the content or who wrote it: they judge the content,
// not the person.
//
// Standing rule preserved: a jury REMOVE is a confirmed decision, so (and only
// then) the author's standing drops by the same VIOLATION_PENALTY a human mod
// removal uses. A KEEP restores the content and dismisses the flags. A tie, or an
// expiry with no majority, defaults to KEEP, because content is never removed
// without a real majority.

const db = require('./db');
const { logger } = require('./logger');
const { recordStandingEvent } = require('./trust');
const { notify } = require('./notify');

const JURY_SIZE = Math.max(3, Number(process.env.JURY_SIZE || 5) | 0);     // target panel size
const JURY_MIN = Math.max(3, Number(process.env.JURY_MIN || 3) | 0);       // minimum to convene
const JURY_TTL_HOURS = Number(process.env.JURY_TTL_HOURS || 72);           // auto-settle after this
const JURY_MIN_STANDING = Number(process.env.JURY_MIN_STANDING || 120);    // "pristine" standing
const JURY_MIN_TL = Number(process.env.JURY_MIN_TL || 2);                  // established account

function oddDown(n) { return n % 2 === 0 ? n - 1 : n; }

async function authorOf(targetType, targetId) {
  if (targetType === 'post') { const r = await db.prepare('SELECT user_id FROM posts WHERE id = ?').get(targetId); return r ? r.user_id : null; }
  if (targetType === 'comment') { const r = await db.prepare('SELECT user_id FROM comments WHERE id = ?').get(targetId); return r ? r.user_id : null; }
  return null;
}

// Randomly draw up to `limit` pristine, established, verified jurors, excluding
// the author and anyone who flagged the content (no conflicts of interest), plus
// the ghost/system sentinel accounts.
async function eligibleJurors(excludeIds, limit) {
  const ex = excludeIds.filter(Boolean);
  let sql = "SELECT id FROM users WHERE standing >= ? AND trust_level >= ? AND email_verified = 1 " +
    "AND email NOT LIKE '%@deleted.openbook.local' AND email <> 'system@openbook.local'";
  const args = [JURY_MIN_STANDING, JURY_MIN_TL];
  if (ex.length) { sql += ' AND id NOT IN (' + ex.map(() => '?').join(',') + ')'; args.push(...ex); }
  sql += ' ORDER BY RANDOM() LIMIT ?'; args.push(limit);
  const rows = await db.prepare(sql).all(...args);
  return rows.map((r) => r.id);
}

// Convene a jury for a target. No-op if one is already open for it, or if there
// are not yet enough pristine jurors (a brand-new platform stays in human review
// until the community is large enough to seat a real panel). Returns the jury id
// or null.
async function convene(targetType, targetId, communityId, reasonCode) {
  if (targetType !== 'post' && targetType !== 'comment') return null;
  const existing = await db.prepare("SELECT id FROM juries WHERE target_type=? AND target_id=? AND status='open'").get(targetType, targetId);
  if (existing) return null;
  const authorId = await authorOf(targetType, targetId);
  const reporters = (await db.prepare('SELECT DISTINCT reporter_id FROM reports WHERE target_type=? AND target_id=?').all(targetType, targetId)).map((r) => r.reporter_id);
  const exclude = [...new Set([authorId, ...reporters])];
  const pool = await eligibleJurors(exclude, JURY_SIZE);
  const panel = oddDown(Math.min(JURY_SIZE, pool.length));
  if (panel < JURY_MIN) {
    logger.info({ targetType, targetId, eligible: pool.length }, 'jury not convened: not enough pristine jurors yet');
    return null;
  }
  const chosen = pool.slice(0, panel);
  const info = await db.prepare(
    "INSERT INTO juries (target_type, target_id, community_id, reason_code, size, status, expires_at) VALUES (?, ?, ?, ?, ?, 'open', datetime('now', ?))"
  ).run(targetType, targetId, communityId || null, reasonCode || '', panel, '+' + JURY_TTL_HOURS + ' hours');
  const juryId = info.lastInsertRowid;
  const mod = require('./moderation');
  const sys = await mod.systemUserId();
  for (const uid of chosen) {
    await db.prepare('INSERT OR IGNORE INTO jury_members (jury_id, user_id) VALUES (?, ?)').run(juryId, uid);
    notify(uid, sys, 'jury_duty', null);
  }
  try {
    await db.prepare("INSERT INTO mod_actions (actor_id, action, target_type, target_id, community_id, reason, is_public) VALUES (?, 'jury_opened', ?, ?, ?, ?, 1)")
      .run(sys, targetType, targetId, communityId || null, 'A community jury of ' + panel + ' randomly selected, pristine-standing members was convened to review flagged content (' + (reasonCode || 'other') + ').');
  } catch (e) {}
  logger.info({ juryId, panel, targetType, targetId }, 'jury convened');
  return juryId;
}

// Record a juror's ballot and settle early once a majority (or full turnout) is
// reached.
async function castVote(juryId, userId, vote) {
  if (vote !== 'keep' && vote !== 'remove') throw new Error('Vote must be keep or remove');
  const jury = await db.prepare('SELECT * FROM juries WHERE id = ?').get(juryId);
  if (!jury || jury.status !== 'open') throw new Error('This jury is closed');
  const member = await db.prepare('SELECT * FROM jury_members WHERE jury_id = ? AND user_id = ?').get(juryId, userId);
  if (!member) throw new Error('You are not on this jury');
  if (member.vote) throw new Error('You have already voted on this case');
  await db.prepare("UPDATE jury_members SET vote = ?, voted_at = datetime('now') WHERE jury_id = ? AND user_id = ?").run(vote, juryId, userId);
  const tally = await db.prepare("SELECT SUM(vote='keep') keep, SUM(vote='remove') remove, SUM(vote IS NOT NULL) cast FROM jury_members WHERE jury_id = ?").get(juryId);
  const keep = tally.keep || 0, remove = tally.remove || 0, cast = tally.cast || 0;
  const majority = Math.floor(jury.size / 2) + 1;
  if (keep >= majority || remove >= majority || cast >= jury.size) {
    await settle(jury);
    return { settled: true };
  }
  return { settled: false };
}

// Tally the ballots and execute the verdict. Idempotent: only acts on an open
// jury. Tie or no-majority defaults to KEEP (never remove without a majority).
async function settle(juryRow) {
  const jury = await db.prepare('SELECT * FROM juries WHERE id = ?').get(juryRow.id);
  if (!jury || jury.status !== 'open') return;
  const tally = await db.prepare("SELECT SUM(vote='keep') keep, SUM(vote='remove') remove FROM jury_members WHERE jury_id = ?").get(jury.id);
  const keep = tally.keep || 0, remove = tally.remove || 0;
  const outcome = remove > keep ? 'remove' : 'keep';
  await db.prepare("UPDATE juries SET status='decided', outcome=?, keep_votes=?, remove_votes=?, decided_at=datetime('now') WHERE id=?").run(outcome, keep, remove, jury.id);

  const mod = require('./moderation');
  const sys = await mod.systemUserId();
  const authorId = await authorOf(jury.target_type, jury.target_id);
  const cur = await mod.currentVisibility(jury.target_type, jury.target_id);
  if (outcome === 'remove') {
    await mod.setContentVisibility(jury.target_type, jury.target_id, 'removed');
    if (authorId) {
      await recordStandingEvent(authorId, -mod.VIOLATION_PENALTY, 'jury_removed:' + (jury.reason_code || 'other'));
      notify(authorId, sys, 'mod_removed', jury.target_type === 'post' ? jury.target_id : null);
    }
    await db.prepare("UPDATE reports SET status='resolved' WHERE target_type=? AND target_id=? AND status='open'").run(jury.target_type, jury.target_id);
  } else {
    // Restore only if it was flag-auto-hidden; never override a separate human removal.
    if (cur === 'auto_hidden') await mod.setContentVisibility(jury.target_type, jury.target_id, 'visible');
    if (authorId) notify(authorId, sys, 'mod_restored', jury.target_type === 'post' ? jury.target_id : null);
    await db.prepare("UPDATE reports SET status='dismissed' WHERE target_type=? AND target_id=? AND status='open'").run(jury.target_type, jury.target_id);
  }
  const caseFile = 'Community jury of ' + jury.size + ' decided: ' + outcome.toUpperCase() +
    '. Ballot: ' + remove + ' remove / ' + keep + ' keep. Flag reviewed: ' + (jury.reason_code || 'other') + '. Standing changed only on a remove verdict.';
  try {
    await db.prepare("INSERT INTO mod_actions (actor_id, action, target_type, target_id, community_id, reason, is_public) VALUES (?, 'jury_verdict', ?, ?, ?, ?, 1)")
      .run(sys, jury.target_type, jury.target_id, jury.community_id, caseFile);
  } catch (e) {}
  logger.info({ juryId: jury.id, outcome, keep, remove }, 'jury settled');
  return outcome;
}

// Settle any juries past their deadline on whatever votes were cast.
async function expireJuries() {
  let rows = [];
  try { rows = await db.prepare("SELECT * FROM juries WHERE status='open' AND expires_at IS NOT NULL AND expires_at < datetime('now')").all(); }
  catch (e) { return 0; }
  for (const j of rows) { try { await settle(j); } catch (e) { logger.warn({ err: e, juryId: j.id }, 'expire-settle failed'); } }
  if (rows.length) logger.info({ count: rows.length }, 'expired juries settled');
  return rows.length;
}

let timer = null;
function startJuryJobs() {
  if (timer) return;
  expireJuries().catch(() => {});
  timer = setInterval(() => expireJuries().catch(() => {}), 600000); // every 10 min
  if (timer.unref) timer.unref();
  logger.info('jury expiry job started');
}

module.exports = {
  convene, castVote, settle, expireJuries, startJuryJobs, authorOf, eligibleJurors,
  JURY_SIZE, JURY_MIN, JURY_TTL_HOURS, JURY_MIN_STANDING, JURY_MIN_TL,
};
