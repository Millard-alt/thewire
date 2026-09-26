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

/** Only allow http(s) and root-relative URLs through to an href/src. */
export function safeUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.startsWith('/') || raw.startsWith('#')) return raw;
  if (/^https?:\/\//i.test(raw)) return raw;
  return '';
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

  window.setTimeout(() => toast.remove(), duration);
  return toast;
}

/* -------------------------------------------------------------------------- */
/* Modal open / close with focus management                                    */
/* -------------------------------------------------------------------------- */

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

let openDialogCount = 0;

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

  if (openDialogCount === 0) document.body.style.overflow = 'hidden';
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
  if (openDialogCount === 0) document.body.style.overflow = '';

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

