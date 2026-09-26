/* =============================================================================
   src/lib/auth.js â€” AUTHENTICATION (username + password, no Supabase Auth)
   -----------------------------------------------------------------------------
   Staff authenticate with a USERNAME and a password. Nothing else â€” no e-mail
   address is asked for, stored, or required at any point.

   Supabase Auth is deliberately NOT used. It is e-mail-native, which forced
   staff to invent addresses they have never used. Instead the credentials live
   in `staff_accounts`, managed entirely by SECURITY DEFINER functions in
   supabase/credentials.sql:

     wire_is_unclaimed()          -> is the Owner seat still empty?
     wire_request_account(...)    -> create a login request
     wire_login(...)              -> returns an opaque session token
     wire_sign_out()              -> revoke the current token
     wire_list_accounts()         -> the roster, each row flagged is_me

   Passwords are hashed with pgcrypto bcrypt and are never readable from the
   client. Sessions are random tokens; only a SHA-256 digest is persisted.

   Two rules make registration safe:
     1. The FIRST account ever created becomes the Owner and is approved
        immediately â€” otherwise nobody could ever log in to approve anyone.
     2. Every account after that is a *request* the Owner must approve before it
        can sign in.

   Exposed API:
       initAuth()                 restore the session from a stored token
       signIn({login,password})   -> { user, isAdmin }
       signUp({name,login,password}) -> { requiresApproval, isFirstAccount }
       signOut()
       getSession()               -> { user, isAdmin } | null
       onAuthChange(callback)     -> unsubscribe fn

   The header button swaps between "Login" and "Admin Panel / Sign out"
   purely from the state this module publishes. Unauthenticated visitors never
   receive the admin markup, and the admin view is additionally guarded at
   render time (see src/views/admin.js).
   ========================================================================== */

import { config, resolveLogin, isAdminUser } from './config.js';
import {
  getSupabase,
  getSessionToken,
  setSessionToken,
  describeAuthError
} from './supabase.js';

/* -------------------------------------------------------------------------- */
/* RPC helpers                                                                 */
/* -------------------------------------------------------------------------- */

/** Call a Postgres function, unwrapping the {data, error} envelope. */
async function rpc(name, args = {}) {
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw new Error(describeAuthError(error));
  return data;
}

/**
 * The signed-in row, or null when the token is missing/expired/revoked.
 *
 * `wire_list_accounts()` flags the caller's own row with `is_me`. That flag is
 * the authoritative answer, but it only exists once the deployed function is at
 * least as new as credentials.sql. When the server is running an older build
 * the flag is simply absent, every `find` misses, and the app reports the user
 * as signed out even though the token is perfectly valid.
 *
 * So fall back to `wire_session_diagnostic()`, which resolves the same token to
 * a username. Matching that username against the roster returns the right row
 * either way, and costs one extra round-trip only on the degraded path.
 */
async function fetchAccount() {
  const rows = await rpc('wire_list_accounts');
  if (!Array.isArray(rows) || rows.length === 0) return null;

  // Preferred path: the server tells us directly.
  const flagged = rows.find((row) => row.is_me);
  if (flagged) return flagged;

  // Degraded path: a stale deployment with no is_me column.
  const who = await currentUsername();
  if (who) {
    const match = rows.find(
      (row) => String(row.username || '').toLowerCase() === who
    );
    if (match) return match;
  }

  // Last resort: a single-account newsroom can only be talking about itself.
  if (rows.length === 1) return rows[0];

  return null;
}

/** Username the stored session token resolves to, or '' when it resolves to none. */
async function currentUsername() {
  try {
    const diag = await rpc('wire_session_diagnostic');
    if (!diag?.session_resolved) return '';
    return String(diag.username || '').trim().toLowerCase();
  } catch {
    return '';
  }
}

/** Build the public session shape the rest of the app consumes. */
function toSession(account) {
  if (!account) return null;
  const user = {
    id: account.id,
    username: account.username,
    name: account.display_name,
    role: account.role,
    isOwner: Boolean(account.is_owner)
  };
  return { user, isAdmin: true };
}

function adoptSession(account) {
  session = toSession(account);
  publish();
  return session;
}

const DEMO_SESSION_KEY = 'wire.demoSession';

