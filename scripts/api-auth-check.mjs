/* =============================================================================
   scripts/api-auth-check.mjs — SERVERLESS AUTH GATE
   -----------------------------------------------------------------------------
   api/send-push.js failed OPEN. `hasSharedSecret()` compared the caller's bearer
   against PUSH_SEND_TOKEN with no non-empty guard, so when that variable was
   unset:

       bearer === PUSH_TOKEN   ->   '' === ''   ->   true

   Any anonymous visitor could POST /api/broadcast and push to every subscriber.
   The docstring claimed the endpoint "refuses the call rather than defaulting to
   open", and the 503 branch that was written for exactly that case was
   unreachable, because the empty comparison matched first.

   This locks down four things that must never regress:

     1. unset token + empty bearer  -> refused (503 send-push, 401 check-deadlines)
     2. wrong token                 -> 401
     3. correct token               -> the auth gate opens
     4. ?token= in the query string -> ignored entirely (header only)

   Run:  npm run test:api-auth
   ========================================================================== */

const problems = [];
const ok = (m) => console.log('PASS  ' + m);
const bad = (m) => { problems.push(m); console.log('FAIL  ' + m); };

import webpush from 'web-push';

const SECRET = 'correct-horse-battery-staple';

let stamp = 0;

/**
 * Env that satisfies send-push.js's own preflight checks.
 *
 * The handler validates SUPABASE_URL/KEY (L245) and calls
 * `webpush.setVapidDetails()` (L256) BEFORE it authenticates (L268), so without
 * these every case here would return 500/no_supabase_env -- or throw on the stub
 * key -- and the auth gate would never be exercised.
 *
 * The VAPID pair is generated for real because setVapidDetails() rejects a key
 * that does not decode to 65 bytes. They are stubs: the paths under test return
 * before any network call, because `isOwnerSession` short-circuits when no
 * x-wire-token is present.
 */
const vapid = webpush.generateVAPIDKeys();

const PREFLIGHT = {
  VITE_SUPABASE_URL: 'https://stub.supabase.invalid',
  VITE_SUPABASE_ANON_KEY: 'stub-anon-key',
  VITE_VAPID_PUBLIC_KEY: vapid.publicKey,
  VAPID_PRIVATE_KEY: vapid.privateKey
};

/**
 * Load a handler with a given environment.
 *
 * PUSH_SEND_TOKEN and CRON_SECRET are read into module-scope consts when the
 * module is first evaluated, so each scenario needs its own module instance. A
 * cache-busting query on the specifier gives a fresh one without re-implementing
 * the ESM loader.
 */
async function load(file, env) {
  for (const key of ['PUSH_SEND_TOKEN', 'CRON_SECRET', 'SUPABASE_SERVICE_ROLE_KEY']) {
    delete process.env[key];
  }
  Object.assign(process.env, PREFLIGHT, env);
  const mod = await import(`../api/${file}?case=${stamp++}`);
  return mod;
}

/** Minimal stand-ins for the Vercel req/res pair. */
function req(headers = {}, url = 'https://example.test/api/send-push') {
  return { method: 'POST', headers, url, body: undefined };
}

function res() {
  const r = { statusCode: 200, body: null, headers: {} };
  r.status = (code) => { r.statusCode = code; return r; };
  r.json = (payload) => { r.body = payload; return r; };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.end = () => r;
  r.write = () => r;
  return r;
}

const bearer = (t) => ({ authorization: `Bearer ${t}` });

// ---------------------------------------------------------------------------
//  1. send-push.js
// ---------------------------------------------------------------------------

console.log('\n--- api/send-push.js -------------------------------------------');

// The bug. Empty bearer, no token configured.
{
  const { default: handler } = await load('send-push.js', {});
  const r = res();
  await handler(req({}), r);

  if (r.statusCode === 503 && r.body?.code === 'push_send_token_unset') {
    ok('unset PUSH_SEND_TOKEN + empty bearer -> 503 push_send_token_unset');
  } else {
    bad(`unset token + empty bearer -> expected 503/push_send_token_unset, got ` +
        `${r.statusCode}/${r.body?.code}`);
  }
}

// An explicitly empty Authorization header is the same case, not a bypass.
{
  const { default: handler } = await load('send-push.js', {});
  const r = res();
  await handler(req({ authorization: 'Bearer ' }), r);

  if (r.statusCode === 503) {
    ok('unset PUSH_SEND_TOKEN + "Bearer " (empty) -> 503, not 401-or-open');
  } else {
    bad(`"Bearer " with token unset -> expected 503, got ${r.statusCode}`);
  }
}

// A token that is only right when nothing is set must not grant access.
{
  const { hasSharedSecret } = await load('send-push.js', {});
  if (hasSharedSecret(req(bearer(''))) === false) {
    ok('hasSharedSecret(empty bearer) is false when PUSH_SEND_TOKEN is unset');
  } else {
    bad('hasSharedSecret returned true for an empty bearer with no token set');
  }
}

{
  const { default: handler } = await load('send-push.js', { PUSH_SEND_TOKEN: SECRET });
  const r = res();
  await handler(req(bearer('wrong-token')), r);

  if (r.statusCode === 401 && r.body?.code === 'unauthorised') {
    ok('wrong token -> 401 unauthorised');
  } else {
    bad(`wrong token -> expected 401/unauthorised, got ${r.statusCode}/${r.body?.code}`);
  }
}

