/* =============================================================================
   src/lib/dom.js — SMALL UI PRIMITIVES
   -----------------------------------------------------------------------------
   Escaping, toasts, focus-trapped dialogs and modal open/close helpers shared
   by every view. Keeping these in one place is what lets the public site, the
   auth modal and the admin workspace behave consistently.
   ========================================================================== */

/* -------------------------------------------------------------------------- */
/* Escaping                                                                    */
/* -------------------------------------------------------------------------- */

const HTML_ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
};

/** Escape a value for safe interpolation into an HTML template string. */
export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}

/** Escape a value used inside an HTML attribute (quotes + angle brackets). */
export function escapeAttr(value) {
  return escapeHtml(value);
}

/**
 * Only allow http(s) and root-relative URLs through to an href/src.
 *
 * The scheme check is the load-bearing part: it is what stops `javascript:`,
 * `data:` and `vbscript:` from reaching an attribute. `//host/path` is returned
 * as-is because a protocol-relative URL inherits the page's own scheme and so
 * cannot introduce a new one.
 *
 * `allowedHosts` is an OPTIONAL narrowing, not an allowlist by default. The
 * interviews feature needed it: an <iframe src> built from a YouTube id must be
 * provably a YouTube host, and asserting that at the point of use beats
 * trusting the caller's template. Callers that pass it get '' for any host not
 * listed, which is the correct failure -- the embed does not render rather than
 * rendering from somewhere unexpected.
 *
 * Host comparison is on the lower-cased hostname only, never the full URL, so a
 * hostile `https://evil.test/?x=youtube.com` cannot match. A leading `.` on an
 * entry means "this host and any subdomain of it", which is how the bare
 * `youtube.com` entry covers `www.` and `m.`.
 *
 * @param {unknown} value
 * @param {{allowedHosts?: string[]}} [options]
 * @returns {string} the URL, or '' when it is unsafe
 */
export function safeUrl(value, { allowedHosts } = {}) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.startsWith('/') || raw.startsWith('#')) return raw;
  if (!/^https?:\/\//i.test(raw)) return '';

  if (Array.isArray(allowedHosts) && allowedHosts.length) {
    // new URL() throws on a malformed absolute URL, which the regex above
    // already narrowed to http(s)://something -- but the something may still be
    // junk, so a parse failure is a rejection, not a crash.
    let host;
    try {
      host = new URL(raw).hostname.toLowerCase();
    } catch {
      return '';
    }

    const permitted = allowedHosts.some((entry) => {
      const wanted = String(entry || '').trim().toLowerCase().replace(/^\.+/, '');
      if (!wanted) return false;
      // Exact match, or a subdomain of an entry that was written with a dot.
      const suffix = String(entry || '').trim().startsWith('.') ? wanted : `.${wanted}`;
      return host === wanted || host.endsWith(suffix);
    });

    if (!permitted) return '';
  }

  return raw;
}

/* -------------------------------------------------------------------------- */
/* Broken-image fallback                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A neutral portrait glyph, used when a stored image URL turns out to be dead.
 *
 * A DATA URI on purpose. `safeUrl()` deliberately rejects `data:` for anything
 * that came out of the database, and this value never did -- but the reason for
 * inlining it rather than shipping `public/assets/default-avatar.png` is the
 * failure mode: pointing `onerror` at a file on disk means the fallback can
 * itself 404, `onerror` fires again, and the browser retries the same broken
 * request until it gives up. A data URI cannot fail, so it cannot loop.
 */
export const AVATAR_FALLBACK =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">' +
      '<rect width="128" height="128" fill="#e7e1d3"/>' +
      '<circle cx="64" cy="48" r="22" fill="#8c1d11" opacity="0.35"/>' +
      '<path d="M22 122a42 42 0 0 1 84 0z" fill="#8c1d11" opacity="0.35"/></svg>'
  );

/**
 * The `onerror` attribute for a rendered `<img>`.
 *
 * `this.onerror = null` first, so the swap happens exactly once: without it a
 * fallback that itself fails re-enters the handler forever.
 *
 * @param {string} [fallback] any URL the browser can always fetch
 * @returns {string} an attribute fragment, safe to interpolate into a template
 */
