/**
 * Verify the changelog entry renders the way it was intended to.
 *
 * CHANGELOG.md is imported raw at build time and parsed by src/lib/changelog.js,
 * so an entry that reads correctly in an editor can still be dropped or
 * mis-ordered by the parser. This runs the real parser over the real file.
 *
 *   node scripts/changelog-check.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// The parser imports the .md through a Vite `?raw` suffix, which plain node
// cannot do. Read and evaluate the module with a tiny loader instead of
// duplicating its logic, so this checks the REAL parser rather than a copy that
// can drift from it.
//
// `export` is stripped because the body is handed to `new Function`, which is not
// a module. Everything else is left exactly as written.
const modulePath = join('src', 'lib', 'changelog.js');
let source = readFileSync(modulePath, 'utf8');
source = source
  .replace("import source from '../../CHANGELOG.md?raw';", 'const source = __md;')
  .replace(/^export\s+/gm, '');

const md = readFileSync('CHANGELOG.md', 'utf8');
const mod = new Function(
  '__md',
  `${source}\nreturn { getReleases, getPending, pendingCount, sectionIcon };`
);
const { getReleases, getPending, sectionIcon } = mod(md);

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) {
    pass += 1;
    console.log(`PASS  ${name}`);
  } else {
    fail += 1;
    console.log(`FAIL  ${name}${detail ? `  -- ${detail}` : ''}`);
  }
};

const releases = getReleases();
const pending = getPending();

console.log('--- structure ---');
check('CHANGELOG.md parses into releases', releases.length > 0, `${releases.length}`);
check('an [Unreleased] block exists', Boolean(pending), 'the Owner acts on this one');
check(
  'releases are newest first',
  releases[0]?.version === 'Unreleased',
  `first is ${releases[0]?.version}`
);
check('a dated release still exists', releases.some((r) => /\d+\.\d+\.\d+/.test(r.version)));

console.log('\n--- the Unreleased sections ---');
for (const s of pending?.sections || []) {
  console.log(`  ${s.title}  (${s.items.length} item(s), icon ${sectionIcon(s.title)})`);
}

const titles = (pending?.sections || []).map((s) => s.title);
console.log('');
check(
  'every section has items (a heading with none is dropped silently)',
  (pending?.sections || []).every((s) => s.items.length > 0),
  JSON.stringify(titles)
);
check(
  'each section kind appears EXACTLY once',
  new Set(titles.map((t) => t.replace(/\s+[-\u2013\u2014]\s+.*$/, ''))).size === titles.length,
  `repeated headings render as repeated blocks in the panel: ${JSON.stringify(titles)}`
);
check(
  'Pending sits directly after Applied',
  titles[0] === 'Applied' && titles[1].startsWith('Pending'),
  `order was ${JSON.stringify(titles)}`
);
check(
  'Pending gets the hourglass icon, not the generic fallback',
  sectionIcon('Pending — required before these features work') === 'fa-hourglass-half',
  `got ${sectionIcon('Pending — required before these features work')}`
);
check(
  'the order is Applied, Pending, Added, Changed, Fixed, Security',
  JSON.stringify(titles.map((t) => t.replace(/\s+[-\u2013\u2014]\s+.*$/, ''))) ===
    JSON.stringify(['Applied', 'Pending', 'Added', 'Changed', 'Fixed', 'Security']),
  JSON.stringify(titles)
);
check(
  'no section icon falls back to the generic dot',
  (pending?.sections || []).every((s) => sectionIcon(s.title) !== 'fa-circle-dot'),
  (pending?.sections || []).filter((s) => sectionIcon(s.title) === 'fa-circle-dot').map((s) => s.title).join(', ')
);

console.log('\n--- content spot-checks ---');
const allItems = (pending?.sections || []).flatMap((s) => s.items);
const blob = allItems.join('\n');

for (const [label, needle] of [
  ['the service_role key exposure', 'bypasses every row-level security policy'],
  ['the anon-role root cause', 'PostgREST therefore resolves every'],
  ['the missing author_account_id', 'neither** insert'],
  ['the backtick parse failure', 'stopped the whole admin module'],
  ['the nav overflow', '295px'],
  ['the one-row-one-page consequence', 'two rows'],
  ['the migration run order warning', 'do not\n  re-run `024`']
]) {
  check(`${label} is recorded`, blob.includes(needle.replace(/\n\s*/g, ' ')) || blob.includes(needle), needle);
}

check(
  'the pending section names both migrations',
  /028_page_scopes\.sql/.test(blob) && /029_podcast_role_gates\.sql/.test(blob)
);
check(
  'the key rotation is stated as still required',
  /must still be rotated/i.test(blob)
);

console.log('\n--- wrapped lines joined, not split into fragments ---');
check(
  'no item is a bare continuation fragment',
  allItems.every((i) => i.length > 25),
  allItems.filter((i) => i.length <= 25).slice(0, 3).join(' | ')
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);