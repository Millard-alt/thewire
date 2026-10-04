/* =============================================================================
   src/lib/push.js — REAL PUSH NOTIFICATIONS
   -----------------------------------------------------------------------------
   Everything needed to raise a genuine OS-level notification:

       initPush()                register the service worker
       getPermission()           'unsupported' | 'default' | 'granted' | 'denied'
       requestPermission()       ask the reader (must come from a user gesture)
       subscribeToPush()         real Web Push subscription (needs a VAPID key)
       deliverLocally()          show a real notification on THIS device, now
       dispatchWebPush()         ask the serverless sender to push to subscribers
       startBroadcastPolling()   poll for the owner's broadcasts and raise them

   Two delivery paths, because they need different infrastructure:

   1. Web Push reaches a reader whose tab is closed, but it needs a VAPID key
      pair AND a trusted sender holding the private key. That sender is the
      serverless function in api/send-push.js, so the private key never ships to
      the browser and the Owner's panel only calls the endpoint -- see
      dispatchWebPush().

   2. In-app delivery needs no backend at all: the owner posts a broadcast, it
      lands in the `broadcasts` table, and every open client polls for it and
      raises a real OS notification. This genuinely works today.

   Nothing here fakes success. If the browser or an extension blocks the
   notification we report that and fall back to the in-page banner.
   ========================================================================== */

import { config } from './config.js';
import { getSupabase, getSessionToken } from './supabase.js';
// dom.js imports nothing, so this cannot become a cycle. Used to surface push
// failures on screen: the browser collapses every cause of an AbortError into
// one console line, and the reader has no console to look at.
import { showToast } from './dom.js';

const SW_URL = '/sw.js';
const SUBSCRIPTION_KEY = 'wire.pushSubscription';
const SEEN_KEY = 'wire.seenBroadcasts';
/** Poll cadence. One minute is a sensible balance for a news site. */
const POLL_MS = 60_000;

let pollTimer = null;
let onBroadcast = null;

/* -------------------------------------------------------------------------- */
/* Capability + blocker detection                                              */
/* -------------------------------------------------------------------------- */

/**
 * Detect an ad blocker / privacy extension.
 *
 * Most blockers work by aborting network requests, so the app's own CSS or the
 * Supabase SDK never arrives. That is detectable: when Tailwind did not load,
 * its `hidden` utility does nothing and a probe element stays visible.
 */
export function adblockLike() {
  let stylesBlocked = false;
  try {
    const probe = document.createElement('div');
    probe.className = 'hidden';
    probe.setAttribute('aria-hidden', 'true');
    document.body.appendChild(probe);
    stylesBlocked = getComputedStyle(probe).display !== 'none';
    probe.remove();
  } catch {
    stylesBlocked = false;
  }

  // Some extensions neuter the Notification constructor rather than the network.
  let notificationsStubbed = false;
  if ('Notification' in window) {
    try {
      notificationsStubbed = String(window.Notification) === 'undefined';
    } catch {
      notificationsStubbed = true;
    }
  }

  return { stylesBlocked, notificationsStubbed };
}

/**
 * True on an iPhone/iPad, including iPadOS which reports itself as a Mac.
 */
export function isIOS() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  // iPadOS 13+ masquerades as desktop Safari; the touch-point count gives it away.
  const iPadOS = /Macintosh/i.test(ua) && typeof document !== 'undefined' && navigator.maxTouchPoints > 1;
  return /iPhone|iPad|iPod/i.test(ua) || iPadOS;
}

/**
 * True when the page is running as an installed app (added to the Home Screen).
 *
 * This is the single most important fact for iOS: Web Push exists there ONLY in
 * standalone mode. In an ordinary Safari tab `Notification` is present and
 * `requestPermission()` may even succeed, so capability checks pass — but
 * nothing can ever be delivered, because there is no push service for a
 * non-installed web page. Reporting "blocked" there is simply wrong.
 */
export function isStandalone() {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia?.('(display-mode: standalone)').matches === true ||
    window.navigator.standalone === true
  );
}

/** True when this browser can raise a real OS notification. */
export function isSupported() {
  if (typeof window === 'undefined') return false;
  if (!('Notification' in window) || !('serviceWorker' in navigator)) return false;
  // On iOS, a Safari tab can never deliver, so do not pretend otherwise.
  if (isIOS() && !isStandalone()) return false;
  return true;
}

/** @returns {'unsupported'|'default'|'granted'|'denied'} */
export function getPermission() {
  if (!isSupported()) return 'unsupported';
  try {
    return Notification.permission;
  } catch {
    return 'unsupported';
  }
}

/**
 * Ask the reader for notification permission.
 *
 * MUST be called from inside a real click handler — browsers ignore the prompt
 * otherwise, which is why the "Turn on alerts" button exists rather than
 * nagging on page load.
 */
