// antisybil.js
// Phase 5: layered anti-sybil / multi-account defenses (SPEC.md section 5).
//
// The golden rule from the SPEC is "don't block, downweight." Blocking catches
// the wrong people (a real dissident on Tor looks suspicious), so the only HARD
// blocks here are the two cheap, unambiguous ones: disposable throwaway email
// domains, and a failed proof-of-work on signup. Everything else (device/IP
// concentration, coordinated vote rings) is FLAGGED for review and, at most,
// gently downweighted through the existing standing -> reach engine in trust.js,
// which is auditable (trust_events) and appealable. Nothing here is a silent ban.
//
// None of this touches karma or the ranking math; votes still drive ranking
// only. This module only affects standing/reach (safety) and rate limits.
//
// The device/flag/vote-ring helpers read or write the networked database and are
// async; the pure crypto/rate helpers (proof-of-work, disposable-email, in-memory
// rate window) stay synchronous.

const crypto = require('crypto');
const db = require('./db');
const { recordStandingEvent, QUARANTINE_AT } = require('./trust');
const { logger } = require('./logger');

// ---------------------------------------------------------------------------
// 1. Disposable-email gate (cheap throwaway inboxes => mass accounts).
// A built-in list of the most common providers, extendable via the
// DISPOSABLE_EMAIL_DOMAINS env (comma separated) with no code change.
// ---------------------------------------------------------------------------
const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com', 'guerrillamail.com', 'guerrillamail.info', 'sharklasers.com',
  '10minutemail.com', '10minutemail.net', 'tempmail.com', 'temp-mail.org',
  'throwawaymail.com', 'yopmail.com', 'getnada.com', 'nada.email', 'trashmail.com',
  'dispostable.com', 'maildrop.cc', 'fakeinbox.com', 'mailnesia.com', 'mintemail.com',
  'mohmal.com', 'tempr.email', 'discard.email', 'spam4.me', 'grr.la', 'guerrillamailblock.com',
  'tmpmail.org', 'emailondeck.com', 'mailcatch.com', 'moakt.com', 'tempinbox.com',
  'burnermail.io', 'mailtemp.net', 'tempmailo.com', 'mailto.plus', 'fexbox.org',
  'inboxkitten.com', 'tutanota_disposable.invalid', 'einrot.com', 'cuvox.de',
]);
(process.env.DISPOSABLE_EMAIL_DOMAINS || '')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  .forEach((d) => DISPOSABLE_DOMAINS.add(d));

function emailDomain(email) {
  const at = String(email || '').lastIndexOf('@');
  return at >= 0 ? String(email).slice(at + 1).toLowerCase().trim() : '';
}
function isDisposableEmail(email) {
  const d = emailDomain(email);
  return !!d && DISPOSABLE_DOMAINS.has(d);
}

// ---------------------------------------------------------------------------
// 2. Proof-of-work (a small "cost on creation" so mass signups are expensive).
// Hashcash style: the client must find a nonce so that
//   sha256(salt + ':' + nonce) starts with `difficulty` hex zeros.
// The salt is an HMAC(secret, ts.rand), so we can verify WE issued it and that
// it is fresh, with no storage at issue time. A small in-memory set of spent
// salts blocks replay within the TTL window. Difficulty 4 (about 65k hashes)
// is well under 100ms in JS yet adds real cost at scale; tune via env.
// ---------------------------------------------------------------------------
const POW_ENABLED = process.env.SIGNUP_POW !== '0';
const POW_SECRET = process.env.POW_SECRET || crypto.randomBytes(16).toString('hex');
const POW_DIFFICULTY = Math.max(1, Math.min(6, Number(process.env.SIGNUP_POW_DIFFICULTY || 4)));
const POW_TTL_MS = 10 * 60 * 1000;
const spentSalts = new Map(); // salt -> expiry(ms)

function sweepSpent() {
  const now = Date.now();
  for (const [salt, exp] of spentSalts) if (exp <= now) spentSalts.delete(salt);
}

function makeChallenge() {
  sweepSpent();
  const body = Date.now() + '.' + crypto.randomBytes(8).toString('hex');
  const sig = crypto.createHmac('sha256', POW_SECRET).update(body).digest('hex').slice(0, 16);
  return { salt: body + '.' + sig, difficulty: POW_DIFFICULTY, enabled: POW_ENABLED };
}

function saltIssuedByUs(salt) {
  const parts = String(salt || '').split('.');
  if (parts.length !== 3) return false;
  const [ts, rand, sig] = parts;
  const expect = crypto.createHmac('sha256', POW_SECRET).update(ts + '.' + rand).digest('hex').slice(0, 16);
  if (sig.length !== expect.length) return false;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return false;
  } catch (e) { return false; }
  const tsNum = Number(ts);
  return !!tsNum && Date.now() - tsNum <= POW_TTL_MS;
}

