# Deploying The Wire to Vercel

## The short version

```powershell
npm install
npm run build      # must succeed before you deploy
```

Then in Vercel: **Add New → Project**, import this repo, and accept the detected
settings. That is the whole deployment.

| Setting        | Value            |
| -------------- | ---------------- |
| Framework      | Vite             |
| Build command  | `npm run build`  |
| Output dir     | `dist`           |
| Node version   | 20 or newer      |

A committed `vercel.json` pins these explicitly (so you can deploy from the CLI
without being asked) and adds two things worth keeping:

- **Cache headers** — `/assets/*` is served `immutable` for a year, which is safe
  because those filenames are content-hashed. `/sw.js` is forced to
  `max-age=0, must-revalidate` with `Service-Worker-Allowed: /`, so a new deploy
  is picked up immediately instead of being served stale from cache.
- **Security headers** — `X-Content-Type-Options`, `X-Frame-Options: DENY`,
  `Referrer-Policy` and a restrictive `Permissions-Policy`.

The app uses no client-side router, so no SPA rewrite rule is needed.

---

## Environment variables (the part that actually breaks deployments)

This is the single most common reason "it worked on localhost but not when I
published it": **Vercel does not read your local `.env` file.** The `.env` on
your disk is gitignored, so it never reaches the build.

Every `VITE_` variable must be added by hand in the Vercel dashboard:

**Vercel → your project → Settings → Environment Variables**

| Name | Value | Notes |
| ---- | ----- | ----- |
| `VITE_SUPABASE_URL` | `https://iguzwwqjufzzdblkqroj.supabase.co` | your project ref |
| `VITE_SUPABASE_ANON_KEY` | your **anon/publishable** key | safe in the browser; RLS protects it |
| `VITE_DEMO_MODE` | `false` | `true` would make the deployed site ignore the database |
| `VITE_SITE_NAME` | `The Wire` | |
| `VITE_SITE_TAGLINE` | `Nakuru Press Club` | |
| `VITE_PUBLICATION_LOCATION` | `Nakuru, Kenya` | |
| `VITE_ADMIN_USERNAMES` | `chief.owner` | comma-separated |
| `VITE_ADMIN_EMAILS` | `chief.owner@example.com` | legacy fallback, still honoured |
| `VITE_ADMIN_USER_IDS` | *(leave empty)* | optional UUID allow-list |
| `VITE_AUTH_EMAIL_DOMAIN` | `users.thewire.press` | **never change after accounts exist** |
| `VITE_ENABLE_PUSH_BROADCASTS` | `true` | in-app notification bell |
| `VITE_ENABLE_FORCED_NOTIFICATION_LOCKOUT` | `false` | emergency broadcast override |
| `VITE_VAPID_PUBLIC_KEY` | your VAPID **public** key | see the VAPID section below |

Apply these to **all three** environments (Production, Preview, Development) —
Vercel only exposes variables to environments you tick.

After adding them: **Deployments → ⋮ → Redeploy**. A rebuild is required;
editing an env var does not hot-patch the existing bundle.

### How to confirm it worked

Visit your live URL, open the console, and run:

```js
import.meta.env.VITE_SUPABASE_URL
```

If that is `undefined`, the build did not receive the variable and the site has
silently fallen back to demo mode. It will *look* fine — full styling, full
navigation, sample articles — which is exactly why this failure is easy to miss.

The Owner Control Center also shows `Backend: Supabase connected` on the
overview tab. If it says `Local demo store`, stop and fix the env vars.

---

## Supabase: allow your production domain

Auth redirects and CORS both need to know about the Vercel domain.

**Supabase → Authentication → URL Configuration**

- **Site URL** — set to your production origin, e.g. `https://the-wire.vercel.app`
- **Redirect URLs** — add the same origin, plus any preview domains you use

Preview deployments get a unique URL per build, so either add a wildcard:

```
https://*.vercel.app/**
```

or set `VITE_AUTH_EMAIL_DOMAIN`-independent preview env vars per environment.

---

## VAPID keys, and where the private one goes

Generate a pair:

```powershell
npx web-push generate-vapid-keys
```

**Public key** → add `VITE_VAPID_PUBLIC_KEY` to Vercel like any other `VITE_`
variable. It is not a secret; the browser needs it to subscribe.

**Private key** → **do not** add it to Vercel's `VITE_` variables, and never put
it in this repository. Anything prefixed `VITE_` is compiled into the public
JavaScript bundle and is readable by anyone who opens DevTools.

The private key belongs only in the environment of the process that *sends*
pushes — a Supabase Edge Function secret, or a Vercel serverless function's
encrypted environment. It signs the Web Push request; a leaked key lets an
attacker push fake alerts to your entire subscriber list.

**Until that sender exists, broadcasts are in-app only.** They notify devices
that currently have The Wire open. That limit is stated in the Control Center so
it cannot mislead you.

---

## Deployment checklist

- [ ] `npm run build` succeeds locally
- [ ] Every `VITE_` variable added in Vercel (all three environments)
- [ ] `VITE_DEMO_MODE` is `false` on production
- [ ] Supabase Site URL + Redirect URLs include your Vercel domain
- [ ] First visit shows `Backend: Supabase connected` in the Owner panel
- [ ] Owner sign-in works on the live domain
- [ ] Private VAPID key is **not** in any `VITE_` variable

---

## Why "worked on localhost, broke in production" happens

| Cause | Fix |
| ----- | --- |
| `.env` not in Vercel | add each `VITE_` var by hand |
| Build not re-run after adding vars | Redeploy |
| Supabase rejects the new origin | add domain to Redirect URLs |
| `VITE_DEMO_MODE=true` deployed | set to `false` |
| Hard-coded `localhost` URLs | none exist — the app reads config only |

## Custom domain

Vercel → Settings → Domains → Add. Then set the same origin as the Supabase
**Site URL** and add it to **Redirect URLs**. Vite needs no change: assets are
referenced from `/`.
