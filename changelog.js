// changelog.js
// The official OpenBook account posts product updates (new features and bug fixes)
// to its own public feed, so anyone who follows it can see what is being built, in
// the open, and like / comment / share it. Entries are published at boot,
// idempotently: each has a stable slug claimed in the changelog table, so a restart
// never re-posts or duplicates an entry.
//
// To announce a new fix or feature, add an entry with a NEW unique slug below and it
// posts on the next deploy. Keep each one short and human.

const db = require('./db');
const { systemUserId } = require('./moderation');
const { logger } = require('./logger');

const CHANGELOG = [
  { slug: '2026-06-onboarding',
    body: 'Welcome to OpenBook! New members now get a friendly welcome message and a Get started guide, so it is easy to take your first steps: claim a username, make your first post, invite friends, and more.' },
  { slug: '2026-06-suggestions-roadmap',
    body: 'You steer what we build. Share an idea in the Suggestions box, everyone votes, and the most-wanted ideas rise to the top of the public roadmap. Every status change is logged in the open.' },
  { slug: '2026-06-edit-delete-dms',
    body: 'Messages can now be edited (an "edited" mark then shows) and deleted for everyone, just like you would expect. Your messages, your control.' },
  { slug: '2026-06-back-button',
    body: 'Fixed: the back button now returns you to the last page you were on instead of dropping you out of the app, and logged-in members no longer see a flash of the login screen.' },
  { slug: '2026-06-follow-openbook',
    body: 'This is the official OpenBook account. Follow it to see new features and bug fixes the moment they ship, and tell us what you think. We build in the open.' },
  { slug: '2026-06-google-passkey-login',
    body: 'Two new ways to sign in. You can now log in with Google, or set up a passkey and sign in with just your fingerprint, face, or device PIN (Face ID, Touch ID, or Windows Hello). Passkeys are passwordless, and your biometric never leaves your device, we only ever store a public key. Add one any time from Settings. As always, how you sign in is only your identity, it never affects your karma, standing, or reach.' },
  { slug: '2026-06-30-messages-and-clarity',
    body: 'UPDATE: Messages now has a search box, and the OpenBook account stays pinned to the top of your chats so you can always find it. We also labeled the up and down arrows as Vote so they are clear, gave the Get started panel a clear close button, made author avatars clickable to their profile, let you find people by their @username in search, and fixed scrolling in the OpenBook chat. Keep the feedback coming, it shapes what we build.' },
];

async function publishChangelog() {
  try {
    await db.exec(
      "CREATE TABLE IF NOT EXISTS changelog (slug TEXT PRIMARY KEY, post_id INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')))"
    );
    const sysId = await systemUserId();
    let posted = 0;
    for (const entry of CHANGELOG) {
      // Atomic claim on the slug (PRIMARY KEY): only the first run posts it.
      const claim = await db.prepare('INSERT OR IGNORE INTO changelog (slug) VALUES (?)').run(entry.slug);
      if (!claim.changes) continue; // already posted
      try {
        const info = await db.prepare(
          "INSERT INTO posts (user_id, content, audience, type, visibility) VALUES (?, ?, 'public', 'text', 'visible')"
        ).run(sysId, entry.body);
        await db.prepare('UPDATE changelog SET post_id = ? WHERE slug = ?').run(info.lastInsertRowid, entry.slug);
        posted++;
      } catch (e) {
        try { logger.warn({ err: e, slug: entry.slug }, 'changelog post insert failed'); } catch (_) {}
      }
    }
    if (posted) logger.info({ posted }, 'published OpenBook changelog posts');
    return posted;
  } catch (e) {
    try { logger.warn({ err: e }, 'publishChangelog failed'); } catch (_) {}
    return 0;
  }
}

module.exports = { publishChangelog, CHANGELOG };
