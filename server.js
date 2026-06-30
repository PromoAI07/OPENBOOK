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
require('./welcome').setIO(io);

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
// Content Security Policy is a defense-in-depth backstop against XSS: even if a
// future bug let user input reach the page unescaped, an injected <script> still
// could not run. Inline scripts are allowed ONLY by exact sha256 hash, never via
// 'unsafe-inline', so injected script is blocked. The hashes are computed ONCE AT
// STARTUP by scanning every HTML file we serve (public/ + admin.html at the app
// root), so editing or adding an inline script can never silently break a page,
// and no file is ever missed. Inline STYLES stay allowed (the UI uses style=""
// heavily and they are far lower risk). anime.js loads from jsdelivr; media may
// load from the R2 CDN (MEDIA_CDN_BASE) in production.
const fs = require('fs');
function inlineScriptHashes() {
  const crypto = require('crypto');
  const dirs = [path.join(__dirname, 'public'), __dirname]; // served HTML lives here (admin.html is at the root)
  const hashes = new Set();
  for (const dir of dirs) {
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.html')); } catch (e) { continue; }
    for (const f of files) {
      let html = '';
      try { html = fs.readFileSync(path.join(dir, f), 'utf8'); } catch (e) { continue; }
      // Only <script> with NO src attribute is inline (external <script src=...> never matches).
      const re = /<script>([\s\S]*?)<\/script>/g;
      let m;
      while ((m = re.exec(html))) hashes.add("'sha256-" + crypto.createHash('sha256').update(m[1], 'utf8').digest('base64') + "'");
    }
  }
  return [...hashes];
}
let MEDIA_CDN_ORIGIN = null;
try { if (process.env.MEDIA_CDN_BASE) MEDIA_CDN_ORIGIN = new URL(process.env.MEDIA_CDN_BASE).origin; } catch (e) { /* ignore malformed */ }
const cspMedia = ["'self'", 'data:', 'blob:'].concat(MEDIA_CDN_ORIGIN ? [MEDIA_CDN_ORIGIN] : []);
// Cloudflare Turnstile (the optional CAPTCHA) loads its script + renders its
// challenge in an iframe from this origin, and the widget talks back to it. The
// CSP must allow all three (script-src, frame-src, connect-src) or the widget
// silently fails to appear. Harmless when Turnstile is unconfigured: nothing
// loads from here unless a site key is present.
const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'self'"],
      formAction: ["'self'"],
      scriptSrc: ["'self'", 'https://cdn.jsdelivr.net', TURNSTILE_ORIGIN].concat(inlineScriptHashes()),
      // PWA: the web manifest and the service worker are same-origin.
      manifestSrc: ["'self'"],
      workerSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: cspMedia,
      mediaSrc: cspMedia,
      fontSrc: ["'self'", 'data:'],
      frameSrc: ["'self'", TURNSTILE_ORIGIN],
      connectSrc: ["'self'", TURNSTILE_ORIGIN].concat(MEDIA_CDN_ORIGIN ? [MEDIA_CDN_ORIGIN] : []),
    },
  },
}));

// Cache-busting. Stamp the local /js and /css references in served HTML with a
// version derived from the CONTENT of the JS/CSS bundle, so every deploy that
// changes an asset changes its URL (e.g. /js/app.js?v=ab12cd). Browsers AND
// Cloudflare then fetch the new file immediately, while unchanged files keep
// their stamp and stay cached, so a deploy is visible to users without any manual
// cache purge. Computed once at startup. Inline <script> bodies are untouched, so
// the CSP script hashes still match.
const ASSET_V = (function () {
  if (process.env.ASSET_VERSION) return String(process.env.ASSET_VERSION);
  try {
    const crypto = require('crypto');
    const h = crypto.createHash('sha256');
    for (const sub of ['js', 'css']) {
      const dir = path.join(__dirname, 'public', sub);
      let files = [];
      try { files = fs.readdirSync(dir).sort(); } catch (e) { continue; }
      for (const f of files) { try { h.update(f); h.update(fs.readFileSync(path.join(dir, f))); } catch (e) {} }
    }
    return h.digest('hex').slice(0, 12);
  } catch (e) { return 'dev'; }
})();
const _pageCache = new Map();
function sendPage(res, file) {
  let html = _pageCache.get(file);
  if (html === undefined) {
    try { html = fs.readFileSync(file, 'utf8').replace(/((?:src|href)=")(\/(?:js|css)\/[^"?]+)(")/g, '$1$2?v=' + ASSET_V + '$3'); }
    catch (e) { html = null; }
    _pageCache.set(file, html);
  }
  if (html == null) return res.status(404).end();
  res.type('html').send(html);
}

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

// Public landing page, with versioned asset URLs (served before the static
// handler so '/' uses this, not the raw index.html).
app.get('/', (req, res) => {
  // The response depends on the per-user session cookie, so it must never be
  // shared-cached (Cloudflare sits in front). An already-authenticated visitor is
  // sent straight to the app, so the login page never paints for them and there is
  // no "login screen flashes then bounces to the feed" moment.
  res.set('Vary', 'Cookie');
  res.set('Cache-Control', 'private, no-store');
  if (req.user) return res.redirect(302, '/app');
  sendPage(res, path.join(__dirname, 'public', 'index.html'));
});
// The service worker script must never be cached for long, so a future update or a
// removal worker reaches already-installed clients quickly (the browser caps SW
// update checks at 24h anyway, and Cloudflare must not serve a stale copy).
app.get('/sw.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'sw.js'), {
    headers: { 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/' },
  });
});
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

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

