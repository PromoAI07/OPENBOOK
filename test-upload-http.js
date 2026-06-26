// Upload HTTP test: an uploaded image is stored compressed as .webp, and the
// file on disk is much smaller than the original.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { DatabaseSync } = require('node:sqlite');
const BASE = 'http://localhost:3000';
const STAMP = Date.now();
const EMAILS = [];
let pass = 0, fail = 0;
function check(n, c, x) { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n + (x ? ' :: ' + x : '')); } }
function solve(s, d) { let n = 0; const p = '0'.repeat(d); for (;;) { if (crypto.createHash('sha256').update(s + ':' + n).digest('hex').startsWith(p)) return String(n); n++; } }
function cookieFrom(res) { const a = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean); for (const c of a) { const m = /(^|\s)tb_session=([^;]+)/.exec(c); if (m) return 'tb_session=' + m[2]; } return null; }

(async () => {
  // signup A with PoW
  const email = 'p5up+a' + STAMP + '@real-example.com'; EMAILS.push(email);
  const ch = await (await fetch(BASE + '/api/auth/challenge')).json();
  const su = await fetch(BASE + '/api/auth/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'UpA', email, password: 'secret123', fp: 'upfp', powSalt: ch.salt, powNonce: solve(ch.salt, ch.difficulty) }) });
  const cookie = cookieFrom(su);
  check('signup ok', su.status === 200 && !!cookie);

  // make a big-ish PNG and upload as avatar
  const png = await sharp({ create: { width: 2000, height: 2000, channels: 3, background: { r: 30, g: 144, b: 255 } } }).png().toBuffer();
  const fd = new FormData();
  fd.append('image', new Blob([png], { type: 'image/png' }), 'avatar.png');
  const up = await fetch(BASE + '/api/users/me/avatar', { method: 'POST', headers: { Cookie: cookie }, body: fd });
  const upData = await up.json().catch(() => ({}));
  check('avatar upload ok (200)', up.status === 200, up.status + ' ' + JSON.stringify(upData));
  const avatarUrl = upData.user && upData.user.avatar;
  check('stored as compressed .webp', !!avatarUrl && /\.webp$/.test(avatarUrl), 'avatar=' + avatarUrl);

  // confirm the file exists on disk and is smaller than the original PNG
  if (avatarUrl) {
    const diskPath = path.join(__dirname, 'uploads', path.basename(avatarUrl));
    let size = -1; try { size = fs.statSync(diskPath).size; } catch (e) {}
    check('compressed file on disk is smaller than source', size > 0 && size < png.length, 'webp=' + size + ' png=' + png.length);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  const dbx = new DatabaseSync(path.join(__dirname, 'openbook.db'));
  dbx.exec('PRAGMA busy_timeout=5000;');
  dbx.prepare('DELETE FROM users WHERE email = ?').run(email);
  console.log('cleanup: removed test user');
  dbx.close();
  process.exit(fail ? 1 : 0);
})();
