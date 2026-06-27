// media/storage.js
// Backend-agnostic object storage for OpenBook media.
//
// Two backends behind one interface, chosen by the MEDIA_BACKEND env var:
//
//   "local" (default)  files on the persistent disk under DATA_DIR/uploads,
//                      served by express.static. This is exactly today's
//                      behaviour, so with no env set NOTHING changes.
//
//   "s3"               an S3-compatible, EGRESS-FREE bucket (Cloudflare R2 or
//                      Backblaze B2). Objects are content-addressed, written
//                      once with a one-year immutable Cache-Control, and read
//                      by browsers straight from a CDN edge (publicUrl), so the
//                      origin never pays bandwidth for a cache hit.
//
// The whole point of the abstraction: every upload route keeps storing a stable
// "/uploads/<key>" string in the database. In local mode that path is served
// directly; in s3 mode server.js turns it into a 302 to the CDN. Callers never
// learn which backend is live, and you can flip backends with one env var plus
// a one-time backfill.
//
// The AWS SDK is required lazily and optionally (same pattern as sharp): if it
// is not installed, s3 mode logs a clear error and the app keeps running on the
// local backend instead of crashing.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { logger } = require('../logger');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..');
const UP_DIR = path.join(DATA_DIR, 'uploads');
if (!fs.existsSync(UP_DIR)) fs.mkdirSync(UP_DIR, { recursive: true });

const BACKEND = (process.env.MEDIA_BACKEND || 'local').toLowerCase();

// One year, and "immutable" because keys are content-addressed: the bytes for a
// given key can never change, so the browser and the CDN may cache forever.
const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';

// Minimal, dependency-free content-type table. Uploaded media is normalised to a
// short list of formats by the processor, so this stays small on purpose.
const CONTENT_TYPES = {
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.m4v': 'video/x-m4v',
  '.mov': 'video/quicktime',
};
function contentTypeFor(key) {
  return CONTENT_TYPES[path.extname(key).toLowerCase()] || 'application/octet-stream';
}

// Content-addressed key: sha256 of the bytes plus the real extension. Identical
// uploads collapse to one object (free dedupe) and "immutable" caching is always
// safe because the key IS the hash of the content.
function contentKey(buffer, ext) {
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  const clean = (ext || '').toLowerCase().replace(/[^a-z0-9.]/g, '');
  return hash + (clean.startsWith('.') ? clean : '.' + clean);
}

// ---------------------------------------------------------------------------
// Local backend: the disk we already use. Implemented against the same shape as
// the S3 backend so the rest of the app is identical in both modes.
// ---------------------------------------------------------------------------
const localBackend = {
  mode: 'local',
  async put(key, body, _contentType) {
    const dest = path.join(UP_DIR, key);
    if (Buffer.isBuffer(body)) {
      await fs.promises.writeFile(dest, body);
    } else if (typeof body === 'string') {
      // body is a path to an existing file: move it into place (rename, then
      // copy+unlink as a fallback across devices).
      if (path.resolve(body) === path.resolve(dest)) return key;
      try {
        await fs.promises.rename(body, dest);
      } catch (e) {
        await fs.promises.copyFile(body, dest);
        await fs.promises.unlink(body).catch(() => {});
      }
    } else {
      // a readable stream
      await new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(dest);
        body.on('error', reject);
        ws.on('error', reject);
        ws.on('finish', resolve);
        body.pipe(ws);
      });
    }
    return key;
  },
  async del(key) {
    await fs.promises.unlink(path.join(UP_DIR, key)).catch(() => {});
  },
  // express.static already streams local files with Range support, so the
  // /uploads route stays a static mount in local mode and this is unused there.
  // Kept for interface symmetry and for any code that wants raw bytes.
  stream(key) {
    const full = path.join(UP_DIR, key);
    const stat = fs.statSync(full);
    return { stream: fs.createReadStream(full), contentType: contentTypeFor(key), contentLength: stat.size };
  },
  publicUrl(key) {
    return '/uploads/' + key;
  },
};