// Verify a solved challenge. Returns true on success and marks the salt spent.
function verifyPoW(salt, nonce) {
  if (!POW_ENABLED) return true;
  if (!saltIssuedByUs(salt)) return false;
  if (spentSalts.has(salt)) return false; // replay
  const h = crypto.createHash('sha256').update(salt + ':' + String(nonce)).digest('hex');
  if (!h.startsWith('0'.repeat(POW_DIFFICULTY))) return false;
  spentSalts.set(salt, Date.now() + POW_TTL_MS);
  return true;
}

// ---------------------------------------------------------------------------
// 2b. Optional CAPTCHA (Cloudflare Turnstile). OFF unless TURNSTILE_SECRET is
// set, so it is a no-op for the demo. When configured, the signup form sends a
// token we verify server-side. We fail OPEN on a verifier outage (return true)
// so a Cloudflare hiccup can never lock out real signups; PoW still applies.
// ---------------------------------------------------------------------------
const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET || '';
const TURNSTILE_ENABLED = !!TURNSTILE_SECRET;
async function verifyTurnstile(token, ip) {
  if (!TURNSTILE_ENABLED) return true;
  if (!token) return false;
  try {
    const body = new URLSearchParams({ secret: TURNSTILE_SECRET, response: String(token) });
    if (ip) body.append('remoteip', String(ip));
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body });
    const data = await r.json();
    return !!(data && data.success);
  } catch (e) {
    logger.warn({ err: e }, 'turnstile verify failed open');
    return true; // fail open: never block real users on a verifier outage
  }
}

// ---------------------------------------------------------------------------
// 3. Device + IP signals. We store a coarse client fingerprint and the IP per
// account so concentration (many accounts on one device/IP) can RAISE a flag.
// We never hard-block on these (VPN/Tor users are legitimate), per the SPEC.
// ---------------------------------------------------------------------------
async function recordDevice(userId, ip, fingerprint) {
  if (!userId) return;
  const fp = String(fingerprint || '').slice(0, 128) || 'none';
  const ipv = String(ip || '').slice(0, 64);
  try {
    const existing = await db.prepare('SELECT id FROM devices WHERE user_id = ? AND fingerprint = ?').get(userId, fp);
    if (existing) {
      await db.prepare("UPDATE devices SET last_seen = datetime('now'), ip = ? WHERE id = ?").run(ipv, existing.id);
    } else {
      await db.prepare('INSERT INTO devices (user_id, fingerprint, ip) VALUES (?, ?, ?)').run(userId, fp, ipv);
    }
  } catch (e) { /* never let device bookkeeping break a request */ }
}

async function accountsOnFingerprint(fp) {
  if (!fp || fp === 'none') return 0;
  return (await db.prepare('SELECT COUNT(DISTINCT user_id) n FROM devices WHERE fingerprint = ?').get(fp)).n;
}
async function accountsOnIp(ip) {
  if (!ip) return 0;
  return (await db.prepare("SELECT COUNT(DISTINCT user_id) n FROM devices WHERE ip = ? AND ip != ''").get(String(ip))).n;
}

// Record a sybil flag for review, deduped so the same kind is not re-logged for
// the same user within 24h. Returns true if a NEW flag was written.
async function flagUser(userId, kind, detail, score) {
  const recent = await db.prepare(
    "SELECT id FROM sybil_flags WHERE user_id = ? AND kind = ? AND created_at >= datetime('now','-1 day')"
  ).get(userId, kind);
  if (recent) return false;
  await db.prepare('INSERT INTO sybil_flags (user_id, kind, detail, score) VALUES (?, ?, ?, ?)')
    .run(userId, kind, String(detail || '').slice(0, 280), Number(score) || 0);
  return true;
}

// Raise a flag at signup if this device/IP already hosts several accounts. Soft
// only: we flag for review, we do not block the signup.
const SIGNUP_IP_FLAG_AT = Math.max(2, Number(process.env.SIGNUP_IP_FLAG_AT || 4));
const SIGNUP_FP_FLAG_AT = Math.max(2, Number(process.env.SIGNUP_FP_FLAG_AT || 3));
async function flagSignupRisk(userId, ip, fingerprint) {
  try {
    const fp = String(fingerprint || '').slice(0, 128) || 'none';
    const onFp = await accountsOnFingerprint(fp);
    const onIp = await accountsOnIp(ip);
    if (onFp >= SIGNUP_FP_FLAG_AT) await flagUser(userId, 'device_concentration', onFp + ' accounts on this device', onFp);
    else if (onIp >= SIGNUP_IP_FLAG_AT) await flagUser(userId, 'ip_concentration', onIp + ' accounts on this IP', onIp);
  } catch (e) { /* non-fatal */ }
}

