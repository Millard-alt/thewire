/* =============================================================================
   scripts/logo-assets.mjs — ICONS AND FAVICON FROM THE CREST
   -----------------------------------------------------------------------------
   public/icons/ still held a red "W" -- the old "The Wire" mark, left behind by
   the rebrand. That image is what a phone shows on the home screen and what a
   browser shows in the tab, so the site called The Pulse was shipping a logo
   from a name it no longer uses.

   This regenerates every icon surface from public/logo.png so there is exactly
   one source of truth:
     public/icons/icon-192.png            home screen, browser tab
     public/icons/icon-512.png            splash screen, high-DPI
     public/icons/icon-maskable-512.png   Android adaptive (needs safe padding)
     public/favicon-32.png                /favicon.ico fallback chain

   The maskable variant is not just a resize: Android crops adaptive icons to
   whatever shape the launcher uses and can guillotine up to 20% off each edge,
   so the crest is inset to sit inside the safe circle rather than being scaled
   to the full square and sliced.

   Run:  npm run build:icons
   ========================================================================== */

import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const PAPER = '#f7f4ec';
const logoDataUri = 'data:image/png;base64,' + readFileSync('public/logo.png').toString('base64');

/** A square card: the crest centred, optionally inset for a maskable safe zone. */
const card = (size, { inset = 0, background = 'transparent' } = {}) => `<!doctype html>
<html><head><meta charset="utf-8"><style>
*{margin:0;padding:0}
html,body{width:${size}px;height:${size}px;background:${background};overflow:hidden}
img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;
  padding:${inset * 100}%}
</style></head><body><img src="${logoDataUri}" alt="" /></body></html>`;

const browser = await chromium.launch();

async function render(file, size, opts = {}) {
  const page = await browser.newPage({
    viewport: { width: size, height: size },
    deviceScaleFactor: 1
  });
  await page.setContent(card(size, opts), { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: file, type: 'png', omitBackground: opts.background === 'transparent' });
  await page.close();

  const buf = readFileSync(file);
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  if (w !== size || h !== size) {
    console.error(`FAIL  ${file} is ${w}x${h}, expected ${size}x${size}`);
    process.exit(1);
  }
  console.log(`PASS  ${file.padEnd(34)} ${w}x${h}  ${(buf.length / 1024).toFixed(1)} KB`);
}

await render('public/icons/icon-192.png', 192);
await render('public/icons/icon-512.png', 512);
// 12% inset keeps the crest inside Android's safe zone after the launcher's
// circular crop.
await render('public/icons/icon-maskable-512.png', 512, {
  inset: 0.12,
  background: PAPER
});
// A 32px tab icon must sit on an opaque square: a transparent favicon renders as
// a white blob against a dark browser chrome.
await render('public/favicon-32.png', 32, { background: PAPER });

await browser.close();
console.log('\nEvery icon now derives from public/logo.png. Change the crest and');
console.log('re-run `npm run build:icons`; nothing else has to be redrawn.');