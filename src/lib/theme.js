/* =============================================================================
   src/lib/theme.js — DARK / LIGHT MODE CONTROLLER
   -----------------------------------------------------------------------------
   Priority order:
     1. An explicit choice the user made in this browser (localStorage)
     2. The operating system's `prefers-color-scheme`
     3. Light, as the final fallback

   The chosen theme is applied by toggling `dark` on <html>, which is the
   selector Tailwind v4's `@custom-variant dark` is bound to. It is also
   mirrored onto <meta name="theme-color"> so mobile browser chrome matches,
   and broadcast on the `themechange` CustomEvent so open modals and the admin
   workspace re-render with the right colours.

   NOTE: `applyInitialTheme()` is also inlined in <head> (index.html) so the
   correct theme is painted before first paint — no white flash on a dark-mode
   device. Both implementations must stay in sync.
   ========================================================================== */

export const THEME_STORAGE_KEY = 'wire.theme';
export const THEME_CHANGE_EVENT = 'wire:themechange';

const media = window.matchMedia('(prefers-color-scheme: dark)');

/** Colours fed to the browser/toolbar chrome, per theme. */
const THEME_COLORS = {
  light: '#F7F4EC',
  dark: '#12100E'
};

/** @returns {'dark'|'light'|null} the stored preference, if any. */
export function getStoredTheme() {
  try {
    const value = localStorage.getItem(THEME_STORAGE_KEY);
    return value === 'dark' || value === 'light' ? value : null;
  } catch {
    // Private-mode Safari / disabled storage: fall through to system preference.
    return null;
  }
}

/** Persist an explicit choice. @param {'dark'|'light'} theme */
export function storeTheme(theme) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    /* storage unavailable — the theme still applies for this page view */
  }
}

/** The theme the OS is currently asking for. */
export function getSystemTheme() {
  return media.matches ? 'dark' : 'light';
}

/** The theme actually in effect right now. */
export function getActiveTheme() {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

/**
 * Apply a theme to the document.
 * @param {'dark'|'light'} theme
 * @param {{persist?: boolean}} [options]
 */
export function applyTheme(theme, { persist = true } = {}) {
  const next = theme === 'dark' ? 'dark' : 'light';
  const root = document.documentElement;

  root.classList.toggle('dark', next === 'dark');
  // The `.light` class lets CSS distinguish "forced light" from "no choice yet".
  root.classList.toggle('light', next === 'light');
  root.style.colorScheme = next;

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', THEME_COLORS[next]);

  if (persist) storeTheme(next);

  window.dispatchEvent(
    new CustomEvent(THEME_CHANGE_EVENT, { detail: { theme: next } })
  );

  return next;
}

/**
 * Resolve + apply the correct theme on boot.
 * Explicit stored choice wins; otherwise follow the OS.
 */
export function applyInitialTheme() {
  const stored = getStoredTheme();
  return applyTheme(stored ?? getSystemTheme(), { persist: false });
}

/** Flip between light and dark and remember the choice. */
export function toggleTheme() {
  return applyTheme(getActiveTheme() === 'dark' ? 'light' : 'dark');
}

/** Re-sync with the OS if the user has never made an explicit choice. */
function followSystemUnlessOverridden() {
  if (getStoredTheme() === null) applyTheme(getSystemTheme(), { persist: false });
}

/**
 * Wire up the DOM controls:
 *   - `#theme-toggle`      the nav switch (checkbox input)
 *   - `#theme-toggle-label`the live-region text ("Dark mode"/"Light mode")
 *   - OS-level changes, so a user who flips their system theme gets it live
 */
export function initThemeControls() {
  applyInitialTheme();

  const input = document.getElementById('theme-toggle');
  const label = document.getElementById('theme-toggle-label');

  const syncControl = () => {
    const active = getActiveTheme();
    const isDark = active === 'dark';
    if (input) {
      input.checked = isDark;
      // The control is an ARIA switch, so its state must be mirrored onto
      // aria-checked as well as the checked property.
      input.setAttribute('aria-checked', String(isDark));
    }
    if (label) {
      label.textContent = isDark ? 'Dark mode' : 'Light mode';
    }
    if (input) {
      input.setAttribute(
        'aria-label',
        isDark ? 'Switch to light mode' : 'Switch to dark mode'
      );
    }
  };

  input?.addEventListener('change', (event) => {
    applyTheme(event.target.checked ? 'dark' : 'light');
    syncControl();
  });

  // Keep the control honest if something else changes the theme.
  window.addEventListener(THEME_CHANGE_EVENT, syncControl);
  window.addEventListener('storage', (event) => {
    if (event.key === THEME_STORAGE_KEY) {
      applyTheme(event.newValue ?? getSystemTheme(), { persist: false });
      syncControl();
    }
  });

  // Older Safari uses addListener; modern browsers use addEventListener.
  if (typeof media.addEventListener === 'function') {
    media.addEventListener('change', followSystemUnlessOverridden);
  } else if (typeof media.addListener === 'function') {
    media.addListener(followSystemUnlessOverridden);
  }

  syncControl();
}
