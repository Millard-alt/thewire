# Changelog

All notable changes to The Wire are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

Migrations are numbered and live in `supabase/`. They are additive and
idempotent, so re-running one is safe. **A new release is not functional until
its migrations have been run in the Supabase SQL Editor.**

## Live database status

Verified against `iguzwwqjufzzdblkqroj` on 10 Oct 2026.

### 0. Signup FIXED (012 applied). Approval then failed with "Unknown role."

Signup works now, so the first `012` paste landed. Setting a role on an account
then raised `Unknown role.` immediately.

**Cause: a bug I introduced in the same migration.** The `012` I wrote declared

```sql
v_role text := lower(trim(coalesce(p_role, '')));   -- WRONG
```

which lowercases the role on the way *in*. The client sends `'Writer'`; it
arrived as `'writer'`; the very next line compared it against the canonical
capitalised names with `v_role not in ('Owner','Writer','Board Manager')`,
so it failed and every approval raised `Unknown role.`

Fixed in both `012_fix_live_signup_function.sql` and `credentials.sql`: the
value is kept as sent, the legacy `'editor'` alias is matched case-insensitively,
and a separate `case lower(v_role)` normalises *to* the canonical spelling
*without* changing what is stored. `'writer'`, `'WRITER'`, `'Writer'` and the
stale `'Editor'` all resolve correctly now.

**Why the migration's own probe missed it:** the probe only inserted the three
canonical spellings and asserted the CHECK accepted them. That proves the
constraint is healthy — it cannot see a bug in the normalisation *before* the
constraint. A new step evaluates the real normalisation expression against all 8
input spellings, as a pure SELECT: no rows written, and it raises naming the
failing input rather than reporting success.

### 0b. Portrait upload — ROOT CAUSES FOUND, FIX WRITTEN, NOT YET APPLIED

`new row violates row-level security policy`, followed by a 400 on
`POST /storage/v1/object/wire-media/portraits/...`. Two independent causes, both
measured against the live database rather than inferred:

1. **The bucket had no policies at all.** `storage.objects` carried no policies
   for `wire-media`, so every insert was rejected — the "no rows in policy" that
   presents as a generic RLS violation. `uploadSquare()` uses `upsert: true`, so
   a retry is an **UPDATE** and needs its own policy; without it the retry looks
   like the same fresh failure.

2. **The function looked up the wrong identity.** `wire_submit_portrait`
   resolved the caller with `auth.uid()`, which is always `NULL` because this
   project uses custom auth instead of Supabase Auth. Even with the upload
   allowed, the submission would have had no row to write. It now resolves via
   `current_staff_id()`, which joins `staff_accounts` to `staff` on the username
   — the identifier this system actually uses. Confirmed present on both live
   tables before writing the fix.

`staff.auth_user_id` is deliberately left alone. `schema.sql` gives it a foreign
key to `auth.users`, which is empty in this project, so backfilling it raises
`23503` — and because the SQL Editor runs a paste in one implicit transaction,
that single UPDATE would roll back the policies and the function above it. A
repair file cannot contain the failure mode it exists to end.

> ### Action required
> **Paste `supabase/013_portrait_upload_and_identity.sql`** into the Supabase SQL
> Editor. It is idempotent — every policy is dropped before it is created, so
> re-running cannot raise `42710` and roll the paste back the way an earlier
> revision did.
>
> The role fix above still needs **re-pasting `supabase/012_fix_live_signup_function.sql`**.
> Run `013` first, then `012`; order between them does not matter.

### 1. Signup is broken — ROOT CAUSE FOUND, FIX WRITTEN, NOT YET APPLIED

`ERROR: 23514: new row for relation "staff_accounts" violates check
constraint "staff_accounts_role_check"`

**The CHECK constraint is correct.** This was never a constraint bug, and every
attempt to fix it by dropping the constraint was treating a symptom.

