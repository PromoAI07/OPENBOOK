// db.js
// Database setup and schema for OpenBook.
// Uses Node's built-in SQLite (node:sqlite), a single local file database
// (openbook.db) with no native build step required.
// Everything the app stores (users, posts, friends, chat, stories) lives here.
// The DatabaseSync API (prepare/get/all/run/exec) matches what the rest of the
// app expects.

const path = require('path');
const { DatabaseSync } = require('node:sqlite');

// DATA_DIR lets a host put the database on a persistent volume; defaults to the
// project folder for local development.
const DATA_DIR = process.env.DATA_DIR || __dirname;
const db = new DatabaseSync(path.join(DATA_DIR, 'openbook.db'));

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

// Clear out sessions older than 30 days on startup.
db.exec("DELETE FROM sessions WHERE created_at < datetime('now', '-30 days');");

module.exports = db;
