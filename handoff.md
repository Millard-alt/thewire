# The Pulse — Handoff

Project: `D:\website\Finalver` · branch `main` · **12 commits ahead of `origin/main`, nothing pushed**

Date: 2026-10-09

---

## 1. Goal

Defensive security audit and remediation of The Pulse (`thepulse.us.ci`), a
student news publication with an Owner Control Panel on Supabase.

Requested scope, in order:

1. Audit, **report findings before changing code**, sorted Critical → Low with
   file, line, exploit and fix.
2. Fix approved issues: world-writable storage bucket, fail-open serverless auth,
   over-broad RLS policies.
3. SEO: name the organisation in crawler-visible markup, OG/Twitter cards, JSON-LD,
   logo everywhere.
4. Media approval: a Writer must not be able to post media without Board Manager
   or Owner approval.
5. Panel test suite across all three roles.

Standing constraints the user set: **wait for an explicit "go" before pushing.**
That has not been given.

---

## 2. Current state

### Architecture facts (these drive everything)

- Vanilla ES2022 + Vite 6 + Tailwind v4. No framework.
- **There is no Supabase Auth.** No JWT, no `auth.uid()` — it is always NULL. The
  app has its own opaque session tokens in `localStorage['wire.sessionToken']`,
  sent as the `x-wire-token` header. `supabase/credentials.sql` resolves it:
  `wire_bearer_token()` → `current_account_id()` → `is_staff()` / `is_owner()`.
- `wire_bearer_token()` reads `current_setting('request.headers')::jsonb ->> 'x-wire-token'`
  — a **PostgREST** GUC. Verified empirically that Storage does forward it.
- Roles are exactly `'Owner'`, `'Writer'`, `'Board Manager'` (`ROLES` in
  `src/lib/auth.js`). **There is no "editor" role** — the user's "editor panel"
  means the Writer panel.
- Client attaches the header on every request via `global.fetch: withSessionToken`
  in `src/lib/supabase.js:58`.
- Migrations are applied by hand in the Supabase SQL editor, one file per run.

### Uncommitted change

`src/lib/podcasts.js` — the podcast preflight probe fix (see §4). **Syntax-checked,
build-checked and `npm test` were all still running when the run was aborted, so
this change is NOT yet verified green.** Re-run the suite before committing.

### Live database state — UNVERIFIED

- **036, 037 confirmed applied** by the user.
- **034 and 035 were applied and FAILED**, then fixed. It is unknown whether they
  were ever re-run successfully. **This is the single biggest open risk** — if 034
  was not re-applied, the `wire-media` bucket is still world-writable.

Check with:

```sql
select policyname, roles::text, qual, with_check from pg_policies
 where schemaname='storage' and tablename='objects';
select public.can_manage();   -- errors => 035 never applied
```

### Test infrastructure built this session

| Script | What it does |
|---|---|
| `scripts/migration-apply-check.mjs` | Executes 034–037 against **real Postgres 18** (PGlite/WASM) and asserts the security outcome |
| `scripts/podcasts-storage-check.mjs` | Reproduces the podcast upload failure and proves which of two causes it is |
| `scripts/policy-scope-check.mjs` | Static guards for every migration bug hit below |
| `scripts/panel-check.mjs` | Playwright: all 31 tabs × 3 roles, media approval gate |
| `scripts/api-auth-check.mjs` | Serverless auth gate, verified to fail against the vulnerable code |
| `scripts/seo-check.mjs` | Crawler-visible markup |
| `scripts/og-image.mjs`, `scripts/logo-assets.mjs` | Generate `public/og-image.png` (1200×630) and icon set from `public/logo.png` |

`@electric-sql/pglite` added as a devDependency. All of the above are in the
`npm test` chain.

---

## 3. Active files

**Migrations (new this session, none confirmed applied):**

- `supabase/migrations/034_close_wire_media_storage_policies.sql`
- `supabase/migrations/035_staff_can_manage_and_server_side_audit.sql`
- `supabase/migrations/036_edition_line_drop_invented_volume_number.sql`
- `supabase/migrations/037_media_requires_approval.sql`

**Serverless (was fail-open):**

- `api/send-push.js`, `api/check-deadlines.js`, `api/broadcast.js` (alias)

**Store / UI:**

- `src/lib/store.js` — `wire_log_audit` RPC call, media `status`, approve/reject
- `src/lib/podcasts.js` — **uncommitted** probe fix
- `src/lib/upload.js` — 5 GB guard, gif/avif restored
- `src/views/admin.js` — Approve/Reject buttons, Pending badge
- `src/views/public.js` — masthead no longer stomps the org name
- `index.html`, `public/robots.txt`, `public/manifest.webmanifest`

**Do not touch:** `patch-pod.mjs`, `scripts/patch-byline.mjs`,
`scripts/patch-public.mjs` — the user's untracked scratch files.

---

## 4. Changes made

### Security

**CRITICAL — world-writable bucket (034).** `013` created
`wire_media_insert/update/delete` with *only* `bucket_id = 'wire-media'`. No
`is_staff()`. The anon key ships in the reader's bundle, so anyone could upload,
overwrite and delete objects unauthenticated — and because the bucket is public,
an `.svg` would execute on this site's own origin. 034 adds `is_staff()`, pins the
extension, and sets `allowed_mime_types` with **no** size cap
(`file_size_limit = null`).

It keeps the bucket **root** writable as well as `portraits/`, because
`src/lib/upload.js:53` writes gallery images with no folder prefix. Restricting to
`portraits/` would have broken every gallery image.

