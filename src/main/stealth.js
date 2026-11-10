'use strict';
// stealth.js — baseline real-Chrome realism layer.
//
// Goal: pass human-verification stacks (Cloudflare Turnstile / managed
// challenge, DataDome-class probes) by removing Electron tells and covering
// the public anti-bot detection surface. Layers:
//
//   Wire   — real-Chrome UA + UA-CH brand headers on EVERY session (Electron
//            defaults leak "Electron/x.y" in both UA and Sec-CH-UA).
//   JS     — document-start MAIN-world bootstrap on every tab/frame:
//            window.chrome surface, plugins↔mimeTypes cross-reference,
//            permissions↔Notification coherence quirk, webdriver,
//            userAgentData brands, pdfViewerEnabled, toString masking.
//   Input  — trusted events via webContents.sendInputEvent with bezier
//            trajectories + timing jitter (trusted == real input pipeline).
//
// Deliberately avoided (rebrowser/DataDome research — live detection vectors):
//   Runtime.enable, --remote-debugging-port, debugger pauses. Our CDP use is
//   Page/Network/Emulation/Input only; Runtime.evaluate does not subscribe to
//   Runtime events.

const CHROME_VER = (process.versions.chrome || '140.0.0.0').split('.')[0];

const PLATFORMS = {
  win32: { ua: 'Windows NT 10.0; Win64; x64', ch: 'Windows', chVer: '15.0.0' },
  linux: { ua: 'X11; Linux x86_64', ch: 'Linux', chVer: '6.8.0' },
  darwin: { ua: 'Macintosh; Intel Mac OS X 10_15_7', ch: 'macOS', chVer: '14.5.0' }
};
const PLAT = PLATFORMS[process.platform] || PLATFORMS.win32;

const UA = `Mozilla/5.0 (${PLAT.ua}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VER}.0.0.0 Safari/537.36`;
const BRANDS = [
  { brand: 'Not_A Brand', version: '24' },
  { brand: 'Chromium', version: CHROME_VER },
  { brand: 'Google Chrome', version: CHROME_VER }
];
const FULL_BRANDS = BRANDS.map(b => ({ brand: b.brand, version: b.brand === 'Not_A Brand' ? '24.0.0.0' : CHROME_VER + '.0.0.0' }));
const CH_UA = BRANDS.map(b => `"${b.brand}";v="${b.version}"`).join(', ');
const CH_FULL = FULL_BRANDS.map(b => `"${b.brand}";v="${b.version}"`).join(', ');

