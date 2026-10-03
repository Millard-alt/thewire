# Changelog

All notable changes to The Wire are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

Migrations are numbered and live in `supabase/`. They are additive and
idempotent, so re-running one is safe. **A new release is not functional until
its migrations have been run in the Supabase SQL Editor.**

## [0.9.0] — 2026-10-10

A clean-slate changelog. Everything below describes work done in this session,
verified against the live database where the change was server-side.

### Pending — required before these features work

- **`supabase/017_gallery_categories_and_article_photos.sql` must be pasted into
  the Supabase SQL Editor.** It creates the `gallery_categories` table, adds
  `category_id` to `media_assets`, adds `extra_images jsonb` (an array of at most
  three photo objects) to `articles`, and opens the matching RLS policies and
  grants. Until it is applied the new Gallery page, multi-upload and article
  photo strips degrade gracefully: the client falls back to a single
  uncategorised bucket and single-photo articles, exactly as before. Nothing
  breaks; the features are simply inert. The file is fully idempotent, so a
  partial paste can simply be pasted again in full.
  - **`articles_extra_images_check` was rewritten after a failed paste.** The
    first version used `not exists (select ... from jsonb_array_elements(...))`,
    which Postgres rejects outright with `0A000: cannot use subquery in check
    constraint`. It now uses jsonpath (`@?`, `jsonb_typeof`,
    `jsonb_array_length`), which are immutable expressions and therefore legal
    inside a CHECK. The whole migration is wrapped in a transaction, so the failed
    run applied nothing and the file can simply be pasted again in full.

### Fixed

- **Signup rejected every new account** with `23514 ... staff_accounts_role_check`.
  The deployed `wire_request_account` was a stale pre-rename copy that still
  inserted `role = 'Editor'`. The CHECK itself was always correct — it accepts
  `Owner`, `Writer`, `Board Manager`. Migration `012` redefines the function to
  insert `'Writer'`. Verified live.
- **"Unknown role" when approving an account.** Introduced by commit `419e924`,
  which "hardened" `wire_approve_account` with `lower(trim(p_role))`. That
  lowercased the canonical `'Writer'` to `'writer'`, which is not in the CHECK
  either. The fix keeps the stored value canonical and does case-insensitive
  comparison against a separate lowercased copy, so `writer`, `Writer` and
  `BOARD MANAGER` all resolve correctly while the CHECK always has something
  valid to check.
- **"not signed in" on portrait submission.** `wire_approve_account` created a
  `staff_accounts` row with no matching `staff` row, so `current_staff_id()`
  returned NULL and `wire_submit_portrait()` refused. Migration `015` backfills
  the missing rows and provisions one on every future approval. This was also
  why an uploaded portrait never appeared in the Owner panel — one root cause,
  two symptoms.
- **Mojibake across the codebase** — 11 UTF-8 sequences round-tripped through a
  legacy code page (a mangled em dash, ellipsis or middle dot). All repaired by
  explicit byte mapping rather than a blanket regex.
  Repair used explicit byte mapping, never a blanket high-character regex, which had twice corrupted legitimate
  em dashes before. `scripts/encoding-check.mjs` now guards against regressions
  and can genuinely strip a BOM (`buf.toString()` keeps it as U+FEFF, so the
  previous implementation re-emitted the bytes it was deleting).
- **Credits tab buttons silently did nothing.** Several RPCs were called with
  argument names that did not exist in their SQL signatures, so the calls were
  no-ops with no error. Corrected in `src/lib/credits.js`.