// CSRF defense-in-depth: reject state-changing API calls whose Origin (or Referer
// as a fallback) is a DIFFERENT site than this one. The web app is same-origin, so
// its own fetch() calls always carry a matching Origin; the PayPal IPN is
// server-to-server (no browser Origin) and is exempt. A request with NEITHER an
// Origin nor a Referer is allowed (non-browser clients like curl / native apps),
// since a cross-site CSRF attack runs in a browser, which always sends one of them
// and cannot forge the victim's true Origin.
app.use('/api', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  if (req.path.startsWith('/webhooks')) return next(); // server-to-server IPN, no browser Origin
  const src = req.headers.origin || req.headers.referer || req.headers.referrer || '';
  if (!src) return next(); // no Origin/Referer at all: not a browser, so not a CSRF vector
  let ok = false;
  try { ok = new URL(src).host === req.headers.host; } catch (e) { ok = false; }
  if (!ok) {
    logger.warn({ origin: req.headers.origin, referer: req.headers.referer, host: req.headers.host, path: req.path }, 'blocked cross-site request');
    return res.status(403).json({ error: 'Cross-site request blocked.' });
  }
  next();
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
    if (req.path.startsWith('/billing')) return next(); // supporters can pay even if unverified
    if (req.path.startsWith('/webhooks')) return next(); // server-to-server (no user anyway)
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
    paypalEmail: process.env.PAYPAL_RECEIVER_EMAIL || '',
  });
});

// Public client config. Only ever exposes values that are safe in the browser:
// the Turnstile SITE key is public by design (it is rendered into the page); the
// SECRET key stays server-side and is never sent here. When no site key is set,
// the field is empty and the frontend renders no CAPTCHA (dormant).
app.get('/api/config', (req, res) => {
  // Tell the client whether unverified-account deletion is actually armed (so the
  // verify banner only threatens deletion when the server will really do it) and
  // the real grace window, so the warning and the countdown can never drift.
  let unverifiedDeletes = false;
  let unverifiedGraceHours = 24;
  try {
    const uc = require('./unverified-cleanup');
    unverifiedGraceHours = uc.graceHours();
    unverifiedDeletes = uc.enforcementOn() && process.env.UNVERIFIED_CLEANUP !== '0';
  } catch (e) { /* leave defaults */ }
  let googleEnabled = false;
  let webauthnEnabled = false;
  try { googleEnabled = !!require('./routes/auth').GOOGLE_ENABLED; } catch (e) {}
  try { webauthnEnabled = !!require('./routes/auth').WEBAUTHN_ENABLED; } catch (e) {}
  res.json({
    turnstileSiteKey: process.env.TURNSTILE_SITE_KEY || '',
    unverifiedDeletes: unverifiedDeletes,
    unverifiedGraceHours: unverifiedGraceHours,
    googleEnabled: googleEnabled,
    webauthnEnabled: webauthnEnabled,
  });
});

// The supporter tiers and their perks, for the upgrade page (public).
app.get('/api/tiers', (req, res) => {
  res.json({ tiers: require('./entitlements').tierList() });
});

// Public community size: total members and how many of the first-5000 Pioneer
// spots are filled. Sentinel accounts (the [deleted] ghost + system actor) are
// excluded from the member count.
app.get('/api/community-stats', async (req, res) => {
  const growth = require('./growth');
  try {
    const m = await gateDb.prepare("SELECT COUNT(*) c FROM users WHERE email NOT IN ('ghost@deleted.openbook.local','system@openbook.local')").get();
    const p = await gateDb.prepare('SELECT COUNT(*) c FROM users WHERE is_pioneer = 1').get();
    const users = m.c;
    res.json({
      users,
      pioneers: p.c,
      cap: 5000, // the Pioneer-badge cap (first 5,000), shown on the Founding-members card
      maxUsers: growth.MAX_USERS, // the live signup cap (Phase 1)
      signupsFull: growth.MAX_USERS > 0 && users >= growth.MAX_USERS,
      phase: growth.phaseFor(users), // { n, name, from, to }
      phases: growth.PHASES, // the full public ladder
    });
  } catch (e) {
    res.json({ users: 0, pioneers: 0, cap: 5000 });
  }
});

