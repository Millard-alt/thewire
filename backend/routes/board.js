const express = require('express');
const { db } = require('../db');
const { requireAuth, requireAssignmentManager } = require('../middleware/auth');
const asyncHandler = require('../lib/asyncHandler');

const router = express.Router();

/* Ordinary editors can view the board, but only the Owner / an Assignment
   Manager can add, edit or remove items. */
const MUTATION = [requireAuth, requireAssignmentManager];

router.get('/manage', requireAuth, asyncHandler(async (req, res) => {
  const rows = await db.prepare('SELECT * FROM calendar ORDER BY sort_order ASC, id ASC').all();
  res.json(rows.map((c) => ({
    id: c.id, date: c.date, mon: c.mon, title: c.title, time: c.time || '',
    tag: c.tag || '', notes: c.notes || '', sort_order: c.sort_order
  })));
}));

router.post('/', MUTATION, asyncHandler(async (req, res) => {
  const { date, mon, title, time, tag, notes } = req.body || {};
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'A title is required.' });

  const maxRow = await db.prepare('SELECT MAX(sort_order) AS m FROM calendar').get();
  const next = (maxRow && Number(maxRow.m) ? Number(maxRow.m) : 0) + 1;

  const info = await db.prepare(
    'INSERT INTO calendar (date, mon, title, time, tag, notes, sort_order) VALUES (?,?,?,?,?,?,?)'
  ).run(
    String(date === undefined || date === null ? '' : date).trim() || '-',
    String(mon === undefined || mon === null ? '' : mon).trim() || '···',
    String(title).trim(),
    String(time || '').trim(),
    String(tag || '').trim(),
    String(notes || '').trim(),
    next
  );
  res.status(201).json({ id: info.lastInsertRowid });
}));

router.patch('/:id', MUTATION, asyncHandler(async (req, res) => {
  const item = await db.prepare('SELECT * FROM calendar WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Board item not found.' });

  const { date, mon, title, time, tag, notes } = req.body || {};
  const pick = (v, fallback) => (v === undefined || v === null ? fallback : String(v).trim());

  await db.prepare('UPDATE calendar SET date=?, mon=?, title=?, time=?, tag=?, notes=? WHERE id=?').run([
    pick(date, String(item.date || '')),
    pick(mon, String(item.mon || '')),
    pick(title, String(item.title || '')),
    pick(time, String(item.time || '')),
    pick(tag, String(item.tag || '')),
    pick(notes, String(item.notes || '')),
    item.id
  ]);
  res.json({ id: Number(item.id) });
}));

router.delete('/:id', MUTATION, asyncHandler(async (req, res) => {
  const info = await db.prepare('DELETE FROM calendar WHERE id = ?').run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'Board item not found.' });
  res.status(204).end();
}));

module.exports = router;
