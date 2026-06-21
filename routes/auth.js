// routes/auth.js
// Signup, login, logout, and "who am I" endpoints.

const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { createSession, destroySession, requireAuth, publicUser } = require('../auth');
const { recordStandingEvent, refreshTrustLevel, trustSnapshot } = require('../trust');
const { sendVerificationEmail, EMAIL_CONFIGURED } = require('../mailer');

const router = express.Router();

function verifyLink(req, token) {
  return req.protocol + '://' + req.get('host') + '/api/auth/verify?token=' + encodeURIComponent(token);
}
// The self-facing user object includes the owner's own email + verification flag
// (publicUser hides email from everyone else).
function selfUser(u) {
  return Object.assign(publicUser(u), { email: u.email, emailVerified: !!u.email_verified, isAdmin: !!u.is_admin });
}

router.post('/signup', (req, res) => {
  const name = (req.body.name || '').trim();
  const email = (req.body.email || '').trim().toLowerCase();
  const password = req.body.password || '';

  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Name, email and password are all required' });
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (exists) return res.status(409).json({ error: 'That email is already registered' });

  const hash = bcrypt.hashSync(password, 10);
  const token = crypto.randomBytes(24).toString('hex');
  // If no mail provider is configured we cannot deliver a verification link, so
  // auto-verify rather than lock people out. The gate only bites once email is
  // set up (RESEND_API_KEY). This keeps the live demo usable before that.
  const verified = EMAIL_CONFIGURED ? 0 : 1;
  const info = db
    .prepare('INSERT INTO users (name, email, password_hash, verify_token, email_verified) VALUES (?, ?, ?, ?, ?)')
    .run(name, email, hash, token, verified);

  createSession(info.lastInsertRowid, res);
  // Start this account's audit trail at the baseline standing.
  recordStandingEvent(info.lastInsertRowid, 0, 'account_created');

  const out = { user: selfUser(db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid)) };
  if (EMAIL_CONFIGURED) {
    const link = verifyLink(req, token);
    // Fire and forget so signup is never blocked by the mail provider.
    sendVerificationEmail(email, link, name).catch(() => {});
    if (process.env.NODE_ENV !== 'production') out.devVerifyLink = link; // dev testing convenience
  }
  res.json(out);
});

// Click target from the verification email. Marks the account verified and
// bounces back into the app with a flag the UI turns into a toast.
router.get('/verify', (req, res) => {
  const token = (req.query.token || '').toString();
  if (!token) return res.redirect('/app?verified=0');
  const u = db.prepare('SELECT id FROM users WHERE verify_token = ?').get(token);
  if (!u) return res.redirect('/app?verified=0');
  db.prepare('UPDATE users SET email_verified = 1, verify_token = NULL WHERE id = ?').run(u.id);
  res.redirect('/app?verified=1');
});

// Resend the verification email to the logged-in user.
router.post('/resend-verification', requireAuth, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (u.email_verified) return res.json({ ok: true, already: true });
  let token = u.verify_token;
  if (!token) {
    token = crypto.randomBytes(24).toString('hex');
    db.prepare('UPDATE users SET verify_token = ? WHERE id = ?').run(token, u.id);
  }
  const link = verifyLink(req, token);
  const out = { ok: true };
  sendVerificationEmail(u.email, link, u.name).catch(() => {});
  if (process.env.NODE_ENV !== 'production') out.devVerifyLink = link;
  res.json(out);
});

router.post('/login', (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const password = req.body.password || '';

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Wrong email or password' });
  }

  createSession(user.id, res);
  res.json({ user: selfUser(user) });
});

router.post('/logout', (req, res) => {
  destroySession(req.sessionToken, res);
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not logged in' });
  // Keep the trust level current, then return it only to the account owner.
  refreshTrustLevel(req.user.id);
  const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json({ user: selfUser(fresh), trust: trustSnapshot(fresh) });
});

module.exports = router;
