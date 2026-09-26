/* =============================================================================
   src/views/alerts.js â€” READER NOTIFICATION GATE
   -----------------------------------------------------------------------------
   The publication's alerts are opt-in and the browser will only ever ask once,
   from inside a real click. This module owns that conversation so it happens
   before the reader is shown a popup, never after.

       initAlerts()            render the opt-in bar, detect blockers, poll
       ensureAlertPermission() show the instructions and request permission
       alertStatusText()       one line describing the current state

   A story cannot be opened until alerts are on, so the reader always sees the
   instructions *before* a notification is ever delivered to them.
   ========================================================================== */

import * as push from '../lib/push.js';
import * as store from '../lib/store.js';
import { config } from '../lib/config.js';
import { byId, escapeHtml, showToast } from '../lib/dom.js';

const BAR_ID = 'alert-optin-bar';
const GATE_ID = 'alert-gate';

/** The steps a reader must follow, tailored to what actually went wrong. */
function instructions(permission) {
  const steps = [];

  if (permission === 'unsupported') {
    steps.push(
      'This browser cannot show system notifications, or the page is not on a ' +
        'secure (https) connection.',
      'Open The Wire over https, or use Chrome, Edge, Firefox or Safari on a phone.'
    );
  } else if (permission === 'denied') {
    steps.push(
      'Your browser is blocking notifications for this site.',
      'Tap the padlock or the â€œiâ€ icon beside the address bar, then choose ' +
        'â€œAllow notificationsâ€ for The Wire.',
      'Reload the page afterwards.'
    );
  } else {
    steps.push(
      'Tap â€œTurn on alertsâ€. Your phone will ask you to confirm.',
      'Choose â€œAllowâ€ so The Wire can reach you when a dispatch breaks.'
    );
  }

  const blocker = push.adblockLike();
  if (blocker.stylesBlocked || blocker.notificationsStubbed) {
    steps.push(
      'An ad blocker is interfering with this page.',
      'Allow this site in your blocker, or open The Wire in an Incognito window.'
    );
  }

  return steps;
}

function gateMarkup(permission) {
  const steps = instructions(permission)
    .map(
      (step, index) => `
        <li class="flex gap-3">
          <span
            class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[0.65rem] font-bold"
            style="background: var(--accent); color: var(--accent-contrast)"
            aria-hidden="true"
          >${index + 1}</span>
          <span class="text-sm leading-relaxed">${escapeHtml(step)}</span>
        </li>`
    )
    .join('');

  return `
    <div class="space-y-5">
      <p class="text-sm leading-relaxed">
        The Wire only shows a dispatch once alerts are on. Here is how to turn
        them on â€” this is the last step before your first notification.
      </p>
      <ol class="space-y-3">${steps}</ol>
    </div>
  `;
}

/* -------------------------------------------------------------------------- */
/* Instruction modal                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Show the instructions, then ask for permission from the reader's tap.
 * @returns {Promise<boolean>} true once notifications are permitted
 */
export async function ensureAlertPermission() {
  const permission = push.getPermission();
  if (permission === 'granted') return true;
  if (!config.pushBroadcastsEnabled) {
    showToast('The owner has paused alerts for now.', { type: 'info' });
    return false;
  }

  const dialog = byId(GATE_ID);
  if (!dialog) {
    // No dialog in the DOM â€” ask directly rather than trapping the reader.
    return (await push.requestPermission()) === 'granted';
  }

  const body = byId('alert-gate-body');
  if (body) body.innerHTML = gateMarkup(permission);

  dialog.classList.remove('hidden');
  dialog.removeAttribute('aria-hidden');

  return new Promise((resolve) => {
    const done = (value) => {
      dialog.classList.add('hidden');
      dialog.setAttribute('aria-hidden', 'true');
      byId('alert-gate-allow')?.removeEventListener('click', onAllow);
      byId('alert-gate-dismiss')?.removeEventListener('click', onDismiss);
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };

    const onAllow = async () => {
      byId('alert-gate-allow')?.setAttribute('disabled', 'disabled');
      const result = await push.requestPermission();
      byId('alert-gate-allow')?.removeAttribute('disabled');

      if (result === 'granted') {
        push.startBroadcastPolling();
        showToast('Alerts are on for this device.', { type: 'success' });
        done(true);
        return;
      }

      // Still blocked: say so plainly rather than looping the reader.
      if (body) body.innerHTML = gateMarkup(result);
      showToast('Alerts are still blocked. Follow the steps above, then try again.', {
        type: 'error',
        duration: 6000
      });
      done(false);
    };

    const onDismiss = () => {
      showToast('You can turn alerts on any time from the header.', { type: 'info' });
      done(false);
    };

    const onKey = (event) => {
      if (event.key === 'Escape') onDismiss();
    };

    byId('alert-gate-allow')?.addEventListener('click', onAllow);
    byId('alert-gate-dismiss')?.addEventListener('click', onDismiss);
    document.addEventListener('keydown', onKey);
    byId('alert-gate-allow')?.focus();
  });
}

