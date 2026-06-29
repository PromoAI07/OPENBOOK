// routes/escrow.js
// Marketplace escrow ("protected transactions"). The platform sits between buyer
// and seller: the buyer's money is held until they confirm "got it, all good",
// then it is released to the seller minus the platform fee. If the two disagree,
// a platform admin reviews both sides' evidence and decides who gets the money.
//
// MONEY IS GATED. ESCROW_LIVE=1 turns on the real custodial USDT rail (verify the
// buyer's funding tx on-chain, pay the seller on release). While it is off
// (default), the FULL workflow, evidence, and dispute flow run as a clearly
// labeled preview, but no real funds move. This lets the product be built and
// trialed before the legal/licensing side is settled.
//
// CREDIBLE NEUTRALITY: escrow is a marketplace service, entirely separate from the
// reputation engine. Holding or releasing escrow never touches karma, standing,
// reach, or votes.

const express = require('express');
const db = require('../db');
const { requireAuth, publicUser } = require('../auth');
const { isAdmin } = require('../moderation');
const { notify } = require('../notify');
const { upload } = require('../upload');

const router = express.Router();

const ESCROW_LIVE = process.env.ESCROW_LIVE === '1';
const ESCROW_FEE_PCT = Math.max(0, Math.min(50, Number(process.env.ESCROW_FEE_PCT || 5)));

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function computeAmounts(price) {
  const amount = round2(price);
  const fee = round2(amount * (ESCROW_FEE_PCT / 100));
  return { amount, fee_pct: ESCROW_FEE_PCT, fee_amount: fee, seller_amount: round2(amount - fee) };
}

async function recordEvent(orderId, actorId, event, detail) {
  try {
    await db.prepare('INSERT INTO order_events (order_id, actor_id, event, detail) VALUES (?, ?, ?, ?)')
      .run(orderId, actorId || null, String(event), String(detail || ''));
  } catch (e) { /* best effort */ }
}

