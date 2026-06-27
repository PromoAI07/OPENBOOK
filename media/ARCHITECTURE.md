# OpenBook media pipeline

Near zero egress media delivery for images and video, built as an additive,
env gated subsystem. With no new env set, OpenBook behaves exactly as before
(files on the local disk, served by `express.static`). Set a few env vars and the
same code paths push optimised media to an egress free bucket and serve it from a
CDN edge, with an optional peer to peer offload for public viral video.

## The one idea that makes this non breaking

Every upload route stores a stable string in the database: `"/uploads/<key>"`.
Nothing in the routes or the frontend ever needs to know where the bytes live.

```
DB row:  posts.image = "/uploads/9f3c...e1.webp"
                         |
        local mode  -----+-----> express.static reads DATA_DIR/uploads/9f3c...e1.webp
        s3 mode     -----+-----> 302 redirect to  https://cdn.openbook.space/9f3c...e1.webp
                                  (browser pulls bytes from the CDN edge, origin pays no egress)
```

So switching backends is one env var plus a one time backfill of old files. No
schema change, no route change, no frontend change.

## Components

| File | Role |
|------|------|
| `media/storage.js` | Backend adapter. `local` (disk) or `s3` (R2 / B2) behind one interface: `put`, `del`, `stream`, `publicUrl`. Content addressed keys, immutable cache headers, multipart upload for large video. |
| `media/processor.js` | `optimizeImage` (sharp, resize 1920px, WebP or AVIF, quality search toward ~300 KB) and `transcodeVideo` (ffmpeg, `+faststart` MP4 sized toward ~4 MB / 15s). Graceful fallback if sharp / ffmpeg are absent. |
| `upload.js` | Multer + per tier size limit, then the optimise + store pipeline. Transparent to routes (`upload.single('image')` unchanged). |
| `server.js` `/uploads` | In s3 mode, 302 to the CDN. In local mode, static from disk. |
| `public/js/p2p.js` | Browser side WebTorrent (WebRTC) offload for PUBLIC video only. CDN stays the source of truth and fallback. |

## Stage 1: ingestion and optimisation

**Images** (cheap, runs inline on the web process):
- Decode once, honour EXIF orientation, resize to fit 1920px.
- Encode to WebP by default, or AVIF (`MEDIA_IMAGE_FORMAT=avif`) for ~20-30%
  smaller files at more CPU cost.
- Walk a quality ladder (82 down to 40) and stop at the first encode under
  `MEDIA_IMAGE_TARGET_KB` (default 300). The floor keeps quality sane on huge,
  noisy photos.

**Video** (CPU heavy, see "where transcoding runs" below):
- Probe duration with ffprobe, compute a bitrate budget from the target size,
  reserve a slice for audio, cap the rest with `-maxrate` + VBV `-bufsize` so one
  busy scene cannot blow the budget.
- `-movflags +faststart` moves the moov atom to the front so playback starts
  before the whole file downloads.
- H.264 (`libx264`) by default for universal mobile playback. `MEDIA_VIDEO_CODEC`
  = `hevc` (`libx265`) or `av1` (`libsvtav1`) for 30-50% smaller files where the
  player supports them.

### Where transcoding runs (important)

Image optimisation with sharp is fast and fine inline. **Video transcoding is
not.** On a small web dyno, an inline ffmpeg run pins the CPU and starves every
other request. So `MEDIA_TRANSCODE` is **off by default**. At any real volume,
run video transcode in one of these places instead:

1. **Client side** (best for "2.4M users"): compress in the browser with
   `ffmpeg.wasm` or the WebCodecs API before upload. The server then just stores
   the already small file. Zero server CPU.
2. **A worker / queue**: accept the raw upload, return fast, transcode on a
   separate worker process or a job queue, then swap the stored object.
3. **Inline** (`MEDIA_TRANSCODE=1`): only acceptable for low volume or a
   dedicated transcode box. The code path works and is the reference for 1 and 2.

## Stage 2: storage and delivery (Engine A, zero egress cloud)

### Why this is actually zero egress

- **Cloudflare R2** charges for storage and operations but **$0 for egress**.
  Put a Cloudflare cache in front (free on R2 via a custom domain) and repeat
  reads are served from the edge cache without even hitting R2, so you also keep
  Class B (read) operations down.
