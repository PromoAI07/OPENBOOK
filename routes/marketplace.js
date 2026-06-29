// routes/marketplace.js
// Marketplace listings: browse, view, create (with photo), mark sold, delete.
// Listings are visible to all logged-in users; buyers reach sellers via chat.

const express = require('express');
const db = require('../db');
const { requireAuth, publicUser } = require('../auth');
const { upload } = require('../upload');

const cleanup = require('../media/cleanup');

const router = express.Router();

async function decorate(listing, viewerId) {
  const seller = await db.prepare('SELECT * FROM users WHERE id = ?').get(listing.seller_id);
  return {
    id: listing.id,
    title: listing.title,
    description: listing.description,
    price: listing.price,
    category: listing.category,
    location: listing.location,
    condition: listing.condition || '',
    delivery: listing.delivery || '',
    escrow: !!listing.escrow,
    image: listing.image,
    status: listing.status,
    created_at: listing.created_at,
    seller: publicUser(seller),
    isMine: listing.seller_id === viewerId,
  };
}

// Browse listings, with optional text search and category filter.
router.get('/', requireAuth, async (req, res) => {
  const q = (req.query.q || '').trim();
  const category = (req.query.category || '').trim();
  const condition = (req.query.condition || '').trim();
  const loc = (req.query.location || '').trim();
  const minPrice = Number(req.query.minPrice);
  const maxPrice = Number(req.query.maxPrice);
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
  if (condition && condition !== 'All') {
    where.push('condition = ?');
    params.push(condition);
  }
  if (loc) {
    where.push('location LIKE ?');
    params.push('%' + loc + '%');
  }
  if (Number.isFinite(minPrice) && minPrice > 0) { where.push('price >= ?'); params.push(minPrice); }
  if (Number.isFinite(maxPrice) && maxPrice > 0) { where.push('price <= ?'); params.push(maxPrice); }
  const sql =
    'SELECT * FROM listings' +
    (where.length ? ' WHERE ' + where.join(' AND ') : '') +
    ' ORDER BY created_at DESC, id DESC LIMIT 100';
  const rows = await db.prepare(sql).all(...params);
  res.json({ listings: await Promise.all(rows.map((l) => decorate(l, req.user.id))) });
});

// My own listings.
router.get('/mine', requireAuth, async (req, res) => {
  const rows = await db
    .prepare('SELECT * FROM listings WHERE seller_id = ? ORDER BY created_at DESC, id DESC')
    .all(req.user.id);
  res.json({ listings: await Promise.all(rows.map((l) => decorate(l, req.user.id))) });
});

// A single listing.
router.get('/:id', requireAuth, async (req, res) => {
  const l = await db.prepare('SELECT * FROM listings WHERE id = ?').get(Number(req.params.id));
  if (!l) return res.status(404).json({ error: 'Listing not found' });
  res.json({ listing: await decorate(l, req.user.id) });
});

// Create a listing.
router.post('/', requireAuth, upload.single('image'), async (req, res) => {
  const title = (req.body.title || '').trim();
  const description = (req.body.description || '').trim();
  const price = Number(req.body.price);
  const category = (req.body.category || 'General').trim() || 'General';
  const location = (req.body.location || '').trim();
  const CONDITIONS = ['new', 'like_new', 'good', 'fair', 'parts'];
  const condition = CONDITIONS.includes(req.body.condition) ? req.body.condition : '';
  const DELIVERY = ['shipping', 'pickup', 'both'];
  const delivery = DELIVERY.includes(req.body.delivery) ? req.body.delivery : '';
  const image = req.file ? '/uploads/' + req.file.filename : '';
  if (!title) return res.status(400).json({ error: 'A title is required' });
  if (!Number.isFinite(price) || price < 0) return res.status(400).json({ error: 'Enter a valid price' });

  // Escrow: only offered when the seller opts in AND the price is within the cap
  // (bigger items are face-to-face only). The buy route enforces this again.
  const ESCROW_MAX = Math.max(0, Number(process.env.ESCROW_MAX_AMOUNT || 1000));
  const wantsEscrow = [true, 1, '1', 'true', 'on'].includes(req.body.escrow);
  const escrow = (wantsEscrow && price > 0 && (ESCROW_MAX === 0 || price <= ESCROW_MAX)) ? 1 : 0;

  const info = await db
    .prepare(
      'INSERT INTO listings (seller_id, title, description, price, category, location, condition, delivery, escrow, image) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .run(req.user.id, title, description, price, category, location, condition, delivery, escrow, image);
  const l = await db.prepare('SELECT * FROM listings WHERE id = ?').get(info.lastInsertRowid);
  res.json({ listing: await decorate(l, req.user.id) });
});

// Toggle a listing between available and sold (seller only).
router.post('/:id/sold', requireAuth, async (req, res) => {
  const l = await db.prepare('SELECT * FROM listings WHERE id = ?').get(Number(req.params.id));
  if (!l) return res.status(404).json({ error: 'Listing not found' });
  if (l.seller_id !== req.user.id) return res.status(403).json({ error: 'This is not your listing' });
  const status = l.status === 'sold' ? 'available' : 'sold';
  await db.prepare('UPDATE listings SET status = ? WHERE id = ?').run(status, l.id);
  res.json({ status });
});

// Delete a listing (seller only).
router.delete('/:id', requireAuth, async (req, res) => {
  const l = await db.prepare('SELECT * FROM listings WHERE id = ?').get(Number(req.params.id));
  if (!l) return res.status(404).json({ error: 'Listing not found' });
  if (l.seller_id !== req.user.id) return res.status(403).json({ error: 'This is not your listing' });
  await db.prepare('DELETE FROM listings WHERE id = ?').run(l.id);
  if (l.image) await cleanup.deleteMedia(l.image, l.seller_id);
  res.json({ ok: true });
});

module.exports = router;
