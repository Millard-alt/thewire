/* =============================================================================
   scripts/og-image.mjs — SOCIAL PREVIEW CARD
   -----------------------------------------------------------------------------
   Renders public/og-image.png at exactly 1200x630, which is the size Facebook,
   LinkedIn, X and iMessage all crop to. It is committed rather than generated
   at build time so the URL in the og:image / twitter:image tags is stable and
   cacheable; this script exists so the PNG can be regenerated deterministically
   when the logo or the name changes.

   Everything is inlined -- fonts as base64 data URIs -- because a card that
   silently falls back to Times New Roman when fonts.googleapis.com is slow or
   blocked is worse than no card. The site already serves these faces from its
   own origin (public/vendor/fonts), so there is no reason to depend on a CDN
   here either.

   Run:  npm run build:og
   ========================================================================== */

import { readFileSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const W = 1200;
const H = 630;
const OUT = 'public/og-image.png';

const PAPER = '#f7f4ec';
const INK = '#12100e';
const RED = '#8c1d11';
const GOLD = '#b8860b';

/** Inline a woff2 as a data URI so the render never waits on a network font. */
const face = (file, family, weight) => {
  const b64 = readFileSync(`public/vendor/fonts/${file}`).toString('base64');
  return `@font-face{font-family:'${family}';font-style:normal;font-weight:${weight};` +
         `src:url(data:font/woff2;base64,${b64}) format('woff2');}`;
};

const logoDataUri =
  'data:image/png;base64,' + readFileSync('public/logo.png').toString('base64');

const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
${face('playfair-display-400900-normal.woff2', 'Playfair', '400 900')}
${face('inter-600-normal.woff2', 'Inter', '600')}
${face('inter-700-normal.woff2', 'Inter', '700')}
${face('inter-800-normal.woff2', 'Inter', '800')}
${face('special-elite-400-normal.woff2', 'Elite', '400')}
*{margin:0;padding:0;box-sizing:border-box}
body{width:${W}px;height:${H}px;background:${PAPER};color:${INK};
  font-family:'Inter',sans-serif;display:flex;flex-direction:column;
  overflow:hidden;position:relative}
.rule{height:14px;background:${INK};flex:none}
.gold{height:5px;background:${GOLD};flex:none}
.body{flex:1;display:flex;align-items:center;gap:52px;padding:0 76px}
.logo{width:236px;height:236px;object-fit:contain;flex:none}
.txt{flex:1}
.kicker{font-family:'Elite',monospace;font-size:20px;letter-spacing:.30em;
  text-transform:uppercase;color:${RED};margin-bottom:16px}
.name{font-family:'Playfair',serif;font-weight:900;font-size:104px;line-height:.92;
  letter-spacing:.02em;text-transform:uppercase}
.org{margin-top:20px;font-size:31px;font-weight:700;letter-spacing:.055em;
  text-transform:uppercase;color:${INK}}
.tag{margin-top:14px;font-size:21px;font-weight:600;letter-spacing:.14em;
  text-transform:uppercase;color:#5c564b}
.foot{height:78px;flex:none;display:flex;align-items:center;justify-content:space-between;
  padding:0 76px;border-top:2px solid rgba(18,16,14,.16);background:${PAPER}}
.foot span{font-size:19px;font-weight:700;letter-spacing:.16em;text-transform:uppercase}
.foot .r{color:${RED}}
</style></head><body>
  <div class="rule"></div><div class="gold"></div>
  <div class="body">
    <img class="logo" src="${logoDataUri}" alt="" />
    <div class="txt">
      <div class="kicker">Nakuru &#8226; Kenya</div>
      <div class="name">The Pulse</div>
      <div class="org">Melvin Jones Press Club</div>
      <div class="tag">Independent Verified Dispatches</div>
    </div>
  </div>
  <div class="foot">
    <span>thepulse.us.ci</span>
    <span class="r">News &#8226; Interviews &#8226; Podcasts</span>
  </div>
</body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: W, height: H },
  deviceScaleFactor: 1
});
await page.setContent(html, { waitUntil: 'load' });
// webfonts must be resolved before the screenshot or the capture races the font
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: OUT, type: 'png' });
await browser.close();

// Prove the output is the size the social platforms actually want, so a silent
// resize or a clip cannot ship.
const buf = readFileSync(OUT);
const gotW = buf.readUInt32BE(16);
const gotH = buf.readUInt32BE(20);
if (gotW !== W || gotH !== H) {
  console.error(`FAIL  ${OUT} is ${gotW}x${gotH}, expected ${W}x${H}`);
  process.exit(1);
}
writeFileSync(OUT, buf);
console.log(`PASS  ${OUT} is exactly ${gotW}x${gotH} (${(buf.length / 1024).toFixed(1)} KB)`);
console.log('      Served from this origin, so no external image host is involved.');