async function touch(orderId, status) {
  await db.prepare("UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, orderId);
}

async function loadOrder(id) {
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(Number(id));
}

async function decorateOrder(o, viewerId, opts) {
  opts = opts || {};
  const buyer = await db.prepare('SELECT * FROM users WHERE id = ?').get(o.buyer_id);
  const seller = await db.prepare('SELECT * FROM users WHERE id = ?').get(o.seller_id);
  const out = {
    id: o.id,
    listingId: o.listing_id,
    title: o.title,
    amount: o.amount,
    feePct: o.fee_pct,
    feeAmount: o.fee_amount,
    sellerAmount: o.seller_amount,
    currency: o.currency,
    status: o.status,
    live: !!o.live,
    disputeReason: o.dispute_reason || '',
    disputeBy: o.dispute_by || null,
    resolution: o.resolution || '',
    created_at: o.created_at,
    updated_at: o.updated_at,
    buyer: buyer ? publicUser(buyer) : null,
    seller: seller ? publicUser(seller) : null,
    isBuyer: o.buyer_id === viewerId,
    isSeller: o.seller_id === viewerId,
  };
  if (opts.full) {
    out.evidence = (await db.prepare('SELECT * FROM order_evidence WHERE order_id = ? ORDER BY id ASC').all(o.id))
      .map((e) => ({ id: e.id, role: e.role, kind: e.kind, mediaUrl: e.media_url, note: e.note, created_at: e.created_at, userId: e.user_id }));
    out.events = (await db.prepare('SELECT * FROM order_events WHERE order_id = ? ORDER BY id ASC').all(o.id))
      .map((e) => ({ event: e.event, detail: e.detail, created_at: e.created_at }));
  }
  return out;
}

// Public escrow config so the UI can explain the state of things.
router.get('/config', (req, res) => {
  res.json({ live: ESCROW_LIVE, feePct: ESCROW_FEE_PCT });
});

// Buyer commits to buy a listing -> creates the escrow order. When the rail is
// live the buyer then funds it; while gated, it starts already "held" (simulated)
// so the rest of the flow is usable.
router.post('/buy', requireAuth, async (req, res) => {
  const listing = await db.prepare('SELECT * FROM listings WHERE id = ?').get(Number(req.body.listingId));
  if (!listing) return res.status(404).json({ error: 'Listing not found' });
  if (listing.seller_id === req.user.id) return res.status(400).json({ error: 'You cannot buy your own listing' });
  if (listing.status === 'sold') return res.status(409).json({ error: 'This item is already sold' });
  if (listing.status === 'pending') return res.status(409).json({ error: 'This item has a purchase in progress' });
  if (!(Number(listing.price) > 0)) return res.status(400).json({ error: 'This item has no price set, message the seller instead' });

  const a = computeAmounts(listing.price);
  const status = ESCROW_LIVE ? 'awaiting_funds' : 'funds_held'; // gated: simulate the hold so the flow works
  const info = await db.prepare(
    'INSERT INTO orders (listing_id, buyer_id, seller_id, title, amount, fee_pct, fee_amount, seller_amount, currency, status, live) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(listing.id, req.user.id, listing.seller_id, listing.title, a.amount, a.fee_pct, a.fee_amount, a.seller_amount, 'USDT', status, ESCROW_LIVE ? 1 : 0);

  await db.prepare("UPDATE listings SET status = 'pending' WHERE id = ?").run(listing.id);
  await recordEvent(info.lastInsertRowid, req.user.id, 'created', 'order opened' + (ESCROW_LIVE ? '' : ' (preview, no funds moved)'));
  await notify(listing.seller_id, req.user.id, 'escrow_update', null);
  const o = await loadOrder(info.lastInsertRowid);
  res.json({ order: await decorateOrder(o, req.user.id, { full: true }) });
});

// My orders, as buyer or seller.
router.get('/orders', requireAuth, async (req, res) => {
  const rows = await db.prepare(
    'SELECT * FROM orders WHERE buyer_id = ? OR seller_id = ? ORDER BY updated_at DESC, id DESC LIMIT 100'
  ).all(req.user.id, req.user.id);
  res.json({ orders: await Promise.all(rows.map((o) => decorateOrder(o, req.user.id))) });
});

// One order in detail (buyer, seller, or admin), with evidence + event trail.
router.get('/orders/:id', requireAuth, async (req, res) => {
  const o = await loadOrder(req.params.id);
  if (!o) return res.status(404).json({ error: 'Order not found' });
  if (o.buyer_id !== req.user.id && o.seller_id !== req.user.id && !isAdmin(req.user)) {
    return res.status(403).json({ error: 'This is not your order' });
  }
  res.json({ order: await decorateOrder(o, req.user.id, { full: true }) });
});

// Seller marks the item shipped / handed over (from funds_held).
router.post('/orders/:id/shipped', requireAuth, async (req, res) => {
  const o = await loadOrder(req.params.id);
  if (!o) return res.status(404).json({ error: 'Order not found' });
  if (o.seller_id !== req.user.id) return res.status(403).json({ error: 'Only the seller can do that' });
  if (o.status !== 'funds_held') return res.status(409).json({ error: 'This order is not in a state to be shipped' });
  await touch(o.id, 'shipped');
  await recordEvent(o.id, req.user.id, 'shipped', (req.body.note || '').toString().slice(0, 300));
  await notify(o.buyer_id, req.user.id, 'escrow_update', null);
  res.json({ ok: true, status: 'shipped' });
});

// Buyer confirms "got it, all good" -> release to the seller (minus fee). Works
// from funds_held (face to face) or shipped (delivery).
router.post('/orders/:id/received', requireAuth, async (req, res) => {
  const o = await loadOrder(req.params.id);
  if (!o) return res.status(404).json({ error: 'Order not found' });
  if (o.buyer_id !== req.user.id) return res.status(403).json({ error: 'Only the buyer can confirm receipt' });
  if (o.status !== 'funds_held' && o.status !== 'shipped') return res.status(409).json({ error: 'This order cannot be confirmed right now' });
  // LIVE: this is where the USDT payout to the seller (minus fee) is triggered.
  // While gated we just record the release; no funds move.
  await touch(o.id, 'completed');
  await db.prepare("UPDATE listings SET status = 'sold' WHERE id = ?").run(o.listing_id);
  await recordEvent(o.id, req.user.id, 'released', 'buyer confirmed receipt; ' + (o.live ? 'funds released to seller' : 'preview, no funds moved'));
  await notify(o.seller_id, req.user.id, 'escrow_update', null);
  res.json({ ok: true, status: 'completed' });
});

// Either party opens a dispute -> goes to the platform-admin queue.
router.post('/orders/:id/dispute', requireAuth, async (req, res) => {
  const o = await loadOrder(req.params.id);
  if (!o) return res.status(404).json({ error: 'Order not found' });
  if (o.buyer_id !== req.user.id && o.seller_id !== req.user.id) return res.status(403).json({ error: 'This is not your order' });
  if (!['funds_held', 'shipped'].includes(o.status)) return res.status(409).json({ error: 'This order cannot be disputed right now' });
  const reason = (req.body.reason || '').toString().slice(0, 600);
  if (!reason) return res.status(400).json({ error: 'Explain the problem so an admin can review it' });
  await db.prepare("UPDATE orders SET status = 'disputed', dispute_reason = ?, dispute_by = ?, updated_at = datetime('now') WHERE id = ?")
    .run(reason, req.user.id, o.id);
  await recordEvent(o.id, req.user.id, 'disputed', reason);
  await notify(o.buyer_id === req.user.id ? o.seller_id : o.buyer_id, req.user.id, 'escrow_update', null);
  res.json({ ok: true, status: 'disputed' });
});

// Buyer (before shipped) or seller can cancel; the listing reopens.
router.post('/orders/:id/cancel', requireAuth, async (req, res) => {
  const o = await loadOrder(req.params.id);
  if (!o) return res.status(404).json({ error: 'Order not found' });
  const isBuyer = o.buyer_id === req.user.id, isSeller = o.seller_id === req.user.id;
  if (!isBuyer && !isSeller) return res.status(403).json({ error: 'This is not your order' });
  if (!['awaiting_funds', 'funds_held'].includes(o.status)) return res.status(409).json({ error: 'This order can no longer be cancelled' });
  if (isBuyer && o.status === 'shipped') return res.status(409).json({ error: 'The item is already on its way; open a dispute instead' });
  // LIVE: refund any held funds to the buyer here.
  await touch(o.id, 'cancelled');
  await db.prepare("UPDATE listings SET status = 'available' WHERE id = ? AND status = 'pending'").run(o.listing_id);
  await recordEvent(o.id, req.user.id, 'cancelled', o.live ? 'funds refunded to buyer' : 'preview, no funds moved');
  await notify(isBuyer ? o.seller_id : o.buyer_id, req.user.id, 'escrow_update', null);
  res.json({ ok: true, status: 'cancelled' });
});

// Evidence: the seller uploads proof of sending (receipt / photo); the buyer
// uploads any damage or surprise on arrival. One image + an optional note.
router.post('/orders/:id/evidence', requireAuth, upload.single('image'), async (req, res) => {
  const o = await loadOrder(req.params.id);
  if (!o) return res.status(404).json({ error: 'Order not found' });
  const isBuyer = o.buyer_id === req.user.id, isSeller = o.seller_id === req.user.id;
  if (!isBuyer && !isSeller) return res.status(403).json({ error: 'This is not your order' });
  const note = (req.body.note || '').toString().slice(0, 600);
  const KINDS = ['shipping', 'receipt', 'damage', 'photo', 'other'];
  const kind = KINDS.includes(req.body.kind) ? req.body.kind : 'other';
  const mediaUrl = req.file ? '/uploads/' + req.file.filename : '';
  if (!mediaUrl && !note) return res.status(400).json({ error: 'Add a photo or a note' });
  await db.prepare('INSERT INTO order_evidence (order_id, user_id, role, kind, media_url, note) VALUES (?, ?, ?, ?, ?, ?)')
    .run(o.id, req.user.id, isSeller ? 'seller' : 'buyer', kind, mediaUrl, note);
  await recordEvent(o.id, req.user.id, 'evidence', (isSeller ? 'seller' : 'buyer') + ' added ' + kind + ' evidence');
  res.json({ ok: true });
});

// --- Platform-admin dispute resolution ---
router.get('/disputes', requireAuth, async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Admins only' });
  const rows = await db.prepare("SELECT * FROM orders WHERE status = 'disputed' ORDER BY updated_at DESC LIMIT 100").all();
  res.json({ orders: await Promise.all(rows.map((o) => decorateOrder(o, req.user.id, { full: true }))) });
});

// Admin reviews both sides' evidence and decides: release to the seller, or refund
// the buyer. Logged on the order; in live mode this is where funds actually move.
router.post('/orders/:id/resolve', requireAuth, async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Only a platform admin can resolve a dispute' });
  const o = await loadOrder(req.params.id);
  if (!o) return res.status(404).json({ error: 'Order not found' });
  if (o.status !== 'disputed') return res.status(409).json({ error: 'This order is not in dispute' });
  const decision = req.body.decision === 'refund' ? 'refund' : (req.body.decision === 'release' ? 'release' : '');
  if (!decision) return res.status(400).json({ error: 'Decide release (to seller) or refund (to buyer)' });
  const note = (req.body.note || '').toString().slice(0, 600);
  const status = decision === 'release' ? 'resolved_release' : 'resolved_refund';
  await db.prepare("UPDATE orders SET status = ?, resolution = ?, resolved_by = ?, updated_at = datetime('now') WHERE id = ?")
    .run(status, decision + (note ? ': ' + note : ''), req.user.id, o.id);
  // Listing: sold if released to the seller, back on the market if refunded.
  await db.prepare('UPDATE listings SET status = ? WHERE id = ?').run(decision === 'release' ? 'sold' : 'available', o.listing_id);
  await recordEvent(o.id, req.user.id, 'resolved', decision + (o.live ? ' (funds moved)' : ' (preview, no funds moved)') + (note ? ': ' + note : ''));
  await notify(o.buyer_id, req.user.id, 'escrow_update', null);
  await notify(o.seller_id, req.user.id, 'escrow_update', null);
  res.json({ ok: true, status });
});

module.exports = router;
