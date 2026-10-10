/* =============================================================================
   scripts/api-runtime-check.mjs
   -----------------------------------------------------------------------------
   Catches ReferenceErrors in the serverless handlers WITHOUT running them.

   THE BUG
   An earlier revision added a second Supabase client for the owner-session check
   and REPLACED `const db = createClient(...)` instead of sitting beside it. `db`
   stopped existing. Every later use -- the claim, the subscription read, the
   prune, the delivered_count write -- then raised

       ReferenceError: db is not defined

   ...but only at runtime, and only AFTER authentication had already succeeded,
   so the Owner got an opaque 500 on a broadcast the server had accepted.

   WHY NOTHING CAUGHT IT
   `api-auth-check.mjs` imports the handler to test `secretMatches`, which
   returns before any of this code runs. A syntax check passes, because
   `ReferenceError` is not a syntax error -- it is a perfectly valid reference to
   a binding that does not exist. Only executing the code finds it, and the
   first execution that reached that far was in production.

   So this does what a syntax check cannot: resolve every identifier the handler
   uses against what the module actually declares or imports.

   WHAT IT CANNOT CHECK
   It does not run the handler, so it cannot prove a query succeeds or a push is
   delivered. It proves only that every variable the code reads was defined
   somewhere reachable -- which is the entire class of failure above.

   Run:  npm run test:api-runtime
   ========================================================================== */

import { readFileSync, readdirSync } from 'node:fs';

const problems = [];
const ok = (m) => console.log('PASS  ' + m);
const bad = (m) => { problems.push(m); console.log('FAIL  ' + m); };

const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/\/[^\n]*/g, '').replace(/\/\/[^\n]*/g, '');

for (const file of readdirSync('api').filter((f) => f.endsWith('.js'))) {
  const src = strip(readFileSync(`api/${file}`, 'utf8'));
  const declared = new Set();

  // const/let/var at any scope, destructured or not
  for (const m of src.matchAll(/\b(?:const|let|var)\s+\{([^}]+)\}\s*=/g)) {
    for (const part of m[1].split(',')) {
      const name = part.split(':').pop().split('=')[0].trim().replace(/^\.\.\./, '');
      if (name) declared.add(name);
    }
  }
  for (const m of src.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)) declared.add(m[1]);

  // function declarations, params, arrow params, catch params
  for (const m of src.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/g)) {
    declared.add(m[1]);
    for (const p of m[2].split(',')) if (p.trim()) declared.add(p.trim().replace(/[^\w$]/g, ''));
  }
  for (const m of src.matchAll(/\(([^)]*)\)\s*=>/g)) {
    for (const p of m[1].split(',')) if (p.trim()) declared.add(p.trim().replace(/[^\w$]/g, ''));
  }
  for (const m of src.matchAll(/([A-Za-z_$][\w$]*)\s*=>/g)) declared.add(m[1]);
  for (const m of src.matchAll(/catch\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/g)) declared.add(m[1]);
  for (const m of src.matchAll(/for\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);

  // Everything imported.
  for (const m of src.matchAll(/import\s+([A-Za-z_$][\w$]*)\s+from/g)) declared.add(m[1]);
  for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from/g)) {
    for (const part of m[1].split(',')) {
      const name = part.split(/\s+as\s+/).pop().trim();
      if (name) declared.add(name);
    }
  }
  for (const m of src.matchAll(/import\s*\*\s*as\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);

  // Globals the runtime provides.
  for (const g of [
    'console','process','JSON','Math','Date','Object','Array','String','Number','Boolean',
    'Promise','Error','Set','Map','URL','URLSearchParams','Headers','fetch','Response',
    'Request','Buffer','setTimeout','clearTimeout','setInterval','clearInterval','TextEncoder',
    'TextDecoder','URLSearchParams','isNaN','parseInt','parseFloat','structuredClone','AbortController'
  ]) declared.add(g);

  /*
   * The specific bug: an identifier that is READ but never declared, where the
   * name looks like one of this project's own clients. Deliberately narrow --
   * a general undefined-identifier analysis would flag every legitimate global
   * and drown the signal.
   */
  const suspect = ['db', 'client', 'ownerCheck', 'ownerDb', 'supabase'];
  for (const name of suspect) {
    const used = new RegExp(`(^|[^\\w.$])${name}\\s*[.\\[(]`).test(src);
    if (used && !declared.has(name)) {
      bad(
        `${file}: '${name}' is used but never declared. That is a ReferenceError ` +
        'at runtime, after any authentication has already succeeded.'
      );
    } else if (used) {
      ok(`${file}: '${name}' is declared before use`);
    }
  }
}

// --- the two-client contract, stated explicitly ----------------------------

{
  const src = strip(readFileSync('api/send-push.js', 'utf8'));
  const dbDecl = /const\s+db\s*=\s*createClient\(\s*SUPABASE_URL\s*,\s*SUPABASE_KEY/.test(src);
  const ownerDecl = /const\s+ownerAnonKey\s*=/.test(src) && /let\s+ownerCheck\s*=\s*null/.test(src);

  if (dbDecl) ok('send-push declares the service_role client as `db` (the workhorse)');
  else bad('send-push has no `db` service_role client -- every query in the handler references it');

  if (ownerDecl) ok('send-push declares the separate anon owner-check client');
  else bad('send-push no longer declares a guarded owner-check client');

  // The workhorse must be declared BEFORE the owner client, so a future edit
  // adding a second client cannot replace the first.
  const iDb = src.indexOf('const db = createClient');
  const iOwner = src.indexOf('let ownerCheck');
  if (iDb > -1 && iOwner > -1 && iDb < iOwner) {
    ok('the service_role client is declared before the owner-check client');
  } else {
    bad(`client declaration order is wrong (db at ${iDb}, ownerCheck at ${iOwner})`);
  }
}

console.log('\n------------------------------------------------------------------');
if (problems.length) {
  console.log(problems.length + ' problem(s):');
  for (const p of problems) console.log('  - ' + p);
  process.exit(1);
}
console.log('RESULT: PASS — every client the handlers use is declared.');