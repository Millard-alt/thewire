const express = require('express');
const { db } = require('../db');
const { requireAuth, requireOwner, requireEditor, requireApprovedPortrait } = require('../middleware/auth');
const asyncHandler = require('../lib/asyncHandler');

const router = express.Router();

const WEEK_PLACEMENTS = ['week_article', 'week_event', 'week_picture'];
const VALID_PLACEMENTS = [...WEEK_PLACEMENTS, 'feed'];
const VALID_KINDS = ['article', 'photo', 'event'];

const KICKER_BY_PLACEMENT = {
  week_article: 'Article of the Week',
  week_event: 'Event of the Week',
  week_picture: 'Picture of the Week'
};

function toParagraphs(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  try { return JSON.parse(value); } catch (e) { return []; }
}

/* ------------------------------------------------------ editor submissions --- */

/* An editor's own submissions, newest first. */
router.get('/mine', requireAuth, requireEditor, asyncHandler(async (req, res) => {
  const rows = await db.prepare(
    `SELECT id, title, status, kind, placement, tag, fallback_tag, created_at
     FROM articles WHERE submitted_by = ? ORDER BY id DESC`
  ).all(req.user.id);
  res.json(rows);
}));

/* Submit an article / photo / event. Always lands as `pending` — the public site
   shows nothing until the Owner approves it. */
router.post('/', requireAuth, requireEditor, requireApprovedPortrait, asyncHandler(async (req, res) => {
  const b = req.body || {};
  const title = String(b.title || '').trim();
  if (!title) return res.status(400).json({ error: 'A title is required.' });

  const kind = VALID_KINDS.includes(b.kind) ? b.kind : 'article';
  let placement = VALID_PLACEMENTS.includes(b.placement) ? b.placement : 'feed';
  // Keep the slot and the medium consistent: a photo belongs in the picture slot.
  if (placement === 'week_article' && kind === 'photo') placement = 'week_picture';
  if (placement === 'week_picture' && kind !== 'photo') placement = 'week_article';

  const tag = String(b.tag || '').trim() || 'Campus News';
  let fallback = String(b.fallback_tag || '').trim();
  if (WEEK_PLACEMENTS.includes(placement) && !fallback) {
    return res.status(400).json({ error: 'Weekly features need a second category to fall back into.' });
  }
  if (placement === 'feed') fallback = '';

  const body = Array.isArray(b.body) ? b.body.map((s) => String(s)) : toParagraphs(b.body);
  const photoUrl = String(b.photo_url || '').trim() || null;
  // The portrait was approved before we got here, so snapshot it for the byline chip.
  const portraitUrl = req.user.portrait_photo_url || null;

  const info = await db.prepare(
    `INSERT INTO articles(placement, status, kind, kicker, tag, fallback_tag, title, author, portrait_url, time, dek, cap, body, photo_url, submitted_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run([
    placement, 'pending', kind, KICKER_BY_PLACEMENT[placement] || null,
    tag, fallback, title, req.user.name, portraitUrl,
    String(b.time || '').trim(), String(b.dek || '').trim() || null,
    String(b.cap || '').trim() || null, JSON.stringify(body), photoUrl, req.user.id
  ]);

  res.json({ ok: true, id: info.lastInsertRowid, status: 'pending' });
}));

/* ------------------------------------------------------------ Owner review --- */

router.get('/', requireAuth, requireOwner, asyncHandler(async (req, res) => {
  const portraits = await db.prepare(
    `SELECT id, name, username, role, portrait_photo_url, portrait_status
     FROM users WHERE role != 'owner' AND portrait_status = 'pending' ORDER BY id ASC`
  ).all();

  const rows = await db.prepare(
    `SELECT a.id, a.kind, a.title, a.placement, a.tag, a.fallback_tag, a.status,
            a.body, a.photo_url, a.dek, a.cap, u.name AS submitted_by_name
     FROM articles a LEFT JOIN users u ON u.id = a.submitted_by
     WHERE a.status = 'pending' ORDER BY a.id ASC`
  ).all();

  res.json({
    portraits,
    articles: rows.map((a) => ({ ...a, body: toParagraphs(a.body) }))
  });
}));

/* Approve or reject a submission. Approving into a weekly slot rotates the
   outgoing piece down into the feed under its secondary category. */
router.patch('/:id', requireAuth, requireOwner, asyncHandler(async (req, res) => {
  const action = (req.body && req.body.action) || '';
  if (!['approve', 'reject'].includes(action)) {
    return res.status(400).json({ error: "action must be 'approve' or 'reject'." });
  }

  const article = await db.prepare('SELECT * FROM articles WHERE id = ?').get(req.params.id);
  if (!article) return res.status(404).json({ error: 'That submission does not exist.' });

  if (action === 'reject') {
    await db.prepare("UPDATE articles SET status = 'rejected' WHERE id = ?").run(article.id);
    return res.json({ ok: true, id: article.id, status: 'rejected' });
  }

  let cycledOut = null;

  if (WEEK_PLACEMENTS.includes(article.placement)) {
    const current = await db.prepare(
      `SELECT * FROM articles WHERE placement = ? AND status = 'published' AND id != ? ORDER BY id DESC LIMIT 1`
    ).get(article.placement, article.id);

    if (current) {
      // The outgoing weekly piece drops into the feed under its secondary category.
      // Written with CASE rather than NULLIF() so the same SQL runs unchanged on
      // both SQLite and Postgres.
      await db.prepare(
        `UPDATE articles SET placement = 'feed', kicker = NULL,
           tag = CASE WHEN fallback_tag IS NULL OR fallback_tag = '' THEN tag ELSE fallback_tag END
         WHERE id = ?`
      ).run(current.id);
      cycledOut = { id: current.id, title: current.title, tag: current.fallback_tag || current.tag };
    }
  }

  await db.prepare("UPDATE articles SET status = 'published', kicker = ? WHERE id = ?")
    .run(KICKER_BY_PLACEMENT[article.placement] || null, article.id);

  res.json({ ok: true, id: article.id, status: 'published', cycledOut });
}));

/* Owner: manually retire the current piece in a weekly slot (no replacement
   submitted). It drops into the feed under its secondary category. */
router.post('/cycle/:placement', requireAuth, requireOwner, asyncHandler(async (req, res) => {
  const placement = req.params.placement;
  if (!WEEK_PLACEMENTS.includes(placement)) {
    return res.status(400).json({ error: 'Not a weekly slot.' });
  }
  const current = await db.prepare(
    `SELECT * FROM articles WHERE placement = ? AND status = 'published' ORDER BY id DESC LIMIT 1`
  ).get(placement);
  if (!current) return res.status(404).json({ error: 'That slot is already empty.' });

  await db.prepare(
    `UPDATE articles SET placement = 'feed', kicker = NULL,
       tag = CASE WHEN fallback_tag IS NULL OR fallback_tag = '' THEN tag ELSE fallback_tag END
     WHERE id = ?`
  ).run(current.id);

  res.json({ ok: true, cycledOut: { id: current.id, title: current.title, tag: current.fallback_tag || current.tag } });
}));

module.exports = router;
