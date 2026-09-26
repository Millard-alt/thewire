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
import { initAuth, onAuthChange, getSession } from './lib/auth.js';
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
import { renderCredits, primePortraits } from './lib/credits.js';
import {
  openPortraitEditor,
  portraitRequirementMet,
  portraitRequirementSatisfiable
} from './lib/portrait.js';

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

/* -------------------------------------------------------------------------- */
/* Reader view switching (Publication <-> Credits)                              */
/* -------------------------------------------------------------------------- */

/** The reader-facing section currently on screen. */
let readerView = 'publication';

/**
 * Show exactly one reader view. The Owner workspace is untouched by this, so a
 * reader deep-link never has to reload to reach the credits.
 * @param {'publication'|'credits'} name
 */
function showReaderView(name) {
  const target = name === 'credits' ? 'credits' : 'publication';
  readerView = target;

  const publication = byId('publication-view');
  const credits = byId('credits-view');

  if (publication) publication.classList.toggle('hidden', target !== 'publication');
  if (credits) credits.classList.toggle('hidden', target !== 'credits');

  // Paint the credits roster on first reveal only: it costs a round-trip, and
  // the publication is what most visitors want first.
  if (target === 'credits') {
    renderCredits(credits);
    if (credits && !credits.dataset.painted) credits.dataset.painted = '1';
  }

  // Keep the header nav's pressed state honest.
  document
    .querySelectorAll('[data-nav]')
    .forEach((link) =>
      link.setAttribute(
        'aria-current',
        link.dataset.nav === target ? 'page' : 'false'
      )
    );

  if (target === 'publication') renderPublicView();
}


/** Full public repaint. */
function renderPublic() {
  renderChrome();
  renderPublicView();
}

/**
 * Wire the header's reader links. Delegated on the document because the masthead
 * is re-rendered, so per-element listeners would be lost on every repaint.
 */
function initReaderNavigation() {
  if (document.body.dataset.readerNavBound) return;
  document.body.dataset.readerNavBound = '1';

  document.addEventListener('click', (event) => {
    const link = event.target.closest('[data-nav]');
    if (!link) return;

    // Only the two reader views are handled here. data-nav is also used by the
    // workspace for in-panel jumps, so guard on the known set.
    const target = link.dataset.nav;
    if (target !== 'credits' && target !== 'publication') return;

    event.preventDefault();

    // Leaving the workspace first: the Owner panel owns the whole screen, and
    // readers should land on the page they asked for.
    if (isAdminOpen()) closeAdmin();

    showReaderView(target);
    byId('main-content')?.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  /**
   * Section links (Latest, Today's Pick, Weekly, Gallery, Assignments, Masthead).
   *
   * These are plain `href="#id"` anchors and rely on the browser's native
   * fragment scrolling. That silently does nothing whenever the element they
   * point at is not visible: on the credits page the whole publication view is
   * `hidden`, and the Owner workspace is a fixed overlay that covers the page.
   * So we have to reveal the right view first, then scroll ourselves.
   */
  document.addEventListener('click', (event) => {
    const link = event.target.closest('a.nav-link[href^="#"]');
    if (!link) return;

    const id = link.getAttribute('href').slice(1);
    if (!id) return;

    event.preventDefault();

    // The Owner panel owns the screen; dismiss it so the anchor is reachable.
    if (isAdminOpen()) closeAdmin();

    // Any section anchor belongs to the publication, so leave the credits page.
    if (readerView !== 'publication') showReaderView('publication');

    // The publication may still be painting, so retry on the next frame rather
    // than measuring an element that does not exist yet.
    const scrollToSection = (attempt = 0) => {
      const target = document.getElementById(id);
      if (!target) {
        if (attempt < 10) requestAnimationFrame(() => scrollToSection(attempt + 1));
        return;
      }
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });

      // A sticky header would otherwise cover the heading we just scrolled to.
      const sticky = document.querySelector('nav.sticky');
      if (sticky) {
        const offset = sticky.getBoundingClientRect().height + 8;
        const top = target.getBoundingClientRect().top + window.scrollY - offset;
        window.scrollTo({ top, behavior: 'smooth' });
      }
    };

    scrollToSection();

    // Keep the address bar honest so the link can be shared/refreshed.
    if (window.location.hash !== `#${id}`) {
      history.replaceState(null, '', `#${id}`);
    }
  });

  // Land on the credits page when a reader arrives with #credits in the URL.
  if (window.location.hash === '#credits') showReaderView('credits');
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
    onOpenAdmin: () => {
      // Editors must have an approved portrait before the workspace opens.
      if (!enforcePortraitGate()) return;
      openAdmin();
    }
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
/* Portrait requirement                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Find this editor's own roster row.
 *
 * The roster is keyed by the username (or e-mail) the person signs in with,
 * because `staff_accounts` holds the credentials and `staff` holds the profile.
 * Returns null when there is no match — which is itself a blocked state.
 */
function myStaffRow() {
  const session = getSession();
  const login = session?.user?.username || session?.user?.email;
  if (!login) return null;

  const wanted = String(login).toLowerCase();
  return (
    store
      .listStaff()
      .find(
        (row) =>
          String(row.username || row.email || '')
            .trim()
            .toLowerCase() === wanted
      ) || null
  );
}

/**
 * Enforce "no editor features without an approved portrait".
 *
 * The Owner is exempt (the gate exists to verify editors), as is demo mode
 * (there is no server to approve against, so blocking would be a dead end).
 * Everyone else must have an approved portrait before the workspace opens.
 * @returns {boolean} true when the editor may proceed
 */
function enforcePortraitGate() {
  const session = getSession();
  if (!session?.user) return false;
  if (portraitRequirementMet(null, session)) return true;

  const row = myStaffRow();

  // Already uploaded something and it is merely awaiting review: let them in,
  // otherwise they would be locked out of the screen showing that fact.
  if (portraitRequirementSatisfiable(row)) return true;

  if (row?.portrait_status === 'rejected') {
    showToast('Your last portrait was rejected. Please upload a new one.', {
      type: 'error'
    });
  } else {
    showToast('Add a newsroom portrait before using the workspace.', {
      type: 'info'
    });
  }

  openPortraitEditor();
  return false;
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

  /* --- 3b. Portrait cache ------------------------------------------------- */
  // Bylines are painted synchronously by `bylineSticker`, so the approved
  // portraits have to be in the cache BEFORE the first renderPublic() below —
  // otherwise every card falls back to the plain-text byline and the stickers
  // never appear. Failure is non-fatal: the plain byline is a fine fallback.
  try {
    await primePortraits();
  } catch (error) {
    console.warn('[app] portraits unavailable', error);
  }

  /* --- 4. Public view ---------------------------------------------------- */
  renderPublic();
  initPublicInteractions();
  initReaderNavigation();

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
  // second tab) repaints it without a reload. The credits roster is refetched
  // too, because the Owner can change it from the workspace at any moment.
  store.subscribe(() => {
    if (isAdminOpen()) return;
    if (readerView === 'credits') {
      const credits = byId('credits-view');
      if (credits) renderCredits(credits);
      renderChrome();
    } else {
      renderPublic();
    }
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
      // The Owner is exempt from the portrait gate.
      if (enforcePortraitGate()) openAdmin();
    } else {
      showToast('Signed in. This account is not on the staff roster.', {
        type: 'info'
      });
      // A rostered editor signing in still has to satisfy the portrait rule
      // before the workspace becomes usable.
      enforcePortraitGate();
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