- **Backblaze B2** egress is free when delivered through Cloudflare (Bandwidth
  Alliance). Same pattern: B2 is the origin, Cloudflare is the cache.

Objects are written **once**, content addressed (`sha256.ext`), with
`Cache-Control: public, max-age=31536000, immutable`. Because the key is the hash
of the bytes, the content for a key can never change, so the browser and the CDN
can cache it forever and identical uploads dedupe to one object for free.

### Keeping read operations (Class B billing) down

- Immutable, content addressed objects -> the CDN almost never revalidates.
- The app never `LIST`s the bucket on the hot path (keys come from the DB row).
- The `/uploads` redirect itself carries a 1 hour cache header, so even the
  redirect is mostly served from the browser cache after the first view.

### Config: Cloudflare R2 (recommended)

1. Create an R2 bucket (for example `openbook-media`).
2. Connect a custom domain to the bucket, for example `cdn.openbook.space`. This
   automatically puts the Cloudflare cache in front and gives free egress.
   (Add the DNS record Cloudflare asks for; the bucket becomes public read only
   for objects, which is correct for public media.)
3. Create an R2 API token (Object Read and Write) and note the Access Key ID and
   Secret Access Key, and your account id.
4. Set the env vars below and run the backfill.

```
MEDIA_BACKEND=s3
S3_ENDPOINT=https://<accountid>.r2.cloudflarestorage.com
S3_REGION=auto
S3_BUCKET=openbook-media
S3_ACCESS_KEY_ID=<r2 access key id>
S3_SECRET_ACCESS_KEY=<r2 secret>     # secret: set in the Render dashboard, never in the repo
MEDIA_CDN_BASE=https://cdn.openbook.space
```

Then install the SDK (already listed as optional deps):
```
npm i @aws-sdk/client-s3 @aws-sdk/lib-storage
```

### Config: Backblaze B2 (alternative)

Same env, different endpoint, and turn on path style addressing:
```
S3_ENDPOINT=https://s3.<region>.backblazeb2.com
S3_FORCE_PATH_STYLE=1
```
Put Cloudflare in front of the B2 bucket for free egress (Bandwidth Alliance).

### A cache rule worth setting

For `cdn.openbook.space/*`: Cache Everything, Edge TTL "respect origin"
(the objects already say one year immutable). That is the whole CDN config; the
immutable header does the rest.

## Stage 3: peer to peer offload (Engine B, public video only)

`public/js/p2p.js` adds an **opportunistic** layer on top of the CDN using
WebTorrent (BitTorrent over WebRTC data channels). It is deliberately scoped:

- **CDN first, swarm after.** A clip always has a working CDN url. The player
  tries the swarm with a short deadline (3.5s); if the swarm is empty, slow, or
  firewalled, it falls back to the CDN and the user notices nothing. While a
  viewer watches a swarm backed clip, their browser seeds the buffered pieces to
  other concurrent viewers. When a clip is hot, most bytes move viewer to viewer
  and the CDN read count drops.
- **Public content only.** A torrent infohash is a public address: anyone with it
  can fetch the bytes, and you cannot un share what a peer already pulled. That is
  acceptable for a reel the author published to the world. It is not acceptable
  for private or friends only media, which stays CDN only. The module refuses to
  seed anything not explicitly marked public.

### Honest tradeoffs (read before you turn this on)

1. **IPFS / content addressing is permanent and public.** This is the direct
   tension with OpenBook's promise that users control and can delete their media.
   Announcing a CID or infohash to a public swarm or DHT means the bytes can
   outlive your "delete": the CDN object goes away, but a peer that pinned it can
   still serve it. **Therefore P2P and any public IPFS pinning is opt in, public
   only, and never the path for private content.** Deletion of public media is
   "remove from origin + stop seeding", which is best effort for already
   distributed copies. Say this plainly in the UI for public posts.
2. **TURN relays cost bandwidth.** WebRTC uses STUN (cheap) to connect peers
   directly. Behind hard NATs it needs a TURN relay, which relays the media and
   therefore costs egress, the very thing we are avoiding. So TURN is optional and
   should be capped; most of the saving comes from peers that can connect
   directly. Configure TURN only if you accept the cost, via `window.OB_P2P_ICE`.
