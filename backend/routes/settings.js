const express = require('express');
const { db, getSetting } = require('../db');
const { requireAuth, requireOwner } = require('../middleware/auth');
const asyncHandler = require('../lib/asyncHandler');

const router = express.Router();

/* Whitelisted settings keys the Owner is allowed to change. */
const ALLOWED_KEYS = [
  'edition_line',
  'breaking_enabled',
  'breaking_text',
  'forced_notifications',
  'one_signal_app_id'
];

/* GET /api/settings — current values (Owner only). */
router.get('/', requireAuth, requireOwner, asyncHandler(async (req, res) => {
  const rows = await db.prepare('SELECT key, value FROM settings').all();
  const out = {};
  for (const r of rows) {
    if (r.key === 'forced_notifications' || r.key === 'breaking_enabled') {
      out[r.key] = r.value === '1' || r.value === 'true' || r.value === true;
    } else {
      out[r.key] = r.value;
    }
  }
  res.json(out);
}));

/* PUT /api/settings — save any subset of whitelisted keys (Owner only). */
router.put('/', requireAuth, requireOwner, asyncHandler(async (req, res) => {
  const body = req.body || {};
  for (const [k, v] of Object.entries(body)) {
    if (!ALLOWED_KEYS.includes(k)) continue;
    const value = v === true ? '1' : v === false ? '0' : String(v == null ? '' : v);
    const existing = await db.prepare('SELECT key FROM settings WHERE key = ?').get(k);
    if (existing) {
      await db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(value, k);
    } else {
      await db.prepare('INSERT INTO settings(key, value) VALUES (?,?)').run(k, value);
    }
  }
  const rows = await db.prepare('SELECT key, value FROM settings').all();
  const out = {};
  for (const r of rows) {
    if (r.key === 'forced_notifications' || r.key === 'breaking_enabled') {
      out[r.key] = r.value === '1' || r.value === 'true' || r.value === true;
    } else {
      out[r.key] = r.value;
    }
  }
  res.json(out);
}));

/* ---- Categories (Owner-managed) ---- */

router.get('/categories', requireAuth, requireOwner, asyncHandler(async (req, res) => {
  res.json(await db.prepare('SELECT id, name FROM categories ORDER BY name ASC').all());
}));

router.post('/categories', requireAuth, requireOwner, asyncHandler(async (req, res) => {
  const name = String((req.body || {}).name || '').trim();
  if (!name) return res.status(400).json({ error: 'Category name is required.' });
  const dup = await db.prepare('SELECT id FROM categories WHERE name = ?').get(name);
  if (dup) return res.status(409).json({ error: 'That category already exists.' });
  const r = await db.prepare('INSERT INTO categories(name) VALUES (?)').run(name);
  res.status(201).json({ id: r.lastInsertRowid, name });
}));

router.delete('/categories/:id', requireAuth, requireOwner, asyncHandler(async (req, res) => {
  await db.prepare('DELETE FROM categories WHERE id = ?').run(req.params.id);
  res.status(204).end();
}));

/* ---- Credits (Owner-managed) ---- */

router.get('/credits', requireAuth, requireOwner, asyncHandler(async (req, res) => {
  res.json(await db.prepare('SELECT * FROM credits ORDER BY sort_order ASC, id ASC').all());
}));

router.post('/credits', requireAuth, requireOwner, asyncHandler(async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name is required.' });
  const photo = String(b.photo_url || b.image_url || '').trim();
  const r = await db.prepare('INSERT INTO credits(name, role, photo_url, sort_order) VALUES (?,?,?,?)')
    .run(name, String(b.role || ''), photo, Number(b.sort_order) || 0);
  res.status(201).json({ id: r.lastInsertRowid, name, role: b.role || '', photo_url: photo });
}));

router.put('/credits/:id', requireAuth, requireOwner, asyncHandler(async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name is required.' });
  const photo = String(b.photo_url || b.image_url || '').trim();
  await db.prepare('UPDATE credits SET name = ?, role = ?, photo_url = ?, sort_order = ? WHERE id = ?')
    .run(name, String(b.role || ''), photo, Number(b.sort_order) || 0, req.params.id);
  res.json({ id: Number(req.params.id), name, role: b.role || '', photo_url: photo });
}));

router.delete('/credits/:id', requireAuth, requireOwner, asyncHandler(async (req, res) => {
  await db.prepare('DELETE FROM credits WHERE id = ?').run(req.params.id);
  res.status(204).end();
}));

/* ---- Top Performers (Owner-managed) ---- */

router.get('/performers', requireAuth, requireOwner, asyncHandler(async (req, res) => {
  res.json(await db.prepare('SELECT * FROM top_performers ORDER BY sort_order ASC, id ASC').all());
}));

router.post('/performers', requireAuth, requireOwner, asyncHandler(async (req, res) => {
  const b = req.body || {};
  const author = String(b.author || b.name || '').trim();
  if (!author) return res.status(400).json({ error: 'Name is required.' });
  const photo_url = String(b.photo_url || b.image_url || '').trim();
  const blurb = String(b.blurb || '').trim();
  const r = await db.prepare('INSERT INTO top_performers(author, score, sort_order, photo_url, blurb) VALUES (?,?,?,?,?)')
    .run(author, Number(b.score) || 1, Number(b.sort_order) || 0, photo_url, blurb);
  res.status(201).json({ id: r.lastInsertRowid, author, score: Number(b.score) || 1, photo_url, blurb });
}));

router.put('/performers/:id', requireAuth, requireOwner, asyncHandler(async (req, res) => {
  const b = req.body || {};
  const author = String(b.author || b.name || '').trim();
  if (!author) return res.status(400).json({ error: 'Name is required.' });
  const photo_url = String(b.photo_url || b.image_url || '').trim();
  const blurb = String(b.blurb || '').trim();
  await db.prepare('UPDATE top_performers SET author = ?, score = ?, sort_order = ?, photo_url = ?, blurb = ? WHERE id = ?')
    .run(author, Number(b.score) || 1, Number(b.sort_order) || 0, photo_url, blurb, req.params.id);
  res.json({ id: Number(req.params.id), author, score: Number(b.score) || 1, photo_url, blurb });
}));

router.delete('/performers/:id', requireAuth, requireOwner, asyncHandler(async (req, res) => {
  await db.prepare('DELETE FROM top_performers WHERE id = ?').run(req.params.id);
  res.status(204).end();
}));

module.exports = router;
