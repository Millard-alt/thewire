import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (!globalThis.localStorage) {
  const backing = new Map();
  globalThis.localStorage = {
    getItem: (key) => (backing.has(key) ? backing.get(key) : null),
    setItem: (key, value) => backing.set(key, String(value)),
    removeItem: (key) => backing.delete(key),
    clear: () => backing.clear()
  };
}

const { THEME_IDS, isValidThemeId, normaliseThemeId, sanitizeThemeOptions, validateAllThemes } =
  await import('../src/lib/themes.js');
const { getCachedEdition, cacheEdition, applyEdition, normaliseThemeId: nt } =
  await import('../src/lib/edition.js');

let pass = 0, fail = 0, failures = [];
function report(label, ok, detail = '') {
  if (ok) { pass++; console.log('  PASS  ' + label); }
  else { fail++; failures.push(label + (detail ? '\n        ' + detail : '')); console.log('  FAIL  ' + label + (detail ? '\n        ' + detail : '')); }
}

report('three themes only', THEME_IDS.length === 3 && THEME_IDS.includes('default') && THEME_IDS.includes('christmas') && THEME_IDS.includes('sports'), JSON.stringify(THEME_IDS));
report('invalid theme falls back to default', normaliseThemeId('nope') === 'default');
report('valid theme preserved', normaliseThemeId('Sports') === 'sports');
report('theme config valid', validateAllThemes().ok === true);

const sanitized = sanitizeThemeOptions('christmas', { ornaments: false, banner: 'x', evil: true });
report('sanitize drops unknown/wrong types', sanitized.ornaments === false && sanitized.banner === true && !('evil' in sanitized));

const cached = cacheEdition('christmas', { ornaments: false });
report('cache returns normalized', cached.theme === 'christmas' && cached.options.ornaments === false);
report('cached readback', getCachedEdition().theme === 'christmas');

// applyEdition sets data-theme
if (!globalThis.document) {
  globalThis.document = { documentElement: { dataset: {}, classList: { toggle() {} } } };
}
applyEdition('sports', { trackLanes: false });
report('apply sets dataset.theme', document.documentElement.dataset.theme === 'sports');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
