# The Wire — Nakuru Press Club

A production-ready digital newspaper plus a full **Owner Control Center** for the
newsroom. Built with Vite 6, Tailwind CSS v4 and Supabase.

Every admin control in the original static HTML has been converted into a real,
authenticated, database-backed workspace — nothing is a mock, and no privileged
markup ships to unauthenticated visitors.

---

## Quick start

```bash
npm install
cp .env.example .env      # Windows PowerShell: Copy-Item .env.example .env
npm run dev               # http://localhost:5173
```

Out of the box the site runs in **demo mode**: all data lives in `localStorage`,
no network calls are made, and no credentials are needed. Sign in with any valid
username and an 8+ character password to explore the workspace.

```bash
npm run build     # production bundle -> dist/
npm run preview   # serve dist/ on :4173
```

---

## Project structure

```
index.html               Public shell: masthead, nav, auth modal, search modal
.env / .env.example      All configuration (git-ignored)
src/
  app.js                 Boot orchestration: theme -> dialogs -> data -> auth
  styles.css             Tailwind v4 CSS-first theme, tokens, components
  lib/
    config.js            The ONLY place env vars are read
    supabase.js          Lazy, memoised Supabase client + error translation
    auth.js              signIn / signUp / signOut / session restore
    store.js             CRUD repository (Supabase + localStorage backends)
    seed.js              Default publication content
    theme.js             localStorage + prefers-color-scheme controller
    dom.js               Escaping, toasts, focus-trapped dialogs
  views/
    public.js            Reader-facing publication
    auth.js              Login modal + header auth slot
    admin.js             Owner Control Center (10 tabs, full CRUD)
supabase/schema.sql      Tables, RLS policies, seed
```

---

## 1. Environment variables

All configuration lives in `.env` and is read exclusively by `src/lib/config.js`.
Vite only exposes `VITE_`-prefixed keys to the browser via `import.meta.env`,
which acts as a deliberate allow-list.

| Variable | Purpose | Default |
| --- | --- | --- |
| `VITE_SUPABASE_URL` | Supabase project URL | — |
| `VITE_SUPABASE_ANON_KEY` | Anon / publishable key | — |
| `VITE_DEMO_MODE` | `true` = localStorage only, no network | `true` when keys missing |
| `VITE_SITE_NAME` | Publication name in the footer | `The Wire` |
| `VITE_SITE_TAGLINE` | Masthead strapline | Nakuru Press Club… |
| `VITE_PUBLICATION_LOCATION` | Dateline | `Nakuru, Kenya` |
| `VITE_ADMIN_USERNAMES` | Comma-separated **username** allow-list | *(empty = any staff row)* |
| `VITE_ADMIN_EMAILS` | Legacy e-mail allow-list, still honoured | *(empty)* |
| `VITE_ADMIN_USER_IDS` | Comma-separated Auth UUIDs (higher priority) | — |
| `VITE_AUTH_EMAIL_DOMAIN` | Domain for the hidden shadow address | `users.thewire.press` |
| `VITE_ENABLE_PUSH_BROADCASTS` | Broadcast feature flag | `true` |
| `VITE_ENABLE_FORCED_NOTIFICATION_LOCKOUT` | Forced-notification flag | `false` |

### Security rules

- **Only the anon/publishable key may ever go in a `VITE_` variable.** Anything
  prefixed `VITE_` ends up in the client bundle in plain text.
- **Never** put `SUPABASE_SERVICE_ROLE_KEY` in `.env` for a client build. It
  bypasses RLS completely. It belongs in a server environment variable used by a
  Supabase Edge Function.
- For a *static* deployment where you cannot rebuild, inject a runtime override
  before the app script loads and `config.js` will prefer it:

  ```html
  <script>
    window.__WIRE_ENV__ = {
      VITE_SUPABASE_URL: 'https://abc.supabase.co',
      VITE_SUPABASE_ANON_KEY: 'eyJ…'
    };
  </script>
  ```

### Deploying to Vercel / Netlify

**See [DEPLOY.md](DEPLOY.md) for the full checklist**, including the exact list of
`VITE_*` variables to add, Supabase redirect-URL setup, and VAPID key handling.

| Setting | Value |
| --- | --- |
| Build command | `npm run build` |
| Output directory | `dist` |
| Node version | 20+ |

The most common cause of "it worked on localhost but not in production" is that
Vercel never sees your local `.env` file — it is gitignored, so it does not
reach the build. Add every `VITE_*` variable by hand under **Project Settings →
Environment Variables**, then **redeploy** (Vite inlines values at build time,
so editing a variable does not hot-patch the existing bundle).


