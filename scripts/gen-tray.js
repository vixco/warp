// Generates the tray icons (lightning bolt) as PNGs without external deps.
// Run once: node scripts/gen-tray.js  -> assets/tray*.png
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(buf) {
  let c, table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Lightning bolt polygon in a 16x16 box
const BOLT = [[9.5, 0.5], [3.0, 9.0], [6.8, 9.0], [5.5, 15.5], [12.8, 6.5], [8.8, 6.5]];

function inPoly(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function render(size, color, ss = 4) {
  const [r, g, b] = color;
  const buf = Buffer.alloc(size * size * 4);
  const scale = 16 / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hit = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const px = (x + (sx + 0.5) / ss) * scale;
          const py = (y + (sy + 0.5) / ss) * scale;
          if (inPoly(px, py, BOLT)) hit++;
        }
      }
      const a = Math.round((hit / (ss * ss)) * 255);
      const o = (y * size + x) * 4;
      buf[o] = r; buf[o + 1] = g; buf[o + 2] = b; buf[o + 3] = a;
    }
  }
  return buf;
}

const out = path.join(__dirname, '..', 'assets');
fs.mkdirSync(out, { recursive: true });
// macOS template icons: pure black, alpha defines shape (system recolors them)
fs.writeFileSync(path.join(out, 'trayTemplate.png'), png(16, 16, render(16, [0, 0, 0])));
fs.writeFileSync(path.join(out, 'trayTemplate@2x.png'), png(32, 32, render(32, [0, 0, 0])));
// Windows tray: brand blue
fs.writeFileSync(path.join(out, 'tray.png'), png(16, 16, render(16, [79, 124, 255])));
fs.writeFileSync(path.join(out, 'tray@2x.png'), png(32, 32, render(32, [79, 124, 255])));
console.log('gen-tray: wrote assets/tray*.png');