Measured directly against the live database by inserting one throwaway row per
candidate role and deleting it again:

```
role="Writer"    ACCEPTED
role="Board Manager"  ACCEPTED
role="Owner"     ACCEPTED
role="Editor"    REJECTED  23514
```

So the constraint already allowed `Writer`, which is the only value
`wire_request_account` should ever insert. The live copy of that function is a
**stale pre-rename body that still hardcodes `v_role := 'Editor'`**, and
`'Editor'` is not in the constraint's set — hence the identical error on every
signup, for four rounds of migrations that each reported success.

Migration `006_roles_and_privileges.sql` tightened the CHECK and changed the
client, but **never redefined the function**. Supabase keeps the function body it
was last given; editing `credentials.sql` in the repo changes nothing on the
server until that file is pasted.

**To fix: paste `supabase/012_fix_live_signup_function.sql` into the Supabase
SQL Editor.** It redefines the signup and approve functions with `'Writer'`, and
its step 4 calls `wire_request_account` exactly as the browser does, asserts the
row lands as a pending Writer, then deletes it. A migration that cannot create a
Writer does not count as a repair.

### 1a. First paste attempt FAILED — and rolled back the fix with it

```
ERROR: 42710: constraint "staff_accounts_role_check" for relation
       "staff_accounts" already exists
```

The SQL Editor runs a pasted script in one implicit transaction, so that error
discarded **everything** in the paste, including the function redefinitions from
steps 1 and 2. **Signup is still broken** — nothing was applied.

Three separate defects in that revision, all of which would have failed on a
perfectly healthy database. This is the recurring lesson of this bug: a step
that "has nothing to change" must be a genuine no-op, never a step that can fail.

1. **Step 3 dropped the constraint only when it was already correct** — its
   guard tested `definition not ilike '%board manager%'`, which is false
   precisely when the constraint lists all three roles. So it skipped the drop
   and the unconditional `ADD` then raised 42710. Now it discovers every CHECK on
   the role column by name from `pg_constraint` and drops them all,
   unconditionally, so the step is idempotent in both the "already correct" and
   "stale" cases.
2. **The probe username began with `_`**, which `wire_request_account` rejects
   via `^[a-z0-9][a-z0-9._-]{2,31}$`. It would have raised before ever reaching
   the INSERT.
3. **`select id, role, status into ...` from a function returning `jsonb`**
   raises `column id does not exist` — the result is one jsonb document, not a
   three-field composite. It now reads the keys with `->>`.

All three were caught by static review, not by execution: this machine has no
`psql`, no Docker and no Supabase CLI, so **the SQL has still never been run.**
It is reviewed, not verified.

Also folded into the same file: `wire_approve_account` had
`p_role default 'Editor'` and a guard reading
`if v_role not in ('Owner','Editor','Board Manager')` — which *rejected* `Writer`,
the one role the client actually sends. Approval raised `Unknown role.` even once
signup worked. Both `012` and `credentials.sql` are corrected.

### 2. The service_role key cannot repair this

Worth recording, because it was asked twice. PostgREST can only call functions
that exist in the schema, and this project has no arbitrary-SQL RPC
(`exec_sql` → `PGRST202`). `service_role` bypasses RLS on tables and calls
existing RPCs, but `ALTER TABLE ... DROP CONSTRAINT` is DDL and DDL only runs
from the SQL Editor. It is a powerful diagnostic tool — it is how the table
above was measured instead of guessed — but it cannot apply a fix.

**Do not reset the database.** A reset cannot fix this: it recreates
`staff_accounts` from `credentials.sql` with the same three-role CHECK, landing
back on the same error, and it destroys the Owner seat and every approved
session to do it.

### 3. Migration status

