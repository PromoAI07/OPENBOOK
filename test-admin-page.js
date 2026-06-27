// Verifies the /admin page is a separate, server-gated, admin-only entrance.
const crypto = require('crypto');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const BASE = 'http://localhost:3000';
const STAMP = Date.now();
const EMAILS = [];
let pass = 0, fail = 0;
function check(n, c, x) { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n + (x ? ' :: ' + x : '')); } }
function solve(s, d) { let n = 0; const p = '0'.repeat(d); for (;;) { if (crypto.createHash('sha256').update(s + ':' + n).digest('hex').startsWith(p)) return String(n); n++; } }
function cookieFrom(res) { const a = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean); for (const c of a) { const m = /(^|\s)tb_session=([^;]+)/.exec(c); if (m) return 'tb_session=' + m[2]; } return null; }

(async () => {
  const email = 'p5adm+a' + STAMP + '@real-example.com'; EMAILS.push(email);
  const ch = await (await fetch(BASE + '/api/auth/challenge')).json();
  const su = await fetch(BASE + '/api/auth/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'AdmA', email, password: 'secret123', fp: 'admfp', powSalt: ch.salt, powNonce: solve(ch.salt, ch.difficulty) }) });
  const cookie = cookieFrom(su); const idA = (await su.clone().json()).user.id;

  // Logged OUT: /admin redirects to login (/)
  const out = await fetch(BASE + '/admin', { redirect: 'follow' });
  check('logged-out /admin redirected to login', out.url.replace(/\/$/, '') === BASE, 'final=' + out.url);

  // NON-admin: /admin redirects to /app (not served)
  const non = await fetch(BASE + '/admin', { headers: { Cookie: cookie }, redirect: 'follow' });
  const nonBody = await non.text();
  check('non-admin /admin redirected to /app', /\/app$/.test(non.url), 'final=' + non.url);
  check('non-admin did NOT receive the admin page', nonBody.indexOf('Owner analytics') === -1 || /\/app$/.test(non.url));

  // NON-admin: analytics API is 403
  const apiNon = await fetch(BASE + '/api/admin/analytics', { headers: { Cookie: cookie } });
  check('non-admin analytics API blocked (403)', apiNon.status === 403, apiNon.status);

  // Promote to admin, then /admin serves the real page
  const dbx = new DatabaseSync(path.join(__dirname, 'openbook.db'));
  dbx.exec('PRAGMA busy_timeout=5000;');
  dbx.prepare('UPDATE users SET is_admin=1 WHERE id=?').run(idA);
  const adm = await fetch(BASE + '/admin', { headers: { Cookie: cookie }, redirect: 'follow' });
  const admBody = await adm.text();
  check('admin /admin serves the page (200, stays on /admin)', adm.status === 200 && /\/admin$/.test(adm.url), adm.status + ' ' + adm.url);
  check('admin page contains the dashboard', admBody.indexOf('Owner analytics') !== -1 && admBody.indexOf('adminAnalytics') !== -1);

  // The separate page must NOT be reachable via the public static handler
  const direct = await fetch(BASE + '/admin.html', { headers: { Cookie: cookie }, redirect: 'manual' });
  check('admin.html is NOT served by static (no 200)', direct.status !== 200, 'status=' + direct.status);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  const ph = EMAILS.map(() => '?').join(',');
  dbx.prepare('DELETE FROM users WHERE email IN (' + ph + ')').run(...EMAILS);
  console.log('cleanup done');
  dbx.close();
  process.exit(fail ? 1 : 0);
})();
