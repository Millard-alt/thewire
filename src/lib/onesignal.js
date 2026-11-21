/* =============================================================================
   src/lib/onesignal.js — ONESIGNAL SDK BRIDGE
   -----------------------------------------------------------------------------
   Thin, promise-safe bridge to the OneSignal Web SDK (v16). The rest of the
   app must never poke `window.OneSignal` directly:

     - the SDK script loads ASYNC from a CDN, so everything below awaits it;
     - `initOneSignal()` is memoised, so every caller shares one init and one
       `permissionChange` subscription surface;
     - every probe degrades to 'unsupported' instead of throwing, because a
       blocked SDK must never take the page down.

   The OneSignal REST API key is server-only (api/send-onesignal.js); the only
   value the browser needs is the public app id (VITE_ONESIGNAL_APP_ID).
   ========================================================================== */

import { config } from './config.js';

const SDK_URL = 'https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.page.js';

/** Shared init promise so repeated callers never double-load or double-init. */
let initPromise = null;

/** Inject the SDK script tag once, resolving when window.OneSignal exists. */
function loadSdk() {
  return new Promise((resolve, reject) => {
    if (window.OneSignal) {
      resolve(window.OneSignal);
      return;
    }
    const existing = document.querySelector('script[data-onesignal-sdk]');
    if (!existing) {
      const script = document.createElement('script');
      script.src = SDK_URL;
      script.defer = true;
      script.integrity = 'sha384-qOZAgMhG6XuXkezYVIeLdYtonxw+lNknfWfvbPbBWH5cSO5T6nSshFPzEfUoL7ZV';
      script.crossOrigin = 'anonymous';
      script.setAttribute('data-onesignal-sdk', 'true');
      script.addEventListener('error', () => reject(new Error('OneSignal SDK failed to load.')));
      document.head.appendChild(script);
    }
    // Poll briefly for the global; the SDK sets it once initialised.
    const started = Date.now();
    const tick = () => {
      if (window.OneSignal) {
        resolve(window.OneSignal);
        return;
      }
      if (Date.now() - started > 15000) {
        reject(new Error('OneSignal SDK did not initialise in time.'));
        return;
      }
      setTimeout(tick, 100);
    };
    setTimeout(tick, 100);
  });
}

/**
 * Load and initialise OneSignal. Resolves with the OneSignal global, or null
 * when there is no app id configured (the caller treats null as 'unsupported').
 *
 * The signed-in username is passed as the external user id, which is exactly
 * the id api/send-onesignal.js targets — so approval pushes reach this device.
 *
 * @param {string} [externalId] the signed-in user's username
 * @returns {Promise<object|null>}
 */
export function initOneSignal(externalId = '') {
  if (!config.onesignalAppId) return Promise.resolve(null);
  if (!initPromise) {
    initPromise = (async () => {
      try {
        const OneSignal = await loadSdk();
        await OneSignal.init({ appId: config.onesignalAppId });
        const id = String(externalId || '').trim();
        if (id && typeof OneSignal.login === 'function') {
          // v16 renamed setExternalUserId -> login. Tolerate both.
          try {
            await OneSignal.login(id);
          } catch {
            if (typeof OneSignal.setExternalUserId === 'function') {
              await OneSignal.setExternalUserId(id);
            }
          }
        }
        return OneSignal;
      } catch (error) {
        console.warn('[onesignal] init failed', error);
        initPromise = null; // allow a later retry (e.g. after a reload)
        return null;
      }
    })();
  }
  return initPromise;
}

/**
 * The current OneSignal permission as a Notification-permission-style string.
 *
 * `OneSignal.Notifications.permission` is a BOOLEAN in v16;
 * `permissionNative` (when the SDK version ships it) carries the precise
 * 'default' | 'granted' | 'denied' trio, which is what the gate needs to
 * distinguish "never asked" from "actively blocked".
 *
 * @returns {Promise<'granted'|'denied'|'default'|'unsupported'>}
 */
export async function onesignalPermission() {
  if (!config.onesignalAppId) return 'unsupported';
  const OneSignal = await initOneSignal();
  if (!OneSignal?.Notifications) return 'unsupported';
  const native = OneSignal.Notifications.permissionNative;
  if (native === 'granted' || native === 'denied' || native === 'default') return native;
  return OneSignal.Notifications.permission ? 'granted' : 'default';
}

/**
 * Subscribe to permission changes. Returns an unsubscribe function.
 *
 * @param {(granted: boolean) => void} callback
 * @returns {Promise<() => void>}
 */
export async function onOneSignalPermissionChange(callback) {
  const OneSignal = await initOneSignal();
  if (!OneSignal?.Notifications?.addEventListener) return () => {};
  const handler = (event) => callback(Boolean(event));
  OneSignal.Notifications.addEventListener('permissionChange', handler);
  return () => OneSignal.Notifications.removeEventListener('permissionChange', handler);
}

/**
 * Fire the OneSignal slidedown prompt from a real user click. Resolves once
 * the prompt has been SHOWN — the permission answer arrives separately
 * through onOneSignalPermissionChange, which is what the forced gate awaits.
 *
 * @returns {Promise<boolean>} true when the prompt was invoked
 */
export async function promptOneSignalPush() {
  const OneSignal = await initOneSignal();
  if (!OneSignal?.Slidedown?.promptPush) return false;
  try {
    await OneSignal.Slidedown.promptPush();
    return true;
  } catch (error) {
    console.warn('[onesignal] promptPush failed', error);
    return false;
  }
}
