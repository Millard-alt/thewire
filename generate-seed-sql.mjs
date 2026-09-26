/**
 * Generates supabase/002_seed_content.sql from the canonical seed data in
 * src/lib/seed.js, so the database and demo mode can never drift apart.
 * Run:  node generate-seed-sql.mjs
 */
import { writeFileSync } from 'node:fs';
import { createSeedState } from './src/lib/seed.js';

const state = createSeedState();

/** Escape a JS value into a single-quoted SQL literal. */
function lit(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  // Keep the emitted SQL pure ASCII. A bullet or en-dash inside a string
  // literal survives most editors but can be mangled by a copy/paste into the
  // Supabase SQL editor and, in the worst case, abort the whole transaction.
  return `'${String(value)
    .replace(/[^\x00-\x7F]/g, ' ')
    .replace(/'/g, "''")}'`;
}

/** Render a JSON value as a single-quoted jsonb literal. */
function jsonLit(value) {
  return `'${JSON.stringify(value ?? {}).replace(/'/g, "''")}'::jsonb`;
}

/**
 * Every seeded table uses a `uuid` primary key with a `gen_random_uuid()`
 * default, so the seed text ids ('seed-article-1') must NOT be inserted.
 * Idempotency therefore comes from a natural-key guard instead of ON CONFLICT:
 * we only insert when no row with the same business key already exists.
 */
const rows = (list, columns, get) =>
  list
    .map((item) => `  (${columns.map((c) => lit(get(item, c))).join(', ')})`)
    .join(',\n');

const parts = [];

parts.push(`-- ============================================================================
-- 002_seed_content.sql
-- ----------------------------------------------------------------------------
-- GENERATED FILE - do not hand-edit.
-- Regenerate with:  node generate-seed-sql.mjs
--
-- The publication is currently EMPTY: the articles table has zero rows, so the
-- front page renders nothing while the Owner Control Center has nothing to
-- curate. This inserts the canonical seed content from src/lib/seed.js.
--
-- Everything here is public by design - it is ordinary published news copy, the
-- same data the app shows in demo mode.
--
-- Safe to run more than once. The seeded tables have uuid primary keys, so
-- idempotency comes from a natural-key guard ("only insert if no row already has
-- this title/url/username") rather than ON CONFLICT on a fixed id.
-- ============================================================================

begin;

-- ARTICLES -------------------------------------------------------------------
-- Column mapping: seed 'date' -> published_at, 'image' -> image_url.
-- There is no 'excerpt' column, so it is intentionally not inserted.
insert into public.articles
  (title, author, category, status, published_at, body, image_url, caption, featured)
select
  v.title, v.author, v.category, v.status, v.published_at, v.body,
  v.image_url, v.caption, v.featured
from (values
${rows(state.articles, ['title', 'author', 'category', 'status', 'date', 'body', 'image', 'caption', 'featured'], (a, c) => a[c])}
) as v(title, author, category, status, published_at, body, image_url, caption, featured)
where not exists (
  select 1 from public.articles a where a.title = v.title
);
`);

// Status must be the canonical title case the RLS policy and the UI expect.
parts.push(`
-- The read policy is lower(status) = 'published' and the CHECK constraint
-- accepts either spelling, but normalise to title case so the admin filters,
-- which compare against 'Pending Review' and friends, match cleanly.
update public.articles
   set status = initcap(status)
 where status is not null
    and status <> initcap(status);
`);
parts.push(`
-- ASSIGNMENTS ----------------------------------------------------------------
insert into public.assignments (title, reporter, status, deadline)
select v.title, v.reporter, v.status, v.deadline
from (values
${rows(state.assignments, ['title', 'reporter', 'status', 'deadline'], (a, c) => a[c])}
) as v(title, reporter, status, deadline)
where not exists (
  select 1 from public.assignments a where a.title = v.title
);
`);

