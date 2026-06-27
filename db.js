// db.js
// Database setup and schema for OpenBook.
// Uses Node's built-in SQLite (node:sqlite), a single local file database
// (openbook.db) with no native build step required.
// Everything the app stores (users, posts, friends, chat, stories) lives here.
// The DatabaseSync API (prepare/get/all/run/exec) matches what the rest of the
// app expects.

const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { logger, DB_SLOW_MS } = require('./logger');

// DATA_DIR lets a host put the database on a persistent volume; defaults to the
// project folder for local development.
const DATA_DIR = process.env.DATA_DIR || __dirname;
const dbPath = path.join(DATA_DIR, 'openbook.db');
// Loud diagnostic so the Render logs make persistence obvious. In production
// without DATA_DIR, the database sits on EPHEMERAL storage and is wiped on every
// redeploy/restart even if a paid disk is attached, because nothing points at it.
if (process.env.NODE_ENV === 'production' && !process.env.DATA_DIR) {
  logger.warn({ dbPath },
    'DATA_DIR is NOT set: the database is on EPHEMERAL storage and WILL be wiped on every redeploy. ' +
    'Set the DATA_DIR env var to your Render disk mount path (e.g. /data) so data persists.');
} else {
  logger.info({ dbPath, persistent: !!process.env.DATA_DIR }, 'database location');
}
const db = new DatabaseSync(dbPath);

