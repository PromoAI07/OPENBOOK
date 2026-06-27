// media/processor.js
// Crunch uploaded media to the smallest size that still looks good, BEFORE it
// ever reaches long-term storage. Two jobs:
//
//   optimizeImage()  resize to fit 1920px, then encode to WebP (or AVIF) while
//                    searching quality down toward a ~300 KB target.
//
//   transcodeVideo() re-encode to a mobile-friendly MP4 with the moov atom moved
//                    to the FRONT (-movflags +faststart) so playback starts
//                    before the whole file downloads, at a bitrate chosen to hit
//                    a target size (about 4 MB for a 15s short).
//
// Both degrade gracefully: if sharp is missing the original image is kept, and
// if ffmpeg is not on the system the original video is kept. Nothing here throws
// into the request path; a failed optimisation just means a bigger file, never a
// failed upload.
//
// WHERE THIS SHOULD RUN (important, read media/ARCHITECTURE.md):
//   - optimizeImage is cheap (sharp is native and fast) and is fine inline on
//     the web process, which is what upload.js already does for images.
//   - transcodeVideo is CPU-heavy. Inline on a small web dyno it will stall the
//     event loop and starve other requests. Run it on a worker, a queue, or
//     client-side (ffmpeg.wasm / WebCodecs) at scale. It lives here as the
//     reference implementation and is correct to call from a background job.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { logger } = require('../logger');

let sharp = null;
try { sharp = require('sharp'); } catch (e) { /* optional; images pass through uncompressed */ }

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------
// Targets a file size by stepping the encoder quality down until the output is
// at or under targetKB (or we hit the quality floor). AVIF gives ~20-30% smaller
// files than WebP at similar quality but costs more CPU to encode; pick with
// MEDIA_IMAGE_FORMAT=avif when you have the headroom. Default is WebP.
//
// Returns { buffer, ext, contentType, bytes, width, height, format }.
async function optimizeImage(input, opts = {}) {
  if (!sharp) throw new Error('sharp not installed');
  const targetKB = opts.targetKB || Number(process.env.MEDIA_IMAGE_TARGET_KB || 300);
  const maxDim = opts.maxDim || 1920;
  const format = (opts.format || process.env.MEDIA_IMAGE_FORMAT || 'webp').toLowerCase();

  // Decode once, normalise orientation, downscale to fit. We reuse this pipeline
  // object per quality attempt so we are not re-reading the source each loop.
  const base = sharp(input, { failOn: 'none' })
    .rotate()
    .resize({ width: maxDim, height: maxDim, fit: 'inside', withoutEnlargement: true });

  // Quality ladder, high to low. We stop at the first size under target. The
  // floor (40) keeps us from shipping mush even if a photo is huge and noisy.
  // toBuffer({ resolveWithObject: true }) returns the ACTUAL output dimensions
  // and byte size (metadata() would report the source dims, before the resize).
  const ladder = [82, 72, 62, 52, 45, 40];
  let best = null;
  for (const q of ladder) {
    const pipeline = base.clone();
    const { data, info } = format === 'avif'
      ? await pipeline.avif({ quality: q, effort: 4 }).toBuffer({ resolveWithObject: true })
      : await pipeline.webp({ quality: q }).toBuffer({ resolveWithObject: true });
    best = { buffer: data, quality: q, width: info.width, height: info.height };
    if (data.length <= targetKB * 1024) break;
  }

  const ext = format === 'avif' ? '.avif' : '.webp';
  return {
    buffer: best.buffer,
    ext,
    contentType: format === 'avif' ? 'image/avif' : 'image/webp',
    bytes: best.buffer.length,
    width: best.width || null,
    height: best.height || null,
    format,
    quality: best.quality,
  };
}

// ---------------------------------------------------------------------------
// Video
// ---------------------------------------------------------------------------
// Probe duration so we can size the bitrate to a target file. Returns seconds as
// a float, or null if ffprobe is unavailable / fails (caller then keeps original).
function probeDuration(input) {
  return new Promise((resolve) => {
    const args = ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', input];
    let out = '';
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let p;
    try { p = spawn(FFPROBE, args); } catch (e) { return finish(null); }
    p.stdout.on('data', (d) => { out += d.toString(); });
    p.on('error', () => finish(null));
    p.on('close', (code) => {
      if (code !== 0) return finish(null);
      const secs = parseFloat(out.trim());
      finish(Number.isFinite(secs) && secs > 0 ? secs : null);
    });
  });
}

