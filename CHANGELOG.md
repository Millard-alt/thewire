# Changelog

All notable changes to The Wire are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

Migrations are numbered and live in `supabase/`. They are additive and
idempotent, so re-running one is safe. **A new release is not functional until
its migrations have been run in the Supabase SQL Editor.**

## [Unreleased]

### Added

- **Portrait zoom controls.** The portrait editor now has a slider plus
  zoom in / out / reset buttons, and accepts wheel and pinch gestures. The
  slider is a 0-100 position where 0 is the "cover the frame" fit, so the
  same control drives the slider, the buttons, the wheel and the pinch.

- **"Reset portrait" in the Newsroom Panel.** An Owner can now delete a
  staffer's portrait outright and let them submit a properly cropped
  replacement. It appears on any staffer whose portrait is live or rejected,
  and deliberately not on a pending one, where Approve and Reject already
  cover the case. Backed by `supabase/018_portrait_reset.sql` — a reset is
  destructive, so it gets its own Owner-only function rather than reusing
  `wire_assign_portrait`, which is gated on `is_staff()` and is not granted
  to `anon`. **Paste that file into the Supabase SQL Editor; until you do,
  the button reports that the server is missing the function.** Until then
  the rest of the panel is unaffected.

### Fixed

- **The crop box can no longer leave the photo.** Two separate arithmetic
  bugs were letting portraits be submitted mostly blank:

  1. `clampOffsets()` compared `(image.width * scale)` — a length in CSS
     pixels — against `baseScale`, a dimensionless scale factor. Subtracting
     one from the other produced a slack hundreds of pixels too large, so the
     photo could be dragged most of the way out of its own ring. It now
     clamps to half the actual overflow, `(drawW - side) / 2`, per axis.
  2. `fitImage()` used `contain` scaling, so a tall or wide photo started
     smaller than the ring and showed empty canvas before the writer touched
     anything. It now uses `cover`, and zooming has a hard floor at that fit
     so empty padding cannot be reintroduced by zooming out.

  Verified in Chromium: after dragging hard in all four directions and
  zooming to minimum, the sampled canvas contains **zero** fully transparent
  pixels at the fitted position, with no horizontal overflow at 360/390/430px.

- **The "choose a photo" placeholder is hidden once a photo loads.** It is
  absolutely positioned over the frame, so it was printing "Tap to choose a
  photo" on top of the very image being lined up.

- **Credits member names are now legible in dark mode.** They were invisible:
  black text on a near-black background. `.credits-card__name` used
  `var(--color-ink)`, but `--color-ink` is a fixed light-mode literal
  (`#18130f`) declared once in `@theme` and never redefined under `.dark`, so
  every name rendered near-black on the `--surface: #12100e` dark background.
  Credits now uses the theme-aware semantic tokens `--text` and `--text-muted`,
  which resolve to near-black on newsprint and cream in dark mode. The role
  band headers, count badges, card border and empty-avatar placeholder had the
  same defect and are fixed too, so nothing else on the page is left stranded.
  Light mode is unchanged: names measured `rgb(24, 19, 15)` before and after.

## [0.9.2] — 2026-10-10

The Newsroom Panel now always paints above the gallery, and closing it puts you
back on the page you came from.

### Fixed

- **The gallery no longer shows through or over the Owner's Panel.** Opening the
  panel from the gallery left the gallery visible underneath it, and an open
  gallery lightbox could paint on top of the panel. `#main-content` had no
  `position`/`z-index`, so it was painted in normal flow below every positioned
  descendant of `<body>` — which is exactly what the lightbox is
  (`position: fixed; z-index: 60`). It is now raised into its own stacking
  context at `z-index: 50` while the panel is mounted. The panel deliberately
  sits *below* the dialog layer (60) so the modals the Owner opens from inside
  the panel can still cover it.
- **Opening the panel now closes the gallery lightbox and hides every reader
  view.** `openAdmin()` previously hid only `#publication-view`, so the gallery
  and credits views stayed visible and bled through. All three are hidden now,
  and `closeAdmin()` restores the specific view the Owner came from rather than
  always snapping back to the front page.
- **The panel is no longer frozen after opening it from the gallery.** The
  lightbox set `document.body.style.overflow = 'hidden'` as an inline style and
  never cleared it. Inline styles outrank every stylesheet rule, so the phone
  rule `body.admin-active { overflow: auto }` could not restore scrolling. The
  lightbox now goes through `openDialog()`, which counts the lock and toggles a
  `dialog-locked` *class* that participates in the normal cascade and is
  released by `releaseDialogLocks()`.

### Changed

- Repaired mojibake in user-visible strings in `src/views/alerts.js` and
  `src/views/auth.js`: em dashes, an apostrophe and two ellipses had been stored
  as CP1252-mojibake byte sequences and were rendering as three visible garbage
  characters each. They are now stored as real UTF-8.

## [0.9.1] — 2026-10-10

