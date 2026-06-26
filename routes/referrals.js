// routes/referrals.js
// The invite page's data: your referral link + progress, and a leaderboard.

const express = require('express');
const { requireAuth, publicUser } = require('../auth');
const { statsFor, leaderboard } = require('../referrals');

const router = express.Router();

// Your referral code, share link, and progress toward the next free month.
router.get('/me', requireAuth, (req, res) => {
  const s = statsFor(req.user.id);
  const base = req.protocol + '://' + req.get('host');
  res.json(Object.assign({ link: base + '/?ref=' + encodeURIComponent(s.code || '') }, s));
});

// Top inviters (qualified referrals). Public-ish (auth required) and aggregate.
router.get('/leaderboard', requireAuth, (req, res) => {
  const rows = leaderboard(10).map((r) => Object.assign(publicUser(r), { qualified: r.qualified }));
  res.json({ leaderboard: rows });
});

module.exports = router;
