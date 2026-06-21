// routes/albums.js
// Photo albums. Albums and their photos are visible to the owner and accepted
// friends, matching the post privacy model.

const express = require('express');
const db = require('../db');
const { requireAuth, publicUser } = require('../auth');
const { upload } = require('../upload');

const router = express.Router();

function canSee(viewerId, ownerId) {
  if (viewerId === ownerId) return true;
  return !!db
    .prepare(
      "SELECT 1 FROM friendships WHERE status = 'accepted' AND ((requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?))"
    )
    .get(viewerId, ownerId, ownerId, viewerId);
}

function decorateAlbum(a) {
  const photoCount = db.prepare('SELECT COUNT(*) c FROM album_photos WHERE album_id = ?').get(a.id).c;
  const cover = db
    .prepare('SELECT image FROM album_photos WHERE album_id = ? ORDER BY id DESC LIMIT 1')
    .get(a.id);
  return {
    id: a.id,
    title: a.title,
    created_at: a.created_at,
    user_id: a.user_id,
    photoCount,
    cover: cover ? cover.image : '',
  };
}

// A user's albums (owner or accepted friend only).
router.get('/user/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!canSee(req.user.id, id)) return res.json({ albums: [], locked: true });
  const rows = db
    .prepare('SELECT * FROM albums WHERE user_id = ? ORDER BY created_at DESC, id DESC')
    .all(id);
  res.json({ albums: rows.map(decorateAlbum), locked: false });
});

// Create an album.
router.post('/', requireAuth, (req, res) => {
  const title = (req.body.title || '').trim();
  if (!title) return res.status(400).json({ error: 'An album title is required' });
  const info = db.prepare('INSERT INTO albums (user_id, title) VALUES (?, ?)').run(req.user.id, title);
  const a = db.prepare('SELECT * FROM albums WHERE id = ?').get(info.lastInsertRowid);
  res.json({ album: decorateAlbum(a) });
});

// One album with its photos.
router.get('/:id', requireAuth, (req, res) => {
  const a = db.prepare('SELECT * FROM albums WHERE id = ?').get(Number(req.params.id));
  if (!a) return res.status(404).json({ error: 'Album not found' });
  if (!canSee(req.user.id, a.user_id)) {
    return res.status(403).json({ error: 'This album is shared with friends only' });
  }
  const photos = db
    .prepare('SELECT * FROM album_photos WHERE album_id = ? ORDER BY created_at ASC, id ASC')
    .all(a.id);
  const owner = db.prepare('SELECT * FROM users WHERE id = ?').get(a.user_id);
  res.json({
    album: {
      id: a.id,
      title: a.title,
      created_at: a.created_at,
      owner: publicUser(owner),
      isMine: a.user_id === req.user.id,
    },
    photos: photos.map((p) => ({ id: p.id, image: p.image, caption: p.caption, created_at: p.created_at })),
  });
});

// Add a photo to an album (owner only).
router.post('/:id/photos', requireAuth, upload.single('image'), (req, res) => {
  const a = db.prepare('SELECT * FROM albums WHERE id = ?').get(Number(req.params.id));
  if (!a) return res.status(404).json({ error: 'Album not found' });
  if (a.user_id !== req.user.id) return res.status(403).json({ error: 'You can only add to your own albums' });
  if (!req.file) return res.status(400).json({ error: 'Choose a photo to add' });
  const caption = (req.body.caption || '').trim();
  const info = db
    .prepare('INSERT INTO album_photos (album_id, image, caption) VALUES (?, ?, ?)')
    .run(a.id, '/uploads/' + req.file.filename, caption);
  const p = db.prepare('SELECT * FROM album_photos WHERE id = ?').get(info.lastInsertRowid);
  res.json({ photo: { id: p.id, image: p.image, caption: p.caption, created_at: p.created_at } });
});

// Delete a single photo (owner only).
router.delete('/:id/photos/:photoId', requireAuth, (req, res) => {
  const a = db.prepare('SELECT * FROM albums WHERE id = ?').get(Number(req.params.id));
  if (!a) return res.status(404).json({ error: 'Album not found' });
  if (a.user_id !== req.user.id) return res.status(403).json({ error: 'This is not your album' });
  db.prepare('DELETE FROM album_photos WHERE id = ? AND album_id = ?').run(Number(req.params.photoId), a.id);
  res.json({ ok: true });
});

// Delete an album and its photos (owner only).
router.delete('/:id', requireAuth, (req, res) => {
  const a = db.prepare('SELECT * FROM albums WHERE id = ?').get(Number(req.params.id));
  if (!a) return res.status(404).json({ error: 'Album not found' });
  if (a.user_id !== req.user.id) return res.status(403).json({ error: 'This is not your album' });
  db.prepare('DELETE FROM albums WHERE id = ?').run(a.id);
  res.json({ ok: true });
});

module.exports = router;
