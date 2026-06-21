// notify.js
// Creates notification rows and, when possible, pushes a live update to the
// recipient over Socket.IO so the bell badge updates without a refresh.

const db = require('./db');

let ioRef = null;

// Called once from server.js after Socket.IO is created.
function setIO(io) {
  ioRef = io;
}

// type is one of: 'like', 'comment', 'friend_request', 'friend_accept'
function notify(userId, actorId, type, postId = null) {
  if (userId === actorId) return; // never notify yourself
  db.prepare(
    'INSERT INTO notifications (user_id, actor_id, type, post_id) VALUES (?, ?, ?, ?)'
  ).run(userId, actorId, type, postId);

  if (ioRef) {
    const count = db
      .prepare('SELECT COUNT(*) c FROM notifications WHERE user_id = ? AND is_read = 0')
      .get(userId).c;
    ioRef.to('user:' + userId).emit('notification:new', { count });
  }
}

module.exports = { notify, setIO };
