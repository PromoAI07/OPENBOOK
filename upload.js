// upload.js
// Upload handling with multer, plus a small optimisation + storage pipeline that
// is TRANSPARENT to the routes: they still call upload.single('image') /
// videoUpload.single('video') and read req.file.filename exactly as before.
//
// Layered on top of plain multer, in order:
//   1. Per-tier size limit. Free accounts get 100 MB per file; paid tiers more
//      ("pay for extra storage"). Chosen per-request from the user's tier.
//   2. Image compression. Images are resized (max 1920px) and re-encoded to WebP
//      (or AVIF), shrinking them a lot with little visible loss.
//   3. Optional video transcode (MEDIA_TRANSCODE=1): re-encode to a fast-start
//      MP4 sized toward a small target. Heavy: see media/ARCHITECTURE.md, prefer
//      a worker or client-side at scale. Off by default.
//   4. Backend storage. With MEDIA_BACKEND=s3 the optimised bytes are pushed to
//      an egress-free bucket (Cloudflare R2 / Backblaze B2) under a content-
//      addressed key, and req.file.filename becomes that key. With the default
//      MEDIA_BACKEND=local the file just stays on disk under DATA_DIR/uploads,
//      which is exactly the previous behaviour (nothing changes until you set
//      the env).
//
// Everything degrades gracefully: if sharp/ffmpeg are missing, or compression
// fails, the original is kept. The only case that surfaces an error to the user
// is a remote-storage push that fails, because storing a dead "/uploads/<key>"
// reference would be worse than a clear upload error.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { logger } = require('./logger');
const { effectiveTier, storageLimitBytes } = require('./entitlements');
const storage = require('./media/storage');
const processor = require('./media/processor');
const cleanup = require('./media/cleanup');

const UP_DIR = path.join(process.env.DATA_DIR || __dirname, 'uploads');
if (!fs.existsSync(UP_DIR)) fs.mkdirSync(UP_DIR, { recursive: true });

const TRANSCODE = process.env.MEDIA_TRANSCODE === '1';

// Optional native image compressor for the LOCAL fast path. If it is not
// installed, local uploads still work, just without compression.
let sharp = null;
try { sharp = require('sharp'); } catch (e) { logger.warn('sharp not available; image uploads will not be compressed'); }

const diskStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UP_DIR),
  filename: (req, file, cb) => {
    const ext = (path.extname(file.originalname) || '.jpg').toLowerCase();
    cb(null, Date.now() + '_' + crypto.randomBytes(6).toString('hex') + ext);
  },
});

