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

/**
 * The newsroom's three roles, weakest first.
 *
 * This is the single source of truth on the client and MUST stay in step with
 * the CHECK constraint on staff_accounts.role in supabase/credentials.sql and
 * with wire_default_permissions() in supabase/006_roles_and_privileges.sql.
 * An earlier revision of this app also had a 'Managing Editor' and a
 * 'Photographer'; neither survived review, and the database rejected both,
 * so they were removed rather than left as dead options in a dropdown.
 */
export const ROLES = ['Writer', 'Board Manager', 'Owner'];

/**
 * Higher wins. Unknown or missing roles rank lowest, never highest.
 *
 * The keys MUST be drawn from ROLES. This map used to be keyed `Editor` while
 * ROLES said `Writer`, so `roleAtLeast('Writer', 'Writer')` looked up two
 * undefined entries, fell back to `0 >= 99`, and returned FALSE. Every
 * non-owner-only tab was therefore filtered out for every role including the
 * Owner's own: a Writer saw no tabs at all and the Owner saw only the four
 * `ownerOnly` ones. The panel looked "mostly empty" rather than throwing, which
 * is why this survived so long.
 */
const ROLE_RANK = { Writer: 1, 'Board Manager': 2, Owner: 3 };

/** Legacy spellings, mapped onto the current vocabulary. */
const LEGACY_ROLES = {
  reporter: 'Writer',
  editor: 'Writer',
  'managing editor': 'Board Manager',
  photographer: 'Board Manager'
};

/**
 * Coerce whatever the database returned into one of the three known roles.
 * Anything unrecognised becomes 'Writer' -- the weakest role -- so an unknown
 * or corrupted value can never accidentally grant more access than intended.
 */
export function normaliseRole(value) {
  const role = String(value || '').trim().toLowerCase();
  for (const candidate of ROLES) {
    if (candidate.toLowerCase() === role) return candidate;
  }
  // Tolerate the historical names so an account provisioned under the old
  // vocabulary keeps its access instead of silently dropping to the bottom.
  return LEGACY_ROLES[role] || 'Writer';
}

/**
 * The role of the signed-in account, weakest-first, or '' when nobody is
 * signed in. Always a member of ROLES, so it can be compared with roleAtLeast()
 * without a further guard.
 */
export function currentRole() {
  return session?.role ? normaliseRole(session.role) : '';
}

/** Does `role` meet or exceed `minimum`? */
export function roleAtLeast(role, minimum) {
  return (ROLE_RANK[normaliseRole(role)] || 0) >= (ROLE_RANK[minimum] || 99);
}

/** Build the public session shape the rest of the app consumes. */
function toSession(account) {
  if (!account) return null;

  // An account that is not `active` has no privileges at all. The database
  // denies its queries, but we also refuse to hand the UI a workspace so a
  // pending applicant sees an honest "waiting for approval" state.
  const status = String(account.status || 'active').toLowerCase();
  const active = status === 'active';

  const role = normaliseRole(account.role);
  const isOwner = active && Boolean(account.is_owner);

  const user = {
    id: account.id,
    username: account.username,
    name: account.display_name,
    role,
    isOwner
  };

  // `isAdmin` only means "may open the workspace at all". It deliberately does
  // NOT mean "is the Owner": every active account gets a panel, but only the
  // Owner gets the privileged tabs. This was the bug that handed the whole
  // Newsroom Panel to Writers.
  return { user, isAdmin: active, isOwner, role };
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

/** True when the signed-in user may open the Newsroom Panel. */
export function isAdmin() {
  return Boolean(session?.isAdmin);
}

/**
 * True only for the single Owner account.
 *
 * Several people can hold elevated roles, but the Changelog is the Owner's
 * record of what changed and what is still outstanding, so the panel that
 * renders it is gated on this rather than on `isAdmin()`.
 */
export function isOwner() {
  return Boolean(session?.isAdmin && session?.user?.isOwner);
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
    name: username.replace(/[._-]+/g, ' '),
    // Set below, once the Owner seat has been resolved.
    isOwner: false
  };
  // In demo mode there is no account table to consult, so roles are simulated
  // from the configured allow-list:
  //   - no allow-list configured  -> a single Owner demo workspace
  //   - the FIRST entry           -> the Owner seat (mirrors the first-run claim
  //                                  in credentials.sql)
  //   - any other entry           -> Board Manager
  //   - anybody else              -> Writer
  // Everybody gets a panel, exactly as in production: `isAdmin` means "may open
  // the workspace", and the role decides which tabs appear. Someone outside the
  // allow-list therefore lands on the Writer Desk, not on a dead end. That also
  // means the demo can be used to review the per-role gating without handing
  // the Owner seat to a stranger.
  const allow = config.adminUsernames;
  const listed = allow.includes(username);
  const ownerUsername = allow[0] || null;
  const isOwnerSeat = Boolean(allow.length === 0 || (listed && username === ownerUsername));

  const role = isOwnerSeat
    ? 'Owner'
    : listed
      ? 'Board Manager'
      : 'Writer';

  user.role = role;
  user.isOwner = role === 'Owner';

  // `isAdmin` only gates whether the workspace opens at all, so it is true for
  // every signed-in demo user. The role above is what actually restricts tabs.
  return { user, isAdmin: true, isOwner: user.isOwner, role };
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
export async function approveAccount(id, role = 'Writer') {
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