// ---------------------------------------------------------------------------
// S3 backend: Cloudflare R2 or Backblaze B2 over the S3 API.
// ---------------------------------------------------------------------------
// Required env in s3 mode:
//   S3_ENDPOINT           e.g. https://<accountid>.r2.cloudflarestorage.com
//                         or   https://s3.us-west-004.backblazeb2.com
//   S3_BUCKET             bucket name
//   S3_ACCESS_KEY_ID      access key id
//   S3_SECRET_ACCESS_KEY  secret access key
//   MEDIA_CDN_BASE        public CDN origin in front of the bucket,
//                         e.g. https://cdn.openbook.space  (NO trailing slash)
// Optional:
//   S3_REGION             defaults to "auto" (correct for R2)
//   S3_FORCE_PATH_STYLE   "1" for providers that need path-style addressing
let _s3 = null;       // cached client
let _s3lib = null;    // cached { Upload }
function loadS3() {
  if (_s3) return _s3;
  // Lazy + optional. If the SDK is not installed we do NOT crash; the caller
  // falls back to local. Install to activate: npm i @aws-sdk/client-s3 @aws-sdk/lib-storage
  const { S3Client, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
  _s3lib = require('@aws-sdk/lib-storage');
  _s3 = {
    client: new S3Client({
      region: process.env.S3_REGION || 'auto',
      endpoint: process.env.S3_ENDPOINT,
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === '1',
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID,
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
      },
    }),
    GetObjectCommand,
    DeleteObjectCommand,
  };
  return _s3;
}

const s3Backend = {
  mode: 's3',
  async put(key, body, contentType) {
    const s3 = loadS3();
    // body may be a Buffer, a readable stream, or a path to a file on disk.
    let source = body;
    if (typeof body === 'string') source = fs.createReadStream(body);
    // lib-storage's Upload handles streams of unknown length and switches to a
    // multipart upload automatically for large objects (videos), so a 1 GB reel
    // never has to sit fully in memory.
    const uploader = new _s3lib.Upload({
      client: s3.client,
      params: {
        Bucket: process.env.S3_BUCKET,
        Key: key,
        Body: source,
        ContentType: contentType || contentTypeFor(key),
        CacheControl: IMMUTABLE_CACHE,
      },
      queueSize: 4,                 // up to 4 parts in flight
      partSize: 8 * 1024 * 1024,    // 8 MB parts
    });
    await uploader.done();
    // if the source was a temp file on disk, remove it now that it is uploaded.
    if (typeof body === 'string') await fs.promises.unlink(body).catch(() => {});
    return key;
  },
  async del(key) {
    const s3 = loadS3();
    await s3.client.send(new s3.DeleteObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }));
  },
  // Fallback origin streaming with HTTP Range passthrough. The hot path is the
  // CDN (publicUrl); this is only used if something needs the bytes through the
  // origin (for example a private-object proxy you add later). It still counts
  // as egress, so it must NOT be the default delivery path for public media.
  async stream(key, range) {
    const s3 = loadS3();
    const out = await s3.client.send(new s3.GetObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: key,
      Range: range || undefined,
    }));
    return {
      stream: out.Body,
      contentType: out.ContentType || contentTypeFor(key),
      contentLength: out.ContentLength,
      contentRange: out.ContentRange,
      acceptRanges: out.AcceptRanges,
      status: range ? 206 : 200,
    };
  },
  publicUrl(key) {
    const base = (process.env.MEDIA_CDN_BASE || '').replace(/\/+$/, '');
    return base + '/' + key;
  },
};

// Pick the active backend once at load. If s3 is requested but its config is
// incomplete or the SDK is missing, fall back to local with a loud warning so a
// misconfigured deploy degrades to "works, just not zero-egress" instead of
// breaking uploads.
function pickBackend() {
  if (BACKEND !== 's3') return localBackend;
  const need = ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'MEDIA_CDN_BASE'];
  const missing = need.filter((k) => !process.env[k]);
  if (missing.length) {
    logger.error({ missing }, 'MEDIA_BACKEND=s3 but required env is missing; falling back to local storage');
    return localBackend;
  }
  try {
    loadS3();
  } catch (e) {
    logger.error({ err: e }, 'MEDIA_BACKEND=s3 but @aws-sdk is not installed; falling back to local storage');
    return localBackend;
  }
  logger.info({ bucket: process.env.S3_BUCKET, cdn: process.env.MEDIA_CDN_BASE }, 'media storage: s3 (zero-egress) backend active');
  return s3Backend;
}

const active = pickBackend();

module.exports = {
  // active backend interface
  put: (key, body, contentType) => active.put(key, body, contentType),
  del: (key) => active.del(key),
  stream: (key, range) => active.stream(key, range),
  publicUrl: (key) => active.publicUrl(key),
  // introspection used by the upload pipeline and the /uploads route
  get mode() { return active.mode; },
  isRemote: () => active.mode === 's3',
  // helpers shared with the processor
  contentKey,
  contentTypeFor,
  IMMUTABLE_CACHE,
  UP_DIR,
};
