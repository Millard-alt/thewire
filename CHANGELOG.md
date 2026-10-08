# Changelog

All notable changes to The Pulse are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

Migrations are numbered and live in `supabase/`. They are additive and
idempotent, so re-running one is safe. **A new release is not functional until
its migrations have been run in the Supabase SQL Editor.**

## [Unreleased]

### Applied

- Push notification fixes. `manifest.webmanifest` already declares `display: standalone` with root `start_url` and `scope`; `index.html` already links it and carries the `apple-mobile-web-app-*` tags; the service worker registers at `/sw.js` (root scope) and already handles `push` via `self.registration.showNotification()` plus `notificationclick`; `pushManager.subscribe()` already passes `userVisibleOnly: true` with a URL-safe base64-decoded VAPID key; and `instructions()` in `src/views/alerts.js` already branches on `isIOS() && !isStandalone()` to tell iPhone and iPad users to Add to Home Screen rather than sending them into Safari settings where there is nothing to change. These were verified in place rather than rewritten.

### Pending — required before these features work

- **`supabase/migrations/032_roster_leads_and_subcategories.sql`.** Gives every roster row a `sub_category` (the team under the main heading) and an `is_lead`. Until it is run, the sub-category field and the lead checkbox in the Owner panel have nowhere to save. **Run it after `028`, and do not re-run `028` or `024` afterwards** — both still contain a `create or replace` for a shorter `wire_credits_people_upsert`, and putting one back beside the twelve-argument one is `PGRST202 Could not find the function` on every add, save and remove. Existing rosters come through unchanged: `sub_category` is null and `is_lead` is false for every row, so nothing is backfilled into a team the Owner never chose.
- **`supabase/migrations/028_page_scopes.sql`.** Gives `credits_people` an explicit `page_scope`. Until it is run, About Us and Credits both render empty, because both pages read through it. **Run it after `024`, and do not re-run `024` afterwards** — `024` still contains a `create or replace` for the nine-argument `wire_credits_people_upsert`, and putting that back alongside the ten-argument one is `PGRST202 Could not find the function` on every add, save and remove, which kills both pages at once.
- **`supabase/migrations/029_podcast_role_gates.sql`.** Repairs the three `podcasts` table policies and the two `push_subscriptions` ones that were unreachable for the signed-in role. Without it, podcast episodes cannot be saved and the push device registry cannot be read or cleared.
- **Rotate the Supabase `service_role` key.** A working one for this project was committed in `.env.example`, which git tracks. It has been removed from the file, but it is still valid until 2036 and still in the history. This is the only step that actually closes it — see Security below.

### Added

- **The About Us roster is a two-level hierarchy, and each sub-team has a lead.** "BOARD MEMBERS" and "BEHIND THE BYLINES" render as large uppercase section headings; under each one the teams the Owner has defined — Writers, Designers, Photographers, or any name they invent — render as sub-headers with a quieter gold rule. **On a phone** each sub-team shows its lead full width with a 64px portrait, a gold rail and the rest of the team in a swipeable carousel. **On a desktop** every member of the sub-team fills one uniform three-column grid, with the lead carrying a `LEAD` pill and the gold rail. One lead per sub-team is a **partial unique index** in the database, not a decision the template makes: ticking somebody else moves the lead. A sub-team with nobody ticked still renders with someone in charge — `resolveLead()` falls back to the first member by display order, at RENDER time rather than in a backfill, because `is_lead = true` has to keep meaning *the Owner ticked the box*. A person with no sub-category is listed directly under the main heading with no sub-header, rather than in a bucket called "Unfiled" that would publish a filing decision nobody made.
- **`scripts/layout-check.mjs`** — sideways scroll, single-line nav labels and reachability at six widths. Mutation-tested: restoring the movable-only sum brings back `scrollW=1063` at 768px and it fails.
- **`scripts/scope-check.mjs`** — asserts `/about` and `/credits` share no card and that role pills clear 4.5:1 in **both** themes. Its network-payload check is reported as `SKIP` in demo mode rather than a green tick, because demo mode reads localStorage and issues no request: deleting `.eq('page_scope', …)` entirely still gave it 23/23. The load-bearing assertion is the static one in `tests/features.mjs`.
- **`scripts/click-check.mjs`** — clicks the reader page and all 16 owner tabs, requiring each control to change something observable, throw nothing and fail no request. It was a throwaway probe that immediately earned its place twice, so it is permanent. Known limits: it clicks but does not submit, so a dead form handler passes, and roughly a third of on-screen controls are skipped as DOM churn makes positional indexing drift.
- **`npm run test:push`** (`scripts/push-check.mjs`). Asserts the opt-in bar is visible at 360 / 390 / 430px with no horizontal overflow, and that `Notification.requestPermission()` is called **exactly once** by a real click and **zero times** on page load — the gesture requirement that Chrome on Android enforces.
- **Portrait zoom controls.** The portrait editor now has a slider plus zoom in / out / reset buttons, and accepts wheel and pinch gestures. The slider is a 0-100 position where 0 is the "cover the frame" fit, so the same control drives the slider, the buttons, the wheel and the pinch.
- **"Reset portrait" in the Newsroom Panel.** An Owner can now delete a staffer's portrait outright and let them submit a properly cropped replacement. It appears on any staffer whose portrait is live or rejected, and deliberately not on a pending one, where Approve and Reject already cover the case. Backed by `supabase/018_portrait_reset.sql` — a reset is destructive, so it gets its own Owner-only function rather than reusing `wire_assign_portrait`, which is gated on `is_staff()` and is not granted to `anon`. **Paste that file into the Supabase SQL Editor; until you do, the button reports that the server is missing the function.** Until then the rest of the panel is unaffected.

