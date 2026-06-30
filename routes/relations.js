// routes/relations.js
// Block / unblock, mute / unmute, and the "who can @mention me" preference.

const express = require('express');
const db = require('../db');
const { requireAuth, publicUser } = require('../auth');
const rel = require('../relations');

const router = express.Router();

// Resolve a list of ids to publicUser objects, preserving the given order.
async function usersByIds(ids) {
  if (!ids.length) return [];
  const ph = ids.map(() => '?').join(',');
  const rows = await db.prepare('SELECT * FROM users WHERE id IN (' + ph + ')').all(...ids);
  const byId = {}; rows.forEach((u) => (byId[u.id] = u));
  return ids.map((id) => byId[id]).filter(Boolean).map(publicUser);
}

// ---- Block (full two-way cutoff) ----
router.post('/block/:id', requireAuth, async (req, res) => {
  const target = Number(req.params.id);
  if (!target || target === req.user.id) return res.status(400).json({ error: 'You cannot block yourself' });
  const u = await db.prepare('SELECT id, is_official FROM users WHERE id = ?').get(target);
  if (!u) return res.status(404).json({ error: 'User not found' });
  if (u.is_official) return res.status(400).json({ error: 'You cannot block the official OpenBook account' });
  await rel.block(req.user.id, target);
  res.json({ ok: true, blocked: true });
});
router.delete('/block/:id', requireAuth, async (req, res) => {
  await rel.unblock(req.user.id, Number(req.params.id));
  res.json({ ok: true, blocked: false });
});
router.get('/blocks', requireAuth, async (req, res) => {
  res.json({ users: await usersByIds(await rel.listBlocked(req.user.id)) });
});

// ---- Mute (soft one-way hide) ----
router.post('/mute/:id', requireAuth, async (req, res) => {
  const target = Number(req.params.id);
  if (!target || target === req.user.id) return res.status(400).json({ error: 'You cannot mute yourself' });
  const u = await db.prepare('SELECT id FROM users WHERE id = ?').get(target);
  if (!u) return res.status(404).json({ error: 'User not found' });
  await rel.mute(req.user.id, target);
  res.json({ ok: true, muted: true });
});
router.delete('/mute/:id', requireAuth, async (req, res) => {
  await rel.unmute(req.user.id, Number(req.params.id));
  res.json({ ok: true, muted: false });
});
router.get('/mutes', requireAuth, async (req, res) => {
  res.json({ users: await usersByIds(await rel.listMuted(req.user.id)) });
});

// ---- Mention preference: who can @mention-notify you ----
router.put('/mention-pref', requireAuth, async (req, res) => {
  const pref = ['all', 'friends', 'none'].indexOf(req.body.pref) >= 0 ? req.body.pref : 'all';
  await db.prepare('UPDATE users SET mention_pref = ? WHERE id = ?').run(pref, req.user.id);
  res.json({ ok: true, mentionPref: pref });
});

module.exports = router;
