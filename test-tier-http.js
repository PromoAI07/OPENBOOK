// Tier core end-to-end HTTP test against localhost:3000.
// Verifies GET /api/tiers (public), that a non-admin cannot grant, that an admin
// grant gives the target the verified tick + badge (visible via their profile),
// and that revoke clears it. Uses throwaway users (deleted at the end).

const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const BASE = 'http://localhost:3000';
const STAMP = Date.now();
const EMAILS = [];
let pass = 0, fail = 0;
function check(n, c, extra) { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n + (extra ? ' :: ' + extra : '')); } }
function solve(salt, diff) { let n = 0; const p = '0'.repeat(diff); for (;;) { if (crypto.createHash('sha256').update(salt + ':' + n).digest('hex').startsWith(p)) return String(n); n++; } }
function cookieFrom(res) { const all = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean); for (const c of all) { const m = /(^|\s)tb_session=([^;]+)/.exec(c); if (m) return 'tb_session=' + m[2]; } return null; }
async function req(method, p, body, cookie) {
  const opts = { method, headers: {} };
  if (cookie) opts.headers['Cookie'] = cookie;
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(BASE + p, opts);
  let data = null; try { data = await res.json(); } catch (e) {}
  return { status: res.status, data, cookie: cookieFrom(res) };
}
async function signup(name, email) {
  EMAILS.push(email);
  const c = (await req('GET', '/api/auth/challenge')).data;
  return req('POST', '/api/auth/signup', { name, email, password: 'secret123', fp: 'tierfp_' + name, powSalt: c.salt, powNonce: solve(c.salt, c.difficulty) });
}

(async () => {
  // 1. Public tiers endpoint
  const tiers = await req('GET', '/api/tiers');
  check('GET /api/tiers returns 3 tiers', tiers.status === 200 && tiers.data && tiers.data.tiers && tiers.data.tiers.length === 3, JSON.stringify(tiers.data));

  // 2. Create two users
  const a = await signup('TierA', 'p5tier+a' + STAMP + '@real-example.com');
  const b = await signup('TierB', 'p5tier+b' + STAMP + '@real-example.com');
  const cookieA = a.cookie, cookieB = b.cookie;
  const idA = a.data.user.id, idB = b.data.user.id;
  check('both users created', !!idA && !!idB);
  check('new users are not verified by default', a.data.user.verified === false && a.data.user.tier === 0);

  // 3. Non-admin cannot grant
  const denied = await req('POST', '/api/admin/grant', { userId: idB, tier: 1, days: 30 }, cookieA);
  check('non-admin grant rejected (403)', denied.status === 403, denied.status + ' ' + JSON.stringify(denied.data));

  // 4. Make A an admin directly in the DB, then A grants B a tier
  const dbx = new DatabaseSync(path.join(__dirname, 'openbook.db'));
  dbx.exec('PRAGMA busy_timeout=5000;');
  dbx.prepare('UPDATE users SET is_admin=1 WHERE id=?').run(idA);
  const grant = await req('POST', '/api/admin/grant', { userId: idB, tier: 2, days: 30 }, cookieA);
  check('admin grant succeeds (200)', grant.status === 200 && grant.data && grant.data.entitlements && grant.data.entitlements.tier === 2, grant.status + ' ' + JSON.stringify(grant.data));

  // 5. B now shows the verified tick + silver badge on their public profile
  const prof = await req('GET', '/api/users/' + idB, undefined, cookieA);
  const pu = prof.data && prof.data.user;
  check('granted user shows verified tick via publicUser', !!pu && pu.verified === true && pu.tier === 2 && pu.badge === 'silver', JSON.stringify(pu));

  // 6. Guardrail: the grant did not move B's standing/karma
  const brow = dbx.prepare('SELECT karma, standing FROM users WHERE id=?').get(idB);
  check('GUARDRAIL: granted user standing still baseline 100', brow.standing === 100 && brow.karma === 0, JSON.stringify(brow));

  // 7. Revoke clears it
  const rev = await req('POST', '/api/admin/revoke', { userId: idB }, cookieA);
  check('admin revoke succeeds', rev.status === 200 && rev.data.entitlements.tier === 0);
  const prof2 = await req('GET', '/api/users/' + idB, undefined, cookieA);
  check('revoked user no longer verified', prof2.data.user.verified === false && prof2.data.user.tier === 0);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');

  // cleanup
  const ph = EMAILS.map(() => '?').join(',');
  const before = dbx.prepare('SELECT COUNT(*) n FROM users WHERE email IN (' + ph + ')').get(...EMAILS).n;
  dbx.prepare('DELETE FROM users WHERE email IN (' + ph + ')').run(...EMAILS);
  console.log('cleanup: removed ' + before + ' test users');
  dbx.close();
  process.exit(fail ? 1 : 0);
})();