export function imageFallbackAttr(fallback = AVATAR_FALLBACK) {
  return `onerror="this.onerror=null;this.src='${escapeAttr(fallback)}'"`;
}

/* -------------------------------------------------------------------------- */
/* Toasts                                                                     */
/* -------------------------------------------------------------------------- */

let toastStack = null;

function ensureToastStack() {
  if (!toastStack || !document.body.contains(toastStack)) {
    toastStack = document.createElement('div');
    toastStack.className = 'toast-stack no-print';
    toastStack.setAttribute('role', 'status');
    toastStack.setAttribute('aria-live', 'polite');
    document.body.appendChild(toastStack);
  }
  return toastStack;
}

/**
 * Show a transient notification.
 * @param {string} message
 * @param {{type?: 'info'|'success'|'error', duration?: number}} [options]
 */
export function showToast(message, { type = 'info', duration = 4200 } = {}) {
  const stack = ensureToastStack();
  const toast = document.createElement('div');
  toast.className = `toast animate-toast-in${type === 'success' ? ' toast-success' : ''}${
    type === 'error' ? ' toast-error' : ''
  }`;

  const icon = document.createElement('i');
  icon.setAttribute('aria-hidden', 'true');
  icon.classList.add(
    'fa-solid',
    type === 'success'
      ? 'fa-circle-check'
      : type === 'error'
        ? 'fa-triangle-exclamation'
        : 'fa-circle-info'
  );

  const text = document.createElement('span');
  text.className = 'flex-1';
  text.textContent = message;

  const close = document.createElement('button');
  close.className = 'btn-quiet text-xs';
  close.setAttribute('aria-label', 'Dismiss notification');
  close.innerHTML = '<i class="fa-solid fa-xmark" aria-hidden="true"></i>';
  close.addEventListener('click', () => toast.remove());

  toast.append(icon, text, close);
  stack.appendChild(toast);

  // Duration 0 means "stay until dismissed", not "go away immediately".
  // `setTimeout(fn, 0)` fires on the next tick, so every long-running toast
  // built with duration: 0 -- the in-flight upload notices -- was vanishing
  // the moment it was shown.
  let timer = null;
  if (duration > 0) {
    timer = window.setTimeout(() => toast.remove(), duration);
  }

  /**
   * Rewrite the message of a toast already on screen, for progress reporting.
   * Clears any pending auto-dismiss so an update cannot be yanked away
   * mid-flight, and cancels the timer when the toast is removed by hand.
   */
  toast.setMessage = (next) => {
    text.textContent = next;
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
    return toast;
  };

  const originalRemove = toast.remove.bind(toast);
  toast.remove = () => {
    if (timer !== null) window.clearTimeout(timer);
    originalRemove();
  };

  return toast;
}

/* -------------------------------------------------------------------------- */
/* Modal open / close with focus management                                    */
/* -------------------------------------------------------------------------- */

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

let openDialogCount = 0;

/**
 * Drop every outstanding dialog scroll lock.
 *
 * The Newsroom Panel is a full-screen view that mounts while dialogs may
 * still be registered in the counter. Without this reset the stale lock keeps
 * the page unscrollable, which is what made the workspace unusable on Android.
 */
export function releaseDialogLocks() {
  openDialogCount = 0;
  document.body.classList.remove('dialog-locked');
}

