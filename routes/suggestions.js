// routes/suggestions.js
// The community suggestion board: anyone can propose a fix / update / change,
// everyone up/down votes, and the list is sorted by score so the most-wanted
// ideas rise to the top. Admins set status (planned / shipped / declined) to show
// what is being built. One vote per user per suggestion.

const express = require('express');
const db = require('../db');
const { requireAuth, publicUser } = require('../auth');
const { trustRateLimit } = require('../antisybil');
const roadmapSync = require('../roadmap-sync');

const router = express.Router();

const CATEGORIES = ['fix', 'update', 'change'];
// 'in_progress' sits between planned and shipped so the public roadmap has a
// "Building now" column.
const STATUSES = ['open', 'planned', 'in_progress', 'shipped', 'declined'];

async function decorate(s, viewerId) {
  const tally = await db
    .prepare(
      "SELECT COALESCE(SUM(value), 0) AS score, " +
      "COALESCE(SUM(CASE WHEN value = 1 THEN 1 ELSE 0 END), 0) AS up, " +
      "COALESCE(SUM(CASE WHEN value = -1 THEN 1 ELSE 0 END), 0) AS down " +
      "FROM suggestion_votes WHERE suggestion_id = ?"
    )
    .get(s.id);
  // A TRANSPARENCY signal only: the same tally with currently-flagged accounts
  // excluded. The raw score above stays the official one-human-one-vote count
  // that actually decides ordering (Promise #4); this is shown beside it so
  // readers can see real-human-leaning support, never to silently reweight it.
  const filtered = await db
    .prepare(
      "SELECT COALESCE(SUM(value), 0) AS score FROM suggestion_votes " +
      "WHERE suggestion_id = ? AND user_id NOT IN (SELECT user_id FROM sybil_flags WHERE status = 'open')"
    )
    .get(s.id);
  const mine = viewerId ? await db.prepare('SELECT value FROM suggestion_votes WHERE suggestion_id = ? AND user_id = ?').get(s.id, viewerId) : null;
  return {
    id: s.id,
    title: s.title,
    body: s.body,
    category: s.category,
    status: s.status,
    statusNote: s.status_note || '',
    statusAt: s.status_at || null,
    github: s.github_issue ? { issue: s.github_issue, url: roadmapSync.issueUrl(s.github_issue) } : null,
    created_at: s.created_at,
    author: publicUser(await db.prepare('SELECT * FROM users WHERE id = ?').get(s.user_id)),
    score: tally.score,
    up: tally.up,
    down: tally.down,
    sybilFilteredScore: filtered.score,
    myVote: mine ? mine.value : 0,
    mine: s.user_id === viewerId,
  };
}

// Record a status change to the public ledger and stamp the suggestion. Shared
// by the admin status route and (later) the GitHub auto-ship sync.
async function setStatusWithLog(suggestionId, actorId, fromStatus, toStatus, note) {
  await db.prepare("UPDATE suggestions SET status = ?, status_note = ?, status_at = datetime('now') WHERE id = ?")
    .run(toStatus, String(note || ''), suggestionId);
  await db.prepare(
    'INSERT INTO roadmap_events (suggestion_id, actor_id, from_status, to_status, note) VALUES (?, ?, ?, ?, ?)'
  ).run(suggestionId, actorId || null, fromStatus || '', toStatus, String(note || ''));
}

// List, sorted by score (then newest). Optional ?status= filter.
router.get('/', requireAuth, async (req, res) => {
  const status = STATUSES.indexOf(req.query.status) >= 0 ? req.query.status : null;
  const rows = status
    ? await db.prepare('SELECT * FROM suggestions WHERE status = ?').all(status)
    : await db.prepare('SELECT * FROM suggestions').all();
  const list = await Promise.all(rows.map((s) => decorate(s, req.user.id)));
  // Highest score first; ties broken by newest (id grows with time).
  list.sort((a, b) => (b.score - a.score) || (b.id - a.id));
  res.json({ suggestions: list, isAdmin: !!req.user.is_admin });
});

