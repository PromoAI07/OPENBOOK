// Password-reset HTTP test: forgot -> emailed token -> reset -> new password works,
// old password rejected, bad token rejected, unknown email leaks nothing.
const crypto = require('crypto');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const BASE = 'http://localhost:3000';
const STAMP = Date.now();
const EMAILS = [];
let pass = 0, fail = 0;
function check(n, c, x) { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n + (x ? ' :: ' + x : '')); } }
function solve(s, d) { let n = 0; const p = '0'.repeat(d); for (;;) { if (crypto.createHash('sha256').update(s + ':' + n).digest('hex').startsWith(p)) return String(n); n++; } }
async function req(method, p, body) {
  const o = { method, headers: {} };
  if (body !== undefined) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(body); }
  const res = await fetch(BASE + p, o); let data = null; try { data = await res.json(); } catch (e) {}
  return { status: res.status, data };
}

(async () => {
  const email = 'p5rst+a' + STAMP + '@real-example.com'; EMAILS.push(email);
  const ch = (await req('GET', '/api/auth/challenge')).data;
  const su = await req('POST', '/api/auth/signup', { name: 'RstA', email, password: 'oldpass123', fp: 'rstfp', powSalt: ch.salt, powNonce: solve(ch.salt, ch.difficulty) });
  check('signup ok', su.status === 200);

  // Forgot for a REAL email -> returns a dev reset link (non-prod)
  const f = await req('POST', '/api/auth/forgot-password', { email });
  check('forgot returns generic ok', f.status === 200 && f.data.ok === true);
  const link = f.data.devResetLink;
  check('dev reset link issued for real account', !!link && /token=/.test(link || ''), 'link=' + link);
  const token = link ? new URL(link).searchParams.get('token') : '';

  // Forgot for an UNKNOWN email -> generic ok, NO link (no enumeration)
  const fU = await req('POST', '/api/auth/forgot-password', { email: 'nobody' + STAMP + '@real-example.com' });
  check('unknown email: generic ok, no link leaked', fU.status === 200 && fU.data.ok === true && !fU.data.devResetLink);

  // Bad token rejected
  const bad = await req('POST', '/api/auth/reset-password', { token: 'deadbeef', password: 'whatever123' });
  check('bad reset token rejected (400)', bad.status === 400);

  // Reset with the real token
  const r = await req('POST', '/api/auth/reset-password', { token, password: 'newpass456' });
  check('reset succeeds with valid token (200)', r.status === 200 && r.data.ok === true, r.status + ' ' + JSON.stringify(r.data));

  // Old password no longer works; new password does
  const oldLogin = await req('POST', '/api/auth/login', { email, password: 'oldpass123' });
  check('old password rejected after reset (401)', oldLogin.status === 401, oldLogin.status);
  const newLogin = await req('POST', '/api/auth/login', { email, password: 'newpass456' });
  check('new password works (200)', newLogin.status === 200, newLogin.status);

  // Token is single-use: reusing it fails
  const reuse = await req('POST', '/api/auth/reset-password', { token, password: 'another789' });
  check('used token cannot be reused (400)', reuse.status === 400);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  const dbx = new DatabaseSync(path.join(__dirname, 'openbook.db'));
  dbx.exec('PRAGMA busy_timeout=5000;');
  const ph = EMAILS.map(() => '?').join(',');
  dbx.prepare('DELETE FROM users WHERE email IN (' + ph + ')').run(...EMAILS);
  console.log('cleanup done');
  dbx.close();
  process.exit(fail ? 1 : 0);
})();
