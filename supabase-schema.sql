-- ============================================================================
-- The Wire — Supabase (Postgres) schema
-- Run this in the Supabase Dashboard → SQL Editor → New query, in a FRESH
-- database. Every table mirrors the built-in SQLite storage so the app works
-- exactly the same when it points at Supabase.
-- ============================================================================

-- ---------- Staff (editors + assignment managers + owner) ----------
CREATE TABLE IF NOT EXISTS users (
  id                 BIGSERIAL PRIMARY KEY,
  name               TEXT NOT NULL,
  username           TEXT NOT NULL UNIQUE,
  password_hash      TEXT NOT NULL,
  role               TEXT NOT NULL DEFAULT 'editor'
                     CHECK (role IN ('editor','assignment_manager','owner')),
  portrait_photo_url TEXT,
  portrait_status    TEXT NOT NULL DEFAULT 'none'
                     CHECK (portrait_status IN ('none','pending','approved','rejected')),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Articles / submissions ----------
CREATE TABLE IF NOT EXISTS articles (
  id           BIGSERIAL PRIMARY KEY,
  placement    TEXT NOT NULL DEFAULT 'feed'
               CHECK (placement IN ('feed','week_article','week_event','week_picture')),
  status       TEXT NOT NULL DEFAULT 'published'
               CHECK (status IN ('pending','published','rejected')),
  kind         TEXT NOT NULL DEFAULT 'article' CHECK (kind IN ('article','photo','event')),
  kicker       TEXT,
  tag          TEXT,
  fallback_tag TEXT,                 -- where a featured item drops when cycled out
  title        TEXT NOT NULL,
  author       TEXT,
  portrait_url TEXT,                 -- byline photo snapshot for the reader chip
  time         TEXT,
  dek          TEXT,
  cap          TEXT,
  body         JSONB,                -- array of paragraphs
  photo_url    TEXT,
  submitted_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Legacy masthead fallback (used until editor portraits are approved) ----------
CREATE TABLE IF NOT EXISTS team (
  id         BIGSERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  role       TEXT,
  body       JSONB,
  photo_url  TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- ---------- Assignment board ----------
CREATE TABLE IF NOT EXISTS calendar (
  id         BIGSERIAL PRIMARY KEY,
  date       TEXT NOT NULL,
  mon        TEXT NOT NULL,
  title      TEXT NOT NULL,
  time       TEXT,
  tag        TEXT,
  notes      TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Key/value settings ----------
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- ---------- Editorial categories ----------
CREATE TABLE IF NOT EXISTS categories (
  id   BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

-- ---------- Homepage credits (Owner-managed) ----------
CREATE TABLE IF NOT EXISTS credits (
  id         BIGSERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  role       TEXT,
  photo_url  TEXT,
  sort_order INTEGER DEFAULT 0
);

-- ---------- Top Performers (Owner-managed) ----------
CREATE TABLE IF NOT EXISTS top_performers (
  id         BIGSERIAL PRIMARY KEY,
  author     TEXT NOT NULL UNIQUE,
  score      INTEGER DEFAULT 1,
  sort_order INTEGER DEFAULT 0,
  photo_url  TEXT,
  blurb      TEXT
);

-- ---------- Weekly rotation bookkeeping ----------
CREATE TABLE IF NOT EXISTS weekly_rotation (
  id         BIGSERIAL PRIMARY KEY,
  slot       TEXT NOT NULL UNIQUE,
  article_id BIGINT,
  picked_at  TIMESTAMPTZ
);

-- ---------- Today's Pick (singleton row; owner can pin it) ----------
CREATE TABLE IF NOT EXISTS todays_pick (
  id         BIGINT PRIMARY KEY CHECK (id = 1),
  article_id BIGINT,
  picked_at  TIMESTAMPTZ,
  pinned     INTEGER DEFAULT 0
);

-- ---------- Seed (run ONCE, only on an empty database) ----------
INSERT INTO categories (name) VALUES
  ('Campus News'),('Sports & Scores'),('Opinion & Culture'),('Photo Essays'),
  ('Music & Arts'),('Science & Tech'),('Community'),('Editorials')
ON CONFLICT (name) DO NOTHING;

INSERT INTO settings (key, value) VALUES
  ('edition_line','VOL. 1 · NO. 14'),
  ('breaking_enabled','1'),
  ('breaking_text','Robotics team confirmed for Saturday''s regional qualifier — first bid in four years.'),
  ('forced_notifications','0'),
  ('one_signal_app_id','')
ON CONFLICT (key) DO NOTHING;