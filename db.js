// db.js
// Database setup and schema for OpenBook.
//
// OpenBook talks to a NETWORKED libSQL / Turso database instead of a local
// SQLite file on a Render disk. This lets Render deploy with zero downtime: the
// database no longer lives on a disk that must detach then re-attach between
// deploys, so there is no more "502 Bad Gateway" gap while a new version starts.
//
// The rest of the app still uses the familiar `db.prepare(sql).get/all/run(...)`
// and `db.exec(sql)` calls, but they are now ASYNCHRONOUS (they return Promises)
// because the database answers over the network, so every call site awaits them.
// db.init(), awaited once at server startup, builds the schema and runs the
// idempotent startup migrations.
//
// Connection:
//   - Production (Turso): set LIBSQL_URL=libsql://<db>-<org>.turso.io and
//     LIBSQL_AUTH_TOKEN=<token>.
//   - Local dev / fallback: a local file (file:openbook.db), no setup needed.

const path = require('path');
const { createClient } = require('@libsql/client');
const { logger, DB_SLOW_MS } = require('./logger');

const DATA_DIR = process.env.DATA_DIR || __dirname;
const localFileUrl = 'file:' + path.join(DATA_DIR, 'openbook.db');
const url = process.env.LIBSQL_URL || process.env.TURSO_DATABASE_URL || localFileUrl;
const authToken = process.env.LIBSQL_AUTH_TOKEN || process.env.TURSO_AUTH_TOKEN || undefined;
const isRemote = /^(libsql|https?|wss?):/i.test(url);

if (process.env.NODE_ENV === 'production' && !isRemote) {
  logger.warn({ url },
    'LIBSQL_URL is NOT set: using a LOCAL file database. On a diskless host this is EPHEMERAL and is wiped on every ' +
    'redeploy. Set LIBSQL_URL + LIBSQL_AUTH_TOKEN to your Turso database so data persists.');
} else {
  logger.info({ url, remote: isRemote }, 'database location');
}

const client = createClient(
  authToken ? { url, authToken, intMode: 'number' } : { url, intMode: 'number' }
);

// --- Adapter ---------------------------------------------------------------
// Presents the node:sqlite-style surface the app already uses (prepare().get/
// all/run and exec()), backed by the async libSQL client. Rows are mapped to
// plain objects so spreading and JSON serialization behave exactly as before.
// get/all/run return Promises now; every call site awaits them. Any query at or
// above DB_SLOW_MS is logged with its timing (observability only).
function queryLabel(sql) { return String(sql).replace(/\s+/g, ' ').trim().slice(0, 120); }
function rowToObj(columns, row) {
  const o = {};
  for (let i = 0; i < columns.length; i++) o[columns[i]] = row[i];
  return o;
}
function bindArgs(args) {
  // Positional ? params arrive as spread values; a single plain object means
  // named params (e.g. { $id: 1 }), which libSQL accepts directly.
  if (args.length === 1 && args[0] && typeof args[0] === 'object' && !Array.isArray(args[0])) return args[0];
  return args;
}
async function timed(op, sql, run) {
  const start = process.hrtime.bigint();
  const result = await run();
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  if (ms >= DB_SLOW_MS) logger.warn({ ms: Math.round(ms * 10) / 10, op, query: queryLabel(sql) }, 'slow query');
  return result;
}

const db = {
  // exec runs one or more raw statements (schema, migrations); no parameters.
  async exec(sql) { return client.executeMultiple(sql); },
  prepare(sql) {
    return {
      get(...a) {
        return timed('get', sql, async () => {
          const rs = await client.execute({ sql, args: bindArgs(a) });
          return rs.rows.length ? rowToObj(rs.columns, rs.rows[0]) : undefined;
        });
      },
      all(...a) {
        return timed('all', sql, async () => {
          const rs = await client.execute({ sql, args: bindArgs(a) });
          return rs.rows.map((r) => rowToObj(rs.columns, r));
        });
      },
      run(...a) {
        return timed('run', sql, async () => {
          const rs = await client.execute({ sql, args: bindArgs(a) });
          return {
            changes: rs.rowsAffected,
            lastInsertRowid: typeof rs.lastInsertRowid === 'bigint' ? Number(rs.lastInsertRowid) : rs.lastInsertRowid,
          };
        });
      },
    };
  },
  // Direct libSQL client access if ever needed (batch, etc.).
  client,
};

