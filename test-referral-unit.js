// Referral system isolated logic test (throwaway DB).
// Covers code generation, attachReferral (+ self-referral guard), the 30-day
// real-human qualification gate (age, activity, standing, distinct device),
// processReferrals, the every-5 -> 1 free Premium month reward (idempotent),
// stats, and the credible-neutrality guardrail (reward never moves karma/standing).

const os = require('os'); const fs = require('fs'); const path = require('path');
const tmp = path.join(os.tmpdir(), 'ob_ref_' + Date.now());
fs.mkdirSync(tmp, { recursive: true });
process.env.DATA_DIR = tmp; process.env.SYBIL_JOB = '0'; process.env.REFERRAL_JOB = '0'; process.env.LOG_LEVEL = 'silent';
delete process.env.ADMIN_EMAILS;

const ref = require('./referrals');
const ent = require('./entitlements');
const as = require('./antisybil');
const db = require('./db');

let pass = 0, fail = 0;
function check(n, c) { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n); } }

function mkUser(name, email, opts) {
  opts = opts || {};
  const created = opts.ageDays ? "datetime('now','-" + (opts.ageDays | 0) + " days')" : "datetime('now')";
  const info = db.prepare(
    "INSERT INTO users (name,email,password_hash,standing,created_at) VALUES (?,?,?,?, " + created + ")"
  ).run(name, email, 'h', opts.standing == null ? 100 : opts.standing);
  return info.lastInsertRowid;
}
function addPosts(uid, n) { for (let i = 0; i < n; i++) db.prepare("INSERT INTO posts (user_id, content) VALUES (?, ?)").run(uid, 'p' + i); }

// Referrer with a distinct device
const R = mkUser('Ref', 'r@x.com');
as.recordDevice(R, '10.0.0.1', 'fpR');
const code = ref.ensureCode(R);
check('referrer gets a referral code', !!code && code.length >= 4);
check('ensureCode is stable', ref.ensureCode(R) === code);

// Self-referral is rejected
check('self-referral rejected', ref.attachReferral(R, code) === false);

// A fresh invitee via the code
const I1 = mkUser('Inv1', 'i1@x.com');
as.recordDevice(I1, '10.0.0.2', 'fpI1');
check('attachReferral on valid code works', ref.attachReferral(I1, code) === true);
check('invitee.referred_by set', db.prepare('SELECT referred_by FROM users WHERE id=?').get(I1).referred_by === R);
check('pending referral row created', db.prepare("SELECT status FROM referrals WHERE invitee_id=?").get(I1).status === 'pending');
check('fresh invitee does NOT qualify (too new, no activity)', ref.inviteeQualifies(I1, R) === false);

// Make a fully-qualifying invitee: 31 days old, 5 posts, healthy, distinct device
function qualifyingInvitee(name, email, fp) {
  const id = mkUser(name, email, { ageDays: 31, standing: 100 });
  as.recordDevice(id, '10.0.0.9', fp);
  addPosts(id, 5);
  ref.attachReferral(id, code);
  return id;
}
const Q1 = qualifyingInvitee('Q1', 'q1@x.com', 'fpQ1');
check('aged + active + distinct invitee qualifies', ref.inviteeQualifies(Q1, R) === true);

// Shared-device invitee must NOT qualify (anti self-referral ring)
const S = mkUser('Shared', 's@x.com', { ageDays: 31, standing: 100 });
as.recordDevice(S, '10.0.0.1', 'fpR'); // SAME fingerprint as referrer
addPosts(S, 5);
ref.attachReferral(S, code);
check('shared-device invitee blocked', ref.inviteeQualifies(S, R) === false);

// Quarantined invitee must NOT qualify
const QB = mkUser('Quar', 'qb@x.com', { ageDays: 31, standing: 10 });
as.recordDevice(QB, '10.0.0.8', 'fpQB');
addPosts(QB, 5);
ref.attachReferral(QB, code);
check('quarantined invitee blocked', ref.inviteeQualifies(QB, R) === false);

// Build up to 5 qualifying invitees total (Q1 + four more), then process
for (let i = 2; i <= 5; i++) qualifyingInvitee('Q' + i, 'q' + i + '@x.com', 'fpQ' + i);
const before = db.prepare('SELECT karma, standing FROM users WHERE id=?').get(R);
const result = ref.processReferrals();
check('processReferrals qualified the 5 aged+active invitees', result.qualified === 5);
const stats = ref.statsFor(R);
check('5 qualified counted', stats.qualified === 5);
check('1 free month earned at 5', stats.monthsEarned === 1);
check('referrer now effective Premium (tier 3)', ent.effectiveTier(db.prepare('SELECT * FROM users WHERE id=?').get(R)) === 3);
check('inviter badge bronze at 5', stats.badge === 'bronze');
check('toNextReward resets to 5', stats.toNextReward === 5);

// GUARDRAIL: reward did not touch karma/standing
const after = db.prepare('SELECT karma, standing FROM users WHERE id=?').get(R);
check('GUARDRAIL: reward did not change karma', after.karma === before.karma);
check('GUARDRAIL: reward did not change standing', after.standing === before.standing);

// Idempotent: running again does not double-grant
ref.processReferrals();
check('no double reward on re-run', ref.statsFor(R).monthsEarned === 1);

// Reward extends, not shortens: granting another 5 should add a 2nd month (later expiry)
const expEarly = db.prepare('SELECT supporter_expires FROM users WHERE id=?').get(R).supporter_expires;
for (let i = 6; i <= 10; i++) qualifyingInvitee('Q' + i, 'q' + i + '@x.com', 'fpQ' + i);
ref.processReferrals();
const s2 = ref.statsFor(R);
check('10 qualified -> 2 months earned', s2.monthsEarned === 2);
const expLater = db.prepare('SELECT supporter_expires FROM users WHERE id=?').get(R).supporter_expires;
check('2nd reward EXTENDED expiry (later, not shorter)', Date.parse(expLater.replace(' ', 'T') + 'Z') > Date.parse(expEarly.replace(' ', 'T') + 'Z'));

// leaderboard
const lb = ref.leaderboard(10);
check('leaderboard lists the referrer with 10 qualified', lb.length >= 1 && lb[0].qualified === 10);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);