// JSON API.
app.use('/api/auth', authLimiter, require('./routes/auth'));
app.use('/api/users', require('./routes/users'));
app.use('/api/follows', require('./routes/follows'));
app.use('/api/posts', require('./routes/posts'));
app.use('/api/comments', require('./routes/comments'));
app.use('/api/friends', require('./routes/friends'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/stories', require('./routes/stories'));
app.use('/api/messages', require('./routes/messages'));
app.use('/api/marketplace', require('./routes/marketplace'));
app.use('/api/escrow', require('./routes/escrow'));
app.use('/api/groups', require('./routes/groups'));
app.use('/api/albums', require('./routes/albums'));
app.use('/api/communities', require('./routes/communities'));
app.use('/api/votes', require('./routes/votes'));
app.use('/api/reactions', require('./routes/reactions'));
// Reels are disabled for now (video storage is the fastest way to overload the
// servers on a young platform). People can share video links in a normal post
// instead; the route + tables stay dormant so reels can be re-enabled when funded.
// app.use('/api/reels', require('./routes/reels'));
app.use('/api/moderation', require('./routes/moderation'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/referrals', require('./routes/referrals'));
app.use('/api/analytics', require('./routes/analytics'));
app.use('/api/suggestions', require('./routes/suggestions'));
app.use('/api/roadmap', require('./routes/roadmap'));
app.use('/api/webhooks', require('./routes/billing').webhooks);
app.use('/api/billing', require('./routes/billing').api);

// The authenticated single page app shell.
app.get('/app', (req, res) => sendPage(res, path.join(__dirname, 'public', 'app.html')));

// Clean, shareable links: /u/<username-or-id> opens a profile, /p/<id> opens a
// post. Both serve the app shell; the client reads the path and navigates there.
app.get('/u/:handle', (req, res) => sendPage(res, path.join(__dirname, 'public', 'app.html')));
app.get('/p/:id', (req, res) => sendPage(res, path.join(__dirname, 'public', 'app.html')));

// Password-reset page (the target of the emailed link; the token is in the URL).
app.get('/reset', (req, res) => sendPage(res, path.join(__dirname, 'public', 'reset.html')));

// Public "Our Mission" page (open to everyone, logged in or out).
app.get('/mission', (req, res) => sendPage(res, path.join(__dirname, 'public', 'mission.html')));

// Public Privacy Policy and Cookies pages (open to everyone, logged in or out).
app.get('/privacy', (req, res) => sendPage(res, path.join(__dirname, 'public', 'privacy.html')));
app.get('/cookies', (req, res) => sendPage(res, path.join(__dirname, 'public', 'cookies.html')));

// Public community roadmap page (the transparent, voted feature roadmap).
app.get('/roadmap', (req, res) => sendPage(res, path.join(__dirname, 'public', 'roadmap.html')));

// Public, site-wide moderation log (every public mod action, scannable by anyone).
app.get('/mod-log', (req, res) => sendPage(res, path.join(__dirname, 'public', 'mod-log.html')));

// Public Rules page: the stance that open + transparent never means anything goes
// (illegal activity is not allowed). Open to everyone, logged in or out.
app.get('/rules', (req, res) => sendPage(res, path.join(__dirname, 'public', 'rules.html')));

// Separate owner-only analytics page. The PAGE ITSELF is gated here server-side:
// a non-admin (or logged-out) visitor is bounced before the page even loads, and
// the analytics API it calls is independently admin-only. admin.html lives
// OUTSIDE public/ so it can never be served by the static handler. This is the
// "totally separate, admin-only" entrance, not a button in the normal app.
app.get('/admin', (req, res) => {
  if (!req.user) return res.redirect('/');
  if (!req.user.is_admin) return res.redirect('/app');
  sendPage(res, path.join(__dirname, 'admin.html'));
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
      // Onboarding: send the OpenBook welcome message to any existing member who has
      // not received it yet (idempotent, runs in the background, never re-sends).
      try { require('./welcome').backfillWelcomes().catch((e) => logger.warn({ err: e }, 'welcome backfill failed')); } catch (e) { logger.error({ err: e }, 'failed to start welcome backfill'); }
      // Cleanup: permanently remove accounts that never verified their email within
      // the grace window (only runs while email verification is enforced).
      try { require('./unverified-cleanup').startUnverifiedCleanupJob(); } catch (e) { logger.error({ err: e }, 'failed to start unverified cleanup job'); }
      // Publish any new OpenBook changelog posts (idempotent), so followers see what
      // shipped on the official account's public feed.
      try { require('./changelog').publishChangelog().catch((e) => logger.warn({ err: e }, 'changelog publish failed')); } catch (e) { logger.error({ err: e }, 'failed to publish changelog'); }
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
