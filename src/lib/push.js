/* =============================================================================
   src/lib/push.js — REAL PUSH NOTIFICATIONS
   -----------------------------------------------------------------------------
   Everything needed to raise a genuine OS-level notification:

       initPush()                register the service worker
       getPermission()           'unsupported' | 'default' | 'granted' | 'denied'
       requestPermission()       ask the reader (must come from a user gesture)
       subscribeToPush()         real Web Push subscription (needs a VAPID key)
       deliverLocally()          show a real notification on THIS device, now
       startBroadcastPolling()   poll for the owner's broadcasts and raise them

   Two delivery paths, because they need different infrastructure:

   1. Web Push reaches a reader whose tab is closed, but it needs a VAPID key
      pair AND a trusted sender holding the private key. A static front-end can
      do neither, so the private key must never ship to the browser. Without a
      sender, delivery is limited to path 2.

   2. In-app delivery needs no backend at all: the owner posts a broadcast, it
      lands in the `broadcasts` table, and every open client polls for it and
      raises a real OS notification. This genuinely works today.

   Nothing here fakes success. If the browser or an extension blocks the
   notification we report that and fall back to the in-page banner.
   ========================================================================== */

import { config } from './config.js';
import { getSupabase } from './supabase.js';

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

/** True when this browser can raise a real OS notification. */
export function isSupported() {
  return (
    typeof window !== 'undefined' &&
    'Notification' in window &&
    'serviceWorker' in navigator
  );
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
      // Always register the device, even when Web Push is unconfigured, so the
      // Owner's subscriber list reflects real opted-in devices.
      await subscribeToPush();
      await registerDevice().catch(() => {});
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
    badge: '/icons/badge-72.png',
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

/** Decode a base64url VAPID public key into the Uint8Array the API expects. */
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((char) => char.charCodeAt(0)));
}

/**
 * Create or refresh this device's Web Push subscription and store it locally.
 * Returns null when push is not configured, which is the expected case today.
 */
export async function subscribeToPush() {
  const vapidKey = config.vapidPublicKey;
  if (!vapidKey) {
    console.info('[push] no VAPID key configured — in-app delivery only.');
    return null;
  }
  if (getPermission() !== 'granted') return null;
  if (!('PushManager' in window)) return null;

  const registration = await initPush();
  if (!registration?.pushManager) return null;

  try {
    const existing = await registration.pushManager.getSubscription();
    const subscription =
      existing ||
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey)
      }));

    try {
      localStorage.setItem(SUBSCRIPTION_KEY, JSON.stringify(subscription));
    } catch {
      /* private browsing */
    }

    await syncSubscription(subscription);
    return subscription;
  } catch (error) {
    console.warn('[push] subscription failed', error);
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

    if (!subscription) {
      // Only clear the record if it is one of our own local rows; never touch a
      // real push endpoint, which belongs to the browser's push service.
      const { error } = await client
        .from('push_subscriptions')
        .delete()
        .eq('endpoint', endpoint);
      if (error) throw error;
      return { removed: true };
    }

    const { error } = await client
      .from('push_subscriptions')
      .upsert(
        {
          endpoint,
          device: deviceLabel(),
          audience: 'Everyone',
          last_seen: new Date().toISOString()
        },
        { onConflict: 'endpoint' }
      );

    if (error) throw error;
    return { stored: true };
  } catch (error) {
    console.warn('[push] could not sync subscription', error);
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
  if (!client) return [];

  // A reader who has blocked notifications gets nothing; do not even poll.
  if (getPermission() !== 'granted') return [];

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
    console.warn('[push] broadcast poll failed', error);
    return [];
  }

  const seen = readSeen();
  const raised = [];

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
