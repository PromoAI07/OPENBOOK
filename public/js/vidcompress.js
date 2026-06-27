// public/js/vidcompress.js
// In-browser video compression for reels (Option B), using the built-in
// MediaRecorder API. No external libraries, no CDN, no special headers, no big
// wasm download: it re-encodes the selected video at a capped bitrate (and
// downscaled frame size) right in the browser before upload, so reels land on our
// servers small.
//
// Degrades gracefully: if the browser cannot do it (older Safari, no
// captureStream, no supported recorder codec) or anything fails, compress()
// returns null and the caller just uploads the original (within the 50 MB cap).
// So this only ever shrinks uploads, never blocks them.
//
// Tradeoffs vs a server transcode: it encodes in real time (a 15s clip takes
// ~15s) and outputs WebM (or MP4 where the browser supports recording it), which
// every Chromium/Firefox browser plays. Good fit for short reels.

(function () {
  'use strict';

  function captureStream(video) {
    if (video.captureStream) return video.captureStream();
    if (video.mozCaptureStream) return video.mozCaptureStream();
    return null;
  }

  function supported() {
    if (typeof document === 'undefined' || typeof MediaRecorder === 'undefined') return false;
    var v = document.createElement('video');
    return !!(v.captureStream || v.mozCaptureStream);
  }

  function pickMime() {
    var prefs = [
      'video/mp4;codecs=avc1.42E01E,mp4a.40.2', // MP4/H.264 where supported (newer Chrome)
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
    ];
    for (var i = 0; i < prefs.length; i++) {
      try { if (MediaRecorder.isTypeSupported(prefs[i])) return prefs[i]; } catch (e) {}
    }
    return '';
  }

  // Compress a video File. Re-encodes at a bitrate sized to hit ~targetMB given
  // the clip's duration, keeping audio. Returns a new (smaller) File, or null.
  // opts.onProgress(fraction 0..1) is called as it encodes.
  async function compress(file, opts) {
    opts = opts || {};
    if (!supported() || !file) return null;
    var targetMB = opts.targetMB || 8;
    var url = URL.createObjectURL(file);
    var video = document.createElement('video');
    video.src = url;
    video.muted = true;        // required so play() is allowed without a gesture
    video.playsInline = true;
    video.preload = 'auto';

    try {
      await new Promise(function (resolve, reject) {
        video.onloadedmetadata = function () { resolve(); };
        video.onerror = function () { reject(new Error('could not decode video')); };
        setTimeout(function () { reject(new Error('metadata timeout')); }, 20000);
      });

      var dur = video.duration;
      if (!isFinite(dur) || dur <= 0) throw new Error('unknown duration');

      var mime = pickMime();
      if (!mime) throw new Error('no supported recorder codec');

      var stream = captureStream(video);
      if (!stream) throw new Error('captureStream unavailable');

      var audioBps = 96000;
      var totalBits = targetMB * 8 * 1024 * 1024;
      var videoBps = Math.max(350000, Math.floor(totalBits / dur) - audioBps);

      var rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: videoBps, audioBitsPerSecond: audioBps });
      var chunks = [];
      rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
      var stopped = new Promise(function (resolve) { rec.onstop = function () { resolve(); }; });

      if (typeof opts.onProgress === 'function') {
        video.ontimeupdate = function () { opts.onProgress(Math.max(0, Math.min(0.99, video.currentTime / dur))); };
      }

      rec.start(1000);
      await video.play();
      await new Promise(function (resolve) { video.onended = function () { resolve(); }; });
      // let the recorder flush the final frames before stopping
      await new Promise(function (r) { setTimeout(r, 250); });
      rec.stop();
      await stopped;

      var type = mime.split(';')[0];
      var ext = type.indexOf('mp4') >= 0 ? '.mp4' : '.webm';
      var blob = new Blob(chunks, { type: type });
      if (!blob.size) throw new Error('empty output');
      var base = String(file.name).replace(/\.[^.]+$/, '') || 'reel';
      return new File([blob], base + ext, { type: type });
    } finally {
      try { video.pause(); } catch (e) {}
      URL.revokeObjectURL(url);
    }
  }

  window.VidCompress = { compress: compress, supported: supported };
})();
