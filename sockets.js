// sockets.js
// Real time chat over Socket.IO. Each connected user joins a private room
// named "user:<id>" so we can deliver messages straight to them.

const cookie = require('cookie');
const db = require('./db');
const { userFromToken, COOKIE_NAME } = require('./auth');
const presence = require('./presence');

function initSockets(io) {
  io.on('connection', (socket) => {
    // Authenticate the socket using the same session cookie as the web app.
    const raw = socket.handshake.headers.cookie || '';
    const parsed = cookie.parse(raw);
    const user = userFromToken(parsed[COOKIE_NAME]);
    if (!user) {
      socket.disconnect(true);
      return;
    }

    socket.userId = user.id;
    socket.join('user:' + user.id);

    // Presence: track this connection. If the user just came online, tell everyone
    // so contacts lists can flip the dot to green in real time. (Broadcasting to
    // all is fine at this scale; clients ignore ids not in their contacts.)
    if (presence.markOnline(user.id)) io.emit('presence', { userId: user.id, online: true });

    socket.on('disconnect', () => {
      if (presence.markOffline(user.id)) io.emit('presence', { userId: user.id, online: false });
    });

    // Send a direct message to another user.
    socket.on('message:send', (data, ack) => {
      try {
        const to = Number(data && data.to);
        const content = ((data && data.content) || '').toString().trim();
        if (!to || !content) {
          if (typeof ack === 'function') ack({ error: 'Invalid message' });
          return;
        }
        // Soft email gate also applies to chat (re-checked live, not at connect).
        const sender = db.prepare('SELECT email_verified FROM users WHERE id = ?').get(user.id);
        if (!sender || !sender.email_verified) {
          if (typeof ack === 'function') ack({ error: 'Verify your email to send messages.' });
          return;
        }
        const recipient = db.prepare('SELECT id FROM users WHERE id = ?').get(to);
        if (!recipient) {
          if (typeof ack === 'function') ack({ error: 'User not found' });
          return;
        }

        const info = db
          .prepare('INSERT INTO messages (sender_id, recipient_id, content) VALUES (?, ?, ?)')
          .run(user.id, to, content);
        const m = db.prepare('SELECT * FROM messages WHERE id = ?').get(info.lastInsertRowid);

        const base = {
          id: m.id,
          content: m.content,
          created_at: m.created_at,
          sender_id: m.sender_id,
          recipient_id: m.recipient_id,
        };
        // The recipient sees it as not theirs, the sender sees it as theirs.
        io.to('user:' + to).emit('message:new', { ...base, mine: false });
        socket.emit('message:new', { ...base, mine: true });
        if (typeof ack === 'function') ack({ ok: true, message: { ...base, mine: true } });
      } catch (e) {
        // A failed send must never crash the server for every other user.
        console.error('[socket message:send]', e.message);
        if (typeof ack === 'function') ack({ error: 'Could not send the message' });
      }
    });

    // Mark messages from a given user as read. Used when the recipient is
    // already viewing that conversation as a new message arrives live.
    socket.on('message:read', (data, ack) => {
      try {
        const from = Number(data && data.from);
        if (from) {
          db.prepare('UPDATE messages SET is_read = 1 WHERE sender_id = ? AND recipient_id = ?').run(from, user.id);
        }
      } catch (e) {
        console.error('[socket message:read]', e.message);
      }
      if (typeof ack === 'function') ack({ ok: true });
    });

    // Lightweight typing indicator.
    socket.on('typing', (data) => {
      try {
        const to = Number(data && data.to);
        if (to) io.to('user:' + to).emit('typing', { from: user.id });
      } catch (e) {
        console.error('[socket typing]', e.message);
      }
    });

    // Swallow socket-level errors so they can never bubble up and crash the process.
    socket.on('error', (e) => console.error('[socket error]', e && e.message));
  });
}

module.exports = { initSockets };
