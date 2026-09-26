-- ============================================================================
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
  ('The Architecture of Civic Truth in Rift Valley Journalism', 'Grace Wanjiku', 'Investigation', 'Published', 'Sept 24, 2026', 'Journalism in Nakuru has long served as a vital pillar of civic life. As news platforms transition into digital frontiers, maintaining verified records remains sovereign. The Nakuru Press Club continues to champion editorial integrity above algorithmic speed. Our correspondents keep physical day books, notarised transcripts and a public corrections ledger, because a story that cannot be audited is a rumour with a byline.', 'https://images.unsplash.com/photo-1504711434969-e33886168f5c?auto=format&fit=crop&w=1200&q=80', 'Press archives preserved in the Nakuru central room.', true),
  ('Rift Water Rights Assembly Convenes in the Lake Nakuru Basin', 'David Kiprop', 'Civic Dispatch', 'Published', 'Sept 23, 2026', 'Representatives from regional agricultural collectives gathered this morning to deliberate water conservation strategies. Local journalists documented the open council discussions and published the full attendance register alongside the minutes.', 'https://images.unsplash.com/photo-1541872703-74c5e44368f9?auto=format&fit=crop&w=1200&q=80', 'Delegates gathering at the lake basin.', false),
  ('Shadows and Light: Photographs from the Old Railway Quarter', 'Amina Mohamed', 'Culture', 'Published', 'Sept 22, 2026', 'A visual exploration of Nakuru''s historic railway neighbourhood reveals stories written into architectural facades and morning markets.', 'https://images.unsplash.com/photo-1495020689067-958852a7765e?auto=format&fit=crop&w=1200&q=80', 'A quiet morning at the railway terminus.', false),
  ('Pending Editorial Submission: Municipal Infrastructure Review', 'Samuel Ochieng', 'Investigation', 'Pending Review', 'Sept 24, 2026', 'This draft was submitted by staff and requires owner approval before it can run on the front page.', 'https://images.unsplash.com/photo-1486406146926-c627a92ad1ab?auto=format&fit=crop&w=1200&q=80', 'Draft review under editorial inspection.', false)
) as v(title, author, category, status, published_at, body, image_url, caption, featured)
where not exists (
  select 1 from public.articles a where a.title = v.title
);


-- The read policy is lower(status) = 'published' and the CHECK constraint
-- accepts either spelling, but normalise to title case so the admin filters,
-- which compare against 'Pending Review' and friends, match cleanly.
update public.articles
   set status = initcap(status)
 where status is not null
    and status <> initcap(status);


-- ASSIGNMENTS ----------------------------------------------------------------
insert into public.assignments (title, reporter, status, deadline)
select v.title, v.reporter, v.status, v.deadline
from (values
  ('Cover the Nakuru Urban Planning Council session', 'David Kiprop', 'In Progress', 'Sept 26, 2026'),
  ('Investigate the Lake Nakuru water quality index', '', 'Open', 'Sept 30, 2026')
) as v(title, reporter, status, deadline)
where not exists (
  select 1 from public.assignments a where a.title = v.title
);


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
  ('Chief Owner', 'owner', 'chief.owner@example.com', 'Owner', 'Active'),
  ('Grace Wanjiku', 'gwanjiku', 'grace.wanjiku@example.com', 'Editor', 'Active'),
  ('David Kiprop', 'dkiprop', 'david.kiprop@example.com', 'Assignment Manager', 'Active')
) as v(name, username, email, role, status)
where not exists (
  select 1 from public.staff s where s.username = v.username
);


-- TOP PERFORMERS --------------------------------------------------------------
insert into public.top_performers (name, role, articles_count)
select v.name, v.role, v.articles_count
from (values
  ('Grace Wanjiku', 'Senior Investigative Editor', 42),
  ('Amina Mohamed', 'Photojournalist', 28)
) as v(name, role, articles_count)
where not exists (
  select 1 from public.top_performers p where p.name = v.name
);


-- MEDIA LIBRARY ---------------------------------------------------------------
insert into public.media_assets (url, caption)
select v.url, v.caption
from (values
  ('https://images.unsplash.com/photo-1504711434969-e33886168f5c?auto=format&fit=crop&w=1200&q=80', 'Press archives'),
  ('https://images.unsplash.com/photo-1541872703-74c5e44368f9?auto=format&fit=crop&w=1200&q=80', 'Lake basin council'),
  ('https://images.unsplash.com/photo-1495020689067-958852a7765e?auto=format&fit=crop&w=1200&q=80', 'Railway quarter')
) as v(url, caption)
where not exists (
  select 1 from public.media_assets m where m.url = v.url
);


-- BROADCASTS ------------------------------------------------------------------
insert into public.broadcasts (title, message, audience, delivered_count)
select v.title, v.message, v.audience, v.delivered
from (values
  ('Editorial suite is live', 'The Wire''s owner workspace is now active.', 'Everyone', 1420)
) as v(title, message, audience, delivered)
where not exists (
  select 1 from public.broadcasts b where b.title = v.title
);


-- AUDIT LOG -------------------------------------------------------------------
-- actor_id references auth.users, so it is left null for system entries.
insert into public.audit_logs (actor_name, action)
select v.actor_name, v.action
from (values
  ('System', 'Initialised the publication workspace')
) as v(actor_name, action)
where not exists (
  select 1 from public.audit_logs l where l.action = v.action
);


-- SITE SETTINGS ---------------------------------------------------------------
-- Masthead, breaking-news banner and curation slots. The row id is a fixed 1,
-- so this is a real upsert on the primary key.
--
-- weekly_slots / todays_pick_id point at articles, but article ids in the
-- database are uuids generated at insert time rather than the seed's text ids,
-- so the featured story is resolved by title. A miss stores null, which the UI
-- treats as 'nothing curated' instead of rendering the text 'undefined'.
update public.site_settings
   set title         = 'THE WIRE',
       subtitle      = 'NAKURU PRESS CLUB   INDEPENDENT VERIFIED DISPATCHES',
       edition       = 'VOL. CXIV... NO. 32,841   NAKURU, KENYA',
       breaking_news = '{"enabled":true,"label":"BREAKING DISPATCH","headline":"Nakuru Press Club Launches Sovereign Editorial Control Suite","subtext":"Full administrative controls are live across the newsroom.","severity":"Breaking","color":"Red","sticky":true,"dismissible":false,"linkText":"Read the announcement","linkUrl":"#"}'::jsonb,
       weekly_slots  = '{"article":"seed-article-1","event":"seed-article-2","picture":"seed-article-3"}'::jsonb,
       todays_pick_id = (
         select id from public.articles
          where title = 'The Architecture of Civic Truth in Rift Valley Journalism'
          limit 1
       ),
       updated_at = now()
 where id = 1;

commit;
