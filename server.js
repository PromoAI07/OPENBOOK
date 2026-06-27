// server.js
// OpenBook entry point. Sets up Express, static files, the JSON API routes,
// and the Socket.IO server for real time chat and live notifications.

const path = require('path');
const http = require('http');
const express = require('express');
// Make Express forward rejected promises from async route handlers to the error
// handler below (Express 4 does not do this on its own). With the database now
// answering over the network, every handler is async, so this is what turns a
// database error into a clean 500 instead of a hung request.
require('express-async-errors');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Server } = require('socket.io');

const { attachUser } = require('./auth');
const { setIO } = require('./notify');
const { initSockets } = require('./sockets');
const { logger } = require('./logger');

const app = express();
// Trust the hosting platform's reverse proxy so secure cookies and client IPs
// (used by the rate limiter) are detected correctly once deployed.
app.set('trust proxy', 1);
const server = http.createServer(app);
const io = new Server(server);

// Let the notification helper and chat handlers use the live io instance.
setIO(io);
initSockets(io);

// Log every HTTP request once it completes: method, path, status, duration (ms).
// Runs first so the timing covers the whole pipeline. Obvious static assets log
// at debug, so production (info level) stays focused on API and page requests;
// 4xx log at warn and 5xx at error.
function isStaticAsset(p) {
  return p.startsWith('/css/') || p.startsWith('/js/') || p.startsWith('/uploads/') ||
    p.startsWith('/socket.io/') || /\.(css|js|map|png|jpe?g|gif|svg|ico|webp|mp4|woff2?)$/i.test(p);
}
app.use((req, res, next) => {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Math.round((Number(process.hrtime.bigint() - start) / 1e6) * 10) / 10;
    const fields = { method: req.method, path: req.originalUrl || req.url, status: res.statusCode, ms };
    let level = 'info';
    if (res.statusCode >= 500) level = 'error';
    else if (res.statusCode >= 400) level = 'warn';
    else if (isStaticAsset(req.path)) level = 'debug';
    logger[level](fields, 'request');
  });
  next();
});

// Security headers (clickjacking, MIME sniffing, HSTS in production, etc.).
// CSP is left off so the CDN script and inline styles keep working; it can be
// tightened later.
app.use(helmet({ contentSecurityPolicy: false }));

// Parsers and session attachment run on every request.
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(attachUser);

// Serve uploaded media. The database stores stable "/uploads/<key>" strings in
// both modes; how that key turns into bytes depends on the storage backend:
//
//   s3 mode    redirect the browser straight to the CDN edge in front of the
//              egress-free bucket, so the origin never pays bandwidth for the
//              bytes (the 302 is tiny and itself cacheable). The object was
//              written with a one-year immutable Cache-Control, so after the
//              first hit the CDN serves it without touching the bucket either.
//   local mode skip the redirect and serve the file from the persistent disk,
//              exactly as before (express.static handles Range for video).
const mediaStore = require('./media/storage');
app.use('/uploads', (req, res, next) => {
  if (!mediaStore.isRemote()) return next();
  const key = decodeURIComponent(req.path.replace(/^\/+/, ''));
  // keys are flat content-addressed names; reject anything else rather than
  // forwarding a crafted path to the CDN.
  if (!/^[A-Za-z0-9._-]+$/.test(key)) return next();
  res.set('Cache-Control', 'public, max-age=3600');
  return res.redirect(302, mediaStore.publicUrl(key));
});
app.use('/uploads', express.static(path.join(process.env.DATA_DIR || __dirname, 'uploads')));

