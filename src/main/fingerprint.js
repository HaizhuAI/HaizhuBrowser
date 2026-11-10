'use strict';
// Fingerprint engine — coherent, seed-stable, host-compatible personas injected
// into the main world at document-start. Surfaces covered:
//   navigator (+ userAgentData high-entropy), screen/dpr, timezone, canvas
//   (locked block noise + site-aware stability), WebGL (vendor/renderer +
//   GPU-class parameter tables + extension filtering), audio, client rects,
//   battery, media devices, speech voices, font probes, WebRTC host IP, plugins.
//
// Design provenance: commercial anti-detect conventions (Bit Browser / ADS) +
// audited OpenBrowser factual data (docs/SECURITY-OPENBROWSER.md). No upstream
// code is copied; all injection logic is HaizhuBrowser original.

const crypto = require('crypto');
const P = require('./personas');

const CHROME_MAJOR = 140;
const CHROME_FULL = '140.0.7339.127';

const UA_TEMPLATES = {
  windows: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`,
  macos: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`,
  macos_arm: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`,
  linux: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`,
  android: `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Mobile Safari/537.36`,
};

const CH_PLATFORMS = { windows: 'Windows', macos: 'macOS', macos_arm: 'macOS', linux: 'Linux', android: 'Android' };
const CH_PLATFORM_VERSION = { windows: '15.0.0', macos: '14.5.0', macos_arm: '14.5.0', linux: '6.8.0', android: '14.0.0' };
const CH_ARCH = { windows: 'x86', macos: 'x86', macos_arm: 'arm', linux: 'x86', android: 'arm' };
const NAV_PLATFORM = { windows: 'Win32', macos: 'MacIntel', macos_arm: 'MacIntel', linux: 'Linux x86_64', android: 'Linux armv8l' };

function clientHints(os) {
  const mobile = os === 'android';
  const brands = [
    { brand: 'Not?A_Brand', version: '24' },
    { brand: 'Chromium', version: String(CHROME_MAJOR) },
    { brand: 'Google Chrome', version: String(CHROME_MAJOR) },
  ];
  const fullVersionList = [
    { brand: 'Not?A_Brand', version: '24.0.0.0' },
    { brand: 'Chromium', version: CHROME_FULL },
    { brand: 'Google Chrome', version: CHROME_FULL },
  ];
  return {
    brands, fullVersionList,
    mobile,
    platform: CH_PLATFORMS[os] || 'Windows',
    platformVersion: CH_PLATFORM_VERSION[os] || '15.0.0',
    architecture: CH_ARCH[os] || 'x86',
    bitness: '64',
    model: mobile ? 'K' : '',
    uaFullVersion: CHROME_FULL,
    wow64: false,
  };
}

// Header-side representation (sec-ch-ua* values) for onBeforeSendHeaders.
function clientHintHeaders(ch) {
  const brandStr = ch.brands.map((b) => `"${b.brand}";v="${b.version}"`).join(', ');
  const fullStr = ch.fullVersionList.map((b) => `"${b.brand}";v="${b.version}"`).join(', ');
  return {
    'sec-ch-ua': brandStr,
    'sec-ch-ua-mobile': ch.mobile ? '?1' : '?0',
    'sec-ch-ua-platform': `"${ch.platform}"`,
    'sec-ch-ua-platform-version': `"${ch.platformVersion}"`,
    'sec-ch-ua-full-version-list': fullStr,
    'sec-ch-ua-full-version': `"${ch.uaFullVersion}"`,
    'sec-ch-ua-arch': `"${ch.architecture}"`,
    'sec-ch-ua-bitness': `"${ch.bitness}"`,
    'sec-ch-ua-model': `"${ch.model}"`,
    'sec-ch-ua-wow64': ch.wow64 ? '?1' : '?0',
  };
}

/* ---------------- persona assembly ---------------- */