---

## 2. Supabase setup

1. Create a project at [supabase.com](https://supabase.com).
2. **SQL Editor → New query**, paste the whole of `supabase/schema.sql`, run it.
   This creates every table plus the Row Level Security policies.
3. **Project Settings → Data API** → copy the Project URL and the `anon`
   publishable key into `.env`.
4. **Authentication → Providers → Email** → enable it (Supabase requires the
   e-mail provider even for username logins; the address is generated for you).
   Leave "Confirm email" on in production — it still applies to accounts created
   with a real address, and username accounts are auto-confirmed regardless.
5. Create the first owner: **Authentication → Users → Add user**, using the
   shadow address for their username (`<username>@<VITE_AUTH_EMAIL_DOMAIN>`),
   then insert a matching row into `staff` with `auth_user_id` set to that
   user's UUID and `role = 'Owner'`.
6. Set `VITE_DEMO_MODE=false`, restart the dev server.

The `staff` table is the authoritative admin gate. `VITE_ADMIN_USERNAMES` is a
fast client-side allow-list layered on top for defence in depth.

---

## 3. Authentication flow

### Usernames, not e-mails

Staff sign in with a **username** and a password. Supabase's auth API is
e-mail-native, so `resolveLogin()` in `src/lib/config.js` derives a
deterministic *shadow address* from the username:

```
grace.wanjiku   ->   grace.wanjiku@users.thewire.press
```

That address is never displayed, never typed, and never receives mail. It
exists only so `signInWithPassword()` has a key to look up. Practical
consequences worth knowing:

- **Usernames are 3-32 characters** — letters, numbers, `.`, `-`, `_`. They are
  lower-cased, so `Grace` and `grace` are the same account.
- **Renaming a username is not supported.** It would change the derived address
  and orphan the account. Create a new account instead.
- **Never change `VITE_AUTH_EMAIL_DOMAIN` after accounts exist.** Pick it once,
  before sign-ups begin.
- **Password reset by e-mail does not apply** to username accounts — there is
  no inbox. Owners reset staff passwords from the Staff Roster instead. A real
  e-mail typed into the login box still works and is used verbatim, which is how
  pre-existing e-mail accounts keep functioning.
- Because shadow addresses are auto-confirmed, new username accounts skip
  e-mail confirmation and land signed in immediately. Accounts created with a
  real address still require confirmation.

### Session behaviour

- The header contains **no** admin link in the static HTML. The `#auth-slot`
  container ships empty and is filled at runtime by `src/views/auth.js`.
- Signed out → a single **Login** button opens an animated, focus-trapped modal
  supporting sign-in, sign-up and password reset.
- Signed in → the slot swaps to an account chip with a dropdown, plus the
  **Admin Panel** button *only* when `session.isAdmin` is true. The chip shows
  the username, never the shadow address.
- A session revoked in another tab immediately closes the control centre
  (`app.js` → `handleSessionChange`).
- RLS is the real enforcement. Client-side checks are UX, not security.

---

## 4. Dark mode

Priority: `localStorage['wire.theme']` → `prefers-color-scheme` → light.

A small synchronous script in `<head>` applies the class **before first paint**,
so dark-mode visitors never see a white flash. It mirrors `src/lib/theme.js`;
keep the two in sync. The nav switch is a real `role="switch"` checkbox with a
screen-reader label, and the choice syncs across tabs via the `storage` event.
`prefers-reduced-motion` is honoured globally.

---

## 5. CRUD coverage

`src/lib/store.js` implements full Create / Read / Update / Delete against
Supabase for every entity, with a complete localStorage implementation as the
demo-mode backend:

- **Articles** — create, edit, delete, publish, reject, feature
- **Assignments** — create, edit, delete, claim
- **Staff** — create, edit, delete (Owner is protected from deletion)
- **Media library** — create, edit, delete
- **Broadcasts** — create, delete
- **Settings** — branding, breaking-news banner, curation slots, forced-notification
- **Audit log** — appended on every privileged mutation

Reads come from PostgREST with RLS; writes go through `assertOk()`, which
converts PostgREST errors into thrown `Error`s with actionable messages.

---

## Accessibility

Skip link, landmark regions, `aria-current` on tabs, focus traps in every modal,
visible focus rings, `aria-live` toast region, `prefers-reduced-motion` support,
and print styles that render the publication like newsprint.
