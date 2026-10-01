/**
 * Repair double-encoded UTF-8 in source files.
 *
 * These are em-dashes and curly quotes that were pasted through a Windows
 * console code page and got saved twice-encoded, so they now read as "a-circumflex
 * euro" instead of the character intended. They are inside comments, so nothing
 * breaks at runtime -- but they are exactly the kind of thing that has turned
 * into mojibake in a Supabase SQL paste before, and they are noise in a diff.
 *
 * Run: node scripts/_fix_mojibake.mjs [file ...]
 * With no arguments it repairs every tracked source file.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// Build the patterns from code points so this file stays pure ASCII and cannot
// itself become the cause of the problem it is fixing.
const EMDASH = String.fromCodePoint(0x00e2, 0x0080, 0x0094);
const ENDASH = String.fromCodePoint(0x00e2, 0x0080, 0x0093);
const LSQUOTE = String.fromCodePoint(0x00e2, 0x0080, 0x0099);
const RSQUOTE = String.fromCodePoint(0x00e2, 0x0080, 0x009d);
const LDQUOTE = String.fromCodePoint(0x00e2, 0x0080, 0x009c);
const RDQUOTE = String.fromCodePoint(0x00e2, 0x0080, 0x009d);
const EACUTE = String.fromCodePoint(0x00c3, 0x00a9);

const REPLACEMENTS = [
  [EMDASH, '--'],
  [ENDASH, '-'],
  [LSQUOTE, "'"],
  [RSQUOTE, "'"],
  [LDQUOTE, '"'],
  [RDQUOTE, '"'],
  [EACUTE, 'e']
];

const SKIP = new Set(['node_modules', '.git', 'dist', '.vercel']);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(js|mjs|css|html|md|sql|json)$/.test(name)) out.push(full);
  }
  return out;
}

const targets = process.argv.length > 2 ? process.argv.slice(2) : walk('.');
let cleaned = 0;

for (const file of targets) {
  const before = readFileSync(file, 'utf8');
  let after = before;
  for (const [bad, good] of REPLACEMENTS) after = after.split(bad).join(good);
  if (after !== before) {
    writeFileSync(file, after, 'utf8');
    cleaned += 1;
    console.log(`cleaned ${relative('.', file)}`);
  }
}

console.log(`${cleaned} file(s) changed.`);