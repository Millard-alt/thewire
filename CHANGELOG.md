# Changelog

All notable changes to The Wire are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

Migrations are numbered and live in `supabase/`. They are additive and
idempotent, so re-running one is safe. **A new release is not functional until
its migrations have been run in the Supabase SQL Editor.**

## [Unreleased]

### Security
- **Editors no longer receive the Newsroom Panel.** `toSession()` in
  `src/lib/auth.js` was hardcoding `isAdmin: true` for *every* signed-in
  account, so any account the Owner had approved landed on the full Owner
  panel with Accounts, Branding, Security and Changelog all live. `isAdmin` now
  means only "may open the workspace"; privilege is decided by the account's
  role. Verified in a real browser for all three roles: an Editor sees 4 tabs, a
  Board Manager 9, the Owner all 13, with nothing leaking downward.
- **Roles reduced to exactly three:** `Editor`, `Board Manager`, `Owner`. The
  never-real `Reporter` role is gone from the UI, the capability map and the
  database CHECK constraint; it is folded into `Editor`, the weakest role, so
  nobody silently loses access. Any unrecognised role now normalises to `Editor`
  rather than being trusted.

### Added
- Per-tab role gating (`minRole`) plus `ownerOnly` for the four Owner-only tabs
  (Accounts, Changelog, Branding, Security). Every consumer reads the gated
  list, so a hidden tab is genuinely absent rather than merely concealed.
- A "What each role can do" guide in the Staff tab, generated from the same
  capability map the database enforces.
- `supabase/006_roles_and_privileges.sql` — relaxes the `staff_accounts.role`
  CHECK to accept `Board Manager`, migrates any legacy `Reporter` row, and
  re-states `wire_default_permissions()` and `wire_approve_account()` for the
  three real roles. Idempotent.

### Fixed
- Account role dropdowns and the removal guidance no longer mention `Reporter`.
- Panel headings are role-aware: an Editor is told they are on the "Editor
  Desk" rather than being shown Owner wording.
- Demo sign-in no longer refuses a workspace to anybody outside
  `VITE_ADMIN_USERNAMES`. It used to set `isAdmin` from the allow-list, so in
  the demo an Editor account got no panel at all and the role gating could not
  be reviewed. Now every demo sign-in opens a workspace and the role decides
  the tabs, exactly as in production: first allow-list entry is the Owner, a
  later entry is a Board Manager, anyone else is an Editor.
- `tests/roles.mjs` (wired to `npm test`) is a real regression test for all of
  the above. It signs in as each of the three roles, checks the app resolved the
  role it expected, asserts the exact tab list, and fails loudly if any
  Owner-only tab leaks downward. It caught two real problems: the demo sign-in
  dead end above, and a migration-ordering bug in 006. Run it against the demo
  dev server:

  ```
  node node_modules/vite/bin/vite.js --mode demo --port 5201
  set BASE_URL=http://localhost:5201/ && npm test
  ```

### Pending — required before these features work
- Run `supabase/005_portraits_and_credits.sql`. Approved portraits do not
  currently appear on bylines and the Credits roster is empty until it is
  applied. Verified against production: `staff.portrait_url` does not yet exist.
- Run `supabase/006_roles_and_privileges.sql`. Verified against production just
  now: `wire_default_permissions` does not exist in the schema cache at all
  (`PGRST202`), and the `staff_accounts.role` CHECK still carries the old role
  set. Until it is applied, approving somebody as Board Manager will fail and
  the capability map is unavailable server-side. The browser gating above is
  client-side only until then; the database is the real gate and must be
  brought in step.
- Push delivery still requires a server-side sender. Browsers subscribe and
  store endpoints, but broadcasts only reach a tab that is currently open.

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