### Changed

- **About Us and Credits are two genuinely separate pages, not one filtered list.** They shared one roster, and "which page is this row on?" was answered by a NULL `category` column the view then filtered on. Two consequences: the Credits page fetched every row and dropped the board members *in the renderer*, so their names, roles, notes and photo URLs were in the HTML of a page the reader was never on; and "no category" had to mean both "not on About yet" and "deliberately Credits only", so promoting somebody to the board also demoted them from the Credits page. `page_scope` (migration 028) is NOT NULL and CHECK-constrained, and a second constraint makes the crossover unrepresentable: `about_us` requires a category, `credits` forbids one. Both public readers now filter **in the query**. A consequence worth stating plainly: a row belongs to exactly one page, so somebody who must appear on both is **two rows**, edited and ordered independently. The panel says so.
- **The Owner panel has two tabs, not one tab behind three filter buttons.** The page a card belongs to now comes from the submitted form rather than a module variable, and the "Appears under" dropdown is gone from the Credits card — that dropdown was how a person left the Credits page by editing a card on the other.
- **Role badges are pills, not solid blocks.** `background: var(--role-colour); color: #fff` was a slab of whatever colour the Owner picked with the text colour hardcoded, so #b45309 and #7c2d12 failed AA outright. The colour is now a 12% wash with a faint edge and the accent only on the text, nudged until it clears 4.5:1. **Two accents are emitted, one per theme**, because contrast depends on the colour values and only JS can compute a passing accent while the theme is a CSS decision; a single accent tuned for the dark card shipped 1.79:1 pills in light mode. A long title such as `ASSISTANT PRESIDENT/COORDINATOR` now wraps inside the pill instead of pushing past the card.

### Fixed

