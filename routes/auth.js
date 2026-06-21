// routes/auth.js
// Signup, login, logout, and "who am I" endpoints.

const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { createSession, destroySession, publicUser } = require('../auth');
const { recordStandingEvent, refreshTrustLevel, trustSnapshot } = require('../trust');

const router = express.Router();

router.post('/signup', (req, res) => {
  const name = (req.body.name || '').trim();
  const email = (req.body.email || '').trim().toLowerCase();
  const password = req.body.password || '';

  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Name, email and password are all required' });
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (exists) return res.status(409).json({ error: 'That email is already registered' });

  const hash = bcrypt.hashSync(password, 10);
  const info = db
    .prepare('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)')
    .run(name, email, hash);

  createSession(info.lastInsertRowid, res);
  // Start this account's audit trail at the baseline standing.
  recordStandingEvent(info.lastInsertRowid, 0, 'account_created');
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  res.json({ user: publicUser(user) });
});

router.post('/login', (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const password = req.body.password || '';

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Wrong email or password' });
  }

  createSession(user.id, res);
  res.json({ user: publicUser(user) });
});

router.post('/logout', (req, res) => {
  destroySession(req.sessionToken, res);
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not logged in' });
  // Keep the trust level current, then return it only to the account owner.
  refreshTrustLevel(req.user.id);
  const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json({ user: publicUser(fresh), trust: trustSnapshot(fresh) });
});

module.exports = router;
