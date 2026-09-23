# What I actually verified and fixed this session

The previous session's status report claimed several things were done that,
on inspection of the actual code, weren't (or were half-done). Below is only
what I personally checked and tested — no claim here is unverified.

## Bugs found and fixed

1. **Top Performers `photo_url` / `blurb` were never saved, ever.**
   `content.js` has always read `p.photo_url` and `p.blurb` on the public
   feed, but the database column never existed and `settings.js`'s
   POST/PUT `/performers` never wrote them even when the columns were added.
   Fixed both: added the columns (`backend/db.js`) and the insert/update SQL
   (`backend/routes/settings.js`). **Tested live** — created a performer with
   a photo/blurb, confirmed it round-trips through `GET /api/content` intact.

2. **Today's Pick had no pin control**, despite being on the task list.
   Added a `pinned` column, rewrote `todaysPick()` to respect it, and added
   three endpoints: `GET/POST/DELETE /api/content/pick`. **Tested live** —
   pinned an article, confirmed the public feed shows that exact article as
   `pick` instead of the daily random pull; unpinned, confirmed it releases.

3. **A real Postgres portability bug in `todaysPick()`**: the UPDATE used
   SQLite's `rowid`, which doesn't exist on Postgres — this would have
   silently failed to persist on Supabase. `todays_pick` is already a
   singleton row (`id INTEGER/BIGINT PRIMARY KEY CHECK (id = 1)`), so I
   switched the query to `WHERE id = 1`, which works on both backends.

4. **The Credits and Top Performers admin panels didn't exist.** The
   previous session added the *public* display sections and rendering code,
   but never added the Owner-facing forms to actually create/remove a credit
   or performer — there was no way to put content into those sections at
   all. Added both panels to `#settingsPane` in `frontend/index.html`,
   mirroring the existing Categories panel's pattern (list + add + remove,
   calling the existing/fixed `/api/settings/credits` and
   `/api/settings/performers` routes).

5. **`week_rotated_at` wasn't shown anywhere.** It was already being stored
   and returned by `GET /api/settings` — just needed a frontend readout.
   Added one line in Settings showing the last rotation date/time.

## Verified by actually booting the server

I ran the real backend locally (SQLite, throwaway `.env`), logged in as the
seeded Owner, and hit every new/changed endpoint with `curl` — not just read
the code. See the test transcript from this session for the exact requests
and responses (performer create → public feed check, credit create, pick
candidates → pin → public feed check → unpin, `week_rotated_at` present).

## Left undone — be aware of these

- **Postgres/Supabase connectivity** — I cannot test this from here; my
  network access doesn't reach `*.pooler.supabase.com`. Run
  `npm run check-db` yourself (it's already in the repo, unchanged) with
  your real `DATABASE_URL` — it will tell you exactly what's wrong
  (wrong region, IPv6-only host, bad password, etc.) rather than a bare
  `ENOTFOUND`.
- **E2E test coverage** — `backend/tests/e2e.mjs` was not extended to cover
  the new pick/performers/credits endpoints. Worth adding before you trust
  it as a regression check.
- I did not re-verify every item in the earlier status table (OneSignal
  delivery, Cloudinary upload, forced-notification gating, etc.) — I only
  went deep on the specific tasks that were flagged or that I could verify
  quickly. Treat anything not mentioned above as "unverified," not
  "confirmed broken."
