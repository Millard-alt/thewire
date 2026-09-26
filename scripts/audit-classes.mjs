/**
 * audit-classes.mjs — verify every utility class used in the source actually
 * made it into the COMPILED stylesheet.
 *
 * Checking against src/styles.css is meaningless for Tailwind: the utilities
 * only exist after the build. So this script cross-references the class names
 * used in index.html / src/** against dist/assets/*.css.
 *
 * Classes toggled purely from JS and styled via descendant/attribute
 * selectors are listed in IGNORE.
 *
 * Usage:  npm run build && node scripts/audit-classes.mjs
 * Exit 0 = nothing missing, 1 = the stylesheet never defines something used.
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const IGNORE = new Set([
  // toggled by classList, styled via descendant selectors or the cascade
  'active', 'hidden', 'dark', 'light', 'is-open', 'no-print'
]);

/** Font Awesome ships from a CDN, not from our stylesheet. */
const isIcon = (c) => /^fa-/.test(c);

/* ---- collect every class name used in the source ------------------------ */
const used = new Set();
const files = [];

function walk(target) {
  const full = join(ROOT, target);
  if (!existsSync(full)) return;
  if (statSync(full).isFile()) {
    files.push(full);
    return;
  }
  readdirSync(full).forEach((entry) => walk(join(target, entry)));
}
['index.html', 'src'].forEach(walk);

const CLASS_ATTR = /class="([^"$\n]*)"/g; // literal attrs only — no ${...} fragments
const CLASS_LIST = /classList\.(?:add|remove|toggle)\(\s*'([^']+)'/g;
const CLASS_LIST_MULTI = /classList\.(?:add|remove|toggle)\(\s*\[([^\]]+)\]/g;

for (const file of files) {
  if (!/\.(html|js)$/.test(file)) continue;
  const text = readFileSync(file, 'utf8');

  const record = (raw) =>
    raw
      .split(/\s+/)
      .map((c) => c.replace(/^['"`]|['"`]$/g, ''))
      .filter(Boolean)
      .forEach((c) => used.add(c));

  for (const m of text.matchAll(CLASS_ATTR)) record(m[1]);
  for (const m of text.matchAll(CLASS_LIST)) record(m[1]);
  for (const m of text.matchAll(CLASS_LIST_MULTI)) {
    m[1]
      .split(',')
      .map((c) => c.replace(/^['"\s`]|['"\s`]$/g, ''))
      .filter(Boolean)
      .forEach((c) => used.add(c));
  }
}

/* ---- collect the selectors the build actually emitted ------------------- */
const distAssets = join(ROOT, 'dist', 'assets');
if (!existsSync(distAssets)) {
  console.error('dist/assets not found - run `npm run build` first.');
  process.exit(1);
}
const css = readdirSync(distAssets)
  .filter((f) => f.endsWith('.css'))
  .map((f) => readFileSync(join(distAssets, f), 'utf8'))
  .join('\n');

const defined = new Set();
for (const m of css.matchAll(/\.((?:\\.|[A-Za-z0-9_-])+)/g)) {
  defined.add(m[1].replace(/\\(.)/g, '$1'));
}

/* ---- diff --------------------------------------------------------------- */
const missing = [...used]
  .filter((c) => !IGNORE.has(c) && !isIcon(c))
  .filter((c) => !defined.has(c))
  .sort();

console.log(`checked ${used.size} classes across ${files.length} source files`);
console.log(`stylesheet defines ${defined.size} selectors`);

if (!missing.length) {
  console.log('\nOK  every class used in source is present in the built CSS.\n');
  process.exit(0);
}

console.log(`\nMISSING (${missing.length}) - used in source, absent from CSS:\n`);
missing.forEach((c) => console.log('  ' + c));
console.log('');
process.exit(1);
