/* =============================================================================
   src/views/auth.js â€” LOGIN MODAL + HEADER AUTH SLOT
   -----------------------------------------------------------------------------
   Two responsibilities:

     1. `initAuthModal()` wires the animated sign-in / sign-up dialog declared
        in index.html: tab switching, password reveal, submit handling, error
        and success messaging, password reset.
     2. `renderAuthSlot(session)` swaps the header control. Unauthenticated
        visitors get one clean "Login" button. Authenticated privileged users
        get "Admin Panel" + "Sign Out". This is the ONLY place the header's
        auth markup is produced â€” there is no static admin link in the HTML.
   ========================================================================== */

import { signIn, signUp, signOut } from '../lib/auth.js';
import { config } from '../lib/config.js';
import {
  openDialog,
  closeDialog,
  showToast,
  byId,
  escapeHtml
} from '../lib/dom.js';

/* -------------------------------------------------------------------------- */
/* Header auth slot                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Render the header's auth control.
 * @param {{user: object, isAdmin: boolean}|null} session
 * @param {{onOpenAdmin: () => void}} handlers
 */
export function renderAuthSlot(session, { onOpenAdmin } = {}) {
  const slot = byId('auth-slot');
  if (!slot) return;

  /* --- Signed out: one clean Login button -------------------------------- */
  if (!session) {
    slot.innerHTML = `
      <button type="button" id="open-auth" class="btn btn-primary">
        <i class="fa-solid fa-right-to-bracket" aria-hidden="true"></i>
        <span>Login</span>
      </button>
    `;
    slot.querySelector('#open-auth')?.addEventListener('click', openAuthModal);
    return;
  }

  /* --- Signed in --------------------------------------------------------- */
  const { user, isAdmin } = session;
  // Show the username, never the internal shadow address.
  const accountLabel = user.username || user.name || 'Account';
  const label = escapeHtml(user.name || accountLabel);
  const initials = String(user.name || accountLabel || '?')
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join('');

  slot.innerHTML = `
    ${
      isAdmin
        ? `<button type="button" id="open-admin" class="btn btn-primary">
             <i class="fa-solid fa-shield-halved" aria-hidden="true"></i>
             <span>Admin Panel</span>
           </button>`
        : `<span class="badge badge-neutral" title="Signed in with reader access">
             <i class="fa-solid fa-user" aria-hidden="true"></i> Reader
           </span>`
    }
    <div class="relative">
      <button
        type="button"
        id="account-menu-toggle"
        class="btn btn-ghost"
        aria-haspopup="true"
        aria-expanded="false"
        aria-controls="account-menu"
      >
        <span
          class="flex h-5 w-5 items-center justify-center rounded-full font-mono text-[0.625rem] font-bold"
          style="background: var(--accent); color: var(--accent-contrast)"
          aria-hidden="true"
        >${escapeHtml(initials)}</span>
        <span class="hidden sm:inline">${label}</span>
        <i class="fa-solid fa-chevron-down text-[0.5rem]" aria-hidden="true"></i>
      </button>
      <div
        id="account-menu"
        class="panel-raised absolute right-0 z-50 mt-2 hidden w-60 p-2 shadow-xl"
        role="menu"
        aria-labelledby="account-menu-toggle"
      >
        <p class="rule-soft truncate border-b px-3 pt-1 pb-2 text-[0.6875rem] ink-muted">
          @${escapeHtml(accountLabel)}
        </p>
        <button type="button" id="account-signout" class="btn btn-ghost mt-2 w-full justify-start" role="menuitem">
          <i class="fa-solid fa-right-from-bracket" aria-hidden="true"></i>
          Sign Out
        </button>
      </div>
    </div>
  `;

  slot.querySelector('#open-admin')?.addEventListener('click', onOpenAdmin);

  const toggle = slot.querySelector('#account-menu-toggle');
  const menu = slot.querySelector('#account-menu');

  toggle?.addEventListener('click', (event) => {
    event.stopPropagation();
    const open = menu?.classList.toggle('hidden') === false;
    toggle.setAttribute('aria-expanded', String(Boolean(open)));
  });

  slot.querySelector('#account-signout')?.addEventListener('click', async () => {
    closeAccountMenu();
    await performSignOut();
  });

  // Close the account menu on any outside click or Escape.
  if (!document.body.dataset.authMenuBound) {
    document.body.dataset.authMenuBound = '1';
    document.addEventListener('click', (event) => {
      if (!event.target.closest('#account-menu, #account-menu-toggle')) {
        closeAccountMenu();
      }
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeAccountMenu();
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Login modal                                                               */
/* -------------------------------------------------------------------------- */

let onAuthenticated = null;

/** Called once at boot. `callback` receives the session after a successful login. */
export function initAuthModal(callback) {
  onAuthenticated = callback || null;

  // Mode tabs
  byId('auth-tab-signin')?.addEventListener('click', () => setAuthMode('signin'));
  byId('auth-tab-signup')?.addEventListener('click', () => setAuthMode('signup'));

  // Password visibility toggles
  document.querySelectorAll('[data-toggle-password]').forEach((button) => {
    button.addEventListener('click', () => {
      const input = byId(button.dataset.togglePassword);
      if (!input) return;
      const reveal = input.type === 'password';
      input.type = reveal ? 'text' : 'password';
      button.setAttribute('aria-pressed', String(reveal));
      button.innerHTML = reveal
        ? '<i class="fa-solid fa-eye-slash" aria-hidden="true"></i>'
        : '<i class="fa-solid fa-eye" aria-hidden="true"></i>';
    });
  });

  // Forms
  byId('auth-form-signin')?.addEventListener('submit', (event) => {
    event.preventDefault();
    handleSignIn(event.currentTarget);
  });

  byId('auth-form-signup')?.addEventListener('submit', (event) => {
    event.preventDefault();
    handleSignUp(event.currentTarget);
  });

  byId('auth-forgot-password')?.addEventListener('click', (event) => {
    event.preventDefault();
    handleForgotPassword();
  });

  // The open-Login button is rendered dynamically by renderAuthSlot, so bind
  // via delegation as well â€” this covers the very first paint.
  document.addEventListener('click', (event) => {
    if (event.target.closest('#open-auth')) openAuthModal();
  });

  // Tell the visitor which auth backend they are actually talking to. In demo
  // mode this prevents anyone being confused by a fake sign-in.
  const note = byId('auth-backend-note');
  if (note && config.demoMode) {
    note.hidden = false;
    note.textContent =
      'Demo mode: Supabase keys were not found in .env, so any valid e-mail ' +
      'with a password of 8+ characters will sign you in and store the ' +
      'session in this browser only.';
  }
}

/** Open the dialog and focus the e-mail field. */
export function openAuthModal() {
  setAuthMode('signin');
  clearAuthMessages();
  openDialog('auth-modal', { initialFocus: '#auth-signin-login' });
}

/** Switch between the sign-in and sign-up panels. */
export function setAuthMode(mode) {
  const signIn_ = mode === 'signin';
  byId('auth-form-signin')?.classList.toggle('hidden', !signIn_);
  byId('auth-form-signup')?.classList.toggle('hidden', signIn_);

  const tabIn = byId('auth-tab-signin');
  const tabUp = byId('auth-tab-signup');
  tabIn?.setAttribute('aria-selected', String(signIn_));
  tabUp?.setAttribute('aria-selected', String(!signIn_));
  tabIn?.classList.toggle('active', signIn_);
  tabUp?.classList.toggle('active', !signIn_);
}


/* -------------------------------------------------------------------------- */
/* Message helpers                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Write a status/error line inside the modal.
 * @param {'error'|'success'|'info'} type
 * @param {string} message
 */
function setAuthMessage(type, message) {
  const box = byId(type === 'error' ? 'auth-error' : 'auth-success');
  if (!box) return;

  const isError = type === 'error';
  box.className = isError
    ? 'mt-3 flex items-start gap-2 rounded px-3 py-2 text-xs font-semibold'
    : 'mt-3 flex items-start gap-2 rounded px-3 py-2 text-xs font-semibold';
  box.classList.remove('hidden');
  box.style.background = isError
    ? 'color-mix(in srgb, #b3261a 14%, transparent)'
    : 'color-mix(in srgb, #10b981 14%, transparent)';
  box.style.color = isError
    ? 'var(--color-newsred-bright)'
    : 'var(--text)';
  box.style.border = isError
    ? '1px solid color-mix(in srgb, #b3261a 35%, transparent)'
    : '1px solid color-mix(in srgb, #10b981 35%, transparent)';
  box.innerHTML = `
    <i class="fa-solid ${isError ? 'fa-triangle-exclamation' : 'fa-circle-check'} mt-0.5" aria-hidden="true"></i>
    <span>${escapeHtml(message)}</span>
  `;
}

/** Clear both status regions. */
export function clearAuthMessages() {
  const errorBox = byId('auth-error');
  const successBox = byId('auth-success');
  if (errorBox) {
    errorBox.replaceChildren();
    errorBox.classList.add('hidden');
  }
  if (successBox) {
    successBox.replaceChildren();
    successBox.classList.add('hidden');
  }
}

/** Put a button into a loading state and disable the whole form. */
function setFormBusy(form, busy, busyLabel = 'Please waitâ€¦') {
  if (!form) return;
  form.setAttribute('aria-busy', String(busy));
  form.querySelectorAll('input, button').forEach((node) => {
    node.disabled = busy;
  });
  const submit = form.querySelector('button[type="submit"]');
  if (submit) {
    if (busy) {
      submit.dataset.originalLabel = submit.innerHTML;
      submit.innerHTML = `<i class="fa-solid fa-circle-notch spin-slow" aria-hidden="true"></i> ${escapeHtml(busyLabel)}`;
    } else if (submit.dataset.originalLabel) {
      submit.innerHTML = submit.dataset.originalLabel;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Form submissions                                                           */
/* -------------------------------------------------------------------------- */

/** Sign a reader or staff member in with username + password. */
async function handleSignIn(form) {
  clearAuthMessages();

  const login = byId('auth-signin-login')?.value || '';
  const password = byId('auth-signin-password')?.value || '';

  if (!login.trim() || !password) {
    setAuthMessage('error', 'Enter both your username and password.');
    return;
  }

  setFormBusy(form, true, 'Signing inâ€¦');
  try {
    // The welcome toast and the "open the workspace" decision belong to the
    // app-level callback, so this handler only reports failures â€” never a
    // second success message.
    const session = await signIn({ login, password });
    closeDialog('auth-modal');
    form.reset();
    onAuthenticated?.(session);
  } catch (error) {
    setAuthMessage('error', error.message || 'Could not sign you in.');
  } finally {
    setFormBusy(form, false);
  }
}

/**
 * Register an account.
 *
 * The very first account on a fresh install becomes the Owner and is signed in
 * straight away. Everyone after that is recorded as a pending request and must
 * be approved by the Owner before they can sign in.
 */
async function handleSignUp(form) {
  clearAuthMessages();

  const name = byId('auth-signup-name')?.value || '';
  const login = byId('auth-signup-login')?.value || '';
  const password = byId('auth-signup-password')?.value || '';

  if (!login.trim()) {
    setAuthMessage('error', 'Choose a username.');
    return;
  }

  if (password.length < 8) {
    setAuthMessage('error', 'Passwords must be at least 8 characters long.');
    return;
  }

  setFormBusy(form, true, 'Creating account...');
  try {
    const { isOwner, requiresApproval } = await signUp({ name, login, password });

    closeDialog('auth-modal');
    form.reset();

    if (requiresApproval) {
      showToast(
        'Request received. The Owner must approve your account before you can sign in.',
        { type: 'info' }
      );
      onAuthenticated?.(null);
      return;
    }

    showToast(
      isOwner
        ? 'Welcome. Your Owner account is ready.'
        : 'Account created and signed in.',
      { type: 'success' }
    );
    onAuthenticated?.(null);
  } catch (error) {
    setAuthMessage('error', error.message || 'Could not create the account.');
  } finally {
    setFormBusy(form, false);
  }
}

/**
 * Passwords are never sent by e-mail here â€” there is no inbox behind a
 * username. The Owner resets them from the Staff roster, which also revokes
 * that person's existing sessions.
 */
function handleForgotPassword() {
  setAuthMessage(
    'info',
    'Passwords are reset by the Owner from the Staff roster in the Control Center. ' +
      'Ask the Owner to reset it for you â€” it takes effect immediately.'
  );
}

/** Collapse the account dropdown. */
function closeAccountMenu() {
  const menu = byId('account-menu');
  const toggle = byId('account-menu-toggle');
  menu?.classList.add('hidden');
  toggle?.setAttribute('aria-expanded', 'false');
}

/** Sign out and tell the user. Errors are surfaced, never swallowed. */
export async function performSignOut() {
  try {
    await signOut();
    showToast('You have been signed out.', { type: 'info' });
  } catch (error) {
    showToast(error.message || 'Could not sign out.', { type: 'error' });
  }
}
