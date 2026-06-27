// presence.js
// In-memory online presence. A user is "online" while they hold at least one live
// socket connection (several tabs count once). This powers the green/grey dot on
// the contacts list. In-memory is the right call here: presence is ephemeral, and
// after a restart it simply rebuilds itself as clients reconnect.

const counts = new Map(); // userId -> number of open sockets

// Returns true if this connection brought the user from offline to online.
function markOnline(userId) {
  userId = Number(userId);
  const n = (counts.get(userId) || 0) + 1;
  counts.set(userId, n);
  return n === 1;
}

// Returns true if this disconnect left the user fully offline (no sockets left).
function markOffline(userId) {
  userId = Number(userId);
  const n = (counts.get(userId) || 0) - 1;
  if (n <= 0) { counts.delete(userId); return true; }
  counts.set(userId, n);
  return false;
}

function isOnline(userId) { return counts.has(Number(userId)); }
function onlineIds() { return [...counts.keys()]; }

module.exports = { markOnline, markOffline, isOnline, onlineIds };
