/* =============================================================================
   src/lib/themes.js — EDITORIAL EDITION CONFIG (data, not duplicated pages)
   -----------------------------------------------------------------------------
   Three editions only: default, christmas, sports. A theme is a token set plus
   an options schema plus asset references. It never carries layout or content.
   ========================================================================== */

export const THEME_IDS = ['default', 'christmas', 'sports'];

export function isValidThemeId(value) {
  return THEME_IDS.includes(String(value || '').trim().toLowerCase());
}

export function normaliseThemeId(value) {
  const id = String(value || '').trim().toLowerCase();
  return isValidThemeId(id) ? id : 'default';
}

/** Default option values per theme. Unknown keys are dropped on sanitize. */
export const DEFAULT_THEME_OPTIONS = {
  default: {},
  christmas: { ornaments: true, banner: true },
  sports: { trackLanes: true, finishLine: true }
};

/** Schema: allowed option keys and their types. */
export const THEME_OPTION_SCHEMAS = {
  default: {},
  christmas: { ornaments: 'boolean', banner: 'boolean' },
  sports: { trackLanes: 'boolean', finishLine: 'boolean' }
};

/** Sanitize an options object against the schema, falling back to defaults. */
export function sanitizeThemeOptions(themeId, raw) {
  const id = normaliseThemeId(themeId);
  const schema = THEME_OPTION_SCHEMAS[id] || {};
  const defaults = DEFAULT_THEME_OPTIONS[id] || {};
  const source = raw && typeof raw === 'object' ? raw : {};
  const out = { ...defaults };
  Object.keys(schema).forEach((key) => {
    const type = schema[key];
    const value = source[key];
    if (type === 'boolean' && typeof value === 'boolean') out[key] = value;
  });
  return out;
}

export const THEMES = {
  default: {
    id: 'default',
    label: 'Default',
    editionLabel: 'Default Edition',
    optionsSchema: {},
    defaultOptions: {},
    tokens: {},
    assets: {}
  },
  christmas: {
    id: 'christmas',
    label: 'Christmas',
    editionLabel: 'Christmas Edition',
    optionsSchema: { ornaments: 'boolean', banner: 'boolean' },
    defaultOptions: { ornaments: true, banner: true },
    tokens: {},
    assets: { hero: 'christmas-hero', ornament: 'christmas-ornament' }
  },
  sports: {
    id: 'sports',
    label: 'Sports',
    editionLabel: 'Sports Edition',
    optionsSchema: { trackLanes: 'boolean', finishLine: 'boolean' },
    defaultOptions: { trackLanes: true, finishLine: true },
    tokens: {},
    assets: { hero: 'sports-hero', track: 'sports-track' }
  }
};

/** Validate a whole config object. Returns { ok, errors }. */
export function validateThemeConfig(config) {
  const errors = [];
  if (!config || typeof config !== 'object') {
    return { ok: false, errors: ['config must be an object'] };
  }
  if (!isValidThemeId(config.id)) errors.push('invalid theme id');
  if (typeof config.label !== 'string' || !config.label) errors.push('label required');
  if (typeof config.editionLabel !== 'string' || !config.editionLabel) errors.push('editionLabel required');
  if (!config.optionsSchema || typeof config.optionsSchema !== 'object') errors.push('optionsSchema required');
  if (!config.defaultOptions || typeof config.defaultOptions !== 'object') errors.push('defaultOptions required');
  return { ok: errors.length === 0, errors };
}

export function validateAllThemes() {
  const results = {};
  let ok = true;
  Object.values(THEMES).forEach((theme) => {
    const result = validateThemeConfig(theme);
    results[theme.id] = result;
    if (!result.ok) ok = false;
  });
  return { ok, results };
}