// ---- main-world bootstrap ------------------------------------------------
// Injected via tabs.js writeBootstrap (page.js preload inserts it as the
// first <script> in <html>, document-start, every frame — including
// challenge iframes). Runs BEFORE fingerprint persona bootstrap so persona
// values override baseline where applicable.
const BOOTSTRAP = `(function(){'use strict';
// -- native-code masking (mirrors fingerprint.js pattern) --
const MASKED = new WeakMap();
const _ts = Function.prototype.toString;
const mask = (fn, name) => { MASKED.set(fn, name); return fn; };
Object.defineProperty(Function.prototype, 'toString', {
  value: mask(function toString() {
    const n = MASKED.get(this);
    if (n !== undefined) return 'function ' + n + '() { [native code] }';
    return _ts.call(this);
  }, 'toString'),
  writable: true, configurable: true
});
const def = (obj, prop, desc) => { try { Object.defineProperty(obj, prop, desc); } catch (e) {} };
const getter = (obj, prop, fn, name) => def(obj, prop, { get: mask(fn, 'get ' + (name || prop)), enumerable: true, configurable: true });

// -- navigator.webdriver --
getter(Navigator.prototype, 'webdriver', () => false);

// -- navigator.vendor --
getter(Navigator.prototype, 'vendor', () => 'Google Inc.');

// -- navigator.pdfViewerEnabled --
getter(Navigator.prototype, 'pdfViewerEnabled', () => true);

// -- navigator.plugins + mimeTypes (cross-referenced, real class protos) --
try {
  const MIME_PDF = { type: 'application/pdf', suffixes: 'pdf', description: '' };
  const MIME_TXT = { type: 'text/pdf', suffixes: 'pdf', description: '' };
  const NAMES = ['PDF Viewer', 'Chrome PDF Viewer', 'Chromium PDF Viewer', 'Microsoft Edge PDF Viewer', 'WebKit built-in PDF'];
  const mkMime = (m, plugin) => {
    const mt = Object.create(MimeType.prototype);
    def(mt, 'type', { value: m.type, enumerable: true });
    def(mt, 'suffixes', { value: m.suffixes, enumerable: true });
    def(mt, 'description', { value: m.description, enumerable: true });
    def(mt, 'enabledPlugin', { value: plugin, enumerable: true });
    return mt;
  };
  const arr = NAMES.map(name => {
    const p = Object.create(Plugin.prototype);
    def(p, 'name', { value: name, enumerable: true });
    def(p, 'filename', { value: 'internal-pdf-viewer', enumerable: true });
    def(p, 'description', { value: 'Portable Document Format', enumerable: true });
    def(p, 'length', { value: 1, enumerable: true });
    return p;
  });
  const mimes = [MIME_PDF, MIME_TXT].map(m => mkMime(m, arr[0]));
  // cross-reference: each plugin's [0] is a mime whose enabledPlugin is itself
  arr.forEach(p => { p[0] = mkMime(MIME_PDF, p); });
  const pa = Object.create(PluginArray.prototype);
  arr.forEach((p, i) => { def(pa, i, { value: p, enumerable: true }); def(pa, p.name, { value: p }); });
  def(pa, 'length', { value: arr.length, enumerable: true });
  def(pa, 'item', { value: mask(function item(i) { return arr[i] || null; }, 'item') });
  def(pa, 'namedItem', { value: mask(function namedItem(n) { return arr.find(p => p.name === n) || null; }, 'namedItem') });
  def(pa, 'refresh', { value: mask(function refresh() {}, 'refresh') });
  const ma = Object.create(MimeTypeArray.prototype);
  mimes.forEach(m => { def(ma, m.type, { value: m, enumerable: true }); });
  def(ma, 'length', { value: mimes.length, enumerable: true });
  def(ma, 'item', { value: mask(function item(i) { return mimes[i] || null; }, 'item') });
  def(ma, 'namedItem', { value: mask(function namedItem(n) { return mimes.find(m => m.type === n) || null; }, 'namedItem') });
  getter(Navigator.prototype, 'plugins', () => pa);
  getter(Navigator.prototype, 'mimeTypes', () => ma);
} catch (e) {}

// -- window.chrome (real surface; runtime only on secure origins) --
try {
  {
    const insecure = location.protocol !== 'https:' && !/^(localhost|127\\.|\\[::1\\]|$)/.test(location.hostname);
    const nav0 = performance.timing ? performance.timing.navigationStart : Date.now();
    const checkId = (id) => {
      if (id !== undefined && !/^[a-z]{32}$/.test(String(id)))
        throw new TypeError("Invalid extension id: '" + id + "'. It should be 32 characters long and contain only letters a-z.");
    };
    // Electron exposes an empty window.chrome = {} stub — merge into it.
    const chrome = (window.chrome && typeof window.chrome === 'object') ? window.chrome : {};
    chrome.app = {
      isInstalled: false,
      InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
      RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
      getDetails: mask(function getDetails() { return null; }, 'getDetails'),
      getIsInstalled: mask(function getIsInstalled() { return false; }, 'getIsInstalled'),
      installState: mask(function installState(cb) { if (cb) cb('not_installed'); }, 'installState'),
      runningState: mask(function runningState() { return 'cannot_run'; }, 'runningState')
    };
    if (!insecure) chrome.runtime = {
      OnInstalledReason: { CHROME_UPDATE: 'chrome_update', INSTALL: 'install', SHARED_MODULE_UPDATE: 'shared_module_update', UPDATE: 'update' },
      OnRestartRequiredReason: { APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic' },
      PlatformArch: { ARM: 'arm', ARM64: 'arm64', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
      PlatformNaclArch: { ARM: 'arm', ARM64: 'arm64', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
      PlatformOs: { ANDROID: 'android', CROS: 'cros', FUCHSIA: 'fuchsia', LINUX: 'linux', MAC: 'mac', OPENBSD: 'openbsd', WIN: 'win' },
      RequestUpdateCheckStatus: { NO_UPDATE: 'no_update', THROTTLED: 'throttled', UPDATE_AVAILABLE: 'update_available' },
      connect: mask(function connect() { checkId(arguments[0]); return { onDisconnect: { addListener(){} }, onMessage: { addListener(){} }, postMessage() {}, disconnect() {} }; }, 'connect'),
      sendMessage: mask(function sendMessage() { checkId(arguments[0]); }, 'sendMessage'),
      id: undefined
    };
    chrome.csi = mask(function csi() {
      return { onloadT: performance.timing ? performance.timing.loadEventEnd || nav0 : nav0,
               pageT: Math.max(1, Math.round(performance.now())) + Math.random() * 100,
               startE: nav0, tran: 15 };
    }, 'csi');
    chrome.loadTimes = mask(function loadTimes() {
      const s = nav0 / 1000, n = performance.now() / 1000;
      return { commitLoadTime: s + n * 0.3, connectionInfo: 'h2',
               finishDocumentLoadTime: s + n * 0.8, finishLoadTime: s + n,
               firstPaintAfterLoadTime: 0, firstPaintTime: s + n * 0.5,
               navigationType: 'Other', npnNegotiatedProtocol: 'h2',
               requestTime: s, startLoadTime: s,
               wasAlternateProtocolAvailable: false, wasFetchedViaSpdy: true, wasNpnNegotiated: true };
    }, 'loadTimes');
    if (!window.chrome || window.chrome !== chrome)
      def(window, 'chrome', { value: chrome, enumerable: true, configurable: true, writable: true });
  }
} catch (e) {}

// -- permissions ↔ Notification coherence (real-Chrome quirk preserved) --
try {
  const _query = Permissions.prototype.query;
  Permissions.prototype.query = mask(function query(desc) {
    if (desc && desc.name === 'notifications') {
      const insecure = location.protocol !== 'https:' && !/^(localhost|127\\.|\\[::1\\])/.test(location.hostname);
      // real Chrome: insecure origin -> query 'prompt' while Notification.permission 'denied'
      const state = insecure ? 'prompt' : (Notification.permission === 'default' ? 'prompt' : Notification.permission);
      return Promise.resolve({ state, onchange: null });
    }
    return _query.call(this, desc);
  }, 'query');
} catch (e) {}

// -- navigator.userAgentData — real Chrome brand surface --
try {
  const BRANDS = ${JSON.stringify(BRANDS)};
  const FULL = ${JSON.stringify(FULL_BRANDS)};
  const PLAT_CH = ${JSON.stringify(PLAT.ch)}, PLAT_VER = ${JSON.stringify(PLAT.chVer)}, FULLVER = ${JSON.stringify(CHROME_VER + '.0.0.0')};
  const uad = {
    brands: BRANDS.map(b => ({ ...b })),
    mobile: false,
    platform: PLAT_CH,
    getHighEntropyValues: mask(function getHighEntropyValues(hints) {
      const all = { architecture: 'x86', bitness: '64', brands: BRANDS.map(b => ({ ...b })),
                    fullVersionList: FULL.map(b => ({ ...b })), model: '', mobile: false,
                    platform: PLAT_CH, platformVersion: PLAT_VER, uaFullVersion: FULLVER, wow64: false };
      const out = {};
      for (const h of (hints || [])) if (h in all) out[h] = all[h];
      return Promise.resolve(out);
    }, 'getHighEntropyValues'),
    toJSON: mask(function toJSON() { return { brands: BRANDS.map(b => ({ ...b })), mobile: false, platform: PLAT_CH }; }, 'toJSON')
  };
  getter(Navigator.prototype, 'userAgentData', () => uad);
} catch (e) {}

// -- misc coherence --
try {
  getter(Navigator.prototype, 'doNotTrack', () => null);
  getter(Navigator.prototype, 'maxTouchPoints', () => ${process.platform === 'win32' ? '10' : '0'});
} catch (e) {}

// -- software-GL WebGL mask --
// SwiftShader/llvmpipe renderer strings are a known VM/headless signal for
// Turnstile. If the real GPU string is hardware, leave it; if it's software
// raster, present the most common integrated-GPU string for this platform.
// (Only unmasked debug-renderer params — persona tables override elsewhere.)
try {
  const SW = /SwiftShader|llvmpipe|softpipe|software/i;
  const REAL = ${JSON.stringify(process.platform === 'win32'
    ? { v: 'Google Inc. (Intel)', r: 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)' }
    : process.platform === 'darwin'
      ? { v: 'Google Inc. (Intel)', r: 'ANGLE (Intel, Intel(R) UHD Graphics 617 OpenGL Engine)' }
      : { v: 'Google Inc. (Intel)', r: 'ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (CML GT2), OpenGL 4.6)' })};
  const patchGL = (proto) => {
    if (!proto || !proto.getParameter) return;
    const _gp = proto.getParameter;
    proto.getParameter = mask(function getParameter(pname) {
      const v = _gp.call(this, pname);
      if ((pname === 37445 || pname === 37446) && typeof v === 'string' && SW.test(v))
        return pname === 37445 ? REAL.v : REAL.r;
      return v;
    }, 'getParameter');
  };
  patchGL(WebGLRenderingContext.prototype);
  patchGL(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype);
} catch (e) {}
})();`;

