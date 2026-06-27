// export.js
// The "download all my data" pipeline. This is Promise #3 (your data is yours to
// export) and Promise #2 (nothing hidden: the export includes the full audit
// trail about you, not just your content) turned into working code.
//
// Two tiers:
//   - JSON (synchronous): every database row about you, streamed as one JSON
//     download. No media bytes, but a manifest of your media (keys + sizes + the
//     resolvable URL). Cheap, instant, no dependencies.
//   - ZIP (background job): the same data.json PLUS every media object you own,
//     streamed straight from storage into a zip so memory stays flat even for a
//     gigabyte of reels. Handed back via a one-time, expiring token.
//
// Privacy rules baked in: secrets (password hash, verify/reset tokens) are
// stripped, and only rows about THIS user are included. Your message history
// includes the other party's name (it is your conversation copy), exactly like
// every mainstream data export.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const storage = require('./media/storage');
const { logger } = require('./logger');

const DATA_DIR = process.env.DATA_DIR || __dirname;
const EXPORT_DIR = path.join(DATA_DIR, 'exports');
try { if (!fs.existsSync(EXPORT_DIR)) fs.mkdirSync(EXPORT_DIR, { recursive: true }); } catch (e) {}

function nowIso() { return new Date().toISOString().replace('T', ' ').slice(0, 19); }

// Gather everything the database holds about one user. Every table that is keyed
// to a user appears here; the reputation audit (trust_events) is included on
// purpose so the export is genuinely complete.
async function collectUserData(userId) {
  const many = (sql, ...a) => db.prepare(sql).all(...a);
  const one = (sql, ...a) => db.prepare(sql).get(...a);

  const me = await one('SELECT * FROM users WHERE id = ?', userId);
  if (me) {
    // Never export secrets, not even to the owner.
    delete me.password_hash;
    delete me.verify_token;
    delete me.reset_token;
    delete me.reset_expires;
  }

  return {
    meta: { schema: 'openbook-export/v1', exported_at: nowIso(), user_id: userId },
    account: me || null,
    posts:            await many('SELECT * FROM posts WHERE user_id = ?', userId),
    post_edits:       await many('SELECT pe.* FROM post_edits pe JOIN posts p ON p.id = pe.post_id WHERE p.user_id = ?', userId),
    comments:         await many('SELECT * FROM comments WHERE user_id = ?', userId),
    reactions:        await many('SELECT * FROM reactions WHERE user_id = ?', userId),
    votes:            await many('SELECT * FROM votes WHERE user_id = ?', userId),
    poll_votes:       await many('SELECT * FROM poll_votes WHERE user_id = ?', userId),
    suggestions:      await many('SELECT * FROM suggestions WHERE user_id = ?', userId),
    suggestion_votes: await many('SELECT * FROM suggestion_votes WHERE user_id = ?', userId),
    stories:          await many('SELECT * FROM stories WHERE user_id = ?', userId),
    reels:            await many('SELECT * FROM reels WHERE user_id = ?', userId),
    reel_comments:    await many('SELECT * FROM reel_comments WHERE user_id = ?', userId),
    albums:           await many('SELECT * FROM albums WHERE user_id = ?', userId),
    album_photos:     await many('SELECT ap.* FROM album_photos ap JOIN albums a ON a.id = ap.album_id WHERE a.user_id = ?', userId),
    listings:         await many('SELECT * FROM listings WHERE seller_id = ?', userId),
    messages:         await many('SELECT * FROM messages WHERE sender_id = ? OR recipient_id = ?', userId, userId),
    friendships:      await many('SELECT * FROM friendships WHERE requester_id = ? OR addressee_id = ?', userId, userId),
    communities_created: await many('SELECT * FROM communities WHERE creator_id = ?', userId),
    community_memberships: await many('SELECT * FROM community_members WHERE user_id = ?', userId),
    groups_created:   await many('SELECT * FROM groups WHERE creator_id = ?', userId),
    group_memberships: await many('SELECT * FROM group_members WHERE user_id = ?', userId),
    name_history:     await many('SELECT * FROM name_history WHERE user_id = ?', userId),
    // The transparency backbone: your full reputation + supporter history.
    trust_events:     await many('SELECT * FROM trust_events WHERE user_id = ?', userId),
    supporter_events: await many('SELECT * FROM supporter_events WHERE user_id = ?', userId),
    reports_filed:    await many('SELECT * FROM reports WHERE reporter_id = ?', userId),
    appeals:          await many('SELECT * FROM appeals WHERE user_id = ?', userId),
    referrals:        await many('SELECT * FROM referrals WHERE referrer_id = ? OR invitee_id = ?', userId, userId),
    devices:          await many('SELECT id, ip, fingerprint, first_seen, last_seen FROM devices WHERE user_id = ?', userId),
    media:            await many('SELECT key, bytes, created_at FROM user_media WHERE user_id = ?', userId),
  };
}

const README = [
  'OpenBook data export',
  '=====================',
  '',
  'This archive contains everything OpenBook holds about your account.',
  '',
  'data.json   Every database record about you: your profile, posts, comments,',
  '            messages, votes, reactions, and your full reputation history',
  '            (trust_events). Secrets like your password are never included.',
  'media/      Every photo and video you uploaded, by its storage key. The keys',
  '            match the "media" manifest inside data.json.',
  '',
  'Your data is yours. OpenBook never sells it. See https://openbook.space/privacy',
  '',
].join('\n');

