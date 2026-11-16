'use strict';
// Shifter Web Proxy lane — ported integration of shifter.io's free residential
// web proxy (scramjet + bare-mux + wisp). A proxy tab hosts a controller page
// on shifter.io that creates a session (reCAPTCHA once), mints short-lived
// tickets and drives the proxied runtime iframe via postMessage — every
// request inside the tab exits from a residential IP in the chosen country.
//
// Flow (mirrors web-proxy-launcher/client.js):
//   GET  api/v1/config                 → countries + captchaSiteKey + runtimeOrigin
//   POST api/v1/sessions               → {country, captchaToken} → credential+session
//   POST api/v1/session/tickets        → Bearer → {ticket, revision}
//   iframe runtimeOrigin/index.html?parentOrigin&channel&protocolVersion=1
//   postMessage start {ticket,url,engineId} / go / back / forward / reload /
//   reconnect / clear / ping ; runtime posts ready/url/loading/loaded/error

const API = 'https://web.p.shifter.io/api/v1/';
const RUNTIME = 'https://web.p.shifter.io';
const HOST_PAGE = 'https://shifter.io/';
const HOST_ORIGIN = 'https://shifter.io';

// Injected into the host tab. Owns: config fetch, captcha card, session
// create/resume, ticket minting, runtime iframe bridge, toolbar UI, state.
// Re-entrant: installs once per document, keyed on window.__hzwp.
const CONTROLLER = String.raw`
(() => {
  if (window.__hzwp && window.__hzwp.v === 1) return 'exists';
  const CFG = window.__hzwpcfg || {};
  delete window.__hzwpcfg;
  const API = ${JSON.stringify(API)}, RT = ${JSON.stringify(RUNTIME)};
  const LSKEY = 'shifter-web-proxy:v1:' + RT + ':shifter';
  const uuid = () => (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
      });
  const CHAN = uuid();
  const S = { v:1, phase:'boot', country:(CFG.country||'us').toLowerCase(), targetUrl:CFG.url||'',
              sessionUrl:'', error:null, remaining:null, sessionStatus:null, needsCaptcha:false,
              countries:[], captchaSiteKey:null };
  let credential = null, frame = null, ready = false, engineId = null, cfg = null;
  let capResolvers = [], capWidget = undefined, started = false, pendingUrl = null, bootFails = 0;
  const store = {
    get: () => { try { return localStorage.getItem(LSKEY); } catch { return null; } },
    set: v => { try { localStorage.setItem(LSKEY, v); } catch {} },
    del: () => { try { localStorage.removeItem(LSKEY); } catch {} }
  };
  credential = store.get();
  const note = (k, v) => { S[k] = v; };
  const api = async (p, m = 'GET', b) => {
    const r = await fetch(API + p, {
      method: m, credentials: 'omit', signal: AbortSignal.timeout(15000),
      headers: { ...(credential ? { Authorization: 'Bearer ' + credential } : {}),
                 ...(b ? { 'Content-Type': 'application/json' } : {}) },
      body: b ? JSON.stringify(b) : undefined
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      if (r.status === 401) { credential = null; store.del(); note('needsCaptcha', true); }
      throw Object.assign(new Error(d.error || ('HTTP ' + r.status)), { code: d.code || ('HTTP_' + r.status) });
    }
    return d;
  };
  // control-to-runtime uses 'command'; runtime-to-control replies use 'type'.
  const send = (command, data = {}) => {
    if (frame && frame.contentWindow)
      frame.contentWindow.postMessage({ source:'shifter-control', protocolVersion:1, channel:CHAN, command, ...data }, RT);
  };

  // ---------- injected page UI ----------
  const css = document.createElement('style');
  css.textContent =
    'html,body{margin:0;height:100%;overflow:hidden;background:#0e1424}' +
    '#hzwp-bar{display:flex;align-items:center;gap:8px;height:40px;padding:0 10px;' +
    'background:#141b2e;color:#e6ecf5;font:13px/1 system-ui;border-bottom:1px solid #232c45;' +
    'position:fixed;top:0;left:0;right:0;z-index:1000000}' +
    '#hzwp-bar img{width:16px;height:16px;border-radius:50%}' +
    '#hzwp-bar select{background:#1b2338;color:#e6ecf5;border:1px solid #2c3854;border-radius:6px;height:26px;max-width:150px;padding:0 4px}' +
    '#hzwp-bar .u{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#8fa2c4;font-size:12px}' +
    '#hzwp-bar button{background:#1b2338;color:#c9d6ec;border:1px solid #2c3854;border-radius:6px;height:26px;padding:0 9px;cursor:pointer;font-size:13px}' +
    '#hzwp-bar button:hover{border-color:#4a5b85}' +
    '#hzwp-badge{color:#5f7ab8;font-size:11px;white-space:nowrap}' +
    '#hzwp-frame{position:fixed;top:40px;left:0;right:0;bottom:0;border:0;width:100%;height:calc(100% - 40px);display:block;background:#fff}' +
    '#hzwp-cap{position:fixed;inset:0;z-index:1000001;display:none;place-items:center;background:#101521cc}' +
    '#hzwp-cap .card{background:#fff;color:#182329;border-radius:14px;padding:26px;width:min(390px,calc(100vw - 20px));font:15px/1.5 system-ui;box-shadow:0 20px 80px #0006}' +
    '#hzwp-cap h2{font:600 20px/1.3 system-ui;margin:0 0 10px}' +
    '#hzwp-cap p{font:14px/1.5 system-ui;margin:10px 0;color:#445}' +
    '#hzwp-cap .st{color:#5b6269;font-size:13px;min-height:18px}' +
    '#hzwp-cap [data-retry]{border:1px solid #ccd2d5;border-radius:8px;background:#f5f7f8;color:#182329;font:600 14px system-ui;padding:9px 15px;cursor:pointer}';
  document.head.appendChild(css);
  const LANG = (navigator.language || 'en').toLowerCase();
  const T = LANG.startsWith('zh')
    ? { h2: '简单验证', p: '完成人机验证后，即可通过所选国家的住宅 IP 浏览网页。', loading: '正在加载验证…', failed: '验证失败——请重试。', retry: '重试' }
    : { h2: 'One quick check', p: 'Verify you are human to start browsing through a residential IP.', loading: 'Loading verification…', failed: 'Verification failed — try again.', retry: 'Try again' };
  document.body.innerHTML =
    '<div id="hzwp-bar">' +
      '<img id="hzwp-flag" src="https://shifter.io/images/flags/' + S.country + '.svg" alt="">' +
      '<select id="hzwp-country"></select>' +
      '<span class="u" id="hzwp-url"></span>' +
      '<button id="hzwp-b" title="Back">&#8592;</button>' +
      '<button id="hzwp-f" title="Forward">&#8594;</button>' +
      '<button id="hzwp-r" title="Reload">&#10227;</button>' +
      '<span id="hzwp-badge"></span>' +
    '</div>' +
    '<div id="hzwp-cap"><div class="card"><h2>' + T.h2 + '</h2>' +
      '<p>' + T.p + '</p>' +
      '<div id="hzwp-widget"></div><p class="st" id="hzwp-capst">' + T.loading + '</p>' +
      '<button data-retry style="display:none">' + T.retry + '</button></div></div>';
  const $ = s => document.querySelector(s);
  $('#hzwp-b').onclick = () => send('back');
  $('#hzwp-f').onclick = () => send('forward');
  $('#hzwp-r').onclick = () => send('reload');
  $('#hzwp-country').onchange = e => window.__hzwp.cmd('country', e.target.value);
  const setUrl = u => { $('#hzwp-url').textContent = u || ''; try { document.title = u || 'Web Proxy'; } catch {} };

  // ---------- captcha ----------
  function showCaptcha(on) { $('#hzwp-cap').style.display = on ? 'grid' : 'none'; }
  function needCaptcha() {
    note('needsCaptcha', true); note('phase', 'captcha');
    showCaptcha(true);
    if (capResolvers.length) return;
    const st = $('#hzwp-capst');
    const g = () => {
      try {
        if (!window.grecaptcha || !window.grecaptcha.render) { st.textContent = T.failed; return; }
        capWidget = window.grecaptcha.render($('#hzwp-widget'), {
          sitekey: S.captchaSiteKey,
          callback: t => { const rs = capResolvers; capResolvers = []; st.textContent = ''; rs.forEach(r => r(t)); },
          'expired-callback': () => { st.textContent = 'Verification expired — click again.'; },
          'error-callback': () => { st.textContent = 'Verification error — retry.'; }
        });
        st.textContent = '';
      } catch (e) { st.textContent = 'Verification failed to render: ' + e.message; }
    };
    if (window.grecaptcha && window.grecaptcha.render) return void g();
    const sc = document.createElement('script');
    sc.src = 'https://www.google.com/recaptcha/api.js?render=explicit&onload=__hzwpCapReady';
    sc.async = true; sc.onerror = () => { st.textContent = 'Could not load verification.'; };
    window.__hzwpCapReady = g;
    document.head.appendChild(sc);
  }
  const captchaToken = () => new Promise(res => { capResolvers.push(res); });

  // ---------- runtime iframe ----------
  function mountRuntime(url) {
    if (frame) { try { frame.remove(); } catch {} frame = null; }
    ready = false;
    pendingUrl = url || pendingUrl; // authorized once runtime posts 'ready'
    const f = document.createElement('iframe');
    f.id = 'hzwp-frame';
    f.title = 'Proxied browsing session';
    f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
    f.src = RT + '/index.html?' + new URLSearchParams({ parentOrigin: location.origin, channel: CHAN, protocolVersion: '1' });
    document.body.appendChild(f);
    frame = f;
  }
  async function authorize(url) {
    const a = await api('session/tickets', 'POST');
    engineId = uuid();
    send('start', { ticket: a.ticket, url, engineId, recovery: true });
  }
  window.addEventListener('message', e => {
    if (e.origin !== RT || !e.data || e.data.source !== 'shifter-runtime' || e.data.channel !== CHAN) return;
    const t = e.data.type;
    if (t === 'ready') {
      ready = true; note('phase', 'connecting');
      // runtime listener is live only now — mint a ticket and start
      if (pendingUrl) { const u = pendingUrl; pendingUrl = null; authorize(u).catch(err => { note('phase','error'); note('error', err.message); }); }
    }
    else if (t === 'url') { note('sessionUrl', e.data.url); setUrl(e.data.url); }
    else if (t === 'loading') note('phase', 'loading');
    else if (t === 'loaded') { note('phase', 'loaded'); }
    else if (t === 'error') { note('phase', 'error'); note('error', e.data.message || 'error'); }
    else if (t === 'proxy-failure') { note('phase', 'proxy-failure'); note('error', e.data.message || 'proxy failure'); recover(); }
  });
  async function recover() {
    try { await api('session/recover', 'POST', { revision: 0, url: S.sessionUrl || S.targetUrl, reason: 'runtime' }); } catch {}
    try {
      await api('session/reconnect', 'POST');
      await new Promise(r => setTimeout(r, 4000));
      const a = await api('session/tickets', 'POST');
      engineId = uuid();
      send('reconnect', { ticket: a.ticket, url: S.sessionUrl || S.targetUrl, engineId, recovery: true });
    } catch (e) { note('error', e.message); }
  }

  // ---------- session ----------
  async function createSession(country) {
    note('phase', 'verifying');
    const token = await captchaToken();
    note('phase', 'starting');
    const r = await api('sessions', 'POST', { country, captchaToken: token });
    if (r.credential) { credential = r.credential; store.set(r.credential); }
    if (r.session && r.session.status === 'active' && r.session.country !== country)
      await api('session/country', 'POST', { country });
    return r.session;
  }
  async function boot() {
    try {
      cfg = await api('config');
      S.countries = cfg.countries || [];
      S.captchaSiteKey = cfg.captchaSiteKey;
      const sel = $('#hzwp-country');
      sel.innerHTML = S.countries.map(c => '<option value="' + c.code + '"' + (c.code === S.country ? ' selected' : '') + '>' + c.name + '</option>').join('');
      if (credential) {
        try {
          const s = await api('session');
          if (s && (s.status === 'active' || s.connected)) {
            S.sessionStatus = s.status; S.remaining = s.remainingSeconds || null;
            if (s.country !== S.country) {
              note('phase', 'switching');
              await api('session/country', 'POST', { country: S.country });
              await new Promise(r => setTimeout(r, 1400));
            }
            mountRuntime(S.targetUrl);
            return;
          }
        } catch (e) { /* fall through to fresh session */ }
      }
      needCaptcha();
      const s = await createSession(S.country);
      S.sessionStatus = s && s.status;
      S.remaining = (s && s.remainingSeconds) || null;
      note('needsCaptcha', false);
      showCaptcha(false);
      mountRuntime(S.targetUrl);
    } catch (e) {
      note('phase', 'error'); note('error', e.message);
      if (e.code === 'CAPTCHA_REJECTED') { needCaptcha(); const st = $('#hzwp-capst'); if (st) st.textContent = T.failed; const s2 = await createSession(S.country); S.sessionStatus = s2 && s2.status; S.remaining = (s2 && s2.remainingSeconds) || null; note('needsCaptcha', false); showCaptcha(false); mountRuntime(S.targetUrl); }
      else if (!S.captchaSiteKey && bootFails < 4) { bootFails++; await new Promise(r => setTimeout(r, 2500)); return boot(); }
      else if (e.code !== 'AUTH_REQUIRED') { needCaptcha(); }
    }
  }
  // keep session state fresh
  setInterval(async () => {
    if (!credential) return;
    try { const s = await api('session'); if (s) { S.sessionStatus = s.status; S.remaining = s.remainingSeconds || S.remaining; } }
    catch (e) { if (e.code === 'AUTH_REQUIRED' || e.code === 'NO_SESSION' || /ended/i.test(e.message || '')) { note('sessionStatus', 'ended'); if (!S.needsCaptcha) boot(); } }
  }, 30000);

  // ---------- control surface ----------
  window.__hzwp = {
    v: 1,
    get: () => ({ phase: S.phase, country: S.country, url: S.sessionUrl || S.targetUrl,
                  error: S.error, ready, started, remaining: S.remaining,
                  sessionStatus: S.sessionStatus, needsCaptcha: S.needsCaptcha }),
    cmd: async (c, a) => {
      if (c === 'go') { S.targetUrl = a; if (ready) send('go', { url: a }); else pendingUrl = a; return 'sent'; }
      if (['back', 'forward', 'reload'].includes(c)) { send(c); return 'sent'; }
      if (c === 'country') {
        const code = String(a).toLowerCase();
        if (!S.countries.some(x => x.code === code)) throw new Error('unknown country ' + code);
        S.country = code;
        const sel = $('#hzwp-country'); if (sel) sel.value = code;
        $('#hzwp-flag').src = 'https://shifter.io/images/flags/' + code + '.svg';
        if (credential) {
          note('phase', 'switching');
          try {
            await api('session/country', 'POST', { country: code });
            await new Promise(r => setTimeout(r, 1400));
            mountRuntime(S.sessionUrl || S.targetUrl);
          } catch (e) {
            if (/ended|NO_SESSION|AUTH/i.test(e.message || '')) {
              credential = null; store.del(); note('phase', 'restarting'); boot();
              return 'restarting';
            }
            throw e;
          }
        }
        return 'switched';
      }
      if (c === 'capbox') {
        const f = document.querySelector('#hzwp-widget iframe');
        const st = ($('#hzwp-capst') || {}).textContent || '';
        const frames = [...document.querySelectorAll('iframe')].map(x => (x.src || '').slice(0, 90));
        const bf = [...document.querySelectorAll('iframe')].find(x => /bframe/.test(x.src || ''));
        const bbox = bf ? (r => ({ x: r.x, y: r.y, w: r.width, h: r.height }))(bf.getBoundingClientRect()) : null;
        if (!f) return { box: null, bframe: bbox, st, frames, grecaptcha: !!window.grecaptcha };
        const r = f.getBoundingClientRect();
        return { box: { x: r.x, y: r.y, w: r.width, h: r.height }, bframe: bbox, st, frames };
      }
      if (c === 'at') {
        const el = document.elementFromPoint(a.x, a.y);
        return el ? { tag: el.tagName, id: el.id || '', cls: (el.className || '').toString().slice(0, 60), src: (el.src || '').slice(0, 80) } : null;
      }
      if (c === 'clickprobe') {
        if (!window.__hzclicks) {
          window.__hzclicks = [];
          document.addEventListener('mousedown', e => window.__hzclicks.push(['d', e.clientX, e.clientY, e.isTrusted]), true);
          document.addEventListener('mouseup', e => window.__hzclicks.push(['u', e.clientX, e.clientY, e.isTrusted]), true);
        }
        return window.__hzclicks.slice(-12);
      }
      if (c === 'stop') { try { await api('session', 'DELETE'); } catch {} try { send('clear'); } catch {} return 'stopped'; }
      if (c === 'restart') { credential = null; store.del(); needCaptcha(); const s = await createSession(S.country); S.sessionStatus = s && s.status; showCaptcha(false); mountRuntime(S.sessionUrl || S.targetUrl); return 'restarted'; }
      throw new Error('unknown cmd ' + c);
    }
  };
  $('#hzwp-badge').textContent = 'Shifter residential';
  started = true;
  boot();
  return 'installed';
})()
`;

