/* =============================================================================
   src/lib/config.js — ENVIRONMENT VARIABLE ACCESS
   -----------------------------------------------------------------------------
   Every credential and deployment setting in this project is read here and
   nowhere else. Nothing is hard-coded in the markup or the UI modules.

   Resolution order for each key:
     1. `import.meta.env.VITE_*`  — values baked in at build time from `.env`
                                    (Vite only exposes `VITE_`-prefixed keys, so
                                    this is a safe allow-list, not a leak).
     2. `window.__WIRE_ENV__`     — an optional runtime override object. This is
                                    what you use when you deploy a *static* build
                                    to a host where you can inject config without
                                    rebuilding (e.g. a `config.js` tag, Docker
                                    entrypoint, or `index.html` templating).

   If neither is present the app falls back to localStorage-only demo mode so
   the front-end still runs and can be demoed without a Supabase project.
   ========================================================================== */

const RAW = (typeof import.meta !== 'undefined' && import.meta.env) || {};
const RUNTIME =
  (typeof window !== 'undefined' && window.__WIRE_ENV__) || {};

/** Read a value from build-time env, then runtime override. */
function env(key, fallback = null) {
  const buildTime = RAW[key];
  if (buildTime !== undefined && buildTime !== null && buildTime !== '') {
    return buildTime;
  }
  const runtime = RUNTIME[key];
  if (runtime !== undefined && runtime !== null && runtime !== '') {
    return runtime;
  }
  return fallback;
}

