// referrals.js
// Incentivize real growth: invite friends and family, and for every 5 invited
// accounts that prove they are real, retained humans (active for 30+ days, not
// bots), the referrer earns one free month of Premium plus an Inviter badge.
//
// A referral only "qualifies" once the invited account clears the same Phase 5
// trust / anti-sybil bar we already use, so the reward cannot be farmed with
// throwaway or bot accounts:
//   - account age >= 30 days (REFERRAL_QUALIFY_DAYS)
//   - healthy standing (not quarantined / shadowbanned)
//   - real activity: at least REFERRAL_MIN_CONTRIB posts + comments
//   - a DISTINCT device fingerprint from the referrer (no self-referral rings)
//
// Reward = tier TIME only (free Premium months via entitlements.extendTier).
// It never touches karma, standing, reach, or voting weight. credible neutrality
// holds: you can grow the network, but you cannot buy influence over the feed.
//
// Every helper that reads/writes the database is async; genCode, parseTs and
// inviterBadge (pure) stay sync.

const crypto = require('crypto');
const db = require('./db');
const { logger } = require('./logger');
const { extendTier } = require('./entitlements');
const { QUARANTINE_AT } = require('./trust');

const QUALIFY_AGE_DAYS = Number(process.env.REFERRAL_QUALIFY_DAYS || 30);
const QUALIFY_MIN_CONTRIB = Number(process.env.REFERRAL_MIN_CONTRIB || 5); // posts + comments
const REWARD_EVERY = Math.max(1, Number(process.env.REFERRAL_REWARD_EVERY || 5));
const REWARD_TIER = 3;   // Premium
const REWARD_DAYS = 30;  // one month

function genCode() {
  return crypto.randomBytes(6).toString('base64url').replace(/[-_]/g, '').slice(0, 8) || crypto.randomBytes(4).toString('hex');
}

// Ensure a user has a unique referral code (generated lazily, so accounts that
// predate this feature get one on first access).
async function ensureCode(userId) {
  const u = await db.prepare('SELECT referral_code FROM users WHERE id = ?').get(userId);
  if (u && u.referral_code) return u.referral_code;
  for (let i = 0; i < 12; i++) {
    const code = genCode();
    if (!(await db.prepare('SELECT 1 FROM users WHERE referral_code = ?').get(code))) {
      await db.prepare('UPDATE users SET referral_code = ? WHERE id = ?').run(code, userId);
      return code;
    }
  }
  return null;
}

async function userByCode(code) {
  if (!code) return null;
  return db.prepare('SELECT * FROM users WHERE referral_code = ?').get(String(code).trim());
}

// At signup: if the ref code is valid (and not the user's own), record
// referred_by and open a pending referral.
async function attachReferral(inviteeId, code) {
  const ref = await userByCode(code);
  if (!ref || ref.id === inviteeId) return false;
  await db.prepare('UPDATE users SET referred_by = ? WHERE id = ? AND referred_by IS NULL').run(ref.id, inviteeId);
  try {
    await db.prepare("INSERT OR IGNORE INTO referrals (referrer_id, invitee_id, status) VALUES (?, ?, 'pending')").run(ref.id, inviteeId);
  } catch (e) { /* unique invitee guard */ }
  return true;
}

function parseTs(ts) {
  if (!ts) return NaN;
  return Date.parse(String(ts).indexOf('T') >= 0 ? ts : String(ts).replace(' ', 'T') + 'Z');
}

// Is this invitee currently a real, retained human (per the rules above)?
async function inviteeQualifies(inviteeId, referrerId) {
  const u = await db.prepare('SELECT * FROM users WHERE id = ?').get(inviteeId);
  if (!u) return false;
  const created = parseTs(u.created_at);
  if (!isFinite(created) || (Date.now() - created) < QUALIFY_AGE_DAYS * 86400000) return false;
  if ((u.standing == null ? 100 : u.standing) < QUARANTINE_AT) return false; // shadowbanned/quarantined do not count
  const posts = (await db.prepare('SELECT COUNT(*) c FROM posts WHERE user_id = ?').get(inviteeId)).c;
  const comments = (await db.prepare('SELECT COUNT(*) c FROM comments WHERE user_id = ?').get(inviteeId)).c;
  if ((posts + comments) < QUALIFY_MIN_CONTRIB) return false;
  // Distinct device from the referrer (blocks the obvious self-referral ring).
  const shared = await db.prepare(
    "SELECT 1 FROM devices d1 JOIN devices d2 ON d1.fingerprint = d2.fingerprint " +
    "WHERE d1.user_id = ? AND d2.user_id = ? AND d1.fingerprint NOT IN ('', 'none') LIMIT 1"
  ).get(inviteeId, referrerId);
  if (shared) return false;
  return true;
}

