// routes/auth.js
// Signup, login, logout, and "who am I" endpoints.

const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { createSession, destroySession, requireAuth, publicUser } = require('../auth');
const { recordStandingEvent, refreshTrustLevel, trustSnapshot } = require('../trust');
const { sendVerificationEmail, sendPasswordResetEmail, EMAIL_CONFIGURED } = require('../mailer');
const {
  isDisposableEmail, makeChallenge, verifyPoW, verifyTurnstile,
  recordDevice, flagSignupRisk,
} = require('../antisybil');
const { ensureCode, attachReferral } = require('../referrals');

const router = express.Router();

// Email sending (Resend) and the "must verify to post" gate are DECOUPLED on
// purpose. Adding RESEND_API_KEY makes password-reset and any verification
// emails deliverable, but new signups are only FORCED to verify when
// REQUIRE_EMAIL_VERIFICATION=1. This lets the owner have working password reset
// while keeping signups frictionless until they choose to require verification.
const REQUIRE_EMAIL_VERIFICATION = process.env.REQUIRE_EMAIL_VERIFICATION === '1';

// Pin the public base URL used in emailed links, so a spoofed Host header can
// never point a verification/reset link at an attacker's domain. Falls back to
// the request's own protocol+host when APP_BASE_URL is not set (fine for dev).
function baseUrl(req) {
  const env = (process.env.APP_BASE_URL || '').replace(/\/+$/, '');
  return env || (req.protocol + '://' + req.get('host'));
}

// Per-account login throttle (in-memory, single instance like antisybil.js).
// Slows online password guessing against ONE account even across many IPs. A high
// threshold + short cooldown means a user mistyping their password is never
// locked out; the worst an attacker can do is impose a brief cooldown on an email
// (they still cannot read or change anything). Move to Redis before running
// multiple instances. DUMMY_HASH makes the unknown-email path spend the same
// bcrypt time as a real one, closing the login timing side-channel.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);
const loginFails = new Map(); // email -> { count, first, until }
const LOGIN_MAX_FAILS = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_COOLDOWN_MS = 15 * 60 * 1000;
function loginBlocked(email) {
  const r = loginFails.get(email);
  return !!(r && r.until && r.until > Date.now());
}
function recordLoginFail(email) {
  const now = Date.now();
  let r = loginFails.get(email);
  if (!r || (now - r.first) > LOGIN_WINDOW_MS) r = { count: 0, first: now, until: 0 };
  r.count++;
  if (r.count >= LOGIN_MAX_FAILS) r.until = now + LOGIN_COOLDOWN_MS;
  loginFails.set(email, r);
}

function verifyLink(req, token) {
  return baseUrl(req) + '/api/auth/verify?token=' + encodeURIComponent(token);
}

// Issue a proof-of-work challenge for the signup form (anti-mass-signup cost).
router.get('/challenge', (req, res) => res.json(makeChallenge()));
// The self-facing user object includes the owner's own email + verification flag
// (publicUser hides email from everyone else).
function selfUser(u) {
  return Object.assign(publicUser(u), { email: u.email, emailVerified: !!u.email_verified, isAdmin: !!u.is_admin });
}

router.post('/signup', async (req, res, next) => {
 try {
  const name = (req.body.name || '').trim();
  const email = (req.body.email || '').trim().toLowerCase();
  const password = req.body.password || '';
  const fingerprint = (req.body.fp || req.body.fingerprint || '').toString();

  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Name, email and password are all required' });
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  // Anti-sybil: block throwaway inboxes (cheap mass accounts).
  if (isDisposableEmail(email)) {
    return res.status(400).json({ error: 'Please use a permanent email address (disposable email providers are not allowed).' });
  }
  // Anti-sybil: lightweight proof-of-work, so mass signups are expensive. Off
  // only if SIGNUP_POW=0; the signup form solves the challenge automatically.
  if (!verifyPoW(req.body.powSalt, req.body.powNonce)) {
    return res.status(400).json({ error: 'Could not verify your browser. Please refresh the page and try again.', code: 'POW_FAILED' });
  }
  // Anti-sybil: optional CAPTCHA. No-op unless TURNSTILE_SECRET is configured.
  if (!(await verifyTurnstile(req.body.turnstileToken, req.ip))) {
    return res.status(400).json({ error: 'CAPTCHA check failed. Please try again.', code: 'CAPTCHA_FAILED' });
  }

  const exists = await db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (exists) return res.status(409).json({ error: 'That email is already registered' });

  const hash = bcrypt.hashSync(password, 10);
  const token = crypto.randomBytes(24).toString('hex');
  // If no mail provider is configured we cannot deliver a verification link, so
  // auto-verify rather than lock people out. The gate only bites once email is
  // set up (RESEND_API_KEY). This keeps the live demo usable before that.
  const verified = (EMAIL_CONFIGURED && REQUIRE_EMAIL_VERIFICATION) ? 0 : 1;
  const info = await db
    .prepare('INSERT INTO users (name, email, password_hash, verify_token, email_verified) VALUES (?, ?, ?, ?, ?)')
    .run(name, email, hash, token, verified);

  await createSession(info.lastInsertRowid, res);
  // Start this account's audit trail at the baseline standing.
  await recordStandingEvent(info.lastInsertRowid, 0, 'account_created');
  // Anti-sybil bookkeeping: remember this device/IP and flag (do not block) if
  // the same device or IP already hosts several accounts.
  await recordDevice(info.lastInsertRowid, req.ip, fingerprint);
  await flagSignupRisk(info.lastInsertRowid, req.ip, fingerprint);
  // Referral: give the new account its own invite code, and if they arrived via
  // someone's ?ref code, open a pending referral (qualifies after 30 active days).
  await ensureCode(info.lastInsertRowid);
  const refCode = (req.body.ref || '').toString().trim();
  if (refCode) await attachReferral(info.lastInsertRowid, refCode);

  // Pioneer badge: the first 5000 real members (signup order) get it forever.
  // Cosmetic only. Founders + sentinel accounts are excluded from the count.
  try {
    const cnt = await db.prepare(
      "SELECT COUNT(*) c FROM users WHERE is_founder = 0 AND email NOT IN ('ghost@deleted.openbook.local','system@openbook.local')"
    ).get();
    if (cnt && cnt.c <= 5000) await db.prepare('UPDATE users SET is_pioneer = 1 WHERE id = ?').run(info.lastInsertRowid);
  } catch (e) { /* non-fatal */ }

  const out = { user: selfUser(await db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid)) };
  if (EMAIL_CONFIGURED && REQUIRE_EMAIL_VERIFICATION) {
    const link = verifyLink(req, token);
    // Fire and forget so signup is never blocked by the mail provider.
    sendVerificationEmail(email, link, name).catch(() => {});
    if (process.env.NODE_ENV !== 'production') out.devVerifyLink = link; // dev testing convenience
  }
  res.json(out);
 } catch (e) { next(e); }
});

