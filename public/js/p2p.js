// public/js/p2p.js
// Opportunistic peer-to-peer OFFLOAD for OpenBook video, browser side.
//
// Read this before wiring it up, because the honest design here is deliberately
// narrower than "serve everything over IPFS":
//
//   1. The CDN (Cloudflare R2 + edge) is ALWAYS the source of truth and the
//      guaranteed fallback. P2P never replaces it. P2P only tries to fetch the
//      SAME bytes from other viewers first, and to upload (seed) those bytes to
//      other viewers while you watch. When the swarm is empty, slow, or blocked
//      by a firewall, we fall back to the CDN and the user notices nothing.
//
//   2. P2P is for PUBLIC content only. The torrent / infohash for a clip is
//      effectively a public address: anyone who has it can fetch the bytes, and
//      you cannot "unshare" what a peer already pulled. That is fine for a public
//      reel that the author published to the world. It is NOT acceptable for
//      friends-only or private media, which must stay CDN-only. The server marks
//      which clips are public; this module refuses to seed anything else.
//
//   3. WebRTC needs a signaling tracker (cheap) and, behind hard NATs, a TURN
//      relay (NOT cheap: TURN relays bandwidth, which is the egress we are trying
//      to avoid). So we use STUN by default and treat TURN as an optional, capped
//      last resort. Most of the saving comes from open and cone NATs reaching
//      each other directly. P2P is a bonus on top of the CDN, not a replacement
//      for it.
//
// Transport: WebTorrent. It speaks the BitTorrent protocol over WebRTC data
// channels, is mature in the browser, computes a content address (infohash) for
// us, and gives us seeding for free. It is loaded lazily from a CDN script the
// first time a public clip asks for it, so it adds ZERO weight to normal page
// loads. (A pure libp2p + Bitswap + UnixFS CID path is possible with Helia; see
// media/ARCHITECTURE.md for why WebTorrent is the pragmatic browser choice today.)

