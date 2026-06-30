// welcome.js
// The one-time "Welcome to OpenBook" direct message every member receives from the
// official OpenBook account, plus a matching bell notification. New signups get it
// at signup; existing members are backfilled once at boot. It is idempotent: a
// member is welcomed exactly once, guarded by the users.welcomed flag with an
// atomic claim, so a restart or a repeat call can never spam anyone.

const db = require('./db');
const { systemUserId } = require('./moderation');
const { notify } = require('./notify');
const { logger } = require('./logger');

let ioRef = null;
// Called once from server.js after Socket.IO is created, so an online member gets
// the welcome live; a brand-new signup is not connected yet and sees it on first load.
function setIO(io) { ioRef = io; }

// The message body. Plain text on purpose: it reads well in the conversation list
// preview and as a normal chat bubble, and the in-app onboarding buttons are added
// by the client (it recognises the official OpenBook thread). No em or en dashes.
const WELCOME_TEXT =
  'Welcome to OpenBook! 🎉\n\n' +
  'We are a different kind of social network: no ads, no data selling, and money can ' +
  'never buy reach, karma, or a louder vote. You are the user here, not the product, ' +
  'and the whole platform is open source and steered in the open, together with you.\n\n' +
  'Use the Get started buttons in this chat to take your first steps: claim your ' +
  '@username before someone else does, write your first post so people can vote it up ' +
  'and you start earning karma and account standing, invite friends (every 5 friends ' +
  'who join unlock Premium for you), share an idea in the Suggestions box, start or ' +
  'join a community, and, if you would like to, support the cause so we can stay ' +
  'ad-free and independent.\n\n' +
  'We are genuinely glad you are here.\n- The OpenBook team';

// Send the welcome to one user, exactly once. Returns true only if it sent now.
async function sendWelcome(userId) {
  try {
    const sysId = await systemUserId();
    if (!userId || userId === sysId) return false; // never welcome the system actor itself
    // Atomic claim: only the first caller to flip welcomed 0 -> 1 proceeds. This
    // makes concurrent signups / a repeated backfill safe (exactly one message).
    const claim = await db.prepare('UPDATE users SET welcomed = 1 WHERE id = ? AND welcomed = 0').run(userId);
    if (!claim.changes) return false; // already welcomed, or no such user

    // The message is the one side effect we must not silently lose. If inserting it
    // fails (a transient db error), RELEASE the claim so a later boot backfill retries
    // this member. The insert failed, so that retry cannot create a duplicate.
    try {
      await db.prepare('INSERT INTO messages (sender_id, recipient_id, content) VALUES (?, ?, ?)')
        .run(sysId, userId, WELCOME_TEXT);
    } catch (e) {
      try { await db.prepare('UPDATE users SET welcomed = 0 WHERE id = ?').run(userId); } catch (_) {}
      try { logger.warn({ err: e, userId }, 'welcome message insert failed; released the claim to retry'); } catch (_) {}
      return false;
    }

    // From here the welcome message exists and the claim MUST stay (releasing it now
    // would duplicate the message on a retry). The bell notification and the live
    // ping are best-effort: a failure in either never un-welcomes the member.
    try { await notify(userId, sysId, 'welcome'); } catch (_) {}
    try {
      if (ioRef) {
        const m = await db.prepare(
          'SELECT * FROM messages WHERE sender_id = ? AND recipient_id = ? ORDER BY id DESC LIMIT 1'
        ).get(sysId, userId);
        if (m) ioRef.to('user:' + userId).emit('message:new', {
          id: m.id, content: m.content, created_at: m.created_at,
          sender_id: sysId, recipient_id: userId, mine: false,
        });
      }
    } catch (_) {}
    return true;
  } catch (e) {
    try { logger.warn({ err: e, userId }, 'sendWelcome failed'); } catch (_) {}
    return false;
  }
}

// Backfill every existing member who has not been welcomed yet. Run once at boot.
// The system + ghost sentinel accounts are marked welcomed at boot (see db.js), so
// the welcomed = 0 filter naturally skips them. Idempotent across restarts.
async function backfillWelcomes() {
  try {
    const sysId = await systemUserId(); // make sure the official account exists first
    const rows = await db.prepare('SELECT id FROM users WHERE welcomed = 0 AND id != ?').all(sysId);
    let sent = 0;
    for (const r of rows) { if (await sendWelcome(r.id)) sent++; }
    if (sent) { try { logger.info({ sent }, 'backfilled OpenBook welcome messages'); } catch (_) {} }
    return sent;
  } catch (e) {
    try { logger.warn({ err: e }, 'backfillWelcomes failed'); } catch (_) {}
    return 0;
  }
}

module.exports = { sendWelcome, backfillWelcomes, setIO, WELCOME_TEXT };