// ---------------------------------------------------------------------------
// 4. Trust-gated downvotes. A brand-new account cannot downvote, which stops
// day-old sockpuppets from brigading. Upvotes and clearing a vote stay open.
// ---------------------------------------------------------------------------
const MIN_DOWNVOTE_TL = Math.max(0, Number(process.env.MIN_DOWNVOTE_TL == null ? 1 : process.env.MIN_DOWNVOTE_TL));
function canDownvote(trustLevel) {
  return (trustLevel | 0) >= MIN_DOWNVOTE_TL;
}

// ---------------------------------------------------------------------------
// 5. Trust-scaled rate limits. New accounts get tight caps on content creation;
// established accounts get generous ones. Numbers are roomy for any real human
// and only bite automated spam. In-memory sliding window (single instance; for
// horizontal scale move this to Redis).
// ---------------------------------------------------------------------------
const RATE = {
  // [ TL0, TL1, TL2, TL3+ ] => { n: max actions, ms: window }
  post: [ { n: 6, ms: 600000 }, { n: 20, ms: 600000 }, { n: 60, ms: 600000 }, { n: 200, ms: 600000 } ],
  comment: [ { n: 20, ms: 600000 }, { n: 60, ms: 600000 }, { n: 150, ms: 600000 }, { n: 500, ms: 600000 } ],
};
const hits = new Map(); // `${userId}:${action}` -> [timestamps]

function checkRate(userId, action, trustLevel) {
  const tiers = RATE[action];
  if (!tiers) return { ok: true };
  const tl = Math.max(0, Math.min(tiers.length - 1, trustLevel | 0));
  const { n, ms } = tiers[tl];
  const key = userId + ':' + action;
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < ms);
  if (arr.length >= n) {
    hits.set(key, arr);
    return { ok: false, retryMs: ms - (now - arr[0]) };
  }
  arr.push(now);
  hits.set(key, arr);
  return { ok: true };
}

// Express middleware factory: rate-limit a content action by the user's trust
// level. Must run after requireAuth. On limit, returns 429 with a friendly note.
// The returned middleware is async (it refreshes the trust level over the
// network); a DB hiccup falls through rather than blocking the request.
function trustRateLimit(action) {
  const { refreshTrustLevel } = require('./trust');
  return async function (req, res, next) {
    if (!req.user) return next(); // requireAuth handles the 401
    let tl = 0;
    try { tl = await refreshTrustLevel(req.user.id); } catch (e) { return next(); }
    const r = checkRate(req.user.id, action, tl);
    if (!r.ok) {
      const mins = Math.max(1, Math.round(r.retryMs / 60000));
      return res.status(429).json({
        error: 'You are doing that a bit fast. New accounts have a gentle limit that relaxes as your account ages. Try again in about ' + mins + ' minute' + (mins === 1 ? '' : 's') + '.',
        code: 'RATE_LIMITED',
      });
    }
    next();
  };
}

// ---------------------------------------------------------------------------
// 6. Vote-ring / burst-cluster detection (background job). Finds pairs of
// low-trust accounts created in the same burst window that vote the same way on
// the same targets far more than chance. This catches sockpuppet rings better
// than identity checks do. Conservative multi-condition test to avoid flagging
// real friends; the only auto-action is a small, capped, appealable standing
// nudge plus a flag for review (it can quarantine a persistent ring over time
// but never floors/shadowbans on suspicion alone, that needs confirmed mod
// action).
// ---------------------------------------------------------------------------
const RING_LOOKBACK_HOURS = Number(process.env.SYBIL_LOOKBACK_HOURS || 72);
const RING_MIN_SHARED = Math.max(3, Number(process.env.SYBIL_MIN_SHARED || 5));
const RING_BURST_HOURS = Number(process.env.SYBIL_BURST_HOURS || 48);
const RING_MAX_TL = Math.max(0, Number(process.env.SYBIL_MAX_TL == null ? 1 : process.env.SYBIL_MAX_TL));
const RING_PENALTY = Math.max(0, Number(process.env.SYBIL_PENALTY || 10));
const RING_PENALTY_FLOOR = QUARANTINE_AT; // suspicion alone never pushes below quarantine

