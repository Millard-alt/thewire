const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const { requireAuth, requireOwner } = require('../middleware/auth');
const asyncHandler = require('../lib/asyncHandler');

const router = express.Router();

/* Owner-only management for staff accounts. */
router.use(requireAuth, requireOwner);

router.get('/', asyncHandler(async (req, res) => {
  const rows = await db.prepare(
    `SELECT id, name, username, role, portrait_status, portrait_photo_url FROM users
     WHERE role != 'owner' ORDER BY name ASC`
  ).all();
  res.json(rows.map((u) => ({
    id: u.id, name: u.name, username: u.username, role: u.role,
    portrait_status: u.portrait_status || 'none', portrait_url: u.portrait_photo_url || ''
  })));
}));

/* The Owner creates the account *and* chooses the password, so a new editor can
   log in immediately and then set up their self-portrait. */
router.post('/', asyncHandler(async (req, res) => {
  const { name, username, password } = req.body || {};
  if (!name || !username || !password) {
    return res.status(400).json({ error: 'Name, username and password are all required.' });
  }
  const cleanUser = String(username).trim();
  if (String(password).length < 6) {
    return res.status(400).json({ error: 'Use a password of at least 6 characters.' });
  }

  const existing = await db.prepare('SELECT id FROM users WHERE username = ?').get(cleanUser);
  if (existing) return res.status(409).json({ error: 'That username is already taken.' });

  const hash = bcrypt.hashSync(String(password), 10);
  const info = await db.prepare(
    `INSERT INTO users (name, username, password_hash, role, portrait_status) VALUES (?,?,?,'editor','none')`
  ).run(String(name).trim(), cleanUser, hash);

  res.status(201).json({ id: info.lastInsertRowid, name: String(name).trim(), username: cleanUser, role: 'editor' });
}));

/* Toggle the Assignment Manager role on/off for an editor. */
router.patch('/:id/role', asyncHandler(async (req, res) => {
  const { role } = req.body || {};
  if (!['editor', 'assignment_manager'].includes(role)) {
    return res.status(400).json({ error: 'Role must be "editor" or "assignment_manager".' });
  }
  const user = await db.prepare(`SELECT * FROM users WHERE id = ? AND role != 'owner'`).get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Editor account not found.' });

  await db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, user.id);
  res.json({ id: user.id, role });
}));

/* Owner approves or rejects an editor's self-portrait. */
router.patch('/:id/portrait', asyncHandler(async (req, res) => {
  const { action } = req.body || {};
  if (!['approve', 'reject'].includes(action)) {
    return res.status(400).json({ error: 'action must be "approve" or "reject".' });
  }
  const user = await db.prepare(`SELECT * FROM users WHERE id = ? AND role != 'owner'`).get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Editor account not found.' });

  const portrait_status = action === 'approve' ? 'approved' : 'rejected';
  await db.prepare('UPDATE users SET portrait_status = ? WHERE id = ?').run(portrait_status, user.id);
  res.json({ id: user.id, portrait_status });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const user = await db.prepare(`SELECT * FROM users WHERE id = ? AND role != 'owner'`).get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Editor account not found.' });

  // Keep the published archive intact: unattach their byline rows before removal.
  await db.prepare('UPDATE articles SET submitted_by = NULL WHERE submitted_by = ?').run(user.id);
  await db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
  res.status(204).end();
}));

module.exports = router;
