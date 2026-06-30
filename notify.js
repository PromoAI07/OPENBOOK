// notify.js
// Creates notification rows and, when possible, pushes a live update to the
// recipient over Socket.IO so the bell badge updates without a refresh.
//
// notify() writes to the networked database and is async. It is often called
// fire-and-forget from a route, so its body is wrapped: a notification failure
// must never break the action that triggered it.

const db = require('./db');

let ioRef = null;

// Called once from server.js after Socket.IO is created.
function setIO(io) {
  ioRef = io;
}

// type is one of: 'like', 'reaction', 'comment', 'mention', 'friend_request',
// 'friend_accept', 'follow', 'welcome', 'escrow_update', 'mod_removed', 'mod_restored',
// 'jury_duty'
async function notify(userId, actorId, type, postId = null) {
  if (userId === actorId) return; // never notify yourself
  try {
    await db.prepare(
      'INSERT INTO notifications (user_id, actor_id, type, post_id) VALUES (?, ?, ?, ?)'
    ).run(userId, actorId, type, postId);

    if (ioRef) {
      const row = await db
        .prepare('SELECT COUNT(*) c FROM notifications WHERE user_id = ? AND is_read = 0')
        .get(userId);
      ioRef.to('user:' + userId).emit('notification:new', { count: row.c });
    }
  } catch (e) { /* best-effort; never break the triggering action */ }
}

module.exports = { notify, setIO };