parts.push(`
-- STAFF ROSTER ----------------------------------------------------------------
-- Display records only. These are NOT login accounts: real logins live in
-- public.staff_accounts and are created through owner-approved signup.
-- auth_user_id is left null so no roster row is bound to a Supabase Auth
-- identity, and shadow_email is derived to match VITE_AUTH_EMAIL_DOMAIN
-- (users.thewire.press) so is_staff() can match a session later.
insert into public.staff (name, username, shadow_email, email, role, status)
select v.name, v.username,
       v.username || '@users.thewire.press',
       v.email, v.role, v.status
from (values
${rows(state.staff, ['name', 'username', 'email', 'role', 'status'], (s, c) => s[c])}
) as v(name, username, email, role, status)
where not exists (
  select 1 from public.staff s where s.username = v.username
);
`);

parts.push(`
-- TOP PERFORMERS --------------------------------------------------------------
insert into public.top_performers (name, role, articles_count)
select v.name, v.role, v.articles_count
from (values
${rows(state.topPerformers, ['name', 'role', 'articlesCount'], (p, c) => p[c])}
) as v(name, role, articles_count)
where not exists (
  select 1 from public.top_performers p where p.name = v.name
);
`);

parts.push(`
-- MEDIA LIBRARY ---------------------------------------------------------------
insert into public.media_assets (url, caption)
select v.url, v.caption
from (values
${rows(state.mediaLibrary, ['url', 'caption'], (m, c) => m[c])}
) as v(url, caption)
where not exists (
  select 1 from public.media_assets m where m.url = v.url
);
`);

parts.push(`
-- BROADCASTS ------------------------------------------------------------------
insert into public.broadcasts (title, message, audience, delivered_count)
select v.title, v.message, v.audience, v.delivered
from (values
${rows(state.notifications.history, ['title', 'message', 'audience', 'delivered'], (b, c) => b[c])}
) as v(title, message, audience, delivered)
where not exists (
  select 1 from public.broadcasts b where b.title = v.title
);
`);

parts.push(`
-- AUDIT LOG -------------------------------------------------------------------
-- actor_id references auth.users, so it is left null for system entries.
insert into public.audit_logs (actor_name, action)
select v.actor_name, v.action
from (values
${rows(state.auditLogs, ['user', 'action'], (l, c) => l[c])}
) as v(actor_name, action)
where not exists (
  select 1 from public.audit_logs l where l.action = v.action
);
`);

const todaysPick = state.articles.find((a) => a.id === state.todaysPickId);

parts.push(`
-- SITE SETTINGS ---------------------------------------------------------------
-- Masthead, breaking-news banner and curation slots. The row id is a fixed 1,
-- so this is a real upsert on the primary key.
--
-- weekly_slots / todays_pick_id point at articles, but article ids in the
-- database are uuids generated at insert time rather than the seed's text ids,
-- so the featured story is resolved by title. A miss stores null, which the UI
-- treats as 'nothing curated' instead of rendering the text 'undefined'.
update public.site_settings
   set title         = ${lit(state.branding.title)},
       subtitle      = ${lit(state.branding.subtitle)},
       edition       = ${lit(state.branding.edition)},
       breaking_news = ${jsonLit(state.breakingNews)},
       weekly_slots  = ${jsonLit(state.weeklySlots)},
       todays_pick_id = (
         select id from public.articles
          where title = ${lit(todaysPick ? todaysPick.title : '')}
          limit 1
       ),
       updated_at = now()
 where id = 1;

commit;
`);

writeFileSync(
  'supabase/002_seed_content.sql',
  parts.join('\n'),
  'utf8'
);

console.log(
  `Wrote supabase/002_seed_content.sql: ${state.articles.length} articles, ` +
    `${state.assignments.length} assignments, ${state.staff.length} staff, ` +
    `${state.topPerformers.length} performers, ${state.mediaLibrary.length} media, ` +
    `${state.notifications.history.length} broadcasts, ` +
    `${state.auditLogs.length} audit entries.`
);

