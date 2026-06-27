// trust.js
// Phase 0 reputation engine scaffolding (see SPEC.md sections 2-5).
//
// The core rule of OpenBook: downvotes affect ranking, only confirmed rule
// violations affect standing, and the shadowban is driven by standing, never by
// raw votes. So we keep two separate scores:
//   - karma:    social score from up/down votes. Drives ranking ONLY. May be
//               negative. Never hides content. (Voting arrives in Phase 1.)
//   - standing: trust/safety score. Drives privileges and the shadowban via a
//               reach_score multiplier applied at ranking time.
// Every change to either score is written to trust_events for a full,
// auditable, appealable trail.
//
// recordStandingEvent, recordKarmaEvent and refreshTrustLevel write to the
// (networked) database and are async; the pure helpers (reachFromStanding,
// computeTrustLevel, trustSnapshot) stay synchronous.

const db = require('./db');

const STANDING_BASELINE = 100; // new accounts start here
const QUARANTINE_AT = 50;      // below this, reach is reduced
const FLOOR_AT = 10;           // below this, effectively shadowbanned

// Map a standing value to a reach multiplier (1.0 normal .. 0.05 shadowban).
function reachFromStanding(standing) {
  if (standing >= QUARANTINE_AT) return 1.0;
  if (standing >= FLOOR_AT) return 0.5;
  return 0.05;
}

// Record a change to a user's standing and update their reach_score.
async function recordStandingEvent(userId, delta, cause) {
  await db.prepare('INSERT INTO trust_events (user_id, score, delta, cause) VALUES (?, ?, ?, ?)')
    .run(userId, 'standing', delta, cause);
  const u = await db.prepare('SELECT standing FROM users WHERE id = ?').get(userId);
  if (!u) return null;
  // Clamp at zero so standing can never be driven negative (reach already floors
  // at the FLOOR_AT threshold). No upper clamp, so future positive signals can
  // still raise standing above the baseline.
  const standing = Math.max(0, u.standing + delta);
  const reach = reachFromStanding(standing);
  await db.prepare('UPDATE users SET standing = ?, reach_score = ? WHERE id = ?').run(standing, reach, userId);
  return { standing, reach_score: reach };
}

// Record a change to a user's karma (the votes table is the source of truth in
// Phase 1; this keeps the running total and the audit trail in sync).
async function recordKarmaEvent(userId, delta, cause) {
  await db.prepare('INSERT INTO trust_events (user_id, score, delta, cause) VALUES (?, ?, ?, ?)')
    .run(userId, 'karma', delta, cause);
  await db.prepare('UPDATE users SET karma = karma + ? WHERE id = ?').run(delta, userId);
}

// Parse the SQLite UTC timestamp safely.
function parseTime(ts) {
  if (!ts) return new Date();
  return new Date(ts.indexOf('T') >= 0 ? ts : ts.replace(' ', 'T') + 'Z');
}

// Trust level TL0..TL4 from account age plus clean standing. Discourse-style:
// privileges unlock with age and good behaviour, never with money or ID.
// Refined in later phases (clean-activity history, verified contact, etc.).
function computeTrustLevel(user) {
  if (user.standing < QUARANTINE_AT) return 0; // poor standing pins you at TL0
  const ageDays = (Date.now() - parseTime(user.created_at).getTime()) / 86400000;
  if (ageDays >= 30) return 3;
  if (ageDays >= 7) return 2;
  if (ageDays >= 1) return 1;
  return 0;
}

// Recompute and persist a user's trust level. Safe to call on activity.
async function refreshTrustLevel(userId) {
  const u = await db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!u) return 0;
  const tl = computeTrustLevel(u);
  if (tl !== u.trust_level) await db.prepare('UPDATE users SET trust_level = ? WHERE id = ?').run(tl, userId);
  return tl;
}

// The self-facing trust snapshot returned to a logged-in user. It deliberately
// OMITS reach_score: the graduated shadowban must be silent, so even the account
// owner must not be able to read their own reach multiplier (SPEC section 4,
// "no obvious tell"). reach_score stays server-side, used only at ranking time.
function trustSnapshot(user) {
  return {
    karma: user.karma || 0,
    standing: user.standing == null ? STANDING_BASELINE : user.standing,
    trustLevel: user.trust_level || 0,
  };
}

module.exports = {
  STANDING_BASELINE,
  QUARANTINE_AT,
  FLOOR_AT,
  reachFromStanding,
  recordStandingEvent,
  recordKarmaEvent,
  computeTrustLevel,
  refreshTrustLevel,
  trustSnapshot,
};
