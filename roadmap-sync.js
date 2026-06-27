// roadmap-sync.js
// Optional bridge between the in-app community roadmap (the suggestion board) and
// the open-source GitHub repo. This makes the roadmap genuinely dynamic and ties
// it to the public code (Promise #5): an admin can link a top-voted suggestion to
// a GitHub issue, and when that issue (or its PR) is closed, the suggestion auto
// advances to "shipped" with a public ledger note.
//
// Everything here is OFF by default and degrades gracefully:
//   - issueUrl() always works (pure string).
//   - createIssue() needs GITHUB_TOKEN; without it, it throws a clear error and
//     the caller (admin "create issue" button) shows that message. Linking an
//     existing issue number never needs the token.
//   - syncRoadmap() only runs when GITHUB_TOKEN is set; otherwise it is a no-op.
//
// Standalone on purpose (it does its own DB writes for the ledger) so there is no
// circular require with routes/suggestions.js.

const db = require('./db');
const { logger } = require('./logger');

const REPO = process.env.GITHUB_REPO || 'PromoAI07/OPENBOOK';
const TOKEN = process.env.GITHUB_TOKEN || '';
const API = 'https://api.github.com';

function issueUrl(number) {
  return 'https://github.com/' + REPO + '/issues/' + number;
}

async function gh(method, pathPart, body) {
  if (!TOKEN) throw new Error('GitHub is not configured (set GITHUB_TOKEN).');
  const res = await fetch(API + '/repos/' + REPO + pathPart, {
    method,
    headers: {
      Authorization: 'Bearer ' + TOKEN,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'openbook-roadmap-sync',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error('GitHub API ' + res.status);
  return res.json();
}

// Create a roadmap-labelled issue for a suggestion; returns its number.
async function createIssue(suggestion) {
  const issue = await gh('POST', '/issues', {
    title: '[roadmap] ' + suggestion.title,
    body: (suggestion.body || '') + '\n\n_Proposed and voted by the OpenBook community._',
    labels: ['community-roadmap'],
  });
  return issue.number;
}

// Reconcile linked issues: when one is closed, flip the suggestion to "shipped"
// and write the public ledger row. Safe and idempotent (skips already-shipped).
async function syncRoadmap() {
  if (!TOKEN) return 0;
  let linked = [];
  try {
    linked = await db.prepare('SELECT id, github_issue, status FROM suggestions WHERE github_issue IS NOT NULL').all();
  } catch (e) { return 0; }
  let shipped = 0;
  for (const s of linked) {
    try {
      const issue = await gh('GET', '/issues/' + s.github_issue);
      if (issue.state === 'closed' && s.status !== 'shipped') {
        await db.prepare("UPDATE suggestions SET status = 'shipped', status_note = ?, status_at = datetime('now') WHERE id = ?")
          .run('Linked GitHub issue #' + s.github_issue + ' was closed (shipped).', s.id);
        await db.prepare(
          "INSERT INTO roadmap_events (suggestion_id, actor_id, from_status, to_status, note) VALUES (?, NULL, ?, 'shipped', ?)"
        ).run(s.id, s.status, 'Auto-shipped: GitHub issue #' + s.github_issue + ' closed.');
        shipped++;
      }
    } catch (e) {
      logger.warn({ err: e, suggestion: s.id }, 'roadmap sync: issue check failed');
    }
  }
  if (shipped) logger.info({ shipped }, 'roadmap sync advanced suggestions to shipped');
  return shipped;
}

let timer = null;
function startRoadmapJobs() {
  if (timer || !TOKEN) return; // only run when GitHub is configured
  syncRoadmap().catch((e) => logger.error({ err: e }, 'initial roadmap sync failed'));
  timer = setInterval(() => syncRoadmap().catch((e) => logger.error({ err: e }, 'roadmap sync failed')), 1800000); // 30 min
  if (timer.unref) timer.unref();
  logger.info('roadmap GitHub sync job started');
}

module.exports = { issueUrl, createIssue, syncRoadmap, startRoadmapJobs };