// File-attachment downloads. Forces a safe attachment download (Content-Disposition
// + octet-stream) so an uploaded document can never run inline as a page in the
// user's session. In s3 mode the bytes come from the CDN (redirect).
app.get('/download/:key', (req, res) => {
  const key = String(req.params.key || '');
  if (!/^[A-Za-z0-9._-]+$/.test(key)) return res.status(400).end();
  const name = (req.query.n ? String(req.query.n) : key).replace(/[^A-Za-z0-9._ ()-]/g, '_').slice(0, 200) || 'file';
  res.setHeader('Content-Disposition', 'attachment; filename="' + name + '"');
  if (mediaStore.isRemote()) {
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.redirect(302, mediaStore.publicUrl(key));
  }
  res.setHeader('Content-Type', 'application/octet-stream');
  return res.sendFile(path.join(process.env.DATA_DIR || __dirname, 'uploads', key), (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
});

app.use(express.static(path.join(__dirname, 'public')));

// Throttle auth attempts to slow brute force and signup abuse. Only the mutating
// auth calls (POST signup/login/logout/resend) need throttling; the read-only
// GETs (the proof-of-work challenge and /me) are skipped so a shared NAT cannot
// starve them out of this bucket and block legitimate signups.
const authLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS',
  message: { error: 'Too many attempts. Please wait a few minutes and try again.' },
});

// Soft email gate: unverified accounts can read and browse everything, but
// cannot create content until they verify. GETs, auth routes, profile edits,
// and notification reads stay open; everything else under /api needs a verified
// email. (db is required lazily to avoid a circular import at module load.)
const gateDb = require('./db');
app.use('/api', async (req, res, next) => {
  try {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    if (!req.user) return next(); // requireAuth on the route handles the 401
    if (req.path.startsWith('/auth')) return next();
    if (req.path.startsWith('/users/me')) return next(); // profile + avatar edits
    if (req.path.startsWith('/notifications')) return next(); // mark read
    if (req.path.startsWith('/analytics')) return next(); // coarse usage pings
    const u = await gateDb.prepare('SELECT email_verified FROM users WHERE id = ?').get(req.user.id);
    if (u && u.email_verified) return next();
    return res.status(403).json({
      error: 'Please verify your email to do that. Check your inbox, or resend the link from the banner at the top.',
      code: 'UNVERIFIED',
    });
  } catch (e) { return next(e); }
});

// Public funding info for the Support page (links are set via env so they can be
// changed without a code deploy). Empty values render as "coming soon".
app.get('/api/support', (req, res) => {
  res.json({
    github: process.env.SUPPORT_GITHUB || '',
    opencollective: process.env.SUPPORT_OPENCOLLECTIVE || '',
    crypto: process.env.SUPPORT_CRYPTO || '',
  });
});

// The supporter tiers and their perks, for the upgrade page (public).
app.get('/api/tiers', (req, res) => {
  res.json({ tiers: require('./entitlements').tierList() });
});

