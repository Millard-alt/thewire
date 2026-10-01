/**
 * scripts/check-encoding.mjs — verify tracked text files are clean UTF-8.
 *
 * WHY THE EARLIER TWO SCRIPTS WERE BOTH WRONG
 *
 * 1. scripts/_encoding_check.mjs searched for literal mojibake strings. It
 *    matched nothing and reported the tree clean, so it could not tell a real
 *    problem from a clean one.
 *
 * 2. scripts/_fix_mojibake.mjs "repaired" files with
 *    Buffer.from(text, 'latin1'). It DESTROYED seven good files, turning a
 *    correct U+2014 em dash into U+0014 and a middle dot in the site tagline
 *    into a bare double quote. Reverted with `git checkout`.
 *
 * 3. This file, when it first ran, reported three files as broken purely
 *    because the PowerShell CONSOLE rendered a correct U+2014 as the three
 *    characters U+0393 U+00C7 U+00F6. That output looks identical to real
 *    mojibake. Treating console output as evidence about file CONTENT is what
 *    started the whole mess.
 *
 * WHY THIS VERSION IS DIFFERENT
 * It never prints file text. It inspects bytes and reports U+XXXX codepoint
 * NUMBERS, which the console cannot mis-render. That immediately showed the
 * tree was fine except for one genuine defect in src/views/alerts.js.
 *
 * It also knows the correct decoder. The real damage is Windows-1252, not
 * Latin-1: a left double quote is three bytes E2 80 9C, and reading those as
 * CP1252 yields U+00E2 U+20AC U+0153. Mapping those
 * back through CP1252 gives the bytes E2 80 9C, which decode as UTF-8 to a
 * proper left double quote U+201C. A Latin-1 pass maps U+20AC to 0x80 by
 * luck but U+0153 to nothing at all, which is why attempt 2 silently failed.
 *
 * It repairs nothing unless --fix is passed, and even then only for strings
 * that decode cleanly.
 *
 *   node scripts/check-encoding.mjs          report only
 *   node scripts/check-encoding.mjs --fix    repair CP1252 mojibake
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const FIX = process.argv.includes('--fix');

/**
 * The Windows-1252 characters that occupy bytes 0x80-0x9F. Everything outside
 * this range is identical to Latin-1, which is why the rest is handled inline.
 */
const CP1252_HIGH = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85,
  0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a,
  0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92,
  0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
  0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c,
  0x017e: 0x9e, 0x0178: 0x9f
};

/**
 * Reverse a Windows-1252 round trip: take the wrongly-decoded text and recover
 * the original bytes.
 *
 * @param {string} text  text that was decoded as CP1252 instead of UTF-8
 * @returns {Buffer|null} the recovered bytes, or null if any character has no
 *   CP1252 byte (which means the text was never mojibake)
 */
function undoCp1252(text) {
  const bytes = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp <= 0xff) {
      bytes.push(cp);
    } else if (CP1252_HIGH[cp] !== undefined) {
      bytes.push(CP1252_HIGH[cp]);
    } else {
      return null;
    }
  }
  return Buffer.from(bytes);
}

/** True when `buf` starts with a UTF-8 byte order mark. */
const isBom = (buf) => buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;

/** C1 control range: 0x80-0x9F. Legitimate text almost never contains these. */
const isC1 = (cp) => cp >= 0x80 && cp <= 0x9f;

const targets = execSync('git ls-files', { encoding: 'utf8' })
  .split(/\r?\n/)
  .filter((f) => /\.(js|mjs|css|html|md|json|sql)$/i.test(f));

const problems = [];

for (const file of targets) {
  let buf;
  try {
    buf = readFileSync(file);
  } catch {
    continue;
  }

  // Read the BOM off the decoded string, not just the byte array.
  // buf.toString('utf8') keeps it as a U+FEFF character, so writing the decoded
  // text straight back re-emits the BOM as three UTF-8 bytes and the file never
  // actually changes. Every fix has to start from a BOM-free string.
  const bom = isBom(buf);
  const text = (bom ? buf.toString('utf8').replace(/^\uFEFF/, '') : buf.toString('utf8'));

  const found = new Set();
  let replacement = 0;
  if (bom) found.add(0xfeff);
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === 0xfffd) {
      replacement += 1;
      found.add(0xfffd);
    } else if (isC1(cp)) {
      found.add(cp);
    }
  }

  if (!found.size) continue;

  const report = { file, bom, replacement, found };

  if (FIX) {
    // Repair only the spans that contain a C1 control, so legitimate Unicode
    // elsewhere in the file (em dashes, curly quotes typed correctly) is never
    // touched. Anything else must survive the round trip unchanged.
    const repaired = text.replace(
      /[\u0080-\u009f\u00e2\u00e3\u00c2\u00c3][\s\S]*?[\u0093\u0094\u009d]/g,
      (span) => {
        const bytes = undoCp1252(span);
        if (!bytes) return span;
        const back = bytes.toString('utf8');
        // Refuse a "repair" that still contains a replacement character.
        return back.includes('\uFFFD') ? span : back;
      }
    );

    const after = [...repaired].filter((c) => isC1(c.codePointAt(0)));
    const out = Buffer.from(repaired, 'utf8');

    // Write when either defect shrank. A BOM-only file has no C1 controls to
    // reduce, so keying the write on C1 alone left BOMs permanently unrepairable
    // and the --fix pass silently did nothing.
    const c1Before = [...text].filter((c) => isC1(c.codePointAt(0))).length;
    const improved = bom || after.length < c1Before;

    if (improved) {
      // Drop the BOM rather than re-prepending it: it is never wanted, and the
      // task brief requires SQL pasted into the Supabase editor to be BOM-free.
      writeFileSync(file, out);
      report.fixed = true;
      report.remaining = after.length;
    }
  }

  problems.push(report);
}

if (!problems.length) {
  console.log(`OK - ${targets.length} file(s): valid UTF-8, no BOM, no C1 controls.`);
  process.exit(0);
}

console.log(`${problems.length} file(s) need attention (codepoints, not rendered text):\n`);
for (const p of problems) {
  console.log(`  ${p.file}`);
  console.log(
    `     bom=${p.bom} invalidUtf8=${p.replacement} ` +
      `codepoints=${[...p.found].sort((a, b) => a - b).map((c) => 'U+' + c.toString(16).toUpperCase().padStart(4, '0')).join(' ')}`
  );
  if (p.fixed) console.log(`     -> fixed, ${p.remaining} C1 control(s) remaining`);
}

if (!FIX) console.log('\nRun with --fix to repair CP1252 mojibake.');
process.exit(FIX && problems.every((p) => p.fixed) ? 0 : 1);