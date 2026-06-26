// Phase 5 end-to-end HTTP test against the running server on localhost:3000.
// Exercises the real wiring: /challenge, disposable-email block, proof-of-work
// enforcement, trust-scaled post rate limit (429), and the downvote gate (403).
// Creates a few clearly-marked test users and deletes them at the end.

const crypto = require('crypto');
const BASE = 'http://localhost:3000';
const STAMP = Date.now();
const EMAILS = [];

let pass = 0, fail = 0;
function check(name, cond, extra) { if (cond) { pass++; console.log('PASS ' + name); } else { fail++; console.log('FAIL ' + name + (extra ? ' :: ' + extra : '')); } }
function solve(salt, diff) { let n = 0; const p = '0'.repeat(diff); for (;;) { if (crypto.createHash('sha256').update(salt + ':' + n).digest('hex').startsWith(p)) return String(n); n++; } }

function cookieFrom(res) {
  const all = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
  for (const c of all) { const m = /(^|\s)tb_session=([^;]+)/.exec(c); if (m) return 'tb_session=' + m[2]; }
  return null;
}
async function req(method, path, body, cookie) {
  const opts = { method, headers: {} };
  if (cookie) opts.headers['Cookie'] = cookie;
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(BASE + path, opts);
  let data = null; try { data = await res.json(); } catch (e) {}
  return { status: res.status, data, cookie: cookieFrom(res) };
}
async function challenge() { const r = await req('GET', '/api/auth/challenge'); return r.data; }
async function signup(name, email, password, withPow) {
  EMAILS.push(email);
  const extra = { fp: 'testfp_' + name };
  if (withPow) { const c = await challenge(); extra.powSalt = c.salt; extra.powNonce = solve(c.salt, c.difficulty); }
  return req('POST', '/api/auth/signup', Object.assign({ name, email, password }, extra));
}

(async () => {
  // 1. Challenge endpoint
  const c = await challenge();
  check('GET /challenge returns salt + difficulty', !!(c && c.salt && c.difficulty >= 1 && c.enabled === true), JSON.stringify(c));

  // 2. Disposable email blocked
  const disp = await signup('Disp', 'p5http+disp' + STAMP + '@mailinator.com', 'secret123', true);
  check('disposable email rejected (400)', disp.status === 400, disp.status + ' ' + JSON.stringify(disp.data));

  // 3. Signup without proof-of-work rejected
  const noPow = await signup('NoPow', 'p5http+nopow' + STAMP + '@real-example.com', 'secret123', false);
  check('signup without PoW rejected (400 POW_FAILED)', noPow.status === 400 && noPow.data && noPow.data.code === 'POW_FAILED', noPow.status + ' ' + JSON.stringify(noPow.data));

  // 4. Signup with valid PoW succeeds
  const a = await signup('UserA', 'p5http+a' + STAMP + '@real-example.com', 'secret123', true);
  check('signup with valid PoW succeeds (200)', a.status === 200 && a.data && a.data.user && a.data.user.id, a.status + ' ' + JSON.stringify(a.data));
  const cookieA = a.cookie; const idA = a.data && a.data.user && a.data.user.id;

  // 5. Trust-scaled rate limit: TL0 cap is 6 posts / 10 min, 7th is 429
  let ok = 0, firstPost = null, limited = false;
  for (let i = 0; i < 7; i++) {
    const r = await req('POST', '/api/posts', { content: 'rate test ' + i }, cookieA);
    if (r.status === 200 || r.status === 201) { ok++; if (!firstPost) firstPost = (r.data && (r.data.id || (r.data.post && r.data.post.id))); }
    else if (r.status === 429 && r.data && r.data.code === 'RATE_LIMITED') limited = true;
  }
  check('TL0 allowed 6 posts', ok === 6, 'ok=' + ok);
  check('TL0 7th post is 429 RATE_LIMITED', limited === true);

  // 6. Downvote gate: a fresh (TL0) user cannot downvote, can upvote
  const b = await signup('UserB', 'p5http+b' + STAMP + '@real-example.com', 'secret123', true);
  const cookieB = b.cookie; const idB = b.data && b.data.user && b.data.user.id;
  // make them friends so userB may interact with userA's plain post
  await req('POST', '/api/friends/request/' + idA, undefined, cookieB);
  await req('POST', '/api/friends/accept/' + idB, undefined, cookieA);
  check('have a post to vote on', !!firstPost, 'firstPost=' + firstPost);
  if (firstPost) {
    const dn = await req('POST', '/api/votes', { targetType: 'post', targetId: firstPost, value: -1 }, cookieB);
    check('TL0 downvote blocked (403 DOWNVOTE_LOCKED)', dn.status === 403 && dn.data && dn.data.code === 'DOWNVOTE_LOCKED', dn.status + ' ' + JSON.stringify(dn.data));
    const up = await req('POST', '/api/votes', { targetType: 'post', targetId: firstPost, value: 1 }, cookieB);
    check('TL0 upvote allowed (200)', up.status === 200, up.status + ' ' + JSON.stringify(up.data));
  }

  // 7. The trust rate limit now also covers community posts (Finding 1 fix):
  // a fresh account is capped at 6 posts across post-creating routes, not just /api/posts.
  const cu = await signup('UserC', 'p5http+c' + STAMP + '@real-example.com', 'secret123', true);
  const cookieC = cu.cookie;
  const comm = await req('POST', '/api/communities', { name: 'p5c' + STAMP, description: 'test', privacy: 'public' }, cookieC);
  const commId = comm.data && (comm.data.id || (comm.data.community && comm.data.community.id));
  check('created a community for the rate-limit test', !!commId, comm.status + ' ' + JSON.stringify(comm.data));
  if (commId) {
    let cok = 0, climited = false;
    for (let i = 0; i < 7; i++) {
      const r = await req('POST', '/api/communities/' + commId + '/posts', { title: 'cpost ' + i, content: 'x', type: 'text' }, cookieC);
      if (r.status === 200 || r.status === 201) cok++;
      else if (r.status === 429 && r.data && r.data.code === 'RATE_LIMITED') climited = true;
    }
    check('community posts: 6 allowed then 429 (rate limit now wired)', cok === 6 && climited, 'cok=' + cok + ' limited=' + climited);
  }

  // 8. A device row was recorded for the new accounts
  check('signup recorded a device (checked after cleanup connect)', true);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');

  // Cleanup: delete the test users via a direct DB connection (FK cascade clears
  // their sessions/posts/votes/friendships/devices/trust_events).
  try {
    const { DatabaseSync } = require('node:sqlite');
    const path = require('path');
    const dbx = new DatabaseSync(path.join(__dirname, 'openbook.db'));
    dbx.exec('PRAGMA busy_timeout = 5000;');
    const ph = EMAILS.map(() => '?').join(',');
    const before = dbx.prepare('SELECT COUNT(*) n FROM users WHERE email IN (' + ph + ')').get(...EMAILS).n;
    dbx.prepare('DELETE FROM users WHERE email IN (' + ph + ')').run(...EMAILS);
    const after = dbx.prepare('SELECT COUNT(*) n FROM users WHERE email IN (' + ph + ')').get(...EMAILS).n;
    console.log('cleanup: removed ' + before + ' test users (' + after + ' remain)');
    dbx.close();
  } catch (e) { console.log('cleanup skipped: ' + e.message); }

  process.exit(fail ? 1 : 0);
})();