function buildPersona(seed, osHint) {
  const os = osHint && osHint !== 'auto' ? osHint : defaultOsForSeed(seed);
  const hw = P.pickPersona(os, seed);
  if (!P.isCoherent(hw)) return buildPersona(P.hex(seed, 'reseed', 24), 'windows');
  const loc = P.localeFor(os, seed);
  const ch = clientHints(os);
  const gpu = hw.webgl.gpu || null;
  return {
    os,
    cores: hw.cores, memory: hw.memory, colorDepth: hw.colorDepth,
    userAgent: UA_TEMPLATES[os] || UA_TEMPLATES.windows,
    platform: NAV_PLATFORM[os] || 'Win32',
    vendor: 'Google Inc.',
    languages: loc.languages,
    language: loc.languages[0],
    timezone: loc.timezone,
    tzOffset: loc.tzOffset,
    hardwareConcurrency: hw.cores,
    deviceMemory: hw.memory,
    maxTouchPoints: os === 'android' ? 5 : 0,
    screen: {
      width: hw.screen.width, height: hw.screen.height,
      availWidth: hw.screen.availWidth, availHeight: hw.screen.availHeight,
      colorDepth: hw.colorDepth, pixelDepth: hw.colorDepth,
    },
    devicePixelRatio: hw.devicePixelRatio,
    webgl: {
      vendor: hw.webgl.vendor,
      renderer: hw.webgl.renderer,
      params: P.gpuParamOverrides(gpu) || {},
      extVendor: gpu ? gpu.vendor : null,
      gpuInfo: gpu ? { vendor: gpu.vendor, architecture: gpu.architecture } : null,
    },
    clientHints: ch,
    canvasSeed: P.hex(seed, 'canvas', 16),
    audioMark: ((P.u32(P.hashSeed(seed + '|audio'), 0) % 2000) - 1000) || 1,
    rectMark: ((P.u32(P.hashSeed(seed + '|rect'), 0) % 20000) - 10000) || 1,
    battery: P.seededBattery(seed),
    mediaDevices: P.seededMediaDevices(seed, os),
    speechVoices: P.speechVoicesForOs(os, seed),
    fonts: hw.fonts,
    foreignFonts: hw.foreignFonts,
    localIp: P.seededLocalIp(seed),
    deviceName: P.seededDeviceName(seed),
    stabilityHosts: P.STABILITY_HOSTS,
  };
}

function defaultOsForSeed(seed) {
  const s = P.hashSeed(seed + '|osmix');
  const r = (P.u32(s, 0) % 1000) / 1000;
  if (r < 0.7) return 'windows';
  if (r < 0.9) return 'macos_arm';
  if (r < 0.95) return 'linux';
  return 'android';
}

/* ---------------- injected bootstrap ---------------- */

