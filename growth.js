// growth.js
// The public membership growth ladder and the Phase-1 signup cap. Scaling the
// servers is staged: we hold membership at a cap until there is enough support to
// fund the next tier of infrastructure, then raise it. All of this is shown
// publicly on the Support page, so the limit and the plan are never hidden.

const db = require('./db');

// The hard signup cap right now (Phase 1). Raise MAX_USERS the moment bigger
// servers are deployed (no code change needed). 0 or unset disables the cap.
const MAX_USERS = Number(process.env.MAX_USERS == null ? 5000 : process.env.MAX_USERS);

// The growth ladder. `to` is the member ceiling of each phase.
const PHASES = [
  { n: 1, name: 'Phase 1', from: 0, to: 5000 },
  { n: 2, name: 'Phase 2', from: 5000, to: 50000 },
  { n: 3, name: 'Phase 3', from: 50000, to: 250000 },
  { n: 4, name: 'Phase 4', from: 250000, to: 1000000 },
];

// The phase a given member count sits in (the first phase whose ceiling it is
// still under; the last phase once past every ceiling).
function phaseFor(count) {
  const c = Number(count) || 0;
  for (const p of PHASES) if (c < p.to) return p;
  return PHASES[PHASES.length - 1];
}

// Real members, excluding the internal sentinel accounts (the [deleted] ghost and
// the automated system actor), so the count and the cap mean "real people".
async function realUserCount() {
  const r = await db.prepare(
    "SELECT COUNT(*) c FROM users WHERE email NOT IN ('ghost@deleted.openbook.local','system@openbook.local')"
  ).get();
  return r ? r.c : 0;
}

async function signupsFull() {
  if (!(MAX_USERS > 0)) return false;
  return (await realUserCount()) >= MAX_USERS;
}

module.exports = { MAX_USERS, PHASES, phaseFor, realUserCount, signupsFull };
