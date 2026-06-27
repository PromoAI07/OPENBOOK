// chat.js
// Socket.IO client wrapper for real time chat and live notification pings.
// app.js calls Chat.init() once the user is confirmed logged in.

window.Chat = (function () {
  let socket = null;
  const messageHandlers = [];
  const notifHandlers = [];
  const typingHandlers = [];
  const presenceHandlers = [];

  function init() {
    if (socket) return;
    // io() is provided by /socket.io/socket.io.js. Same origin, so the
    // session cookie is sent automatically with the handshake.
    socket = io({ withCredentials: true });
    socket.on('message:new', (m) => messageHandlers.forEach((h) => h(m)));
    socket.on('notification:new', (n) => notifHandlers.forEach((h) => h(n)));
    socket.on('typing', (t) => typingHandlers.forEach((h) => h(t)));
    socket.on('presence', (p) => presenceHandlers.forEach((h) => h(p)));
  }

  function send(to, content) {
    return new Promise((resolve, reject) => {
      if (!socket) return reject(new Error('Not connected to chat'));
      socket.emit('message:send', { to: to, content: content }, (res) => {
        if (res && res.ok) resolve(res.message);
        else reject(new Error((res && res.error) || 'Could not send the message'));
      });
    });
  }

  function typing(to) {
    if (socket) socket.emit('typing', { to: to });
  }

  function markRead(from) {
    return new Promise((resolve) => {
      if (!socket) return resolve();
      socket.emit('message:read', { from: from }, () => resolve());
    });
  }

  return {
    init: init,
    send: send,
    typing: typing,
    markRead: markRead,
    onMessage: (cb) => messageHandlers.push(cb),
    onNotif: (cb) => notifHandlers.push(cb),
    onTyping: (cb) => typingHandlers.push(cb),
    onPresence: (cb) => presenceHandlers.push(cb),
  };
})();
