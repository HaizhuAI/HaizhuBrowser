'use strict';
// make-icon.js — SDF-renders the Haizhu line-mark (pillar + twin waves)
// onto a navy squircle and emits resources/icon.png + icon.ico. Pure Node.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const S = 512;               // render size
const buf = new Float32Array(S * S * 4); // rgba float

// signed-distance helpers
const sdSeg = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax, dy = by - ay;
  const h = Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + dx * h), py - (ay + dy * h));
};
const sdSquircle = (px, py, cx, cy, r, n) => {
  // superellipse-ish squircle via rounded-rect sdf
  const qx = Math.abs(px - cx) - (r - n), qy = Math.abs(py - cy) - (r - n);
  const ax = Math.max(qx, 0), ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - n;
};
const sdWave = (px, py, cx, cy, half, amp, per) => {
  // distance to sine curve sampled as capsules
  let d = 1e9, prevX = cx - half, prevY = cy + amp * Math.sin(0);
  const N = 40;
  for (let i = 1; i <= N; i++) {
    const t = i / N, x = cx - half + 2 * half * t;
    const y = cy + amp * Math.sin(t * Math.PI * 2 * per + Math.PI); // start low
    d = Math.min(d, sdSeg(px, py, prevX, prevY, x, y));
    prevX = x; prevY = y;
  }
  return d;
};

const lerp = (a, b, t) => a + (b - a) * t;
const mix = (c1, c2, t) => [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];

const top = [0x1f, 0x86, 0xe8];   // bright ocean blue
const bot = [0x0b, 0x2e, 0x66];   // deep navy
const ink = [0xff, 0xff, 0xff];

for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4;
    const px = x + .5, py = y + .5;
    // squircle bg w/ vertical gradient + subtle radial lift
    const dBg = sdSquircle(px, py, 256, 256, 232, 74);
    const gT = Math.min(1, Math.max(0, (py - 40) / 430));
    let col = mix(top, bot, gT);
    // radial sheen
    const lift = Math.max(0, 1 - Math.hypot(px - 190, py - 120) / 520) * 0.16;
    col = col.map(c => Math.min(255, c + 255 * lift * (1 - gT)));
    let a = Math.min(1, Math.max(0, -dBg + 0.7));

    // line art — uniform stroke width 26px (viewBox scale ~2.9/48*512)
    const w = 13; // half-width
    const strokes = Math.min(
      sdSeg(px, py, 256, 118, 256, 394),                       // pillar
      Math.min(
        sdWave(px, py, 256, 224, 124, 26, 1.0),                // upper wave
        sdWave(px, py, 256, 320, 124, 26, 1.0)                 // lower wave
      )
    );
    const sa = Math.min(1, Math.max(0, w - strokes + 0.7));
    // composite: white strokes over bg
    const A = a + sa * (1 - a);
    buf[i]     = (col[0] * a * (1 - sa) + ink[0] * sa) / (A || 1);
    buf[i + 1] = (col[1] * a * (1 - sa) + ink[1] * sa) / (A || 1);
    buf[i + 2] = (col[2] * a * (1 - sa) + ink[2] * sa) / (A || 1);
    buf[i + 3] = A * 255;
  }
}

// downsample 512 -> 256 (box filter)
const D = 256;
const out = Buffer.alloc(D * D * 4);
for (let y = 0; y < D; y++) for (let x = 0; x < D; x++) {
  let r = 0, g = 0, b = 0, a = 0;
  for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
    const si = ((y * 2 + dy) * S + x * 2 + dx) * 4;
    r += buf[si]; g += buf[si + 1]; b += buf[si + 2]; a += buf[si + 3];
  }
  const di = (y * D + x) * 4;
  out[di] = r / 4; out[di + 1] = g / 4; out[di + 2] = b / 4; out[di + 3] = a / 4;
}

// PNG encode
function pngEncode(rgba, w, h) {
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const idat = zlib.deflateSync(raw);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(td) : crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))
  ]);
}
// fallback crc32 table (node<20 lacks zlib.crc32)
let _tbl = null;
function crc32(b) {
  if (!_tbl) {
    _tbl = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; _tbl[n] = c >>> 0; }
  }
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = _tbl[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const png = pngEncode(out, D, D);
const dir = path.join(__dirname, '..', 'resources');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'icon.png'), png);

// ICO: 1 image, PNG-compressed (Vista+)
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4);
const entry = Buffer.alloc(16);
entry[0] = 0; entry[1] = 0; entry[2] = 0; entry[3] = 0;          // w,h(0=256),colors,reserved
entry.writeUInt16LE(1, 4); entry.writeUInt16LE(32, 6);          // planes, bpp
entry.writeUInt32LE(png.length, 8); entry.writeUInt32LE(22, 12);
fs.writeFileSync(path.join(dir, 'icon.ico'), Buffer.concat([header, entry, png]));

console.log('icon.png + icon.ico written', png.length, 'bytes');
