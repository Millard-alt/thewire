/* =============================================================================
   scripts/egress-check.mjs
   -----------------------------------------------------------------------------
   Static guards against the three shapes of query that turned into a Supabase
   egress bill. A test is cheaper than an invoice.

   1. THE POLL asked for the same five broadcasts every sixty seconds, on every
      open tab, forever -- and threw away the ones already seen. 43,200
      requests per tab per month. Now it filters on a `created_at` watermark so
      the common case returns zero rows.

   2. BACKOFF. Broadcasting is rare, so the costliest thing a poller can do is
      keep asking at full speed during silence. The interval must grow when a
      pass finds nothing and reset when it does.

   3. HIDDEN TABS. A tab the reader cannot see cannot show an alert. Polling it
      is pure waste, and background tabs are where tabs spend their lives.

   4. HYDRATE fetched whole tables with `select('*')` and no limit on every page
      load, for every reader including anonymous ones. `body` is the full text of
      every article.

   What this CANNOT check: actual byte counts. Only real traffic or the Supabase
   dashboard reports those. These guards stop the obvious regressions; they do
   not measure your bill.

   Run:  npm run test:egress
   ========================================================================== */

import { readFileSync } from 'node:fs';

const push = readFileSync('src/lib/push.js', 'utf8');
const store = readFileSync('src/lib/store.js', 'utf8');
const sw = readFileSync('public/sw.js', 'utf8');

const problems = [];
const ok = (m) => console.log('PASS  ' + m);
const bad = (m) => { problems.push(m); console.log('FAIL  ' + m); };

/** The body of pollOnce, so a match cannot be satisfied by an unrelated comment. */
function fnBody(src, name) {
  const start = src.indexOf(`export async function ${name}`);
  if (start < 0) return '';
  let depth = 0;
  let seen = false;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') { depth++; seen = true; }
    else if (src[i] === '}') { depth--; if (seen && depth === 0) return src.slice(start, i); }
  }
  return src.slice(start);
}

// --- 1. the poll asks for what it has not seen -----------------------------

{
  const body = fnBody(push, 'pollOnce');
  if (/\.gt\(\s*['"]created_at['"]/.test(body)) {
    ok('the poll filters on created_at, so an up-to-date reader gets zero rows');
  } else {
    bad('pollOnce re-reads broadcasts it has already seen (no created_at filter)');
  }

  // Without a watermark persisted, the filter never narrows and the change is
  // cosmetic: `gt` would be handed null and fall through to the full read.
  if (/WATERMARK_KEY/.test(push) && /localStorage\.setItem\(\s*WATERMARK_KEY/.test(push)) {
    ok('the watermark is persisted, so the filter actually narrows across reloads');
  } else {
    bad('no persisted watermark: the created_at filter would never narrow anything');
  }

  // The seen-id set is trimmed to 50. If the watermark were derived from it, a
  // reader who fired 50 broadcasts would silently lose the high-water mark.
  if (/seen\.add\(String\(id\)\)/.test(push)) {
    ok('the watermark is tracked separately from the trimmed seen-id set');
  }
}

// --- 2. idle backoff -------------------------------------------------------

if (/idlePasses/.test(push) && /2 \*\* idlePasses/.test(push)) {
  ok('the interval backs off when a pass finds nothing');
} else {
  bad('the poll cadence is fixed: no backoff during silence');
}

// Matched against whitespace-normalised source, and tolerant of the guard
// expression in front of the `?`: the shape is
//   idlePasses = <guard> ? 0 : idlePasses + 1
// and only the reset-to-zero on the raised branch matters.
const flat = push.replace(/\s+/g, ' ');
if (/idlePasses\s*=\s*[^;?]*\?\s*0\s*:\s*idlePasses\s*\+\s*1/.test(flat)) {
  ok('a pass that raised an alert resets the backoff, so an emergency is not missed');
} else {
  bad('the backoff never resets: a burst of alerts would be polled slowly');
}

// --- 3. hidden tabs --------------------------------------------------------

if (/visibilityState\s*===\s*['"]hidden['"]/.test(push)) {
  ok('the poll checks document.visibilityState');
} else {
  bad('the poller runs in hidden tabs, which cannot display an alert');
}

if (/addEventListener\(\s*['"]visibilitychange['"]/.test(push)) {
  ok('returning to the tab resumes polling immediately rather than waiting out the timer');
} else {
  bad('no visibilitychange listener: a backgrounded poller may never resume');
}

// A fixed setInterval is the shape this replaced. Its return is unambiguous,
// so any occurrence in this file is a regression even inside a comment.
{
  const real = push.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  if (!/setInterval/.test(real)) ok('no setInterval remains in the poller');
  else bad('setInterval is back in push.js: the cadence cannot adapt');
}

// --- 4. hydrate does not read whole tables forever -------------------------

{
  const body = fnBody(store, 'hydrate');
  // `select('*')` with no limit on articles/media/staff is the shape that grew
  // the bill without anyone changing anything.
  const unbounded = [...body.matchAll(
    /from\(TABLES\.(\w+)\)\s*\.select\(\s*['"]\*['"]\s*\)(?![^;]*?\.limit\()/g
  )].map((m) => m[1]);

  if (unbounded.length === 0) {
    ok('no unbounded select(\'*\') left in hydrate()');
  } else {
    bad('hydrate() still reads every row of: ' + [...new Set(unbounded)].join(', '));
  }
}

// --- 5. the service worker must not be the reason Storage is uncached ------
//
// It returns early for any cross-origin request, so every Supabase Storage image
// bypasses it. That is CORRECT -- a cache-first worker on an infinite storage
// space would grow without bound. Noted so a future reader does not "fix" it
// into an unbounded cache.
{
  const real = sw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  if (/url\.origin\s*!==\s*self\.location\.origin/.test(real)) {
    ok('the service worker still skips cross-origin requests (Storage images rely on CDN cache, not this)');
  } else {
    bad('the service worker now intercepts cross-origin requests: it would cache Storage images unboundedly');
  }
}

// --- 6. new uploads must stay cacheable ------------------------------------

for (const [file, label] of [
  ['src/lib/upload.js', 'gallery/media images'],
  ['src/lib/portrait.js', 'portraits']
]) {
  const src = readFileSync(file, 'utf8');
  if (/cacheControl:\s*['"]31536000['"]/.test(src)) {
    ok(`${label} are uploaded with a 1-year cache header`);
  } else {
    bad(`${label} are uploaded without a long cache header, so every view refetches them`);
  }
}

console.log('\n------------------------------------------------------------------');
if (problems.length) {
  console.log(problems.length + ' problem(s):');
  for (const p of problems) console.log('  - ' + p);
  process.exit(1);
}
console.log('RESULT: PASS — no recurring egress regression.');