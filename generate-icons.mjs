/**
 * generate-icons.mjs — one-off build helper.
 *
 * Produces the PWA icon set in public/icons/ without pulling in an image
 * library: a newsprint-red field with a white "W" and a gold rule, drawn
 * procedurally and encoded as PNG with Node's built-in zlib.
 *
 * Run with:  node generate-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), 'public', 'icons');

/* Brand colours, mirrored from the @theme tokens in src/styles.css */
const NEWSRED = [0x8c, 0x1d, 0x11];
const PAPER = [0xf7, 0xf4, 0xec];
const GOLD = [0xe0, 0xa9, 0x1b];

/** CRC-32, required for every PNG chunk. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = -1;
  for (let i = 0; i < buffer.length; i++) {
    c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** Encode an RGB pixel buffer (w*h*3) as a PNG. */
function encodePng(width, height, rgb) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour RGB
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // Each scanline is prefixed with a filter byte (0 = None).
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/**
 * Draw the icon.
 * @param {number} size   edge length in pixels
 * @param {boolean} maskable  when true, shrink the artwork into the 80% safe
 *                            zone so Android can crop it to any shape
 */
function drawIcon(size, maskable) {
  const rgb = Buffer.alloc(size * size * 3);

  // Background: full-bleed red for a maskable icon, inset paper for a normal
  // one so it reads as a masthead rather than a plain red square.
  const bg = maskable ? NEWSRED : PAPER;
  for (let i = 0; i < size * size; i++) {
    rgb[i * 3] = bg[0];
    rgb[i * 3 + 1] = bg[1];
    rgb[i * 3 + 2] = bg[2];
  }

  const put = (x, y, colour) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 3;
    rgb[i] = colour[0];
    rgb[i + 1] = colour[1];
    rgb[i + 2] = colour[2];
  };
  const rect = (x0, y0, w, h, colour) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) put(x, y, colour);
  };

  // A "W" built from four slanted strokes.
  const scale = maskable ? 0.56 : 0.78;
  const glyph = Math.round(size * scale);
  const ox = Math.round((size - glyph) / 2);
  const oy = Math.round((size - glyph) / 2);
  const stroke = Math.max(2, Math.round(glyph * 0.13));
  const ink = maskable ? PAPER : NEWSRED;

  // Four strokes: down, up, down, up. Each is drawn as a thick line between two
  // points using a simple distance test so the edges stay smooth at any size.
  const pts = [
    [0.02, 0.06],
    [0.28, 0.94],
    [0.5, 0.3],
    [0.72, 0.94],
    [0.98, 0.06]
  ].map(([px, py]) => [ox + px * glyph, oy + py * glyph]);

  const half = stroke / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      for (const [ax, ay, bx, by] of pts.slice(0, -1).map((p, i) => [p[0], p[1], pts[i + 1][0], pts[i + 1][1]])) {
        const dx = bx - ax;
        const dy = by - ay;
        const lenSq = dx * dx + dy * dy;
        let t = lenSq === 0 ? 0 : ((x - ax) * dx + (y - ay) * dy) / lenSq;
        t = Math.max(0, Math.min(1, t));
        const cx = ax + t * dx;
        const cy = ay + t * dy;
        if ((x - cx) ** 2 + (y - cy) ** 2 <= half * half) {
          put(x, y, ink);
          break;
        }
      }
    }
  }

  // Gold rule beneath the wordmark.
  const ruleY = Math.round(oy + glyph * 1.04);
  const ruleW = Math.round(glyph * 0.92);
  rect(Math.round((size - ruleW) / 2), ruleY, ruleW, Math.max(2, Math.round(size * 0.018)), GOLD);

  return encodePng(size, size, rgb);
}

mkdirSync(OUT_DIR, { recursive: true });

const targets = [
  ['icon-192.png', 192, false],
  ['icon-512.png', 512, false],
  ['icon-maskable-512.png', 512, true]
];

for (const [name, size, maskable] of targets) {
  const file = join(OUT_DIR, name);
  writeFileSync(file, drawIcon(size, maskable));
  console.log(`wrote ${name} (${size}x${size})`);
}