// Transcode to a fast-start MP4 sized toward targetMB. We compute a total
// bitrate budget from (targetMB, duration), reserve a fixed slice for audio, and
// give the rest to video with a maxrate cap + VBV buffer so a noisy scene cannot
// blow the size budget. H.264 (libx264) is the safe default for universal mobile
// playback; set MEDIA_VIDEO_CODEC=av1 (libsvtav1) or hevc (libx265) for ~30-50%
// smaller files when your players support them.
//
// Returns { path, ext, contentType, bytes } for the new file, or null if ffmpeg
// is missing or the transcode fails (caller keeps the original upload).
async function transcodeVideo(input, opts = {}) {
  const targetMB = opts.targetMB || Number(process.env.MEDIA_VIDEO_TARGET_MB || 4);
  const maxDim = opts.maxDim || 720;             // vertical shorts: cap the long edge
  const audioKbps = opts.audioKbps || 96;
  const codec = (opts.codec || process.env.MEDIA_VIDEO_CODEC || 'h264').toLowerCase();

  const duration = await probeDuration(input);
  // Without a duration we cannot size a bitrate safely. Bail to "keep original".
  if (!duration) {
    logger.warn('transcodeVideo: could not probe duration (ffprobe missing?); keeping original');
    return null;
  }

  // Bit budget. total_bits = targetMB * 8 * 1024 * 1024. Subtract audio, keep
  // ~6% headroom for container overhead, the rest is the video bitrate.
  const totalKbit = (targetMB * 8 * 1024) / duration;          // kbit/s for the whole file
  const videoKbps = Math.max(200, Math.floor((totalKbit - audioKbps) * 0.94));
  const maxrate = Math.floor(videoKbps * 1.45);
  const bufsize = Math.floor(videoKbps * 2);

  const outPath = path.join(
    path.dirname(input),
    'opt_' + crypto.randomBytes(6).toString('hex') + '.mp4'
  );

  // Scale so the LONG edge is at most maxDim, keep aspect, force even dims
  // (yuv420p / H.264 require even width+height).
  const vf = `scale='if(gt(iw,ih),min(${maxDim},iw),-2)':'if(gt(iw,ih),-2,min(${maxDim},ih))'`;

  const codecArgs = {
    h264: ['-c:v', 'libx264', '-preset', 'veal' /* see note below */, '-profile:v', 'high', '-pix_fmt', 'yuv420p'],
    hevc: ['-c:v', 'libx265', '-preset', 'medium', '-tag:v', 'hvc1', '-pix_fmt', 'yuv420p'],
    av1: ['-c:v', 'libsvtav1', '-preset', '8', '-pix_fmt', 'yuv420p'],
  }[codec] || ['-c:v', 'libx264', '-preset', 'medium', '-profile:v', 'high', '-pix_fmt', 'yuv420p'];

  // NOTE: libx264 has no "veal" preset; guard against a typo by normalising any
  // unknown preset to "medium" before spawning.
  for (let i = 0; i < codecArgs.length; i++) {
    if (codecArgs[i] === '-preset' && codecArgs[i + 1] && !/^(ultrafast|superfast|veryfast|faster|fast|medium|slow|slower|veryslow|[0-9]+)$/.test(codecArgs[i + 1])) {
      codecArgs[i + 1] = 'medium';
    }
  }

  const args = [
    '-y',
    '-i', input,
    '-vf', vf,
    ...codecArgs,
    '-b:v', `${videoKbps}k`,
    '-maxrate', `${maxrate}k`,
    '-bufsize', `${bufsize}k`,
    '-c:a', 'aac', '-b:a', `${audioKbps}k`,
    '-movflags', '+faststart',   // moov atom to the front: progressive playback
    outPath,
  ];

  const ok = await new Promise((resolve) => {
    let p;
    let stderr = '';
    try { p = spawn(FFMPEG, args); } catch (e) { return resolve(false); }
    p.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > 8000) stderr = stderr.slice(-8000); });
    p.on('error', (e) => { logger.warn({ err: e.message }, 'ffmpeg spawn failed; keeping original video'); resolve(false); });
    p.on('close', (code) => {
      if (code === 0) return resolve(true);
      logger.warn({ code, tail: stderr.slice(-500) }, 'ffmpeg exited non-zero; keeping original video');
      resolve(false);
    });
  });

  if (!ok) { try { fs.unlinkSync(outPath); } catch (e) {} return null; }

  let bytes = 0;
  try { bytes = fs.statSync(outPath).size; } catch (e) {}
  return { path: outPath, ext: '.mp4', contentType: 'video/mp4', bytes };
}

// Content-addressed key from raw bytes (sha256 + extension). Used so the same
// file uploaded twice maps to one storage object and can be cached immutably.
function keyFromBuffer(buffer, ext) {
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  const clean = (ext || '').toLowerCase().replace(/[^a-z0-9.]/g, '');
  return hash + (clean.startsWith('.') ? clean : '.' + clean);
}

module.exports = { optimizeImage, transcodeVideo, probeDuration, keyFromBuffer, hasSharp: !!sharp };
