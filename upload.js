// upload.js
// Image upload handling with multer. Files are saved on disk in /uploads
// and served back statically. Each filename is randomized to avoid clashes.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');

// Keep uploads under DATA_DIR so they can live on a persistent volume in
// production; defaults to the project folder locally.
const UP_DIR = path.join(process.env.DATA_DIR || __dirname, 'uploads');
if (!fs.existsSync(UP_DIR)) fs.mkdirSync(UP_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UP_DIR),
  filename: (req, file, cb) => {
    const ext = (path.extname(file.originalname) || '.jpg').toLowerCase();
    const name = Date.now() + '_' + crypto.randomBytes(6).toString('hex') + ext;
    cb(null, name);
  },
});

function imageFilter(req, file, cb) {
  if (/^image\//.test(file.mimetype)) cb(null, true);
  else cb(Object.assign(new Error('Only image files are allowed'), { status: 400 }));
}

const upload = multer({
  storage,
  fileFilter: imageFilter,
  limits: { fileSize: 8 * 1024 * 1024 }, // 8 MB per image
});

function videoFilter(req, file, cb) {
  if (/^video\//.test(file.mimetype)) cb(null, true);
  else cb(Object.assign(new Error('Only video files are allowed'), { status: 400 }));
}

// Reels: short videos. Same disk storage, a larger size cap.
const videoUpload = multer({
  storage,
  fileFilter: videoFilter,
  limits: { fileSize: 60 * 1024 * 1024 }, // 60 MB per reel
});

module.exports = { upload, videoUpload, UP_DIR };