(function () {
  'use strict';

  var WEBTORRENT_SRC = 'https://cdn.jsdelivr.net/npm/webtorrent@2/webtorrent.min.js';
  // Public, free WebRTC trackers for swarm discovery (signaling only, not data).
  // Run your own (bittorrent-tracker) for reliability at scale.
  var TRACKERS = [
    'wss://tracker.openwebtorrent.com',
    'wss://tracker.webtorrent.dev',
  ];
  // How long we let the swarm try before giving up and using the CDN. Kept short
  // so a cold/empty swarm never makes the user wait.
  var SWARM_DEADLINE_MS = 3500;

  var _clientPromise = null; // singleton WebTorrent client (one per tab)
  var _scriptPromise = null; // singleton script load
  var _enabled = true;       // global kill switch (set false to force CDN-only)

  function supported() {
    return _enabled &&
      typeof window !== 'undefined' &&
      typeof window.RTCPeerConnection !== 'undefined';
  }

  // Load the WebTorrent bundle exactly once, only when first needed.
  function loadWebTorrent() {
    if (window.WebTorrent) return Promise.resolve(window.WebTorrent);
    if (_scriptPromise) return _scriptPromise;
    _scriptPromise = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = WEBTORRENT_SRC;
      s.async = true;
      s.onload = function () { resolve(window.WebTorrent); };
      s.onerror = function () { reject(new Error('failed to load webtorrent')); };
      document.head.appendChild(s);
    });
    return _scriptPromise;
  }

  function getClient() {
    if (_clientPromise) return _clientPromise;
    _clientPromise = loadWebTorrent().then(function (WebTorrent) {
      var opts = {};
      // Optional TURN relay: only if the page configured one. STUN is implicit.
      if (window.OB_P2P_ICE) opts.tracker = { rtcConfig: { iceServers: window.OB_P2P_ICE } };
      var client = new WebTorrent(opts);
      client.on('error', function (e) { /* swallow: we always have the CDN */ });
      return client;
    });
    return _clientPromise;
  }

  // Pick the matching file out of a torrent (a clip torrent normally has one).
  function pickVideoFile(torrent) {
    var files = torrent.files || [];
    for (var i = 0; i < files.length; i++) {
      if (/\.(mp4|webm|m4v|mov)$/i.test(files[i].name)) return files[i];
    }
    return files[0] || null;
  }

  // Attach a clip to a <video> element with the CDN-first, swarm-after strategy.
  //
  //   videoEl  the <video> to play into
  //   opts = {
  //     cdnUrl   REQUIRED. The canonical CDN url. Always works.
  //     magnet   OPTIONAL. magnet: uri or infohash for the swarm.
  //     isPublic OPTIONAL. must be truthy to use/seed P2P at all.
  //     seed     OPTIONAL (default true). keep seeding to peers while watching.
  //   }
  //
  // Returns a handle with .destroy() to leave the swarm (call when the clip
  // scrolls off screen / the player closes) so we are not seeding forever.
  function attach(videoEl, opts) {
    opts = opts || {};
    if (!videoEl || !opts.cdnUrl) throw new Error('attach requires videoEl and opts.cdnUrl');

    // The safe default and the only path for private content: just play the CDN.
    function playCdn() {
      if (videoEl.src !== opts.cdnUrl) videoEl.src = opts.cdnUrl;
      return { source: 'cdn', destroy: function () {} };
    }

    // Refuse P2P unless this is public content, we have an address, and the
    // browser can do WebRTC. Anything else is CDN-only, by design.
    if (!opts.magnet || !opts.isPublic || !supported()) {
      return playCdn();
    }

    var handle = { source: 'pending', torrent: null, destroyed: false, destroy: noop };
    var settled = false;

    // If the swarm has not produced playable bytes by the deadline, fall back to
    // the CDN. We do NOT tear down the torrent on fallback: it can keep seeding
    // and may still serve later range requests, but the user is already watching.
    var deadline = setTimeout(function () {
      if (!settled) { settled = true; playCdn(); handle.source = 'cdn-fallback'; }
    }, SWARM_DEADLINE_MS);

    getClient().then(function (client) {
      if (handle.destroyed) return;

      // Avoid adding the same infohash twice (it throws). Reuse if present.
      var existing = client.get(opts.magnet);
      var onReady = function (torrent) {
        handle.torrent = torrent;
        var file = pickVideoFile(torrent);
        if (!file) { if (!settled) { settled = true; clearTimeout(deadline); playCdn(); } return; }

        // streamTo wires the file into the <video> via Media Source Extensions,
        // pulling pieces from peers (and seeding what we have to others). If it
        // succeeds before the deadline we are playing from the swarm.
        file.streamTo(videoEl);
        if (!settled) { settled = true; clearTimeout(deadline); handle.source = 'p2p'; }

        // If we are NOT meant to keep seeding, drop the torrent once buffered.
        if (opts.seed === false) {
          torrent.on('done', function () { safeRemove(client, torrent); });
        }
      };

      if (existing && existing.ready) return onReady(existing);
      if (existing) return existing.on('ready', function () { onReady(existing); });

      client.add(opts.magnet, { announce: TRACKERS }, function (torrent) { onReady(torrent); });
    }).catch(function () {
      if (!settled) { settled = true; clearTimeout(deadline); playCdn(); handle.source = 'cdn-fallback'; }
    });

    handle.destroy = function () {
      handle.destroyed = true;
      clearTimeout(deadline);
      getClient().then(function (client) {
        if (handle.torrent) safeRemove(client, handle.torrent);
      }).catch(noop);
    };
    return handle;
  }

  // Seed a freshly recorded/uploaded clip from the uploader's own browser so the
  // first viewers can pull from them immediately (warms the swarm before the file
  // is even widely cached). Public content only. Returns a promise of the magnet
  // uri, which you POST back to the server to store alongside the CDN url.
  function seedFile(file, name) {
    if (!supported()) return Promise.reject(new Error('p2p unsupported'));
    return getClient().then(function (client) {
      return new Promise(function (resolve) {
        client.seed(file, { name: name, announce: TRACKERS }, function (torrent) {
          resolve(torrent.magnetURI);
        });
      });
    });
  }

  function safeRemove(client, torrent) {
    try { client.remove(torrent, { destroyStore: false }); } catch (e) {}
  }
  function noop() {}

  // Public API on window. Set window.OB_P2P_ICE before this loads to add TURN.
  window.OBP2P = {
    attach: attach,
    seedFile: seedFile,
    supported: supported,
    disable: function () { _enabled = false; },
    enable: function () { _enabled = true; },
  };
})();
