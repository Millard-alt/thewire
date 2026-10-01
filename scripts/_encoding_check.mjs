// Throwaway integrity check. Verifies every modified file is still valid UTF-8,
// has no BOM, and contains no mojibake sequences.
//
// This exists because a bulk PowerShell rename (Get-Content -Raw / WriteAllText)
// silently double-encoded every em dash and curly quote in the files it touched
// on Windows PowerShell 5.1, which reads text using the system code page rather
// than UTF-8. The corruption was caught only because this check existed. Bulk
// text edits in this repo must be done from Node.

import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

// See scripts/_strip_bom.mjs. A BOM is invisible but real: Vite treats those
// bytes as part of the first token, so the file-opening comment stops being the
// first line. Cosmetic, but cheap to remove.
const bomTarget = 'src/views/auth.js';
const bomBuf = readFileSync(bomTarget);
if (bomBuf[0] === 0xef && bomBuf[1] === 0xbb && bomBuf[2] === 0xbf) {
  writeFileSync(bomTarget, bomBuf.subarray(3));
  console.log(`stripped BOM from ${bomTarget}\n`);
}

const files = execSync('git diff --name-only', { encoding: 'utf8' })
  .split('\n')
  .map((s) => s.trim())
  .filter(Boolean)
  .filter((f) => /\.(js|mjs|css|html|json|md)$/.test(f));

let bad = 0;
for (const file of files) {
  const buf = readFileSync(file);
  const bom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  const text = buf.toString('utf8');
  // U+FFFD means the bytes were not valid UTF-8.
  const replacement = (text.match(/\uFFFD/g) || []).length;
  // Double-encoded sequences: the tell-tale of a code-page round trip. The
  // patterns are built from code points so this file stays pure ASCII and
  // cannot itself become a source of mojibake.
  const EMDASH = String.fromCodePoint(0x00e2, 0x0080, 0x0094);
  const EACUTE = String.fromCodePoint(0x00c3, 0x00a9);
  const NBSP = String.fromCodePoint(0x00c2, 0x00a0);
  const mojibake = (text.match(new RegExp(`${EMDASH}|${EACUTE}|${NBSP}|Â `, 'g')) || [])
    .length;
  const failed = bom || replacement || mojibake;
  if (failed) bad += 1;

  // Only a NEW problem counts. If the committed file already had it, it is
  // pre-existing and not something this change introduced.
  let preexisting = '';
  if (failed) {
    try {
      const head = execSync(`git show HEAD:${file}`, { encoding: 'utf8', maxBuffer: 1 << 28 });
      const headBom = execSync(`git show HEAD:${file}`, { maxBuffer: 1 << 28 })[0] === 0xef;
      const headMoji = (head.match(/â€|e|Ã¢|Â /g) || []).length;
      if (headBom === bom && headMoji === mojibake) preexisting = '  (PRE-EXISTING in HEAD)';
    } catch {
      /* new file, nothing to compare */
    }
  }
  console.log(
    `${(failed ? 'FAIL' : 'ok').padEnd(4)} bom=${bom} repl=${replacement} moji=${mojibake}  ${file}${preexisting}`
  );
}
console.log(bad ? `\n${bad} FILE(S) flagged` : '\nAll files clean UTF-8, no BOM.');
process.exit(bad ? 1 : 0);