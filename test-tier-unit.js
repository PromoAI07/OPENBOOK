// Tier/entitlement isolated logic test (throwaway DB in temp).
// Covers effectiveTier (incl. expiry), grantTier/revokeTier, publicTierFields,
// publicUser tier fields, tierList, and the credible-neutrality guardrail that a
// tier grant never touches karma / standing / reach_score.

const os = require('os'); const fs = require('fs'); const path = require('path');
const tmp = path.join(os.tmpdir(), 'ob_tier_' + Date.now());
fs.mkdirSync(tmp, { recursive: true });
process.env.DATA_DIR = tmp; process.env.SYBIL_JOB = '0'; process.env.LOG_LEVEL = 'silent';
delete process.env.ADMIN_EMAILS;

const ent = require('./entitlements');
const { publicUser } = require('./auth');
const db = require('./db');

let pass = 0, fail = 0;
function check(n, c) { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n); } }

// tierList
check('tierList has 3 paid tiers', ent.tierList().length === 3 && ent.tierList()[0].price === 1 && ent.tierList()[2].price === 10);

// effectiveTier
check('free -> 0', ent.effectiveTier({ supporter_tier: 0 }) === 0);
check('tier2 future -> 2', ent.effectiveTier({ supporter_tier: 2, supporter_expires: '2999-01-01 00:00:00' }) === 2);
check('tier2 past -> 0 (expired)', ent.effectiveTier({ supporter_tier: 2, supporter_expires: '2000-01-01 00:00:00' }) === 0);
check('tier3 permanent (null expiry) -> 3', ent.effectiveTier({ supporter_tier: 3, supporter_expires: null }) === 3);
check('tier clamps to 3', ent.effectiveTier({ supporter_tier: 9, supporter_expires: null }) === 3);

// publicTierFields
const f1 = ent.publicTierFields({ supporter_tier: 1, supporter_expires: null });
check('tier1 fields: verified + bronze', f1.tier === 1 && f1.verified === true && f1.badge === 'bronze' && f1.tierName === 'Supporter');
const f0 = ent.publicTierFields({ supporter_tier: 0 });
check('tier0 fields: not verified, no badge', f0.verified === false && f0.badge === null);

// grantTier on a real user + publicUser exposes the fields + GUARDRAIL
const id = db.prepare("INSERT INTO users (name,email,password_hash) VALUES ('T','t@x.com','h')").run().lastInsertRowid;
const before = db.prepare('SELECT karma, standing, reach_score FROM users WHERE id=?').get(id);
ent.grantTier(id, 2, 30, 'test');
let row = db.prepare('SELECT * FROM users WHERE id=?').get(id);
check('grant sets tier 2', ent.effectiveTier(row) === 2);
check('grant sets supporter_since + expires', !!row.supporter_since && !!row.supporter_expires);
const pu = publicUser(row);
check('publicUser exposes verified tick', pu.verified === true && pu.tier === 2 && pu.badge === 'silver');
const after = db.prepare('SELECT karma, standing, reach_score FROM users WHERE id=?').get(id);
check('GUARDRAIL: grant did not change karma', after.karma === before.karma);
check('GUARDRAIL: grant did not change standing', after.standing === before.standing);
check('GUARDRAIL: grant did not change reach_score', after.reach_score === before.reach_score);

// expiry through publicUser
db.prepare("UPDATE users SET supporter_expires='2000-01-01 00:00:00' WHERE id=?").run(id);
row = db.prepare('SELECT * FROM users WHERE id=?').get(id);
check('expired supporter shows no tick', publicUser(row).verified === false);

// revoke
ent.grantTier(id, 3, 0, 'perm'); // permanent premium
check('permanent grant -> tier 3 verified', publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(id)).tier === 3);
ent.revokeTier(id, 'test');
check('revoke -> tier 0', publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(id)).tier === 0);

// audit trail
const events = db.prepare('SELECT COUNT(*) c FROM supporter_events WHERE user_id=?').get(id).c;
check('supporter_events logged each change', events >= 3);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);