// JSON API.
app.use('/api/auth', authLimiter, require('./routes/auth'));
app.use('/api/users', require('./routes/users'));
app.use('/api/posts', require('./routes/posts'));
app.use('/api/comments', require('./routes/comments'));
app.use('/api/friends', require('./routes/friends'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/stories', require('./routes/stories'));
app.use('/api/messages', require('./routes/messages'));
app.use('/api/marketplace', require('./routes/marketplace'));
app.use('/api/groups', require('./routes/groups'));
app.use('/api/albums', require('./routes/albums'));
app.use('/api/communities', require('./routes/communities'));
app.use('/api/votes', require('./routes/votes'));
app.use('/api/reactions', require('./routes/reactions'));
app.use('/api/reels', require('./routes/reels'));
app.use('/api/moderation', require('./routes/moderation'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/referrals', require('./routes/referrals'));
app.use('/api/analytics', require('./routes/analytics'));
app.use('/api/suggestions', require('./routes/suggestions'));
app.use('/api/roadmap', require('./routes/roadmap'));

// The authenticated single page app shell.
app.get('/app', (req, res) => res.sendFile(path.join(__dirname, 'public', 'app.html')));

// Password-reset page (the target of the emailed link; the token is in the URL).
app.get('/reset', (req, res) => res.sendFile(path.join(__dirname, 'public', 'reset.html')));

// Public "Our Mission" page (open to everyone, logged in or out).
app.get('/mission', (req, res) => res.sendFile(path.join(__dirname, 'public', 'mission.html')));

// Public Privacy Policy and Cookies pages (open to everyone, logged in or out).
app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, 'public', 'privacy.html')));
app.get('/cookies', (req, res) => res.sendFile(path.join(__dirname, 'public', 'cookies.html')));

// Public community roadmap page (the transparent, voted feature roadmap).
app.get('/roadmap', (req, res) => res.sendFile(path.join(__dirname, 'public', 'roadmap.html')));

// Public, site-wide moderation log (every public mod action, scannable by anyone).
app.get('/mod-log', (req, res) => res.sendFile(path.join(__dirname, 'public', 'mod-log.html')));

// Separate owner-only analytics page. The PAGE ITSELF is gated here server-side:
// a non-admin (or logged-out) visitor is bounced before the page even loads, and
// the analytics API it calls is independently admin-only. admin.html lives
// OUTSIDE public/ so it can never be served by the static handler. This is the
// "totally separate, admin-only" entrance, not a button in the normal app.
app.get('/admin', (req, res) => {
  if (!req.user) return res.redirect('/');
  if (!req.user.is_admin) return res.redirect('/app');
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// Central error handler so upload errors and the like return clean JSON. The
// response is unchanged; we just log with a full stack trace for 5xx (and a
// lighter line for expected 4xx) so failures are diagnosable.
app.use((err, req, res, next) => {
  const status = err.status || (err.name === 'MulterError' ? 400 : 500);
  const message = err.code === 'LIMIT_FILE_SIZE'
    ? 'File is too large. Free accounts can upload up to 100 MB per file; upgrade to Plus or Premium for larger uploads.'
    : (err.message || 'Something went wrong');
  const where = { method: req.method, path: req.originalUrl || req.url, status };
  if (status >= 500) logger.error({ err, ...where }, 'request error');
  else logger.warn({ err: err.message, ...where }, 'request error');
  res.status(status).json({ error: message });
});

// Never let one stray async error take down the whole server for everyone.
process.on('uncaughtException', (e) => logger.error({ err: e }, 'uncaughtException'));
process.on('unhandledRejection', (e) => logger.error({ err: e instanceof Error ? e : new Error(String(e)) }, 'unhandledRejection'));

const PORT = process.env.PORT || 3000;
// Build the database schema FIRST (it is now a networked database, so this is
// async), then start listening. We never accept a request before the schema is
// ready. If the database is unreachable at boot we fail loudly rather than serve
// a broken app.
require('./db').init()
  .then(() => {
    server.listen(PORT, () => {
      logger.info({ port: PORT, env: process.env.NODE_ENV || 'development' }, 'OpenBook server started');
      // Phase 5: start the background vote-ring scan (no-op if SYBIL_JOB=0).
      try { require('./antisybil').startSybilJobs(); } catch (e) { logger.error({ err: e }, 'failed to start sybil jobs'); }
      // Referral: qualify pending referrals + pay rewards on a schedule.
      try { require('./referrals').startReferralJobs(); } catch (e) { logger.error({ err: e }, 'failed to start referral jobs'); }
      // Media: hard-delete expired stories (and their files) on a schedule, so the
      // 24-hour promise is real and storage (the only real cost) stops growing.
      try { require('./media/cleanup').startStoryCleanupJob(); } catch (e) { logger.error({ err: e }, 'failed to start story cleanup job'); }
      // Data export: sweep expired export artifacts so they never accumulate.
      try { require('./export').startExportCleanupJob(); } catch (e) { logger.error({ err: e }, 'failed to start export cleanup job'); }
      // Roadmap: reconcile linked GitHub issues (no-op unless GITHUB_TOKEN is set).
      try { require('./roadmap-sync').startRoadmapJobs(); } catch (e) { logger.error({ err: e }, 'failed to start roadmap sync job'); }
      // Jury: settle any community juries past their deadline (Phase 4).
      try { require('./jury').startJuryJobs(); } catch (e) { logger.error({ err: e }, 'failed to start jury job'); }
    });
  })
  .catch((e) => {
    logger.error({ err: e }, 'database init failed; server not started');
    process.exit(1);
  });
