/* =============================================================================
   src/lib/supabase.js — SINGLE SHARED SUPABASE CLIENT
   -----------------------------------------------------------------------------
   The client is created lazily and memoised. If the environment variables are
   missing we deliberately return `null` instead of throwing, so the rest of the
   app can fall back to the localStorage demo store without special-casing.
   ========================================================================== */

import { createClient } from '@supabase/supabase-js';
import { config } from './config.js';

let client = null;

/** localStorage key holding the opaque session token issued by wire_login(). */
export const SESSION_TOKEN_KEY = 'wire.sessionToken';

/**
 * Wrap fetch so the caller's session token rides along on every request.
 *
 * Supabase Auth is no longer used, so there is no JWT to send. Instead the
 * browser holds an opaque token and presents it as `x-wire-token`; the RLS
 * policies in supabase/credentials.sql resolve it back to a staff_accounts row.
 */
function withSessionToken(input, init = {}) {
  let token = null;
  try {
    token = localStorage.getItem(SESSION_TOKEN_KEY);
  } catch {
    /* storage unavailable (private mode) — send unauthenticated */
  }

  const headers = new Headers(init.headers || {});
  if (token) headers.set('x-wire-token', token);
  else headers.delete('x-wire-token');

  return fetch(input, { ...init, headers });
}

/**
 * @returns {import('@supabase/supabase-js').SupabaseClient | null}
 */
export function getSupabase() {
  if (client) return client;
  if (!config.supabaseConfigured) return null;

  client = createClient(config.supabaseUrl, config.supabaseAnonKey, {
    // We manage our own sessions, so Supabase's own refresh/PKCE machinery is
    // turned off — leaving it on would fight our token and confuse sign-out.
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false
    },
    db: {
      schema: 'public'
    },
    global: {
      fetch: withSessionToken,
      headers: { 'x-application-name': 'the-wire' }
    }
  });

  return client;
}

/**
 * Store (or clear) the session token used by withSessionToken().
 *
 * `wire_login()` returns a jsonb OBJECT ({ token, username, role, ... }), not a
 * bare string. Passing that object straight in used to coerce it to the literal
 * text "[object Object]", which was then sent as the x-wire-token header, matched
 * no session row, and surfaced to the user as a bare "Not authorised." after a
 * signup that had visibly succeeded. Unwrap it here, once, so no caller can get
 * this wrong.
 */
export function setSessionToken(token) {
  try {
    // Accept a bare string, a login payload, or a { token } wrapper.
    const value =
      token && typeof token === 'object' ? token.token ?? token.session_token : token;

    if (!value || typeof value !== 'string') {
      localStorage.removeItem(SESSION_TOKEN_KEY);
      return;
    }
    localStorage.setItem(SESSION_TOKEN_KEY, value);
  } catch {
    /* ignore */
  }
}

/** @returns {string|null} */
export function getSessionToken() {
  try {
    return localStorage.getItem(SESSION_TOKEN_KEY);
  } catch {
    return null;
  }
}


/** True when a real Supabase client is available. */
export function hasSupabase() {
  return getSupabase() !== null;
}

/**
 * Turn a PostgREST error into a human-readable sentence for the auth modal.
 * Keeps raw Supabase messages out of the UI unless we understand them.
 */
export function describeAuthError(error) {
  if (!error) return 'Something went wrong. Please try again.';
  const message = String(error.message || error.error_description || error);
  const lower = message.toLowerCase();

  if (lower.includes('invalid login credentials')) {
    return 'Incorrect username or password. Please check and try again.';
  }
  if (lower.includes('email not confirmed')) {
    return 'This address still needs to be confirmed. Check your inbox.';
  }
  if (lower.includes('user already registered')) {
    return 'An account already exists for that username. Try signing in instead.';
  }
  if (lower.includes('rate limit') || lower.includes('too many')) {
    return 'Too many attempts. Please wait a minute and try again.';
  }
  if (lower.includes('password should be')) {
    return 'Passwords must be at least 6 characters long.';
  }
  if (lower.includes('failed to fetch') || lower.includes('network')) {
    return 'Could not reach the authentication server. Check your connection.';
  }
  return message;
}