Gallery and credits work for the phone: an image is filed before it is shown, a
category opens as its own page, and the credits roster reads as a grid of people.

### Added

- **"Add to gallery" asks which category the image belongs in.** The toggle in the
  Owner panel's Media tab now opens a category picker instead of filing the photo
  into a default. An image with no category is kept but never shown publicly, and
  `store.listGalleryByCategory()` no longer emits the uncategorised bucket, so an
  unfiled photo cannot reach the public Gallery page by accident.
- **Category pages.** Tapping a category card animates into a full page for that
  category rather than expanding a dropdown of every image inline. The page has a
  Back button that returns to the category list. The transition is disabled under
  `prefers-reduced-motion`.

### Changed

- The gallery block is gone from the front page. The `PHOTO GALLERY` nav button
  and the Gallery page are now the only route in, and the footer link was dropped
  so the gallery is not listed twice in one column.
- Credits cards follow the new spec: a coloured accent bar to the left of the role
  name, the count badge on the far right of the row, no full-width outer wrapper,
  and a responsive `1 / md:2 / lg:3` grid at `gap-4`. Member cards are sharp
  cornered with a thin `border-neutral-700`, plain background, and a left-aligned
  `w-12 h-12` circular avatar beside a bold serif name and a two-line bio. Hover
  and focus draw a retro offset box-shadow.

### Fixed

- The gallery suite no longer asserts the front-page door it now proves is absent,
  and it opens the mobile Menu disclosure before clicking a nav link, which it
  could not previously reach at 390px.
- Android notifications no longer depend on an automatic permission prompt.
  Opening a story used to call `ensureAlertPermission()` from `openArticle()`, so
  the request fired on page load rather than from a deliberate opt-in. Android
  Chrome suppresses a prompt that is not the result of an explicit user gesture,
  which is why the native dialog never appeared and readers who then allowed it
  from Site Settings still got nothing. The call is removed from `openArticle()`
  and the only remaining request sites are the "Turn on alerts" button and the
  Owner's send-a-test button, both real gestures.
## [0.9.0] — 2026-10-10

A clean-slate changelog. Everything below describes work done in this session,
verified against the live database where the change was server-side.

### Applied — `017` is live and verified

`supabase/017_gallery_categories_and_article_photos.sql` has been pasted into the
Supabase SQL Editor and is **complete**. It creates the `gallery_categories`
table, adds `category_id` to `media_assets`, adds `extra_images jsonb` (an array
of at most three photo objects) to `articles`, and opens the matching RLS
policies and grants.

Verified by querying the live database, not by assumption:

- `gallery_categories` exists and is reachable over PostgREST.
- `articles.extra_images` and `media_assets.category_id` both exist.
- `anon` can SELECT `gallery_categories`, which is what the public Gallery page
  needs to render its cards.
- `anon` INSERT is refused with `42501 ... violates row-level security policy`,
  confirming the Owner-only write policy is genuinely enforced rather than
  merely written in the file. The Owner's own browser is authorised by the
  `x-wire-token` session header, which `wire_bearer_token()` reads, so this is the
  intended shape and not a lockout.

The `articles_extra_images_check` constraint needed a rewrite along the way. The
first version used `not exists (select ... from jsonb_array_elements(...))`,
which Postgres rejects outright with `0A000: cannot use subquery in check
constraint`. It now uses jsonpath (`@?`, `jsonb_typeof`, `jsonb_array_length`),
which are immutable expressions and are therefore legal inside a CHECK, with a
`CASE` guard so `jsonb_array_length` cannot raise `22023` on a non-array. The
migration is one transaction, so the failed attempt applied nothing and the
successful run applied all of it.

**The Gallery page, Owner-managed categories, multi-file upload and article
photo strips are now functional.** No migrations remain outstanding.

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
- The suites do not prove the database, but the schema was checked directly: with
  `service_role` I confirmed `gallery_categories` exists, `articles.extra_images`
  and `media_assets.category_id` both exist, and `anon` INSERT is refused with
  `42501 ... violates row-level security policy`. That refusal is the intended
  shape, not a lockout — the Owner's own browser is authorised by the
  `x-wire-token` session header, which `wire_bearer_token()` reads. So the
  Gallery page, categories and article photo strips have their schema; what has
  not been exercised end to end is the Owner's browser writing through those
  policies to a real row.
- `016_grant_owner_panel_rpcs.sql` reported every function as `BROKEN` while
  printing ACLs that plainly contained `anon=X/postgres`. The verifier's
  `'anon' = any (proacl::text[])` test can never be true — each array element is
  a whole aclitem. It was corrected to `has_function_privilege(...)`; the grants
  were present all along.
- No test covers the Owner's *success* path for portrait approval. The refusal
  path is proven live (`P0001: only the Owner can approve or reject a
  portrait`); the approval path is not, because doing so writes to
  `staff.portrait_status` and the Owner password is not on this machine.