// Grant any rewards the referrer is now owed (every REWARD_EVERY qualified =
// one Premium month), idempotently via referral_rewards_granted.
async function payRewards(referrerId) {
  const qcount = (await db.prepare("SELECT COUNT(*) c FROM referrals WHERE referrer_id = ? AND status = 'qualified'").get(referrerId)).c;
  const row = await db.prepare('SELECT referral_rewards_granted FROM users WHERE id = ?').get(referrerId);
  const already = row ? (row.referral_rewards_granted | 0) : 0;
  const due = Math.floor(qcount / REWARD_EVERY);
  if (due > already) {
    for (let i = 0; i < due - already; i++) await extendTier(referrerId, REWARD_TIER, REWARD_DAYS, 'referral_reward');
    await db.prepare('UPDATE users SET referral_rewards_granted = ? WHERE id = ?').run(due, referrerId);
    logger.info({ referrerId, monthsGranted: due - already, totalQualified: qcount }, 'referral reward granted');
  }
  return due;
}

// Scan pending referrals, qualify the ones that now meet the bar, pay rewards.
async function processReferrals() {
  const pending = await db.prepare("SELECT * FROM referrals WHERE status = 'pending'").all();
  const affected = new Set();
  let qualified = 0;
  for (const r of pending) {
    if (await inviteeQualifies(r.invitee_id, r.referrer_id)) {
      await db.prepare("UPDATE referrals SET status = 'qualified', qualified_at = datetime('now') WHERE id = ?").run(r.id);
      affected.add(r.referrer_id);
      qualified++;
    }
  }
  for (const refId of affected) await payRewards(refId);
  if (qualified) logger.info({ qualified, referrers: affected.size }, 'referrals qualified');
  return { qualified, referrers: affected.size };
}

function inviterBadge(qualifiedCount) {
  if (qualifiedCount >= 100) return 'gold';
  if (qualifiedCount >= 25) return 'silver';
  if (qualifiedCount >= 5) return 'bronze';
  return null;
}

async function statsFor(userId) {
  const code = await ensureCode(userId);
  const qualified = (await db.prepare("SELECT COUNT(*) c FROM referrals WHERE referrer_id = ? AND status = 'qualified'").get(userId)).c;
  const pending = (await db.prepare("SELECT COUNT(*) c FROM referrals WHERE referrer_id = ? AND status = 'pending'").get(userId)).c;
  const row = await db.prepare('SELECT referral_rewards_granted FROM users WHERE id = ?').get(userId);
  return {
    code,
    qualified,
    pending,
    monthsEarned: row ? (row.referral_rewards_granted | 0) : 0,
    rewardEvery: REWARD_EVERY,
    toNextReward: REWARD_EVERY - (qualified % REWARD_EVERY),
    qualifyDays: QUALIFY_AGE_DAYS,
    badge: inviterBadge(qualified),
  };
}

async function leaderboard(limit) {
  return db.prepare(
    "SELECT u.id, u.name, u.avatar, u.supporter_tier, u.supporter_expires, COUNT(r.id) qualified " +
    "FROM referrals r JOIN users u ON u.id = r.referrer_id " +
    "WHERE r.status = 'qualified' GROUP BY r.referrer_id ORDER BY qualified DESC, u.id ASC LIMIT ?"
  ).all(Math.max(1, Math.min(100, limit || 10)));
}

let timer = null;
function startReferralJobs() {
  if (process.env.REFERRAL_JOB === '0') { logger.info('referral background job disabled'); return; }
  if (timer) return;
  const everyMs = Math.max(60000, Number(process.env.REFERRAL_JOB_MS || 60 * 60 * 1000)); // hourly
  timer = setInterval(() => { processReferrals().catch((e) => logger.error({ err: e }, 'referral job failed')); }, everyMs);
  if (timer.unref) timer.unref();
  const t = setTimeout(() => { processReferrals().catch(() => {}); }, 90000); // first pass ~90s after boot
  if (t.unref) t.unref();
  logger.info({ everyMs }, 'referral background job started');
}

module.exports = {
  genCode, ensureCode, userByCode, attachReferral, inviteeQualifies,
  payRewards, processReferrals, statsFor, leaderboard, inviterBadge, startReferralJobs,
  QUALIFY_AGE_DAYS, QUALIFY_MIN_CONTRIB, REWARD_EVERY, REWARD_TIER, REWARD_DAYS,
};