{
  const { hasSharedSecret } = await load('send-push.js', { PUSH_SEND_TOKEN: SECRET });
  if (hasSharedSecret(req(bearer(SECRET))) === true) {
    ok('correct token -> auth gate opens');
  } else {
    bad('hasSharedSecret rejected the correct token');
  }
}

// Prefix / near-miss must not pass.
{
  const { hasSharedSecret } = await load('send-push.js', { PUSH_SEND_TOKEN: SECRET });
  const cases = [[SECRET.slice(0, -1), 'truncated'], [SECRET + 'x', 'extended'], ['CORRECT-HORSE-BATTERY-STAPLE', 'uppercased']];
  let allRejected = true;
  for (const [candidate, label] of cases) {
    if (hasSharedSecret(req(bearer(candidate))) !== false) {
      bad(`a ${label} token was accepted`);
      allRejected = false;
    }
  }
  if (allRejected) ok('truncated / extended / uppercased tokens are all rejected');
}

// The query string is no longer a credential.
{
  const { default: handler } = await load('send-push.js', { PUSH_SEND_TOKEN: SECRET });
  const r = res();
  await handler(req({}, `https://example.test/api/send-push?token=${SECRET}`), r);

  if (r.statusCode === 401) {
    ok('?token=<correct> in the query string is ignored -> 401');
  } else {
    bad(`?token= still authenticates (got ${r.statusCode}) -- it must not`);
  }
}

// ---------------------------------------------------------------------------
//  2. check-deadlines.js
// ---------------------------------------------------------------------------

console.log('\n--- api/check-deadlines.js -------------------------------------');

{
  const { default: handler } = await load('check-deadlines.js', {});
  const r = res();
  await handler(req({}, 'https://example.test/api/check-deadlines'), r);

  if (r.statusCode === 401 && r.body?.code === 'unauthorised') {
    ok('neither secret configured -> 401 unauthorised');
  } else {
    bad(`no secrets -> expected 401/unauthorised, got ${r.statusCode}/${r.body?.code}`);
  }
}

{
  const { default: handler } = await load('check-deadlines.js', { CRON_SECRET: SECRET });
  const r = res();
  await handler(req(bearer('wrong'), 'https://example.test/api/check-deadlines'), r);

  if (r.statusCode === 401) ok('wrong CRON_SECRET -> 401');
  else bad(`wrong CRON_SECRET -> expected 401, got ${r.statusCode}`);
}

{
  const { default: handler } = await load('check-deadlines.js', { CRON_SECRET: SECRET });
  const r = res();
  await handler(req(bearer(SECRET), 'https://example.test/api/check-deadlines'), r);

  // Passing the gate lands on the missing-VAPID check, which is a 500, not a
  // 401/503. That proves authentication succeeded without needing the network.
  if (r.statusCode !== 401 && r.statusCode !== 503) {
    ok(`correct CRON_SECRET -> gate opened (reached ${r.body?.code}, ${r.statusCode})`);
  } else {
    bad(`correct CRON_SECRET was rejected at the auth gate (${r.statusCode})`);
  }
}

{
  const { default: handler } = await load('check-deadlines.js', { PUSH_SEND_TOKEN: SECRET });
  const r = res();
  await handler(req({}, `https://example.test/api/check-deadlines?token=${SECRET}`), r);

  if (r.statusCode === 401) ok('?token= is ignored here too -> 401');
  else bad(`?token= still authenticates check-deadlines (got ${r.statusCode})`);
}

// PUSH_SEND_TOKEN alone must still open the gate -- the push stack uses it.
{
  const { authorised } = await load('check-deadlines.js', { PUSH_SEND_TOKEN: SECRET });
  if (authorised(req(bearer(SECRET))) === true) ok('PUSH_SEND_TOKEN alone opens the gate');
  else bad('PUSH_SEND_TOKEN alone did not open the gate');
}

// ---------------------------------------------------------------------------
//  3. secretMatches in isolation
// ---------------------------------------------------------------------------

console.log('\n--- secretMatches ---------------------------------------------');

{
  const { secretMatches } = await load('send-push.js', { PUSH_SEND_TOKEN: SECRET });
  const cases = [
    ['', '', false, 'both empty'],
    ['', SECRET, false, 'empty candidate'],
    [SECRET, '', false, 'empty expected'],
    [SECRET, SECRET, true, 'exact match'],
    ['wrong', SECRET, false, 'mismatch'],
    ['SECRETT', SECRET, false, 'same prefix, longer']
  ];
  let allOk = true;
  for (const [candidate, expected, want, label] of cases) {
    if (secretMatches(candidate, expected) !== want) {
      bad(`secretMatches ${label}: expected ${want}`);
      allOk = false;
    }
  }
  if (allOk) ok('all 6 secretMatches cases behave, including both-empty -> false');
}

// ---------------------------------------------------------------------------

console.log('\n------------------------------------------------------------------');
if (problems.length) {
  console.log(`${problems.length} problem(s):`);
  for (const p of problems) console.log('  - ' + p);
  process.exit(1);
}
console.log('RESULT: PASS — both endpoints fail closed.');