- **`wire_register_device` was granted to `authenticated` only**, the same class
  of grant bug as the portrait functions. `016` repairs it (the grants were in
  fact already present — `016`'s own verifier was wrong, see below).
- **Portrait approval had no UI at all.** `setPortraitStatus()` was exported but
  nothing ever called it. The Owner now gets approve/reject controls on the
  Staff tab for any staffer with a pending portrait; non-Owners see their own
  photo and no controls.
- **Portrait requirement exempted every writer.** `portraitRequirementMet()` and
  `publishPortrait()` tested `session.isAdmin`, which is true for *every* active
  account since the roles were split, not just the Owner. Corrected to
  `session.isOwner`.
- **Seed data used non-roles** (`Assignment Manager`, `Senior Investigative
  Editor`, `Photojournalist`). No CHECK ever accepted these and
  `normaliseRole()` folded them to `Writer`, so the row and the UI disagreed.
  Normalised to `Board Manager` / `Writer`.
- **The Owner panel's gallery rendered the literal text "undefined".** Two causes:
  `listGalleryCategories()` returned no `count` for the card subtitle, and the
  media mapper set no `categoryName`. Both display fields are now derived in one
  place so every caller gets them.
- **The category delete button did nothing.** The button rendered but `handleClick`
  had no `case` for it, so the click fell through to nothing.
- **The article editor's extra-photo inputs were never read on save.** The inputs
  existed in the form and the store accepted the field, but `saveArticleFromForm`
  never passed it, so uploaded supporting photos were silently discarded.
- **Seed media used a different key than every consumer reads** (`galleryCategoryId`
  in the seed against `categoryId` in the store), and stale demo state in
  localStorage carried the old key. Corrected at the source, and the read is now
  tolerant of the legacy key.
- **The category manager did not repaint after a create.** The store updated but
  the list was never re-rendered.

### Added

- **The Gallery is now its own page** with owner-managed categories rendered as
  cards. Selecting a card animates into that category's photos. Categories are
  created and reordered by the Owner from the newsroom panel.
- **Multi-file upload** for the gallery: pick several images at once and they are
  uploaded together, with per-file progress and partial-failure reporting.
- **Up to three photos per article**, laid out as a grid that expands when
  tapped. The limit is enforced in the client and in the schema so a long
  slideshow can never make an article look messy.
- **Credits are grouped by role**, the way a Discord member list groups them.
  Consecutive people sharing a role sit under one heading. The band order is
  whatever the Owner sets in the newsroom panel, so moving `Coordinator` above
  `Patron` there puts it above `Patron` on the page. Each band has move-up and
  move-down controls.
- **The Credits heading on the front page is now set in caps**, to match the
  rest of the masthead.

### Security

- **`scripts/rpc-contract-check.mjs`, wired into `npm test`.** It fails the
  build if any client `rpc()` name or argument stops matching its SQL
  definition. Every RPC drift bug above would have been caught by it
  automatically.
- **`scripts/gallery-check.mjs` (`npm run test:gallery`), wired into `npm test`.**
  26 checks over the new surfaces, none of which the previous four suites
  touched: the gallery door, routing to the gallery page, category card expand
  and collapse with `aria-expanded` tracked, zero horizontal overflow at 320 /
  360 / 390 / 430px, Owner category create-select-delete, the media form's
  category picker, multi-file upload, the three-photo cap with four files
  offered, and the article strip's expand/collapse on a published story.
  The cap assertion was mutation-tested: raising `MAX_ARTICLE_PHOTOS` to 9 makes
  it fail, so it is not a check that passes by construction.

### Known limitations

- The five test suites (`npm test`, `test:smoke`, `test:credits`, `test:gallery`,
  `lint:encoding`) all run against a **local demo-mode server**. They prove
  client logic, role gating and markup — they do **not** exercise the live
  database, so passing tests are not evidence that a migration has been applied.
- Consequently `017` is **unverified**. The gallery, multi-upload and article
  photos all run against demo data; until the migration is pasted they degrade
  to a single uncategorised bucket and single-photo articles.
- `016_grant_owner_panel_rpcs.sql` reported every function as `BROKEN` while
  printing ACLs that plainly contained `anon=X/postgres`. The verifier's
  `'anon' = any (proacl::text[])` test can never be true — each array element is
  a whole aclitem. It was corrected to `has_function_privilege(...)`; the grants
  were present all along.
- No test covers the Owner's *success* path for portrait approval. The refusal
  path is proven live (`P0001: only the Owner can approve or reject a
  portrait`); the approval path is not, because doing so writes to
  `staff.portrait_status` and the Owner password is not on this machine.
