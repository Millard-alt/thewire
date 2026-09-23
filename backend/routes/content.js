const express = require('express');
const { db, DEFAULT_CATEGORIES } = require('../db');
const { requireAuth, requireOwner } = require('../middleware/auth');
const asyncHandler = require('../lib/asyncHandler');

const router = express.Router();

/* body is TEXT on both backends; tolerate an already-parsed array too. */
function toParagraphs(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  try { return JSON.parse(value); } catch (e) { return []; }
}

function rowToArticle(row) {
  if (!row) return null;
  return {
    id: row.id,
    kicker: row.kicker || undefined,
    tag: row.tag || '',
    placement: row.placement || 'feed',
    title: row.title,
    author: row.author || '',
    portrait_url: row.portrait_url || '',
    time: row.time || '',
    dek: row.dek || undefined,
    cap: row.cap || undefined,
    body: toParagraphs(row.body),
    photo_url: row.photo_url || ''
  };
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/* Rotate every week: featured pieces move to the feed under their secondary
   category and the slots become empty until the next approval fills them. */
async function rotateWeeklyIfNeeded() {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'week_rotated_at'").get();
  const last = row ? Number(row.value) || 0 : 0;
  if (Date.now() - last < WEEK_MS) return;

  const stale = await db.prepare(
    `SELECT id, fallback_tag FROM articles
     WHERE status = 'published' AND placement IN ('week_article','week_event','week_picture')`
  ).all();
  for (const a of stale) {
    await db.prepare(`UPDATE articles SET placement = 'feed', kicker = NULL,
        tag = COALESCE(NULLIF(fallback_tag, ''), tag) WHERE id = ?`).run(a.id);
  }
  await db.prepare(`INSERT INTO settings(key, value) VALUES ('week_rotated_at', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(Date.now()));
}

/* Today's Pick: normally one random published story per calendar day, unless
   the Owner has pinned a specific article — then it sticks until unpinned. */
async function todaysPick() {
  const today = new Date().toISOString().slice(0, 10);
  const saved = await db.prepare("SELECT * FROM todays_pick LIMIT 1").get();

  if (saved && saved.pinned && saved.article_id) {
    const a = await db.prepare(`SELECT * FROM articles WHERE id = ? AND status = 'published'`).get(saved.article_id);
    if (a) return rowToArticle(a);
    // Pinned article no longer exists/published — fall through to random pick below.
  }

  if (saved && !saved.pinned && saved.picked_at === today && saved.article_id) {
    const a = await db.prepare(`SELECT * FROM articles WHERE id = ? AND status = 'published'`).get(saved.article_id);
    if (a) return rowToArticle(a);
  }

  const pool = await db.prepare(
    `SELECT * FROM articles WHERE status = 'published' AND placement = 'feed' ORDER BY RANDOM() LIMIT 1`
  ).get();
  if (!pool) return null;
  if (saved) {
    await db.prepare('UPDATE todays_pick SET article_id = ?, picked_at = ?, pinned = 0 WHERE id = 1')
      .run(pool.id, today);
  } else {
    await db.prepare('INSERT INTO todays_pick(article_id, picked_at, pinned) VALUES (?,?,0)').run(pool.id, today);
  }
  return rowToArticle(pool);
}

/* Owner: published feed articles they can choose from, plus current pin state. */
router.get('/pick', requireAuth, requireOwner, asyncHandler(async (req, res) => {
  const candidates = await db.prepare(
    `SELECT id, title, tag, author FROM articles WHERE status = 'published' AND placement = 'feed' ORDER BY created_at DESC, id DESC`
  ).all();
  const saved = await db.prepare('SELECT * FROM todays_pick LIMIT 1').get();
  res.json({
    candidates,
    pinned: !!(saved && saved.pinned),
    article_id: saved ? saved.article_id : null
  });
}));

/* Owner: lock Today's Pick to a specific article. */
router.post('/pick', requireAuth, requireOwner, asyncHandler(async (req, res) => {
  const articleId = Number((req.body || {}).article_id);
  if (!articleId) return res.status(400).json({ error: 'article_id is required.' });
  const a = await db.prepare(`SELECT id FROM articles WHERE id = ? AND status = 'published'`).get(articleId);
  if (!a) return res.status(404).json({ error: 'That article is not published.' });

  const today = new Date().toISOString().slice(0, 10);
  const saved = await db.prepare('SELECT * FROM todays_pick LIMIT 1').get();
  if (saved) {
    await db.prepare('UPDATE todays_pick SET article_id = ?, picked_at = ?, pinned = 1 WHERE id = 1').run(articleId, today);
  } else {
    await db.prepare('INSERT INTO todays_pick(article_id, picked_at, pinned) VALUES (?,?,1)').run(articleId, today);
  }
  res.json({ ok: true, article_id: articleId, pinned: true });
}));

/* Owner: release the pin — Today's Pick goes back to rotating randomly. */
router.delete('/pick', requireAuth, requireOwner, asyncHandler(async (req, res) => {
  const saved = await db.prepare('SELECT * FROM todays_pick LIMIT 1').get();
  if (saved) await db.prepare('UPDATE todays_pick SET pinned = 0 WHERE id = 1').run();
  res.json({ ok: true, pinned: false });
}));

router.get('/', asyncHandler(async (req, res) => {
  await rotateWeeklyIfNeeded();

  const latestByPlacement = (placement) =>
    db.prepare(`SELECT * FROM articles WHERE placement = ? AND status = 'published' ORDER BY created_at DESC, id DESC LIMIT 1`)
      .get(placement);

  const week = {
    article: rowToArticle(await latestByPlacement('week_article')),
    event: rowToArticle(await latestByPlacement('week_event')),
    picture: rowToArticle(await latestByPlacement('week_picture'))
  };

  const feedRows = await db.prepare(`SELECT * FROM articles WHERE placement = 'feed' AND status = 'published' ORDER BY created_at DESC, id DESC`).all();
  const feed = feedRows.map(rowToArticle);
  const pick = await todaysPick();

  /* Masthead: approved portraits first; legacy team seed as demo fallback. */
  const portraitMast = await db.prepare(
    `SELECT id, name, portrait_photo_url, role FROM users
     WHERE role != 'owner' AND portrait_status = 'approved' ORDER BY name ASC`
  ).all();
  const teamFallback = await db.prepare('SELECT * FROM team ORDER BY sort_order ASC, id ASC').all();
  let team;
  if (portraitMast.length) {
    team = portraitMast.map((t) => ({
      id: t.id,
      name: t.name, role: t.role === 'assignment_manager' ? 'Assignment Manager' : 'Editor',
      body: [], photo_url: t.portrait_photo_url || ''
    }));
  } else {
    team = teamFallback.map((t) => ({
      id: t.id,
      name: t.name, role: t.role || '', body: toParagraphs(t.body), photo_url: t.photo_url || ''
    }));
  }

  const calendarRows = await db.prepare('SELECT * FROM calendar ORDER BY sort_order ASC, id ASC').all();
  const calendar = calendarRows.map((c) => ({
    id: c.id, date: c.date, mon: c.mon, title: c.title, time: c.time || '', tag: c.tag || '', notes: c.notes || ''
  }));

  const settingsRows = await db.prepare('SELECT * FROM settings').all();
  const settings = Object.fromEntries(settingsRows.map((s) => [s.key, s.value]));

  const catRows = await db.prepare('SELECT name FROM categories ORDER BY name ASC').all();
  const cats = catRows.length ? catRows.map((c) => c.name) : DEFAULT_CATEGORIES;

  const performerRows = await db.prepare('SELECT * FROM top_performers ORDER BY sort_order ASC, id ASC').all();
  const performers = performerRows.map((p) => ({
    id: p.id, name: p.name || p.author || '', photo_url: p.photo_url || p.image_url || '',
    articles: Number(p.articles != null ? p.articles : p.score) || 0, blurb: p.blurb || ''
  }));

  const creditRows = await db.prepare('SELECT * FROM credits ORDER BY sort_order ASC, id ASC').all();
  const credits = creditRows.map((c) => ({
    id: c.id, name: c.name || '', role: c.role || '', image_url: c.image_url || c.photo_url || '',
    photo_url: c.photo_url || c.image_url || ''
  }));

  res.json({
    breaking: settings.breaking_enabled === '1' || settings.breaking_enabled === 'true',
    breakingText: settings.breaking_text || '',
    editionLine: settings.edition_line || '',
    forcedNotifications: settings.forced_notifications === '1' || settings.forced_notifications === 'true',
    onesignalAppId: settings.one_signal_app_id || process.env.ONESIGNAL_APP_ID || '',
    week,
    pick,
    feed,
    team,
    calendar,
    performers,
    credits,
    tabs: ['All', ...cats]
  });
}));

module.exports = router;
