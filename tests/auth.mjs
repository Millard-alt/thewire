/* =============================================================================
   test-auth.mjs - end-to-end auth check against the live database
   -----------------------------------------------------------------------------
   Run:  node test-auth.mjs
   Optional:  node test-auth.mjs <username> <password>

   READ-ONLY by default. It never creates, approves or deletes an account,
   because a signup permanently consumes the Owner seat on an empty database
   and there is no undo without SQL.
   ========================================================================== */

import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

/* --- credentials straight out of .env, never echoed to the console --------- */
const env = Object.fromEntries(
  readFileSync(new URL('./.env', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim() && !line.trim().startsWith('#'))
    .map((line) => {
      const i = line.indexOf('=');
      return [line.slice(0, i).trim(), line.slice(i + 1).trim()];
    })
);

const url = env.VITE_SUPABASE_URL;
const key = env.VITE_SUPABASE_ANON_KEY;

if (!url || !key) {
  console.error('VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY missing from .env');
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { persistSession: false } });

const args = process.argv.slice(2);
const creds = args.filter((a) => !a.startsWith('--'));

let pass = 0;
let fail = 0;
let ownerToken = null;

function report(label, ok, detail = '') {
  if (ok) {
    pass++;
    console.log(`  PASS  ${label}${detail ? '  (' + detail + ')' : ''}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}${detail ? '  (' + detail + ')' : ''}`);
  }
}

/** Call a Postgres function, returning the {data, error} envelope. */
async function call(fn, args = {}) {
  const { data, error } = await supabase.rpc(fn, args);
  return { data, error };
}

/**
 * Same, but presented as a signed-in Owner. The Owner-only RPCs
 * (wire_list_accounts, wire_reject_account, ...) re-check authorisation on the
 * server, so a probe that needs them must send a real Owner token or it will
 * only ever measure the refusal path.
 */
async function callAs(token, fn, args = {}) {
  const client = createClient(url, key, {
    auth: { persistSession: false },
    global: {
      headers: { apikey: key },
      fetch: (input, init = {}) => {
        const headers = new Headers(init.headers || {});
        headers.set('x-wire-token', token);
        return fetch(input, { ...init, headers });
      }
    }
  });
  const { data, error } = await client.rpc(fn, args);
  return { data, error };
}

/* --- 1. every function the client calls must exist ------------------------ */
console.log('\n== 1. Required database functions ==');

// Print the deployed build stamp first. If the database reports an older stamp
// than this file expects, a failing test below is explained by a migration
// that never took effect - not by broken application code.
const EXPECTED_STAMP = 'stage2-v3-pending-signin-allowed';
const { data: stamp, error: stampErr } = await call('wire_credentials_version');
if (stampErr) {
  console.log('  ----  No version stamp - supabase/credentials.sql has not been');
  console.log('        re-run since the stamp was added. Re-run it.');
} else if (stamp === EXPECTED_STAMP) {
  pass++;
  console.log(`  PASS  deployed build is current  (${stamp})`);
} else {
  console.log(`  ----  STALE DATABASE. reports "${stamp}",`);
  console.log(`        expected "${EXPECTED_STAMP}".`);
  console.log('        Re-run supabase/credentials.sql in the SQL Editor.');
}
const REQUIRED = [
  'wire_is_unclaimed',
  'wire_login',
  'wire_request_account',
  'wire_sign_out',
  'wire_list_accounts',
  'wire_approve_account',
  'wire_reject_account',
  'wire_set_password',
  'wire_session_diagnostic'
];
const ZERO = '00000000-0000-0000-0000-000000000000';
for (const fn of REQUIRED) {
  // Probe with blank/zero args. A raised domain error ("Incorrect username or
  // password", "Not authorised") proves the function resolved. A
  // "Could not find the function" error proves it was never deployed.
  let error;
  if (fn === 'wire_login') error = (await call(fn, { p_username: '__probe__', p_password: '__probe__' })).error;
  // Every parameterless-looking probe MUST supply the real arity, otherwise
  // PostgREST answers "Could not find the function ... without parameters" and
  // the check falsely reports the function as never deployed.
  else if (fn === 'wire_request_account')
    error = (await call(fn, { p_username: '__probe__', p_display_name: 'probe', p_password: 'probe-pass-123' })).error;
  else if (fn === 'wire_reject_account') error = (await call(fn, { p_id: ZERO })).error;
  else if (fn === 'wire_approve_account') error = (await call(fn, { p_id: ZERO, p_role: 'Editor' })).error;
  else if (fn === 'wire_set_password') error = (await call(fn, { p_id: ZERO, p_password: 'x' })).error;
  else error = (await call(fn)).error;

  const msg = error?.message || 'present';
  const missing = /Could not find the function|does not exist/i.test(msg);
  const stale = /schema cache/i.test(msg);
  report(
    fn,
    !missing,
    missing ? 'MISSING' : stale ? 'STALE CACHE - reload Supabase' : msg.slice(0, 58)
  );
}

