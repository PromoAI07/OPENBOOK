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
const { signupsFull, MAX_USERS } = require('../growth');

const router = express.Router();

// Email sending (Resend) and the "must verify to post" gate are DECOUPLED on
// purpose. Adding RESEND_API_KEY makes password-reset and any verification
// emails deliverable, but new signups are only FORCED to verify when
// REQUIRE_EMAIL_VERIFICATION=1. This lets the owner have working password reset
// while keeping signups frictionless until they choose to require verification.
const REQUIRE_EMAIL_VERIFICATION = process.env.REQUIRE_EMAIL_VERIFICATION === '1';

// Sign in with Google (OAuth 2.0 authorization-code flow). Dormant until BOTH
// GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are set, so nothing changes for the live
// site until the owner adds the credentials. No third-party JS and no extra package:
// the whole flow is server redirects, and the id_token is read straight from Google's
// token endpoint (server to server over TLS), so it is trustworthy without a JWKS
// fetch as long as we check aud + iss + email_verified.
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_ENABLED = !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);

function decodeJwtPayload(jwt) {
  try {
    const part = String(jwt).split('.')[1];
    const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json);
  } catch (e) { return null; }
}

// A modest IP rate limit on the OAuth routes so the account-creation branch cannot
// be scripted faster than the throttled, proof-of-work-gated POST /signup path. A
// real user does one round trip (start + callback), so this never affects them.
const oauthLimiter = require('express-rate-limit')({
  windowMs: 10 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many sign-in attempts. Please wait a few minutes and try again.' },
});

// Does this account have any content yet (posts or comments)? Used so a Google
// sign-in never silently absorbs a content-bearing, never-verified local account.
async function accountHasContent(userId) {
  try {
    const r = await db.prepare(
      'SELECT (SELECT COUNT(*) FROM posts WHERE user_id = ?) + (SELECT COUNT(*) FROM comments WHERE user_id = ?) AS c'
    ).get(userId, userId);
    return !!(r && r.c > 0);
  } catch (e) { return true; } // on error, assume content (the safe, non-merging side)
}

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

// Silent honeypot. The signup and login forms carry an off-screen field that no
// human ever sees or fills (hp_token). A non-empty value is a strong automated-bot
// signal, so we reject with the SAME generic error a normal failure gives, so a
// bot never learns the trap exists. Zero friction and zero privacy cost for real
// users, who always submit it empty.
function botTrapped(req) {
  return !!String((req.body && req.body.hp_token) || '').trim();
}

// Issue a proof-of-work challenge for the signup form (anti-mass-signup cost).
router.get('/challenge', (req, res) => res.json(makeChallenge()));
// The self-facing user object includes the owner's own email + verification flag
// (publicUser hides email from everyone else).
function selfUser(u) {
  return Object.assign(publicUser(u), {
    email: u.email,
    emailVerified: !!u.email_verified,
    isAdmin: !!u.is_admin,
    googleLinked: !!u.google_id, // whether a Google account is connected
  });
}

router.post('/signup', async (req, res, next) => {
 try {
  const name = (req.body.name || '').trim();
  const email = (req.body.email || '').trim().toLowerCase();
  const password = req.body.password || '';
  const fingerprint = (req.body.fp || req.body.fingerprint || '').toString();

  // Silent honeypot first: if the hidden trap field is filled, this is a bot.
  // Reject with the same generic message as a failed proof-of-work so the trap
  // stays invisible.
  if (botTrapped(req)) {
    return res.status(400).json({ error: 'Could not verify your browser. Please refresh the page and try again.', code: 'POW_FAILED' });
  }
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

  // Phase-1 signup cap: hold real membership at MAX_USERS until there is enough
  // support to fund Phase 2 (bigger servers). Public and configurable (MAX_USERS).
  if (await signupsFull()) {
    return res.status(403).json({
      error: 'OpenBook is in Phase 1 and is currently full at ' + MAX_USERS.toLocaleString() + ' members. We are raising support to open Phase 2 with bigger servers. Please check back soon.',
      code: 'SIGNUPS_FULL',
    });
  }

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

  // Drop the OpenBook welcome message (and its bell notification) into the new
  // member's inbox so it is waiting the moment they open the app. Awaited so it is
  // present on first load, but wrapped so a hiccup here never blocks signup.
  try { await require('../welcome').sendWelcome(info.lastInsertRowid); } catch (e) { /* non-fatal */ }

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

  // Silent honeypot: a filled trap field means a bot. Answer with the normal
  // wrong-credentials error so it is indistinguishable from a real failure.
  if (botTrapped(req)) return res.status(401).json({ error: 'Wrong email or password' });
  // Optional CAPTCHA on login (no-op unless TURNSTILE_SECRET is set): stops
  // automated credential-stuffing scripts from hammering this endpoint. Fails
  // open on a Cloudflare outage, so real users are never locked out.
  if (!(await verifyTurnstile(req.body.turnstileToken, req.ip))) {
    return res.status(400).json({ error: 'CAPTCHA check failed. Please try again.', code: 'CAPTCHA_FAILED' });
  }
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

// ---- Sign in with Google (OAuth 2.0 authorization-code flow) ---------------
function googleRedirectUri(req) { return baseUrl(req) + '/api/auth/google/callback'; }

// Start the flow. ?mode=connect (while logged in) links Google to the CURRENT
// account; otherwise it logs in, or creates a new account if the Google email has none.
router.get('/google', oauthLimiter, (req, res) => {
  if (!GOOGLE_ENABLED) return res.redirect('/?autherror=google_unavailable');
  const state = crypto.randomBytes(16).toString('hex');
  const connectUid = (req.query.mode === 'connect' && req.user) ? req.user.id : 0;
  // Short-lived httpOnly cookie carrying the CSRF state + the connect intent.
  res.cookie('g_oauth', JSON.stringify({ s: state, c: connectUid }), {
    httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 10 * 60 * 1000,
  });
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: googleRedirectUri(req),
    response_type: 'code',
    scope: 'openid email profile',
    state: state,
    access_type: 'online',
    prompt: 'select_account',
  });
  res.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + params.toString());
});

