/* =============================================================================
   src/views/alerts.js — READER NOTIFICATION GATE
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

/**
 * Remembers that this reader has already answered the alert prompt, so we never
 * nag. A browser only ever shows its own prompt once, but *our* instructions
 * modal was re-shown on every single article opened, which read as a bug.
 */
const ANSWERED_KEY = 'wire.alerts.answered';

function hasAnswered() {
  try {
    return localStorage.getItem(ANSWERED_KEY) === '1';
  } catch {
    return false;
  }
}

function markAnswered() {
  try {
    localStorage.setItem(ANSWERED_KEY, '1');
  } catch {
    /* private mode — we simply ask again next time */
  }
}

/**
 * Has the Owner switched the prompt off?
 *
 * The Owner toggle in Security & settings writes `notifications.forced` to the
 * database. It used to be displayed but never read by any reader-facing code,
 * so switching it either way changed nothing. Forced mode now genuinely means
 * "stop asking" — which is what an Owner who has turned it off expects.
 */
function ownerSuppressesPrompt() {
  return Boolean(store.getState().notifications?.forced);
}

/**
 * Should we open the instruction modal for this reader at all?
 * Never while the Owner has suppressed it, and never twice.
 */
export function shouldPromptForAlerts() {
  if (!config.pushBroadcastsEnabled) return false;
  if (ownerSuppressesPrompt()) return false;
  if (hasAnswered()) return false;
  return push.getPermission() !== 'granted';
}

