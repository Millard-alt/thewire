/* =============================================================================
   scripts/podcast-delete-guard-check.mjs
   -----------------------------------------------------------------------------
   A DELETE that matches no rows is SUCCESS, not failure.

   That is not a quirk, it is how row level security works: policies FILTER the
   rows a statement may touch, and a statement touching none of them has done
   nothing and committed cleanly. Only INSERT raises, because WITH CHECK is
   evaluated against the proposed row.

   For years that meant a Board Manager could click "Refuse" on a Writer's
   pending episode and be told "Submission refused and its audio purged" while
   the episode stayed live -- because podcasts_delete was is_owner() only, so
   the DELETE silently removed nothing. The panel emptied the queue from local
   cache, so it looked like it had worked, and the row reappeared on the next
   repaint. Migration 038 grants the authority; this checks the CLIENT.

   The guard is `.select('id')` on the delete, which turns "no error" into
   evidence: a filtered delete returns zero rows, a real one returns the row.
   A source assertion is enough for that, because the failure this is guarding
   against is precisely the absence of the check -- a regex can prove the guard
   is present, and only the live database (see migration-apply-check.mjs) can
   prove the policies behave.

   Run:  npm run test:podcast-delete-guard
   ========================================================================== */

import { readFileSync } from 'node:fs';

const src = readFileSync('src/lib/podcasts.js', 'utf8');

const problems = [];
const ok = (m) => console.log('PASS  ' + m);
const bad = (m) => { problems.push(m); console.log('FAIL  ' + m); };

// --- 1. the guard itself ----------------------------------------------------

// \s* rather than literal dots between the chain: prettier may break the chain
// across lines, and a check that only passes on one formatting is a check that
// will fail the day somebody reformats the file.
if (/\.delete\(\)\s*\.eq\(\s*'id'\s*,\s*id\s*\)\s*\.select\(/.test(src)) {
  ok('the delete is followed by .select() -- a filtered delete is distinguishable');
} else {
  bad('no .select() after .delete(): a zero-row delete is reported as success');
}

// --- 2. the guard is USED, not merely present ------------------------------

if (/function deletePodcastRow/.test(src)) {
  ok('deletePodcastRow() exists');
} else {
  bad('deletePodcastRow() is missing -- the assertion is not shared');
}

const callers = src.match(/await deletePodcastRow\(/g) || [];
if (callers.length >= 2) {
  ok(`both delete paths go through deletePodcastRow() (${callers.length} call sites)`);
} else {
  bad(`only ${callers.length} call site(s) use the guard; a bare .delete() remains`);
}

// A bare delete left anywhere is the exact defect. This is the check that would
// have caught the original bug, because the original bug WAS a bare delete.
{
  const bare = [...src.matchAll(/\.from\(\s*'podcasts'\s*\)\s*\.delete\(\)(?!\s*\.eq)/g)];
  if (bare.length === 0) ok('no unasserted .delete() on the podcasts table remains');
  else bad(`found ${bare.length} .delete() call(s) with no assertion on the result`);
}

// --- 3. a zero-row delete must not read as success --------------------------

if (/Array\.isArray\(data\)\s*\|\|\s*data\.length\s*===\s*0/.test(src)) {
  ok('an empty result set is treated as a failure');
} else {
  bad('an empty result set is not checked -- the guard returns ok for zero rows');
}

if (/ok:\s*false[\s\S]{0,220}not removed/.test(src)) {
  ok('the refusal message says the row was NOT removed, rather than claiming success');
} else {
  bad('no honest failure message for a refused delete');
}

// --- 4. neither caller may swallow it --------------------------------------

{
  // Each caller must propagate the failure rather than carry on to the storage
  // purge. Purging audio for a row that still exists is how an episode loses
  // its recording while remaining published.
  const bodies = src.split(/export async function (?:decidePodcast|deletePodcast)\b/);
  const leaky = bodies.slice(1).filter((b) => {
    const usesGuard = /deletePodcastRow/.test(b);
    const ignores = /await deletePodcastRow\([^)]*\);/.test(b);
    return usesGuard && ignores && !/if \(\s*!\w+\.ok\s*\)/.test(b);
  });
  if (leaky.length === 0) ok('every caller checks the guard before continuing');
  else bad('a caller ignores the guard result and carries on to purge storage anyway');
}

// --- 5. migration 038 must exist, or the guard reports failures forever ----

if (readFileSync('supabase/migrations/038_approver_can_refuse_a_pending_episode.sql', 'utf8')
    .includes('can_approve()')) {
  ok('038 exists, so the guard is a safety net rather than a permanent error');
} else {
  bad('038 is missing -- the approver has no authority, so every refuse will now fail loudly');
}

console.log('\n------------------------------------------------------------------');
if (problems.length) {
  console.log(problems.length + ' problem(s):');
  for (const p of problems) console.log('  - ' + p);
  process.exit(1);
}
console.log('RESULT: PASS — a refused delete can no longer report success.');