// One-off icon generator. Run locally, commit the output bytes:
//
//   node scripts/gen-icons.mjs
//
// Deliberately NOT wired into `next build`. Committed binaries make the icon
// content immune to sharp/librsvg version drift, and Google's one hard favicon
// rule is that the URL — and, in spirit, what it serves — stays stable.
//
// Source of truth is public/icon.svg. Everything else here is derived.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const SVG = readFileSync(join(PUBLIC, 'icon.svg'));

// The rounded corners are transparent in the source. Browser tabs and Google's
// SERP both composite that fine, but iOS masks apple-touch-icon itself and
// renders any alpha as black — so those get flattened onto the amber.
const AMBER = '#f59e0b';

const render = (size, { opaque = false } = {}) => {
  let pipe = sharp(SVG, { density: 512 }).resize(size, size);
  if (opaque) pipe = pipe.flatten({ background: AMBER });
  return pipe.png({ compressionLevel: 9 }).toBuffer();
};

/**
 * Assemble a multi-size .ico with PNG payloads. Supported by every browser
 * since IE/Vista and by Google's image pipeline, and it avoids pulling in an
 * ICO encoder dependency for ~25 lines of buffer work.
 */
function buildIco(pngs) {
  const ICONDIR = 6;
  const ICONDIRENTRY = 16;
  const header = Buffer.alloc(ICONDIR);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: 1 = icon
  header.writeUInt16LE(pngs.length, 4);

  let offset = ICONDIR + ICONDIRENTRY * pngs.length;
  const entries = pngs.map(({ size, data }) => {
    const e = Buffer.alloc(ICONDIRENTRY);
    e.writeUInt8(size >= 256 ? 0 : size, 0); // 0 means 256
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2); // palette colors
    e.writeUInt8(0, 3); // reserved
    e.writeUInt16LE(1, 4); // color planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    return e;
  });

  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]);
}

const icoSizes = [16, 32, 48];
const pngs = await Promise.all(
  icoSizes.map(async (size) => ({ size, data: await render(size) })),
);
writeFileSync(join(PUBLIC, 'favicon.ico'), buildIco(pngs));

const rasters = [
  ['apple-touch-icon.png', 180],
  ['icon-192.png', 192],
  ['icon-512.png', 512],
];
for (const [name, size] of rasters) {
  writeFileSync(join(PUBLIC, name), await render(size, { opaque: true }));
}

// Report ink coverage at the size Google actually renders in a results row.
// The amber tile is what makes the icon visible against a white SERP; the
// chevron just has to survive at ~2px stroke.
const { data, info } = await sharp(SVG, { density: 512 })
  .resize(16, 16)
  .flatten({ background: '#ffffff' })
  .raw()
  .toBuffer({ resolveWithObject: true });

const hist = new Map();
for (let i = 0; i < data.length; i += info.channels) {
  const key = `${data[i]},${data[i + 1]},${data[i + 2]}`;
  hist.set(key, (hist.get(key) ?? 0) + 1);
}
const total = info.width * info.height;
console.log('16x16 coverage (composited on white):');
for (const [rgb, n] of [...hist].sort((a, b) => b[1] - a[1]).slice(0, 4)) {
  console.log(`  ${rgb.padEnd(14)} ${((100 * n) / total).toFixed(1)}%`);
}
console.log('\nwrote favicon.ico, ' + rasters.map(([n]) => n).join(', '));