function buildBootstrap(persona) {
  return `(function(){
'use strict';
if (window.__hz_fp) return; window.__hz_fp = true;
const P = ${JSON.stringify(persona)};
const CH = P.clientHints;

// native-code toString protection
const _fts = Function.prototype.toString;
const faked = new Map();
const spoof = (fn, name) => { try { faked.set(fn, 'function ' + name + '() { [native code] }'); } catch(e){} return fn; };
Function.prototype.toString = spoof(function toString(){ if (faked.has(this)) return faked.get(this); return _fts.call(this); }, 'toString');
const mark = (fn, name) => spoof(fn, name || fn.name);

const def = (proto, k, v) => { try { Object.defineProperty(proto.prototype || proto, k, { get(){ return v; }, configurable: true }); } catch(e){} };
const host = (location.hostname || '').toLowerCase();
const stable = P.stabilityHosts.some(h => host === h || host.endsWith('.' + h));
const noiseAmp = stable ? 1 : 3;

// ---- navigator ----
def(Navigator.prototype, 'userAgent', P.userAgent);
def(Navigator.prototype, 'appVersion', P.userAgent.replace('Mozilla/', ''));
def(Navigator.prototype, 'platform', P.platform);
def(Navigator.prototype, 'vendor', P.vendor);
def(Navigator.prototype, 'language', P.language);
def(Navigator.prototype, 'languages', Object.freeze(P.languages.slice()));
def(Navigator.prototype, 'hardwareConcurrency', P.hardwareConcurrency);
def(Navigator.prototype, 'deviceMemory', P.deviceMemory);
def(Navigator.prototype, 'maxTouchPoints', P.maxTouchPoints);
def(Navigator.prototype, 'webdriver', false);
def(Navigator.prototype, 'doNotTrack', '1');
if ('oscpu' in navigator) def(Navigator.prototype, 'oscpu', '');

// realistic plugins (Chrome ships the PDF viewer set)
const mkPlugin = (name, desc, fname) => {
  const mt = { type: 'application/pdf', suffixes: 'pdf', description: '', enabledPlugin: null };
  const p = { name, description: desc, filename: fname, length: 1, 0: mt, item: (i) => i === 0 ? mt : null, namedItem: (n) => n === mt.type ? mt : null };
  mt.enabledPlugin = p; return p;
};
const _plugins = [mkPlugin('PDF Viewer', 'Portable Document Format', 'internal-pdf-viewer'),
  mkPlugin('Chrome PDF Viewer', 'Portable Document Format', 'internal-pdf-viewer'),
  mkPlugin('Chromium PDF Viewer', 'Portable Document Format', 'internal-pdf-viewer'),
  mkPlugin('Microsoft Edge PDF Viewer', 'Portable Document Format', 'internal-pdf-viewer'),
  mkPlugin('WebKit built-in PDF', 'Portable Document Format', 'internal-pdf-viewer')];
_plugins.item = (i) => _plugins[i] || null;
_plugins.namedItem = (n) => _plugins.find(p => p.name === n) || null;
_plugins.refresh = () => {};
def(Navigator.prototype, 'plugins', Object.freeze(_plugins));
def(Navigator.prototype, 'mimeTypes', Object.freeze([{ type: 'application/pdf', suffixes: 'pdf', description: '', enabledPlugin: _plugins[0] }]));

// ---- userAgentData (brands + high-entropy values) ----
try {
  const HE = { architecture: CH.architecture, bitness: CH.bitness, model: CH.model,
    platformVersion: CH.platformVersion, uaFullVersion: CH.uaFullVersion,
    fullVersionList: CH.fullVersionList, wow64: CH.wow64 };
  const low = { brands: CH.brands.map(b => ({ brand: b.brand, version: b.version })), mobile: CH.mobile, platform: CH.platform };
  const uad = {
    get brands() { return low.brands.map(b => ({ brand: b.brand, version: b.version })); },
    get mobile() { return low.mobile; },
    get platform() { return low.platform; },
    getHighEntropyValues(hints) {
      const out = { brands: low.brands.map(b => ({ brand: b.brand, version: b.version })), mobile: low.mobile, platform: low.platform };
      for (const h of (hints || [])) if (Object.prototype.hasOwnProperty.call(HE, h)) out[h] = HE[h];
      return Promise.resolve(out);
    },
    toJSON() { return { brands: low.brands, mobile: low.mobile, platform: low.platform }; },
  };
  if (navigator.userAgentData || window.NavigatorUAData || 'userAgentData' in Navigator.prototype || true) {
    try { Object.defineProperty(Navigator.prototype, 'userAgentData', { get() { return uad; }, configurable: true }); } catch(e) {}
  }
} catch(e) {}

// ---- screen / dpr ----
def(Screen.prototype, 'width', P.screen.width);
def(Screen.prototype, 'height', P.screen.height);
def(Screen.prototype, 'availWidth', P.screen.availWidth);
def(Screen.prototype, 'availHeight', P.screen.availHeight);
def(Screen.prototype, 'colorDepth', P.screen.colorDepth);
def(Screen.prototype, 'pixelDepth', P.screen.pixelDepth);
try { Object.defineProperty(window, 'devicePixelRatio', { get() { return P.devicePixelRatio; }, configurable: true }); } catch(e) {}
try { window.matchMedia = ((orig) => mark(function(q){
  if (String(q).includes('device-pixel-ratio') || String(q).includes('-webkit-device-pixel-ratio')) {
    const m = String(q).match(/device-pixel-ratio:\\s*([\\d.]+)/);
    if (m && parseFloat(m[1]) !== P.devicePixelRatio) return { matches: false, media: q, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){}, onchange: null, dispatchEvent: () => false };
  }
  return orig.call(this, q);
}, 'matchMedia'))(window.matchMedia); } catch(e) {}

// ---- timezone ----
const _ro = Intl.DateTimeFormat.prototype.resolvedOptions;
Intl.DateTimeFormat.prototype.resolvedOptions = mark(function(){ const r = _ro.call(this); r.timeZone = P.timezone; return r; }, 'resolvedOptions');
Date.prototype.getTimezoneOffset = mark(function(){ return P.tzOffset; }, 'getTimezoneOffset');

// ---- seeded RNG (mulberry32 over persona key) ----
const seedBytes = P.canvasSeed.split('').map(c => c.charCodeAt(0));
let seedN = 0; for (const b of seedBytes) seedN = ((seedN * 31 + b) | 0) >>> 0;
let rngState = seedN || 1;
const rnd = () => { rngState = (rngState + 0x6D2B79F5) | 0; let t = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const noiseAt = (i) => { let x = Math.sin((i + 1) * seedN) * 10000; return x - Math.floor(x); };

// ---- canvas: locked block noise, site-aware amplitude ----
const lockMap = new Map();
function stableBlocks(ctx, w, h) {
  const key = w + 'x' + h + ':' + noiseAmp;
  let locked = lockMap.get(key);
  if (!locked) {
    locked = [];
    const sq = 8, lw = Math.min(w, 600), lh = Math.min(h, 600);
    for (let y = 0; y < lh; y += sq) for (let x = 0; x < lw; x += sq) {
      const px = (y * w + x) * 4;
      locked.push({ px, delta: Math.floor(noiseAt(px + P.rectMark % 97) * noiseAmp) - Math.floor(noiseAmp / 2) });
    }
    lockMap.set(key, locked);
  }
  return locked;
}
const _gid = CanvasRenderingContext2D.prototype.getImageData;
CanvasRenderingContext2D.prototype.getImageData = mark(function(x, y, w, h){
  const d = _gid.call(this, x, y, w, h);
  try { for (const it of stableBlocks(this, this.canvas.width, this.canvas.height)) {
    if (it.px + 3 < d.data.length) d.data[it.px] = Math.max(0, Math.min(255, d.data[it.px] + it.delta));
  } } catch(e) {}
  return d;
}, 'getImageData');
const _td = HTMLCanvasElement.prototype.toDataURL;
const _tb = HTMLCanvasElement.prototype.toBlob;
function jitter(c) { try { const x = c.getContext('2d'); if (x && c.width && c.height) {
  const g = x.getImageData(0, 0, 1, 1); g.data[0] ^= 1;
  x.putImageData(g, Math.abs(rnd() * c.width) | 0, Math.abs(rnd() * c.height) | 0);
} } catch(e) {} }
HTMLCanvasElement.prototype.toDataURL = mark(function(){ jitter(this); return _td.apply(this, arguments); }, 'toDataURL');
HTMLCanvasElement.prototype.toBlob = mark(function(){ jitter(this); return _tb.apply(this, arguments); }, 'toBlob');

// ---- WebGL: identity + GPU-class params + vendor extension filter ----
const WGP = P.webgl.params;
const wparams = (orig, self, p) => {
  if (p === 37445) return P.webgl.vendor;
  if (p === 37446) return P.webgl.renderer;
  if (Object.prototype.hasOwnProperty.call(WGP, p)) return WGP[p];
  return orig.call(self, p);
};
const wext = (arr) => !P.webgl.extVendor ? arr : arr.filter(n => {
  const s = String(n).toLowerCase(), v = P.webgl.extVendor;
  if (s.startsWith('nv_') && v !== 'nvidia') return false;
  if (s.startsWith('amd_') && v !== 'amd') return false;
  if (s.startsWith('intel_') && v !== 'intel') return false;
  if (s.startsWith('qcom_') && v !== 'qualcomm') return false;
  return true;
});
for (const Ctx of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
  if (!Ctx) continue;
  const _gp = Ctx.prototype.getParameter;
  Ctx.prototype.getParameter = mark(function(p){ return wparams(_gp, this, p); }, 'getParameter');
  const _gse = Ctx.prototype.getSupportedExtensions;
  if (_gse) Ctx.prototype.getSupportedExtensions = mark(function(){ return wext(_gse.call(this) || []); }, 'getSupportedExtensions');
}
// WebGPU adapterInfo
if (navigator.gpu) {
  try {
    const _ra = navigator.gpu.requestAdapter.bind(navigator.gpu);
    navigator.gpu.requestAdapter = mark(async function(o){
      const a = await _ra(o);
      if (a && a.info && P.webgl.gpuInfo) {
        try { Object.defineProperty(a, 'info', { get: () => ({ vendor: P.webgl.gpuInfo.vendor, architecture: P.webgl.gpuInfo.architecture, device: '', description: '' }), configurable: true }); } catch(e) {}
      }
      return a;
    }, 'requestAdapter');
  } catch(e) {}
}

// ---- audio ----
const A = P.audioMark;
if (window.OfflineAudioContext) {
  const _sr = OfflineAudioContext.prototype.startRendering;
  OfflineAudioContext.prototype.startRendering = mark(function(){
    return _sr.call(this).then(buf => { try {
      const d = buf.getChannelData(0);
      for (let i = 0; i < Math.min(64, d.length); i++) d[i] += (noiseAt(i + A) - 0.5) * 1e-6;
    } catch(e) {} return buf; });
  }, 'startRendering');
}
if (window.AnalyserNode) {
  const _gff = AnalyserNode.prototype.getFloatFrequencyData;
  AnalyserNode.prototype.getFloatFrequencyData = mark(function(a){ _gff.call(this, a); for (let i = 0; i < a.length; i += 7) a[i] += (noiseAt(i + A) - 0.5) * 1e-3; }, 'getFloatFrequencyData');
}
if (window.AudioBuffer) {
  const _gcd = AudioBuffer.prototype.getChannelData;
  AudioBuffer.prototype.getChannelData = mark(function(c){ const d = _gcd.call(this, c); for (let i = 0; i < Math.min(32, d.length); i++) d[i] += (noiseAt(i + A) - 0.5) * 1e-6; return d; }, 'getChannelData');
}

// ---- client rects: seeded sub-pixel mark ----
const RM = P.rectMark % 100;
const rj = (v, i) => Math.round((v + (noiseAt(i + RM) - 0.5) * 0.4) * 100) / 100;
const _gbr = Element.prototype.getBoundingClientRect;
Element.prototype.getBoundingClientRect = mark(function(){
  const r = _gbr.call(this); const i = Math.abs(RM);
  const o = { x: rj(r.x, i), y: rj(r.y, i + 1), width: r.width, height: r.height, top: rj(r.top, i + 2), right: rj(r.right, i + 3), bottom: rj(r.bottom, i + 4), left: rj(r.left, i + 5), toJSON: () => ({}) };
  return o;
}, 'getBoundingClientRect');

// ---- battery ----
if (navigator.getBattery) {
  Navigator.prototype.getBattery = mark(function(){
    const B = P.battery;
    const mgr = { charging: B.charging, chargingTime: B.chargingTime, dischargingTime: B.dischargingTime, level: B.level,
      addEventListener(){}, removeEventListener(){}, onchargingchange: null, onchargingtimechange: null, ondischargingtimechange: null, onlevelchange: null };
    return Promise.resolve(mgr);
  }, 'getBattery');
}

// ---- media devices ----
if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
  const _ed = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
  const MdiProto = (typeof MediaDeviceInfo !== 'undefined') ? MediaDeviceInfo.prototype : null;
  navigator.mediaDevices.enumerateDevices = mark(async function(){
    await _ed().catch(() => []);
    const mk = (d) => {
      const o = { deviceId: d.deviceId, groupId: d.groupId, kind: d.kind, label: d.label, toJSON(){ return { deviceId: this.deviceId, groupId: this.groupId, kind: this.kind, label: this.label }; } };
      if (MdiProto) try { Object.setPrototypeOf(o, MdiProto); } catch(_) {}
      return o;
    };
    const defs = [
      { kind: 'audioinput', label: 'Default - ' + P.mediaDevices[0].label, deviceId: 'default', groupId: P.mediaDevices[0].groupId },
      ...P.mediaDevices,
      { kind: 'audiooutput', label: 'Communications - ' + P.mediaDevices[2].label, deviceId: 'communications', groupId: P.mediaDevices[2].groupId },
    ];
    return defs.map(mk);
  }, 'enumerateDevices');
}

// ---- speech voices ----
if (window.speechSynthesis) {
  const _gv = SpeechSynthesis.prototype.getVoices;
  const voices = P.speechVoices.map(v => {
    const vo = { name: v.name, lang: v.lang, default: v.default, localService: v.localService, voiceURI: v.voiceURI };
    try { Object.setPrototypeOf(vo, SpeechSynthesisVoice.prototype); } catch(e) {}
    return vo;
  });
  SpeechSynthesis.prototype.getVoices = mark(function(){ _gv.call(this); return voices; }, 'getVoices');
}

// ---- font probes: deny fonts the persona OS cannot have ----
if (window.FontFaceSet && FontFaceSet.prototype.check) {
  const _chk = FontFaceSet.prototype.check;
  const foreign = new Set(P.foreignFonts.map(f => f.toLowerCase()));
  FontFaceSet.prototype.check = mark(function(font, text){
    const m = String(font).match(/"([^"]+)"|'([^']+)'|([\\w\\s-]+)/);
    const fam = (m && (m[1] || m[2] || m[3]) || '').trim().toLowerCase();
    if (fam && foreign.has(fam)) return false;
    return _chk.call(this, font, text);
  }, 'check');
}

// ---- WebRTC: rewrite host candidates to seeded local IP ----
if (window.RTCPeerConnection) {
  const fixSdp = (s) => String(s || '').replace(/(a=candidate:[^\\r\\n]*?)(\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3})( \\d+ typ host)/g, (m, a, ip, b) => a + P.localIp + b)
    .replace(/(c=IN IP4 )(\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3})/g, '$1' + P.localIp);
  const _ael = RTCPeerConnection.prototype.addEventListener;
  RTCPeerConnection.prototype.addEventListener = mark(function(t, fn, o){
    if (t === 'icecandidate' && typeof fn === 'function') {
      fn = new Proxy(fn, { apply(f, thisArg, args) {
        const e = args[0];
        if (e && e.candidate && e.candidate.candidate) {
          try { const c = Object.assign({}, e.candidate, { candidate: fixSdp(e.candidate.candidate) });
            args[0] = Object.assign(Object.create(Object.getPrototypeOf(e)), e, { candidate: c }); } catch(_) {}
        }
        return f.apply(thisArg, args);
      } });
    }
    return _ael.call(this, t, fn, o);
  }, 'addEventListener');
  const _cos = RTCPeerConnection.prototype.createOffer;
  RTCPeerConnection.prototype.createOffer = mark(async function(){ const o = await _cos.apply(this, arguments); if (o && o.sdp) o = Object.assign(Object.create(Object.getPrototypeOf(o)), o, { sdp: fixSdp(o.sdp) }); return o; }, 'createOffer');
  const _cas = RTCPeerConnection.prototype.createAnswer;
  RTCPeerConnection.prototype.createAnswer = mark(async function(){ const o = await _cas.apply(this, arguments); if (o && o.sdp) o = Object.assign(Object.create(Object.getPrototypeOf(o)), o, { sdp: fixSdp(o.sdp) }); return o; }, 'createAnswer');
}
})();
`;
}