- **Opening the About Us tab first hung the Newsroom Panel on "Loading the About Us page…", forever.** `renderRosterTab()` derived the tab id it re-checked before painting with `tabScope(scope)` — but `tabScope()` takes a *tab id*, not a *scope*, so for the About Us tab it fell through to `'credits'`, compared that against `body.dataset.tab` (which is `'about'`), always bailed out, and left the panel on its loading state. It appeared to work only because opening the **Credits** tab first populated the module cache and took the synchronous path, which skips the guard entirely — so the bug hid behind the order the Owner happened to click two tabs in, and every test that reached the About tab via the Credits tab passed. Now `scopeToTabId()` and `tabScope()` are a named pair rather than one function called with the wrong kind of argument.
- **`.credits-band-editor` had no CSS anywhere.** Both roster tabs emitted it — the band heading, the count badge and the two move buttons — and it was defined in no stylesheet, so every band in the Newsroom Panel rendered as an unstyled block. The public page's band has had styling since the Credits page shipped; the editor had not.
- **Writer podcast submissions could never succeed.** `podcasts_staff_submit` requires `author_account_id = current_account_id()`, and **neither** insert path sent the column. It is nullable, so the row was written with `NULL` — and `NULL = current_account_id()` is `NULL`, not true — and the policy refused the insert. Reported as "The submission was refused by the server", which is the least informative sentence available for a misconfigured policy. Both paths now send it, and a refusal now names the real error when there is no account.
- **The upload preflight could not detect a refused write.** `checkPodcastStorage()` called `.list()`, which is a **read**, authorised by `podcasts_read`. The rule that refuses uploads is `podcasts_upload`, which is `for insert`. So the preflight passed, the dialog opened, the writer picked their episode and spent their data allowance pushing it, and the upload was refused at the very end by a rule it had never tested — the exact scenario the function existed to prevent. It now writes a one-byte probe to the same `episodes/` prefix, so it exercises the role check *and* the folder clause.
- **A backtick inside an HTML comment stopped the whole admin module evaluating.** A comment inside a template literal read `...no matching \`case\` reads as a delegated button...`; the backtick closed the string and `case` was parsed as JavaScript. The module threw `Unexpected token 'case'`, which emptied the header's auth slot and killed every button in the Newsroom Panel — from one console line nobody was reading. Asserted in `tests/features.mjs`.
- **"Turn on alerts" did nothing once a reader had answered.** `ensureAlertPermission()` opened with `if (hasAnswered()) return false`, and that guard applied to *deliberate* clicks as well as the automatic prompt. A tap produced no dialog, no toast and no error. Opting in now passes `{ deliberate: true }`, so a denial is explained rather than swallowed.
- **`data-action="podcast-save-edit"` pointed at a `case` that never existed.** It is a plain submit control routed by the delegated form listener, so it is no longer lying about being a delegated button.
- **The header overflowed sideways by up to 295px.** The nav fit test summed only the five *movable* links (416px) against 514px and decided "it fits", while the five fixed links took another 530px it never counted. The row also had no `flex-shrink`, so a slightly-too-wide row *compressed* and wrapped labels inside their own boxes instead of overflowing — "Today's Pick" measured 41px tall beside "Weekly" at 24.5px. No `overflow-x: hidden` was added: it hides the symptom and breaks `position: sticky`.
- **`025_podcasts_storage_repair.sql` and `028_page_scopes.sql` could not be pasted into Supabase at all.** One had comment lines written as ` *` instead of `--` (`42601 syntax error at or near "*"`), which was mine. The other had a diagnostic query selecting `b.id` and `b.public` with **no `FROM` clause** — `42P01`. Adding `FROM storage.buckets b` would have been worse: a missing bucket returns zero rows, so every other column would vanish in the one case being diagnosed. Scalar subqueries now always return one row. Its `path_ok` column was also a constant expression that never looked at the policy; it now reads the policy's own `WITH CHECK` clause.
- **The `025` diagnosis reported two columns that can never answer the question.** `caller_is_staff` and `session_resolves` are always false in the SQL Editor for every user, because both resolve the account from the HTTP request's bearer token and the Editor has no request. They looked like the answer while being structurally incapable of being one. Replaced with what is answerable there: account counts and live sessions.
- **The "Pending" changelog section never sorted or got its icon.** `baseTitle()` reduces `Pending — required before these features work` to `Pending`, but `SECTION_ORDER` and `SECTION_ICONS` were keyed on the full heading, so the lookup always missed and the section fell to the end with a generic dot.
- **The notification opt-in bar could never appear.** `#alert-optin-bar` ships with the `hidden` attribute in `index.html`, and `renderOptInBar()` in `src/views/alerts.js` wrote its contents into the element without ever clearing that flag. The bar was therefore painted into an invisible box: readers were never offered the "Turn on alerts" button, and so never got as far as the permission prompt — which is very likely what made Android look like it was refusing to prompt at all. The renderer now clears `hidden` on the paths that return early and un-hides it only once there is a real bar to show.
- **Mojibake in user-visible strings.** Em dashes and curly quotes in `src/views/alerts.js` had been re-encoded through CP-1252 and were rendering as literal sequences of accented characters on the page. Repaired to valid UTF-8.
- **The crop box can no longer leave the photo.** Two separate arithmetic bugs were letting portraits be submitted mostly blank: 1. `clampOffsets()` compared `(image.width * scale)` — a length in CSS pixels — against `baseScale`, a dimensionless scale factor. Subtracting one from the other produced a slack hundreds of pixels too large, so the photo could be dragged most of the way out of its own ring. It now clamps to half the actual overflow, `(drawW - side) / 2`, per axis. 2. `fitImage()` used `contain` scaling, so a tall or wide photo started smaller than the ring and showed empty canvas before the writer touched anything. It now uses `cover`, and zooming has a hard floor at that fit so empty padding cannot be reintroduced by zooming out. Verified in Chromium: after dragging hard in all four directions and zooming to minimum, the sampled canvas contains **zero** fully transparent pixels at the fitted position, with no horizontal overflow at 360/390/430px.
- **The "choose a photo" placeholder is hidden once a photo loads.** It is absolutely positioned over the frame, so it was printing "Tap to choose a photo" on top of the very image being lined up.
- **Cropped portraits are saved centred, and the Owner panel displays them centred.** The saved crop was computed from the wrong centre, so the frame the user carefully lined up and the square that was actually stored were different regions of the photo: 1. `cropToSquare()` added `image.width / 2` and `image.height / 2` to the frame's centre, but `paint()` maps a source pixel `p` to frame position `originX + p * scale`, so the centre of the frame is simply `(side / 2 - originX) / scale` — nothing else. The extra half-image was then swallowed by the clamp, which pinned the crop to the bottom-right corner of the photo. For a 4000x3000 photo cropped 3000 wide, the correct start is `sx = 500`; the code asked for 2500 and got 1000. The bottom-right corner of a portrait photo is the dark backdrop, which is exactly the "off-centre and partially black" report. Dragging appeared to do nothing because the clamp overrode it at every zoom. 2. `.portrait-sticker` used `object-position: center 30%`, a shift that had been added to rescue raw, uncropped uploads whose heads sat near the top edge. Against an exactly-cropped square that offset is pure misregistration, so even a correct crop rendered above where it was placed. It is now `center`, with `aspect-ratio: 1 / 1` and `overflow: hidden` so the frame cannot letterbox. The Owner's own staff editor was also uploading the raw file, uncropped, so portraits assigned from the panel bypassed the cropper entirely. It now runs uploads through the same `squareUpImage()` normaliser, which means every portrait in the database is the same 512 square whichever route it came in by, and the display rule no longer needs an exception. Verified in Chromium with a 1600x1000 test image: the centre of the saved 512 square matches the centre of the framed region to within 1px, the saved square contains zero transparent/black padding, and the panel sticker computes to `object-position: center` inside a 1:1 clipped box.
- **Credits member names are now legible in dark mode.** They were invisible: black text on a near-black background. `.credits-card__name` used `var(--color-ink)`, but `--color-ink` is a fixed light-mode literal (`#18130f`) declared once in `@theme` and never redefined under `.dark`, so every name rendered near-black on the `--surface: #12100e` dark background. Credits now uses the theme-aware semantic tokens `--text` and `--text-muted`, which resolve to near-black on newsprint and cream in dark mode. The role band headers, count badges, card border and empty-avatar placeholder had the same defect and are fixed too, so nothing else on the page is left stranded. Light mode is unchanged: names measured `rgb(24, 19, 15)` before and after.

