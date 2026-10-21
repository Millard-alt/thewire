import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('D:/website/Finalver/node_modules/playwright');

const PORT = 5204;
const BASE = `http://localhost:${PORT}/`;
const server = spawn('node', ['node_modules/vite/bin/vite.js', '--mode', 'demo', '--port', String(PORT), '--strictPort'], { cwd: 'D:/website/Finalver', stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
server.stdout.on('data', d => log += d);
server.stderr.on('data', d => log += d);
function stop() { try { server.kill(); } catch {} }
process.on('exit', stop);
async function wait() {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    try { const r = await fetch(BASE); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 400));
  }
  console.log(log.slice(-2000));
  stop();
  process.exit(2);
}
await wait();
const browser = await chromium.launch();
const vars = ['--color-paper', '--color-ink', '--color-newsred', '--surface', '--text', '--accent'];
const computed = {};
for (const edition of ['default', 'christmas', 'sports']) {
  for (const mode of ['light', 'dark']) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    await page.addInitScript(({ edition, mode }) => {
      localStorage.setItem('wire.edition', edition);
      localStorage.setItem('wire.theme', mode);
    }, { edition, mode });
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    const dt = await page.evaluate(() => document.documentElement.dataset.theme);
    if (dt !== edition) { console.error('dataset mismatch', edition, dt); process.exit(1); }
    const vals = await page.evaluate((vars) => {
      const cs = getComputedStyle(document.documentElement);
      const out = {};
      vars.forEach(v => { out[v] = cs.getPropertyValue(v).trim(); });
      return out;
    }, vars);
    computed[`${edition}-${mode}`] = vals;
    await ctx.close();
  }
}
await browser.close();
stop();

let failed = false;
for (const mode of ['light', 'dark']) {
  const d = computed[`default-${mode}`];
  const c = computed[`christmas-${mode}`];
  const s = computed[`sports-${mode}`];
  const identical = (a, b) => vars.every(v => a[v] === b[v]);
  if (identical(d, c)) { console.error(`christmas identical to default in ${mode}`); failed = true; }
  if (identical(d, s)) { console.error(`sports identical to default in ${mode}`); failed = true; }
  if (identical(c, s)) { console.error(`christmas identical to sports in ${mode}`); failed = true; }
}
if (failed) process.exit(1);
console.log('PASS: theme computed tokens differ across editions');
process.exit(0);
