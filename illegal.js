// illegal.js
// SPEC section 12, item 1: the illegal-content safety layer. This is SEPARATE
// from the credible-neutrality / free-speech machinery. Illegal media (CSAM,
// etc.) is removed regardless of votes, standing, or the jury, and is handled by
// platform admins only.
//
// Two mechanisms:
//   1. Hash-matching on upload. Every uploaded image/video/file is SHA-256 hashed
//      and checked against `blocked_hashes` BEFORE it is stored. A match is
//      blocked outright and logged confidentially. The list starts empty and
//      grows whenever an admin confirms an 'illegal' report (the matched bytes
//      can never be re-uploaded).
//   2. A documented hook for a real perceptual-hash provider (NCMEC / PhotoDNA /
//      PDQ). Those feeds require a legal agreement and cannot be bundled in an
//      open-source repo, so we ship exact SHA-256 matching now and leave a clean
//      seam (the `algo` column + matchHashes) to add perceptual matching later.

const db = require('./db');
const crypto = require('crypto');
const { logger } = require('./logger');

// Is this exact hash on the blocklist? (algo defaults to sha256; the column lets
// a perceptual algo coexist without a migration.)
async function isBlockedHash(hash, algo = 'sha256') {
  if (!hash) return false;
  const r = await db.prepare('SELECT 1 FROM blocked_hashes WHERE algo = ? AND hash = ?').get(algo, String(hash));
  return !!r;
}

// Add a hash to the blocklist so the same bytes can never be uploaded again.
// Idempotent (UNIQUE(algo, hash)); returns true only when a NEW row was added.
async function blockHash(hash, addedBy, reason = 'illegal', algo = 'sha256') {
  if (!hash) return false;
  const info = await db
    .prepare('INSERT OR IGNORE INTO blocked_hashes (algo, hash, reason, added_by) VALUES (?, ?, ?, ?)')
    .run(algo, String(hash), String(reason || 'illegal').slice(0, 120), addedBy || null);
  return !!info.changes;
}

// SHA-256 of a buffer (used for the perceptual-hook seam and tests).
function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// Confidential record of a blocked upload attempt. is_public = 0 means it NEVER
// appears in the public mod log; only platform admins see it. Never throws (a
// logging failure must not turn into a user-facing error on an already-blocked
// upload). No-op without a user id (uploads are auth-gated, so there always is one).
async function recordBlockedUpload(userId, hash) {
  if (!userId) return;
  try {
    await db
      .prepare(
        "INSERT INTO mod_actions (actor_id, action, target_type, target_id, reason, is_public) " +
        "VALUES (?, 'blocked_upload', 'user', ?, 'known illegal media blocked at upload (hash match)', 0)"
      )
      .run(userId, userId);
  } catch (e) { logger.warn({ err: e }, 'recordBlockedUpload failed'); }
}

module.exports = { isBlockedHash, blockHash, recordBlockedUpload, sha256 };