/** Keep Tab focus inside the dialog. */
function trapFocus(dialog, event) {
  const nodes = Array.from(dialog.querySelectorAll(FOCUSABLE)).filter(
    (node) => node.offsetParent !== null || node === document.activeElement
  );
  if (!nodes.length) return;

  const first = nodes[0];
  const last = nodes[nodes.length - 1];

  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

/**
 * Open a dialog element.
 * @param {string|HTMLElement} target element or id
 * @param {{initialFocus?: string}} [options]
 */
export function openDialog(target, { initialFocus } = {}) {
  const dialog =
    typeof target === 'string' ? document.getElementById(target) : target;
  if (!dialog) return null;

  dialog.dataset.returnFocus = document.activeElement?.id || '';
  dialog.classList.remove('hidden');
  dialog.classList.add('animate-backdrop-in');

  const card = dialog.querySelector('.modal-card') || dialog.firstElementChild;
  if (card) {
    card.classList.remove('animate-modal-in');
    void card.offsetWidth; // restart the animation
    card.classList.add('animate-modal-in');
  }

  /*
  Scroll lock for open dialogs.

  This used to be an inline `document.body.style.overflow = 'hidden'`. An inline
  style outranks every stylesheet rule, so if a dialog was still open when the
  Newsroom Panel mounted, the lock survived and the workspace could never
  be scrolled on a phone — the page looked frozen with half the screen hidden
  behind the tab strip.

  A class is used instead so the cascade can resolve it, and the counter is
  clearable via releaseDialogLocks() when a full-screen view takes over.
  */
  if (openDialogCount === 0) document.body.classList.add('dialog-locked');
  openDialogCount += 1;

  const focusTarget = initialFocus
    ? dialog.querySelector(initialFocus)
    : card?.querySelector(FOCUSABLE) || card;
  window.setTimeout(() => focusTarget?.focus?.(), 40);

  return dialog;
}

/** Close a dialog element and restore focus. */
export function closeDialog(target) {
  const dialog =
    typeof target === 'string' ? document.getElementById(target) : target;
  if (!dialog || dialog.classList.contains('hidden')) return;

  dialog.classList.add('hidden');
  dialog.classList.remove('animate-backdrop-in');

  openDialogCount = Math.max(0, openDialogCount - 1);
  if (openDialogCount === 0) document.body.classList.remove('dialog-locked');

  const returnId = dialog.dataset.returnFocus;
  if (returnId) document.getElementById(returnId)?.focus?.();
}

/** True when the element is currently visible. */
export function isOpen(target) {
  const dialog =
    typeof target === 'string' ? document.getElementById(target) : target;
  return Boolean(dialog && !dialog.classList.contains('hidden'));
}

/* -------------------------------------------------------------------------- */
/* Global dialog wiring                                                        */
/* -------------------------------------------------------------------------- */

/**
 * One delegated listener for every dialog in the document:
 *   - `data-close-dialog="<id>"` closes that dialog
 *   - clicking the backdrop itself closes it
 *   - Escape closes the top-most dialog
 *   - Tab is trapped inside the open dialog
 */
export function initDialogBehaviour() {
  document.addEventListener('click', (event) => {
    const closer = event.target.closest('[data-close-dialog]');
    if (closer) {
      event.preventDefault();
      closeDialog(closer.dataset.closeDialog);
      return;
    }

    const dialog = event.target.closest('.modal-backdrop');
    if (dialog && event.target === dialog) {
      closeDialog(dialog);
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    const dialogs = Array.from(
      document.querySelectorAll('.modal-backdrop:not(.hidden)')
    );
    const top = dialogs[dialogs.length - 1];
    if (top) closeDialog(top);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return;
    const dialogs = Array.from(
      document.querySelectorAll('.modal-backdrop:not(.hidden)')
    );
    const top = dialogs[dialogs.length - 1];
    if (top) trapFocus(top, event);
  });
}

/* -------------------------------------------------------------------------- */
/* Misc                                                                       */
/* -------------------------------------------------------------------------- */

/** `<span id="x">` -> HTMLElement */
export function byId(id) {
  return document.getElementById(id);
}

/** Toggle the `hidden` utility class on an element. */
export function toggleHidden(element, force) {
  if (!element) return;
  element.classList.toggle('hidden', force);
}

/** Pretty-print a headline date for the masthead. */
export function formatEditionDate(date = new Date()) {
  return date.toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  });
}

/** Read the value of a checkbox-ish input safely. */
export function checked(id) {
  return Boolean(document.getElementById(id)?.checked);
}

