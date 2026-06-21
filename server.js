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

const app = express();
// Trust the hosting platform's reverse proxy so secure cookies and client IPs
// (used by the rate limiter) are detected correctly once deployed.
app.set('trust proxy', 1);
const server = http.createServer(app);
const io = new Server(server);

// Let the notification helper and chat handlers use the live io instance.
setIO(io);
initSockets(io);

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

// Throttle auth attempts to slow brute force and signup abuse.
const authLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
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

// The authenticated single page app shell.
app.get('/app', (req, res) => res.sendFile(path.join(__dirname, 'public', 'app.html')));

// Central error handler so upload errors and the like return clean JSON.
app.use((err, req, res, next) => {
  const status = err.status || (err.name === 'MulterError' ? 400 : 500);
  const message = err.code === 'LIMIT_FILE_SIZE'
    ? 'File is too large (images max 8 MB, reels max 60 MB)'
    : (err.message || 'Something went wrong');
  if (status >= 500) console.error('[error]', err.message);
  res.status(status).json({ error: message });
});

// Never let one stray async error take down the whole server for everyone.
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e && e.message));
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e && (e.message || e)));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('OpenBook is running at http://localhost:' + PORT);
});
