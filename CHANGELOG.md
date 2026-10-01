# Changelog

All notable changes to The Wire are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

Migrations are numbered and live in `supabase/`. They are additive and
idempotent, so re-running one is safe. **A new release is not functional until
its migrations have been run in the Supabase SQL Editor.**

## Live database status

Verified by probes against `iguzwwqjufzzdblkqroj` on 10 Oct 2026, using `anon`
credentials only. Existence was confirmed by calling each function with its real
signature: PostgREST answers `PGRST202 "could not find the function"` when an
object is absent, and any other error (permission, argument, Owner gate) proves
the object exists. Tables were checked with a `select` of the specific column.

| Migration | State | How it was confirmed |
|---|---|---|
| `schema.sql`, `credentials.sql`, `001`, `002` | applied | site is live against them |
| `003_subscriptions_and_gallery.sql` | **applied** | `wire_subscriber_count()` returns `0` |
| `004_device_registration.sql` | **applied** | `wire_register_device` and `wire_unregister_device` both resolve; `device_registrations` is not part of this migration, so its absence is expected |
| `005_portraits_and_credits.sql` | **applied** | `staff.portrait_url` and `staff.permissions` both select `200`; `wire_submit_portrait` / `wire_assign_portrait` / `wire_set_portrait_status` all resolve and reject `anon` with the correct message |
| `006_roles_and_privileges.sql` | **applied** (after fix) | `wire_default_permissions('Writer')` returns a real capability map |
| `007_article_ownership.sql` | **applied** (after fix) | `articles.author_account_id` selects `200`; `wire_owns_article` returns a boolean |
| `008_reset_non_owner_accounts.sql` | **not run — deliberately** | Destructive by design. The Owner's call when they want it. |
| `009_credits_page.sql` | **applied** | `credits_people` exists and is empty; `wire_credits_people_list()` returns `[]`; all three write functions resolve and reject `anon` with "only the Owner can change the Credits page" |
| `010_diagnose_role.sql` | **read-only, safe to run** | Reports exactly which CHECK on `staff_accounts.role` is rejecting your rows. Run this first. |
| `011_repair_role_constraint.sql` | **NOT YET RUN — you must run this** | Supersedes 010, which was withdrawn as unsafe. Repairs the constraint by column identity rather than by name, then self-tests. See the third failure below. |

**One migration is still outstanding: `supabase/011_repair_role_constraint.sql`.**
Until it is applied, approving or editing any account fails with
`ERROR: 23514 ... violates check constraint "staff_accounts_role_check"`.
Everything else in this release is applied and verified. The Owner-only
guarantee on the Credits page is enforced in the database, not just the UI: I
confirmed the three `wire_credits_people_*` write functions actively refuse an
`anon` caller.

Tables `articles`, `staff` and `credits_people` are all currently empty, which
is expected for a fresh install.

### The three migration failures and how they were resolved

All three were diagnosed from the error text, fixed in the committed SQL, and
confirmed by re-probing. They are recorded because the fixes are load-bearing,
not cosmetic.

#### 1. `007_article_ownership.sql` — `ERROR: 42883: function min(uuid) does not exist`

The backfill that linked existing articles to their author tried to pick one
account per name with `min(id)`. **Postgres has no `min` aggregate for `uuid`.**
Rewritten as `min(id::text)::uuid`, which sorts identically and casts back.

#### 2. `006_roles_and_privileges.sql` — `ERROR: 23514`, role CHECK ordering

The script tried to rewrite rows to `'Writer'` before the constraint that
rejected `'Writer'` had been replaced. Postgres evaluates statements in order,
so the normalising `UPDATE` was blocked by the very constraint the migration
existed to fix. The constraint is now dropped first, the data normalised, then
one correct guard added.

#### 3. `staff_accounts_role_check` still rejects `'Writer'` — **the live one**

```
ERROR:  23514: new row for relation "staff_accounts" violates check
        constraint "staff_accounts_role_check"
DETAIL:  Failing row contains (..., 'editor', ..., 'Editor', 'Writer',
         'active', ...)
```

The failing row's role is `'Writer'` — the value the entire product now uses.
So the constraint doing the rejecting **is not the one in `credentials.sql`**;
that file already listed `'Writer'`. A second, older CHECK was still live, from
before the Editor-to-Writer rename.

The reason the earlier fix appeared to succeed but changed nothing: it dropped
the constraint *by literal name*. A differently-named copy, or a second copy
added by a re-run, simply does not match and is never dropped. The migration
reports success and leaves the old CHECK in place, so the next write fails with
the identical error and the fix looks like it did not take.

