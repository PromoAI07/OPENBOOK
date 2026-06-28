# Deploying OpenBook

OpenBook is an always-on Node server with live chat (WebSockets) and file
uploads, so it does **not** run on static or serverless hosts (Netlify, Vercel,
GitHub Pages). It does **not** need a local disk: with a networked database and
object storage, the web service is stateless and redeploys with zero downtime
and no data loss.

## Production stack: Render + Turso + Cloudflare R2

This is how the live site runs.

- **App:** [Render](https://render.com) web service on the **Starter** plan
  (always-on; the Free plan sleeps after ~15 min idle, which is wrong for a live
  site that takes payments). A blueprint is included: [`render.yaml`](render.yaml).
- **Database:** a [Turso](https://turso.tech) (libSQL) database. Networked, so it
  survives every redeploy.
- **Media:** a [Cloudflare R2](https://developers.cloudflare.com/r2/) bucket
  (S3-compatible, egress-free). Uploads live here instead of on a server disk.

### One-time setup

1. **Database:** create a Turso database, copy its URL and an auth token.
2. **Media:** create an R2 bucket, an access key/secret, and a public URL for it.
3. **Render:** New + → **Blueprint**, connect the **OPENBOOK** repo (Render reads
   `render.yaml`), then **Apply**.
4. In the Render service's **Environment** tab, set the values for the keys the
   blueprint declares (they are committed as `sync: false`, i.e. names only):
   - `LIBSQL_URL`, `LIBSQL_AUTH_TOKEN` (Turso)
   - `MEDIA_BACKEND=s3`, `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`,
     `S3_SECRET_ACCESS_KEY`, `MEDIA_CDN_BASE`, `S3_REGION=auto` (Cloudflare R2)
   - Optional: `RESEND_API_KEY` + `EMAIL_FROM` (email), `ADMIN_EMAILS`,
     `PAYPAL_RECEIVER_EMAIL` (payments). See [`README.md`](README.md) for the full
     list and [`PAYMENTS.md`](PAYMENTS.md) for the supporter rails.

Because the database and files live off-box, you can redeploy or scale the
service freely without downtime or data loss. **The code stays public on GitHub;
user data and password hashes live in your Turso database and your R2 bucket,
never in the repo.**

## Quick local demo (no accounts to set up)

With none of the `LIBSQL_*` or `S3_*` variables set, the app falls back to a
local SQLite file and a local `uploads/` folder. That is meant for development
(`npm install` then `npm start`, open http://localhost:3000), not production: on
a host with no disk it is wiped on every redeploy.

## Other hosts

Any host that runs an always-on Node process works (Railway and similar
container hosts, for example). Point it at the same Turso + R2 env vars and the
service stays stateless; no disk required.
