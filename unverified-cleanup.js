// unverified-cleanup.js
// Removes accounts that signed up with an email they never verified. If a member
// does not click the verification link within the grace window (default 24 hours),
// the account and all of its data are permanently deleted, using the exact same
// erasure as the owner "delete my account" route.
//
// SAFETY: this only ever runs while email verification is actually ENFORCED
// (EMAIL_CONFIGURED + REQUIRE_EMAIL_VERIFICATION). When verification is off, new
// signups are auto-verified, so a verified=0 row would be a harmless legacy artifact
// that must NOT be deleted. Privileged and sentinel accounts are always excluded.
// Set UNVERIFIED_CLEANUP=0 to disable entirely.

const db = require('./db');
const { logger } = require('./logger');
const { EMAIL_CONFIGURED } = require('./mailer');

// Verification is only enforced (and thus accounts only land unverified) when both
// a mail provider is configured AND REQUIRE_EMAIL_VERIFICATION is on.
function enforcementOn() {
  return !!EMAIL_CONFIGURED && process.env.REQUIRE_EMAIL_VERIFICATION === '1';
}

function graceHours() {
  const h = Number(process.env.UNVERIFIED_GRACE_HOURS);
  return h && h > 0 ? h : 24;
}

async function sweepUnverified() {
  if (process.env.UNVERIFIED_CLEANUP === '0') return 0; // kill switch
  if (!enforcementOn()) return 0;                       // never delete when verification is not enforced
  const hours = graceHours();
  let rows = [];
  try {
    rows = await db.prepare(
      'SELECT id FROM users ' +
      'WHERE email_verified = 0 ' +
      "AND created_at < datetime('now', ?) " +
      'AND is_admin = 0 AND is_founder = 0 AND is_official = 0 ' +
      "AND email NOT IN ('ghost@deleted.openbook.local', 'system@openbook.local')"
    ).all('-' + hours + ' hours');
  } catch (e) {
    logger.warn({ err: e }, 'unverified sweep query failed');
    return 0;
  }
  if (!rows.length) return 0;

  // Lazy require avoids any load-order cycle (routes/users.js pulls in a lot).
  const deleteUserCompletely = require('./routes/users').deleteUserCompletely;
  let removed = 0;
  for (const r of rows) {
    try {
      await deleteUserCompletely(r.id, 'Email was never verified within the grace window; account auto-removed.');
      removed++;
    } catch (e) {
      logger.warn({ err: e, userId: r.id }, 'unverified account delete failed');
    }
  }
  if (removed) logger.info({ removed, graceHours: hours }, 'removed unverified accounts past the grace window');
  return removed;
}

let timer = null;
function startUnverifiedCleanupJob() {
  if (timer) return;
  const everyMs = Number(process.env.UNVERIFIED_CLEANUP_MS || 3600000); // hourly
  // Delay the first sweep so boot stays light and the first run is clearly logged.
  setTimeout(() => {
    sweepUnverified().catch((e) => logger.error({ err: e }, 'initial unverified sweep failed'));
  }, 60000);
  timer = setInterval(() => {
    sweepUnverified().catch((e) => logger.error({ err: e }, 'unverified cleanup failed'));
  }, everyMs);
  if (timer.unref) timer.unref();
  logger.info({ everyMs, graceHours: graceHours(), enforcement: enforcementOn() }, 'unverified-account cleanup job started');
}

module.exports = { sweepUnverified, startUnverifiedCleanupJob, graceHours, enforcementOn };