// Build the JSON-only export object (used by the synchronous route).
async function buildJson(userId) {
  return collectUserData(userId);
}

// Build the full ZIP (data.json + README + every media object) to a local file
// and return { file, bytes }. Streams each object through storage.stream so a
// large library never sits in memory. archiver is pure JS (no native build); if
// it is somehow missing we throw a clear error and the JSON export still works.
async function buildZipFile(userId, outFile) {
  let archiver;
  try { archiver = require('archiver'); }
  catch (e) { throw new Error('archiver is not installed; run: npm install archiver'); }

  const data = await collectUserData(userId);
  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outFile);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
    archive.on('warning', (w) => logger.warn({ w }, 'export archive warning'));
    archive.pipe(output);

    archive.append(JSON.stringify(data, null, 2), { name: 'data.json' });
    archive.append(README, { name: 'README.txt' });

    // Append media sequentially so we never open hundreds of streams at once.
    (async () => {
      for (const m of data.media) {
        if (!/^[A-Za-z0-9._-]+$/.test(m.key)) continue;
        try {
          const { stream } = await storage.stream(m.key);
          await new Promise((res) => {
            archive.append(stream, { name: 'media/' + m.key });
            // archiver consumes the stream; move on when it has been queued.
            stream.on('end', res);
            stream.on('error', () => res());
          });
        } catch (e) {
          logger.warn({ err: e, key: m.key }, 'export: media object missing, skipping');
        }
      }
      archive.finalize();
    })().catch(reject);
  });
  const bytes = fs.existsSync(outFile) ? fs.statSync(outFile).size : 0;
  return { file: outFile, bytes };
}

// --- Job lifecycle (ZIP) -------------------------------------------------
// One in-flight or recent job per user (anti-abuse: a full export touches all of
// their storage). Returns the existing fresh job if there is one.
async function recentJob(userId) {
  return db.prepare(
    "SELECT * FROM export_jobs WHERE user_id = ? AND status IN ('pending','building','ready') " +
    "AND created_at >= datetime('now', '-1 day') ORDER BY id DESC LIMIT 1"
  ).get(userId);
}

async function createJob(userId, format) {
  const token = crypto.randomBytes(24).toString('hex');
  const info = await db.prepare(
    'INSERT INTO export_jobs (user_id, format, status, token) VALUES (?, ?, ?, ?)'
  ).run(userId, format === 'json' ? 'json' : 'zip', 'pending', token);
  const job = await db.prepare('SELECT * FROM export_jobs WHERE id = ?').get(info.lastInsertRowid);
  // Build off the request so the POST returns immediately.
  setImmediate(() => runJob(job).catch((e) => logger.error({ err: e, job: job.id }, 'export job failed')));
  return job;
}

async function runJob(job) {
  await db.prepare("UPDATE export_jobs SET status = 'building' WHERE id = ?").run(job.id);
  try {
    const outFile = path.join(EXPORT_DIR, 'openbook-export-' + job.user_id + '-' + job.token + '.zip');
    const { bytes } = await buildZipFile(job.user_id, outFile);
    await db.prepare(
      "UPDATE export_jobs SET status = 'ready', file = ?, bytes = ?, ready_at = datetime('now'), expires_at = datetime('now', '+1 day') WHERE id = ?"
    ).run(outFile, bytes, job.id);
    logger.info({ job: job.id, bytes }, 'export ready');
  } catch (e) {
    await db.prepare("UPDATE export_jobs SET status = 'failed', error = ? WHERE id = ?").run(String(e.message || e), job.id);
  }
}

// Delete expired export artifacts + rows so they never accumulate. Reused by a
// startup sweep + an hourly timer (see startExportCleanupJob).
async function sweepExpiredExports() {
  let rows = [];
  try {
    rows = await db.prepare("SELECT id, file FROM export_jobs WHERE expires_at IS NOT NULL AND expires_at < datetime('now')").all();
  } catch (e) { return 0; }
  for (const r of rows) {
    if (r.file) { try { await fs.promises.unlink(r.file); } catch (e) {} }
    try { await db.prepare("UPDATE export_jobs SET status = 'expired', file = '' WHERE id = ?").run(r.id); } catch (e) {}
  }
  // Also drop fully-stale rows after a week so the table stays small.
  try { await db.prepare("DELETE FROM export_jobs WHERE created_at < datetime('now', '-7 days')").run(); } catch (e) {}
  return rows.length;
}

let exportTimer = null;
function startExportCleanupJob() {
  if (exportTimer) return;
  sweepExpiredExports().catch(() => {});
  exportTimer = setInterval(() => sweepExpiredExports().catch(() => {}), 3600000); // hourly
  if (exportTimer.unref) exportTimer.unref();
}

module.exports = {
  collectUserData, buildJson, buildZipFile,
  recentJob, createJob, runJob, sweepExpiredExports, startExportCleanupJob,
  EXPORT_DIR,
};