/* --- 2. the owner seat ---------------------------------------------------- */
console.log('\n== 2. Owner seat ==');
const { data: unclaimed, error: uErr } = await call('wire_is_unclaimed');
if (uErr) {
  report('wire_is_unclaimed reachable', false, uErr.message);
} else if (unclaimed === true) {
  // The only genuinely noteworthy state: nobody has claimed Owner yet.
  console.log('  WARN  No accounts exist. The next signup becomes Owner.');
  console.log('        Until then nobody can sign in.');
} else {
  // Accounts existing is the NORMAL steady state, not a defect. Reporting it as
  // a failure made a healthy newsroom look broken.
  console.log('  OK    Accounts already exist, so the Owner seat is claimed.');
  console.log('        New signups arrive PENDING and cannot do anything until the');
  console.log('        Owner approves them and assigns a role.');
  console.log('        To start over, run supabase/000_reset_accounts.sql.');
}

/* --- 3. signed-out safety ------------------------------------------------- */
console.log('\n== 3. Signed-out safety ==');
{
  const { data, error } = await call('wire_list_accounts');
  // Owner-gated: must refuse, and must not leak any rows.
  const refused = /Not authorised|not authorised/i.test(error?.message || '');
  report('wire_list_accounts refuses anon', refused, error ? 'refused (correct)' : 'RETURNED DATA - LEAK');
  if (!refused && Array.isArray(data)) report('no rows leaked', data.length === 0, `${data.length} rows`);
}

/* --- 4. real credentials, if supplied ------------------------------------ */
if (creds.length === 2) {
  console.log('\n== 4. Live login ==');
  const [username, password] = creds;
  const { data, error } = await call('wire_login', { p_username: username, p_password: password });

  if (error) {
    report(`login as "${username}"`, false, error.message.slice(0, 70));
    if (/Incorrect username or password/i.test(error.message)) {
      console.log('        -> That username + password combination is not valid.');
    }
    if (/waiting for the Owner/i.test(error.message)) {
      console.log('        -> The account EXISTS but is PENDING approval.');
      console.log('        -> Sign in as the Owner and approve it, or run 000_reset_accounts.sql.');
    }
  } else {
    report(`login as "${username}"`, true, `role=${data.role} owner=${data.is_owner}`);

    // Kept for section 5: the pending-applicant probe has to clean up after
    // itself through an Owner-only RPC. Declared outside this block so the
    // later section can reach it.
    ownerToken = data.token;

    // Prove the whole session chain resolves with that token. The browser sends
    // it as the x-wire-token header, so mirror that exactly rather than trying
    // to poke at the client's internal header bag.
    const client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: {
        headers: { apikey: key },
        fetch: (input, init = {}) => {
          const headers = new Headers(init.headers || {});
          headers.set('x-wire-token', data.token);
          return fetch(input, { ...init, headers });
        }
      }
    });
    const { data: accounts, error: aErr } = await client.rpc('wire_list_accounts');
    report(
      'token resolves to the account',
      !aErr && Array.isArray(accounts) && accounts.length > 0,
      aErr ? aErr.message : `${accounts?.length ?? 0} account(s) visible`
    );
    if (Array.isArray(accounts)) {
      // Mirror src/lib/auth.js exactly: prefer the is_me flag, and fall back to
      // matching the caller's own id when the deployed function predates the
      // flag. Asserting the flag alone would report a failure the app does not
      // actually suffer from.
      const flagged = accounts.find((r) => r.is_me);
      const me = flagged || accounts.find((r) => r.id === data.id);
      report(
        'current account identified in roster',
        Boolean(me) && me.username === data.username,
        me
          ? `${me.username} via ${flagged ? 'is_me flag' : 'id fallback'}`
          : 'no row matched the signed-in account'
      );
      if (!flagged) {
        console.log(
          '  NOTE  deployed wire_list_accounts() has no is_me column; the client\n' +
            '        falls back to matching by account id, which is verified above.\n' +
            '        Re-run supabase/credentials.sql to deploy the newer version.'
        );
      }
    }

    // Negative control: the same call WITHOUT the token must be refused.
    const anonClient = createClient(url, key, { auth: { persistSession: false } });
    const { error: anonErr } = await anonClient.rpc('wire_list_accounts');
    report(
      'same call without the token is refused',
      Boolean(anonErr),
      anonErr ? 'refused (correct)' : 'RETURNED DATA - LEAK'
    );

    // Negative control: a garbage token must not authenticate anything.
    const badClient = createClient(url, key, {
      auth: { persistSession: false },
      global: {
        fetch: (input, init = {}) => {
          const headers = new Headers(init.headers || {});
          headers.set('x-wire-token', 'not-a-real-token');
          return fetch(input, { ...init, headers });
        }
      }
    });
    const { error: badErr } = await badClient.rpc('wire_list_accounts');
    report(
      'forged token is rejected',
      Boolean(badErr),
      badErr ? 'rejected (correct)' : 'ACCEPTED A FORGED TOKEN - LEAK'
    );

    // Unknown user must not authenticate.
    const bad = await call('wire_login', {
      p_username: '__nobody__',
      p_password: 'wrongpassword'
    });
    report(
      'unknown user rejected',
      /Incorrect username or password/i.test(bad.error?.message || ''),
      (bad.error?.message || 'NO ERROR - log in succeeded!').slice(0, 60)
    );
  }
} else {
  console.log('\n== 4. Live login ==');
  console.log('  skipped. Run:  node test-auth.mjs <username> <password>');
}