router.get('/google/callback', oauthLimiter, async (req, res) => {
  if (!GOOGLE_ENABLED) return res.redirect('/');
  let saved = {};
  try { saved = JSON.parse((req.cookies && req.cookies.g_oauth) || '{}'); } catch (e) {}
  res.clearCookie('g_oauth');
  const code = String(req.query.code || '');
  const state = String(req.query.state || '');
  // Verify the CSRF state matches the one we set before redirecting to Google.
  if (!code || !state || !saved.s || state !== saved.s) return res.redirect('/?autherror=google_failed');
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: googleRedirectUri(req),
        grant_type: 'authorization_code',
      }),
    });
    if (!tokenRes.ok) return res.redirect('/?autherror=google_failed');
    const tok = await tokenRes.json().catch(() => ({}));
    const payload = tok && tok.id_token ? decodeJwtPayload(tok.id_token) : null;
    const issOk = payload && (payload.iss === 'accounts.google.com' || payload.iss === 'https://accounts.google.com');
    if (!payload || payload.aud !== GOOGLE_CLIENT_ID || !issOk) return res.redirect('/?autherror=google_failed');
    // Reject an expired token (defence in depth; the code is single-use anyway).
    if (typeof payload.exp === 'number' && payload.exp * 1000 < Date.now()) return res.redirect('/?autherror=google_failed');
    // Only trust a Google-verified email (so linking by email cannot be spoofed).
    if (!payload.email || payload.email_verified !== true) return res.redirect('/?autherror=google_email');
    const googleId = String(payload.sub);
    const email = String(payload.email).toLowerCase();
    const name = String(payload.name || email.split('@')[0]).slice(0, 60);

    // CONNECT: link Google to the account that started the flow (must still be its session).
    const connectUid = Number(saved.c) || 0;
    if (connectUid) {
      if (!req.user || req.user.id !== connectUid) return res.redirect('/?autherror=connect_failed');
      const other = await db.prepare('SELECT id FROM users WHERE google_id = ?').get(googleId);
      if (other && other.id !== req.user.id) return res.redirect('/app?google=inuse');
      await db.prepare('UPDATE users SET google_id = ? WHERE id = ?').run(googleId, req.user.id);
      return res.redirect('/app?google=connected');
    }

    // LOGIN or SIGNUP.
    // 1) Already linked to a Google account -> log in.
    let user = await db.prepare('SELECT * FROM users WHERE google_id = ?').get(googleId);
    // 2) An account exists with this email. Auto-link + log in ONLY when it is safe:
    //    the existing account already proved it owns this email (verified), OR it has
    //    no content yet (a brand-new/empty account, so nothing could be absorbed from a
    //    possibly-mistyped/squatted unverified address). A content-bearing account that
    //    never verified its email is never silently merged into the Google identity.
    if (!user) {
      const byEmail = await db.prepare('SELECT * FROM users WHERE lower(email) = ?').get(email);
      if (byEmail) {
        const safeToLink = !!byEmail.email_verified || !(await accountHasContent(byEmail.id));
        if (!safeToLink) return res.redirect('/?autherror=email_exists');
        await db.prepare('UPDATE users SET google_id = ?, email_verified = 1 WHERE id = ?').run(googleId, byEmail.id);
        user = byEmail;
      }
    }
    // 3) No account -> create one (auto-verified by Google), respecting the signup cap.
    if (!user) {
      if (await signupsFull()) return res.redirect('/?autherror=signups_full');
      const hash = 'google$' + crypto.randomBytes(24).toString('hex'); // not a bcrypt hash: password login is impossible
      try {
        const info = await db.prepare(
          'INSERT INTO users (name, email, password_hash, email_verified, google_id) VALUES (?, ?, ?, 1, ?)'
        ).run(name, email, hash, googleId);
        const newId = info.lastInsertRowid;
        // Mirror the normal signup side-effects (best-effort, never block sign-in).
        try { await recordStandingEvent(newId, 0, 'account_created'); } catch (e) {}
        try { await recordDevice(newId, req.ip, ''); } catch (e) {}
        try { await ensureCode(newId); } catch (e) {}
        try {
          const cnt = await db.prepare("SELECT COUNT(*) c FROM users WHERE is_founder = 0 AND email NOT IN ('ghost@deleted.openbook.local','system@openbook.local')").get();
          if (cnt && cnt.c <= 5000) await db.prepare('UPDATE users SET is_pioneer = 1 WHERE id = ?').run(newId);
        } catch (e) {}
        try { await require('../welcome').sendWelcome(newId); } catch (e) {}
        user = await db.prepare('SELECT * FROM users WHERE id = ?').get(newId);
      } catch (e) {
        // Lost a race (a concurrent sign-in created this google_id/email first): the
        // row now exists, so link/log in instead of failing.
        user = await db.prepare('SELECT * FROM users WHERE google_id = ? OR lower(email) = ?').get(googleId, email);
        if (!user) throw e; // a genuine failure: let the outer catch redirect safely
      }
    }
    await createSession(user.id, res);
    return res.redirect('/app');
  } catch (e) {
    try { require('../logger').logger.warn({ err: e }, 'google oauth callback failed'); } catch (_) {}
    return res.redirect('/?autherror=google_failed');
  }
});

router.GOOGLE_ENABLED = GOOGLE_ENABLED;
module.exports = router;