### Security

- **A real `service_role` key was committed to `.env.example`, which git tracks.** Not a password with extra privileges — the master key, which **bypasses every row-level security policy in the project**. Every policy here, including the `credits_people` ownership model and the article attribution guards that took three migrations to repair, is decorative against it. Removed from the file; **the key must still be rotated in the Supabase dashboard**, because deleting a line from a tracked file does not unpublish it. `tests/features.mjs` now decodes any JWT-shaped string in a tracked file and fails if it resolves to a Supabase key.
- **Four RLS policies were unreachable, so they protected nothing.** This project has no Supabase Auth JWT — `credentials.sql` states it outright — and issues its own token in the `x-wire-token` header. PostgREST therefore resolves every request as role `anon`, which makes `anon` the signed-in role and `authenticated` a role nothing ever arrives as. A policy written `for insert to authenticated` is not stricter, it is **unreachable**: - `podcasts_upload` and `podcasts_delete` (`storage.objects`) — every podcast upload refused with `new row violates row-level security policy`; - `podcasts_staff_submit`, `podcasts_owner_all` and `podcasts_delete_own_pending` (`public.podcasts`) — the same failure one layer down, once the bucket was fixed; - `push_subscriptions_staff_read` and `push_subscriptions_staff_delete`, unreported and unnoticed until the whole schema was audited. Every feature that *worked* already named `anon` as well — `articles_*` (007), `interviews_*` (022). The podcast and push policies were the only outliers. Removing the role clause widens which roles are **evaluated**, never who is **allowed**: every row still has to satisfy `is_staff()` or `is_owner()`, which resolve the account from the request's bearer token.
- The accompanying table `grant`s were `to authenticated` only, and RLS is consulted *after* the table privilege — so those refused the write with `permission denied` before any policy was reached. Granted to `anon` as well. Note that Supabase's default privileges already give `anon` `TRUNCATE` and `TRIGGER` on `public` tables anyway, which is the clearest demonstration that grants are not the boundary here and policies are.

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