// ---- audit — runs in-page, returns per-check pass/fail --------------------
const AUDIT_JS = `(async function(){
const R = {}; const T = (n, f) => { try { const v = f(); R[n] = v && v.then ? v : Promise.resolve(v); } catch (e) { R[n] = Promise.resolve('FAIL:' + e.message); } };
T('webdriver', () => navigator.webdriver === false ? 'pass' : 'FAIL:' + navigator.webdriver);
T('ua_clean', () => !/Electron|HeadlessChrome|Haizhu/i.test(navigator.userAgent) ? 'pass' : 'FAIL:' + navigator.userAgent);
T('chrome_obj', () => window.chrome && typeof chrome.app === 'object' ? 'pass' : 'FAIL');
T('chrome_runtime', () => location.protocol !== 'https:' ? 'skip(insecure)' : (chrome.runtime && chrome.runtime.PlatformOs ? 'pass' : 'FAIL'));
T('chrome_csi', () => typeof chrome.csi === 'function' && 'pageT' in chrome.csi() ? 'pass' : 'FAIL');
T('chrome_loadTimes', () => typeof chrome.loadTimes === 'function' && chrome.loadTimes().npnNegotiatedProtocol ? 'pass' : 'FAIL');
T('plugins', () => navigator.plugins.length >= 3 && navigator.plugins[0].name ? 'pass' : 'FAIL:' + navigator.plugins.length);
T('mime_xref', () => { const p = navigator.plugins[0]; return p && p[0] && p[0].enabledPlugin === p ? 'pass' : 'FAIL'; });
T('plugins_class', () => navigator.plugins instanceof PluginArray ? 'pass' : 'FAIL');
T('languages', () => Array.isArray(navigator.languages) && navigator.languages.length ? 'pass' : 'FAIL');
T('vendor', () => navigator.vendor === 'Google Inc.' ? 'pass' : 'FAIL:' + navigator.vendor);
T('pdfviewer', () => navigator.pdfViewerEnabled === true ? 'pass' : 'FAIL');
T('platform', () => navigator.platform ? 'pass' : 'FAIL');
T('hw_mem', () => navigator.hardwareConcurrency >= 2 && navigator.deviceMemory >= 2 ? 'pass' : 'WARN:' + navigator.hardwareConcurrency + 'c/' + navigator.deviceMemory + 'g');
T('uad_brands', () => { const b = (navigator.userAgentData || {}).brands || []; return b.some(x => x.brand === 'Google Chrome') ? 'pass' : 'FAIL:' + JSON.stringify(b); });
T('uad_fvl', () => navigator.userAgentData.getHighEntropyValues(['fullVersionList']).then(v => v.fullVersionList.some(x => x.brand === 'Google Chrome') ? 'pass' : 'FAIL'));
T('perms_notif', () => navigator.permissions.query({ name: 'notifications' }).then(s => (s.state === 'prompt' || s.state === 'granted') ? 'pass' : 'WARN:' + s.state));
T('notif_perm', () => Notification.permission ? 'pass' : 'FAIL');
T('tostring_mask', () => /native code/.test(Function.prototype.toString.call(Navigator.prototype.query || Object.getOwnPropertyDescriptor(Navigator.prototype,'webdriver').get)) ? 'pass' : 'WARN');
T('webgl_renderer', () => { try { const gl = document.createElement('canvas').getContext('webgl'); const i = gl.getExtension('WEBGL_debug_renderer_info'); const r = gl.getParameter(i.UNMASKED_RENDERER_WEBGL); return /SwiftShader|llvmpipe|softpipe/i.test(r) ? 'FAIL:' + r : 'pass:' + r.slice(0, 60); } catch (e) { return 'WARN:' + e.message; } });
T('tz', () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone ? 'pass' : 'FAIL'; } catch (e) { return 'FAIL'; } });
T('screen', () => screen.width >= 800 && screen.colorDepth >= 24 && window.outerWidth > 0 ? 'pass' : 'WARN:' + screen.width + 'x' + screen.height + '/' + window.outerWidth);
T('media_devs', () => navigator.mediaDevices && navigator.mediaDevices.enumerateDevices ? 'pass' : 'WARN');
T('touch', () => 'ontouchstart' in window || navigator.maxTouchPoints >= 0 ? 'pass' : 'FAIL');
const out = {};
for (const [k, p] of Object.entries(R)) out[k] = await p;
return out;
})()`;