3. **Browser P2P lives only while tabs are open.** Seeders disappear when viewers
   close the tab. The swarm is a cache that tracks attention, not durable storage.
   This is exactly why the CDN must remain the source of truth.
4. **WebTorrent vs pure libp2p / Helia.** The spec mentions IPFS CIDs, libp2p, and
   GossipSub. In the browser today, WebTorrent is the pragmatic choice for
   streaming media: mature WebRTC swarm, built in seeding, MSE streaming to a
   `<video>`. Pure libp2p + Bitswap + UnixFS over WebRTC (via Helia) is the
   strict IPFS path and is viable for content addressing and DHT discovery, but
   in browser media streaming it is rougher and heavier. The storage layer
   already content addresses every object by sha256, so moving to true UnixFS
   CIDv1 later is a deterministic wrap of the same hash, not a rewrite.

### Wiring P2P into the reels frontend (sketch)

The server stores an optional `magnet` and an `is_public` flag per reel. The
player then does:

```js
// after rendering a reel <video> element:
var handle = window.OBP2P.attach(videoEl, {
  cdnUrl: reel.video,        // the canonical /uploads or CDN url, always works
  magnet: reel.magnet,       // optional swarm address, public clips only
  isPublic: reel.is_public,  // gate: never P2P private content
});
// when the reel scrolls off screen / the viewer closes it:
handle.destroy();            // leave the swarm so we are not seeding forever
```

To seed from the uploader's own browser right after upload (warms the swarm
before the file is widely cached), call `window.OBP2P.seedFile(file, name)` and
POST the returned magnet back to the server to store on the reel. This is a
frontend follow up; the reels schema needs `magnet TEXT` and an `is_public` flag,
which are not added yet.

## Env var reference

| Var | Default | Meaning |
|-----|---------|---------|
| `MEDIA_BACKEND` | `local` | `local` disk, or `s3` for R2 / B2. |
| `MEDIA_CDN_BASE` | (none) | CDN origin in front of the bucket, no trailing slash. |
| `S3_ENDPOINT` / `S3_BUCKET` / `S3_REGION` | (none) / (none) / `auto` | Bucket connection. |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | (none) | Bucket credentials (secret). |
| `S3_FORCE_PATH_STYLE` | off | `1` for B2 and similar. |
| `MEDIA_IMAGE_FORMAT` | `webp` | `webp` or `avif`. |
| `MEDIA_IMAGE_TARGET_KB` | `300` | Image size target. |
| `MEDIA_TRANSCODE` | off | `1` to transcode video inline (heavy; prefer worker / client). |
| `MEDIA_VIDEO_CODEC` | `h264` | `h264`, `hevc`, or `av1`. |
| `MEDIA_VIDEO_TARGET_MB` | `4` | Video size target. |
| `FFMPEG_PATH` / `FFPROBE_PATH` | `ffmpeg` / `ffprobe` | Binary locations. |

## Rollout (safe order)

1. **Now (already in place):** code is additive and `MEDIA_BACKEND=local`, so
   production is unchanged. Optional SDK deps do not break the build if absent.
2. **Turn on R2:** create the bucket + CDN domain, set the env vars, `npm i` the
   SDK, deploy. New uploads go to R2 and serve from the CDN. Old files still
   serve from disk via the static fallback.
3. **Backfill:** one off script that reads existing `/uploads/<name>` references,
   uploads each disk file to R2 under the same key, and verifies. After that the
   disk is only a cache.
4. **Video at scale:** add client side compression (ffmpeg.wasm / WebCodecs), or
   a transcode worker, instead of `MEDIA_TRANSCODE=1`.
5. **P2P (optional):** add `magnet` + `is_public` to reels, load `p2p.js`, attach
   on public reels only. Measure CDN read reduction before widening.

## What is NOT done yet (so the doc does not overstate)

- `upload.js` and `server.js` are wired and gated, but R2 itself is not
  provisioned and `MEDIA_BACKEND` is still `local` in production.
- No backfill script yet (step 3).
- Reels schema has no `magnet` / `is_public` column yet, so P2P is not attached in
  the UI; `p2p.js` is ready and tested in isolation.
- Video transcoding defaults off; the at scale path (client side or worker) is
  designed but not built.
