// Draws the app and tray icons (two usage bars on a dark tile) and writes them as PNG files.
// Run with `npm run icon`; the generated files are committed, so this is only needed after design changes.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const BACKGROUND = [0x1c, 0x1c, 0x21];
const TRACK = [0x3f, 0x3f, 0x46];
const GRADIENT = [
  [0x22, 0xc5, 0x5e],
  [0xfa, 0xcc, 0x15],
  [0xef, 0x44, 0x44],
];
const SUBSAMPLES = 4;

function gradientAt(t) {
  const clamped = Math.min(1, Math.max(0, t));
  const [from, to, local] = clamped <= 0.5 ? [GRADIENT[0], GRADIENT[1], clamped * 2] : [GRADIENT[1], GRADIENT[2], (clamped - 0.5) * 2];
  return from.map((channel, index) => channel + (to[index] - channel) * local);
}

function inRoundedRect(x, y, x0, y0, x1, y1, radius) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const dx = Math.max(x0 + radius - x, 0, x - (x1 - radius));
  const dy = Math.max(y0 + radius - y, 0, y - (y1 - radius));
  return dx * dx + dy * dy <= radius * radius;
}

/** Returns RGBA pixels for a square icon of `size` pixels. Small (tray) icons use bolder bars. */
function renderIcon(size, { bold }) {
  const margin = bold ? 0 : size * 0.04;
  const tileRadius = size * (bold ? 0.18 : 0.2);
  const thickness = size * (bold ? 0.2 : 0.15);
  const barStart = size * (bold ? 0.16 : 0.2);
  const barEnd = size - barStart;
  const bars = [
    { center: size * (bold ? 0.34 : 0.37), fill: 0.8 },
    { center: size * (bold ? 0.66 : 0.63), fill: 0.45 },
  ];

  const pixels = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SUBSAMPLES; sy++) {
        for (let sx = 0; sx < SUBSAMPLES; sx++) {
          const x = px + (sx + 0.5) / SUBSAMPLES;
          const y = py + (sy + 0.5) / SUBSAMPLES;
          if (!inRoundedRect(x, y, margin, margin, size - margin, size - margin, tileRadius)) continue;
          let color = BACKGROUND;
          for (const bar of bars) {
            const y0 = bar.center - thickness / 2;
            const y1 = bar.center + thickness / 2;
            const fillEnd = barStart + (barEnd - barStart) * bar.fill;
            if (inRoundedRect(x, y, barStart, y0, fillEnd, y1, thickness / 2)) {
              color = gradientAt((x - barStart) / (barEnd - barStart));
            } else if (inRoundedRect(x, y, barStart, y0, barEnd, y1, thickness / 2)) {
              color = TRACK;
            }
          }
          r += color[0];
          g += color[1];
          b += color[2];
          a += 1;
        }
      }
      const offset = (py * size + px) * 4;
      if (a > 0) {
        pixels[offset] = Math.round(r / a);
        pixels[offset + 1] = Math.round(g / a);
        pixels[offset + 2] = Math.round(b / a);
      }
      pixels[offset + 3] = Math.round((a / (SUBSAMPLES * SUBSAMPLES)) * 255);
    }
  }
  return pixels;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

function encodePng(size, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // color type: RGBA
  const rows = [];
  for (let y = 0; y < size; y++) {
    rows.push(Buffer.from([0]), pixels.subarray(y * size * 4, (y + 1) * size * 4));
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const outputs = [
  { file: 'build/icon.png', size: 256, bold: false },
  { file: 'src/assets/icon.png', size: 256, bold: false },
  { file: 'src/assets/tray.png', size: 16, bold: true },
  { file: 'src/assets/tray@1.5x.png', size: 24, bold: true },
  { file: 'src/assets/tray@2x.png', size: 32, bold: true },
];

for (const { file, size, bold } of outputs) {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, encodePng(size, renderIcon(size, { bold })));
  console.log(`Wrote ${file} (${size}x${size})`);
}
