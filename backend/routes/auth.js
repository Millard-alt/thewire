const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { db } = require('../db');
const { JWT_SECRET, requireAuth, requireEditor } = require('../middleware/auth');
const asyncHandler = require('../lib/asyncHandler');

const router = express.Router();

router.post('/login', asyncHandler(async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }
  const user = await db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim());
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Incorrect username or password.' });
  }
  const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '12h' });
  res.json({
    token, id: user.id, role: user.role, name: user.name,
    username: user.username, portrait_status: user.portrait_status, portrait_url: user.portrait_photo_url || ''
  });
}));

/* Current user profile — lets the frontend know whether the portrait setup step is done. */
router.get('/me', requireAuth, (req, res) => {
  res.json({
    id: req.user.id, name: req.user.name, username: req.user.username,
    role: req.user.role, portrait_status: req.user.portrait_status, portrait_url: req.user.portrait_photo_url || ''
  });
});

/* Editor sets their self-portrait (uploaded to /upload first). Marks it pending Owner review. */
router.put('/me/portrait', requireAuth, requireEditor, asyncHandler(async (req, res) => {
  const { portrait_url } = req.body || {};
  if (!portrait_url || typeof portrait_url !== 'string' || !portrait_url.trim()) {
    return res.status(400).json({ error: 'A portrait URL is required.' });
  }
  await db.prepare('UPDATE users SET portrait_photo_url = ?, portrait_status = ? WHERE id = ?')
    .run(portrait_url.trim(), 'pending', req.user.id);
  res.json({ portrait_status: 'pending', portrait_url: portrait_url.trim() });
}));

module.exports = router;
