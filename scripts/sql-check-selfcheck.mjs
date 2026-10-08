/**
 * Mutation-test sql-static-check.mjs against the THREE real failures it exists
 * to catch. Each mutation reintroduces one of the actual mistakes, and the check
 * must FAIL each time. A validator never seen to fail is not known to work.
 */
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';

const TARGET = 'supabase/migrations/033_writer_lockdown.sql';
const CHECK = 'scripts/sql-static-check.mjs';
const BACKUP = process.env.TEMP + '/033.mut.bak';
const CHECK_BACKUP = process.env.TEMP + '/sqlcheck.mut.bak';

copyFileSync(TARGET, BACKUP);
copyFileSync(CHECK, CHECK_BACKUP);

const original = readFileSync(TARGET, 'utf8');

const MUTATIONS = [
  [
    'can_approve() is never declared (the 42883 that started this)',
    (s) => s.replace('create or replace function public.can_approve()', 'create or replace function public.can_approve_typo()')
  ],
  [
    'a trigger function declares an argument (the 42P13)',
    (s) =>
      s.replace(
        'create or replace function public.articles_publish_guard()',
        'create or replace function public.articles_publish_guard(p_table text)'
      )
  ],
  [
    'a comment names a stale signature (the second 42883)',
    (s) =>
      s.replace(
        'comment on function public.wire_approver_scope_guard() is',
        'comment on function public.wire_approver_scope_guard(text) is'
      )
  ]
];

let survived = 0;

for (const [label, mutate] of MUTATIONS) {
  const mutated = mutate(original);
  if (mutated === original) {
    console.log(`  SKIP  ${label} -- the anchor text was not found`);
    survived += 1;
    continue;
  }
  writeFileSync(TARGET, mutated);

  let failed = false;
  try {
    const { execFileSync } = await import('node:child_process');
    execFileSync('node', [CHECK], { stdio: 'pipe' });
  } catch {
    failed = true; // non-zero exit = the check caught it
  }

  console.log(`  ${failed ? 'CAUGHT ' : 'MISSED '} ${label}`);
  if (!failed) survived += 1;
}

copyFileSync(BACKUP, TARGET);
console.log('\nrestored the original file');
console.log(
  readFileSync(TARGET, 'utf8') === original ? 'restore verified byte-for-byte' : 'RESTORE FAILED'
);
process.exit(survived ? 1 : 0);