// Create a suggestion. Rate-limited like other content creation. The author
// auto-upvotes their own idea.
router.post('/', requireAuth, trustRateLimit('post'), async (req, res) => {
  const title = String(req.body.title || '').trim().slice(0, 140);
  const body = String(req.body.body || '').trim().slice(0, 2000);
  const category = CATEGORIES.indexOf(req.body.category) >= 0 ? req.body.category : 'change';
  if (!title) return res.status(400).json({ error: 'Give your suggestion a short title' });
  const info = await db.prepare('INSERT INTO suggestions (user_id, title, body, category) VALUES (?, ?, ?, ?)').run(req.user.id, title, body, category);
  try {
    await db.prepare('INSERT OR IGNORE INTO suggestion_votes (suggestion_id, user_id, value) VALUES (?, ?, 1)').run(info.lastInsertRowid, req.user.id);
  } catch (e) { /* non-fatal */ }
  res.json({ suggestion: await decorate(await db.prepare('SELECT * FROM suggestions WHERE id = ?').get(info.lastInsertRowid), req.user.id) });
});

// Vote: value 1 (up), -1 (down), or 0 (clear). One vote per user.
router.post('/:id/vote', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const value = Number(req.body.value);
  const s = await db.prepare('SELECT * FROM suggestions WHERE id = ?').get(id);
  if (!s) return res.status(404).json({ error: 'Suggestion not found' });
  if (value === 0) {
    await db.prepare('DELETE FROM suggestion_votes WHERE suggestion_id = ? AND user_id = ?').run(id, req.user.id);
  } else if (value === 1 || value === -1) {
    await db.prepare(
      "INSERT INTO suggestion_votes (suggestion_id, user_id, value) VALUES (?, ?, ?) " +
      "ON CONFLICT(suggestion_id, user_id) DO UPDATE SET value = excluded.value, created_at = datetime('now')"
    ).run(id, req.user.id, value);
  } else {
    return res.status(400).json({ error: 'Invalid vote' });
  }
  res.json({ suggestion: await decorate(await db.prepare('SELECT * FROM suggestions WHERE id = ?').get(id), req.user.id) });
});

// Admin: set status (mark the winners as planned / in_progress / shipped /
// declined). Every change is written to the public roadmap ledger with an
// optional note explaining why.
router.post('/:id/status', requireAuth, async (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Admins only' });
  const id = Number(req.params.id);
  const status = STATUSES.indexOf(req.body.status) >= 0 ? req.body.status : null;
  if (!status) return res.status(400).json({ error: 'Invalid status' });
  const note = String(req.body.note || '').trim().slice(0, 280);
  const s = await db.prepare('SELECT * FROM suggestions WHERE id = ?').get(id);
  if (!s) return res.status(404).json({ error: 'Suggestion not found' });
  await setStatusWithLog(id, req.user.id, s.status, status, note);
  res.json({ suggestion: await decorate(await db.prepare('SELECT * FROM suggestions WHERE id = ?').get(id), req.user.id) });
});

// Admin: link this suggestion to a GitHub issue (or create one). Ties the
// in-app roadmap vote to the open-source repo so "shipped" can later auto-flip
// when the linked issue/PR closes (see roadmap-sync.js). No-op friendly: if no
// GITHUB_TOKEN is configured, creating returns a clear error but linking an
// existing number still works.
router.post('/:id/github', requireAuth, async (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Admins only' });
  const id = Number(req.params.id);
  const s = await db.prepare('SELECT * FROM suggestions WHERE id = ?').get(id);
  if (!s) return res.status(404).json({ error: 'Suggestion not found' });
  const linkNumber = Number(req.body.issue) || 0;
  try {
    let issue = linkNumber;
    if (!issue && req.body.create) issue = await roadmapSync.createIssue(s);
    if (!issue) return res.status(400).json({ error: 'Provide an issue number or set create:true' });
    await db.prepare('UPDATE suggestions SET github_issue = ? WHERE id = ?').run(issue, id);
    res.json({ suggestion: await decorate(await db.prepare('SELECT * FROM suggestions WHERE id = ?').get(id), req.user.id) });
  } catch (e) {
    res.status(400).json({ error: e.message || 'GitHub link failed' });
  }
});

// Delete (author or admin).
router.delete('/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const s = await db.prepare('SELECT * FROM suggestions WHERE id = ?').get(id);
  if (!s) return res.status(404).json({ error: 'Suggestion not found' });
  if (s.user_id !== req.user.id && !req.user.is_admin) return res.status(403).json({ error: 'Not allowed' });
  await db.prepare('DELETE FROM suggestions WHERE id = ?').run(id);
  res.json({ ok: true });
});

module.exports = router;