export async function requestPermission() {
  if (!isSupported()) return 'unsupported';
  try {
    const result = await Notification.requestPermission();
    if (result === 'granted') {
      // Run the pre-flight BEFORE subscribing. Every check in it is cheaper
      // than a real subscribe() call, and one of them either names the actual
      // blocker or rules out whole categories of cause. It never throws, so a
      // failed probe cannot stop a subscription that would otherwise work.
      const report = await debugPushEnvironment().catch((error) => {
        console.warn('[push] diagnostic pass failed', error);
        return null;
      });

      // Always register the device, even when Web Push is unconfigured, so the
      // Owner's subscriber list reflects real opted-in devices.
      const subscription = await subscribeToPush();
      await registerDevice().catch(() => {});

      // Only complain when there is genuinely nothing to deliver through. A
      // failed probe alone is not a failure: the browser may use a different
      // push service than the one probed, or block our probe while permitting
      // its own request.
      if (!subscription && report && !report.ok) {
        console.warn('[push] subscription unavailable:', report.summary);
        showToast(
          `Alerts are on, but not working yet. ${report.summary}`,
          { type: 'error', duration: 9000 }
        );
      }

      return result;
    }
    return result;
  } catch (error) {
    console.warn('[push] permission request failed', error);
    return 'denied';
  }
}

/**
 * Register the service worker.
 *
 * Only available in a secure context: `https://`, or `localhost` during
 * development. On a phone hitting a LAN IP over plain http this is `null`,
 * which is a real limitation of the platform, not a bug here.
 */