// Click target from the verification email. Marks the account verified and
// bounces back into the app with a flag the UI turns into a toast.
router.get('/verify', async (req, res) => {
  const token = (req.query.token || '').toString();
  if (!token) return res.redirect('/app?verified=0');
  const u = await db.prepare('SELECT id FROM users WHERE verify_token = ?').get(token);
  if (!u) return res.redirect('/app?verified=0');
  await db.prepare('UPDATE users SET email_verified = 1, verify_token = NULL WHERE id = ?').run(u.id);
  res.redirect('/app?verified=1');
});

// Resend the verification email to the logged-in user.
router.post('/resend-verification', requireAuth, async (req, res) => {
  const u = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (u.email_verified) return res.json({ ok: true, already: true });
  let token = u.verify_token;
  if (!token) {
    token = crypto.randomBytes(24).toString('hex');
    await db.prepare('UPDATE users SET verify_token = ? WHERE id = ?').run(token, u.id);
  }
  const link = verifyLink(req, token);
  const out = { ok: true };
  sendVerificationEmail(u.email, link, u.name).catch(() => {});
  if (process.env.NODE_ENV !== 'production') out.devVerifyLink = link;
  res.json(out);
});

// Forgot password: email a one-time reset link. Always returns a generic ok so
// the response never reveals whether an account exists for that email.
router.post('/forgot-password', async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const out = { ok: true };
  if (!email) return res.json(out);
  const u = await db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (u) {
    const token = crypto.randomBytes(24).toString('hex');
    await db.prepare("UPDATE users SET reset_token = ?, reset_expires = datetime('now', '+1 hour') WHERE id = ?").run(token, u.id);
    const link = baseUrl(req) + '/reset?token=' + encodeURIComponent(token);
    sendPasswordResetEmail(u.email, link, u.name).catch(() => {});
    if (process.env.NODE_ENV !== 'production') out.devResetLink = link; // dev testing only
  }
  res.json(out);
});

// Complete a password reset using the emailed token.
router.post('/reset-password', async (req, res) => {
  const token = (req.body.token || '').toString();
  const password = req.body.password || '';
  if (!token) return res.status(400).json({ error: 'Missing reset token' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  const u = await db.prepare("SELECT * FROM users WHERE reset_token = ? AND reset_expires >= datetime('now')").get(token);
  if (!u) return res.status(400).json({ error: 'This reset link is invalid or has expired. Please request a new one.' });
  const hash = bcrypt.hashSync(password, 10);
  await db.prepare('UPDATE users SET password_hash = ?, reset_token = NULL, reset_expires = NULL WHERE id = ?').run(hash, u.id);
  // Log out any existing sessions so an old/leaked session cannot outlive a reset.
  await db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
  res.json({ ok: true });
});

router.post('/login', async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const password = req.body.password || '';

  if (email && loginBlocked(email)) {
    return res.status(429).json({ error: 'Too many failed attempts for this account. Please wait a few minutes, or reset your password.' });
  }
  const user = await db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  // Always run one bcrypt comparison (the real hash, or a dummy when the email is
  // unknown) so a wrong email and a wrong password take the same time, closing the
  // timing side-channel that would otherwise reveal which emails are registered.
  const ok = bcrypt.compareSync(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !ok) {
    if (email) recordLoginFail(email);
    return res.status(401).json({ error: 'Wrong email or password' });
  }
  loginFails.delete(email);

  await createSession(user.id, res);
  // Keep the device/IP record fresh so multi-account concentration stays visible.
  await recordDevice(user.id, req.ip, (req.body.fp || req.body.fingerprint || '').toString());
  res.json({ user: selfUser(user) });
});

router.post('/logout', async (req, res) => {
  await destroySession(req.sessionToken, res);
  res.json({ ok: true });
});

router.get('/me', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not logged in' });
  // Keep the trust level current, then return it only to the account owner.
  await refreshTrustLevel(req.user.id);
  const fresh = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json({ user: selfUser(fresh), trust: trustSnapshot(fresh) });
});

module.exports = router;
