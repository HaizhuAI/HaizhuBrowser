'use strict';
// Fingerprint spoofing engine — generates a main-world bootstrap script that
// normalizes / randomizes the most common tracking surfaces:
//   navigator.*, screen.*, canvas, WebGL, AudioContext, fonts, timezone, WebRTC.
// A "profile" is a plain object; mode 'per-session' rotates on every restart,
// 'per-domain' derives a stable persona from the eTLD+1 hash.

const crypto = require('crypto');

const UA_POOL = [
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', platform: 'Win32', vendor: 'Google Inc.', oscpu: 'Windows NT 10.0; Win64; x64' },
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0', platform: 'Win32', vendor: 'Google Inc.', oscpu: 'Windows NT 10.0; Win64; x64' },
  { ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', platform: 'Linux x86_64', vendor: 'Google Inc.', oscpu: 'Linux x86_64' },
  { ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', platform: 'MacIntel', vendor: 'Google Inc.', oscpu: 'Intel Mac OS X 10_15_7' },
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0', platform: 'Win32', vendor: '', oscpu: 'Windows NT 10.0; Win64; x64' }
];
const SCREEN_POOL = [
  { w: 1920, h: 1080 }, { w: 1536, h: 864 }, { w: 1366, h: 768 },
  { w: 2560, h: 1440 }, { w: 1600, h: 900 }, { w: 1440, h: 900 }
];
const LANG_POOL = [
  ['en-US', 'en'], ['en-GB', 'en'], ['zh-CN', 'zh', 'en'], ['de-DE', 'de', 'en'], ['ja-JP', 'en']
];
const HW_POOL = [4, 6, 8, 12, 16];
const GPU_POOL = [
  'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
  'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)',
  'ANGLE (AMD, AMD Radeon RX 6600 Direct3D11 vs_5_0 ps_5_0, D3D11)',
  'WebKit WebGL',
  'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device), SwiftShader driver)'
];

function pick(arr, rng) { return arr[Math.floor(rng() * arr.length)]; }
function seededRng(seed) {
  let h = crypto.createHash('sha256').update(String(seed)).digest();
  let i = 0;
  return () => {
    if (i >= h.length) { h = crypto.createHash('sha256').update(h).digest(); i = 0; }
    return h[i++] / 256;
  };
}

// Build a persona object. seed -> deterministic persona.
function buildPersona(seed) {
  const rng = seededRng(seed);
  const ua = pick(UA_POOL, rng);
  const scr = pick(SCREEN_POOL, rng);
  const langs = pick(LANG_POOL, rng);
  return {
    userAgent: ua.ua, platform: ua.platform, vendor: ua.vendor, oscpu: ua.oscpu,
    screen: { width: scr.w, height: scr.h, availW: scr.w, availH: scr.h - 40, colorDepth: 24, pixelDepth: 24 },
    languages: langs, language: langs[0],
    hardwareConcurrency: pick(HW_POOL, rng),
    deviceMemory: pick([4, 8, 16], rng),
    maxTouchPoints: 0,
    gpu: pick(GPU_POOL, rng),
    tzOffset: pick([0, -480, -300, -420, -540, 60, 120], rng), // minutes west of UTC like Date#getTimezoneOffset
    noiseSeed: Array.from(crypto.createHash('sha256').update(seed + ':n').digest().slice(0, 16)),
    canvasNoise: 0.001 + rng() * 0.004,
    audioNoise: 0.0001 + rng() * 0.0009,
    webrtc: pick(['disable', 'proxy-only', 'mask-local'], rng)
  };
}

// The injected bootstrap. Runs in the MAIN world before any page script
// (Page.addScriptToEvaluateOnNewDocument). `P` is the serialized persona.
function buildBootstrap(persona) {
  const P = JSON.stringify(persona);
  return `(function(){
'use strict';
if (window.__hz_fp) return; window.__hz_fp = true;
const P = ${P};
const N = P.noiseSeed;
let npos = 0;
const noise = () => N[(npos++) % N.length] / 255 - 0.5;
const def = (o, k, v) => { try { Object.defineProperty(o, k, { get: () => v, configurable: true }); } catch(e){} };
const defProto = (proto, k, v) => { try { Object.defineProperty(proto.prototype || proto, k, { get(){ return v; }, configurable: true }); } catch(e){} };

// ---- navigator ----
def(Navigator.prototype, 'userAgent', P.userAgent);
def(Navigator.prototype, 'appVersion', P.userAgent.replace('Mozilla/',''));
def(Navigator.prototype, 'platform', P.platform);
def(Navigator.prototype, 'vendor', P.vendor);
def(Navigator.prototype, 'language', P.language);
def(Navigator.prototype, 'languages', Object.freeze(P.languages.slice()));
def(Navigator.prototype, 'hardwareConcurrency', P.hardwareConcurrency);
def(Navigator.prototype, 'deviceMemory', P.deviceMemory);
def(Navigator.prototype, 'maxTouchPoints', P.maxTouchPoints);
def(Navigator.prototype, 'webdriver', false);
if (navigator.userAgentData) {
  def(NavigatorUAData.prototype, 'platform', P.platform === 'MacIntel' ? 'macOS' : (P.platform === 'Win32' ? 'Windows' : 'Linux'));
  def(NavigatorUAData.prototype, 'mobile', false);
}
if ('oscpu' in navigator) def(Navigator.prototype, 'oscpu', P.oscpu);

// ---- screen ----
def(Screen.prototype, 'width', P.screen.width);
def(Screen.prototype, 'height', P.screen.height);
def(Screen.prototype, 'availWidth', P.screen.availW);
def(Screen.prototype, 'availHeight', P.screen.availH);
def(Screen.prototype, 'colorDepth', P.screen.colorDepth);
def(Screen.prototype, 'pixelDepth', P.screen.pixelDepth);

// ---- timezone ----
const _tz = Intl.DateTimeFormat.prototype.resolvedOptions;
Intl.DateTimeFormat.prototype.resolvedOptions = function(){ const r=_tz.call(this); r.timeZone=P.tzName||r.timeZone; return r; };
const _gto = Date.prototype.getTimezoneOffset;
Date.prototype.getTimezoneOffset = function(){ return P.tzOffset; };

// ---- canvas ----
const _getImageData = CanvasRenderingContext2D.prototype.getImageData;
CanvasRenderingContext2D.prototype.getImageData = function(x,y,w,h){
  const d = _getImageData.call(this,x,y,w,h);
  const n = Math.max(1, Math.floor(d.data.length * P.canvasNoise));
  for (let i=0;i<n;i++){ const p=(Math.abs(noise())*d.data.length)|0; d.data[p]=d.data[p]^1; }
  return d;
};
const _toDataURL = HTMLCanvasElement.prototype.toDataURL;
const _toBlob = HTMLCanvasElement.prototype.toBlob;
const jitterCtx = c => { try{ const x=c.getContext('2d'); if(x&&c.width&&c.height){ const g=x.getImageData(0,0,1,1); g.data[0]^=1; x.putImageData(g,Math.abs(noise())*c.width|0,Math.abs(noise())*c.height|0);} }catch(e){} };
HTMLCanvasElement.prototype.toDataURL = function(){ jitterCtx(this); return _toDataURL.apply(this,arguments); };
HTMLCanvasElement.prototype.toBlob = function(){ jitterCtx(this); return _toBlob.apply(this,arguments); };

// ---- WebGL ----
const gp = WebGLRenderingContext.prototype.getParameter;
WebGLRenderingContext.prototype.getParameter = function(p){
  if (p === 37445) return 'WebKit';                       // UNMASKED_VENDOR
  if (p === 37446) return P.gpu;                          // UNMASKED_RENDERER
  if (p === 7937)  return 'WebKit';                       // VENDOR
  if (p === 7938)  return 'WebKit WebGL';                 // RENDERER
  return gp.call(this,p);
};
if (window.WebGL2RenderingContext) {
  const gp2 = WebGL2RenderingContext.prototype.getParameter;
  WebGL2RenderingContext.prototype.getParameter = function(p){
    if (p === 37445) return 'WebKit';
    if (p === 37446) return P.gpu;
    if (p === 7937)  return 'WebKit';
    if (p === 7938)  return 'WebKit WebGL';
    return gp2.call(this,p);
  };
}
const _getSupportedExtensions = WebGLRenderingContext.prototype.getSupportedExtensions;
WebGLRenderingContext.prototype.getSupportedExtensions = function(){ return _getSupportedExtensions.call(this); };

// ---- AudioContext ----
if (window.OfflineAudioContext) {
  const _start = OfflineAudioContext.prototype.startRendering;
  OfflineAudioContext.prototype.startRendering = function(){
    return _start.call(this).then(buf => {
      try{ const d = buf.getChannelData(0); for(let i=0;i<Math.min(64,d.length);i++) d[i]+=noise()*P.audioNoise; }catch(e){}
      return buf;
    });
  };
}
if (window.AnalyserNode) {
  const _gfa = AnalyserNode.prototype.getFloatFrequencyData;
  AnalyserNode.prototype.getFloatFrequencyData = function(a){ _gfa.call(this,a); for(let i=0;i<a.length;i+=7) a[i]+=noise()*P.audioNoise*100; };
}

// ---- misc surfaces ----
def(Navigator.prototype, 'doNotTrack', '1');
if (window.BatteryManager) def(Navigator.prototype, 'getBattery', undefined);
if (navigator.connection) {
  try{ def(navigator.connection,'rtt',50); def(navigator.connection,'downlink',10); }catch(e){}
}
// plugins/mimeTypes look non-empty
def(Navigator.prototype, 'plugins', Object.freeze([1,2,3,4,5]));
// font probing noise: offsetWidth/Height micro-jitter
const _oW = Object.getOwnPropertyDescriptor(HTMLElement.prototype,'offsetWidth');
if (_oW && _oW.get) def(HTMLElement.prototype,'offsetWidth', undefined) , Object.defineProperty(HTMLElement.prototype,'offsetWidth',{get:function(){const v=_oW.get.call(this);return v+(Math.abs(noise())<0.02?1:0);},configurable:true});
const _oH = Object.getOwnPropertyDescriptor(HTMLElement.prototype,'offsetHeight');
if (_oH && _oH.get) Object.defineProperty(HTMLElement.prototype,'offsetHeight',{get:function(){const v=_oH.get.call(this);return v+(Math.abs(noise())<0.02?1:0);},configurable:true});
})();
`;
}

class FingerprintManager {
  constructor(store) {
    this.store = store;
    this.sessionSeed = crypto.randomBytes(16).toString('hex');
  }
  get settings() {
    return this.store.get('fingerprint', { enabled: false, mode: 'per-session', webrtc: 'mask-local', uaHeader: true });
  }
  personaFor(seed) {
    const s = this.settings;
    if (!s.enabled) return null;
    const key = s.mode === 'per-domain' ? seed : this.sessionSeed;
    return buildPersona(key);
  }
  bootstrapFor(seed) {
    const p = this.personaFor(seed);
    return p ? buildBootstrap(p) : null;
  }
  rotate() { this.sessionSeed = crypto.randomBytes(16).toString('hex'); }
}

module.exports = { FingerprintManager, buildPersona };