function isHost(url) { try { return new URL(url).origin === HOST_ORIGIN; } catch { return false; } }

class WebProxy {
  constructor({ tabs, broadcast }) {
    this.tabs = tabs;
    this.broadcast = broadcast || (() => {});
    this.sessions = new Map(); // tabId -> {country, url, phase}
    this._countries = null;
  }
  tab(id) {
    const t = this.tabs.tabs.get(Number(id)) || this.tabs.tabs.get(id);
    if (!t) throw new Error('no such tab ' + id);
    return t;
  }
  isProxyTab(id) { return this.sessions.has(Number(id)) || this.sessions.has(id); }

  async countries() {
    if (this._countries) return this._countries;
    const r = await fetch(API + 'config', { headers: { Origin: HOST_ORIGIN, Referer: HOST_PAGE } });
    const d = await r.json();
    this._countries = { countries: d.countries || [], fetchedAt: Date.now() };
    return this._countries;
  }

  // Open a proxy tab: host page on shifter.io + injected controller.
  async open({ url, country = 'us' } = {}) {
    url = String(url || '').trim();
    if (!url) throw new Error('url required');
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    country = String(country || 'us').toLowerCase();
    const tab = this.tabs.openTab(HOST_PAGE, true);
    const rec = { tabId: tab.id, country, url, phase: 'boot' };
    this.sessions.set(tab.id, rec);
    tab.webproxy = true;
    const inject = () => {
      if (tab.wc.isDestroyed()) return;
      if (!isHost(tab.wc.getURL())) return;
      const cfg = `window.__hzwpcfg=${JSON.stringify({ url, country })};`;
      const probe = `(function(){if(window.__hzwp)return 'already';try{return (eval(${JSON.stringify(CONTROLLER)}))}catch(e){return 'CTRLERR:'+String(e.stack||e.message).slice(0,400)}})()`;
      tab.wc.executeJavaScript(cfg + probe, true)
        .then(r => {
          if (typeof r === 'string' && r.startsWith('CTRLERR:')) { rec.phase = 'error'; rec.error = r; }
          else if (r !== 'already') rec.phase = 'installed';
          this.broadcast('webproxy-state', tab.id, r);
        })
        .catch(e => { rec.phase = 'error'; rec.error = e.message; });
    };
    // dom-ready fires per document; host page 302s (shifter.io/ → /cn), so
    // re-inject whenever a fresh host document reports ready.
    tab.wc.on('dom-ready', inject);
    tab.wc.on('did-navigate', () => setTimeout(inject, 300));
    // Route outer-page navigations into the proxied runtime instead —
    // omnibox entries on a proxy tab load through the residential exit.
    tab.wc.on('will-navigate', (e, u) => {
      if (!this.isProxyTab(tab.id)) return;
      if (isHost(u) || u.startsWith('about:')) return;
      e.preventDefault();
      this.nav(tab.id, u).catch(() => {});
    });
    tab.wc.on('destroyed', () => this.sessions.delete(tab.id));
    return { tabId: tab.id, url, country };
  }

