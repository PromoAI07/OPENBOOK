// Verifies the email-verification gate when REQUIRE_EMAIL_VERIFICATION=1:
// a new signup is unverified, is blocked from posting (403 UNVERIFIED), and once
// it verifies via the emailed link it can post. Run against a local server
// started with REQUIRE_EMAIL_VERIFICATION=1 and a (fake) RESEND key.
const crypto = require('crypto');
const BASE = 'http://localhost:3007';
let pass = 0, fail = 0;
function check(n, c, x) { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n + (x ? ' :: ' + x : '')); } }
function solve(s, d) { let n = 0; const p = '0'.repeat(d); for (;;) { if (crypto.createHash('sha256').update(s + ':' + n).digest('hex').startsWith(p)) return String(n); n++; } }
function cookieFrom(res) { const a = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean); for (const c of a) { const m = /(^|\s)tb_session=([^;]+)/.exec(c); if (m) return 'tb_session=' + m[2]; } return null; }
async function req(method, p, body, cookie, redirect) {
  const o = { method, headers: {}, redirect: redirect || 'follow' }; if (cookie) o.headers.Cookie = cookie;
  if (body !== undefined) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(body); }
  const res = await fetch(BASE + p, o); let data = null; try { data = await res.json(); } catch (e) {}
  return { status: res.status, data, cookie: cookieFrom(res), url: res.url };
}

(async () => {
  const ch = (await req('GET', '/api/auth/challenge')).data;
  const email = 'vg' + Date.now() + '@real-example.com';
  const su = await req('POST', '/api/auth/signup', { name: 'VG', email, password: 'secret123', fp: 'vgfp', powSalt: ch.salt, powNonce: solve(ch.salt, ch.difficulty) });
  check('signup ok', su.status === 200, su.status + ' ' + JSON.stringify(su.data));
  check('new signup is UNVERIFIED', su.data.user && su.data.user.emailVerified === false, JSON.stringify(su.data.user));
  const verifyLink = su.data.devVerifyLink;
  check('a verification link was generated', !!verifyLink, 'link=' + verifyLink);
  const cookie = su.cookie;

  // Unverified user cannot post
  const blocked = await req('POST', '/api/posts', { content: 'hello while unverified' }, cookie);
  check('unverified user blocked from posting (403 UNVERIFIED)', blocked.status === 403 && blocked.data && blocked.data.code === 'UNVERIFIED', blocked.status + ' ' + JSON.stringify(blocked.data));

  // Visit the verification link
  const token = verifyLink ? new URL(verifyLink).searchParams.get('token') : '';
  const v = await req('GET', '/api/auth/verify?token=' + encodeURIComponent(token), undefined, cookie);
  check('verify link marks the account verified', /verified=1/.test(v.url) || v.status === 200, v.status + ' ' + v.url);

  // Now the same user CAN post
  const okPost = await req('POST', '/api/posts', { content: 'hello now verified' }, cookie);
  check('verified user can post (200)', okPost.status === 200 || okPost.status === 201, okPost.status + ' ' + JSON.stringify(okPost.data));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
