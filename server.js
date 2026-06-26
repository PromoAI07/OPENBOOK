// server.js
// OpenBook entry point. Sets up Express, static files, the JSON API routes,
// and the Socket.IO server for real time chat and live notifications.

const path = require('path');
const http = require('http');
const express = require('express');
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

// Serve uploaded images and the static frontend. Uploads live under DATA_DIR
// so they can sit on a persistent volume in production.
app.use('/uploads', express.static(path.join(process.env.DATA_DIR || __dirname, 'uploads')));
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
app.use('/api', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  if (!req.user) return next(); // requireAuth on the route handles the 401
  if (req.path.startsWith('/auth')) return next();
  if (req.path.startsWith('/users/me')) return next(); // profile + avatar edits
  if (req.path.startsWith('/notifications')) return next(); // mark read
  const u = gateDb.prepare('SELECT email_verified FROM users WHERE id = ?').get(req.user.id);
  if (u && u.email_verified) return next();
  return res.status(403).json({
    error: 'Please verify your email to do that. Check your inbox, or resend the link from the banner at the top.',
    code: 'UNVERIFIED',
  });
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

// The authenticated single page app shell.
app.get('/app', (req, res) => res.sendFile(path.join(__dirname, 'public', 'app.html')));

// Central error handler so upload errors and the like return clean JSON. The
// response is unchanged; we just log with a full stack trace for 5xx (and a
// lighter line for expected 4xx) so failures are diagnosable.
app.use((err, req, res, next) => {
  const status = err.status || (err.name === 'MulterError' ? 400 : 500);
  const message = err.code === 'LIMIT_FILE_SIZE'
    ? 'File is too large (images max 8 MB, reels max 60 MB)'
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
server.listen(PORT, () => {
  logger.info({ port: PORT, env: process.env.NODE_ENV || 'development' }, 'OpenBook server started');
  // Phase 5: start the background vote-ring scan (no-op if SYBIL_JOB=0).
  try { require('./antisybil').startSybilJobs(); } catch (e) { logger.error({ err: e }, 'failed to start sybil jobs'); }
  // Referral: qualify pending referrals + pay rewards on a schedule.
  try { require('./referrals').startReferralJobs(); } catch (e) { logger.error({ err: e }, 'failed to start referral jobs'); }
});
