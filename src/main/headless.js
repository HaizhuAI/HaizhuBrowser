'use strict';
// Headless lane — lightpanda-style fast/lean page execution for AI agents.
// A pool of standalone offscreen WebContents that never paint, composite or
// decode images; plus a "fast mode" flag that strips heavy resource types
// (image/font/media) from any session, including visible tabs.

const { webContents, session } = require('electron');

const HEAVY = new Set(['image', 'media', 'font']); // stylesheet optional per-call

class Headless {
  constructor(store, { onSession, hub }) {
    this.store = store;
    this.onSession = onSession; // wires hub.attach + stealth.attachSession like normal tabs
    this.hub = hub;
    this.pages = new Map(); // wcId -> {wc, url, title, openedAt, blocked}
    this.ses = null;
    this.fastSessions = new WeakSet(); // sessions with fast-mode resource blocking on
    this._wired = false;
  }

  session() {
    if (!this.ses) {
      this.ses = session.fromPartition('persist:hzheadless');
      if (this.onSession) this.onSession(this.ses);
      this.wireBlocking();
    }
    return this.ses;
  }

  // One hub subscriber for both lanes — fires only when fast mode is on for
  // the session, or the session is the dedicated headless lane.
  wireBlocking() {
    if (this._wired || !this.hub) return;
    this._wired = true;
    this.hub.on('before', (d, ses) => {
      if (!HEAVY.has(d.resourceType)) return;
      if (ses === this.ses || this.fastSessions.has(ses)) return { cancel: true };
    });
  }

  setFast(ses, on) {
    this.wireBlocking();
    on ? this.fastSessions.add(ses) : this.fastSessions.delete(ses);
    return this.fastSessions.has(ses);
  }
  isFast(ses) { return this.fastSessions.has(ses); }

  async open(opts = {}) {
    const wc = webContents.create({
      webPreferences: {
        session: this.session(),
        offscreen: true,               // no compositor/raster — the big win
        images: false,                 // skip decode entirely (block covers the rest)
        webgl: false,
        autoplayPolicy: 'user-gesture-required',
        backgroundThrottling: true,
        contextIsolation: true,
        sandbox: true
      }
    });
    wc.setAudioMuted(true);
    // never emit paint work — offscreen still rasterizes on capturePage only
    wc.setFrameRate(1);
    const rec = { wc, id: wc.id, url: '', title: '', openedAt: Date.now() };
    this.pages.set(wc.id, rec);
    wc.once('destroyed', () => this.pages.delete(wc.id));
    if (opts.url) {
      await wc.loadURL(opts.url).catch(e => { rec.error = e.message; });
      rec.url = wc.getURL(); rec.title = wc.getTitle();
    }
    return rec;
  }

  get(id) {
    const p = this.pages.get(Number(id)) || this.pages.get(id);
    if (!p) throw new Error('no such headless page ' + id);
    return p;
  }
  list() {
    return [...this.pages.values()].map(p => ({ id: p.id, url: p.url || p.wc.getURL(), title: p.wc.getTitle(), openedAt: p.openedAt, error: p.error || null }));
  }
  async close(id) {
    if (id === 'all') { const n = this.pages.size; for (const p of this.pages.values()) p.wc.destroy(); this.pages.clear(); return n; }
    const p = this.pages.get(Number(id)) || this.pages.get(id);
    if (!p) throw new Error('no such headless page ' + id);
    p.wc.destroy(); return 1;
  }
  async nav(id, url) {
    const p = this.get(id);
    await p.wc.loadURL(url);
    p.url = p.wc.getURL(); p.title = p.wc.getTitle();
    return { id, url: p.url, title: p.title };
  }
  async evalJs(id, code) {
    const wc = this.get(id).wc;
    let wrapped = `(function(){ ${code} })()`;
    try { new Function(`return (${code})`); wrapped = `(function(){ return (${code}) })()`; } catch {}
    const r = await wc.executeJavaScript(wrapped, true);
    return r === undefined ? '(undefined)' : JSON.stringify(r).slice(0, 20000);
  }
  async text(id) {
    return (await this.get(id).wc.executeJavaScript('document.body ? document.body.innerText.slice(0,20000) : ""', true)) || '';
  }
  async html(id) {
    return (await this.get(id).wc.executeJavaScript('document.documentElement ? document.documentElement.outerHTML.slice(0,30000) : ""', true)) || '';
  }
  async query(id, selector, limit = 20) {
    return this.get(id).wc.executeJavaScript(
      `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).slice(0,${limit}).map(e=>({tag:e.tagName,text:(e.innerText||'').slice(0,120),href:e.href||null,id:e.id||null,cls:e.className||null}))`, true);
  }
  async click(id, selector) {
    return this.get(id).wc.executeJavaScript(
      `(function(){const e=document.querySelector(${JSON.stringify(selector)});if(!e)return 'not found';e.scrollIntoView({block:'center'});e.click();return 'clicked'})()`, true);
  }
  async fill(id, selector, value) {
    return this.get(id).wc.executeJavaScript(
      `(function(){const e=document.querySelector(${JSON.stringify(selector)});if(!e)return 'not found';e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return 'filled'})()`, true);
  }
  async shot(id) {
    const img = await this.get(id).wc.capturePage(); // offscreen rasterizes on demand
    return img.toPNG();
  }
}

module.exports = { Headless };