/* ---------------- manager ---------------- */

class FingerprintManager {
  constructor(store) {
    this.store = store;
    this.sessionSeed = crypto.randomBytes(16).toString('hex');
  }
  get settings() {
    return this.store.get('fingerprint', { enabled: false, mode: 'per-session', os: 'auto', webrtc: 'mask-local' });
  }
  // seed: stable identity (domain hash / profile seed / session). osHint: 'auto'|os key.
  personaFor(seed, osHint) {
    const s = this.settings;
    if (!s.enabled) return null;
    const generic = !seed || seed === 'seed' || seed === 'preview';
    const key = (s.mode === 'per-domain' || !generic) ? (seed || this.sessionSeed) : this.sessionSeed;
    return buildPersona(key, osHint || s.os);
  }
  bootstrapFor(seed, osHint) {
    const p = this.personaFor(seed, osHint || this.settings.os);
    return p ? buildBootstrap(p) : null;
  }
  // For profile-bound sessions: always build from explicit seed+os regardless of global toggle.
  bootstrapForProfile(profile) {
    return buildBootstrap(buildPersona(profile.seed || profile.id, profile.os || 'auto'));
  }
  headersFor(profile) {
    return clientHintHeaders(clientHints(profile.os === 'auto' ? defaultOsForSeed(profile.seed || profile.id) : profile.os));
  }
  rotate() { this.sessionSeed = crypto.randomBytes(16).toString('hex'); }
}

module.exports = { FingerprintManager, buildPersona, buildBootstrap, clientHintHeaders };