class Stealth {
  constructor() { this.sessions = new WeakSet(); }

  ua() { return UA; }

  // CDP document-start injection — applies to EVERY frame (including
  // cross-origin challenge iframes) with zero DOM trace, unlike the
  // bootstrap <script> path which is top-frame only.
  // Returns a promise the caller gates navigation on (same about:blank prime
  // pattern as setupCdpFp — commands queue until first renderer commit).
  async attachTab(tab) {
    const wc = tab.wc;
    try {
      await Promise.race([
        wc.loadURL('about:blank'),
        new Promise((_, rj) => setTimeout(() => rj(new Error('prime timeout')), 3000)),
      ]);
    } catch (e) {}
    const send = (m, p) => Promise.race([
      wc.debugger.sendCommand(m, p),
      new Promise((_, rj) => setTimeout(() => rj(new Error('cdp timeout')), 3000)),
    ]).catch(() => null);
    const apply = async () => {
      try { if (!wc.debugger.isAttached()) wc.debugger.attach('1.3'); } catch (e) { return; }
      await send('Page.enable');
      const r = await send('Page.addScriptToEvaluateOnNewDocument', { source: BOOTSTRAP, runImmediately: true });
      if (r && r.identifier) tab._stealthScriptId = r.identifier;
    };
    await apply();
    wc.debugger.on('detach', () => {
      if (wc.isDestroyed()) return;
      try { wc.debugger.attach('1.3'); apply(); } catch (e) {}
    });
  }

