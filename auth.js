// auth.js
// Session handling and auth helpers.
// We use a simple, secure session table: on login we generate a random token,
// store it server side, and put it in an httpOnly cookie the browser sends back.
//
// Session/user lookups now hit a networked database, so createSession,
// destroySession, userFromToken and the attachUser middleware are async.
// requireAuth and publicUser stay synchronous (they touch no database).

const crypto = require('crypto');
const db = require('./db');
const { publicTierFields } = require('./entitlements');

const COOKIE_NAME = 'tb_session';
const THIRTY_DAYS = 1000 * 60 * 60 * 24 * 30;

// Create a session for a user and set the cookie on the response.
async function createSession(userId, res) {
  const token = crypto.randomBytes(32).toString('hex');
  await db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').run(token, userId);
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    // Send the cookie only over HTTPS once deployed (set NODE_ENV=production).
    secure: process.env.NODE_ENV === 'production',
    maxAge: THIRTY_DAYS,
  });
  return token;
}

// Remove a session and clear the cookie (logout).
async function destroySession(token, res) {
  if (token) await db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  res.clearCookie(COOKIE_NAME);
}

// Look up the full user row for a session token, or null.
async function userFromToken(token) {
  if (!token) return null;
  const row = await db.prepare(
    "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.created_at >= datetime('now', '-30 days')"
  ).get(token);
  return row || null;
}

// Express middleware: attach req.user (or null) and req.sessionToken on every
// request. A DB hiccup must never wedge the request, so failures fall back to
// "logged out" rather than rejecting.
async function attachUser(req, res, next) {
  try {
    const token = req.cookies ? req.cookies[COOKIE_NAME] : null;
    req.user = await userFromToken(token);
    req.sessionToken = token;
  } catch (e) {
    req.user = null;
    req.sessionToken = null;
  }
  next();
}

// Express middleware: block the request if nobody is logged in.
function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'You need to log in first' });
  next();
}

// Strip private fields (email, password hash) before sending a user to the client.
function publicUser(u) {
  if (!u) return null;
  return Object.assign({
    id: u.id,
    name: u.name,
    avatar: u.avatar || '',
    cover: u.cover || '',
    bio: u.bio || '',
    karma: u.karma || 0,
    created_at: u.created_at,
    founder: !!u.is_founder, // cosmetic Founder badge (never affects reputation)
    avatarPos: u.avatar_pos || '50% 50%', // drag-to-position focal points
    coverPos: u.cover_pos || '50% 50%',
  }, publicTierFields(u)); // tier, tierName, verified (blue tick), badge
}

module.exports = {
  COOKIE_NAME,
  createSession,
  destroySession,
  userFromToken,
  attachUser,
  requireAuth,
  publicUser,
};
