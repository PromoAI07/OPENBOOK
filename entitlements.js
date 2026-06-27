// entitlements.js
// Supporter tiers and the perks each one unlocks. This is the single source of
// truth for "what does a paying supporter get".
//
// CREDIBLE-NEUTRALITY GUARDRAIL (the whole reason OpenBook exists): a tier may
// only grant COSMETIC, CAPACITY, and CONVENIENCE perks. A tier must NEVER touch
// karma, standing, reach_score, feed ranking, or voting weight. Money (and
// referral rewards, which grant free tier time) can support the project and
// unlock a badge or more upload room, but they can never buy a place in the feed
// or extra weight in a community vote. Nothing in this file imports or changes
// trust.js / ranking.js, by design.
//
// Payment is not wired yet. Tiers are granted by admins (routes/admin.js) and,
// soon, as free months by the referral system. The grant path is the same
// (grantTier), so billing will just call grantTier on a successful charge.
//
// The grant/audit helpers (grantTier, revokeTier, extendTier, effectiveSnapshot,
// logEvent) write to the networked database and are async. The pure read helpers
// (effectiveTier, publicTierFields, entitlementsFor, tierList, storageLimitBytes,
// tierConfig) take a user object that the caller already loaded and stay sync.

const db = require('./db');

// Tier 0 = free. 1 = Supporter ($1), 2 = Plus ($3), 3 = Premium ($10).
// `verified` = the blue tick (paid-only). `badge` = the colored supporter badge.
// `adFree` is an entitlement flag for when/if optional ads ever exist.
// `perks` is the human-readable list shown on the upgrade page.
const TIERS = {
  0: {
    tier: 0, name: 'Free', price: 0, badge: null, verified: false, adFree: false,
    customization: 'none',
    perks: ['Full access to OpenBook', 'Your data is never sold, ever', 'A vote on big changes'],
  },
  1: {
    tier: 1, name: 'Supporter', price: 1, badge: 'bronze', verified: true, adFree: false,
    customization: 'accent',
    perks: ['Blue verified tick', 'Bronze Supporter badge', '1 GB of media storage', 'A profile accent color', 'Your name in the supporters credits', 'Early access to new features'],
  },
  2: {
    tier: 2, name: 'Plus', price: 3, badge: 'silver', verified: true, adFree: true,
    customization: 'themes',
    perks: ['Everything in Supporter', 'Silver badge', '3 GB of media storage', 'Ad-free, forever (if ads ever launch)', 'Bigger uploads (250 MB per file)', 'Profile themes'],
  },
  3: {
    tier: 3, name: 'Premium', price: 10, badge: 'gold', verified: true, adFree: true,
    customization: 'full',
    perks: ['Everything in Plus', 'Gold badge', '10 GB of media storage', 'Full profile customization', 'Largest uploads (1 GB per file)', 'Pro analytics', 'Propose features first'],
  },
};

function tierConfig(tier) {
  return TIERS[Math.max(0, Math.min(3, tier | 0))] || TIERS[0];
}

// Total stored-media cap per effective tier, in GB, indexed 0..3. This is a pure
// CAPACITY perk ("pay for extra storage"), never influence. The upload pipeline
// (upload.js) checks a user's SUM(bytes) against this before accepting a file.
// Overridable via env so the floor can be tuned without a deploy.
const TIER_STORAGE_GB = [
  Number(process.env.STORAGE_GB_FREE || 0.25),    // Free: 250 MB
  Number(process.env.STORAGE_GB_SUPPORTER || 1),  // Supporter: 1 GB
  Number(process.env.STORAGE_GB_PLUS || 3),       // Plus: 3 GB
  Number(process.env.STORAGE_GB_PREMIUM || 10),   // Premium: 10 GB
];
function storageLimitBytes(user) {
  const t = effectiveTier(user || {});
  const gb = TIER_STORAGE_GB[Math.max(0, Math.min(3, t))] || TIER_STORAGE_GB[0];
  return Math.round(gb * 1024 * 1024 * 1024);
}

function parseTs(ts) {
  if (!ts) return null;
  const ms = Date.parse(String(ts).indexOf('T') >= 0 ? ts : String(ts).replace(' ', 'T') + 'Z');
  return isNaN(ms) ? null : ms;
}

// The user's effective tier RIGHT NOW: drops to 0 if their supporter time has
// lapsed. supporter_expires NULL means a permanent grant.
function effectiveTier(user) {
  if (!user) return 0;
  const t = user.supporter_tier | 0;
  if (t <= 0) return 0;
  const exp = parseTs(user.supporter_expires);
  if (exp != null && exp < Date.now()) return 0;
  return Math.min(3, t);
}