`supabase/010_diagnose_role.sql` reports the truth first — run it before
repairing anything. It is pure `SELECT`: the live table definition, every CHECK
on the `role` column with its exact expression, every role value currently
stored, and the set of values the guard would accept. It writes nothing and
cannot break anything, so you can send me its output and I can confirm the cause
instead of guessing again.

`supabase/011_repair_role_constraint.sql` is the fix. It replaces `010`, which I
withdrew: two defects were found in it during review, and it should not be run.

- **Matches constraints by column identity, not by text.** It resolves the
  `role` column to its `attnum` from `pg_attribute` and drops every `pg_constraint`
  row whose `conkey` contains that attnum. Nothing depends on the constraint's
  name or on its definition being phrased a particular way, so a stale copy
  cannot survive being missed.
- **Self-tests, in the same transaction.** It inserts a throwaway probe row with
  `role = 'Writer'`, confirms the row came back, and deletes it — inside a
  `BEGIN`/`ROLLBACK` that discards the probe no matter how the script exits. If
  the probe had been left outside the rollback it would have become a real
  account; if the repair had been wrapped in the same rollback it would have
  undone itself. Both mistakes were caught in review and are the reason this
  version is a different file rather than an edit.
- **Normalises every row to a real role**, case-insensitively, so `editor`,
  `reporter`, `managing editor` and `photographer` all fold onto one. Anything
  unrecognised falls to `Writer`, the weakest role, so a stray value can never
  grant more access than intended. `is_owner` is honoured first, so the Owner
  seat is never demoted by a leftover role string.
- **De-duplicates `is_owner` to at most one row**, deliberately by removal rather
  than by promotion: choosing which account becomes the Owner from a query would
  hand the entire Control Center to an arbitrary row.
- **Adds exactly one guard** matching `ROLES` in `src/lib/auth.js`, then asserts
  its own result and raises with the offending rows named rather than reporting
  success with bad data behind it.

Everything runs inside one `DO` block, so it is atomic. The Supabase SQL Editor
wraps a paste in a single implicit transaction, which means a mid-script failure
rolls the whole thing back and leaves the table untouched — that is what makes a
half-applied fix indistinguishable from no fix, and it is why the statement
order matters.

Idempotent, and safe to run before or after 006.


## [Unreleased]

### Added
- **Credits page rebuilt as its own roster, editable only by the Owner.**
  Previously the page was derived from the `staff` table, so it listed every
  account that existed rather than the people the Owner had chosen to credit.
  It is now backed by a dedicated `credits_people` table and nothing else — a
  contributor with no account can be credited, and an account that is not
  credited does not appear.
- **"Add new person"** on the Credits tab: photo (file upload or pasted URL),
  name, a free-text role, a role colour and a one-line blurb. The role is a
  plain text field, not a fixed list — the Owner can type a label that has no
  counterpart in the staff roles (a patron, a funder, a volunteer) and it is
  stored and displayed verbatim.
- **"Copy role colour"** lifts the colour off another person's card and applies
  it to the one being edited, so a shared role stays visually consistent without
  re-picking a hex value each time. It is available on every card and on the
  add form.
- **`scripts/credits-check.mjs`** — 7 checks driven through the real UI in
  Chromium: the Owner-only tab gate, the add form, the typed role, the colour,
  copy-colour-from-another-person, and survival across a reload.
  Wired up as `npm run test:credits`.
- **The Login button now says who it is for.** It reads "Press login" with an
  `aria-label` of "Press login. Press members only.", so readers are not led to
  expect a reader account that does not exist. Verified in a real browser: the
  signed-out header shows the button, the label is correct, and it is exposed to
  screen readers.
- `supabase/007_article_ownership.sql` — adds `articles.author_account_id` and
  replaces the blanket `articles_staff_write` policy with per-role DELETE
  policies: a Writer may delete only articles they authored, the Owner may
  delete any. Enforced in the database, so it holds even with a leaked anon
  key. Idempotent.
- `supabase/008_reset_non_owner_accounts.sql` — keeps only the Owner row, deletes
  every other `staff_accounts` row and wipes `wire_sessions` so all browsers are
  logged out. Wrapped in a transaction, prints what it removed and asserts the
  result. **Not yet run.**