export async function initPush() {
  if (!('serviceWorker' in navigator)) return null;
  try {
    return await navigator.serviceWorker.register(SW_URL, { scope: '/' });
  } catch (error) {
    console.warn('[push] service worker registration failed', error);
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Local delivery — a real OS notification on this device                       */
/* -------------------------------------------------------------------------- */

/**
 * Raise a genuine notification right now on this device.
 *
 * Prefers the service worker registration because that is the only path that
 * survives the tab being backgrounded on mobile, and because the worker gives us
 * the `actions` / `data` handling defined in public/sw.js.
 *
 * @param {{title?: string, body?: string, tag?: string, url?: string,
 *          requireInteraction?: boolean}} message
 * @returns {Promise<boolean>} true when the OS actually accepted the notification
 */
export async function deliverLocally({
  title = 'The Wire',
  body = '',
  tag = 'the-wire-broadcast',
  url = '/',
  requireInteraction = true
} = {}) {
  if (getPermission() !== 'granted') return false;

  const options = {
    body,
    // The tag collapses repeat broadcasts instead of stacking them.
    tag,
    renotify: true,
    icon: '/icons/icon-192.png',
    // No `badge` - see the matching note in public/sw.js. There is no monochrome
    // status-bar glyph in public/icons/, and pointing at a full-colour mark
    // 404s on every notification. The OS default is used instead.
    // An alert must not be silent or the reader misses an emergency dispatch.
    requireInteraction: Boolean(requireInteraction),
    vibrate: [200, 100, 200, 100, 200],
    data: { url },
    actions: [{ action: 'open', title: 'Read now' }]
  };

  try {
    const registration = await initPush();
    if (registration?.showNotification) {
      await registration.showNotification(title, options);
      return true;
    }
    // Safari/iOS before 16.4 has no showNotification on the registration.
    new Notification(title, options);
    return true;
  } catch (error) {
    console.warn('[push] local delivery failed', error);
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Web Push subscription (requires a VAPID key + a sender)                     */
/* -------------------------------------------------------------------------- */

/** How many bytes a decoded VAPID public key must contain. */
// An uncompressed P-256 point: 0x04 || X(32) || Y(32). Anything else is not a
// VAPID key, and `pushManager.subscribe()` rejects it with a bare AbortError
// that gives no hint as to why.
const VAPID_PUBLIC_KEY_BYTES = 65;

/** base64url, possibly with padding, possibly wrapped in quotes or newlines. */
const BASE64URL_RE = /^[A-Za-z0-9\-_+/=]+$/;

/**
 * Normalise a VAPID public key pasted from anywhere into clean base64url.
 *
 * The value reaches us from a `.env` file, a Vercel dashboard textarea or a
 * `window.__WIRE_ENV__` override, so in practice it arrives with stray
 * whitespace, a trailing newline, or the quotes someone kept when copying.
 * Those characters are not valid base64 and `atob()` rejects them — but not
 * before the browser has already surfaced a generic "push service error" that
 * says nothing about the real cause. Stripping them here turns a silent
 * misconfiguration into a working subscription.
 */
function normaliseVapidKey(raw) {
  return String(raw == null ? '' : raw)
    .trim()
    // Strip one layer of matching quotes: "key" or 'key'.
    .replace(/^["'](.*)["']$/, '$1')
    // Remove ALL whitespace, including interior line breaks from a wrapped value.
    .replace(/\s+/g, '');
}

/**
 * Decode a base64url VAPID public key into the Uint8Array the Push API expects.
 *
 * Throws a specific, readable error rather than letting a malformed key reach
 * `subscribe()`, where the browser reports every possible cause as the same
 * opaque `AbortError: Registration failed - push service error`.
 *
 * @param {string} raw the configured key, in any of the shapes above
 * @returns {Uint8Array} exactly `VAPID_PUBLIC_KEY_BYTES` long
 */
function urlBase64ToUint8Array(raw) {
  const key = normaliseVapidKey(raw);

  if (!key) throw new Error('VAPID public key is empty.');
  if (!BASE64URL_RE.test(key)) {
    throw new Error(
      'VAPID public key contains characters that are not base64url ' +
        `(offending: ${key.replace(BASE64URL_RE, '').slice(0, 8) || 'whitespace'}).`
    );
  }

  // Re-pad to a multiple of 4. `(4 - len % 4) % 4` is 0 when already aligned,
  // which is what stops an already-padded key gaining four more "=" characters.
  const padding = '='.repeat((4 - (key.length % 4)) % 4);
  const base64 = (key + padding).replace(/-/g, '+').replace(/_/g, '/');

  let raw_;
  try {
    raw_ = atob(base64);
  } catch (error) {
    throw new Error(`VAPID public key is not valid base64: ${error.message}`);
  }

  const bytes = Uint8Array.from([...raw_].map((char) => char.charCodeAt(0)));

  // Length is the single most useful check available, and the one the browser
  // will not give us. A 32-byte value is the *private* key pasted into the
  // public variable; 33 bytes usually means a compressed point; anything else
  // is truncated. All three produce an identical AbortError from subscribe().
  if (bytes.length !== VAPID_PUBLIC_KEY_BYTES) {
    throw new Error(
      `VAPID public key decodes to ${bytes.length} bytes, ` +
        `but must be exactly ${VAPID_PUBLIC_KEY_BYTES}. ` +
        (bytes.length === 32
          ? 'A 32-byte key is the PRIVATE half — check you copied the public key.'
          : 'The value is likely truncated, or is not a VAPID key at all.')
    );
  }

  return bytes;
}

/**
 * Everything needed to tell "the env var never arrived" apart from "the browser
 * refused to talk to the push service", logged in one object.
 *
 * Reports `Boolean(key)` and `key.length` but never the key itself: the public
 * key is not secret, but logging it would put it in shared screenshots and CI
 * output for no diagnostic gain — its length and byte length are what matter.
 */
function vapidDiagnostics(raw) {
  const configured = Boolean(raw);
  const normalised = normaliseVapidKey(raw);

  let decoded = null;
  let valid = false;
  let problem = configured ? 'not checked' : 'missing';

  if (configured) {
    try {
      decoded = urlBase64ToUint8Array(raw).length;
      valid = true;
      problem = null;
    } catch (error) {
      problem = error.message;
    }
  }

  return {
    configured,
    /** Characters in the value as configured, before normalisation. */
    keyLength: configured ? String(raw).length : 0,
    /** Characters after trimming quotes/whitespace — the real key length. */
    normalisedLength: normalised.length,
    /** Decoded byte length. A valid VAPID public key is exactly 65. */
    decodedBytes: decoded,
    valid,
    problem,
    /** Which resolution path supplied the value (see config.js). */
    source: import.meta.env?.VITE_VAPID_PUBLIC_KEY
      ? 'import.meta.env (baked at build time)'
      : 'window.__WIRE_ENV__ (runtime override)',
    secureContext:
      typeof window !== 'undefined' ? Boolean(window.isSecureContext) : 'unknown'
  };
}

/* -------------------------------------------------------------------------- */
/* Pre-flight environment diagnostic                                            */
/* -------------------------------------------------------------------------- */

/**
 * Push service endpoints, per browser engine.
 *
 * The subscription request is sent to ONE of these by the browser itself - the
 * page never chooses. So when `subscribe()` fails, the first question is always
 * "could the browser reach its push service?", and that is answerable without
 * subscribing at all.
 */
function pushServiceFor(ua = navigator.userAgent) {
  if (/Firefox/i.test(ua)) {
    return {
      name: 'Mozilla autopush',
      url: 'https://updates.push.services.mozilla.com/wpush/v2/'
    };
  }
  if (/Edg\//i.test(ua)) {
    return { name: 'Windows WNS', url: 'https://login.live.com/accesstoken.srf' };
  }
  if (/Chrome|Chromium|CriOS|Opera|OPR|Samsung/i.test(ua)) {
    return { name: 'Google FCM', url: 'https://fcm.googleapis.com/fcm/send' };
  }
  return { name: 'unknown engine', url: 'https://fcm.googleapis.com/fcm/send' };
}

/**
 * Is the browser's push service reachable from this machine?
 *
 * `mode: 'no-cors'` is deliberate. An opaque response still proves the request
 * left the browser, completed DNS and TLS, and reached a server - the status is
 * hidden from us but the round trip is not. A blocked request (ad blocker,
 * extension filter, corporate proxy, DNS sinkhole) never resolves at all and
 * rejects, which is exactly the signal we want.
 *
 * This is the check that separates "your environment is blocking push" from
 * "your VAPID key is wrong" - otherwise indistinguishable, because both
 * surface as the same AbortError.
 *
 * @returns {Promise<{service: string, reachable: boolean|null, detail: string}>}
 */
async function probePushService() {
  const target = pushServiceFor();
  console.log('[push-debug] Testing reachability of', target.name, target.url);

  try {
    const response = await fetch(target.url, {
      method: 'HEAD',
      mode: 'no-cors',
      // No caching: a cached response would mask a network that is now blocked.
      cache: 'no-store',
      // Short timeout. A hanging request is itself a symptom, and waiting the
      // full browser default would leave the reader staring at a blank screen.
      signal: AbortSignal.timeout(6000)
    });
    // 'opaque' under no-cors is success: the server answered, we just may not
    // read the status.
    console.log(
      `[push-debug] ${target.name} REACHABLE (type: ${response.type}) - not a network block.`
    );
    return {
      service: target.name,
      reachable: true,
      detail: `response type ${response.type}`
    };
  } catch (error) {
    // AbortError here is OUR timeout, not the browser's push AbortError.
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    console.error(
      `[push-debug] ${target.name} UNREACHABLE - the request never completed.`,
      {
        name: error?.name,
        message: error?.message,
        likely: timedOut
          ? 'Connection blackholed or very slow (proxy/firewall dropping packets).'
          : 'Blocked by an ad blocker, privacy extension, or DNS filter.',
        toTest: 'Retry in a clean Incognito window with all extensions disabled.'
      }
    );
    return {
      service: target.name,
      reachable: false,
      detail: timedOut ? 'timed out after 6s' : error?.message || 'request failed'
    };
  }
}

/**
 * Run every check that can be done BEFORE attempting a real subscription.
 *
 * Order matters: the cheapest and most decisive checks run first, so a reader
 * whose network is blocked is told that in a second rather than after a real
 * `subscribe()` call has already failed.
 *
 * @param {string} [vapidPublicKey]
 * @returns {Promise<{ok: boolean, summary: string, secure: boolean,
 *                    network: object, key: object, sw: object}>}
 */
export async function debugPushEnvironment(vapidPublicKey = config.vapidPublicKey) {
  console.log('[push-debug] ===== push environment diagnostic =====');

  // --- Secure context -------------------------------------------------------
  // Push requires https or localhost. Free to check, impossible to recover
  // from, so it is verified before anything touches the network.
  const secure = typeof window !== 'undefined' && Boolean(window.isSecureContext);
  console.log('[push-debug] Secure context:', secure, '| origin:', location.origin);
  if (!secure) {
    console.error(
      '[push-debug] Not a secure context. Web Push is unavailable outside https ' +
        'and localhost; a LAN IP over plain http cannot subscribe.'
    );
  }

  // --- VAPID key ------------------------------------------------------------
  const key = vapidDiagnostics(vapidPublicKey);
  try {
    // Decoding for real, not just counting characters: this proves the key
    // survives atob() and is 65 bytes long, which is the actual precondition.
    const bytes = urlBase64ToUint8Array(vapidPublicKey);
    console.log('[push-debug] VAPID key decodes to', bytes.length, 'bytes - usable.');
  } catch (error) {
    console.error('[push-debug] VAPID key will not decode:', error.message);
  }
  console.log('[push-debug] VAPID key:', key);

  // --- Service worker -------------------------------------------------------
  const sw = {
    supported: 'serviceWorker' in navigator,
    ready: false,
    scope: null,
    active: false
  };
  if (sw.supported) {
    try {
      // `ready` never rejects, so it must be raced against a timeout: a worker
      // that fails to activate would otherwise hang this call forever.
      const registration = await Promise.race([
        navigator.serviceWorker.ready,
        new Promise((resolve) => setTimeout(() => resolve(null), 5000))
      ]);
      if (registration) {
        sw.ready = true;
        sw.scope = registration.scope;
        sw.active = Boolean(registration.active);
        console.log('[push-debug] Service worker active. Scope:', registration.scope);
      } else {
        console.error('[push-debug] No active service worker after 5s.');
      }
    } catch (error) {
      console.error('[push-debug] Service worker lookup threw:', error.message);
    }
  } else {
    console.error('[push-debug] This browser has no serviceWorker support at all.');
  }

  // --- Push service reachability -------------------------------------------
  const network = await probePushService();

  // --- Verdict --------------------------------------------------------------
  // Ordered by what most often breaks first, so `summary` names the thing the
  // reader can actually act on.
  let summary;
  if (!secure) {
    summary = 'Alerts need a secure (https) connection. Open the site over https.';
  } else if (!key.configured) {
    summary = 'This build has no VAPID key, so alerts cannot be sent.';
  } else if (!key.valid) {
    summary = 'The VAPID key is unusable: ' + (key.problem || 'unknown problem');
  } else if (network.reachable === false) {
    summary =
      `Your network is blocking the ${network.service} push service. ` +
      'This is an ad blocker, privacy extension or network filter - not a site fault.';
  } else if (!sw.active) {
    summary = 'Alerts are blocked because the service worker is not active.';
  } else {
    summary = `Environment looks healthy (${network.service} reachable).`;
  }

  const report = {
    ok: Boolean(secure && key.valid && network.reachable !== false && sw.active),
    secure,
    network,
    key,
    sw,
    summary
  };

  console.log('[push-debug] VERDICT:', summary);
  console.log('[push-debug] report:', report);
  console.log('[push-debug] =========================================');

  return report;
}

/**
 * Create or refresh this device's Web Push subscription and store it locally.
 * Returns null when push is not configured or the browser refuses, both of
 * which are legitimate outcomes rather than crashes.
 */
export async function subscribeToPush() {
  const vapidKey = config.vapidPublicKey;

  // Logged unconditionally, not only on failure: a successful subscription is
  // the only proof the build actually baked the key in, and the Owner Panel
  // cannot see the browser console.
  const diag = vapidDiagnostics(vapidKey);
  console.log('[push] VAPID diagnostics', diag);

  if (!diag.configured) {
    console.warn(
      '[push] VITE_VAPID_PUBLIC_KEY is not set in this build — the browser ' +
        'cannot subscribe, so no push keys ever reach Supabase and every ' +
        'broadcast reports no_subscribers. Set it in .env locally, and in the ' +
        'Vercel project settings in production, then REBUILD: Vite inlines ' +
        'VITE_ variables at build time, so changing the variable without ' +
        'redeploying changes nothing. Generate a pair with: ' +
        'npx web-push generate-vapid-keys'
    );
    return null;
  }

  if (!diag.valid) {
    console.error(
      '[push] VITE_VAPID_PUBLIC_KEY is present but unusable: ' + diag.problem +
        ' — subscription will fail. Confirm the PUBLIC key is in the public ' +
        'variable and the private key in VAPID_PRIVATE_KEY.'
    );
    return null;
  }

  if (getPermission() !== 'granted') {
    console.log('[push] subscribe skipped: permission is not "granted".');
    return null;
  }
  if (!('PushManager' in window)) {
    console.warn('[push] subscribe skipped: this browser has no PushManager.');
    return null;
  }

  const registration = await initPush();
  if (!registration?.pushManager) {
    console.warn('[push] subscribe skipped: no service worker registration.');
    return null;
  }

  try {
    const existing = await registration.pushManager.getSubscription();
    if (existing) console.log('[push] reusing this device\'s existing subscription.');

    const subscription =
      existing ||
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey)
      }));

    // Confirm we can read keys off the subscription. One without both keys is
    // structurally undeliverable, and discovering that here gives a clear
    // message instead of a silent "skipped: no keys" from the sender later.
    const keys = subscriptionKeys(subscription);
    console.log('[push] subscription ready', {
      endpointHost: (() => {
        try {
          return new URL(subscription.endpoint).host;
        } catch {
          return 'not a URL';
        }
      })(),
      hasP256dh: Boolean(keys.p256dh),
      hasAuth: Boolean(keys.auth)
    });

    if (!keys.p256dh || !keys.auth) {
      console.warn(
        '[push] the subscription is missing one or both applicationServerKey ' +
          'values, so the sender will skip it as "no keys". This usually means ' +
          'the browser reused a stale subscription from an earlier build. Clear ' +
          'site data for this origin, then allow notifications again.'
      );
    }

    try {
      localStorage.setItem(SUBSCRIPTION_KEY, JSON.stringify(subscription));
    } catch {
      /* private browsing */
    }

    const synced = await syncSubscription(subscription);
    if (synced?.error) {
      console.warn('[push] subscribed, but syncing to Supabase failed', synced);
    }
    return subscription;
  } catch (error) {
    // `AbortError: Registration failed - push service error` is the most common
    // Web Push failure and the least informative: the browser collapses a
    // blocked network request, a rejected key and a revoked permission into one
    // message. Log enough to tell them apart.
    const name = error?.name || 'Error';
    const isAbort = name === 'AbortError';

    console.error(`[push] subscription failed (${name})`, {
      message: error?.message,
      vapid: diag,
      // An insecure context blocks the push service outright, and is invisible
      // from the page's own code otherwise.
      secureContext:
        typeof window !== 'undefined' ? Boolean(window.isSecureContext) : 'unknown',
      serviceWorker: {
        scope: registration?.scope,
        active: Boolean(registration?.active)
      }
    });

    if (isAbort) {
      console.error(
        '[push] AbortError means the browser could not complete the push ' +
          'subscription. In order of likelihood:\n' +
          '  1. The push service was blocked. Ad/privacy blockers, corporate ' +
          'proxies and DNS filtering commonly block fcm.googleapis.com, ' +
          'updates.push.services.mozilla.com or notify.windows.com. Retest in a ' +
          'clean Incognito window with extensions disabled.\n' +
          '  2. Not a secure context. Push requires https or localhost; a LAN IP ' +
          'over plain http fails exactly this way.\n' +
          '  3. The key is still wrong despite passing validation above — the ' +
          'decoded bytes should begin with 0x04 (an uncompressed P-256 point).\n' +
          '  4. Permission was revoked between the check and the call.'
      );
    }

    // A rejected registration can leave a half-built subscription that then
    // blocks every retry. Clear it so the next attempt starts clean.
    try {
      const stale = await registration.pushManager.getSubscription();
      if (stale) await stale.unsubscribe();
    } catch {
      /* best effort only */
    }

    return null;
  }
}

/** The stored subscription, if this device has one. */
export function getStoredSubscription() {
  try {
    const raw = localStorage.getItem(SUBSCRIPTION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * A stable, privacy-safe identifier for THIS device.
 *
 * Web Push normally hands us a push endpoint, but that only exists once a VAPID
 * key is configured. Without one there was no identifier at all, so nothing was
 * ever written to `push_subscriptions` and the Owner panel's subscriber count
 * stayed at zero. This is that identifier: random, local, and regenerable.
 */
function deviceId() {
  const KEY = 'wire.deviceId';
  try {
    let id = localStorage.getItem(KEY);
    if (!id) {
      id = `dev-${crypto.randomUUID()}`;
      localStorage.setItem(KEY, id);
    }
    return id;
  } catch {
    return 'dev-anonymous';
  }
}

/** A label the Owner can read in the subscriber list, e.g. "Windows - Chrome". */
function deviceLabel() {
  const ua = navigator.userAgent;
  const os = /Android/i.test(ua)
    ? 'Android'
    : /iPhone|iPad|iOS/i.test(ua)
      ? 'iOS'
      : /Windows/i.test(ua)
        ? 'Windows'
        : /Mac OS/i.test(ua)
          ? 'macOS'
          : /Linux/i.test(ua)
            ? 'Linux'
            : 'Unknown OS';
  const browser = /Edg\//i.test(ua)
    ? 'Edge'
    : /OPR\//i.test(ua)
      ? 'Opera'
      : /Firefox/i.test(ua)
        ? 'Firefox'
        : /Chrome/i.test(ua)
          ? 'Chrome'
          : /Safari/i.test(ua)
            ? 'Safari'
            : 'Browser';
  return `${os} - ${browser}`;
}

/**
 * Pull the two application-server keys off a PushSubscription.
 *
 * `subscription.toJSON().keys` is the supported shape, but a subscription that
 * came back out of localStorage is a plain object, and older Safari builds omit
 * `toJSON` entirely. Reading both means a subscription registered months ago
 * still yields its keys the first time the reader re-opens the site.
 *
 * Returns `{ p256dh: null, auth: null }` rather than throwing when the shape is
 * unfamiliar, because the caller can still register the device for in-app
 * delivery; it simply cannot receive a real push.
 *
 * @param {object|null} subscription
 * @returns {{p256dh: string|null, auth: string|null}}
 */
function subscriptionKeys(subscription) {
  const empty = { p256dh: null, auth: null };
  if (!subscription) return empty;

  let keys = null;
  try {
    keys = typeof subscription.toJSON === 'function' ? subscription.toJSON().keys : null;
  } catch {
    keys = null;
  }
  if (!keys) keys = subscription.keys || null;
  if (!keys) return empty;

  const p256dh = typeof keys.p256dh === 'string' ? keys.p256dh.trim() : '';
  const auth = typeof keys.auth === 'string' ? keys.auth.trim() : '';

  // 65 bytes -> 87 url-safe base64 chars for p256dh; 16 bytes -> 22 for auth.
  // Anything wildly outside that is junk and must not be handed to the server,
  // where it would be fed straight into an ECDH handshake.
  if (p256dh.length < 80 || p256dh.length > 100) return { ...empty, auth: auth || null };
  if (auth.length < 16 || auth.length > 32) return { p256dh, auth: null };

  return { p256dh, auth };
}

/**
 * Push this device's subscription up to `push_subscriptions`, or clear it when
 * the reader has switched notifications off.
 *
 * This runs even without a VAPID key. A real Web Push endpoint is preferred when
 * one exists (that is what an actual push service would address), otherwise the
 * locally-generated device id is registered so the subscriber list and the
 * delivery history reflect genuine opted-in devices instead of a placeholder.
 *
 * @param {object|null} [subscription] pass null to unregister
 * @returns {Promise<{stored?: boolean, removed?: boolean, error?: string, skipped?: boolean}>}
 */
export async function syncSubscription(subscription = getStoredSubscription()) {
  const client = getSupabase();
  if (!client) return { skipped: true };

  try {
    const endpoint = subscription?.endpoint
      ? String(subscription.endpoint).slice(0, 500)
      : deviceId();

    // Both writes go through SECURITY DEFINER functions (migration 004) rather
    // than direct table access. Direct writes cannot work here: an upsert
    // compiles to INSERT ... ON CONFLICT DO UPDATE and needs an UPDATE policy
    // the table does not have, while a delete-then-insert fails differently --
    // a non-matching DELETE under RLS removes 0 rows *without error*, so the
    // re-insert hits 23505 duplicate key. The functions run as the table owner,
    // so RLS does not apply to them at all.
    if (!subscription) {
      const { error } = await client.rpc('wire_unregister_device', {
        p_endpoint: endpoint
      });
      if (error) throw error;
      return { removed: true };
    }

    // Migration 019 added p_p256dh / p_auth. Without them the row is unusable
    // to the sender: web-push cannot do the ECDH handshake with an endpoint
    // alone, so a subscription stored without its keys can never be pushed to.
    // The SQL function defaults both to null, so an older 004-only deployment
    // still accepts this call - it just ignores the two extra arguments.
    const keys = subscriptionKeys(subscription);
    const { error } = await client.rpc('wire_register_device', {
      p_endpoint: endpoint,
      p_device: deviceLabel(),
      p_audience: 'Everyone',
      p_p256dh: keys.p256dh,
      p_auth: keys.auth
    });

    if (error) throw error;
    console.log('[push] subscription synced', {
      endpoint: endpoint.slice(-48),
      keysStored: Boolean(keys.p256dh && keys.auth)
    });
    return { stored: true, keysStored: Boolean(keys.p256dh && keys.auth) };
  } catch (error) {
    // A missing RPC means migration 004 has not been applied yet. Say so
    // plainly, because otherwise this looks like a permissions bug and sends
    // people hunting through policies that are already correct.
    if (/function.*wire_(un)?register_device|schema cache/i.test(error.message)) {
      console.warn(
        '[push] device registration is unavailable - run ' +
          'supabase/004_device_registration.sql in the Supabase SQL Editor.'
      );
    } else {
      console.warn('[push] could not sync subscription', error);
    }
    return { error: error.message };
  }
}

/**
 * Register this device as a subscriber regardless of whether Web Push is
 * configured. Called whenever notification permission is granted, so the Owner's
 * list reflects real devices instead of a hardcoded number.
 */
export async function registerDevice() {
  // A truthy stand-in is required: passing null to syncSubscription means
  // "the reader turned alerts off, delete my row".
  return syncSubscription(getStoredSubscription() || { endpoint: deviceId() });
}

/**
 * The registered subscriber devices. Read through a SECURITY DEFINER function so
 * the owner sees the list without the table being readable by the public.
 * @returns {Promise<Array<{endpoint: string, device: string, last_seen: string}>>}
 */
export async function listDevices() {
  const client = getSupabase();
  if (!client) return [];
  try {
    const { data, error } = await client.rpc('wire_list_devices');
    if (error) throw error;
    return data || [];
  } catch (error) {
    console.warn('[push] could not list devices', error);
    return [];
  }
}

/* -------------------------------------------------------------------------- */
/* Broadcast polling — how an owner's broadcast reaches an open reader         */
/* -------------------------------------------------------------------------- */

function readSeen() {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch {
    return new Set();
  }
}

function markSeen(id) {
  try {
    const seen = readSeen();
    seen.add(String(id));
    // Keep the set small; a reader only needs a short dedupe window.
    const trimmed = [...seen].slice(-50);
    localStorage.setItem(SEEN_KEY, JSON.stringify(trimmed));
  } catch {
    /* private browsing */
  }
}

/**
 * Record a broadcast as already handled on this device.
 *
 * The owner panel calls this when it sends a broadcast: the notification is
 * raised directly, so the poller must not raise the same row again a moment
 * later when it reaches the top of the feed.
 *
 * @param {string|number} id
 */
export function markBroadcastSeen(id) {
  if (id === undefined || id === null) return;
  markSeen(String(id));
}

/**
 * One polling pass. Exported so the owner panel can offer a "send a test
 * notification" button without duplicating the fetch logic.
 *
 * @returns {Promise<Array>} broadcasts raised on this device during this pass
 */
export async function pollOnce() {
  const client = getSupabase();
  if (!client) {
    console.warn('[push] poll skipped: no Supabase client (demo mode or unconfigured).');
    return [];
  }

  // A reader who has blocked notifications gets nothing; do not even poll.
  const permission = getPermission();
  if (permission !== 'granted') {
    console.log('[push] poll skipped: permission is "' + permission + '", not "granted".');
    return [];
  }

  let rows = [];
  try {
    const { data, error } = await client
      .from('broadcasts')
      .select('id,title,message,audience,created_at')
      .order('created_at', { ascending: false })
      .limit(5);
    if (error) throw error;
    rows = data || [];
  } catch (error) {
    console.error('[push] broadcast poll FAILED - the broadcasts table is unreadable.', {
      message: error && error.message,
      hint: /does not exist|schema cache|42P01/i.test(error && error.message || '')
        ? 'Table missing - run supabase/003_subscriptions_and_gallery.sql'
        : 'Check the anon SELECT grant and RLS on public.broadcasts.'
    });
    return [];
  }

  const seen = readSeen();
  const raised = [];

  console.log('[push] poll pass', {
    rows: rows.length,
    alreadySeen: seen.size,
    newest: rows[0] ? { id: rows[0].id, title: rows[0].title, at: rows[0].created_at } : null
  });

  for (const row of rows) {
    const key = String(row.id);
    if (seen.has(key)) continue;
    // First ever poll: record what is already there rather than firing a
    // backlog of old alerts at a reader who has just arrived.
    markSeen(key);
    if (seen.size === 0) continue;

    const delivered = await deliverLocally({
      title: row.title || 'The Wire',
      body: row.message || '',
      tag: `broadcast-${key}`,
      url: config.notificationTargetUrl || '/',
      // An emergency alarm stays on screen; a routine bulletin can be dismissed.
      requireInteraction: row.audience === 'Emergency'
    });

    if (delivered) {
      raised.push(row);
      if (typeof onBroadcast === 'function') onBroadcast(row);
    }
  }

  return raised;
}

/**
 * Begin polling for the owner's broadcasts.
 * @param {(broadcast: object) => void} [handler] called after each alert
 */
export function startBroadcastPolling(handler) {
  if (handler) onBroadcast = handler;
  stopBroadcastPolling();
  if (!config.pushBroadcastsEnabled) return false;

  // Only worth polling once this device can actually display an alert.
  if (getPermission() !== 'granted') return false;

  // Do the first pass immediately, then settle into the cadence.
  pollOnce().catch(() => {});
  pollTimer = setInterval(() => {
    pollOnce().catch(() => {});
  }, POLL_MS);
  return true;
}

/** Stop polling. Safe to call when polling was never started. */
export function stopBroadcastPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/**
 * Human-readable explanation of the current push state, for the UI.
 * @returns {{ok: boolean, label: string, detail: string}}
 */
export function pushStatus() {
  const { stylesBlocked, notificationsStubbed } = adblockLike();

  // iOS in an ordinary Safari tab is not "blocked" and never was: push simply
  // does not exist outside an installed app. Say what to do about it instead of
  // sending the reader to settings that will not help.
  if (isIOS() && !isStandalone()) {
    return {
      ok: false,
      label: 'Add The Wire to your Home Screen',
      detail:
        'On iPhone and iPad, alerts only work once The Wire is installed. Tap the ' +
        'Share button, then “Add to Home Screen”, and open The Wire from there.'
    };
  }

  if (notificationsStubbed) {
    return {
      ok: false,
      label: 'Blocked by an extension',
      detail:
        'A privacy extension has disabled notifications for this site. Allow ' +
        'notifications for The Wire, or open the page in an Incognito window.'
    };
  }

  const permission = getPermission();
  if (permission === 'unsupported') {
    return {
      ok: false,
      label: 'Not supported on this device',
      detail:
        window.isSecureContext === false
          ? 'Notifications need a secure (https) connection. Open the site over ' +
            'https, or use localhost during development.'
          : 'This browser cannot show system notifications.'
    };
  }
  if (permission === 'denied') {
    return {
      ok: false,
      label: 'Notifications are blocked',
      detail:
        'Your browser is refusing notifications for this site. Re-allow them ' +
        'in the padlock / site-settings menu, or open the page in an Incognito window.'
    };
  }
  if (permission === 'default') {
    return {
      ok: false,
      label: 'Not turned on yet',
      detail:
        'Tap “Turn on alerts” to let The Wire raise notifications on this device.'
    };
  }

  return {
    ok: true,
    label: stylesBlocked
      ? 'On, but some page styling is blocked'
      : 'Alerts are on for this device',
    detail: stylesBlocked
      ? 'Notifications work, but an ad blocker stopped part of the page styling. ' +
        'Allow this site, or open it in an Incognito window, to see the full design.'
      : config.vapidPublicKey
        ? 'The owner can reach this device even when the tab is closed.'
        : 'The owner can reach you while this tab is open. Background delivery ' +
          'needs a VAPID key — see the README.'
  };
}

/* -------------------------------------------------------------------------- */
/* Sending — Owner Panel only                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Ask the serverless sender (api/send-push.js, also mounted at /api/broadcast)
 * to push a custom message to every subscribed device via Web Push.
 *
 * This is the step that was missing: the Owner Panel wrote a broadcast into
 * Supabase and stopped there, so a reader with the tab closed never heard about
 * it and the panel could only honestly say "in-app delivery". The sender holds
 * the VAPID private key, reads `push_subscriptions` and calls web-push for us.
 *
 * Authentication is the Owner's own browser session, presented as the same
 * `x-wire-token` header every other database request already carries. The panel
 * never sees the VAPID private key or PUSH_SEND_TOKEN.
 *
 * @param {{title: string, body?: string, audience?: string, url?: string}} broadcast
 * @returns {Promise<{ok: boolean, delivered: number, reason?: string, detail?: string}>}
 *          `ok` is true only when the sender actually dispatched to at least one
 *          device — callers must not claim success otherwise.
 */
export async function dispatchWebPush({
  title,
  body = '',
  audience = 'Everyone',
  url = ''
} = {}) {
  const text = String(title || '').trim();
  if (!text) return { ok: false, delivered: 0, reason: 'empty_title' };

  // Without a VAPID public key in the build there is nothing on the devices to
  // push to, so do not spend a round-trip pretending otherwise.
  if (!config.vapidPublicKey) {
    return {
      ok: false,
      delivered: 0,
      reason: 'no_vapid_key',
      detail: 'VITE_VAPID_PUBLIC_KEY is not set in this build.'
    };
  }

  try {
    const response = await fetch('/api/broadcast', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // The Owner's session token. The function verifies it resolves to the
        // Owner before it will touch the subscriber list.
        ...(getSessionToken() ? { 'x-wire-token': getSessionToken() } : {})
      },
      body: JSON.stringify({
        title: text,
        body: String(body || ''),
        audience,
        url: url || config.notificationTargetUrl || '/'
      })
    });

    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }

    if (!response.ok || !data?.ok) {
      const detail = data?.detail || data?.code || `HTTP ${response.status}`;
      console.warn('[push] web push dispatch refused', response.status, detail);
      return { ok: false, delivered: 0, reason: data?.code || 'http_error', detail };
    }

    const delivered = Number(data.delivered ?? data.sent ?? 0);
    console.log('[push] web push dispatched', { delivered, skipped: data.skipped });
    return { ok: delivered > 0, delivered, reason: delivered > 0 ? undefined : 'no_subscribers' };
  } catch (error) {
    console.warn('[push] web push dispatch failed', error);
    return { ok: false, delivered: 0, reason: 'network', detail: error.message };
  }
}