**CRITICAL — fail-open auth (send-push.js).** `hasSharedSecret` compared the
bearer against `PUSH_SEND_TOKEN` with no non-empty guard, so with the variable
unset `'' === ''` was **true** and any anonymous caller could push to every
subscriber. Now fails closed via `secretMatches()` with `crypto.timingSafeEqual`,
and `?token=` query auth removed.

**HIGH — nine policies gated on bare `is_staff()` (035).** The panel's role gates
were decorative. Added `can_manage()` (Owner or active Board Manager), re-scoped
the four reserved tables, made audit reads Owner-only, and replaced the audit
insert policy with `wire_log_audit(text)` — SECURITY DEFINER, actor derived from
the session, direct INSERT revoked. `actor_name` used to be **client-supplied**,
so any staff member could forge a log line naming anyone.

**Media approval (037).** `media_assets` had no status column and
`media_public_read` was `using (true)`. 037 adds `status`, **backfills every
existing row to `'approved'`** before attaching the default (adding the column with
`default 'pending'` would blank the live gallery), and gates reads on approval.

### SEO / branding

Title, description, OG, Twitter and Organization JSON-LD; MJLA expanded to
"Melvin Jones Lions Academy" (inferred from the crest — **still needs user
confirmation**); logo in the favicon, icons, manifest and masthead; the invented
"Vol. CXIV – No. 32,841" removed from four places including a live DB migration.

### Panel test suite

Owner 16 tabs / Manager 10 / Writer 5, all opened with zero console errors.
Media: Writer sees Pending + **no** Approve button; Owner and Manager see Approve;
Manager clicking it clears the badge.

---

## 5. Failed attempts

**Every one of these was my own defect, and each cost a production round trip.**

| Error | Cause |
|---|---|
| `unexpected wire_media policy without is_staff(): wire media owner delete` | `_` is a **single-char wildcard** in `LIKE`, so `wire_media%` matched `"wire media owner delete"` |
| `42601 syntax error at or near "'public.is_owner()'"` | `IS NOT` is not a text comparison operator (it is NULL/TRUE/DISTINCT FROM) |
| `42703 column "table_name" does not exist` | `pg_policies` spells it `tablename` |
| `audit_logs read policy is not is_owner(): is_owner()` | `pg_get_expr` **dequalifies** the schema prefix. Worse: an earlier check of mine compared against `'public.is_staff()'` and so **could never match** — it was a verification that verified nothing |

Also: three bare `end` (missing `;`) in `DO` blocks in 034, and again later in
037 — reintroduced during ordinary edits, caught only because the guard existed.

**Wrong diagnoses I gave and had to retract:**

- Claimed the podcast upload needed `auth.uid()` / an auth session header. **Wrong
  and harmful** — would break every policy, since this project has no Supabase Auth.
- Claimed `is_staff()` was false for the account. Wrong; all 14 accounts are active.
- Claimed supabase-js used TUS for large files. Wrong — 2.117.2 `upload()` is a
  single POST.

**Harness bugs that made tests lie (worth knowing):**

- RLS **filters** rows, it does not raise. Only INSERT raises. A denied UPDATE
  "succeeds" matching zero rows.
- Missing GRANTs make every negative pass for the wrong reason.
- Missing `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` makes every negative fail.
- A `DELETE` matches zero rows if the table has no SELECT policy.
- Requests must be made as role `anon`, not `authenticated` — `x-wire-token`
  authenticates the *predicates*, not the role.

**The actual podcast bug (fix written, uncommitted, unverified):**
`src/lib/podcasts.js:250` preflight probe passed `upsert: true`. That sends
`x-upsert: true`, requiring UPDATE authority — but `025` defines **no UPDATE policy**
for the podcasts bucket (only select/insert/delete). Portraits work because `034`
gives `wire-media` an UPDATE policy. The real upload at `:569` already used
`upsert: false`, so only the probe was broken — which blocked the panel before an
upload was ever attempted. Changed to `upsert: false` and rewrote the error message,
which had been wrongly advising the user to re-run 025.

---

## 6. Specific next steps

1. **Verify the uncommitted change.**
   `npm test` → expect exit 0, then `npm run build`. The run was aborted before
   completing. Then commit `src/lib/podcasts.js`.

2. **Confirm 034 and 035 are applied.** Run the two queries in §2. If `can_manage()`
   errors, 035 was never applied. If any `wire_media_*` policy lacks `is_staff()`,
   the bucket is still world-writable. This is the most serious open item.

3. **Deploy and test the podcast fix** on the real site. Delete the probe object
   first: `delete from storage.objects where name = 'podcasts/episodes/curl-probe.mp3';`

4. **Rotate the `service_role` key** committed in `b5dccf7`. Valid until 2036.
   Only the user can do this; no code change invalidates it.

5. **Set `PUSH_SEND_TOKEN` in Vercel** (`Settings → Environment Variables`, then
   redeploy). Push endpoints now fail closed, so notifications are dead until it is
   set. Also confirm the deadline cron exists — there is **no `crons` block in
   `vercel.json`**; it must be dashboard-configured, and it needs `CRON_SECRET` or
   `PUSH_SEND_TOKEN` set as a bearer.

6. **Confirm MJLA = "Melvin Jones Lions Academy"** (inferred from the crest).

7. **Ask for the "go", then push.** Order:
   `034 → 035 → 036 → 037`.

### Known-good commands

```powershell
npm test                      # full suite, expect exit 0
npm run test:migrations       # real Postgres, ~2s
npm run test:panel            # Playwright, starts its own server on :5311
```

### Pre-existing, untouched

`supabase/000_reset_accounts.sql`, `006_roles_and_privileges.sql` and
`008_reset_non_owner_accounts.sql` all contain the same bare-`end` defect. They
will fail if ever run. Out of scope; now trivially testable with PGlite.