  // Wire layer — returns {requestHeaders} inside the webhub fan-out. On env
  // sessions the profile rewrite (registered after) wins and re-maps UA/CH to
  // the persona; on every other session this baseline stands.
  headerRewrite(details, ses) {
    const h = { ...(details.requestHeaders || {}) };
    const set = (k, v) => {
      const key = Object.keys(h).find(x => x.toLowerCase() === k);
      h[key !== undefined ? key : k] = v;
    };
    set('User-Agent', UA);
    set('Sec-CH-UA', CH_UA);
    set('Sec-CH-UA-Mobile', '?0');
    set('Sec-CH-UA-Platform', `"${PLAT.ch}"`);
    if (Object.keys(h).some(k => k.toLowerCase() === 'sec-ch-ua-full-version-list')) set('Sec-CH-UA-Full-Version-List', CH_FULL);
    if (Object.keys(h).some(k => k.toLowerCase() === 'sec-ch-ua-full-version')) set('Sec-CH-UA-Full-Version', `"${CHROME_VER}.0.0.0"`);
    if (!Object.keys(h).some(k => k.toLowerCase() === 'accept-language')) set('Accept-Language', 'en-US,en;q=0.9');
    return { requestHeaders: h };
  }

  attachSession(ses) {
    if (this.sessions.has(ses)) return;
    this.sessions.add(ses);
    try { ses.setUserAgent(UA); } catch (e) {}
  }

  bootstrap() { return BOOTSTRAP; }

  async audit(tab) { return await tab.wc.executeJavaScript(AUDIT_JS, true); }