/* --- 5. pending applicant can sign in but has zero access ------------------ */
// The rule you asked for: a signup that is not the Owner lands in a pending
// state where it can sign in, see that it is waiting, and touch nothing else.
// This proves the SQL half. The UI half is src/app.js + src/views/auth.js.
if (creds.length === 2) {
  console.log('\n== 5. Pending applicant isolation ==');
  // Must satisfy the same rule a real applicant does: 3-32 chars of
  // letters, digits, dot, dash, underscore -- no leading punctuation.
  const handle = `probe${Date.now().toString(36)}`;
  const { error: reqErr } = await call('wire_request_account', {
    p_username: handle,
    p_display_name: 'Probe Applicant',
    p_password: 'probe-password-1'
  });
  if (reqErr) {
    report('applicant can request an account', false, reqErr.message.slice(0, 60));
  } else {
    report('applicant can request an account', true, `created ${handle}`);

    // It must be able to sign in, so it can see that it is waiting.
    const { data: pData, error: pErr } = await call('wire_login', {
      p_username: handle,
      p_password: 'probe-password-1'
    });
    report(
      'pending applicant can sign in',
      !pErr && pData?.status === 'pending',
      pErr ? pErr.message.slice(0, 60) : `status=${pData?.status}`
    );

    if (pData?.token) {
      // ...and must be refused by every privileged surface.
      const pClient = createClient(url, key, {
        auth: { persistSession: false },
        global: {
          fetch: (input, init = {}) => {
            const headers = new Headers(init.headers || {});
            headers.set('x-wire-token', pData.token);
            return fetch(input, { ...init, headers });
          }
        }
      });
      const { data: sData, error: sErr } = await pClient.rpc('is_staff');
      report(
        'pending applicant is not staff',
        Boolean(sErr) || sData === false,
        sErr ? 'denied (correct)' : sData === false ? 'returns false (correct)' : 'GRANTED STAFF - HOLE'
      );
      const { data: lData, error: lErr } = await pClient.rpc('wire_list_accounts');
      report(
        'pending applicant cannot read the roster',
        Boolean(lErr) || !Array.isArray(lData) || lData.length === 0,
        lErr ? 'denied (correct)' : Array.isArray(lData) ? `READ ${lData.length} ROWS - LEAK` : 'no data'
      );
    }

    // Tidy up: the probe must not linger and consume the real newsroom.
    // Needs the Owner token, because wire_reject_account is Owner-only, and the
    // account id rather than the username -- the function's parameter is p_id.
    const { data: roster } = await callAs(ownerToken, 'wire_list_accounts');
    const mine = (Array.isArray(roster) ? roster : []).find((r) => r.username === handle);
    const { error: rejErr } = mine
      ? await callAs(ownerToken, 'wire_reject_account', { p_id: mine.id })
      : { error: { message: 'probe not found in roster' } };
    console.log(
      `  ----  probe ${handle} ${rejErr ? 'NOT removed: ' + rejErr.message.slice(0, 50) : 'rejected (cleaned up)'} ----`
    );
    if (rejErr) {
      console.log('        Run supabase/000_reset_accounts.sql, or reject it in the Owner panel.');
    }
  }
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