/** The steps a reader must follow, tailored to what actually went wrong. */
function instructions(permission) {
  const steps = [];

  // iOS needs the app installed before alerts are possible at all. This must be
  // checked first: the generic advice below sends iOS readers into Safari
  // settings, where there is nothing useful for them to change.
  if (push.isIOS() && !push.isStandalone()) {
    steps.push(
      'On iPhone and iPad, The Wire must be installed before it can send alerts.',
      'Tap the Share button (the square with an arrow), then Add to Home Screen.',
      'Open The Wire from the new Home Screen icon. Alerts work only from there.'
    );
  } else if (permission === 'unsupported') {
    steps.push(
      'This browser cannot show system notifications, or the page is not on a ' +
        'secure (https) connection.',
      'Open The Wire over https, or use Chrome, Edge, Firefox or Safari on a phone.'
    );
  } else if (permission === 'denied') {
    steps.push(
      'Your browser is blocking notifications for this site.',
      'Tap the padlock or the “i” icon beside the address bar, then choose ' +
        '“Allow notifications” for The Wire.',
      'Reload the page afterwards.'
    );
  } else {
    steps.push(
      'Tap “Turn on alerts”. Your phone will ask you to confirm.',
      'Choose “Allow” so The Wire can reach you when a dispatch breaks.'
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
        them on — this is the last step before your first notification.
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

  // Respect the Owner's decision and the reader's previous answer. Without this
  // the modal reappeared on every article, which is what you reported.
  if (ownerSuppressesPrompt()) {
    showToast('Alerts are off for this device. The owner has paused prompts.', {
      type: 'info'
    });
    return false;
  }
  if (hasAnswered()) return false;

  const dialog = byId(GATE_ID);
  if (!dialog) {
    // No dialog in the DOM — ask directly rather than trapping the reader.
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
        markAnswered();
        done(true);
        return;
      }

      // Still blocked: say so plainly rather than looping the reader.
      if (body) body.innerHTML = gateMarkup(result);
      showToast('Alerts are still blocked. Follow the steps above, then try again.', {
        type: 'error',
        duration: 6000
      });
      // They answered and it did not work, so do not ask again unprompted.
      markAnswered();
      done(false);
    };

    const onDismiss = () => {
      showToast('You can turn alerts on any time from the header.', { type: 'info' });
      // Declining is a valid answer — respect it instead of re-asking.
      markAnswered();
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

  // The container ships with `hidden` in index.html. Every path below has to put
  // that back explicitly when there is nothing to show, otherwise the bar keeps
  // painting into an invisible box and the reader is never offered the button
  // that triggers Notification.requestPermission().
  const clear = () => {
    bar.replaceChildren();
    bar.hidden = true;
  };

  // No bar at all when the owner has switched alerts off.
  if (!config.pushBroadcastsEnabled) {
    clear();
    return;
  }

  const status = push.pushStatus();
  if (status.ok) {
    clear();
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

  // Un-hide only now that there is a real bar to show.
  bar.hidden = false;
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
      'Some of this page’s styling was blocked by an ad blocker. Allow this ' +
        'site, or open The Wire in an Incognito window, to see the full design.',
      { type: 'error', duration: 9000 }
    );
  }

  renderOptInBar();
  if (push.getPermission() === 'granted') {
    push.startBroadcastPolling();

    // Re-attach this device to the signed-in staff account so "Specific User"
    // broadcasts can actually find it. Fire-and-forget: linking is a repair, not
    // a precondition for rendering the page.
    push.linkSubscriptionToSession().catch(() => {});
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
 * Send a broadcast from the Newsroom Panel: save the row AND push it to every
 * subscribed device.
 *
 * Two things happen, and both are needed:
 *
 *   1. The row goes into `broadcasts`. That is the durable record for the
 *      delivery history, and it is how a device that is not push-capable (or a
 *      reader with the tab open) still hears about it on the next poll.
 *
 *   2. `/api/broadcast` is called so the serverless sender can run `web-push`
 *      against every stored subscription. This is the part that actually reaches
 *      a reader whose tab is closed. The VAPID private key stays on the server;
 *      this browser only presents its own Owner session token.
 *
 * A failed push is reported, never swallowed: the row is still saved, and the
 * caller toasts the real delivery count rather than implying everyone was
 * reached.
 *
 * @param {{title: string, message: string, audience: string}} payload
 * @returns {Promise<{sent: number, pushed: number, pushedOk: boolean,
 *                    pushReason: string|null, popped: boolean, broadcast: object}>}
 */
export async function sendBroadcastToDevices({
  title,
  message,
  audience,
  targetStaffId = null
}) {
  if (!config.pushBroadcastsEnabled) {
    throw new Error('The owner has paused broadcasts, so this send was not delivered.');
  }

  console.log('[push] sendBroadcastToDevices called', { title, audience, hasMessage: Boolean(message) });

  const broadcast = await store.createBroadcast({
    title,
    message,
    audience
  });

  // Mark seen before any delivery attempt: if the push fails, this device must
  // not have the poller raise the same text a second time a minute later. The
  // local popup below is the confirmation on this device instead.
  push.markBroadcastSeen(broadcast.id);

  // Real Web Push, via the serverless sender. This is NOT a count of rows in the
  // subscriber table - it is what the push service accepted.
  const result = await push.dispatchWebPush({
    title: title || 'The Wire',
    body: message || '',
    audience,
    // null for a broadcast to everyone; a staff_accounts uuid for a targeted
    // send, which the sender turns into `where staff_id = ...`.
    targetStaffId,
    url: config.notificationTargetUrl || '/'
  });

  console.log('[push] web push dispatch result', {
    ok: result.ok,
    delivered: result.delivered,
    reason: result.reason
  });

  // The local popup is a courtesy proof on the Owner's own machine. It is
  // deliberately not counted as delivery to anybody else.
  const popped = await push.deliverLocally({
    title: title || 'The Wire',
    body: message || '',
    tag: `broadcast-${broadcast.id}`,
    url: config.notificationTargetUrl || '/',
    requireInteraction: audience === 'Emergency'
  });

  return {
    // Row count of the subscriber table. Useful context, NOT a delivery count.
    sent: broadcast.delivered ?? 0,
    pushed: result.delivered,
    pushedOk: result.ok,
    pushReason: result.reason || null,
    pushDetail: result.detail || null,
    popped,
    broadcast
  };
}