/* -------------------------------------------------------------------------- */
/* Opt-in bar + blocker warning                                                */
/* -------------------------------------------------------------------------- */

/** One line describing the current push state, for the bar and the header. */
export function alertStatusText() {
  return push.pushStatus();
}

/**
 * Show the instructions outside the gate, for a reader already on the page
 * when their blocker is detected.
 */
function showInstructions(title) {
  const body = byId('alert-gate-body');
  const heading = byId('alert-gate-title');
  if (heading) heading.textContent = title;
  if (body) body.innerHTML = gateMarkup(push.getPermission());

  const dialog = byId(GATE_ID);
  if (!dialog) return;
  dialog.classList.remove('hidden');
  dialog.removeAttribute('aria-hidden');
  byId('alert-gate-dismiss')?.focus();
}

/** Paint (or remove) the opt-in bar. */
function renderOptInBar() {
  const bar = byId(BAR_ID);
  if (!bar) return;

  // No bar at all when the owner has switched alerts off.
  if (!config.pushBroadcastsEnabled) {
    bar.replaceChildren();
    return;
  }

  const status = push.pushStatus();
  if (status.ok) {
    bar.replaceChildren();
    return;
  }

  const blocker = push.adblockLike();
  const isBlocker = blocker.stylesBlocked || blocker.notificationsStubbed;

  bar.innerHTML = `
    <div
      class="mx-auto flex max-w-7xl flex-col gap-2 px-4 py-2.5 text-xs sm:flex-row sm:items-center sm:gap-3"
      role="status"
    >
      <i class="fa-solid ${isBlocker ? 'fa-triangle-exclamation' : 'fa-bell'}"
         aria-hidden="true"></i>
      <span class="min-w-0 flex-1 leading-relaxed">${escapeHtml(status.detail)}</span>
      <button
        type="button"
        id="alert-optin-button"
        class="btn btn-accent shrink-0 self-start sm:self-auto"
      >
        ${isBlocker ? 'How to fix' : 'Turn on alerts'}
      </button>
    </div>
  `;

  byId('alert-optin-button')?.addEventListener('click', () => {
    if (isBlocker) {
      showInstructions('Blocked by your ad blocker');
      return;
    }

    ensureAlertPermission();
  });
}

/**
 * Wire the opt-in bar, warn about blockers, and start polling once this device
 * is allowed to receive alerts.
 */
export async function initAlerts() {
  if (!config.pushBroadcastsEnabled) return;

  await push.initPush();

  // A blocker is worth saying out loud: it is the most common reason a reader
  // thinks the site is broken.
  const blocker = push.adblockLike();
  if (blocker.stylesBlocked) {
    showToast(
      'Some of this pageâ€™s styling was blocked by an ad blocker. Allow this ' +
        'site, or open The Wire in an Incognito window, to see the full design.',
      { type: 'error', duration: 9000 }
    );
  }

  renderOptInBar();
  if (push.getPermission() === 'granted') {
    push.startBroadcastPolling();
  }

  // Keep the bar honest when the reader changes the permission in browser
  // settings while the tab is open.
  if ('permissions' in navigator) {
    navigator.permissions
      .query({ name: 'notifications' })
      .then((status) => {
        status.onchange = renderOptInBar;
      })
      .catch(() => {
        /* not every browser exposes this query */
      });
  }
}

/* -------------------------------------------------------------------------- */
/* Owner broadcast delivery                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Send a broadcast from the Control Center and raise a real notification for it
 * on this device immediately.
 *
 * The record is written first so that every *other* opted-in device picks it up
 * on its next poll, and so the send survives in the delivery history. The local
 * notification is raised straight away rather than waiting a minute for the
 * poller, and the broadcast id is marked as already-seen so this device does
 * not raise a duplicate when the poller reaches the same row.
 *
 * @param {{title: string, message: string, audience: string}} payload
 * @returns {Promise<{sent: number, popped: boolean, broadcast: object}>}
 */
export async function sendBroadcastToDevices({ title, message, audience }) {
  if (!config.pushBroadcastsEnabled) {
    throw new Error('The owner has paused broadcasts, so this send was not delivered.');
  }

  const broadcast = await store.createBroadcast({
    title,
    message,
    audience
  });

  // Mark seen first: if delivery fails we do not want the poller retrying it
  // either, because the owner already has the error toast.
  push.markBroadcastSeen(broadcast.id);

  const popped = await push.deliverLocally({
    title: title || 'The Wire',
    body: message || '',
    tag: `broadcast-${broadcast.id}`,
    url: config.notificationTargetUrl || '/',
    requireInteraction: audience === 'Emergency'
  });

  return {
    sent: broadcast.delivered ?? 0,
    popped,
    broadcast
  };
}
