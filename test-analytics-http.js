// Owner analytics HTTP test: ingest events, then verify the admin aggregation
// reflects them, and that non-admins are blocked.
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
async function req(method, p, body, cookie) {
  const o = { method, headers: {} }; if (cookie) o.headers.Cookie = cookie;
  if (body !== undefined) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(body); }
  const res = await fetch(BASE + p, o); let data = null; try { data = await res.json(); } catch (e) {}
  return { status: res.status, data, cookie: cookieFrom(res) };
}
async function signup(name, email) {
  EMAILS.push(email);
  const c = (await req('GET', '/api/auth/challenge')).data;
  return req('POST', '/api/auth/signup', { name, email, password: 'secret123', fp: 'anfp_' + name, powSalt: c.salt, powNonce: solve(c.salt, c.difficulty) });
}

(async () => {
  const a = await signup('AnA', 'p5an+a' + STAMP + '@real-example.com');
  const cookieA = a.cookie; const idA = a.data.user.id;

  // Non-admin cannot read analytics
  const denied = await req('GET', '/api/admin/analytics', undefined, cookieA);
  check('non-admin analytics blocked (403)', denied.status === 403, denied.status);

  // Ingest a batch of events (as the logged-in user)
  const sess = 'sess' + STAMP;
  const ev = await req('POST', '/api/analytics', { session: sess, events: [
    { type: 'pageview', label: 'feed' }, { type: 'pageview', label: 'profile' }, { type: 'pageview', label: 'feed' },
    { type: 'click', label: 'tab:Home' }, { type: 'click', label: 'invite' },
    { type: 'heartbeat', label: '' }, { type: 'heartbeat', label: '' }, { type: 'heartbeat', label: '' },
    { type: 'evil', label: 'should be dropped' },
  ] }, cookieA);
  check('ingest accepted, evil type dropped', ev.status === 200 && ev.data.stored === 8, JSON.stringify(ev.data));

  // Make A an admin, then read analytics
  const dbx = new DatabaseSync(path.join(__dirname, 'openbook.db'));
  dbx.exec('PRAGMA busy_timeout=5000;');
  dbx.prepare('UPDATE users SET is_admin=1 WHERE id=?').run(idA);

  const an = await req('GET', '/api/admin/analytics', undefined, cookieA);
  check('admin analytics ok (200)', an.status === 200, an.status + ' ' + JSON.stringify(an.data));
  const d = an.data || {};
  check('totals present', !!d.totals && d.totals.totalUsers >= 1, JSON.stringify(d.totals));
  check('pageviews counted (>=3)', d.totals.totalPageviews >= 3, 'pv=' + d.totals.totalPageviews);
  check('clicks counted (>=2)', d.totals.totalClicks >= 2, 'clk=' + d.totals.totalClicks);
  check('avg session time > 0 (from heartbeats)', d.totals.avgSessionSec > 0, 'avg=' + d.totals.avgSessionSec);
  check('top page includes feed', (d.topPages || []).some((p) => p.label === 'feed' && p.c >= 2));
  check('entry page is feed (first view of session)', (d.entryPages || []).some((p) => p.label === 'feed'));
  check('top button includes a click label', (d.topButtons || []).some((b) => b.label === 'tab:Home' || b.label === 'invite'));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  // cleanup: delete test user + its analytics rows (user_id SET NULL on delete, so clear by session too)
  const ph = EMAILS.map(() => '?').join(',');
  dbx.prepare('DELETE FROM users WHERE email IN (' + ph + ')').run(...EMAILS);
  dbx.prepare('DELETE FROM analytics_events WHERE session_id = ?').run(sess);
  console.log('cleanup done');
  dbx.close();
  process.exit(fail ? 1 : 0);
})();