function imageFilter(req, file, cb) {
  if (/^image\//.test(file.mimetype)) cb(null, true);
  else cb(Object.assign(new Error('Only image files are allowed'), { status: 400 }));
}
function videoFilter(req, file, cb) {
  if (/^video\//.test(file.mimetype)) cb(null, true);
  else cb(Object.assign(new Error('Only video files are allowed'), { status: 400 }));
}

// Per-file size limit by the uploader's tier. Free = 100 MB; paid tiers larger.
const TIER_UPLOAD_MB = [100, 100, 250, 1024]; // index by effective tier 0..3
function uploadLimitMb(user) {
  const t = effectiveTier(user || {});
  return TIER_UPLOAD_MB[Math.max(0, Math.min(3, t))] || 100;
}
function limitBytesFor(user) { return uploadLimitMb(user) * 1024 * 1024; }

// sha256 of a file on disk, streamed so a 1 GB video is never read into memory.
function hashFile(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(p);
    s.on('error', reject);
    s.on('data', (d) => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
  });
}

// LOCAL-mode image compression, in place: resize to fit 1920px and re-encode to
// WebP q80. Updates req.file so the route stores the compressed file. This is the
// original behaviour and runs when we are NOT pushing to a remote backend.
async function compressImageLocal(req) {
  const f = req.file;
  if (!sharp || !f || !/^image\//.test(f.mimetype || '')) return;
  if (/gif|svg/i.test(f.mimetype)) return; // leave animations / vectors alone
  try {
    const outName = f.filename.replace(/\.[^.]+$/, '') + '.webp';
    const outPath = path.join(UP_DIR, outName);
    const samePath = outPath === f.path;
    const writePath = samePath ? outPath + '.tmp' : outPath;
    await sharp(f.path)
      .rotate()
      .resize({ width: 1920, height: 1920, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 80 })
      .toFile(writePath);
    if (samePath) fs.renameSync(writePath, outPath);
    else { try { fs.unlinkSync(f.path); } catch (e) {} }
    f.filename = outName;
    f.path = outPath;
    f.mimetype = 'image/webp';
  } catch (e) {
    logger.warn({ err: e }, 'image compression failed; keeping original');
  }
}

// Reject the upload if it would push the user past their tier's total storage
// cap. Runs once we know the FINAL stored size, just before committing. On
// failure it runs cleanupFn (remove the processed file we were about to keep) and
// throws a 413 so the user gets a clear "you are out of space" message. A 0/falsy
// cap means unlimited.
function assertQuota(user, addBytes, cleanupFn) {
  const cap = storageLimitBytes(user);
  if (!cap) return;
  const used = cleanup.usageBytes(user && user.id);
  if (used + addBytes > cap) {
    if (cleanupFn) { try { cleanupFn(); } catch (e) {} }
    throw Object.assign(
      new Error('You have used all of your storage. Upgrade for more space, or delete some older photos and videos to free up room.'),
      { status: 413 }
    );
  }
}

// Finalise an upload after multer has written the original to disk. Applies the
// right optimisation for the media kind, enforces the storage quota, then either
// leaves the file on disk (local) or pushes it to the egress-free backend (s3)
// under a content-addressed key. Records the object in user_media so it can be
// counted toward quota and truly deleted later.
async function finalize(req, isImage) {
  const f = req.file;
  if (!f) return;
  const remote = storage.isRemote();
  const userId = req.user && req.user.id;
  let key = null;
  let bytes = 0;
  const rmTmp = (p) => () => { try { fs.unlinkSync(p); } catch (e) {} };

  // -------- images (jpeg/png/webp/etc; not gif/svg) --------
  if (isImage && /^image\//.test(f.mimetype || '') && !/gif|svg/i.test(f.mimetype)) {
    if (!remote) {
      await compressImageLocal(req); // sets f.filename/path/mimetype on disk
      key = f.filename;
      try { bytes = fs.statSync(f.path).size; } catch (e) { bytes = 0; }
      assertQuota(req.user, bytes, rmTmp(f.path));
    } else if (processor.hasSharp) {
      // remote: target ~300 KB, content-address, check quota, push, drop temp.
      const r = await processor.optimizeImage(f.path, {});
      key = storage.contentKey(r.buffer, r.ext);
      bytes = r.bytes;
      assertQuota(req.user, bytes, rmTmp(f.path));
      await storage.put(key, r.buffer, r.contentType);
      await fs.promises.unlink(f.path).catch(() => {});
      f.path = null; f.mimetype = r.contentType;
    } else {
      // no compressor available: push the original bytes.
      const buf = await fs.promises.readFile(f.path);
      key = storage.contentKey(buf, path.extname(f.filename) || '.jpg');
      bytes = buf.length;
      assertQuota(req.user, bytes, rmTmp(f.path));
      await storage.put(key, buf, f.mimetype);
      await fs.promises.unlink(f.path).catch(() => {});
      f.path = null;
    }
  }
  // -------- gif / svg images: never re-encode; just store --------
  else if (isImage) {
    if (!remote) {
      key = f.filename;
      try { bytes = fs.statSync(f.path).size; } catch (e) { bytes = 0; }
      assertQuota(req.user, bytes, rmTmp(f.path));
    } else {
      const buf = await fs.promises.readFile(f.path);
      key = storage.contentKey(buf, path.extname(f.filename) || '.bin');
      bytes = buf.length;
      assertQuota(req.user, bytes, rmTmp(f.path));
      await storage.put(key, buf, f.mimetype);
      await fs.promises.unlink(f.path).catch(() => {});
      f.path = null;
    }
  }
  // -------- video --------
  else {
    let current = f.path;
    let ext = path.extname(f.filename).toLowerCase() || '.mp4';
    if (TRANSCODE) {
      const t = await processor.transcodeVideo(current, {});
      if (t) {
        await fs.promises.unlink(current).catch(() => {});
        current = t.path; ext = '.mp4'; f.mimetype = t.contentType;
      }
    }
    try { bytes = fs.statSync(current).size; } catch (e) { bytes = 0; }
    assertQuota(req.user, bytes, rmTmp(current));
    if (!remote) {
      key = path.basename(current);
      f.path = current;
    } else {
      const hash = await hashFile(current);
      key = hash + ext;
      await storage.put(key, current, f.mimetype); // put() unlinks the temp path
      f.path = null;
    }
  }

  f.filename = key;
  cleanup.recordUpload(userId, key, bytes);
}

// Build a middleware that mirrors multer's .single(field): applies the per-tier
// limit per request, then runs the optimisation + storage pipeline.
function singleFactory(filter, isImage) {
  return function (field) {
    return function (req, res, next) {
      const mw = multer({ storage: diskStorage, fileFilter: filter, limits: { fileSize: limitBytesFor(req.user) } }).single(field);
      mw(req, res, (err) => {
        if (err) return next(err);
        finalize(req, isImage).then(() => next()).catch((e) => {
          // Errors with an explicit status (quota 413, etc.) always surface so
          // the user sees a clear message, in either backend mode.
          if (e && e.status) return next(e);
          // A remote-push failure must surface (a dead reference is worse than a
          // visible error). A local optimisation failure is non-fatal: the
          // original is still on disk, so continue.
          if (storage.isRemote()) {
            logger.error({ err: e }, 'media finalize failed (remote)');
            return next(Object.assign(new Error('Upload could not be stored. Please try again.'), { status: 502 }));
          }
          logger.warn({ err: e }, 'media finalize failed (local); keeping original');
          next();
        });
      });
    };
  };
}

// Same shape the routes already use: upload.single('image') / videoUpload.single('video').
const upload = { single: singleFactory(imageFilter, true) };
const videoUpload = { single: singleFactory(videoFilter, false) };

module.exports = { upload, videoUpload, UP_DIR, uploadLimitMb, TIER_UPLOAD_MB };