- `supabase/010_diagnose_role.sql` — **read-only diagnostic.** Reports the live
  `staff_accounts` definition, every CHECK on the `role` column with its exact
  expression, and every role value currently stored. Pure `SELECT`, so it cannot
  change anything. Run this and send me the output; it settles which constraint is
  actually rejecting your rows instead of me inferring it.
- `supabase/011_repair_role_constraint.sql` — repairs the `staff_accounts.role`
  CHECK that still rejects `'Writer'` and blocks every account approval. It
  supersedes `010_repair_role_constraint.sql`, **which is withdrawn and must not be
  run.** It resolves the `role` column to its `attnum` and drops every CHECK whose
  `conkey` contains it — matching by column identity, so a stale copy cannot
  survive being missed. It normalises every row to a real role, de-duplicates
  `is_owner`, re-adds exactly one guard matching `ROLES` in `src/lib/auth.js`,
  then self-tests by inserting a probe row with `role = 'Writer'` inside a
  `BEGIN`/`ROLLBACK` that discards it. Raises if any row still violates the guard.
  **Run this after the diagnostic.**

### Changed
- The Credits tab is gated on **Owner** specifically, not on "any elevated
  role". A Board Manager can open the Newsroom Panel but neither sees the tab
  nor reaches its data. This is enforced in Postgres as well as the UI: every
  write goes through a `wire_credits_*` function that raises unless `is_owner()`
  is true, so a leaked anon key cannot edit the credits page.
- "Owner Control Centre" is gone everywhere (`src/`, `index.html`, docs). The
  panel is the Newsroom Panel — a screen the whole team works in, not the
  Owner's private one. A regression test asserts the old wording cannot return.
- **The role is "Writer", not "Editor."** All user-facing strings, dropdown
  labels, seed data and SQL now say Writer. `supabase/006_roles_and_privileges.sql`
  and `supabase/011_repair_role_constraint.sql` normalise legacy `'Editor'` rows
  to `'Writer'`, so existing accounts keep working. The role set is `Owner`,
  `Board Manager`, `Writer`; the never-real `Reporter` is gone and folds into
  `Writer`.
- **`credentials.sql` no longer creates a database born broken.** Its
  `staff_accounts` CHECK listed the retired `'Editor'` alongside the real roles,
  and `wire_approve_account` defaulted to `'Editor'` while validating against
  `('Owner','Editor','Board Manager')` — so it rejected `'Writer'` with
  "Unknown role" and the Owner could not approve anybody at all. The CHECK now
  lists exactly the three real roles and refuses the retired spelling, and the
  approval function defaults to `'Writer'` while folding a stray `'Editor'` onto
  it rather than failing. A fresh install from this file alone is now correct
  without needing 006 or 011 to patch it afterwards.

### Security
- Writers can delete only their own articles, enforced by RLS rather than by the
  UI. The client-side check is an affordance that keeps the button honest; the
  database is the real gate.
- Accounts, Changelog, Branding, Security and Credits are Owner-only and gated
  against the live session.

### Fixed
- **Demo mode now persists credits entries.** In demo mode `addPerson` returned a
  fabricated object and never stored it, so a person added in the local demo
  vanished on the next repaint. The demo store is now a real local list that
  survives a reload, which is what let the credits checks assert persistence.
- **The Owner can now delete articles.** This was the headline bug and it was
  not an RLS problem. `mergeState()` in `src/lib/store.js` ran every list
  through `next.x?.length ? next.x : seed.x`, which reads "Postgres returned zero
  rows" as "we have no data yet" and re-injected the demo seed. Because
  `articles` was empty on the live database, the Content tab rendered four fake
  `seed-article-N` stories. `isPersistedId()` then correctly refused to send a
  text id to a `uuid` column, so no database call was made, the in-memory
  removal was discarded because production never writes localStorage, and the
  story reappeared on the next hydrate. A remote payload is now treated as
  authoritative — an empty table is an empty table.
- Article delete is honest about failure. PostgREST reports success even when
  RLS matched zero rows, so the delete now asks for the row back and raises a
  real error instead of reporting a deletion that never happened.
- Stale curation pointers cleared. `site_settings.weekly_slots` and
  `todays_pick_id` are jsonb that held `seed-article-N` ids pointing at rows
  that never existed. They are dropped at load and no longer fall back to
  localStorage, so the Curation tab stops looking populated with ghosts.
- **The portrait gate was open for everyone.** `portraitRequirementMet()` and
  `publishPortrait()` tested `session.isAdmin` to exempt the Owner, but since
  the roles were split `isAdmin` means "may open the workspace" and is true for
  *every* active account. Writers were therefore exempt from the portrait
  requirement entirely. Both now test `isOwner`.
