/* =============================================================================
   THE PULSE — THEME BOOT SCRIPT (served from /theme-boot.js)
   -----------------------------------------------------------------------------
   Runs synchronously in <head>, before first paint, so a visitor on a dark
   device never sees a white flash. It mirrors src/lib/theme.js exactly:
     localStorage['wire.theme']  ->  prefers-color-scheme  ->  light
   plus the cached editorial edition on <html data-theme>.

   WHY THIS IS AN EXTERNAL FILE
   The strict Content-Security-Policy (vercel.json) forbids inline scripts.
   A classic `<script src>` from our own origin is still parser-blocking and
   still executes before the body is parsed — the anti-flash behaviour is
   identical to the previous inline block, and `script-src 'self'` admits it.

   Keep in sync with src/lib/theme.js (applyInitialTheme) and note that
   tests/features.mjs asserts the `wire.theme` identifier is intact.
   ========================================================================== */
(function () {
  try {
    var stored = localStorage.getItem('wire.theme');
    var prefersDark =
      window.matchMedia &&
      window.matchMedia('(prefers-color-scheme: dark)').matches;
    var theme =
      stored === 'dark' || stored === 'light'
        ? stored
        : prefersDark
          ? 'dark'
          : 'light';
    var root = document.documentElement;
    root.classList.toggle('dark', theme === 'dark');
    root.classList.toggle('light', theme === 'light');
    root.style.colorScheme = theme;
    var edition = null;
    try { edition = localStorage.getItem('wire.edition'); } catch (e) {}
    if (edition !== 'christmas' && edition !== 'sports' && edition !== 'diwali') edition = 'default';
    console.log('[theme-boot] edition from cache', edition);
    root.dataset.theme = edition;
    root.dataset.edition = edition;
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      meta.setAttribute(
        'content',
        theme === 'dark' ? '#12100E' : '#F7F4EC'
      );
    }
  } catch (error) {
    /* localStorage blocked — fall through to the CSS light default */
  }
})();
