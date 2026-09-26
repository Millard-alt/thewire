# Going live with Supabase (production)

The app ships in **demo mode** by default: everything lives in `localStorage` and
no network call is ever made. To run for real you need a Supabase project and
three values in `.env`.

## 1. Create the project

1. Sign up at [supabase.com](https://supabase.com) and create a project.
2. Wait for the database to finish provisioning.

## 2. Create the tables

**SQL Editor → New query**, paste the entire contents of
[`supabase/schema.sql`](supabase/schema.sql) and run it.

The script is idempotent (every object uses `if not exists` / `drop policy if
exists`), so re-running it is safe. It creates all eight tables, the
`is_staff()` helper and the Row Level Security policies.

> If you use a custom `VITE_AUTH_EMAIL_DOMAIN`, edit the one literal in the
> backfill `update` statement near the bottom to match, before running.

## 3. Allow username sign-ins

Go to **Authentication → Sign In / Providers → Email** and:

- **Enable Email sign-in** — turn it on.
- **Confirm email** — turn it **off**.

> **Turning confirmation off is required.** Username accounts sign in through a
> derived shadow address (`chief.owner@users.thewire.press`) which has no inbox,
> so a confirmation e-mail could never be delivered and nobody could ever log in.
> Only enable confirmation again if you switch every staff account to a real,
> readable address.

## 4. Copy the credentials

**Project Settings → Data API**, then copy into `.env`:

| Variable | Where to find it |
| --- | --- |
| `VITE_SUPABASE_URL` | Project URL |
| `VITE_SUPABASE_ANON_KEY` | anon / publishable key |
| `VITE_DEMO_MODE` | set to `false` |
| `VITE_ADMIN_USERNAMES` | your owner usernames, comma-separated |

```ini
VITE_SUPABASE_URL=https://your-real-ref.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGciOi...real-key...9x2Q
VITE_DEMO_MODE=false
VITE_ADMIN_USERNAMES=chief.owner
```

> Only the **anon / publishable** key may ever go in a `VITE_` variable — anything
> prefixed `VITE_` is inlined into the public bundle. Never put the
> `service_role` key here; it bypasses RLS entirely.

`config.js` auto-detects placeholder values, so if you leave
`YOUR-PROJECT-REF` in place the app quietly stays in demo mode rather than
crashing. It will not warn you in the UI, so check the console banner.

## 5. Create the owner account

Staff sign in by username, so the account is created with the **shadow address**:

1. **Authentication → Users → Add user**, e-mail
   `chief.owner@users.thewire.press`, set a password.
2. Run this in the SQL Editor, substituting your real username:

   ```sql
   insert into public.staff (name, username, shadow_email, role, status)
   values ('Chief Owner', 'chief.owner',
           'chief.owner@users.thewire.press', 'Owner', 'Active');
   ```

The `is_staff()` policy matches on `shadow_email` for this first sign-in, then
on `auth_user_id` afterwards, so you do not have to paste the user's UUID.

Once signed in, additional staff can be created from the **Owner Control
Center → Staff**, which provisions the Supabase account for you.

## 6. Seed the publication

The database starts empty, so the front page will show "The archive is empty."
Publish from **Owner Control Center → Articles**, or import the demo content
with this snippet:

```sql
insert into public.articles (title, author, category, body, status)
select * from (values
  ('Rift Valley Farmers Adapt to a Shorter Rains Season',
   'Amina Yusuf', 'Environment',
   'Growers across Nakuru county are re-planting drought-tolerant varieties.', 'Published')
) as v(title, author, category, body, status);
```

## 7. Deploy

| Setting | Value |
| --- | --- |
| Build command | `npm run build` |
| Output directory | `dist` |
| Node version | 20+ |

Add the same `VITE_*` variables under **Project Settings → Environment
Variables** for Production and Preview. Vite inlines them at build time, so
**you must redeploy after changing any variable**.

## 8. Verify before you trust it

- Signed out, the front page must show only `status = 'Published'` stories.
- Signed in as a non-`VITE_ADMIN_USERNAMES` account, there must be **no**
  Admin Panel button, and browsing the Supabase tables must return nothing
  (that is RLS doing its job, not the client).
- **Control Center → Audit log** should record every privileged action.
- Open the browser console: the red demo-mode banner must be **absent**.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| "Could not reach the authentication server" | Project still provisioning, or the URL/anon key is wrong |
| "Invalid username or password" on a known-good account | Shadow address mismatch — check `VITE_AUTH_EMAIL_DOMAIN` matches the address you created the user with |
| Sign-in succeeds but no Admin Panel | Username missing from `VITE_ADMIN_USERNAMES`, or the `staff` row is not `status = 'Active'` |
| Sign-in asks to confirm an e-mail | Turn **Confirm email** off (step 3) |
| Still says demo mode in the console | `VITE_SUPABASE_URL` still contains a placeholder |