// Compact fields safe to attach to ANY public user object (drives the tick +
// badge in the UI). Never includes anything reach/standing related.
function publicTierFields(user) {
  const t = effectiveTier(user);
  const cfg = tierConfig(t);
  return { tier: t, tierName: cfg.name, verified: cfg.verified, badge: cfg.badge };
}

// The full entitlement set for the owner (dashboard / upgrade page).
function entitlementsFor(user) {
  const t = effectiveTier(user);
  const cfg = tierConfig(t);
  return {
    tier: t,
    tierName: cfg.name,
    verified: cfg.verified,
    badge: cfg.badge,
    adFree: cfg.adFree,
    customization: cfg.customization,
    perks: cfg.perks,
    since: user && user.supporter_since ? user.supporter_since : null,
    expires: user && user.supporter_expires ? user.supporter_expires : null,
  };
}

// The list shown on the upgrade / support page.
function tierList() {
  return [1, 2, 3].map((t) => {
    const c = TIERS[t];
    return { tier: c.tier, name: c.name, price: c.price, badge: c.badge, perks: c.perks };
  });
}

// Grant (or change) a user's tier. days > 0 sets an expiry that many days out;
// days falsy = permanent (expires NULL). tier 0 clears supporter status. This is
// the ONE write path, shared by admin grants, the referral system, and (later)
// billing webhooks, so the rules live in one place.
async function grantTier(userId, tier, days, cause) {
  tier = Math.max(0, Math.min(3, tier | 0));
  if (tier === 0) {
    await db.prepare('UPDATE users SET supporter_tier = 0, supporter_expires = NULL WHERE id = ?').run(userId);
    await logEvent(userId, 0, days, cause);
    return effectiveSnapshot(userId);
  }
  if (days && Number(days) > 0) {
    await db.prepare(
      "UPDATE users SET supporter_tier = ?, supporter_since = COALESCE(supporter_since, datetime('now')), supporter_expires = datetime('now', ?) WHERE id = ?"
    ).run(tier, '+' + (Number(days) | 0) + ' days', userId);
  } else {
    await db.prepare(
      "UPDATE users SET supporter_tier = ?, supporter_since = COALESCE(supporter_since, datetime('now')), supporter_expires = NULL WHERE id = ?"
    ).run(tier, userId);
  }
  await logEvent(userId, tier, days, cause);
  return effectiveSnapshot(userId);
}

async function revokeTier(userId, cause) {
  return grantTier(userId, 0, 0, cause || 'revoked');
}

// Extend supporter time without ever SHORTENING it: the new expiry is `days`
// added to the later of (now, current unexpired expiry), and the tier becomes
// the higher of the current effective tier and the granted tier. Used by the
// referral system to grant free months (and reusable by billing renewals), so a
// reward can never accidentally cut someone's existing paid time short.
async function extendTier(userId, tier, days, cause) {
  tier = Math.max(0, Math.min(3, tier | 0));
  const u = await db.prepare('SELECT supporter_tier, supporter_expires FROM users WHERE id = ?').get(userId);
  if (!u) return null;
  const now = Date.now();
  let baseMs = now;
  const exp = parseTs(u.supporter_expires);
  if (exp != null && exp > now) baseMs = exp;
  const newExpiresMs = baseMs + (Number(days) || 0) * 86400000;
  const newTier = Math.max(effectiveTier(u), tier);
  const iso = new Date(newExpiresMs).toISOString().replace('T', ' ').slice(0, 19);
  await db.prepare("UPDATE users SET supporter_tier = ?, supporter_since = COALESCE(supporter_since, datetime('now')), supporter_expires = ? WHERE id = ?")
    .run(newTier, iso, userId);
  await logEvent(userId, newTier, days, cause);
  return effectiveSnapshot(userId);
}

// Lightweight audit of tier changes (transparency; separate from trust_events so
// the reputation audit trail stays purely karma/standing).
async function logEvent(userId, tier, days, cause) {
  try {
    await db.prepare('INSERT INTO supporter_events (user_id, tier, days, cause) VALUES (?, ?, ?, ?)')
      .run(userId, tier, days ? (Number(days) | 0) : null, String(cause || ''));
  } catch (e) { /* table is created in db.js; never let auditing break a grant */ }
}

async function effectiveSnapshot(userId) {
  const u = await db.prepare('SELECT supporter_tier, supporter_since, supporter_expires FROM users WHERE id = ?').get(userId);
  return entitlementsFor(u || {});
}

module.exports = {
  TIERS, tierConfig, effectiveTier, publicTierFields, entitlementsFor,
  tierList, grantTier, revokeTier, extendTier,
  TIER_STORAGE_GB, storageLimitBytes,
};
