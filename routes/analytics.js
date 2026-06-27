// routes/analytics.js
// Receives small batches of coarse usage events from the app (page views, button
// clicks, visibility heartbeats) for the owner analytics dashboard. Open to
// logged-in and anonymous clients (so top-of-funnel is captured), but tightly
// bounded: a whitelist of event types, a capped batch size, and short labels.
// We never store content or personal data here, only a view name or a button id.

const express = require('express');
const db = require('../db');

const router = express.Router();
const ALLOWED = new Set(['pageview', 'click', 'heartbeat']);

router.post('/', async (req, res) => {
  const session = (req.body && req.body.session ? String(req.body.session) : '').slice(0, 64);
  const events = (req.body && Array.isArray(req.body.events)) ? req.body.events.slice(0, 50) : [];
  const uid = req.user ? req.user.id : null;
  const ins = db.prepare('INSERT INTO analytics_events (user_id, session_id, type, label) VALUES (?, ?, ?, ?)');
  let stored = 0;
  for (const e of events) {
    if (!e || !ALLOWED.has(e.type)) continue;
    await ins.run(uid, session, e.type, (e.label == null ? '' : String(e.label)).slice(0, 80));
    stored++;
  }
  res.json({ ok: true, stored });
});

module.exports = router;
