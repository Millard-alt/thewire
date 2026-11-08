import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('D:/website/Finalver/node_modules/playwright');

const PORT = 5206;
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
const pairs = [
  ['--text','--bg','body'],
  ['--text-muted','--bg','muted'],
  ['--text','--surface','card'],
  ['--text-muted','--surface','card muted'],
  ['--accent','--bg','eyebrow'],
  ['--accent','--surface','author label'],
  ['--nav-ink','--nav-bg','nav'],
  ['--brk-ink','--brk-bg','breaking bar'],
  ['--btn-ink','--btn-bg','button'],
  ['--hero-ink','--hero-bg','hero'],
  ['--mast-ink','--mast-bg','masthead title'],
  ['--mast-muted','--mast-bg','masthead dateline'],
  ['--mast-accent','--mast-bg','masthead tagline'],
];
let failed = false;
for (const edition of ['default','christmas','sports']) {
  for (const mode of ['light','dark']) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    await page.addInitScript(({ edition, mode }) => {
      localStorage.setItem('wire.edition', edition);
      localStorage.setItem('wire.theme', mode);
    }, { edition, mode });
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    const vals = await page.evaluate((vars) => {
      const cs = getComputedStyle(document.documentElement);
      const out = {};
      vars.forEach(v => { out[v] = cs.getPropertyValue(v).trim(); });
      return out;
    }, Array.from(new Set(pairs.flat().filter(v=>v.startsWith('--')))));
    const lum = (hex) => {
      // handle var() not resolved? computed values are hex or color-mix; for color-mix skip
      if (!/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(hex)) return null;
      let h = hex.replace('#','');
      if (h.length === 3) h = h.split('').map(c=>c+c).join('');
      const r = parseInt(h.slice(0,2),16)/255;
      const g = parseInt(h.slice(2,4),16)/255;
      const b = parseInt(h.slice(4,6),16)/255;
      const toLin = (v) => v <= 0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4);
      return 0.2126*toLin(r) + 0.7152*toLin(g) + 0.0722*toLin(b);
    };
    const ratio = (a,b) => {
      const la = lum(a), lb = lum(b);
      if (la === null || lb === null) return null;
      return (Math.max(la,lb)+0.05)/(Math.min(la,lb)+0.05);
    };
    for (const [fg,bg,name] of pairs) {
      const r = ratio(vals[fg], vals[bg]);
      if (r !== null && r < 4.5) {
        console.error(`CONTRAST FAIL ${edition}/${mode}: ${name} ${vals[fg]} on ${vals[bg]} = ${r.toFixed(2)}`);
        failed = true;
      }
    }
    await ctx.close();
  }
}
await browser.close();
stop();
if (failed) process.exit(1);
console.log('PASS: all contrast pairs >= 4.5:1 where computable');
process.exit(0);
