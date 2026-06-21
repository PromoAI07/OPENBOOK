# Deploying OpenBook to Fly.io (persistent, cheap)

Fly keeps OpenBook's SQLite database and uploaded files on a **persistent volume**,
so accounts and posts no longer reset (the problem with Render's free ephemeral
disk). Machines scale to zero when idle, so a low-traffic demo costs roughly
**$1 to $3 a month** (mostly the ~$0.15/GB volume). A payment card is required on
the Fly account even though usage is tiny.

The repo already contains everything Fly needs: `Dockerfile`, `fly.toml`,
`.dockerignore`. The app reads `DATA_DIR=/data` (set in `fly.toml`) and stores the
database + uploads there.

> You do **not** need Docker installed locally. `fly deploy` builds the image on
> Fly's remote builder.

## One-time setup

1. **Install the Fly CLI** (Windows PowerShell):
   ```powershell
   iwr https://fly.io/install.ps1 -useb | iex
   ```
   Then restart the terminal so `fly` is on PATH.

2. **Sign in / sign up** (this adds your card on the Fly side, which I cannot do):
   ```powershell
   fly auth signup   # or: fly auth login
   ```

## Deploy (run from C:\Git\OpenBook)

3. **Create the app** without deploying yet (reads the existing fly.toml; pick a
   unique name if `openbook-social` is taken):
   ```powershell
   fly launch --no-deploy --copy-config --name openbook-social --region iad
   ```

4. **Create the persistent volume** (same region as the app):
   ```powershell
   fly volumes create openbook_data --region iad --size 1
   ```

5. **Deploy:**
   ```powershell
   fly deploy
   ```

Fly prints a URL like `https://openbook-social.fly.dev`. That is your new live,
persistent OpenBook. Email verification links and everything else use that host
automatically (the app trusts Fly's proxy for HTTPS).

## After it is up
- Future updates: just `fly deploy` again. The volume (your data) is untouched.
- Turn on email verification later: `fly secrets set RESEND_API_KEY=... EMAIL_FROM="OpenBook <noreply@yourdomain>"` (this is the Fly equivalent of Render env vars; secrets trigger a redeploy but the volume persists).
- Logs: `fly logs`. Status: `fly status`. Scale memory down to 256mb to save more: edit `fly.toml` `[[vm]] memory` and `fly deploy`.

## Notes
- Keep it to a **single machine** (do not scale to 2+) because one SQLite file
  lives on one volume. For multi-instance scale later, move to Postgres.
- The Render config (`render.yaml`) is left in place; you can run either host.
