// Referral HTTP test: an invite link attaches a new signup as a pending referral.
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const BASE = 'http://localhost:3000';
const STAMP = Date.now();
const EMAILS = [];
let pass = 0, fail = 0;
function check(n, c, x) { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n + (x ? ' :: ' + x : '')); } }
function solve(s, d) { let n = 0; const p = '0'.repeat(d); for (;;) { if (crypto.createHash('sha256').update(s + ':' + n).digest('hex').startsWith(p)) return String(n); n++; } }
function cookieFrom(res) { const a = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean); for (const c of a) { const m = /(^|\s)tb_session=([^;]+)/.exec(c); if (m) return 'tb_session=' + m[2]; } return null; }
async function req(method, p, body, cookie) {
  const o = { method, headers: {} }; if (cookie) o.headers.Cookie = cookie;
  if (body !== undefined) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(body); }
  const res = await fetch(BASE + p, o); let data = null; try { data = await res.json(); } catch (e) {}
  return { status: res.status, data, cookie: cookieFrom(res) };
}
async function signup(name, email, extra) {
  EMAILS.push(email);
  const c = (await req('GET', '/api/auth/challenge')).data;
  return req('POST', '/api/auth/signup', Object.assign({ name, email, password: 'secret123', fp: 'reffp_' + name, powSalt: c.salt, powNonce: solve(c.salt, c.difficulty) }, extra || {}));
}

(async () => {
  const a = await signup('RefA', 'p5ref+a' + STAMP + '@real-example.com');
  const cookieA = a.cookie;
  const meA = await req('GET', '/api/referrals/me', undefined, cookieA);
  check('referrer gets code + link', meA.status === 200 && !!meA.data.code && /\/\?ref=/.test(meA.data.link), JSON.stringify(meA.data));
  check('referrer starts with 0 pending/qualified', meA.data.pending === 0 && meA.data.qualified === 0);

  const code = meA.data.code;
  const b = await signup('RefB', 'p5ref+b' + STAMP + '@real-example.com', { ref: code });
  check('invitee signup with ref succeeds', b.status === 200, b.status + ' ' + JSON.stringify(b.data));

  const meA2 = await req('GET', '/api/referrals/me', undefined, cookieA);
  check('referrer now has 1 pending referral', meA2.data.pending === 1, JSON.stringify(meA2.data));
  check('still 0 qualified (B is brand new)', meA2.data.qualified === 0);

  const lb = await req('GET', '/api/referrals/leaderboard', undefined, cookieA);
  check('leaderboard endpoint works', lb.status === 200 && Array.isArray(lb.data.leaderboard));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  const dbx = new DatabaseSync(path.join(__dirname, 'openbook.db'));
  dbx.exec('PRAGMA busy_timeout=5000;');
  const ph = EMAILS.map(() => '?').join(',');
  const n = dbx.prepare('SELECT COUNT(*) n FROM users WHERE email IN (' + ph + ')').get(...EMAILS).n;
  dbx.prepare('DELETE FROM users WHERE email IN (' + ph + ')').run(...EMAILS);
  console.log('cleanup: removed ' + n + ' test users');
  dbx.close();
  process.exit(fail ? 1 : 0);
})();
