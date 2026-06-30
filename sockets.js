// sockets.js
// Real time chat over Socket.IO. Each connected user joins a private room
// named "user:<id>" so we can deliver messages straight to them.
//
// Auth and message persistence hit the networked database, so the connection
// handler and the message events are async. Each handler keeps its own try/catch
// so a database hiccup can never crash the process for every other user.

const cookie = require('cookie');
const db = require('./db');
const { userFromToken, COOKIE_NAME } = require('./auth');
const presence = require('./presence');

// Cap on a single message's length, applied to both sending and editing so an
// edited message cannot balloon past what could be sent in the first place.
const MAX_MSG_LEN = 5000;

// Notify only a user's accepted friends (the people whose contacts list shows
// their dot) when they come online or go offline, by emitting to each friend's
// private "user:<id>" room. This replaces a global io.emit broadcast, which sent
// every connect/disconnect to EVERY connected socket (O(users) per event).
// Offline friends pick up fresh state from the contacts API on their next load.
// Fire-and-forget with its own try/catch so a presence hiccup never disturbs the
// connection.
async function emitPresenceToFriends(io, userId, online) {
  try {
    const rows = await db.prepare(
      `SELECT CASE WHEN requester_id = ? THEN addressee_id ELSE requester_id END AS fid
       FROM friendships
       WHERE status = 'accepted' AND (requester_id = ? OR addressee_id = ?)`
    ).all(userId, userId, userId);
    for (const r of rows) io.to('user:' + r.fid).emit('presence', { userId, online });
  } catch (e) {
    console.error('[socket presence]', e && e.message);
  }
}

function initSockets(io) {
  io.on('connection', async (socket) => {
    // Authenticate the socket using the same session cookie as the web app.
    let user = null;
    try {
      const raw = socket.handshake.headers.cookie || '';
      const parsed = cookie.parse(raw);
      user = await userFromToken(parsed[COOKIE_NAME]);
    } catch (e) {
      user = null;
    }
    if (!user) {
      socket.disconnect(true);
      return;
    }

    socket.userId = user.id;
    socket.join('user:' + user.id);

    // Presence: track this connection. If the user just came online, tell ONLY
    // their friends (whose contacts list shows their dot) so it flips green in
    // real time, instead of broadcasting to every connected socket.
    if (presence.markOnline(user.id)) emitPresenceToFriends(io, user.id, true);

    socket.on('disconnect', () => {
      if (presence.markOffline(user.id)) emitPresenceToFriends(io, user.id, false);
    });

    // Send a direct message to another user.
    socket.on('message:send', async (data, ack) => {
      try {
        const to = Number(data && data.to);
        const content = ((data && data.content) || '').toString().trim();
        if (!to || !content) {
          if (typeof ack === 'function') ack({ error: 'Invalid message' });
          return;
        }
        if (content.length > MAX_MSG_LEN) {
          if (typeof ack === 'function') ack({ error: 'Message is too long.' });
          return;
        }
        // Soft email gate also applies to chat (re-checked live, not at connect).
        const sender = await db.prepare('SELECT email_verified FROM users WHERE id = ?').get(user.id);
        if (!sender || !sender.email_verified) {
          if (typeof ack === 'function') ack({ error: 'Verify your email to send messages.' });
          return;
        }
        const recipient = await db.prepare('SELECT id FROM users WHERE id = ?').get(to);
        if (!recipient) {
          if (typeof ack === 'function') ack({ error: 'User not found' });
          return;
        }

        const info = await db
          .prepare('INSERT INTO messages (sender_id, recipient_id, content) VALUES (?, ?, ?)')
          .run(user.id, to, content);
        const m = await db.prepare('SELECT * FROM messages WHERE id = ?').get(info.lastInsertRowid);

        const base = {
          id: m.id,
          content: m.content,
          created_at: m.created_at,
          sender_id: m.sender_id,
          recipient_id: m.recipient_id,
          edited: !!m.edited,
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
    socket.on('message:read', async (data, ack) => {
      try {
        const from = Number(data && data.from);
        if (from) {
          await db.prepare('UPDATE messages SET is_read = 1 WHERE sender_id = ? AND recipient_id = ?').run(from, user.id);
        }
      } catch (e) {
        console.error('[socket message:read]', e.message);
      }
      if (typeof ack === 'function') ack({ ok: true });
    });

    // Edit a message you sent. Only the author can edit it; both sides get the new
    // text live and an "edited" mark. The content is re-validated and trimmed.
    socket.on('message:edit', async (data, ack) => {
      try {
        const id = Number(data && data.id);
        const content = ((data && data.content) || '').toString().trim();
        if (!id || !content) { if (typeof ack === 'function') ack({ error: 'Invalid edit' }); return; }
        if (content.length > MAX_MSG_LEN) { if (typeof ack === 'function') ack({ error: 'Message is too long.' }); return; }
        const m = await db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
        if (!m) { if (typeof ack === 'function') ack({ error: 'That message is no longer available.' }); return; }
        if (m.sender_id !== user.id) { if (typeof ack === 'function') ack({ error: 'You can only edit your own messages.' }); return; }
        await db.prepare('UPDATE messages SET content = ?, edited = 1 WHERE id = ?').run(content, id);
        const payload = { id: id, content: content, edited: true, sender_id: m.sender_id, recipient_id: m.recipient_id };
        io.to('user:' + m.recipient_id).emit('message:edited', payload);
        io.to('user:' + m.sender_id).emit('message:edited', payload);
        if (typeof ack === 'function') ack({ ok: true });
      } catch (e) {
        console.error('[socket message:edit]', e.message);
        if (typeof ack === 'function') ack({ error: 'Could not edit the message' });
      }
    });

    // Delete a message you sent, for everyone (Telegram-style). The row is removed
    // entirely; both sides remove the bubble live. Only the author can delete it.
    socket.on('message:delete', async (data, ack) => {
      try {
        const id = Number(data && data.id);
        if (!id) { if (typeof ack === 'function') ack({ error: 'Invalid delete' }); return; }
        const m = await db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
        if (!m) { if (typeof ack === 'function') ack({ ok: true, alreadyGone: true }); return; } // already deleted: treat as success
        if (m.sender_id !== user.id) { if (typeof ack === 'function') ack({ error: 'You can only delete your own messages.' }); return; }
        await db.prepare('DELETE FROM messages WHERE id = ?').run(id);
        const payload = { id: id, sender_id: m.sender_id, recipient_id: m.recipient_id };
        io.to('user:' + m.recipient_id).emit('message:deleted', payload);
        io.to('user:' + m.sender_id).emit('message:deleted', payload);
        if (typeof ack === 'function') ack({ ok: true });
      } catch (e) {
        console.error('[socket message:delete]', e.message);
        if (typeof ack === 'function') ack({ error: 'Could not delete the message' });
      }
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
