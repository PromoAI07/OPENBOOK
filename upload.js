// upload.js
// Upload handling with multer. Files are saved on disk under DATA_DIR/uploads
// (so they live on the persistent disk in production) and served statically.
//
// Two things layered on top of plain multer, both transparent to the routes
// (they still call upload.single('image') / videoUpload.single('video')):
//   1. Per-tier size limit. Free accounts get 100 MB per file; paid tiers get
//      more ("pay for extra storage"). The limit is chosen per-request from the
//      logged-in user's effective supporter tier.
//   2. Image compression. Uploaded images are resized (max 1920px) and re-encoded
//      to WebP q80, which shrinks them dramatically with little visible quality
//      loss. Uses sharp if available and degrades gracefully (keeps the original)
//      if sharp is missing or fails. Videos are not transcoded.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { logger } = require('./logger');
const { effectiveTier } = require('./entitlements');

const UP_DIR = path.join(process.env.DATA_DIR || __dirname, 'uploads');
if (!fs.existsSync(UP_DIR)) fs.mkdirSync(UP_DIR, { recursive: true });

// Optional native image compressor. If it is not installed (or fails to load),
// uploads still work, just without compression.
let sharp = null;
try { sharp = require('sharp'); } catch (e) { logger.warn('sharp not available; image uploads will not be compressed'); }

const storage = multer.diskStorage({
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

// Compress an uploaded image in place: resize to fit 1920px and re-encode to
// WebP q80. Updates req.file.filename so the route stores the compressed file.
async function compressImage(req) {
  const f = req.file;
  if (!sharp || !f || !/^image\//.test(f.mimetype || '')) return;
  if (/gif|svg/i.test(f.mimetype)) return; // leave animations / vectors alone
  try {
    const outName = f.filename.replace(/\.[^.]+$/, '') + '.webp';
    const outPath = path.join(UP_DIR, outName);
    const samePath = outPath === f.path;
    const writePath = samePath ? outPath + '.tmp' : outPath;
    await sharp(f.path)
      .rotate() // honor EXIF orientation
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

// Build a middleware that mirrors multer's .single(field) but applies the
// per-tier limit per request and (for images) compresses afterward.
function singleFactory(filter, compress) {
  return function (field) {
    return function (req, res, next) {
      const mw = multer({ storage, fileFilter: filter, limits: { fileSize: limitBytesFor(req.user) } }).single(field);
      mw(req, res, (err) => {
        if (err) return next(err);
        if (!compress) return next();
        compressImage(req).then(() => next()).catch(() => next());
      });
    };
  };
}

// Same shape the routes already use: upload.single('image') / videoUpload.single('video').
const upload = { single: singleFactory(imageFilter, true) };
const videoUpload = { single: singleFactory(videoFilter, false) };

module.exports = { upload, videoUpload, UP_DIR, uploadLimitMb, TIER_UPLOAD_MB };