- The demo seed used two roles that never existed (`Assignment Manager`,
  `Senior Investigative Editor`, `Photojournalist`). No CHECK constraint
  accepted them, so the seed rows disagreed with the UI about what they were.
  Corrected to `Board Manager` and `Writer`.
- `scripts/smoke.mjs` targeted `#auth-signin-email`, a field that is actually
  `#auth-signin-login`, so its sign-in checks could never have passed. Fixed,
  and the smoke suite now runs green.
- The changelog feed crashed the whole app when the new release-assurance
  sections were added. Registering them in `src/lib/changelog.js` needed three
  more headings in the sort order, and two of them were written as bare
  identifiers (`Verified,`) rather than quoted strings. That is a shorthand
  property reference to a variable that does not exist, so it threw
  `ReferenceError: Verified is not defined` at module load — before any render,
  which blanked the page and failed all three suites at once. The strings are
  quoted and a comment records why. The sort order now covers every heading the
  markdown actually uses.
- `supabase/006_roles_and_privileges.sql` could not be applied at all — it failed
  with `ERROR: 23514`. The migration folds the legacy `Editor` role onto
  `Writer`, but the `UPDATE` ran while the *old* CHECK constraint was still
  attached, and that constraint only accepted `Owner` and `Editor`, so writing
  `Writer` was rejected. The migration now drops the CHECK, normalises the rows,
  and re-adds the CHECK asserting the real three roles — relax, mutate, then
  assert. The order is deliberate: had the drop come after the failing `UPDATE`,
  the abort would have left the table with no CHECK at all.
- `supabase/007_article_ownership.sql` failed with `ERROR: 42883:
  function min(uuid) does not exist`. The ownership backfill used `min(id)` to
  pick one account per author name, and Postgres has no `min()` aggregate for
  `uuid`. Because the aggregate sat in the same statement as the backfill, the
  abort happened before the RLS policies further down the file were created,
  leaving the database half-migrated. Now `min(id::text)::uuid`: the cast gives
  `min()` a sortable type, canonical hyphenated uuids sort lexically in a stable
  order, and the round trip is lossless.
- Mojibake and a stray UTF-8 BOM cleared from `src/lib/auth.js`,
  `src/styles.css`, `src/views/public.js` and `scripts/smoke.mjs`.
- The encoding lint now lives at `scripts/encoding-check.mjs` (run with
  `npm run lint:encoding`). The old `scripts/check-encoding.mjs` name was
  silently excluded by a `check-*.mjs` rule in `.gitignore`, so the script could
  never have been committed.

### Verified
- `npm run build` — 65 modules, built in ~3s.
- `npm test` (`tests/roles.mjs`) — Writer, Board Manager and Owner all PASS.
  Tabs 4 / 9 / 13 respectively, nothing leaked downward, all tabs render, delete
  scoping correct, no console or page errors.
- `npm run test:credits` (`scripts/credits-check.mjs`) — 7/7 PASS. Owner sees the
  Credits tab, a Board Manager does not, a typed role of "Patron" survives, the
  colour saves, copy-colour moved the hex to match the source card, and the entry
  survives a reload.
- `node scripts/smoke.mjs` — all checks passed.
- `npm run lint:encoding` — 56 tracked files clean UTF-8, no BOM, no C1 controls.
- `npm audit --omit=dev` — no vulnerabilities.
- **Live database confirmed applied.** Every function this release depends on was
  called with its real signature and returned a real answer rather than
  `PGRST202`. All three `wire_credits_people_*` write functions were probed with
  `anon` and each refused with "only the Owner can change the Credits page", so
  the Owner-only guarantee is confirmed at the database level, not just the UI.
- **Disclosure:** one probe called `wire_register_device`, which is a write
  function, and it returned `"subscribed"`. I then checked
  `wire_subscriber_count()` — a SECURITY DEFINER `count(*)` with no RLS
  filtering — and it returns `0`, and a direct select of `push_subscriptions`
  returns `*/0`. **No row was created.** The return value is misleading; the
  table is genuinely empty. I did not intend to call a write function and have
  not done so since.

