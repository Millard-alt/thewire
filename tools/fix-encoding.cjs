// One-off repair: some source files were saved with UTF-8 bytes decoded as
// Windows-1252, so an em dash landed on disk as three mojibake characters.
// Swap those exact mis-encoded sequences back to the intended characters.
//
// All patterns are built from code points so this script stays pure ASCII and
// cannot itself be corrupted by an editor's encoding guess.
const fs = require('fs');

/** Rebuild the classic mojibake for a single Unicode code point. */
function mojibake(codePoint) {
  const utf8 = Buffer.from(String.fromCodePoint(codePoint), 'utf8');
  // Windows-1252 remaps 0x80-0x9F; fall back to the identity byte for the rest.
  const CP1252 = {
    0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026,
    0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160,
    0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019,
    0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
    0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153,
    0x9e: 0x017e, 0x9f: 0x0178
  };
  return Buffer.from(
    Array.from(utf8).map((byte) => CP1252[byte] ?? byte)
  ).toString('utf8');
}

/** Code points worth repairing: punctuation plus Latin-1 letters. */
const TARGETS = [
  0x2014, 0x2013, 0x2018, 0x2019, 0x201c, 0x201d, 0x2026, 0x2022, 0x2030,
  0x2039, 0x203a, 0x2122, 0x00b0, 0x00ab, 0x00bb, 0x2032, 0x2033,
  0x00e0, 0x00e1, 0x00e2, 0x00e3, 0x00e4, 0x00e5, 0x00e6, 0x00e7, 0x00e8,
  0x00e9, 0x00ea, 0x00eb, 0x00ec, 0x00ed, 0x00ee, 0x00ef, 0x00f1, 0x00f2,
  0x00f3, 0x00f4, 0x00f6, 0x00f9, 0x00fa, 0x00fc, 0x0153, 0x0152, 0x0160,
  0x0161, 0x017d, 0x017e, 0x0178, 0x00c6, 0x00e6, 0x00c2
];

for (const file of process.argv.slice(2)) {
  const original = fs.readFileSync(file, 'utf8');
  let text = original;
  let count = 0;

  for (const codePoint of TARGETS) {
    const broken = mojibake(codePoint);
    if (broken === String.fromCodePoint(codePoint)) continue;
    const parts = text.split(broken);
    if (parts.length > 1) {
      count += parts.length - 1;
      text = parts.join(String.fromCodePoint(codePoint));
    }
  }

  if (count > 0) {
    fs.writeFileSync(file, text, 'utf8');
    console.log(`repaired ${file} (${count} sequences)`);
  } else {
    console.log(`clean    ${file}`);
  }
}