| Migration | State | Effect if not run |
|---|---|---|
| `schema.sql`, `credentials.sql`, `001`, `002` | applied | — |
| `003_subscriptions_and_gallery.sql` | **applied** | — |
| `004_device_registration.sql` | **NOT applied** | `wire_register_device` / `wire_unregister_device` return 404, so a reader who turns on alerts is silently not subscribed. Broadcasts stay in-app only. |
| `005_portraits_and_credits.sql` | **NOT applied** | No `portrait_url` / `portrait_status` / `credits_*` columns. **The Credits tab and the forced-portrait signup flow cannot work.** `wire_submit_portrait`, `wire_assign_portrait`, `wire_set_portrait_status`, `wire_set_credits` all return 404. |
| `006_roles_and_privileges.sql` | **partially applied** | `is_owner()` exists but `wire_default_permissions` returns 404, so the capabilities jsonb falls back to the `{}` default. |
| `007_article_ownership.sql` | **NOT applied** | No `articles.author_account_id`. Writer-scoped deletes are **not** enforced in the database; the blanket `articles_staff_write` policy still lets any staff account delete any article. |
| `008_reset_non_owner_accounts.sql` | **not yet written to prod** | Deletes every non-Owner account and logs all browsers out. |
| `009_credits_page.sql` | **NOT applied** | No `credits_people` table. **The remade Credits page cannot save anything** — every write goes through a `wire_credits_*` RPC, all of which return 404. |

**Run these six, in this order, in the Supabase SQL Editor:**

1. **`supabase/012_fix_live_signup_function.sql` — FIRST, signup is broken until
   this is applied**
2. `supabase/004_device_registration.sql`
3. `supabase/005_portraits_and_credits.sql`
4. `supabase/006_roles_and_privileges.sql`
5. `supabase/007_article_ownership.sql`
6. `supabase/009_credits_page.sql`

Then run `supabase/008_reset_non_owner_accounts.sql` last — it logs everyone out,
so do it once the others are in place.

Until 005, 007 and 009 are applied, **the site is not production ready**: the
Credits tab has nothing to write to, the portrait gate has no column to check, and
the writer-scoped delete guarantee is client-side only. The client degrades safely
in all three cases (it probes for the ownership column and omits it if absent, and
every missing RPC surfaces a message naming the migration to run), so nothing
crashes — but the guarantees are not real yet.

## [Unreleased]

### Fixed
- **Signup no longer dies on `staff_accounts_role_check`.** Root cause was a
  stale server-side `wire_request_account` still inserting the pre-rename role
  `'Editor'`; the CHECK was right all along. `012_fix_live_signup_function.sql`
  redefines it with `'Writer'`. **Requires the SQL Editor paste to take effect.**
- **Account approval no longer raises `Unknown role.`** `wire_approve_account`
  defaulted to and validated against `'Editor'` while the client sends
  `'Writer'`. Both it and `credentials.sql` now use the real three-role set and
  fold the legacy spelling on the way in, so a stale browser tab cannot write a
  value the CHECK refuses.
- `src/lib/portrait.js` no longer tests `isAdmin` where it means "is Owner".
  `isAdmin` is true for every active account since the roles were split, so the
  portrait gate was exempting every new writer — the exact opposite of its
  intent. Now correctly uses `isOwner`.
- Seed data no longer invents roles: `'Assignment Manager'` was never accepted
  by anything and was silently folded to `Writer`, and two `top_performers`
  rows carried job titles (`'Senior Investigative Editor'`,
  `'Photojournalist'`) where a role belongs.

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

### Changed
- The Credits tab is gated on **Owner** specifically, not on "any elevated
  role". A Board Manager can open the Newsroom Panel but neither sees the tab
  nor reaches its data. This is enforced in Postgres as well as the UI: every
  write goes through a `wire_credits_*` function that raises unless `is_owner()`
  is true, so a leaked anon key cannot edit the credits page.