  async cmd(id, c, a) {
    const t = this.tab(id);
    const r = await Promise.race([
      t.wc.executeJavaScript(
        `window.__hzwp ? window.__hzwp.cmd(${JSON.stringify(c)}, ${JSON.stringify(a)}) : Promise.reject(new Error('webproxy controller not installed'))`, true),
      new Promise((_, rej) => setTimeout(() => rej(new Error('webproxy cmd timeout')), 25000))
    ]);
    return r;
  }
  async nav(id, url) {
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    const rec = this.sessions.get(Number(id)) || this.sessions.get(id);
    if (rec) rec.url = url;
    return this.cmd(id, 'go', url);
  }
  back(id) { return this.cmd(id, 'back'); }
  forward(id) { return this.cmd(id, 'forward'); }
  reload(id) { return this.cmd(id, 'reload'); }
  setCountry(id, code) {
    const rec = this.sessions.get(Number(id)) || this.sessions.get(id);
    if (rec) rec.country = String(code).toLowerCase();
    return this.cmd(id, 'country', code);
  }
  async state(id) {
    const t = this.tab(id);
    const s = await Promise.race([
      t.wc.executeJavaScript(
        'window.__hzwp ? window.__hzwp.get() : Promise.resolve({phase:"no-controller"})', true),
      new Promise(res => setTimeout(() => res({ phase: 'stuck' }), 8000))
    ]);
    const rec = this.sessions.get(Number(id)) || this.sessions.get(id) || {};
    return { tabId: t.id, proxy: true, ...rec, ...(s || {}) };
  }
  async stop(id) {
    try { await this.cmd(id, 'stop'); } catch {}
    this.sessions.delete(Number(id)); this.sessions.delete(id);
    try { this.tabs.closeTab(Number(id)); } catch {}
    return { stopped: true };
  }
  async list() {
    const out = [];
    for (const [id, rec] of this.sessions) out.push({ tabId: id, ...rec });
    return out;
  }
}

module.exports = { WebProxy, HOST_PAGE };