  // ---- human input (trusted pipeline: webContents.sendInputEvent) ----
  async humanMove(wc, x1, y1, x2, y2, ms = 350) {
    const steps = Math.max(12, Math.round(Math.hypot(x2 - x1, y2 - y1) / 12));
    const cx = (x1 + x2) / 2 + (Math.random() - 0.5) * Math.abs(x2 - x1) * 0.4;
    const cy = (y1 + y2) / 2 + (Math.random() - 0.5) * Math.abs(y2 - y1) * 0.4;
    const t0 = Date.now();
    for (let i = 1; i <= steps; i++) {
      const t = i / steps, u = 1 - t;
      const x = u * u * x1 + 2 * u * t * cx + t * t * x2;
      const y = u * u * y1 + 2 * u * t * cy + t * t * y2;
      wc.sendInputEvent({ type: 'mouseMove', x: Math.round(x), y: Math.round(y) });
      // ease-out timing: faster mid-flight, slower near target
      const target = t0 + ms * (1 - Math.pow(1 - t, 2.2));
      const wait = target - Date.now();
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
    }
  }

  async humanClick(wc, x, y) {
    const tx = Math.round(x + (Math.random() - 0.5) * 4);
    const ty = Math.round(y + (Math.random() - 0.5) * 4);
    // approach from a nearby plausible position
    await this.humanMove(wc, tx + 60 + Math.random() * 120, ty + 40 + Math.random() * 80, tx, ty, 250 + Math.random() * 350);
    await new Promise(r => setTimeout(r, 60 + Math.random() * 160)); // pre-click hover
    wc.sendInputEvent({ type: 'mouseDown', x: tx, y: ty, button: 'left', clickCount: 1 });
    await new Promise(r => setTimeout(r, 45 + Math.random() * 75)); // human press duration
    wc.sendInputEvent({ type: 'mouseUp', x: tx, y: ty, button: 'left', clickCount: 1 });
    return { x: tx, y: ty };
  }

  async humanType(wc, text) {
    for (const ch of String(text)) {
      wc.sendInputEvent({ type: 'char', keyCode: ch });
      await new Promise(r => setTimeout(r, 55 + Math.random() * 120));
    }
    return text.length;
  }

  // Turnstile / CF managed-challenge best-effort click pass.
  // Locates the challenge iframe, clicks the checkbox zone with a human
  // trajectory, then polls for the token / cf_clearance.
  async solveTurnstile(tab, timeoutMs = 15000) {
    const wc = tab.wc;
    const box = await wc.executeJavaScript(`(function(){
      const found = [];
      const walk = (n) => {
        if (!n) return;
        if (n.tagName === 'IFRAME') found.push(n);
        if (n.shadowRoot) walk(n.shadowRoot);
        const kids = n.children || [];
        for (let i = 0; i < kids.length; i++) walk(kids[i]);
      };
      walk(document.body || document.documentElement);
      const f = found.find(x => /challenges\\.cloudflare\\.com|turnstile/i.test(x.src || ''))
             || found.find(x => /challenge/i.test(x.title || ''))
             || found.find(x => x.offsetParent !== null);
      if (!f) {
        // widget may sit inside a plain container — measure its box instead
        const c = document.querySelector('#cf-stage,#challenge-stage,.cf-turnstile,[data-turnstile-sitekey],div[class*="turnstile" i]');
        if (c) { const r = c.getBoundingClientRect(); if (r.width > 4 && r.height > 4) return { x: r.x, y: r.y, w: r.width, h: r.height }; }
        return null;
      }
      const r = f.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    })()`, true);
    if (!box) return { ok: false, reason: 'no challenge iframe' };
    // checkbox sits left-center of the compact widget (~30px from left edge)
    const cx = box.x + Math.min(30, box.w / 4);
    const cy = box.y + box.h / 2;
    await this.humanClick(wc, cx, cy);
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      await new Promise(r => setTimeout(r, 800));
      const state = await wc.executeJavaScript(`(function(){
        const inp = document.querySelector('input[name="cf-turnstile-response"],input[name="cf-turnstile-response"]');
        if (inp && inp.value) return { done: true, token: inp.value.slice(0, 24) + '…' };
        const f = document.querySelector('iframe[src*="challenges.cloudflare.com"],iframe[title*="challenge"]');
        return { done: false, iframe: !!f };
      })()`, true).catch(() => null);
      if (state && state.done) return { ok: true, token: state.token };
      const ck = await wc.session.cookies.get({ name: 'cf_clearance' }).catch(() => []);
      if (ck.length) return { ok: true, cfClearance: true };
      // widget gone usually means the challenge page moved on
      if (state && !state.iframe) return { ok: true, cleared: 'iframe gone' };
    }
    return { ok: false, reason: 'timeout waiting for token' };
  }
}

module.exports = { Stealth, UA, CHROME_VER };
