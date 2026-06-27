// routes/roadmap.js
// The PUBLIC, read-only projection of the community suggestion board, shaped as a
// roadmap. Anyone (logged in or out) can see what the community is steering the
// platform toward, because "the community decides" (Promise #4) should be
// visible to the whole world, not just members. The official ordering uses the
// raw one-human-one-vote score; a sybil-filtered score is shown beside it for
// transparency, never instead of it.

const express = require('express');
const db = require('../db');
const { publicUser } = require('../auth');
const roadmapSync = require('../roadmap-sync');

const router = express.Router();

const COLUMN_FOR = {
  open: 'considering',
  planned: 'planned',
  in_progress: 'in_progress',
  shipped: 'shipped',
  declined: 'declined',
};

// Build score maps in two grouped queries (no N+1 as the board grows).
async function tallies() {
  const raw = await db.prepare(
    'SELECT suggestion_id, ' +
    'COALESCE(SUM(value),0) score, ' +
    'COALESCE(SUM(CASE WHEN value=1 THEN 1 ELSE 0 END),0) up, ' +
    'COALESCE(SUM(CASE WHEN value=-1 THEN 1 ELSE 0 END),0) down ' +
    'FROM suggestion_votes GROUP BY suggestion_id'
  ).all();
  const filtered = await db.prepare(
    "SELECT suggestion_id, COALESCE(SUM(value),0) score FROM suggestion_votes " +
    "WHERE user_id NOT IN (SELECT user_id FROM sybil_flags WHERE status = 'open') GROUP BY suggestion_id"
  ).all();
  const rawMap = new Map(raw.map((r) => [r.suggestion_id, r]));
  const filtMap = new Map(filtered.map((r) => [r.suggestion_id, r.score]));
  return { rawMap, filtMap };
}

function item(s, t, filt, author) {
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
    author: author ? { id: author.id, name: author.name, badge: author.badge, verified: author.verified } : null,
    score: t ? t.score : 0,
    up: t ? t.up : 0,
    down: t ? t.down : 0,
    sybilFilteredScore: filt == null ? 0 : filt,
  };
}

// GET /api/roadmap : every suggestion grouped into roadmap columns.
router.get('/', async (req, res, next) => {
  try {
    const rows = await db.prepare('SELECT * FROM suggestions').all();
    const { rawMap, filtMap } = await tallies();
    // Author lookup (one query, mapped).
    const ids = [...new Set(rows.map((r) => r.user_id))];
    const authors = new Map();
    if (ids.length) {
      const ph = ids.map(() => '?').join(',');
      const us = await db.prepare('SELECT * FROM users WHERE id IN (' + ph + ')').all(...ids);
      for (const u of us) authors.set(u.id, publicUser(u));
    }
    const columns = { considering: [], planned: [], in_progress: [], shipped: [], declined: [] };
    for (const s of rows) {
      const col = COLUMN_FOR[s.status] || 'considering';
      columns[col].push(item(s, rawMap.get(s.id), filtMap.get(s.id), authors.get(s.user_id)));
    }
    for (const k of Object.keys(columns)) {
      columns[k].sort((a, b) => (b.score - a.score) || (b.id - a.id));
    }
    res.json({ columns, updated_at: new Date().toISOString() });
  } catch (e) { next(e); }
});

// GET /api/roadmap/:id : one item plus its full public status history.
router.get('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const s = await db.prepare('SELECT * FROM suggestions WHERE id = ?').get(id);
    if (!s) return res.status(404).json({ error: 'Not found' });
    const { rawMap, filtMap } = await tallies();
    const author = publicUser(await db.prepare('SELECT * FROM users WHERE id = ?').get(s.user_id));
    const history = await db.prepare(
      'SELECT from_status, to_status, note, created_at FROM roadmap_events WHERE suggestion_id = ? ORDER BY id'
    ).all(id);
    res.json({ item: item(s, rawMap.get(id), filtMap.get(id), author), history });
  } catch (e) { next(e); }
});

module.exports = router;
