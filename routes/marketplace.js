// routes/marketplace.js
// Marketplace listings: browse, view, create (with photo), mark sold, delete.
// Listings are visible to all logged-in users; buyers reach sellers via chat.

const express = require('express');
const db = require('../db');
const { requireAuth, publicUser } = require('../auth');
const { upload } = require('../upload');

const cleanup = require('../media/cleanup');

const router = express.Router();

function decorate(listing, viewerId) {
  const seller = db.prepare('SELECT * FROM users WHERE id = ?').get(listing.seller_id);
  return {
    id: listing.id,
    title: listing.title,
    description: listing.description,
    price: listing.price,
    category: listing.category,
    location: listing.location,
    image: listing.image,
    status: listing.status,
    created_at: listing.created_at,
    seller: publicUser(seller),
    isMine: listing.seller_id === viewerId,
  };
}

// Browse listings, with optional text search and category filter.
router.get('/', requireAuth, (req, res) => {
  const q = (req.query.q || '').trim();
  const category = (req.query.category || '').trim();
  const where = [];
  const params = [];
  if (q) {
    where.push('(title LIKE ? OR description LIKE ?)');
    params.push('%' + q + '%', '%' + q + '%');
  }
  if (category && category !== 'All') {
    where.push('category = ?');
    params.push(category);
  }
  const sql =
    'SELECT * FROM listings' +
    (where.length ? ' WHERE ' + where.join(' AND ') : '') +
    ' ORDER BY created_at DESC, id DESC LIMIT 100';
  const rows = db.prepare(sql).all(...params);
  res.json({ listings: rows.map((l) => decorate(l, req.user.id)) });
});

// My own listings.
router.get('/mine', requireAuth, (req, res) => {
  const rows = db
    .prepare('SELECT * FROM listings WHERE seller_id = ? ORDER BY created_at DESC, id DESC')
    .all(req.user.id);
  res.json({ listings: rows.map((l) => decorate(l, req.user.id)) });
});

// A single listing.
router.get('/:id', requireAuth, (req, res) => {
  const l = db.prepare('SELECT * FROM listings WHERE id = ?').get(Number(req.params.id));
  if (!l) return res.status(404).json({ error: 'Listing not found' });
  res.json({ listing: decorate(l, req.user.id) });
});

// Create a listing.
router.post('/', requireAuth, upload.single('image'), (req, res) => {
  const title = (req.body.title || '').trim();
  const description = (req.body.description || '').trim();
  const price = Number(req.body.price);
  const category = (req.body.category || 'General').trim() || 'General';
  const location = (req.body.location || '').trim();
  const image = req.file ? '/uploads/' + req.file.filename : '';
  if (!title) return res.status(400).json({ error: 'A title is required' });
  if (!Number.isFinite(price) || price < 0) return res.status(400).json({ error: 'Enter a valid price' });

  const info = db
    .prepare(
      'INSERT INTO listings (seller_id, title, description, price, category, location, image) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .run(req.user.id, title, description, price, category, location, image);
  const l = db.prepare('SELECT * FROM listings WHERE id = ?').get(info.lastInsertRowid);
  res.json({ listing: decorate(l, req.user.id) });
});

// Toggle a listing between available and sold (seller only).
router.post('/:id/sold', requireAuth, (req, res) => {
  const l = db.prepare('SELECT * FROM listings WHERE id = ?').get(Number(req.params.id));
  if (!l) return res.status(404).json({ error: 'Listing not found' });
  if (l.seller_id !== req.user.id) return res.status(403).json({ error: 'This is not your listing' });
  const status = l.status === 'sold' ? 'available' : 'sold';
  db.prepare('UPDATE listings SET status = ? WHERE id = ?').run(status, l.id);
  res.json({ status });
});

// Delete a listing (seller only).
router.delete('/:id', requireAuth, (req, res) => {
  const l = db.prepare('SELECT * FROM listings WHERE id = ?').get(Number(req.params.id));
  if (!l) return res.status(404).json({ error: 'Listing not found' });
  if (l.seller_id !== req.user.id) return res.status(403).json({ error: 'This is not your listing' });
  db.prepare('DELETE FROM listings WHERE id = ?').run(l.id);
  if (l.image) cleanup.deleteMedia(l.image, l.seller_id);
  res.json({ ok: true });
});

module.exports = router;
