# OpenBook

An open-source social network with the core Facebook feel, kept simple.
Sign up, build a profile, post with photos, add friends, chat in real time,
share stories, browse a marketplace, join groups, and keep photo albums.

> OpenBook is an independent open-source project. It is not affiliated with,
> endorsed by, or connected to Meta or Facebook.

## Features

- Accounts: sign up, log in, log out, secure sessions
- Profiles: avatar, cover photo, bio, your wall
- News feed from you and your accepted friends
- Posts with text and photos, likes, comments
- Friend requests: send, accept, decline, unfriend
- Notifications (likes, comments, friend requests) with a live badge
- Real-time direct messaging (Socket.IO)
- Stories that disappear after 24 hours
- Marketplace: list items with photos, browse by category, message the seller
- Groups: public and private, with their own posts (members only for private)
- Photo albums (shared with friends)

## Tech

- Node.js + Express (web server and JSON API)
- SQLite via Node's built-in `node:sqlite` (a real database in one file, no native build step)
- Socket.IO (real-time chat and live notification badges)
- bcryptjs (password hashing), helmet (security headers), express-rate-limit
- multer (image uploads)
- Plain HTML, CSS, and JavaScript frontend with anime.js

## Run it locally

You need Node.js 20 or newer (https://nodejs.org).

```
npm install
npm start
```

Then open http://localhost:3000. Create two accounts with different emails,
send a friend request from one to the other, accept it, then post, like,
comment, and open Messages to chat live between two browser windows.

## Configuration

All optional, set as environment variables:

| Variable    | Default            | Purpose |
|-------------|--------------------|---------|
| `PORT`      | `3000`             | Port to listen on |
| `NODE_ENV`  | (unset)            | Set to `production` to enable the `Secure` cookie flag (serve over HTTPS) |
| `DATA_DIR`  | the project folder | Where `openbook.db` and the `uploads/` folder live. Point this at a persistent disk in production |

## Project structure

```
server.js        Express app, security middleware, socket.io, route mounting
db.js            Database connection, schema, and migrations
auth.js          Session cookies, login state, helpers
upload.js        Image upload handling (multer)
notify.js        Creates notifications and pushes live updates
sockets.js       Real-time chat handlers
routes/          One file per area: auth, users, posts, comments, friends,
                 notifications, stories, messages, marketplace, groups, albums
public/          The frontend (index.html, app.html, css/, js/)
uploads/         Uploaded images (kept out of git)
```

## Data and privacy

- This repository contains the application **code only**. No user data is in it.
- The database (`openbook.db`), uploaded images (`uploads/`), and any secrets
  (`.env`) are listed in `.gitignore` and are never committed.
- Passwords are stored only as bcrypt hashes, never in plain text.
- In production, run behind HTTPS with `NODE_ENV=production` so the session
  cookie is sent only over encrypted connections. Sessions expire after 30 days.
- Posts and albums are visible to the author and accepted friends. Private group
  posts are visible to members only. To make posts public instead, relax
  `canSeePosts` in `routes/posts.js`.

## Deploying

OpenBook needs an always-on Node server with a persistent disk (for the database
and uploaded photos) and HTTPS. Any host that runs Node and gives you a volume
works (Railway, Render, Fly.io, or a small VPS). The steps:

1. Push this repo to your host (or connect the GitHub repo).
2. Set `NODE_ENV=production` and point `DATA_DIR` at the mounted volume.
3. Start command: `npm start`.

For larger scale later, swap SQLite for Postgres (the schema in `db.js` maps over
almost directly) and move uploads to object storage (S3 / Cloudflare R2).

## License

MIT. See [LICENSE](LICENSE).
