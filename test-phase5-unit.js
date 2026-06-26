// Phase 5 isolated logic test. Runs against a throwaway database in the temp
// folder (set via DATA_DIR before db.js loads) so it never touches dev data.
// Covers: disposable email, proof-of-work, downvote gate, trust-scaled rate
// limits, device/IP signals, sybil flags, vote-ring detection + auto-action,
// and a re-check of the Phase 0-2 trust/ranking math.

const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const tmp = path.join(os.tmpdir(), 'ob_p5_' + Date.now());
fs.mkdirSync(tmp, { recursive: true });
process.env.DATA_DIR = tmp;
process.env.SYBIL_JOB = '0';            // no background timers in the test
process.env.LOG_LEVEL = 'silent';       // keep output clean
delete process.env.ADMIN_EMAILS;

const as = require('./antisybil');
const trust = require('./trust');
const ranking = require('./ranking');
const db = require('./db');

let pass = 0, fail = 0;
function check(name, cond) { if (cond) { pass++; console.log('PASS ' + name); } else { fail++; console.log('FAIL ' + name); } }
function solve(salt, diff) { let n = 0; const p = '0'.repeat(diff); for (;;) { if (crypto.createHash('sha256').update(salt + ':' + n).digest('hex').startsWith(p)) return String(n); n++; } }

// 1. Disposable email gate
check('disposable domain blocked', as.isDisposableEmail('a@mailinator.com') === true);
check('real domain allowed', as.isDisposableEmail('a@gmail.com') === false);
check('emailDomain lowercases', as.emailDomain('A@Example.COM') === 'example.com');

// 2. Proof of work
const ch = as.makeChallenge();
check('challenge issued', !!ch.salt && ch.difficulty >= 1 && ch.enabled === true);
const nonce = solve(ch.salt, ch.difficulty);
check('valid PoW accepted', as.verifyPoW(ch.salt, nonce) === true);
check('replay rejected', as.verifyPoW(ch.salt, nonce) === false);
const ch2 = as.makeChallenge();
check('wrong nonce rejected', as.verifyPoW(ch2.salt, 'nope') === false);
check('forged salt rejected', as.verifyPoW('123.abc.deadbeefdeadbeef', '0') === false);

// 3. Downvote gate
check('TL0 cannot downvote', as.canDownvote(0) === false);
check('TL1 can downvote', as.canDownvote(1) === true);
check('MIN_DOWNVOTE_TL default 1', as.MIN_DOWNVOTE_TL === 1);

// 4. Trust-scaled rate limits
let allowed = 0;
for (let i = 0; i < 6; i++) if (as.checkRate(900001, 'post', 0).ok) allowed++;
check('TL0 post cap: 6 allowed', allowed === 6);
check('TL0 post cap: 7th blocked (429)', as.checkRate(900001, 'post', 0).ok === false);
let allowed3 = 0;
for (let i = 0; i < 60; i++) if (as.checkRate(900002, 'post', 3).ok) allowed3++;
check('TL3 post cap generous (60 ok)', allowed3 === 60);
check('comment cap separate from post', as.checkRate(900001, 'comment', 0).ok === true);

// helper to insert a user with explicit fields
function mkUser(name, email, opts) {
  opts = opts || {};
  const info = db.prepare("INSERT INTO users (name,email,password_hash,standing,trust_level) VALUES (?,?,?,?,?)")
    .run(name, email, 'h', opts.standing == null ? 100 : opts.standing, opts.tl == null ? 0 : opts.tl);
  return info.lastInsertRowid;
}

// 5. Device + IP signals and flag dedupe
const u1 = mkUser('U1', 'u1@real.com');
const u2 = mkUser('U2', 'u2@real.com');
as.recordDevice(u1, '1.2.3.4', 'fpAAA');
as.recordDevice(u2, '1.2.3.4', 'fpAAA');
as.recordDevice(u1, '1.2.3.4', 'fpAAA'); // idempotent (same user+fp)
check('2 accounts on shared fingerprint', as.accountsOnFingerprint('fpAAA') === 2);
check('2 accounts on shared IP', as.accountsOnIp('1.2.3.4') === 2);
check('flagUser writes new flag', as.flagUser(u1, 'test', 'd', 1) === true);
check('flagUser dedupes within 24h', as.flagUser(u1, 'test', 'd', 1) === false);

// 6. Vote-ring detection + conservative auto-action
const ringA = mkUser('RingA', 'ra@real.com', { tl: 0, standing: 100 });
const ringB = mkUser('RingB', 'rb@real.com', { tl: 0, standing: 100 });
const outsider = mkUser('Solo', 'solo@real.com', { tl: 0, standing: 100 });
for (let t = 1; t <= 6; t++) {
  db.prepare("INSERT INTO votes (user_id,target_type,target_id,value,weight) VALUES (?,?,?,1,0.1)").run(ringA, 'post', t);
  db.prepare("INSERT INTO votes (user_id,target_type,target_id,value,weight) VALUES (?,?,?,1,0.1)").run(ringB, 'post', t);
}
db.prepare("INSERT INTO votes (user_id,target_type,target_id,value,weight) VALUES (?,?,?,1,0.1)").run(outsider, 'post', 99);
const found = as.detectVoteRings({ lookbackHours: 72, minShared: 5, burstHours: 48, maxTl: 1 });
const hitPair = found.some((p) => (p.a === ringA && p.b === ringB) || (p.a === ringB && p.b === ringA));
check('vote ring detected', hitPair);
check('outsider not flagged as a pair', !found.some((p) => p.a === outsider || p.b === outsider));
const acted = as.actOnRing(found);
check('ring auto-action applied', acted >= 2);
const sA = db.prepare('SELECT standing FROM users WHERE id=?').get(ringA).standing;
check('ring standing nudged down', sA < 100);
check('suspicion never floors below quarantine', sA >= trust.QUARANTINE_AT);
const flagRows = db.prepare("SELECT COUNT(*) n FROM sybil_flags WHERE kind='vote_ring'").get().n;
check('vote_ring flags recorded', flagRows >= 2);
const ev = db.prepare("SELECT COUNT(*) n FROM trust_events WHERE cause='sybil_ring_suspected'").get().n;
check('standing nudge is in the audit trail', ev >= 2);

// 7. Phase 0-2 math sanity (make sure nothing regressed)
check('reach: floor -> 0.05', trust.reachFromStanding(5) === 0.05);
check('reach: quarantine -> 0.5', trust.reachFromStanding(30) === 0.5);
check('reach: healthy -> 1.0', trust.reachFromStanding(100) === 1.0);
check('vote weight TL0 small', ranking.trustWeight(0) === 0.1);
check('vote weight TL3 full', ranking.trustWeight(3) === 1.0);
check('wilson 0 votes = 0', ranking.wilson(0, 0) === 0);
check('wilson rewards volume', ranking.wilson(20, 0) > ranking.wilson(1, 0));
check('controversy: balanced beats one-sided', ranking.controversy(10, 10) > ranking.controversy(19, 1));
check('hot: newer wins at equal score', ranking.hot(5, 0, '2026-01-02 00:00:00') > ranking.hot(5, 0, '2026-01-01 00:00:00'));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);
