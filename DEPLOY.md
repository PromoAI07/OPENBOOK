# Deploying OpenBook

OpenBook is a persistent Node server with a database, live chat (WebSockets), and
file uploads. It needs a host that runs an always-on process with a disk. It does
**not** run on static/serverless hosts (Netlify, Vercel, GitHub Pages).

## Quick free demo: Render

Best for putting a clickable demo in front of people at $0.

1. Go to https://render.com and sign up (you can use "Sign in with GitHub").
2. Click **New +** then **Blueprint**.
3. Connect your GitHub and pick the **OPENBOOK** repo. Render reads `render.yaml`
   and sets everything up (Node, build, start, HTTPS, `NODE_ENV=production`).
4. Click **Apply**. First build takes a few minutes.
5. You get a public URL like `https://openbook.onrender.com`. Share that.

Free-tier notes (fine for a demo):
- The service sleeps after ~15 min idle; the first visit then takes ~30-60s to
  wake. After that it is snappy.
- The free disk is ephemeral, so the database and uploaded photos reset on each
  redeploy/restart. Great for "try it", not for keeping real accounts.

## Making it permanent (when demand is proven)

On the same Render service:
1. Change the instance type from **Free** to **Starter** (about $7/mo).
2. Add a **Disk** mounted at `/data` (a few GB is plenty).
3. Add an environment variable **`DATA_DIR=/data`**.

Now the database and uploads live on a private persistent disk. The code stays
public on GitHub; **user data and password hashes never leave your server.**

For very large scale, move the database to Postgres and uploads to object
storage (S3 / Cloudflare R2); the schema in `db.js` maps over directly.

## Alternative hosts

- **Railway** (railway.app): similar, has volumes, ~$5/mo after a trial credit.
- **Fly.io**: free allowance, supports volumes, more command-line oriented.