// WAL mode is faster and handles concurrent reads well.
db.exec('PRAGMA journal_mode = WAL;');
// Enforce foreign keys so deleting a user cleans up their data.
db.exec('PRAGMA foreign_keys = ON;');
// Wait up to 5 seconds on a locked database instead of throwing immediately.
db.exec('PRAGMA busy_timeout = 5000;');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT    NOT NULL,
    email         TEXT    NOT NULL UNIQUE,
    password_hash TEXT    NOT NULL,
    bio           TEXT    NOT NULL DEFAULT '',
    avatar        TEXT    NOT NULL DEFAULT '',
    cover         TEXT    NOT NULL DEFAULT '',
    created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL,
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS posts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    content    TEXT    NOT NULL DEFAULT '',
    image      TEXT    NOT NULL DEFAULT '',
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS likes (
    user_id    INTEGER NOT NULL,
    post_id    INTEGER NOT NULL,
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, post_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS comments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id    INTEGER NOT NULL,
    user_id    INTEGER NOT NULL,
    content    TEXT    NOT NULL,
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS friendships (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    requester_id INTEGER NOT NULL,
    addressee_id INTEGER NOT NULL,
    status       TEXT    NOT NULL DEFAULT 'pending',
    created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE (requester_id, addressee_id),
    FOREIGN KEY (requester_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (addressee_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    actor_id   INTEGER NOT NULL,
    type       TEXT    NOT NULL,
    post_id    INTEGER,
    is_read    INTEGER NOT NULL DEFAULT 0,
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS stories (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    image      TEXT    NOT NULL,
    caption    TEXT    NOT NULL DEFAULT '',
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS messages (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id    INTEGER NOT NULL,
    recipient_id INTEGER NOT NULL,
    content      TEXT    NOT NULL,
    is_read      INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (sender_id)    REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (recipient_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_posts_user      ON posts(user_id);
  CREATE INDEX IF NOT EXISTS idx_comments_post   ON comments(post_id);
  CREATE INDEX IF NOT EXISTS idx_likes_post      ON likes(post_id);
  CREATE INDEX IF NOT EXISTS idx_notif_user      ON notifications(user_id);
  CREATE INDEX IF NOT EXISTS idx_messages_pair   ON messages(sender_id, recipient_id);
  CREATE INDEX IF NOT EXISTS idx_stories_user    ON stories(user_id);
`);

// Feature tables: groups, photo albums, and marketplace listings.
db.exec(`
  CREATE TABLE IF NOT EXISTS groups (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    description TEXT    NOT NULL DEFAULT '',
    cover       TEXT    NOT NULL DEFAULT '',
    privacy     TEXT    NOT NULL DEFAULT 'public',
    creator_id  INTEGER NOT NULL,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (creator_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS group_members (
    group_id   INTEGER NOT NULL,
    user_id    INTEGER NOT NULL,
    role       TEXT    NOT NULL DEFAULT 'member',
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (group_id, user_id),
    FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id)  REFERENCES users(id)  ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS albums (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    title      TEXT    NOT NULL,
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS album_photos (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    album_id   INTEGER NOT NULL,
    image      TEXT    NOT NULL,
    caption    TEXT    NOT NULL DEFAULT '',
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (album_id) REFERENCES albums(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS listings (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    seller_id   INTEGER NOT NULL,
    title       TEXT    NOT NULL,
    description TEXT    NOT NULL DEFAULT '',
    price       REAL    NOT NULL DEFAULT 0,
    category    TEXT    NOT NULL DEFAULT 'General',
    location    TEXT    NOT NULL DEFAULT '',
    image       TEXT    NOT NULL DEFAULT '',
    status      TEXT    NOT NULL DEFAULT 'available',
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (seller_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members(user_id);
  CREATE INDEX IF NOT EXISTS idx_albums_user        ON albums(user_id);
  CREATE INDEX IF NOT EXISTS idx_album_photos_album ON album_photos(album_id);
  CREATE INDEX IF NOT EXISTS idx_listings_seller    ON listings(seller_id);
`);

// Migration: posts can belong to a group. Add the column if an older database
// predates this feature, then index it.
try {
  const cols = db.prepare('PRAGMA table_info(posts)').all();
  if (!cols.some((c) => c.name === 'group_id')) {
    db.exec('ALTER TABLE posts ADD COLUMN group_id INTEGER');
  }
} catch (e) {
  try { db.exec('ALTER TABLE posts ADD COLUMN group_id INTEGER'); } catch (e2) { /* already present */ }
}
db.exec('CREATE INDEX IF NOT EXISTS idx_posts_group ON posts(group_id)');

// --- Phase 0: reputation scaffolding (see SPEC.md) ---
// Two separate scores per user: karma (social, drives ranking only) and
// standing (trust/safety, drives privileges and the shadowban trigger). Plus a
// trust_level (TL0..TL4) and a reach_score multiplier used at ranking time.
function addColumn(table, colDef, colName) {
  try {
    const cols = db.prepare('PRAGMA table_info(' + table + ')').all();
    if (!cols.some((c) => c.name === colName)) db.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + colDef);
  } catch (e) {
    try { db.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + colDef); } catch (e2) { /* already present */ }
  }
}
addColumn('users', 'karma INTEGER NOT NULL DEFAULT 0', 'karma');
addColumn('users', 'standing INTEGER NOT NULL DEFAULT 100', 'standing');
addColumn('users', 'reach_score REAL NOT NULL DEFAULT 1.0', 'reach_score');
addColumn('users', 'trust_level INTEGER NOT NULL DEFAULT 0', 'trust_level');

// Full audit trail for every standing/karma change (the transparency backbone).
db.exec(`
  CREATE TABLE IF NOT EXISTS trust_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    score      TEXT    NOT NULL DEFAULT 'standing',
    delta      INTEGER NOT NULL,
    cause      TEXT    NOT NULL,
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_trust_events_user ON trust_events(user_id);
`);

// --- Phase 1: communities, voting, threaded comments (see SPEC.md) ---
db.exec(`
  CREATE TABLE IF NOT EXISTS communities (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL UNIQUE,
    description TEXT    NOT NULL DEFAULT '',
    rules       TEXT    NOT NULL DEFAULT '',
    icon        TEXT    NOT NULL DEFAULT '',
    privacy     TEXT    NOT NULL DEFAULT 'public',
    creator_id  INTEGER NOT NULL,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (creator_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS community_members (
    community_id INTEGER NOT NULL,
    user_id      INTEGER NOT NULL,
    role         TEXT    NOT NULL DEFAULT 'member',
    created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (community_id, user_id),
    FOREIGN KEY (community_id) REFERENCES communities(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id)      REFERENCES users(id)       ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS votes (
    user_id     INTEGER NOT NULL,
    target_type TEXT    NOT NULL,
    target_id   INTEGER NOT NULL,
    value       INTEGER NOT NULL,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, target_type, target_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_community_members_user ON community_members(user_id);
  CREATE INDEX IF NOT EXISTS idx_votes_target ON votes(target_type, target_id);
`);

// Posts can also belong to a community and carry a title, type, link, and a
// visibility flag (the last is used by Phase 4 moderation). Comments can nest.
addColumn('posts', 'community_id INTEGER', 'community_id');
addColumn('posts', "title TEXT NOT NULL DEFAULT ''", 'title');
addColumn('posts', "type TEXT NOT NULL DEFAULT 'text'", 'type');
addColumn('posts', "url TEXT NOT NULL DEFAULT ''", 'url');
addColumn('posts', "visibility TEXT NOT NULL DEFAULT 'visible'", 'visibility');
// Audience for a personal post: 'public' (anyone, shows in Discover) or 'friends'
// (accepted friends + author only). Existing posts default to 'friends' so nothing
// already shared privately is retroactively exposed; the composer defaults new
// posts to 'public'. Community/group posts ignore this (their own privacy rules
// in visibility.js apply).
addColumn('posts', "audience TEXT NOT NULL DEFAULT 'friends'", 'audience');
addColumn('comments', 'parent_id INTEGER', 'parent_id');
addColumn('comments', "visibility TEXT NOT NULL DEFAULT 'visible'", 'visibility');
db.exec('CREATE INDEX IF NOT EXISTS idx_posts_community ON posts(community_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_comments_parent ON comments(parent_id)');

// --- Reactions (Facebook-style) and post edit history ---
db.exec(`
  CREATE TABLE IF NOT EXISTS reactions (
    user_id     INTEGER NOT NULL,
    target_type TEXT    NOT NULL,
    target_id   INTEGER NOT NULL,
    type        TEXT    NOT NULL,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, target_type, target_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_reactions_target ON reactions(target_type, target_id);

  CREATE TABLE IF NOT EXISTS post_edits (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id     INTEGER NOT NULL,
    title       TEXT    NOT NULL DEFAULT '',
    content     TEXT    NOT NULL DEFAULT '',
    replaced_at TEXT    NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_post_edits_post ON post_edits(post_id);
`);
addColumn('posts', 'edit_count INTEGER NOT NULL DEFAULT 0', 'edit_count');
addColumn('posts', 'edited_at TEXT', 'edited_at');

// --- Phase 2: feeds + ranking (see SPEC.md section 7, ranking.js) ---
// Each vote stores the voter's trust weight at cast time, so ranking can use
// trust-weighted "effective" votes (a brand-new account barely moves the rank)
// while the raw count still drives the visible score and karma. Pre-Phase-2
// votes default to full weight (1), which is the right neutral behaviour.
addColumn('votes', 'weight REAL NOT NULL DEFAULT 1', 'weight');
db.exec('CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at)');

// Carry existing likes over as 'like' reactions (idempotent; safe every boot).
try {
  db.exec("INSERT OR IGNORE INTO reactions (user_id, target_type, target_id, type, created_at) SELECT user_id, 'post', post_id, 'like', created_at FROM likes");
} catch (e) { /* likes table may be absent in a brand new database */ }

// --- Reels: short vertical videos (Facebook/TikTok-style) ---
// Likes reuse the generic reactions table (target_type = 'reel', type = 'like').
db.exec(`
  CREATE TABLE IF NOT EXISTS reels (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    video      TEXT    NOT NULL,
    caption    TEXT    NOT NULL DEFAULT '',
    views      INTEGER NOT NULL DEFAULT 0,
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS reel_comments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    reel_id    INTEGER NOT NULL,
    user_id    INTEGER NOT NULL,
    content    TEXT    NOT NULL,
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (reel_id) REFERENCES reels(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_reels_created      ON reels(created_at);
  CREATE INDEX IF NOT EXISTS idx_reel_comments_reel ON reel_comments(reel_id);
`);

// --- Username history (public trail of old display names) ---
// Display-name changes are rate-limited (see routes/users.js) and each change
// records the previous name here, so anyone viewing a profile can see what the
// person used to be called.
db.exec(`
  CREATE TABLE IF NOT EXISTS name_history (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    old_name   TEXT    NOT NULL,
    changed_at TEXT    NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_name_history_user ON name_history(user_id);
`);

// --- Analytics: a per-post view counter (opens of the post detail) ---
addColumn('posts', 'views INTEGER NOT NULL DEFAULT 0', 'views');

// --- Email verification (soft gate: browse freely, verify to post) ---
// New signups start unverified; accounts that existed before this feature are
// grandfathered as verified once (so the gate only applies going forward).
{
  const cols = db.prepare('PRAGMA table_info(users)').all();
  if (!cols.some((c) => c.name === 'email_verified')) {
    db.exec('ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0');
    db.exec('UPDATE users SET email_verified = 1');
  }
}
addColumn('users', 'verify_token TEXT', 'verify_token');

// --- Password reset (forgot password) ---
// A one-time token + expiry, set when a reset is requested and cleared once the
// password is changed. Delivered by the same mailer as verification.
addColumn('users', 'reset_token TEXT', 'reset_token');
addColumn('users', 'reset_expires TEXT', 'reset_expires');

// --- Phase 3/4: moderation, reports, bans, appeals, shadowban ---
// Moderation power is distributed: post creators moderate their own threads,
// community mods moderate their community, platform admins handle only sitewide
// issues. Every action is logged (mod_actions), confirmed removals lower the
// author's standing (which the reach engine in trust.js turns into a graduated
// shadowban), and affected users are notified and can appeal. Nothing here is
// driven by votes, only by confirmed actions.
addColumn('users', 'is_admin INTEGER NOT NULL DEFAULT 0', 'is_admin');
// Founder badge flag (cosmetic). Synced from FOUNDER_EMAILS at boot (see below).
addColumn('users', 'is_founder INTEGER NOT NULL DEFAULT 0', 'is_founder');
// Focal point (object-position) for the avatar + cover, so users can drag-position
// their photos like Facebook. Stored as a CSS position string, e.g. "50% 30%".
addColumn('users', "avatar_pos TEXT NOT NULL DEFAULT '50% 50%'", 'avatar_pos');
addColumn('users', "cover_pos TEXT NOT NULL DEFAULT '50% 50%'", 'cover_pos');
addColumn('posts', 'locked INTEGER NOT NULL DEFAULT 0', 'locked');   // comments locked
addColumn('posts', 'pinned INTEGER NOT NULL DEFAULT 0', 'pinned');   // pinned in its community

db.exec(`
  CREATE TABLE IF NOT EXISTS reports (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    reporter_id INTEGER NOT NULL,
    target_type TEXT    NOT NULL,
    target_id   INTEGER NOT NULL,
    reason_code TEXT    NOT NULL,
    detail      TEXT    NOT NULL DEFAULT '',
    status      TEXT    NOT NULL DEFAULT 'open',
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (reporter_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);
  CREATE INDEX IF NOT EXISTS idx_reports_target ON reports(target_type, target_id);

  CREATE TABLE IF NOT EXISTS mod_actions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id     INTEGER NOT NULL,
    action       TEXT    NOT NULL,
    target_type  TEXT    NOT NULL,
    target_id    INTEGER NOT NULL,
    community_id INTEGER,
    reason       TEXT    NOT NULL DEFAULT '',
    is_public    INTEGER NOT NULL DEFAULT 1,
    created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_mod_actions_comm ON mod_actions(community_id);

  CREATE TABLE IF NOT EXISTS community_bans (
    community_id INTEGER NOT NULL,
    user_id      INTEGER NOT NULL,
    reason       TEXT    NOT NULL DEFAULT '',
    created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (community_id, user_id),
    FOREIGN KEY (community_id) REFERENCES communities(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id)      REFERENCES users(id)       ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS appeals (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL,
    mod_action_id INTEGER,
    message       TEXT    NOT NULL DEFAULT '',
    status        TEXT    NOT NULL DEFAULT 'open',
    created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_appeals_status ON appeals(status);
`);

// Appeals can reference the specific content they are about, so an admin
// "reverse" can restore that content and the standing it cost.
addColumn('appeals', 'target_type TEXT', 'target_type');
addColumn('appeals', 'target_id INTEGER', 'target_id');

// --- Phase 5: anti-sybil (see SPEC.md section 5, antisybil.js) ---
// devices: a coarse client fingerprint + IP per account, so concentration (many
// accounts on one device/IP) can raise a soft flag. We never hard-block on this.
// sybil_flags: the review queue the background vote-ring job and signup-risk
// checks write to. Auto-actions stay gentle and appealable (logged in
// trust_events); confirmed bans remain a separate, human moderation decision.
db.exec(`
  CREATE TABLE IF NOT EXISTS devices (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL,
    fingerprint TEXT    NOT NULL DEFAULT '',
    ip          TEXT    NOT NULL DEFAULT '',
    first_seen  TEXT    NOT NULL DEFAULT (datetime('now')),
    last_seen   TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE (user_id, fingerprint),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_devices_fp ON devices(fingerprint);
  CREATE INDEX IF NOT EXISTS idx_devices_ip ON devices(ip);

  CREATE TABLE IF NOT EXISTS sybil_flags (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    kind       TEXT    NOT NULL,
    detail     TEXT    NOT NULL DEFAULT '',
    score      REAL    NOT NULL DEFAULT 0,
    status     TEXT    NOT NULL DEFAULT 'open',
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_sybil_flags_user   ON sybil_flags(user_id);
  CREATE INDEX IF NOT EXISTS idx_sybil_flags_status ON sybil_flags(status);
`);

// --- Supporter tiers (entitlements; see entitlements.js) ---
// Tier is cosmetic + capacity + convenience ONLY. It NEVER affects karma,
// standing, reach_score, or voting weight (credible neutrality: money cannot buy
// influence over the feed or the vote). supporter_expires NULL = permanent.
// Payment wiring comes later; for now tiers are admin-grantable and will also be
// granted as free months by the referral system.
addColumn('users', 'supporter_tier INTEGER NOT NULL DEFAULT 0', 'supporter_tier');
addColumn('users', 'supporter_since TEXT', 'supporter_since');
addColumn('users', 'supporter_expires TEXT', 'supporter_expires');

// A small, separate audit of tier grants/changes (kept apart from trust_events
// so the karma/standing reputation trail stays clean).
db.exec(`
  CREATE TABLE IF NOT EXISTS supporter_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    tier       INTEGER NOT NULL,
    days       INTEGER,
    cause      TEXT    NOT NULL DEFAULT '',
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_supporter_events_user ON supporter_events(user_id);
`);

// --- Referral system (see referrals.js) ---
// Each user gets a referral_code; new signups can carry ?ref=<code> which sets
// referred_by and opens a pending referrals row. A referral only "qualifies"
// once the invited account proves it is a real, retained human (account age +
// real activity + healthy standing + a distinct device from the referrer, all
// reusing the Phase 5 trust/anti-sybil signals). Every 5 qualified referrals
// grants the referrer one free month of Premium via entitlements.grantTier;
// referral_rewards_granted tracks how many months were already paid out so we
// never double-grant. Referral rewards are tier time only, never karma/standing.
addColumn('users', 'referral_code TEXT', 'referral_code');
addColumn('users', 'referred_by INTEGER', 'referred_by');
addColumn('users', 'referral_rewards_granted INTEGER NOT NULL DEFAULT 0', 'referral_rewards_granted');
db.exec(`
  CREATE TABLE IF NOT EXISTS referrals (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    referrer_id  INTEGER NOT NULL,
    invitee_id   INTEGER NOT NULL UNIQUE,
    status       TEXT    NOT NULL DEFAULT 'pending',
    created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
    qualified_at TEXT,
    FOREIGN KEY (referrer_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (invitee_id)  REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_id);
  CREATE INDEX IF NOT EXISTS idx_referrals_status   ON referrals(status);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_referral_code ON users(referral_code) WHERE referral_code IS NOT NULL;
`);

// --- Owner analytics (privacy-conscious, aggregate) ---
// Coarse usage events for the admin dashboard only: page views, button clicks,
// and visibility heartbeats (to estimate time on platform). We store an internal
// user_id (nullable) + an opaque session id + a short label (a view name or a
// button id), never message content or any personal data. Old events are pruned.
db.exec(`
  CREATE TABLE IF NOT EXISTS analytics_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER,
    session_id TEXT    NOT NULL DEFAULT '',
    type       TEXT    NOT NULL,
    label      TEXT    NOT NULL DEFAULT '',
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_analytics_type_time ON analytics_events(type, created_at);
  CREATE INDEX IF NOT EXISTS idx_analytics_session   ON analytics_events(session_id);
`);
// Keep the analytics table from growing without bound.
db.exec("DELETE FROM analytics_events WHERE created_at < datetime('now', '-90 days');");

// --- Media lifecycle: one row per uploaded object reference (see media/cleanup.js) ---
// Every successful upload records (user_id, storage key, byte size) here. This is
// the backbone of three promises at once:
//   1. Real deletion. When a post/photo/reel is deleted we remove its row; the
//      underlying storage object is deleted only when the LAST row for that key
//      is gone (so content-addressed dedupe across users is safe).
//   2. Storage quota. A user's footprint is SUM(bytes) over their rows, which the
//      upload pipeline checks against their tier cap.
//   3. Account wipe. Deleting an account deletes every object the user owns.
db.exec(`
  CREATE TABLE IF NOT EXISTS user_media (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    key        TEXT    NOT NULL,
    bytes      INTEGER NOT NULL DEFAULT 0,
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_user_media_user ON user_media(user_id);
  CREATE INDEX IF NOT EXISTS idx_user_media_key  ON user_media(key);
`);

// --- Rich posts: colored/"imaged" text backgrounds, file attachments, polls ---
// bg: a background style id for short text-only posts (Facebook-style colored
// status). file_url/file_name: an attached document. Polls reuse posts.type='poll'
// with their options + votes in their own tables.
addColumn('posts', "bg TEXT NOT NULL DEFAULT ''", 'bg');
addColumn('posts', "file_url TEXT NOT NULL DEFAULT ''", 'file_url');
addColumn('posts', "file_name TEXT NOT NULL DEFAULT ''", 'file_name');
db.exec(`
  CREATE TABLE IF NOT EXISTS poll_options (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id   INTEGER NOT NULL,
    text      TEXT    NOT NULL,
    position  INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_poll_options_post ON poll_options(post_id);

  CREATE TABLE IF NOT EXISTS poll_votes (
    post_id    INTEGER NOT NULL,
    user_id    INTEGER NOT NULL,
    option_id  INTEGER NOT NULL,
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (post_id, user_id),
    FOREIGN KEY (post_id)   REFERENCES posts(id)        ON DELETE CASCADE,
    FOREIGN KEY (user_id)   REFERENCES users(id)        ON DELETE CASCADE,
    FOREIGN KEY (option_id) REFERENCES poll_options(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_poll_votes_post ON poll_votes(post_id);
`);

// --- Suggestion board (community-voted feature requests) ---
// Users suggest a fix/update/change; everyone up/down votes; the board is sorted
// by score so the most-wanted rise to the top. Admins mark status (planned,
// shipped, declined) to surface what is being built each cycle.
db.exec(`
  CREATE TABLE IF NOT EXISTS suggestions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    title      TEXT    NOT NULL,
    body       TEXT    NOT NULL DEFAULT '',
    category   TEXT    NOT NULL DEFAULT 'change',
    status     TEXT    NOT NULL DEFAULT 'open',
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_suggestions_status ON suggestions(status);

  CREATE TABLE IF NOT EXISTS suggestion_votes (
    suggestion_id INTEGER NOT NULL,
    user_id       INTEGER NOT NULL,
    value         INTEGER NOT NULL,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (suggestion_id, user_id),
    FOREIGN KEY (suggestion_id) REFERENCES suggestions(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id)       REFERENCES users(id)        ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_suggestion_votes_sug ON suggestion_votes(suggestion_id);
`);

// Platform admins are designated by the ADMIN_EMAILS env var (comma separated).
// The sync is two-way: when the list is set, clear all admin flags first and then
// re-grant, so removing an email from the list actually demotes that user. (When
// the env var is unset we leave existing flags untouched.)
try {
  const adminEmails = (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (adminEmails.length) {
    const ph = adminEmails.map(() => '?').join(',');
    db.exec('UPDATE users SET is_admin = 0');
    db.prepare('UPDATE users SET is_admin = 1 WHERE lower(email) IN (' + ph + ')').run(...adminEmails);
  }
} catch (e) { /* users table or column may not be ready on a brand new db */ }

// Founder badge: designate the platform founder(s) by email (FOUNDER_EMAILS, comma
// separated; defaults to the owner's account). Two-way sync like admins: clear all
// then set the listed ones, so removing an email also removes the badge. Cosmetic
// only (a badge next to the name); it never affects karma, standing, reach, or votes.
try {
  const founderEmails = (process.env.FOUNDER_EMAILS || 'nmservicesww@gmail.com')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (founderEmails.length) {
    const ph = founderEmails.map(() => '?').join(',');
    db.exec('UPDATE users SET is_founder = 0');
    db.prepare('UPDATE users SET is_founder = 1 WHERE lower(email) IN (' + ph + ')').run(...founderEmails);
  }
} catch (e) { /* column may not be ready on a brand new db */ }

// Clear out sessions older than 30 days on startup.
db.exec("DELETE FROM sessions WHERE created_at < datetime('now', '-30 days');");

// --- Query timing (observability only; no behavior change) ---
// Wrap prepared-statement get/all/run so any query at or above DB_SLOW_MS is
// logged with its timing and a short label. This is transparent: a Proxy times
// those three methods and passes every other property/method through untouched,
// so no call site changes and results are identical. Installed last so the
// one-time startup migrations above are not themselves timed.
function queryLabel(sql) {
  return String(sql).replace(/\s+/g, ' ').trim().slice(0, 120);
}
const _prepare = db.prepare.bind(db);
db.prepare = function (sql) {
  const stmt = _prepare(sql);
  return new Proxy(stmt, {
    get(target, prop) {
      const value = target[prop];
      if (typeof value !== 'function') return value;
      if (prop === 'get' || prop === 'all' || prop === 'run') {
        return function (...args) {
          const start = process.hrtime.bigint();
          const result = value.apply(target, args);
          const ms = Number(process.hrtime.bigint() - start) / 1e6;
          if (ms >= DB_SLOW_MS) {
            logger.warn({ ms: Math.round(ms * 10) / 10, op: prop, query: queryLabel(sql) }, 'slow query');
          }
          return result;
        };
      }
      return value.bind(target);
    },
  });
};

module.exports = db;
