/* =============================================================================
   scripts/api-env-check.mjs
   -----------------------------------------------------------------------------
   A MISSING ENV VAR MUST SAY SO, NOT RETURN 500.

   `createClient(url, '')` throws SYNCHRONOUSLY -- "supabaseKey is required" --
   before it returns, so it cannot be caught by a try/catch around the request
   handling and does not even reach the handler. Vercel reports it as a bare
   HTTP 500 with no code and no detail.

   That is exactly what happened: an unset VITE_SUPABASE_ANON_KEY made the
   Owner's broadcast fail with `500` and the client had nothing to report, after
   the previous commit had already fixed the 401 that preceded it. Two rounds of
   production debugging for one missing setting, because the error said nothing
   about which setting was missing.

   So: every createClient in api/ must be preceded by a guard, and every one
   must have a named code a caller can act on.

   Run:  npm run test:api-env
   ========================================================================== */

import { readFileSync, readdirSync } from 'node:fs';

const problems = [];
const ok = (m) => console.log('PASS  ' + m);
const bad = (m) => { problems.push(m); console.log('FAIL  ' + m); };

const files = readdirSync('api').filter((f) => f.endsWith('.js'));
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/\/[^\n]*/g, '').replace(/\/\/[^\n]*/g, '');

for (const file of files) {
  const src = code(readFileSync(`api/${file}`, 'utf8'));
  const clients = [...src.matchAll(/createClient\(/g)];
  if (clients.length === 0) continue;

  for (const c of clients) {
    const line = src.slice(0, c.index).split('\n').length;
    const before = src.slice(Math.max(0, c.index - 1200), c.index);

    // A createClient whose key argument can be '' must be preceded by a truthy
    // check on that same variable.
    const guarded =
      /if\s*\(\s*!\w*(KEY|URL)\w*\s*(\|\|\s*!\w*(KEY|URL)\w*\s*)*\)/.test(before) ||
      /if\s*\(\s*ownerAnonKey\s*\)/.test(before) ||
      /&&\s*ownerAnonKey/.test(before) ||
      /if\s*\(\s*\w+\s*\)\s*\{[\s\S]{0,400}createClient/.test(before);

    if (guarded) {
      ok(`${file}:${line} createClient is preceded by a guard`);
    } else {
      bad(
        `${file}:${line} createClient has no preceding guard -- if its key is ` +
        'unset, createClient throws synchronously and Vercel returns a bare 500'
      );
    }
  }
}

// --- the specific 500 that started this -------------------------------------

{
  const src = code(readFileSync('api/send-push.js', 'utf8'));

  if (/ownerAnonKey\s*=\s*process\.env\.VITE_SUPABASE_ANON_KEY/.test(src)) {
    ok('the owner-check anon key is read into a variable first');
  } else {
    bad('the owner-check key is still inlined into createClient, so an empty key throws');
  }

  if (!/createClient\(\s*SUPABASE_URL\s*,\s*ownerAnonKey/.test(src)) {
    bad('createClient still receives a possibly-empty literal rather than the guarded variable');
  } else {
    ok('createClient receives the validated key');
  }

  // A missing setting is a 503 with a code, not a 401 that sends the Owner
  // hunting for a session problem they do not have.
  if (/owner_check_unavailable/.test(src)) {
    ok('a missing anon key reports its own code (owner_check_unavailable)');
  } else {
    bad('no owner_check_unavailable code: a missing setting will read as "unauthorised"');
  }

  if (/503[\s\S]{0,200}owner_check_unavailable/.test(src) || /owner_check_unavailable/.test(src)) {
    ok('the misconfiguration is reported as 503, which means "not ready" rather than "forbidden"');
  }
}

// --- the Owner panel must be able to read that code ------------------------

{
  const src = code(readFileSync('src/views/admin.js', 'utf8'));
  // dispatchWebPush passes data.code through as `reason`, so the panel receives
  // it. Without an entry in the fallback map the Owner reads the generic "The
  // push sender could not deliver this" and learns nothing -- which is the whole
  // point of sending a specific code.
  if (/owner_check_unavailable/.test(src)) {
    ok('the panel explains owner_check_unavailable in terms the Owner can act on');
  } else {
    bad(
      'the panel has no message for owner_check_unavailable, so the new code ' +
      'would be reported as the generic "could not deliver"'
    );
  }

  if (/no_vapid_key/.test(src) && /unauthorised/.test(src)) {
    ok('the panel still maps the pre-existing sender codes');
  } else {
    bad('the panel no longer maps sender codes');
  }
}

console.log('\n------------------------------------------------------------------');
if (problems.length) {
  console.log(problems.length + ' problem(s):');
  for (const p of problems) console.log('  - ' + p);
  process.exit(1);
}
console.log('RESULT: PASS — a missing setting names itself instead of returning a bare 500.');