### Pending — required before these features work
- `supabase/009_credits_page.sql` must be run in the Supabase SQL Editor before
  any of the above works against the live database. Until then the Credits tab
  renders and the Owner-only gate holds, but every save returns a message naming
  the migration. No data was written to the live database while building this.

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
- Mojibake cleared from `src/lib/auth.js`, `src/styles.css` and
  `src/views/public.js` (11 sequences: em dashes, one ellipsis, one middle dot).
  Every repair was made by explicit byte mapping, not a blanket rewrite: the
  tree also contains *correct* em dashes and middle dots, and two earlier
  automated attempts corrupted those instead of the mojibake.
- **The ad-hoc encoding scripts are gone, folded into one tool.** Four
  throwaway `_*.mjs` probes were deleted and `scripts/encoding-check.mjs` is now
  the only encoding checker, reporting codepoint numbers rather than rendered
  text (the PowerShell console renders a correct U+2014 exactly like mojibake,
  which is what made earlier passes unreliable). It is wired up as
  `npm run lint:encoding`.
- **`npm run lint:encoding --fix` could not remove a BOM.** It reported the file
  fixed, then found the same BOM on the next run. `buf.toString('utf8')` keeps
  the BOM as a U+FEFF *character*, so writing the decoded string back re-emitted
  the very bytes it was meant to delete. The decoder now strips it first, and the
  write is no longer conditional on C1 controls shrinking. Cleared the BOM from
  `scripts/credits-check.mjs`; all 58 tracked files are clean.
- Five `tmp-*.txt` scratch files that had been committed by mistake are removed
  from the repo, and `tmp-*.txt` / `tmp-*.cjs` are gitignored so a debugging
  session cannot leave them behind again.

### Added
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

### Security
- Writers can delete only their own articles, enforced by RLS rather than by the
  UI. The client-side check is an affordance that keeps the button honest; the
  database is the real gate.
- Accounts, Changelog, Branding and Security are Owner-only and gated against
  the live session.

### Changed
- "Owner Control Centre" is gone everywhere (`src/`, `index.html`, docs). The
  panel is the Newsroom Panel — a screen the whole team works in, not the
  Owner's private one. A regression test asserts the old wording cannot return.
- **The role is "Writer", not "Editor."** All user-facing strings, dropdown
  labels, seed data and SQL now say Writer. `supabase/006_roles_and_privileges.sql`
  accepts both spellings and normalises legacy `'Editor'` rows to `'Writer'`, so
  existing accounts keep working. The role set is `Owner`, `Board Manager`,
  `Writer`; the never-real `Reporter` is gone and folds into `Writer`.

### Verified
- `npm run build` — 65 modules, built in ~3s.
- `npm test` (`tests/roles.mjs`) — Writer, Board Manager and Owner all PASS.
  Tabs 4 / 9 / 13 respectively, nothing leaked downward, all tabs render, delete
  scoping correct, no console or page errors.
- `node scripts/smoke.mjs` — all checks passed.
- Live database re-checked read-only throughout. No writes were made.

### Pending — required before these features work
- **Run these three files in the Supabase SQL Editor, in this order:**
  1. `supabase/005_portraits_and_credits.sql`
  2. `supabase/006_roles_and_privileges.sql`
  3. `supabase/007_article_ownership.sql`
- Then, if you want everyone logged out and only the Owner kept:
  4. `supabase/008_reset_non_owner_accounts.sql`
- Confirmed against production: `staff.portrait_url` does not exist yet, and
  `wire_default_permissions` is absent from the schema cache (`PGRST202`). Until
  005 and 006 are applied, portraits do not appear on bylines, the Credits
  roster is empty, and the browser role gating is client-side only.
- Push delivery still requires a server-side sender. Browsers subscribe and
  store endpoints, but broadcasts only reach a tab that is currently open.

### Untested
- Article delete against the live database was **not** exercised end to end. The
  fix removes the seed that caused it and the ownership column is written only
  once 007 has been applied, so the first real delete should be checked by hand
  after running the migrations.

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