/** Parse a comma-separated env value into a trimmed, non-empty array. */
function envList(key) {
  return String(env(key, ''))
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

/** Parse a boolean-ish env value ("true", "1", "yes" -> true). */
function envBool(key, fallback = false) {
  const raw = env(key, null);
  if (raw === null) return fallback;
  return ['true', '1', 'yes', 'on'].includes(String(raw).toLowerCase());
}

const supabaseUrl = String(env('VITE_SUPABASE_URL', '')).replace(/\/+$/, '');
const supabaseAnonKey = String(env('VITE_SUPABASE_ANON_KEY', ''));

/**
 * Supabase's auth API is e-mail-native, but the newsroom signs in with a
 * USERNAME. Rather than force staff to invent an address they never use, we
 * derive a stable, deterministic "shadow" address from the username and hide
 * it from the UI entirely. The address is never displayed, never mailed, and
 * only exists so `supabase.auth.signInWithPassword()` has something to key on.
 * Changing a username therefore means creating a new account.
 */
const authEmailDomain = String(
  env('VITE_AUTH_EMAIL_DOMAIN', 'users.thewire.press')
)
  .trim()
  .replace(/^@+/, '');

/** True when both Supabase values look like real credentials. */
const supabaseConfigured =
  /^https?:\/\//i.test(supabaseUrl) &&
  supabaseAnonKey.length > 20 &&
  !supabaseUrl.includes('YOUR-PROJECT-REF') &&
  !supabaseAnonKey.includes('YOUR_SUPABASE');

export const config = {
  /* --- Supabase --- */
  supabaseUrl,
  supabaseAnonKey,
  supabaseConfigured,

  /**
   * Demo mode = no network at all. Data lives in localStorage so the whole
   * publication (including the admin workspace) can be exercised offline.
   * Defaults to ON when Supabase env vars are missing.
   */
  demoMode: envBool('VITE_DEMO_MODE', !supabaseConfigured),

  /* --- Publication identity --- */
  siteName: env('VITE_SITE_NAME', 'The Wire'),
  siteTagline: env(
    'VITE_SITE_TAGLINE',
    'Nakuru Press Club • Independent Verified Dispatches'
  ),
  publicationLocation: env('VITE_PUBLICATION_LOCATION', 'Nakuru, Kenya'),

  /* --- Admin allow-list (defence in depth; RLS is the real gate) --- */
  adminUsernames: envList('VITE_ADMIN_USERNAMES'),
  adminEmails: envList('VITE_ADMIN_EMAILS'),
  adminUserIds: envList('VITE_ADMIN_USER_IDS'),

  /* --- Username <-> shadow e-mail mapping --- */
  authEmailDomain,

  /* --- Feature flags --- */
  pushBroadcastsEnabled: envBool('VITE_ENABLE_PUSH_BROADCASTS', true),
  forcedLockoutEnabled: envBool('VITE_ENABLE_FORCED_NOTIFICATION_LOCKOUT', false),

  /**
   * Web Push VAPID *public* key (base64url). This is not a secret and may live
   * in a VITE_ variable. Without it the app still delivers in-app
   * notifications; with it plus a trusted sender it can also deliver while the
   * tab is closed. Generate a pair with:
   *   npx web-push generate-vapid-keys
   */
  vapidPublicKey: env('VITE_VAPID_PUBLIC_KEY', ''),

  /**
   * Where the owner wants a reader to land when they tap a notification.
   * Must be an absolute https:// URL, otherwise the OS has nowhere to send the
   * tap. Empty means "this origin".
   */
  notificationTargetUrl: env('VITE_NOTIFICATION_TARGET_URL', '')
};

/* -------------------------------------------------------------------------- */
/* Username <-> shadow e-mail                                                  */
/* -------------------------------------------------------------------------- */

/** Usernames are lowercase, 3-32 chars, no spaces. Keeps the mapping reversible. */
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;

/** An address we generated ourselves, as opposed to a real staff mailbox. */
const SHADOW_RE = new RegExp(`@${config.authEmailDomain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');

/**
 * Normalise whatever the user typed in the username box.
 * Accepts a username ("Grace.Wanjiku") or a full real e-mail
 * ("grace@example.com"), so staff who already have an account keep working.
 * @param {string} raw
 * @returns {{username: string, email: string, isShadow: boolean}}
 */
export function resolveLogin(raw) {
  const value = String(raw || '').trim().toLowerCase();
  if (!value) throw new Error('Enter your username.');

  // A real address was typed: use it verbatim, and derive a display username
  // from its local part.
  if (value.includes('@')) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      throw new Error('That does not look like a valid e-mail address.');
    }
    return { username: value.split('@')[0], email: value, isShadow: false };
  }

  if (!USERNAME_RE.test(value)) {
    throw new Error(
      'Usernames are 3-32 characters: letters, numbers, dot, dash or underscore.'
    );
  }
  return {
    username: value,
    email: `${value}@${config.authEmailDomain}`,
    isShadow: true
  };
}

/** True when an e-mail is one we derived from a username (never a real inbox). */
export function isShadowEmail(email) {
  return SHADOW_RE.test(String(email || ''));
}

/** The username to display for a session, preferring the stored value. */
export function usernameFor(user) {
  if (!user) return '';
  if (user.username) return user.username;
  const email = String(user.email || '');
  return isShadowEmail(email) ? email.split('@')[0] : email;
}

/**
 * Decide whether a signed-in user may enter the Owner Control Center.
 * The Supabase `staff` table and its RLS policies remain the authoritative
 * source; this is the fast client-side gate used to decide whether to *render*
 * the Admin Panel link at all.
 */
export function isAdminUser(user) {
  if (!user) return false;
  if (config.adminUserIds.includes(String(user.id).toLowerCase())) return true;
  const username = usernameFor(user).toLowerCase();
  if (username && config.adminUsernames.includes(username)) return true;
  if (user.email && config.adminEmails.includes(user.email.toLowerCase())) {
    return true;
  }
  return false;
}

/** Small helper so the UI can explain itself when config is missing. */
export function describeBackend() {
  if (config.demoMode) {
    return {
      mode: 'demo',
      label: 'Local demo store (localStorage)',
      detail:
        'Supabase environment variables were not detected, so all data is being ' +
        'stored in this browser only. Copy .env.example to .env and restart the ' +
        'dev server to connect a real project.'
    };
  }
  return {
    mode: 'supabase',
    label: 'Supabase connected',
    detail: config.supabaseUrl
  };
}
