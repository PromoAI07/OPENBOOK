# OpenBook

**An open-source social network where your data is yours.** OpenBook fuses the
**Facebook** side (profiles, a personal feed, photos, reactions, real-time chat,
stories, Reels) with the **Reddit** side (communities, threaded comments, up and
down voting, karma), and it is built on one idea most platforms get wrong:
**credible neutrality.**

[![License: AGPL v3](https://img.shields.io/badge/License-AGPLv3-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/Node-24%2B-339933?logo=node.js&logoColor=white)
[![Live demo](https://img.shields.io/badge/demo-openbook--w8gi.onrender.com-4f46e5)](https://openbook-w8gi.onrender.com)

> **Live demo:** https://openbook-w8gi.onrender.com
> (Free hosting, so the first load can take ~30 seconds to wake up.)

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
gets caught, because standing is what falls. The ranking and reputation rules
live in the open in this repo (see [`ranking.js`](ranking.js) and
[`trust.js`](trust.js)), because a neutrality claim has to be auditable, not a
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
- **Database:** Node's built-in `node:sqlite` (a single file, no native build step)
- **Real-time:** Socket.IO
- **Auth:** bcryptjs hashing, httpOnly session cookies
- **Other:** multer (uploads), helmet, express-rate-limit
- **Frontend:** plain HTML, CSS, and JavaScript with anime.js (no build step)

No build tooling, no framework lock-in, and the whole database is one file you
can copy or delete.

## Getting started

Requires **Node.js 24 or newer** (the built-in SQLite module ships with Node 24).

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
| `DATA_DIR` | Folder for the database and uploads (point this at a persistent disk) |
| `PORT` | Port to listen on (default 3000) |
| `RESEND_API_KEY` | Enables email verification via [Resend](https://resend.com). When unset, signups are auto-verified so the app is never locked out |
| `EMAIL_FROM` | Sender for verification emails, for example `OpenBook <noreply@yourdomain>` |
| `SUPPORT_GITHUB`, `SUPPORT_OPENCOLLECTIVE`, `SUPPORT_CRYPTO` | Links shown on the in-app Support page |

## Deployment

OpenBook needs a host that runs an always-on Node process with a disk (it uses
WebSockets and stores files), so it does not run on static or serverless hosts.

- **Render:** a blueprint is included ([`render.yaml`](render.yaml)). See [`DEPLOY.md`](DEPLOY.md).
- **Fly.io:** a `Dockerfile` and `fly.toml` with a persistent volume are included.
  See [`FLY-DEPLOY.md`](FLY-DEPLOY.md).

For data to persist, point `DATA_DIR` at a mounted disk or volume. On a free tier
with an ephemeral disk, accounts and posts reset on each restart, which is fine
for a demo but not for real users. For large scale later, move the database to
Postgres (the schema in `db.js` maps over almost directly) and uploads to object
storage (S3 or Cloudflare R2).

## Project structure

```
server.js        Express app, security middleware, Socket.IO, route mounting
db.js            Database connection, schema, and migrations
auth.js          Session cookies, login state, helpers
trust.js         Reputation engine: karma vs standing, trust levels, reach
ranking.js       Published ranking math: hot, Wilson, controversy, vote weight
visibility.js    Shared who-can-see and who-can-interact rules
postview.js      Shared post shaping for every surface
mailer.js        Email verification sending (Resend)
sockets.js       Real-time chat handlers
routes/          One file per area: auth, users, posts, comments, friends,
                 notifications, stories, messages, marketplace, groups, albums,
                 communities, votes, reactions, reels
public/          The frontend (index.html, app.html, css/, js/)
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