### Outstanding — one item, and it needs you
- **The role CHECK is still broken.** Run these two files, in this order:
  1. `supabase/010_diagnose_role.sql` — read-only, cannot change anything. Send me
     the output so the actual constraint is confirmed rather than inferred.
  2. `supabase/011_repair_role_constraint.sql` — the repair, with a self-test.

  Until then, approving or editing any account fails with
  `ERROR: 23514 ... violates check constraint "staff_accounts_role_check"`, and
  the next write fails with the identical error no matter what else is fixed.
  Do **not** run `010_repair_role_constraint.sql`; it is withdrawn.
  Nothing else in this release is blocked on it.
- `supabase/008_reset_non_owner_accounts.sql` is available but deliberately not
  run. It deletes every non-Owner account and logs all browsers out.
- Push delivery still requires a server-side sender. Browsers subscribe and
  store endpoints, and 004 is applied, so registration works — but broadcasts
  only reach a tab that is currently open.
- The live database is empty (`articles`, `staff`, `credits_people` all have 0
  rows), so the app will look empty until the Owner adds real content.

### Untested
- **Article delete has not been exercised against the live database end to end.**
  The fix (no demo seed re-injected on an empty table) and the RLS scoping are
  both in place and the ownership column is present, but every delete path I ran
  was against the demo store. Worth one manual delete by the Owner on a real
  article to confirm the whole chain.
- The Credits page has never had a real row written to the live
  `credits_people` table — the Owner gate correctly refused every `anon` write I
  attempted. The first real entry is yours to make.

## [1.0.0] — 2026-09-29

First production release: the public publication and the Newsroom Panel.

### Added
- **Public publication** — front page, Today's Pick, three weekly feature slots,
  public assignment board, photo gallery and archive search.
- **Newsroom Panel** — content desk, assignments, staff, media shelf,
  breaking-news bar, broadcast centre, branding and settings. Every control is
  database-backed; no privileged markup ships to unauthenticated visitors.
- **Username sign-in** — staff enter a username, not an e-mail address. Each
  resolves to a derived shadow address (`<username>@users.thewire.press`) that is
  never shown or typed. Existing real e-mail addresses continue to work.
- **Account approvals** (`c493e54`) — registrations land in a `pending` queue and
  cannot sign in until the Owner approves them. Approval assigns the role.
  `Owner` is deliberately not offered; there is exactly one Owner.
- **Staff portraits on bylines** (`22ef775`) — approved portraits render as
  sticker bylines across cards, Today's Pick, weekly slots, article bodies and
  search results, falling back to plain text. The Owner attaches and approves
  portraits from the Staff editor, where a portrait is required on hire.
- **Credits board** (`53ee566`) — the public roster is driven by the usernames
  on the staff table; the Owner chooses who appears and in what order.
- **Broadcasts** — targeted or all-subscriber, with an in-app delivery history.
- **Deploy docs** — `DEPLOY.md` covers the Vercel variable list, Supabase
  redirect URLs and VAPID key handling.

### Security
- Row Level Security verified against the live database as an anonymous client:
  published articles are readable; `staff`, `audit_logs` and `broadcasts` are
  not. All privileged writes go through `SECURITY DEFINER` functions.
- VAPID private key is never referenced by client code. Only the public key
  ships in the bundle.
- The Vercel build heap is raised to 4 GB and Node is pinned to 22.
- `0 vulnerabilities` (`npm audit`).

### Fixed
- The Vercel build failed because devDependencies were not installed; `vite` is
  now present at build time.
- Front page rendered zero articles: status filtering compared against
  `'Published'` while the database stores `published`. Matching is now
  case-insensitive (`001_fix_status_case.sql`).
- Two `undefined` strings appeared on the page. Renderer return values were
  being assigned back into the DOM, wiping the markup.
- Masthead "Save branding" did nothing. The form had no submit handler branch
  and was falling through to a native submit, discarding input on reload.
- Broadcast creation failed when `requires_action` was absent;
  `createBroadcast` now degrades to the core columns and warns.
- Device registration was blocked by RLS (`42501`) (`004_device_registration.sql`).
- The Owner panel overflowed horizontally and could not be scrolled to; CSS
  overrides were being captured by `@layer components` and losing the cascade
  (`d64da7a`).
- Gallery toggle crash, mobile nav auto-opening, Android admin scrolling,
  and header links from the Credits page and Owner panel.
- iOS readers are given honest push guidance rather than a silent failure.

### Known limitations
- Web Push needs a server-side sender to reach closed tabs.
- See **Unreleased** for the outstanding migration.

[Unreleased]: https://github.com/Millard-alt/thewire/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/Millard-alt/thewire/releases/tag/v1.0.0
