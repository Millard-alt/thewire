#!/usr/bin/env node
/* Static guard against the costliest bug class in this project: DRIFT between
   the client and the SQL, where nothing compares them.
     - wire_set_credits sent p_visible/p_note while the function took
       p_is_visible/p_note_text. PostgREST ignores keys it does not know, so the
       call SUCCEEDED and the value was silently dropped.
     - wire_register_device asked for a field the table did not have.
     - Three functions existed but were never GRANTed to anon.
   This parses every client rpc('name', {args}) and every SQL
   create function name(params) and reports any mismatch.
   It cannot see grants, RLS, or what is deployed live -- for that see
   supabase/016_grant_owner_panel_rpcs.sql.
   Pure file reading. No network, no database. */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';

const SRC = 'src';
const SQL = 'supabase';
const MIGRATIONS = join(SQL, 'migrations');

function jsFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...jsFiles(full));
    else if (extname(e.name) === '.js') out.push(full);
  }
  return out;
}

// Read from an opening bracket at `start` to its match. null if unbalanced or
// mismatched -- refuse to guess rather than return a plausible wrong span.
function balanced(text, start) {
  const close = { '(': ')', '[': ']', '{': '}' }[text[start]];
  if (!close) return null;
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    const c = text[i];
    if ('{(['.includes(c)) depth += 1;
    else if ('})]'.includes(c)) {
      depth -= 1;
      if (depth === 0) return c === close ? text.slice(start + 1, i) : null;
    }
  }
  return null;
}

function splitTop(text, sep) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if ('{(['.includes(c)) depth += 1;
    else if ('})]'.includes(c)) depth -= 1;
    else if (c === sep && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/* name -> Set(lower param names). Later files supersede earlier ones. */
const defs = new Map();

/*
 * supabase/migrations/ is scanned too, and it has to be.
 *
 * The newest migrations live there, so reading only the top level meant every
 * function defined in migrations/ was invisible here: the checker could not
 * confirm a client's argument names against it, and it reported "OK" for calls
 * it had never actually looked at. That is the worst failure mode for a guard --
 * silently passing on the half of the schema that is newest.
 *
 * Files are visited in name order across both directories so a later definition
 * still supersedes an earlier one (`defs.set` is last-write-wins).
 */
const sqlFiles = [
  ...readdirSync(SQL)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => join(SQL, f)),
  ...(existsSync(MIGRATIONS)
    ? readdirSync(MIGRATIONS)
        .filter((f) => f.endsWith('.sql'))
        .sort()
        .map((f) => join(MIGRATIONS, f))
    : [])
];

for (const path of sqlFiles) {
  const file = path;
  const text = readFileSync(path, 'utf8');
  // Allow an optional schema qualifier. `create or replace function
  // public.wire_login(` is the form used throughout supabase/, and without the
  // `(?:[a-z0-9_]+\.)?` the name captured was just "public" -- which then failed
  // the following `\s*\(` and matched nothing at all, reporting 0 functions.
  const re =
    /create\s+(?:or\s+replace\s+)?function\s+(?:[a-z0-9_]+\.)?([a-z0-9_]+)\s*\(/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const params = balanced(text, re.lastIndex - 1);
    if (params === null) continue;
    const args = new Set();
    for (const part of splitTop(params, ',')) {
      const ident = part
        .trim()
        .replace(/^(in|out|inout)\s+/i, '')
        .match(/^([a-z0-9_]+)/i);
      if (ident) args.add(ident[1].toLowerCase());
    }
    defs.set(m[1].toLowerCase(), { args, file });
  }
}

/* name -> Map(file -> Set(args sent)) */
const calls = new Map();

for (const file of jsFiles(SRC)) {
  const text = readFileSync(file, 'utf8');
  const re = /\.rpc\(\s*['"]([a-z0-9_]+)['"]\s*,\s*\{/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const obj = balanced(text, re.lastIndex - 1);
    if (obj === null) continue;

    // Top-level keys only: `p_a: 1, p_b: fn(x, y)` must not pick up nested keys.
    const args = new Set();
    let depth = 0;
    let expectKey = true;
    for (let i = 0; i < obj.length; i += 1) {
      const c = obj[i];
      if ('{(['.includes(c)) depth += 1;
      else if ('})]'.includes(c)) depth -= 1;
      else if (c === ',') {
        if (depth === 0) expectKey = true;
      } else if (expectKey && depth === 0) {
        const id = obj.slice(i).match(/^([A-Za-z0-9_]+)\s*:/);
        if (id) {
          args.add(id[1].toLowerCase());
          i += id[1].length;
          expectKey = false;
        } else if (!/\s/.test(c)) expectKey = false;
      }
    }

    const name = m[1].toLowerCase();
    if (!calls.has(name)) calls.set(name, new Map());
    if (!calls.get(name).has(file)) calls.get(name).set(file, new Set());
    for (const a of args) calls.get(name).get(file).add(a);
  }
}

const problems = [];

for (const [name, perFile] of calls) {
  const def = defs.get(name);
  if (!def) {
    problems.push(
      `UNKNOWN RPC  ${name}()` +
        `\n             no "create or replace function ${name}" anywhere in ${SQL}/` +
        `\n             called from: ${[...perFile.keys()].join(', ')}`
    );
    continue;
  }
  for (const [file, sent] of perFile) {
    for (const arg of sent) {
      if (def.args.has(arg)) continue;
      problems.push(
        `BAD ARG      ${name}() does not take "${arg}"` +
          `\n             ${file}` +
          `\n             declares: ${[...def.args].sort().join(', ') || '(none)'}`
      );
    }
  }
}

console.log(
  `Checked ${calls.size} client rpc() call(s) against ${defs.size} SQL function(s).\n`
);

if (problems.length) {
  console.log(`${problems.length} CONTRACT PROBLEM(S):\n`);
  for (const p of problems) console.log(`  ${p}\n`);
  console.log(
    'PostgREST ignores argument keys it does not recognise, so a BAD ARG fails\n' +
      'SILENTLY: the call returns OK and the value is discarded.'
  );
  process.exit(1);
}

console.log('OK - every client rpc() matches a SQL definition and its argument names.');