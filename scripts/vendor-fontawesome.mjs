/**
 * vendor-fontawesome.mjs — one-off helper.
 *
 * FontAwesome is the single most commonly blocked request on the web, and the
 * project used to pull it from cdnjs at runtime. Every icon in the UI would
 * vanish behind an ad blocker. This downloads the stylesheet and the woff2
 * fonts into public/vendor/fontawesome/ so they are served from our own origin
 * and cannot be blocked by a cosmetic filter.
 *
 * Run with:  node vendor-fontawesome.mjs
 * Only the woff2 files are kept: every browser that can run this app's ES
 * modules supports woff2, so the legacy .ttf fallbacks are dead weight.
 */
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), 'public', 'vendor', 'fontawesome');
const FONT_DIR = join(ROOT, 'webfonts');
const VERSION = '6.5.2';
const CDN = `https://cdnjs.cloudflare.com/ajax/libs/font-awesome/${VERSION}`;

const FONTS = [
  'fa-solid-900.woff2',
  'fa-regular-400.woff2',
  'fa-brands-400.woff2',
  'fa-v4compatibility.woff2'
];

mkdirSync(FONT_DIR, { recursive: true });

const progress = { dots: 0 };
function tick() {
  process.stdout.write(`\r  downloading… ${++progress.dots}`);
}

console.log(`Fetching FontAwesome ${VERSION} from cdnjs…`);

const res = await fetch(`${CDN}/css/all.min.css`);
if (!res.ok) {
  console.error(`\nFailed: ${res.status} ${res.statusText}`);
  process.exit(1);
}
let css = await res.text();
tick();

/**
 * Rewrite the @font-face sources to the local copies.
 *
 * Upstream uses `../webfonts/…` because the sheet lives in `css/`. Ours sits
 * directly in `fontawesome/`, next to its own `webfonts/` folder, so the path
 * is one level shallower. The legacy .ttf fallback lines are dropped in the same
 * pass: every browser that can run this app's ES modules supports woff2, so the
 * TrueType copies would be dead weight we never ship.
 */
css = css.replace(
  /(,\s*)?url\(\.\.\/webfonts\/(fa-[a-z0-9-]+)\.ttf\)\s*format\(['"]truetype['"]\)/g,
  ''
);
css = css.replace(/url\(\.\.\/webfonts\//g, 'url(webfonts/');

writeFileSync(join(ROOT, 'all.min.css'), css, 'utf8');
console.log(`\r  wrote all.min.css (${css.length} bytes)          `);

for (const font of FONTS) {
  const response = await fetch(`${CDN}/webfonts/${font}`);
  if (!response.ok) {
    console.error(`\n  MISSING ${font}: ${response.status}`);
    continue;
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  writeFileSync(join(FONT_DIR, font), bytes);
  tick();
}

console.log('\r  fonts written                                    ');

const present = FONTS.filter((f) => existsSync(join(FONT_DIR, f)));
console.log(`\nDone. ${present.length}/${FONTS.length} woff2 files in public/vendor/fontawesome/webfonts`);

// The stray .ttf files are never referenced after the rewrite above.
for (const stale of ['all.css']) {
  const p = join(ROOT, stale);
  if (existsSync(p)) rmSync(p);
}
