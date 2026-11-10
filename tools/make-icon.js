'use strict';
// make-icon.js — SDF-renders the Haizhu line-mark (pillar + twin tapered
// waves) onto a diagonal navy->cyan squircle. Pure Node, no deps.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const S = 512;
const buf = new Float32Array(S * S * 4);

const sdSeg = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax, dy = by - ay;
  const h = Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + dx * h), py - (ay + dy * h));
};
const sdSquircle = (px, py, cx, cy, r, n) => {
  const qx = Math.abs(px - cx) - (r - n), qy = Math.abs(py - cy) - (r - n);
  const ax = Math.max(qx, 0), ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - n;
};
// tapered sine wave: distance to curve minus variable half-width.
// half-width swells in the middle and pinches at the ends (brush feel).
const sdWaveTaper = (px, py, cx, cy, half, amp, phase) => {
  let d = 1e9, w = 0;
  const N = 56;
  let prevX = cx - half, prevY = cy;
  let prevT = 0;
  for (let i = 1; i <= N; i++) {
    const t = i / N, x = cx - half + 2 * half * t;
    const env = Math.sin(Math.PI * t);              // 0->1->0 envelope
    const y = cy + amp * env * Math.sin(t * Math.PI * 2 + phase);
    const seg = sdSeg(px, py, prevX, prevY, x, y);
    const wSeg = 5 + 11 * Math.sin(Math.PI * (prevT + t) / 2); // taper 5->16->5
    if (seg - wSeg < d - w) { d = seg; w = wSeg; }
    prevX = x; prevY = y; prevT = t;
  }
  return d - w;
};

const lerp = (a, b, t) => a + (b - a) * t;
const mix = (c1, c2, t) => [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];

const top = [0x2b, 0x9d, 0xff];   // bright cyan-ocean
const bot = [0x07, 0x1f, 0x4d];   // abyss navy
const ink = [0xff, 0xff, 0xff];

for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4;
    const px = x + .5, py = y + .5;
    const dBg = sdSquircle(px, py, 256, 256, 232, 76);
    // diagonal gradient (top-left light -> bottom-right deep)
    const gT = Math.min(1, Math.max(0, ((px + py) / 2 - 24) / 460));
    let col = mix(top, bot, gT);
    // soft radial sheen upper-left
    const lift = Math.max(0, 1 - Math.hypot(px - 165, py - 125) / 480) * 0.20;
    col = col.map(c => Math.min(255, c + 255 * lift * (1 - gT)));
    // subtle vignette for depth
    const vig = Math.max(0, Math.hypot(px - 256, py - 256) / 400 - 0.35) * 0.35;
    col = col.map(c => c * (1 - vig));
    let a = Math.min(1, Math.max(0, -dBg + 0.7));

    // line art
    const pillar = sdSeg(px, py, 256, 122, 256, 390) - 13;         // 26px stroke
    const waveA = sdWaveTaper(px, py, 256, 214, 128, 30, Math.PI * 0.5);
    const waveB = sdWaveTaper(px, py, 256, 322, 128, 30, Math.PI * 1.5);
    const inkD = Math.min(pillar, waveA, waveB);
    const sa = Math.min(1, Math.max(0, -inkD + 0.8));

    // white ink with a faint cyan core on the upper wave for depth
    let inkCol = ink;
    const core = Math.min(1, Math.max(0, -(waveA + 8) / 6));
    inkCol = mix(ink, [0xc9, 0xe9, 0xff], core * 0.55);

    const A = a + sa * (1 - a);
    buf[i]     = (col[0] * a * (1 - sa) + inkCol[0] * sa) / (A || 1);
    buf[i + 1] = (col[1] * a * (1 - sa) + inkCol[1] * sa) / (A || 1);
    buf[i + 2] = (col[2] * a * (1 - sa) + inkCol[2] * sa) / (A || 1);
    buf[i + 3] = A * 255;
  }
}

// downsample 512 -> 256
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

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4);
const entry = Buffer.alloc(16);
entry[0] = 0; entry[1] = 0; entry[2] = 0; entry[3] = 0;
entry.writeUInt16LE(1, 4); entry.writeUInt16LE(32, 6);
entry.writeUInt32LE(png.length, 8); entry.writeUInt32LE(22, 12);
fs.writeFileSync(path.join(dir, 'icon.ico'), Buffer.concat([header, entry, png]));

console.log('icon.png + icon.ico written', png.length, 'bytes');
