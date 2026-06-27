// media/cleanup.js
// The media lifecycle: record uploads, delete them for real, enforce quota, and
// expire stories. This is what turns "we deleted the database row" into "the
// bytes are actually gone", which is the promise: you control your media and you
// can truly delete it.
//
// How real deletion works WITHOUT breaking dedupe:
//   In s3 mode, object keys are content addressed (sha256), so two users posting
//   the identical image share ONE object. Deleting one user's post must NOT yank
//   the bytes out from under the other. So every upload writes a row in
//   user_media (user_id, key, bytes), and we only delete the underlying object
//   when the LAST row pointing at that key is removed. In local mode keys are
//   unique per upload anyway, so the last-reference check simply always fires.
//   Either way, deletion is correct.
//
// CDN note: with s3 + a custom domain, objects are cached at the edge for up to a
// year (immutable). So "delete" must also purge the CDN, or a deleted photo could
// still be fetched from a cached edge until its TTL. purgeCdn() does that via the
// Cloudflare API when CF_API_TOKEN + CF_ZONE_ID are set. In local mode there is
// no edge cache, so it is a no-op.

const db = require('../db');
const storage = require('./storage');
const { logger } = require('../logger');

// Pull the storage key out of a stored media url. We only ever manage our own
// "/uploads/<key>" references; anything else (an empty string, a default avatar,
// an external http url) returns null and is left untouched.
function keyFromUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const m = url.match(/^\/uploads\/([A-Za-z0-9._-]+)$/);
  return m ? m[1] : null;
}

// Record a freshly stored object for a user. Called by the upload pipeline after
// the bytes are committed to the active backend.
function recordUpload(userId, key, bytes) {
  if (!userId || !key) return;
  try {
    db.prepare('INSERT INTO user_media (user_id, key, bytes) VALUES (?, ?, ?)')
      .run(userId, key, Number(bytes) || 0);
  } catch (e) {
    logger.warn({ err: e, key }, 'recordUpload failed');
  }
}

// Total bytes a user currently stores (for the quota check).
function usageBytes(userId) {
  if (!userId) return 0;
  const r = db.prepare('SELECT COALESCE(SUM(bytes), 0) AS b FROM user_media WHERE user_id = ?').get(userId);
  return r ? Number(r.b) || 0 : 0;
}

// Drop ONE reference to the media at this url, then delete the object if that was
// the last reference. userId, when known, makes us decrement the right owner's
// row (matters for cross user dedupe + quota). Safe to call with empty/foreign
// urls (no-op) and safe to call twice (idempotent once the row is gone).
async function deleteMedia(url, userId) {
  const key = keyFromUrl(url);
  if (!key) return;
  try {
    let row = null;
    if (userId) row = db.prepare('SELECT id FROM user_media WHERE key = ? AND user_id = ? ORDER BY id LIMIT 1').get(key, userId);
    if (!row) row = db.prepare('SELECT id FROM user_media WHERE key = ? ORDER BY id LIMIT 1').get(key);
    if (row) db.prepare('DELETE FROM user_media WHERE id = ?').run(row.id);

    const remaining = db.prepare('SELECT COUNT(*) AS c FROM user_media WHERE key = ?').get(key).c;
    if (remaining === 0) {
      await storage.del(key);
      await purgeCdn([key]);
    }
  } catch (e) {
    logger.warn({ err: e, key }, 'deleteMedia failed');
  }
}

// Delete several urls (used when removing a post that carries one image, or when
// cascading a community/group deletion over many posts).
async function deleteMany(urls, userId) {
  for (const u of urls || []) await deleteMedia(u, userId);
}

// Wipe everything a user owns (account deletion). Deletes the objects (respecting
// shared references) and their user_media rows. Call BEFORE deleting the user row
// so the keys are still known. Returns how many references were removed.
async function wipeUserMedia(userId) {
  const rows = db.prepare('SELECT id, key FROM user_media WHERE user_id = ?').all(userId);
  for (const r of rows) {
    db.prepare('DELETE FROM user_media WHERE id = ?').run(r.id);
    const remaining = db.prepare('SELECT COUNT(*) AS c FROM user_media WHERE key = ?').get(r.key).c;
    if (remaining === 0) {
      await storage.del(r.key).catch(() => {});
      await purgeCdn([r.key]);
    }
  }
  return rows.length;
}

// Purge keys from the CDN edge cache so a deleted object stops being served. Only
// meaningful in s3 mode with Cloudflare credentials configured; otherwise no-op.
async function purgeCdn(keys) {
  const token = process.env.CF_API_TOKEN;
  const zone = process.env.CF_ZONE_ID;
  const base = (process.env.MEDIA_CDN_BASE || '').replace(/\/+$/, '');
  if (!storage.isRemote() || !token || !zone || !base || !keys || !keys.length) return;
  try {
    const files = keys.map((k) => base + '/' + k);
    const res = await fetch('https://api.cloudflare.com/client/v4/zones/' + zone + '/purge_cache', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ files }),
    });
    if (!res.ok) logger.warn({ status: res.status }, 'cdn purge returned non-ok');
  } catch (e) {
    logger.warn({ err: e }, 'cdn purge failed');
  }
}

// ---------------------------------------------------------------------------
// Story expiry. Stories are meant to vanish after 24 hours; until now they were
// only HIDDEN by a query (created_at >= -1 day) while the rows and image files
// piled up forever. This hard-deletes expired stories AND their images, which
// both honours "ephemeral" and keeps storage (the only real cost) from growing.
// ---------------------------------------------------------------------------
async function sweepExpiredStories() {
  let rows = [];
  try {
    rows = db.prepare("SELECT id, user_id, image FROM stories WHERE created_at < datetime('now', '-1 day')").all();
  } catch (e) {
    logger.warn({ err: e }, 'story sweep query failed');
    return 0;
  }
  for (const s of rows) {
    await deleteMedia(s.image, s.user_id);
    try { db.prepare('DELETE FROM stories WHERE id = ?').run(s.id); } catch (e) {}
  }
  if (rows.length) logger.info({ count: rows.length }, 'expired stories cleaned');
  return rows.length;
}

let storyTimer = null;
function startStoryCleanupJob() {
  if (storyTimer) return;
  const everyMs = Number(process.env.STORY_CLEANUP_MS || 3600000); // hourly
  sweepExpiredStories().catch((e) => logger.error({ err: e }, 'initial story sweep failed'));
  storyTimer = setInterval(() => {
    sweepExpiredStories().catch((e) => logger.error({ err: e }, 'story cleanup failed'));
  }, everyMs);
  if (storyTimer.unref) storyTimer.unref();
  logger.info({ everyMs }, 'story cleanup job started');
}

module.exports = {
  keyFromUrl, recordUpload, usageBytes, deleteMedia, deleteMany, wipeUserMedia,
  purgeCdn, sweepExpiredStories, startStoryCleanupJob,
};