// Idempotent startup migrations: add a column only if it is missing. Async
// because every PRAGMA / ALTER now goes over the network.
async function addColumn(table, colDef, colName) {
  try {
    const cols = await db.prepare('PRAGMA table_info(' + table + ')').all();
    if (!cols.some((c) => c.name === colName)) await db.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + colDef);
  } catch (e) {
    try { await db.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + colDef); } catch (e2) { /* already present */ }
  }
}

let _initialized = false;
// Build the schema and run the startup migrations. server.js awaits this once
// before the app starts handling requests. Safe to call more than once.
db.init = async function init() {
  if (_initialized) return;

  // Enforce foreign keys so deleting a user cleans up their data (ON DELETE
  // CASCADE throughout). Set on the connection before any schema work.
  try { await client.execute('PRAGMA foreign_keys = ON;'); } catch (e) { /* some hosts manage this globally */ }

  await db.exec(`
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
  await db.exec(`
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
    const cols = await db.prepare('PRAGMA table_info(posts)').all();
    if (!cols.some((c) => c.name === 'group_id')) {
      await db.exec('ALTER TABLE posts ADD COLUMN group_id INTEGER');
    }
  } catch (e) {
    try { await db.exec('ALTER TABLE posts ADD COLUMN group_id INTEGER'); } catch (e2) { /* already present */ }
  }
  await db.exec('CREATE INDEX IF NOT EXISTS idx_posts_group ON posts(group_id)');

  // --- Phase 0: reputation scaffolding (see SPEC.md) ---
  // Two separate scores per user: karma (social, drives ranking only) and
  // standing (trust/safety, drives privileges and the shadowban trigger). Plus a
  // trust_level (TL0..TL4) and a reach_score multiplier used at ranking time.
  await addColumn('users', 'karma INTEGER NOT NULL DEFAULT 0', 'karma');
  await addColumn('users', 'standing INTEGER NOT NULL DEFAULT 100', 'standing');
  await addColumn('users', 'reach_score REAL NOT NULL DEFAULT 1.0', 'reach_score');
  await addColumn('users', 'trust_level INTEGER NOT NULL DEFAULT 0', 'trust_level');

  // Full audit trail for every standing/karma change (the transparency backbone).
  await db.exec(`
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
  await db.exec(`
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
  await addColumn('posts', 'community_id INTEGER', 'community_id');
  await addColumn('posts', "title TEXT NOT NULL DEFAULT ''", 'title');
  await addColumn('posts', "type TEXT NOT NULL DEFAULT 'text'", 'type');
  await addColumn('posts', "url TEXT NOT NULL DEFAULT ''", 'url');
  await addColumn('posts', "visibility TEXT NOT NULL DEFAULT 'visible'", 'visibility');
  // Audience for a personal post: 'public' (anyone, shows in Discover) or 'friends'
  // (accepted friends + author only). Existing posts default to 'friends' so nothing
  // already shared privately is retroactively exposed; the composer defaults new
  // posts to 'public'. Community/group posts ignore this (their own privacy rules
  // in visibility.js apply).
  await addColumn('posts', "audience TEXT NOT NULL DEFAULT 'friends'", 'audience');
  await addColumn('comments', 'parent_id INTEGER', 'parent_id');
  await addColumn('comments', "visibility TEXT NOT NULL DEFAULT 'visible'", 'visibility');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_posts_community ON posts(community_id)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_comments_parent ON comments(parent_id)');

  // --- Reactions (Facebook-style) and post edit history ---
  await db.exec(`
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
  await addColumn('posts', 'edit_count INTEGER NOT NULL DEFAULT 0', 'edit_count');
  await addColumn('posts', 'edited_at TEXT', 'edited_at');

  // --- Phase 2: feeds + ranking (see SPEC.md section 7, ranking.js) ---
  // Each vote stores the voter's trust weight at cast time, so ranking can use
  // trust-weighted "effective" votes (a brand-new account barely moves the rank)
  // while the raw count still drives the visible score and karma. Pre-Phase-2
  // votes default to full weight (1), which is the right neutral behaviour.
  await addColumn('votes', 'weight REAL NOT NULL DEFAULT 1', 'weight');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at)');

  // Carry existing likes over as 'like' reactions (idempotent; safe every boot).
  try {
    await db.exec("INSERT OR IGNORE INTO reactions (user_id, target_type, target_id, type, created_at) SELECT user_id, 'post', post_id, 'like', created_at FROM likes");
  } catch (e) { /* likes table may be absent in a brand new database */ }

  // --- Reels: short vertical videos (Facebook/TikTok-style) ---
  // Likes reuse the generic reactions table (target_type = 'reel', type = 'like').
  await db.exec(`
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
  await db.exec(`
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
  await addColumn('posts', 'views INTEGER NOT NULL DEFAULT 0', 'views');

  // --- Email verification (soft gate: browse freely, verify to post) ---
  // New signups start unverified; accounts that existed before this feature are
  // grandfathered as verified once (so the gate only applies going forward).
  {
    const cols = await db.prepare('PRAGMA table_info(users)').all();
    if (!cols.some((c) => c.name === 'email_verified')) {
      await db.exec('ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0');
      await db.exec('UPDATE users SET email_verified = 1');
    }
  }
  await addColumn('users', 'verify_token TEXT', 'verify_token');

  // --- Password reset (forgot password) ---
  // A one-time token + expiry, set when a reset is requested and cleared once the
  // password is changed. Delivered by the same mailer as verification.
  await addColumn('users', 'reset_token TEXT', 'reset_token');
  await addColumn('users', 'reset_expires TEXT', 'reset_expires');

  // --- Phase 3/4: moderation, reports, bans, appeals, shadowban ---
  // Moderation power is distributed: post creators moderate their own threads,
  // community mods moderate their community, platform admins handle only sitewide
  // issues. Every action is logged (mod_actions), confirmed removals lower the
  // author's standing (which the reach engine in trust.js turns into a graduated
  // shadowban), and affected users are notified and can appeal. Nothing here is
  // driven by votes, only by confirmed actions.
  await addColumn('users', 'is_admin INTEGER NOT NULL DEFAULT 0', 'is_admin');
  // Founder badge flag (cosmetic). Synced from FOUNDER_EMAILS at boot (see below).
  await addColumn('users', 'is_founder INTEGER NOT NULL DEFAULT 0', 'is_founder');
  // Focal point (object-position) for the avatar + cover, so users can drag-position
  // their photos like Facebook. Stored as a CSS position string, e.g. "50% 30%".
  await addColumn('users', "avatar_pos TEXT NOT NULL DEFAULT '50% 50%'", 'avatar_pos');
  await addColumn('users', "cover_pos TEXT NOT NULL DEFAULT '50% 50%'", 'cover_pos');
  // Supporter perk: a custom profile accent color (hex). Stored for everyone but
  // only APPLIED for paid tiers / founders (see auth.publicUser), so it is a real
  // tier perk and stops applying if supporter time lapses.
  await addColumn('users', "accent_color TEXT NOT NULL DEFAULT ''", 'accent_color');
  // Premium perk: a preset profile theme (color + gradient combo). Stored for
  // everyone but only APPLIED for Premium / founders (see auth.publicUser).
  await addColumn('users', "profile_theme TEXT NOT NULL DEFAULT ''", 'profile_theme');
  // Profile visibility chosen by the owner: 'public' (everyone), 'friends' (only
  // accepted friends), or 'private' (only the owner). Gates the profile page + wall.
  await addColumn('users', "profile_visibility TEXT NOT NULL DEFAULT 'public'", 'profile_visibility');
  // Unique @username (handle). Nullable until a user picks one. Case-insensitively
  // unique via a partial index (empty/null handles do not collide).
  await addColumn('users', 'username TEXT', 'username');
  await db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username COLLATE NOCASE) WHERE username IS NOT NULL AND username != ''");
  await addColumn('posts', 'locked INTEGER NOT NULL DEFAULT 0', 'locked');   // comments locked
  await addColumn('posts', 'pinned INTEGER NOT NULL DEFAULT 0', 'pinned');   // pinned in its community
  // Site-wide announcement pin: the founder/admin flags a post as an official,
  // clearly-labeled announcement shown at the top of the feed (transparent, NOT
  // a hidden feed boost). Kept out of the ranked feeds so it only appears pinned.
  await addColumn('posts', 'announcement INTEGER NOT NULL DEFAULT 0', 'announcement');

  await db.exec(`
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
  await addColumn('appeals', 'target_type TEXT', 'target_type');
  await addColumn('appeals', 'target_id INTEGER', 'target_id');

  // Phase 3 upgrade (karma-weighted flagging): each report stores the reporter's
  // flag weight at file time (proportional to their standing + trust level), so
  // the auto-hide threshold sums trusted flags without re-deriving old standing.
  await addColumn('reports', 'weight REAL NOT NULL DEFAULT 1', 'weight');

  // --- Phase 4: the community jury (decentralized moderation) ---
  // When flagged content is auto-hidden, an odd-sized panel of randomly chosen,
  // pristine-standing, established users is convened to decide Keep or Remove. The
  // majority verdict executes automatically and the full case file (ballot
  // breakdown + outcome) is published to the public mod log. Jurors are anonymous
  // to each other and to the author.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS juries (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      target_type  TEXT    NOT NULL,
      target_id    INTEGER NOT NULL,
      community_id INTEGER,
      reason_code  TEXT    NOT NULL DEFAULT '',
      size         INTEGER NOT NULL DEFAULT 5,
      status       TEXT    NOT NULL DEFAULT 'open',   -- open | decided | expired
      outcome      TEXT,                               -- keep | remove
      keep_votes   INTEGER NOT NULL DEFAULT 0,
      remove_votes INTEGER NOT NULL DEFAULT 0,
      created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
      decided_at   TEXT,
      expires_at   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_juries_status ON juries(status);
    CREATE INDEX IF NOT EXISTS idx_juries_target ON juries(target_type, target_id);

    CREATE TABLE IF NOT EXISTS jury_members (
      jury_id    INTEGER NOT NULL,
      user_id    INTEGER NOT NULL,
      vote       TEXT,                                 -- NULL until cast: keep | remove
      voted_at   TEXT,
      created_at TEXT    NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (jury_id, user_id),
      FOREIGN KEY (jury_id) REFERENCES juries(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id)  ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_jury_members_user ON jury_members(user_id);
  `);

  // --- Phase 5: anti-sybil (see SPEC.md section 5, antisybil.js) ---
  // devices: a coarse client fingerprint + IP per account, so concentration (many
  // accounts on one device/IP) can raise a soft flag. We never hard-block on this.
  // sybil_flags: the review queue the background vote-ring job and signup-risk
  // checks write to. Auto-actions stay gentle and appealable (logged in
  // trust_events); confirmed bans remain a separate, human moderation decision.
  await db.exec(`
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
  await addColumn('users', 'supporter_tier INTEGER NOT NULL DEFAULT 0', 'supporter_tier');
  await addColumn('users', 'supporter_since TEXT', 'supporter_since');
  await addColumn('users', 'supporter_expires TEXT', 'supporter_expires');
  // Opt-out of the public supporters wall (default 0 = shown). A supporter who
  // sets this still counts in the aggregate total (anonymously) but is not listed
  // by name, honoring the "you are in control" promise.
  await addColumn('users', 'hide_supporter INTEGER NOT NULL DEFAULT 0', 'hide_supporter');

  // A small, separate audit of tier grants/changes (kept apart from trust_events
  // so the karma/standing reputation trail stays clean).
  await db.exec(`
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

  // --- Payments: one row per confirmed external payment (see routes/billing.js) ---
  // The UNIQUE (provider, external_id) index is the idempotency guard: a
  // re-delivered PayPal IPN or a re-submitted USDT tx hash inserts nothing and
  // therefore grants nothing twice. user_id is nullable so an unmatched payment is
  // still recorded. This is the audit trail behind every paid tier grant.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS payment_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      provider    TEXT    NOT NULL,
      external_id TEXT    NOT NULL,
      user_id     INTEGER,
      tier        INTEGER NOT NULL,
      days        INTEGER NOT NULL,
      amount      REAL    NOT NULL DEFAULT 0,
      currency    TEXT    NOT NULL DEFAULT '',
      status      TEXT    NOT NULL DEFAULT 'applied',
      detail      TEXT    NOT NULL DEFAULT '',
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_events_ext ON payment_events(provider, external_id);
    CREATE INDEX IF NOT EXISTS idx_payment_events_user ON payment_events(user_id);
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
  await addColumn('users', 'referral_code TEXT', 'referral_code');
  await addColumn('users', 'referred_by INTEGER', 'referred_by');
  await addColumn('users', 'referral_rewards_granted INTEGER NOT NULL DEFAULT 0', 'referral_rewards_granted');
  await db.exec(`
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
  await db.exec(`
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
  await db.exec("DELETE FROM analytics_events WHERE created_at < datetime('now', '-90 days');");

  // --- Media lifecycle: one row per uploaded object reference (see media/cleanup.js) ---
  // Every successful upload records (user_id, storage key, byte size) here. This is
  // the backbone of three promises at once:
  //   1. Real deletion. When a post/photo/reel is deleted we remove its row; the
  //      underlying storage object is deleted only when the LAST row for that key
  //      is gone (so content-addressed dedupe across users is safe).
  //   2. Storage quota. A user's footprint is SUM(bytes) over their rows, which the
  //      upload pipeline checks against their tier cap.
  //   3. Account wipe. Deleting an account deletes every object the user owns.
  await db.exec(`
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
  await addColumn('posts', "bg TEXT NOT NULL DEFAULT ''", 'bg');
  await addColumn('posts', "file_url TEXT NOT NULL DEFAULT ''", 'file_url');
  await addColumn('posts', "file_name TEXT NOT NULL DEFAULT ''", 'file_name');
  await db.exec(`
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
  await db.exec(`
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

  // --- Data control: export jobs (the "download all my data" pipeline) ---
  // A full ZIP export of a user's content + media is built in the background
  // (media can be large), then handed back via a one-time, expiring token. The
  // lightweight JSON export needs no row here (it streams synchronously).
  await db.exec(`
    CREATE TABLE IF NOT EXISTS export_jobs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL,
      format     TEXT    NOT NULL DEFAULT 'zip',
      status     TEXT    NOT NULL DEFAULT 'pending',
      token      TEXT    NOT NULL,
      file       TEXT    NOT NULL DEFAULT '',
      bytes      INTEGER NOT NULL DEFAULT 0,
      error      TEXT    NOT NULL DEFAULT '',
      created_at TEXT    NOT NULL DEFAULT (datetime('now')),
      ready_at   TEXT,
      expires_at TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_export_jobs_user ON export_jobs(user_id);
  `);

  // --- Roadmap upgrade: the suggestion board becomes a public, transparent
  // roadmap. Suggestions gain an optional linked GitHub issue, a status note,
  // and a timestamp; every status change is written to a public append-only
  // ledger (roadmap_events) so "nothing is hidden" holds for governance too.
  await addColumn('suggestions', 'github_issue INTEGER', 'github_issue');
  await addColumn('suggestions', "status_note TEXT NOT NULL DEFAULT ''", 'status_note');
  await addColumn('suggestions', 'status_at TEXT', 'status_at');
  await db.exec(`
    CREATE TABLE IF NOT EXISTS roadmap_events (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      suggestion_id INTEGER NOT NULL,
      actor_id      INTEGER,
      from_status   TEXT NOT NULL DEFAULT '',
      to_status     TEXT NOT NULL,
      note          TEXT NOT NULL DEFAULT '',
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (suggestion_id) REFERENCES suggestions(id) ON DELETE CASCADE,
      FOREIGN KEY (actor_id)      REFERENCES users(id)        ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_roadmap_events_sug ON roadmap_events(suggestion_id);
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
      await db.exec('UPDATE users SET is_admin = 0');
      await db.prepare('UPDATE users SET is_admin = 1 WHERE lower(email) IN (' + ph + ')').run(...adminEmails);
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
      await db.exec('UPDATE users SET is_founder = 0');
      await db.prepare('UPDATE users SET is_founder = 1 WHERE lower(email) IN (' + ph + ')').run(...founderEmails);
    }
  } catch (e) { /* column may not be ready on a brand new db */ }

  // --- Pioneer badge: the first 5000 members get a permanent blue badge ---
  // Awarded by signup order (lowest ids first), excluding the founder(s) and the
  // internal sentinel accounts (the [deleted] ghost + the OpenBook system actor).
  // Stored as a flag so it is permanent and cosmetic only (never reputation).
  // Runs AFTER the founder sync so founders are correctly excluded. Idempotent:
  // the earliest-5000 set is fixed once the platform passes 5000 real members.
  await addColumn('users', 'is_pioneer INTEGER NOT NULL DEFAULT 0', 'is_pioneer');
  try {
    await db.exec(
      "UPDATE users SET is_pioneer = 1 WHERE id IN (" +
      "SELECT id FROM users WHERE is_founder = 0 AND email NOT IN ('ghost@deleted.openbook.local','system@openbook.local') " +
      "ORDER BY id ASC LIMIT 5000) AND is_pioneer = 0;"
    );
    // The founder is explicitly NOT a Pioneer (they have the Founder badge).
    await db.exec('UPDATE users SET is_pioneer = 0 WHERE is_founder = 1;');
  } catch (e) { /* users table/columns may not be ready on a brand new db */ }

  // --- Follows: one-directional (you follow someone to see their PUBLIC posts in
  // your feed without a mutual friendship). Completely separate from friendships;
  // following never grants access to friends-only content. ---
  await db.exec(`
    CREATE TABLE IF NOT EXISTS follows (
      follower_id INTEGER NOT NULL,
      followee_id INTEGER NOT NULL,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (follower_id, followee_id),
      FOREIGN KEY (follower_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (followee_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_follows_followee ON follows(followee_id);
  `);

  // --- Illegal-content blocklist (SPEC 12): SHA-256 hashes of media confirmed
  // illegal. Every upload is checked against this BEFORE it is stored, and the
  // list grows when a platform admin confirms an 'illegal' report. algo lets a
  // future perceptual-hash provider (PDQ/PhotoDNA) coexist with the exact sha256. ---
  await db.exec(`
    CREATE TABLE IF NOT EXISTS blocked_hashes (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      algo       TEXT    NOT NULL DEFAULT 'sha256',
      hash       TEXT    NOT NULL,
      reason     TEXT    NOT NULL DEFAULT 'illegal',
      added_by   INTEGER,
      created_at TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE (algo, hash),
      FOREIGN KEY (added_by) REFERENCES users(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_blocked_hashes_hash ON blocked_hashes(hash);
  `);
  // 'illegal' reports escalate to a confidential platform-admin queue (separate
  // from the neutrality jury). priority + the admin who claimed/closed it live here.
  await addColumn('reports', "priority TEXT NOT NULL DEFAULT 'normal'", 'priority');
  // The sha256 of a post/reel's primary media, so a confirmed-illegal removal can
  // blocklist the exact bytes and so an upload-time match can be recorded.
  await addColumn('posts', "media_hash TEXT NOT NULL DEFAULT ''", 'media_hash');
  await addColumn('reels', "media_hash TEXT NOT NULL DEFAULT ''", 'media_hash');
  // Reels gain a visibility flag (like posts/comments) so an illegal video can be
  // taken down. Feed + single-view queries filter visibility = 'visible'.
  await addColumn('reels', "visibility TEXT NOT NULL DEFAULT 'visible'", 'visibility');

  // --- Marketplace: richer listing fields (Facebook-Marketplace-like) ---
  // condition: new | like_new | good | fair | parts. delivery: shipping | pickup |
  // both. Both optional (empty = unspecified).
  await addColumn('listings', "condition TEXT NOT NULL DEFAULT ''", 'condition');
  await addColumn('listings', "delivery TEXT NOT NULL DEFAULT ''", 'delivery');
  // escrow: 1 = the seller offers escrow protection on this item. Only allowed for
  // items at or under ESCROW_MAX_AMOUNT; bigger items (cars, property) are sold
  // face to face with no escrow. The seller opts in/out when posting.
  await addColumn('listings', 'escrow INTEGER NOT NULL DEFAULT 0', 'escrow');

  // --- Marketplace escrow (SPEC: protected transactions) ---
  // An order is the escrow record for a purchase. Money handling is GATED by the
  // ESCROW_LIVE env: when off, the workflow + evidence + dispute all work but no
  // real funds move (a clearly-labeled preview). The custodial USDT rail plugs in
  // when ESCROW_LIVE=1. status lifecycle:
  //   awaiting_funds -> funds_held -> shipped -> completed
  //                                       \-> disputed -> resolved_release | resolved_refund
  //                  -> cancelled
  await db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      listing_id    INTEGER,
      buyer_id      INTEGER NOT NULL,
      seller_id     INTEGER NOT NULL,
      title         TEXT    NOT NULL DEFAULT '',
      amount        REAL    NOT NULL DEFAULT 0,
      fee_pct       REAL    NOT NULL DEFAULT 0,
      fee_amount    REAL    NOT NULL DEFAULT 0,
      seller_amount REAL    NOT NULL DEFAULT 0,
      currency      TEXT    NOT NULL DEFAULT 'USDT',
      status        TEXT    NOT NULL DEFAULT 'awaiting_funds',
      live          INTEGER NOT NULL DEFAULT 0,
      escrow_network TEXT   NOT NULL DEFAULT '',
      escrow_address TEXT   NOT NULL DEFAULT '',
      tx_in         TEXT    NOT NULL DEFAULT '',
      tx_out        TEXT    NOT NULL DEFAULT '',
      dispute_reason TEXT   NOT NULL DEFAULT '',
      dispute_by    INTEGER,
      resolution    TEXT    NOT NULL DEFAULT '',
      resolved_by   INTEGER,
      created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE SET NULL,
      FOREIGN KEY (buyer_id)   REFERENCES users(id)    ON DELETE CASCADE,
      FOREIGN KEY (seller_id)  REFERENCES users(id)    ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_orders_buyer  ON orders(buyer_id);
    CREATE INDEX IF NOT EXISTS idx_orders_seller ON orders(seller_id);
    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

    CREATE TABLE IF NOT EXISTS order_evidence (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id   INTEGER NOT NULL,
      user_id    INTEGER NOT NULL,
      role       TEXT    NOT NULL DEFAULT 'buyer',
      kind       TEXT    NOT NULL DEFAULT 'other',
      media_url  TEXT    NOT NULL DEFAULT '',
      note       TEXT    NOT NULL DEFAULT '',
      created_at TEXT    NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id)  REFERENCES users(id)  ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_order_evidence_order ON order_evidence(order_id);

    CREATE TABLE IF NOT EXISTS order_events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id   INTEGER NOT NULL,
      actor_id   INTEGER,
      event      TEXT    NOT NULL,
      detail     TEXT    NOT NULL DEFAULT '',
      created_at TEXT    NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_order_events_order ON order_events(order_id);
  `);

  // Clear out sessions older than 30 days on startup.
  await db.exec("DELETE FROM sessions WHERE created_at < datetime('now', '-30 days');");

  _initialized = true;
  logger.info('database schema ready');
};

module.exports = db;
