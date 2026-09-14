// Generates the test media: a 1733x2011 "screenshot" with a 1-pixel checker
// (any resampling shows up instantly) and a 6 s stereo WAV.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DIR = join(dirname(fileURLToPath(import.meta.url)), '.tmp');

const crcT = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();
const crc = (b) => {
  let c = 0xffffffff;
  for (const x of b) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
}
function png(w, h, pixel) {
  const raw = Buffer.alloc(h * (w * 4 + 1));
  let o = 0;
  for (let y = 0; y < h; y++) {
    raw[o++] = 0;
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = pixel(x, y);
      raw[o++] = r; raw[o++] = g; raw[o++] = b; raw[o++] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** The colour this generator puts at source pixel (x, y). */
export const shotPixel = (x, y) => {
  if (y < 60) return [40, 90, 220];
  const cell = (x + y) % 2 ? 235 : 20;
  return [cell, cell, x % 256];
};

/**
 * A stand-in screenshot: dark panel, 1-pixel rules, and rows of bright stems
 * with irregular spacing standing in for text. The point is the spectrum —
 * high-contrast detail a pixel or two wide, which is what crawls when an image
 * is translated by a fraction of a pixel. The checker in shot.png cannot stand
 * in for it: at exactly one pixel it sits on Nyquist, where no resampling has
 * any stable answer and everything collapses to flat grey.
 */
export const uiPixel = (x, y) => {
  if (y % 28 === 4 && x > 40 && x < 860) return [58, 63, 79];   // hairline rule
  const row = Math.floor(y / 28);
  const band = y % 28;
  if (band >= 9 && band <= 21 && x > 55 && x < 845) {
    // A per-row LCG so the stems are irregular the way glyphs are.
    let h = (x * 1103515245 + row * 12345) >>> 0;
    h = (h >>> 16) & 0xff;
    if (h < 90) return [232, 234, 242];
  }
  return [20, 22, 28];
};

export function build() {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(join(DIR, 'ui.png'), png(900, 900, (x, y) => [...uiPixel(x, y), 255]));
  writeFileSync(join(DIR, 'shot.png'), png(1733, 2011, (x, y) => [...shotPixel(x, y), 255]));
  writeFileSync(join(DIR, 'small.png'), png(320, 200, (x, y) => [((x * 255) / 320) | 0, ((y * 255) / 200) | 0, 128, 255]));

  const sr = 48000, dur = 6, n = sr * dur, ch = 2;
  const buf = Buffer.alloc(44 + n * ch * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(buf.length - 8, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(ch, 22);
  buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * ch * 2, 28);
  buf.writeUInt16LE(ch * 2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * ch * 2, 40);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const v = 0.45 * Math.sin(2 * Math.PI * (120 + (900 * t) / dur) * t)
      + 0.35 * Math.exp(-((t * 4) % 1) * 6) * Math.sin(2 * Math.PI * 55 * t);
    const s = (Math.max(-1, Math.min(1, v)) * 32767) | 0;
    buf.writeInt16LE(s, 44 + i * 4);
    buf.writeInt16LE(s, 46 + i * 4);
  }
  writeFileSync(join(DIR, 'tone.wav'), buf);

  // The same media spread over two folders, for the relink checks: one file per
  // folder is exactly the case a single multi-file picker cannot cover, and the
  // copy is renamed so matching cannot lean on a byte-identical filename.
  mkdirSync(join(DIR, 'folderA'), { recursive: true });
  mkdirSync(join(DIR, 'folderB'), { recursive: true });
  copyFileSync(join(DIR, 'shot.png'), join(DIR, 'folderA', 'Shot.png'));
  copyFileSync(join(DIR, 'tone.wav'), join(DIR, 'folderB', 'tone.wav'));
  return DIR;
}

if (import.meta.url === `file://${process.argv[1]}`) console.log('fixtures ->', build());
