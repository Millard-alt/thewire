/* =============================================================================
   src/app.js — APPLICATION ENTRY POINT
   -----------------------------------------------------------------------------
   The orchestrator. Responsibilities, in boot order:

     1. Paint the stored/system theme before anything else (no flash).
     2. Wire global dialog behaviour (Escape, backdrop, focus trap).
     3. Load data from Supabase or the local demo store.
     4. Render the public publication and the masthead.
     5. Restore any existing auth session and swap the header control:
          signed out  -> a single "Login" button
          signed in   -> account chip + "Admin Panel" + "Sign out"
                      -> (and, for privileged users, the control centre mounts)
     6. Keep the header in sync with the auth state on every change.

   Security posture
   ----------------
   The "Admin Panel" markup does not exist in index.html. It is generated at
   runtime by views/auth.js and only when `session.isAdmin` is true, which
   itself is derived from either the VITE_ADMIN_EMAILS allow-list or an Active
   row in the `staff` table. views/admin.js re-checks on every mount. The
   authoritative gate remains Supabase Row Level Security — this is defence in
   depth, not a replacement.
   ========================================================================== */

import { config, describeBackend } from './lib/config.js';
import { initAuth, onAuthChange } from './lib/auth.js';
import * as store from './lib/store.js';
import { initThemeControls, getActiveTheme } from './lib/theme.js';
import { initDialogBehaviour, byId, showToast } from './lib/dom.js';

import {
  renderMasthead,
  renderBreakingBanner,
  renderPublication,
  initPublicInteractions
} from './views/public.js';

import { initAuthModal, renderAuthSlot } from './views/auth.js';
import { openAdmin, closeAdmin, isAdminOpen } from './views/admin.js';
import { initAlerts, ensureAlertPermission } from './views/alerts.js';

/* -------------------------------------------------------------------------- */
/* Rendering                                                                  */
/* -------------------------------------------------------------------------- */

/* These renderers paint their own host nodes and return nothing. Assigning
   their (undefined) return value back into the DOM used to wipe the markup and
   print the literal text "undefined" on the page, which also left the front page
   with zero articles. Just call them. */
function renderPublicView() {
  renderPublication();
}

/** Repaint the masthead + breaking ticker from stored branding. */
function renderChrome() {
  renderMasthead();
  renderBreakingBanner();
  const year = byId('footer-year');
  if (year) year.textContent = String(new Date().getFullYear());
}

/** Full public repaint. */
function renderPublic() {
  renderChrome();
  renderPublicView();
}

/* -------------------------------------------------------------------------- */
/* Auth-driven navigation                                                      */
/* -------------------------------------------------------------------------- */

/**
 * React to an auth state change.
 *
 * - Always repaints the header control.
 * - Closes the control centre if the session was revoked underneath us, so a
 *   sign-out in another tab can never leave admin UI on screen.
 */
function handleSessionChange(session) {
  renderAuthSlot(session, {
    onOpenAdmin: () => openAdmin()
  });

  if (isAdminOpen() && !session?.isAdmin) {
    closeAdmin();
  }
}

/** Close a dialog by id, ignoring "not open" cases. */
function closeDialogSafely(id) {
  const dialog = byId(id);
  if (dialog && !dialog.classList.contains('hidden')) {
    dialog.classList.add('hidden');
    document.body.style.overflow = '';
  }
}

/**
 * Swap the sun/moon glyph inside the theme switch thumb so it always
 * advertises the theme you would move *to* (sun while dark, moon while light).
 */
function syncThemeIcon() {
  const icon = document.querySelector('.theme-icon');
  if (!icon) return;
  const dark = getActiveTheme() === 'dark';
  icon.classList.toggle('fa-sun', !dark);
  icon.classList.toggle('fa-moon', dark);
}

/* -------------------------------------------------------------------------- */
/* Boot                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Start the application. Exported so a test or a future SSR path can await it.
 * @returns {Promise<void>}
 */
export async function boot() {
  /* --- 1. Theme ---------------------------------------------------------- */
  // The inline <head> script already set the class before first paint; this
  // attaches the toggle's behaviour and syncs the switch to the active theme.
  initThemeControls();
  syncThemeIcon();

  /* --- 2. Global dialog behaviour ---------------------------------------- */
  initDialogBehaviour();

  /* --- 3. Data ----------------------------------------------------------- */
  try {
    await store.hydrate();
  } catch (error) {
    console.error('[app] could not load publication data', error);
    showToast('Some publication data could not be loaded.', { type: 'error' });
  }

  /* --- 4. Public view ---------------------------------------------------- */
  renderPublic();
  initPublicInteractions();

  /* --- 4b. Alerts -------------------------------------------------------- */
  // Registers the service worker, paints the opt-in bar, warns about ad
  // blockers and starts polling for the owner's broadcasts. Never throws, so a
  // device without notification support still renders the publication.
  try {
    await initAlerts();
  } catch (error) {
    console.warn('[app] notifications unavailable', error);
  }

  // Keep the public site live: any store write (from the admin workspace or a
  // second tab) repaints it without a reload.
  store.subscribe(() => {
    if (!isAdminOpen()) renderPublic();
  });

  /* --- 5. Auth ----------------------------------------------------------- */
  // Restore any persisted session first, so a returning owner lands in the
  // workspace without touching the Login button.
  try {
    await initAuth();
  } catch (error) {
    console.warn('[app] session restore failed', error);
  }

  initAuthModal((session) => {
    handleSessionChange(session);

    if (!session) return;
    closeDialogSafely('auth-modal');

    if (session.isAdmin) {
      showToast(
        `Welcome back, ${session.user.username || session.user.name || session.user.email}.`,
        { type: 'success' }
      );
      // Land straight in the workspace: that is what the Login button promised.
      openAdmin();
    } else {
      showToast('Signed in. This account is not on the staff roster.', {
        type: 'info'
      });
    }
  });

  onAuthChange(handleSessionChange);

  /* --- 6. Environment notice (dev only) ---------------------------------- */
  if (import.meta.env?.DEV && config.demoMode) {
    console.info(
      `%c[${config.siteName}]%c demo mode — ${describeBackend().detail}`,
      'background:#8c1d11;color:#fff;padding:2px 6px;border-radius:3px;font-weight:700',
      'color:inherit'
    );
  }

  // A theme flip in another tab should repaint the toggle icon here too.
  window.addEventListener('wire:themechange', syncThemeIcon);

  document.body.classList.add('app-ready');
}

/* -------------------------------------------------------------------------- */
/* Auto-start                                                                  */
/* -------------------------------------------------------------------------- */

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}

/* -------------------------------------------------------------------------- */
/* Global safety nets                                                          */
/* -------------------------------------------------------------------------- */

// A failed request should never leave the user staring at a dead button.
window.addEventListener('unhandledrejection', (event) => {
  console.error('[app] unhandled rejection', event.reason);
  showToast('Something went wrong. Please try that again.', { type: 'error' });
});

window.addEventListener('error', (event) => {
  if (event.message) console.error('[app]', event.error || event.message);
});
