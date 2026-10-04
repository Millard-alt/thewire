/* =============================================================================
   THE WIRE — SERVICE WORKER
   -----------------------------------------------------------------------------
   Receives real Web Push messages and displays native OS notifications, so a
   broadcast from the Newsroom Panel genuinely pops up on a phone.

   Also handles clicks: tapping a notification focuses an existing tab rather
   than opening a duplicate one, then routes the reader to the broadcast link.
   ========================================================================== */

const SHELL_CACHE = 'thewire-shell-v1';

/**
 * Static assets that make the publication look correct. They are same-origin and
 * immutable-ish, so they are safe to serve from cache when the network fails.
 * Fonts and the icon sheet are included deliberately: a blocked CDN request must
 * never be able to strip the page of its typography or icons.
 */
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/vendor/fontawesome/all.min.css',
  '/icons/icon-192.png',
  '/manifest.webmanifest'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      // A single missing asset must not abort the whole install.
      .then((cache) => Promise.allSettled(SHELL_ASSETS.map((url) => cache.add(url))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== SHELL_CACHE).map((key) => caches.delete(key)))
      )
      .then(() => self.clients.claim())
  );
});

/**
 * Cache-first for the vendored shell, network-first for everything else.
 * Navigations fall back to the cached shell so a dropped connection still shows
 * the publication instead of the browser's offline error page.
 */
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  const isShellAsset =
    request.mode === 'navigate' ||
    url.pathname.startsWith('/vendor/') ||
    url.pathname.startsWith('/icons/') ||
    url.pathname === '/manifest.webmanifest';

  if (!isShellAsset) return;

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match('/index.html')));
    return;
  }

  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ||
        fetch(request).then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
    )
  );
});

/**
 * Show a notification. Called for real pushes and for in-page sends.
 *
 * `icon` is accepted from the payload so the sender controls it, but it is
 * validated against this origin first: an arbitrary remote URL in a push payload
 * is a tracking-pixel vector, and a bad path just makes the OS fall back to a
 * generic glyph. `/icons/icon-192.png` is the file that actually exists.
 */
async function display({ title, body, icon, tag, url, requireInteraction }) {
  const iconPath =
    typeof icon === 'string' && icon.startsWith('/') && !icon.startsWith('//')
      ? icon
      : '/icons/icon-192.png';

  const options = {
    body: body || '',
    // The tag collapses repeat broadcasts instead of stacking them.
    tag: tag || 'the-wire-broadcast',
    renotify: true,
    icon: iconPath,
    // No `badge`. A badge is the small monochrome glyph shown in the OS status
    // bar, and this project has no such asset: public/icons/ holds only
    // icon-192, icon-512 and icon-maskable-512, all full-colour brand marks.
    // Pointing `badge` at one of those produced a 404 on every notification
    // ("Failed to load resource: /icons/badge-72.png"), which the browser logs
    // as an error even though the notification still displays. Omitting the key
    // is the correct fix - the OS then shows its own default dot, and `icon`
    // above already provides the full-colour artwork where it belongs.
    // Alarms must not be silent or the reader misses an emergency dispatch.
    requireInteraction: Boolean(requireInteraction),
    vibrate: [200, 100, 200, 100, 200],
    data: { url: url || '/' },
    actions: [{ action: 'open', title: 'Read now' }]
  };

  // Prefer the standard API; Safari/iOS needs the constructor form.
  if (self.registration.showNotification) {
    return self.registration.showNotification(title || 'The Wire', options);
  }
  return self.registration.__proto__ &&
    new Notification(title || 'The Wire', options);
}

/* Push diagnostics. These are deliberately chatty: when a broadcast "does
 * nothing" the only place left to look is this worker, and by the time the
 * failure is visible in the OS the browser console of the page that triggered it
 * has long gone. Every line is prefixed [sw] so it can be filtered out of the
 * worker's console noise.
 */
const SW_LOG_PREFIX = '[sw]';

self.addEventListener('push', (event) => {
  let payload = {};
  let raw = null;
  let parseMode = 'empty';

  try {
    raw = event.data ? event.data.text() : null;
    if (raw) {
      try {
        payload = JSON.parse(raw);
        parseMode = 'json';
      } catch {
        // Not JSON. Fall back to a plain-text body rather than showing nothing.
        payload = { title: 'The Wire', body: raw };
        parseMode = 'text';
      }
    }
  } catch (err) {
    console.warn(SW_LOG_PREFIX + 'push: could not read event.data', err);
    parseMode = 'unreadable';
  }

  console.log(SW_LOG_PREFIX + 'push: received', {
    parseMode,
    rawLength: raw ? raw.length : 0,
    hasData: Boolean(event.data),
    keys: Object.keys(payload || {}),
    title: payload && payload.title,
    bodyPreview: payload && payload.body ? String(payload.body).slice(0, 80) : undefined
  });

  // A push with no body at all still has to say something: an empty notification
  // is indistinguishable from a failed one, and a reader cannot tell the
  // difference between "no news" and "the app is broken".
  const data = payload && typeof payload === 'object' ? payload : {};
  const shown = {
    title: data.title || 'New Alert',
    body: data.body || data.message || 'You have an update!',
    icon: data.icon,
    tag: data.tag || (data.id ? `broadcast-${data.id}` : undefined),
    url: data.url,
    requireInteraction: data.requireInteraction !== false
  };

  console.log(SW_LOG_PREFIX + 'push: showing', {
    parseMode,
    title: shown.title,
    icon: shown.icon,
    tag: shown.tag,
    requireInteraction: shown.requireInteraction
  });

  event.waitUntil(
    display(shown)
      .then((result) => {
        console.log(SW_LOG_PREFIX + 'push: showNotification resolved', {
          ok: Boolean(result),
          tag: shown.tag
        });
      })
      .catch((error) => {
        // Almost always one of: permission revoked, the device is in a
        // battery-saver mode, or the OS refused the vibration pattern.
        console.error(SW_LOG_PREFIX + 'push: showNotification FAILED', {
          name: error && error.name,
          message: error && error.message,
          stack: error && error.stack
        });
      })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      // Reuse a tab that is already open, if there is one. `navigate` rather
      // than `focus` alone so a notification pointing at a specific story
      // actually lands on that story.
      for (const client of list) {
        if ('focus' in client) {
          if ('navigate' in client) return client.navigate(target).then((c) => c && c.focus());
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
      return undefined;
    })
  );
});

/**
 * In-page sends. The owner panel can raise a notification on the device it is
 * open on without a round trip through the database, which is what makes the
 * "Send a test alert" button in the Newsroom Panel genuinely useful.
 */
self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'SHOW_NOTIFICATION') {
    event.waitUntil(
      display({
        title: data.title,
        body: data.body,
        tag: data.tag,
        url: data.url,
        requireInteraction: data.requireInteraction
      })
    );
  }
});
