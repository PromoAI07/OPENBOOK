# OpenBook

**An open-source social network where your data is yours.** OpenBook fuses the
**Facebook** side (profiles, a personal feed, photos, reactions, real-time chat,
stories, Reels) with the **Reddit** side (communities, threaded comments, up and
down voting, karma), and it is built on one idea most platforms get wrong:
**credible neutrality.**

[![License: AGPL v3](https://img.shields.io/badge/License-AGPLv3-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/Node-24%2B-339933?logo=node.js&logoColor=white)
[![Live demo](https://img.shields.io/badge/demo-openbook--w8gi.onrender.com-4f46e5)](https://openbook-w8gi.onrender.com)

> **Live demo:** https://openbook.space

> OpenBook is an independent open-source project. It is not affiliated with,
> endorsed by, or connected to Meta, Facebook, or Reddit.

---

## Why OpenBook is different

Most social platforms tie one number to everything: it decides both how popular
you are and whether you get silenced. That is why unpopular opinions get buried
and spammers slip through. OpenBook splits those signals apart:

- **Karma** is your social score. Up and down votes move it. It only affects
  where your content ranks. It can go negative and it **never** hides you.
- **Standing** is your safety score. It rises with account age and clean
  activity, and only **confirmed rule violations** bring it down. Standing, not
  votes, drives reach and the graduated shadowban.

So you can hold an unpopular view, collect a pile of downvotes, and still be
seen, as long as your standing is healthy. A spammer with positive karma still
gets caught, because standing is what falls. The full rulebook (ranking,
reputation, moderation, the illegal-content track, anti-sybil, and exactly what
money does and does not do) is published in plain language in [`RULES.md`](RULES.md),
and the code that runs it lives in the open in this repo (see [`ranking.js`](ranking.js)
and [`trust.js`](trust.js)), because a neutrality claim has to be auditable, not a
black box.

## Features

**Facebook side**
- Profiles with avatar, cover, and bio (plus a public history of past display names)
- A news feed and a combined home feed (friends plus your communities, ranked)
- Posts with photos, and seven reactions (like, love, care, haha, wow, sad, angry) on posts and comments
- Threaded comments with replies
- Friends (requests, accept, decline, unfriend) and notifications
- Real-time direct messaging and chat (WebSockets)
- 24 hour Stories
- **Reels:** a vertical short-video feed with autoplay, likes, comments, and views
- Marketplace, Groups (public and private), and photo Albums
- Post editing with history (the first edit is free and silent)

**Reddit side**
- Communities (public and private), subscribe to follow
- Up and down voting on posts and comments, stored as auditable rows
- Sorts: **Hot, New, Top (day / week / all), Controversial**, plus a **Best**
  (Wilson lower bound) default for comments
- Karma that flows to authors from votes (self-votes excluded)

**Trust and safety (credible neutrality)**
- Two separate scores per user: **karma** and **standing**
- Trust levels TL0 to TL4 that unlock with age and clean activity, never money
- **Trust-weighted votes:** a brand-new account moves ranking far less than an
  established one, which neutralizes brigades without banning anyone
- A graduated, logged shadowban driven by standing (never by raw votes)
- A **transparency dashboard** that shows each user their own karma, standing,
  trust level, and content analytics (views, likes, comments)

**Accounts**
- Email and password auth with secure, server-side sessions
- Optional email verification with a soft gate (browse freely, verify to post),
  off by default until an email provider is configured
- Show and hide password toggle, rate-limited display-name changes

## Tech stack

- **Backend:** Node.js + Express
- **Database:** [libSQL / Turso](https://turso.tech) over `@libsql/client` (a networked SQLite). With `LIBSQL_URL` unset it falls back to a local SQLite file, so local development needs zero setup
- **Real-time:** Socket.IO
- **Auth:** bcryptjs hashing, httpOnly session cookies
- **Media:** multer + sharp, stored either on disk (`local`) or in an S3-compatible, egress-free bucket like Cloudflare R2 / Backblaze B2 (`s3`)
- **Other:** helmet, express-rate-limit, express-async-errors
- **Frontend:** plain HTML, CSS, and JavaScript with anime.js (no build step)

No build tooling and no framework lock-in. The database speaks plain SQLite
(libSQL): locally it is still a single file you can copy or delete, and in
production it is a managed Turso database, so the web service stays stateless
and deploys with zero downtime.

## Getting started

Requires **Node.js 24 or newer** (pinned in `package.json`).

```bash
git clone https://github.com/PromoAI07/OPENBOOK.git
cd OPENBOOK
npm install
npm start
```

Open http://localhost:3000. The database is created automatically as
`openbook.db` (delete it to reset). Uploaded images and videos go to `uploads/`.
Tip: create two accounts in two browser windows to try friends, chat, and voting.

## Configuration

Everything is optional for local development. Set these as environment variables
in production:

| Variable | Purpose |
|---|---|
| `NODE_ENV` | Set to `production` to enable secure cookies and HTTPS behavior |
| `LIBSQL_URL` | Turso/libSQL database URL (`libsql://<db>-<org>.turso.io`). **Unset = a local SQLite file** (perfect for dev) |
| `LIBSQL_AUTH_TOKEN` | Auth token for the Turso database |
| `MEDIA_BACKEND` | `local` (default, files on disk) or `s3` (S3-compatible object storage: Cloudflare R2 / Backblaze B2) |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | Object-storage credentials (required when `MEDIA_BACKEND=s3`) |
| `MEDIA_CDN_BASE` | Public base URL that serves the bucket (e.g. an R2 public URL), no trailing slash |
| `ADMIN_EMAILS` | Comma-separated emails granted the owner analytics panel at `/admin` |
| `FOUNDER_EMAILS` | Comma-separated emails that get the cosmetic Founder badge |
| `DATA_DIR` | Folder for the local-file database + upload staging (only needed in `local` mode; defaults to the app folder) |
| `RESEND_API_KEY` | Enables email verification via [Resend](https://resend.com). When unset, signups are auto-verified so the app is never locked out |
| `EMAIL_FROM` | Sender for verification emails, for example `OpenBook <noreply@yourdomain>` |
| `PORT` | Port to listen on (default 3000) |
| `SUPPORT_GITHUB`, `SUPPORT_OPENCOLLECTIVE`, `SUPPORT_CRYPTO` | Links shown on the in-app Support page |

## Deployment

OpenBook runs as an always-on Node process (it uses WebSockets), so it does not
run on static or serverless hosts. It does **not** need a local disk: point it
at a networked database and object storage and the web service is stateless, so
it deploys with **zero downtime**.

- **Database:** create a free [Turso](https://turso.tech) database and set
  `LIBSQL_URL` + `LIBSQL_AUTH_TOKEN`. With those unset it uses a local SQLite
  file instead, which is ideal for development.
- **Uploads:** set `MEDIA_BACKEND=s3` plus the `S3_*` and `MEDIA_CDN_BASE`
  variables to push media to an egress-free bucket (Cloudflare R2 or Backblaze
  B2). With the default `MEDIA_BACKEND=local`, files stay on disk.
- **Host:** a Render blueprint is included ([`render.yaml`](render.yaml)); see
  [`DEPLOY.md`](DEPLOY.md). With no attached disk, Render does zero-downtime
  rolling deploys. Any always-on Node host (e.g. Railway) works too.

The production demo runs on **Render** (app) + **Turso** (database) +
**Cloudflare R2** (media). Because the database and files live off-box, the
service can be redeployed or scaled freely without downtime or data loss.

## Project structure

```
server.js        Express app, security middleware, Socket.IO, route mounting
db.js            libSQL/Turso adapter, schema, and async startup migrations
auth.js          Session cookies, login state, helpers
trust.js         Reputation engine: karma vs standing, trust levels, reach
ranking.js       Published ranking math: hot, Wilson, controversy, vote weight
entitlements.js  Supporter tiers and perks (cosmetic / capacity / convenience only)
referrals.js     Invite rewards (free Premium months) with anti-farming checks
antisybil.js     Disposable-email + proof-of-work + vote-ring detection
illegal.js       Illegal-content blocklist + upload hash-matching (SPEC 12)
moderation.js    Distributed moderation permission helpers
visibility.js    Shared who-can-see and who-can-interact rules
postview.js      Shared post shaping for every surface
presence.js      In-memory online presence (green / grey dots)
notify.js        Notification creation + live Socket.IO push
mailer.js        Email verification sending (Resend)
sockets.js       Real-time chat handlers
upload.js        Per-tier upload limits, image compression, storage pipeline
media/           storage.js (local|s3 backends), processor.js (sharp/ffmpeg), cleanup.js (real deletion + quota)
routes/          One file per area: auth, users, posts, comments, friends,
                 notifications, stories, messages, marketplace, groups, albums,
                 communities, votes, reactions, reels, moderation, admin,
                 analytics, referrals, suggestions
public/          The frontend (index.html, app.html, css/, js/)
admin.html       Owner-only analytics page (served at /admin, gated by ADMIN_EMAILS)
```

## Your data stays yours

Only the **code** is public. The repository never contains the database, uploaded
files, environment secrets, or any user data (they are all gitignored). When you
self-host, password hashes and personal data live only on your own server.
Passwords are stored only as bcrypt hashes, and sessions expire after 30 days.

## License

[AGPL-3.0-or-later](LICENSE). If you run a modified version of OpenBook as a
network service, you must make your source available to its users. This is the
same license that protects Mastodon and Lemmy, and it keeps OpenBook and its
forks open.

## Contributing

Issues and pull requests are welcome. The ranking and reputation rules are meant
to be debated in the open, so if you think a formula is wrong, open an issue.