const listeners = new Set();
let session = null; // { user: {id,username,name,role,isOwner}, isAdmin: boolean } | null

/** Notify everyone watching the auth state (header, admin guard, modals). */
function publish() {
  listeners.forEach((listener) => {
    try {
      listener(session);
    } catch (error) {
      console.error('[auth] listener failed', error);
    }
  });
}

/** @param {(session: object|null) => void} callback */
export function onAuthChange(callback) {
  listeners.add(callback);
  callback(session);
  return () => listeners.delete(callback);
}

/** @returns {{user: object, isAdmin: boolean}|null} */
export function getSession() {
  return session;
}

/** True when somebody is signed in. */
export function isSignedIn() {
  return Boolean(session);
}

/** True when the signed-in user may open the Owner Control Center. */
export function isAdmin() {
  return Boolean(session?.isAdmin);
}

/* -------------------------------------------------------------------------- */
/* Demo-mode session storage                                                   */
/* -------------------------------------------------------------------------- */

function readDemoSession() {
  try {
    const raw = localStorage.getItem(DEMO_SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeDemoSession(value) {
  try {
    if (value) localStorage.setItem(DEMO_SESSION_KEY, JSON.stringify(value));
    else localStorage.removeItem(DEMO_SESSION_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Demo sign-in. Accepts any well-formed username (or a real e-mail) plus an
 * 8+ character password so the flow can be reviewed end-to-end. Clearly
 * labelled in the UI as demo auth.
 */
function demoSignIn(login, password) {
  const { username, email } = resolveLogin(login);
  if (String(password).length < 8) {
    throw new Error('Demo passwords must be at least 8 characters.');
  }
  const user = {
    id: `demo-${btoa(email).slice(0, 12)}`,
    email,
    username,
    name: username.replace(/[._-]+/g, ' ')
  };
  // Grant admin to the configured allow-list, or to anything at all in demo
  // mode so reviewers are never locked out of the workspace they are testing.
  const admin =
    config.adminUsernames.length === 0 || isAdminUser(user);
  return { user, isAdmin: admin };
}

/* -------------------------------------------------------------------------- */

function normaliseMessage(message) {
  const error = new Error(message);
  error.isAuthError = true;
  return error;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Restore an existing session on page load.
 * Safe to call once during boot.
 */
export async function initAuth() {
  if (config.demoMode || !getSupabase()) {
    session = readDemoSession();
    publish();
    return session;
  }

  // Sessions are opaque bearer tokens minted by wire_login and kept in
  // localStorage. On boot we simply ask the database who that token belongs
  // to; a revoked, expired or forged token resolves to nothing and we start
  // signed out. There is no third-party session object to keep in sync.
  try {
    if (getSessionToken()) {
      const me = await fetchAccount();
      if (me) {
        session = toSession(me);
      } else {
        // The token is no longer valid â€” drop it so we stop sending it.
        setSessionToken(null);
        session = null;
      }
    } else {
      session = null;
    }
  } catch (error) {
    console.warn('[auth] could not restore session', error);
    setSessionToken(null);
    session = null;
  }

  publish();
  return session;
}

/**
 * Is the Owner seat still unclaimed?
 *
 * The very first account created on a fresh database becomes the Owner
 * automatically. Every later request sits in the approval queue until the
 * Owner acts on it, so the login screen can explain that up front instead of
 * letting somebody pick a username and then bounce them.
 * @returns {Promise<boolean>}
 */
export async function isUnclaimed() {
  if (config.demoMode || !getSupabase()) return false;
  try {
    return Boolean(await rpc('wire_is_unclaimed'));
  } catch {
    // If we cannot tell, assume claimed: asking for approval again is the
    // harmless failure, silently granting the Owner seat is not.
    return false;
  }
}

/**
 * SIGN IN with username + password.
 *
 * @param {{login: string, password: string}} credentials
 * @returns {Promise<{user: object, isAdmin: boolean}>}
 * @throws {Error} with a message safe to show to the user
 */
export async function signIn({ login, password }) {
  if (!password) {
    throw normaliseMessage('Enter both your username and password.');
  }

  if (config.demoMode || !getSupabase()) {
    const result = demoSignIn(login, password);
    session = result;
    writeDemoSession(result);
    publish();
    return result;
  }

  // wire_login raises a distinct, explicit error for every failure mode
  // (unknown username, wrong password, awaiting approval, suspended), so there
  // is nothing to branch on here â€” describeAuthError renders it readably.
  const token = await rpc('wire_login', {
    p_username: login,
    p_password: password
  });

  setSessionToken(token);
  return adoptSession(await fetchAccount());
}

/**
 * REQUEST AN ACCOUNT.
 *
 * The first account ever created on this database becomes the Owner and is
 * signed in immediately. Every subsequent request is recorded as `pending` and
 * CANNOT sign in until the Owner approves it â€” the database enforces this, not
 * the browser, so skipping the UI gains nothing.
 *
 * @param {{name: string, login: string, password: string}} details
 * @returns {Promise<{isOwner: boolean, requiresApproval: boolean}>}
 */
export async function signUp({ name, login, password }) {
  const { username } = resolveLogin(login);

  if (String(password || '').length < 8) {
    throw normaliseMessage('Passwords must be at least 8 characters long.');
  }

  if (config.demoMode || !getSupabase()) {
    const result = demoSignIn(login, password);
    session = result;
    writeDemoSession(result);
    publish();
    return { isOwner: true, requiresApproval: false };
  }

  // wire_request_account decides first-run-claim vs. pending-queue on the
  // server, so the client never has to guess who the Owner is.
  const account = await rpc('wire_request_account', {
    p_username: username,
    p_display_name: String(name || '').trim() || username.replace(/[._-]+/g, ' '),
    p_password: password
  });

  const isOwner = Boolean(account?.is_owner);

  if (!isOwner) {
    // Deliberately no session is minted: a pending request has nothing to
    // sign in with until the Owner acts.
    return { isOwner: false, requiresApproval: true };
  }

  // First-run claim: sign the new Owner straight in.
  const token = await rpc('wire_login', {
    p_username: username,
    p_password: password
  });
  setSessionToken(token);
  const me = await fetchAccount();
  if (me) {
    adoptSession(me);
  }
  return { isOwner: true, requiresApproval: false };
}

/**
 * Accounts waiting on the Owner's decision.
 * @returns {Promise<Array<object>>} pending requests only
 */
export async function listPendingAccounts() {
  if (config.demoMode || !getSupabase()) return [];
  const rows = await rpc('wire_list_accounts');
  return (rows || []).filter((row) => String(row.status).toLowerCase() === 'pending');
}

/** Every account the Owner can see, approved or not. */
export async function listAccounts() {
  if (config.demoMode || !getSupabase()) return [];
  return (await rpc('wire_list_accounts')) || [];
}

/**
 * Approve a pending request. Owner-only, enforced in the database.
 * @param {string} id
 * @param {string} [role]
 */
export async function approveAccount(id, role = 'Editor') {
  if (config.demoMode || !getSupabase()) return null;
  return rpc('wire_approve_account', { p_id: id, p_role: role });
}

/**
 * Refuse a pending request, or remove a non-owner account. Owner-only.
 * @param {string} id
 */
export async function rejectAccount(id) {
  if (config.demoMode || !getSupabase()) return false;
  return rpc('wire_reject_account', { p_id: id });
}

/**
 * Reset somebody's password. The Owner never sees the old one, and every
 * existing session for that account is revoked at the same time.
 * @param {string} id
 * @param {string} password
 */
export async function setAccountPassword(id, password) {
  if (String(password || '').length < 8) {
    throw normaliseMessage('Passwords must be at least 8 characters long.');
  }
  if (config.demoMode || !getSupabase()) return false;
  return rpc('wire_set_password', { p_id: id, p_password: password });
}

/** SIGN OUT â€” revoke the token server-side, then forget it locally. */
export async function signOut() {
  if (config.demoMode || !getSupabase()) {
    session = null;
    writeDemoSession(null);
    publish();
    return;
  }

  try {
    // Best effort: if the call fails we still clear locally, because the
    // caller must never be left stuck looking signed in.
    await rpc('wire_sign_out');
  } catch (error) {
    console.warn('[auth] sign-out could not reach the server', error);
  }

  setSessionToken(null);
  session = null;
  publish();
}