async function detectVoteRings(opts) {
  opts = opts || {};
  const lookback = opts.lookbackHours || RING_LOOKBACK_HOURS;
  const minShared = opts.minShared || RING_MIN_SHARED;
  const burstHours = opts.burstHours || RING_BURST_HOURS;
  const maxTl = opts.maxTl == null ? RING_MAX_TL : opts.maxTl;

  const rows = await db.prepare(
    "SELECT v.user_id uid, v.target_type tt, v.target_id tid, v.value val, u.created_at ca, u.trust_level tl " +
    "FROM votes v JOIN users u ON u.id = v.user_id " +
    "WHERE v.created_at >= datetime('now', ?) ORDER BY v.created_at DESC LIMIT 8000"
  ).all('-' + lookback + ' hours');

  // Group voters by (target,value). Skip very popular targets: a big crowd
  // voting on the same hot post is normal, not a ring.
  const groups = new Map();
  for (const r of rows) {
    const key = r.tt + ':' + r.tid + ':' + r.val;
    let g = groups.get(key);
    if (!g) { g = []; groups.set(key, g); }
    g.push(r);
  }
  const meta = new Map(); // uid -> { ca, tl }
  const pair = new Map();  // "a|b" (a<b) -> shared count
  for (const g of groups.values()) {
    if (g.length < 2 || g.length > 200) continue;
    for (const r of g) if (!meta.has(r.uid)) meta.set(r.uid, { ca: r.ca, tl: r.tl });
    for (let i = 0; i < g.length; i++) {
      for (let j = i + 1; j < g.length; j++) {
        if (g[i].uid === g[j].uid) continue;
        const a = Math.min(g[i].uid, g[j].uid);
        const b = Math.max(g[i].uid, g[j].uid);
        const k = a + '|' + b;
        pair.set(k, (pair.get(k) || 0) + 1);
      }
    }
  }

  const found = [];
  for (const [k, shared] of pair) {
    if (shared < minShared) continue;
    const [a, b] = k.split('|').map(Number);
    const ma = meta.get(a);
    const mb = meta.get(b);
    if (!ma || !mb) continue;
    if (ma.tl > maxTl || mb.tl > maxTl) continue; // only suspect low-trust accounts
    const ta = Date.parse((ma.ca || '').replace(' ', 'T') + 'Z');
    const tb = Date.parse((mb.ca || '').replace(' ', 'T') + 'Z');
    if (isFinite(ta) && isFinite(tb) && Math.abs(ta - tb) > burstHours * 3600000) continue; // created together?
    found.push({ a, b, shared });
  }
  return found;
}

// Apply the conservative auto-action to a detected pair: flag both and nudge
// standing down, but never below quarantine on suspicion alone.
async function actOnRing(pairFound) {
  let acted = 0;
  for (const { a, b, shared } of pairFound) {
    for (const uid of [a, b]) {
      const isNew = await flagUser(uid, 'vote_ring', 'coordinated with user ' + (uid === a ? b : a) + ' on ' + shared + ' targets', shared);
      if (!isNew) continue; // already handled within 24h
      if (RING_PENALTY > 0) {
        const u = await db.prepare('SELECT standing FROM users WHERE id = ?').get(uid);
        if (u && u.standing > RING_PENALTY_FLOOR) {
          const delta = -Math.min(RING_PENALTY, u.standing - RING_PENALTY_FLOOR);
          if (delta < 0) await recordStandingEvent(uid, delta, 'sybil_ring_suspected');
        }
      }
      acted++;
    }
  }
  return acted;
}

let ringTimer = null;
async function runRingScan() {
  try {
    const found = await detectVoteRings();
    const acted = await actOnRing(found);
    if (found.length) logger.warn({ pairs: found.length, acted }, 'vote-ring scan flagged clusters');
    else logger.debug('vote-ring scan: nothing flagged');
  } catch (e) {
    logger.error({ err: e }, 'vote-ring scan failed');
  }
}

// Start the periodic background scan. No-op if SYBIL_JOB=0. Safe to call once at
// boot; not called by the unit tests (which invoke detectVoteRings directly).
function startSybilJobs() {
  if (process.env.SYBIL_JOB === '0') { logger.info('sybil background job disabled (SYBIL_JOB=0)'); return; }
  if (ringTimer) return;
  const everyMs = Math.max(60000, Number(process.env.SYBIL_JOB_MS || 30 * 60 * 1000));
  ringTimer = setInterval(runRingScan, everyMs);
  if (ringTimer.unref) ringTimer.unref(); // never keep the process alive just for this
  setTimeout(runRingScan, 60000).unref?.(); // first pass a minute after boot
  logger.info({ everyMs }, 'sybil background job started');
}

module.exports = {
  // disposable email
  isDisposableEmail, emailDomain,
  // proof of work
  POW_ENABLED, POW_DIFFICULTY, makeChallenge, verifyPoW, saltIssuedByUs,
  // captcha (optional)
  TURNSTILE_ENABLED, verifyTurnstile,
  // device / ip
  recordDevice, accountsOnFingerprint, accountsOnIp, flagSignupRisk, flagUser,
  // downvote gate
  MIN_DOWNVOTE_TL, canDownvote,
  // rate limits
  checkRate, trustRateLimit,
  // vote rings
  detectVoteRings, actOnRing, runRingScan, startSybilJobs,
};
