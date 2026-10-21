/* =============================================================================
   src/lib/edition.js — PUBLISHED EDITION CONTROLLER
   -----------------------------------------------------------------------------
   Dark/light mode (src/lib/theme.js) is independent. This module owns only the
   editorial edition: which theme is published, its options, caching and DOM
   application. Preview state never touches the published cache.
   ========================================================================== */

import { getSupabase } from './supabase.js';
import { normaliseThemeId, sanitizeThemeOptions, isValidThemeId } from './themes.js';

export const EDITION_STORAGE_KEY = 'wire.edition';
export const EDITION_OPTIONS_STORAGE_KEY = 'wire.edition.options';
export const EDITION_CHANGE_EVENT = 'wire:editionchange';

const ALLOWED = ['default', 'christmas', 'sports'];

function safeParseJson(value) {
  try {
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

export function getCachedEdition() {
  try {
    const theme = normaliseThemeId(localStorage.getItem(EDITION_STORAGE_KEY));
    const options = sanitizeThemeOptions(theme, safeParseJson(localStorage.getItem(EDITION_OPTIONS_STORAGE_KEY)));
    return { theme, options };
  } catch {
    return { theme: 'default', options: {} };
  }
}

export function cacheEdition(themeId, options) {
  const theme = normaliseThemeId(themeId);
  const clean = sanitizeThemeOptions(theme, options);
  try {
    localStorage.setItem(EDITION_STORAGE_KEY, theme);
    localStorage.setItem(EDITION_OPTIONS_STORAGE_KEY, JSON.stringify(clean));
  } catch {
    /* storage unavailable */
  }
  return { theme, options: clean };
}

export function clearCachedEdition() {
  try {
    localStorage.removeItem(EDITION_STORAGE_KEY);
    localStorage.removeItem(EDITION_OPTIONS_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

export function applyEdition(themeId, options, { updateCache = false } = {}) {
  const theme = normaliseThemeId(themeId);
  const clean = sanitizeThemeOptions(theme, options);
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.dataset.edition = theme;
  // Keep option flags available to scoped CSS/decorations.
  Object.keys(clean).forEach((key) => {
    root.dataset[`edition${key.charAt(0).toUpperCase()}${key.slice(1)}`] = String(clean[key]);
  });
  if (updateCache) cacheEdition(theme, clean);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(EDITION_CHANGE_EVENT, { detail: { theme, options: clean } }));
  }
  return { theme, options: clean };
}

export function applyCachedEdition() {
  const cached = getCachedEdition();
  return applyEdition(cached.theme, cached.options, { updateCache: false });
}

/** Fetch the published edition from Supabase (view only). Returns null on failure/timeout/missing. */
export async function fetchPublishedEdition(timeoutMs = 800) {
  const client = getSupabase();
  if (!client) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const query = client
      .from('site_theme_public')
      .select('published_theme,published_options')
      .limit(1)
      .maybeSingle();
    // supabase-js doesn't accept abort signal directly in older versions; race instead.
    const result = await Promise.race([
      query,
      new Promise((resolve) => setTimeout(() => resolve({ data: null, error: new Error('timeout') }), timeoutMs))
    ]);
    clearTimeout(timer);
    if (!result || result.error || !result.data) return null;
    const theme = normaliseThemeId(result.data.published_theme);
    const options = sanitizeThemeOptions(theme, result.data.published_options);
    return { theme, options };
  } catch {
    clearTimeout(timer);
    return null;
  }
}

/** Publish (owner). Writes to site_theme; caller must be owner (RLS). */
export async function publishEdition(themeId, options) {
  const theme = normaliseThemeId(themeId);
  const clean = sanitizeThemeOptions(theme, options);
  const client = getSupabase();
  if (!client) {
    // Demo mode: cache + apply only.
    cacheEdition(theme, clean);
    return applyEdition(theme, clean, { updateCache: true });
  }
  const { error } = await client
    .from('site_theme')
    .upsert({ id: 1, published_theme: theme, published_options: clean }, { onConflict: 'id' });
  if (error) throw error;
  cacheEdition(theme, clean);
  return applyEdition(theme, clean, { updateCache: true });
}

export async function restoreDefault() {
  return publishEdition('default', {});
}
