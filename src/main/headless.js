'use strict';
// Headless lane — lightpanda-style fast/lean page execution for AI agents.
// A pool of standalone offscreen WebContents that never paint, composite or
// decode images; plus a "fast mode" flag that strips heavy resource types
// (image/font/media) from any session, including visible tabs.
// obscura-derived: built-in tracker blocklist on the headless lane, SSRF
// private-network guard, bulk fetch (scrape command equivalent), markdown
// extraction and PDF export.

const { webContents, session } = require('electron');
const { toMarkdown } = require('./markdown');

const HEAVY = new Set(['image', 'media', 'font']); // stylesheet optional per-call

// Analytics/telemetry/fingerprinting endpoints — obscura's stealth blocklist
// idea, compacted to the high-value set. Headless lane blocks by default.
const TRACKERS = [
  'google-analytics.com', 'googletagmanager.com', 'googlesyndication.com',
  'doubleclick.net', 'googleadservices.com', 'analytics.google.com',
  'facebook.net', 'connect.facebook.net', 'graph.facebook.com',
  'hotjar.com', 'clarity.ms', 'mouseflow.com', 'crazyegg.com', 'fullstory.com',
  'segment.io', 'segment.com', 'mixpanel.com', 'amplitude.com', 'heap.io',
  'heapanalytics.com', 'sentry.io', 'newrelic.com', 'nr-data.net',
  'datadoghq.com', 'logrocket.com', 'pendo.io', 'intercom.io',
  'scorecardresearch.com', 'quantserve.com', 'chartbeat.com', 'parsely.com',
  'cdn.mxpnl.com', 'optimizely.com', 'vwo.com', 'stats.wp.com',
  'hm.baidu.com', 'cnzz.com', 'growingio.com', 'sensorsdata.cn',
  'mc.yandex.ru', 'mc.yandex.com', 'matomo.cloud', 'piwik.pro',
  'fpjs.io', 'cdn.fpjs.io', 'use.fathomanalytics.com', 'plausible.io',
  'ads-twitter.com', 'static.ads-twitter.com', 'analytics.twitter.com',
  'bat.bing.com', 'ads.linkedin.com', 'snap.licdn.com', 'px.ads.linkedin.com',
  'amazon-adsystem.com', 'adsystem.amazon.com', 'taboola.com', 'outbrain.com'
];
const TRACKER_RE = new RegExp(
  '(?:^|\\.)(' + TRACKERS.map(d => d.replace(/\./g, '\\.')).join('|') + ')(?::|/|$)', 'i');

function isPrivateHost(u) {
  try {
    const h = new URL(u).hostname;
    if (h === 'localhost' || h === '[::1]' || h === '::1') return true;
    const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (!m) return false;
    const [a, b] = [+m[1], +m[2]];
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) ||
           (a === 192 && b === 168) || (a === 169 && b === 254) || a === 0;
  } catch { return true; }
}

class Headless {
  constructor(store, { onSession, hub }) {
    this.store = store;
    this.onSession = onSession; // wires hub.attach + stealth.attachSession like normal tabs
    this.hub = hub;
    this.pages = new Map(); // wcId -> {wc, url, title, openedAt, blocked}
    this.ses = null;
    this.fastSessions = new WeakSet(); // sessions with fast-mode resource blocking on
    this._wired = false;
    this.blockTrackers = true;
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
  // the session, or the session is the dedicated headless lane. Headless lane
  // additionally drops tracker endpoints (obscura stealth blocklist).
  wireBlocking() {
    if (this._wired || !this.hub) return;
    this._wired = true;
    this.hub.on('before', (d, ses) => {
      if (ses === this.ses && d.url) {
        // SSRF: covers redirects and subresources — open()/nav() only guard
        // the first hop. Per-page allowPrivate opt-out still honored.
        const rec = d.webContentsId != null ? this.pages.get(d.webContentsId) : null;
        if (isPrivateHost(d.url) && !(rec && rec.allowPrivate)) return { cancel: true };
        if (this.blockTrackers && TRACKER_RE.test(d.url)) return { cancel: true };
      }
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
    if (opts.url && !opts.allowPrivate && isPrivateHost(opts.url)) {
      throw new Error('private/internal network blocked (pass allowPrivate to override)');
    }
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
    const rec = { wc, id: wc.id, url: '', title: '', openedAt: Date.now(), allowPrivate: !!opts.allowPrivate };
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
  async nav(id, url, opts = {}) {
    if (isPrivateHost(url) && !opts.allowPrivate && !this.get(id).allowPrivate) {
      throw new Error('private/internal network blocked');
    }
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
  async markdown(id) {
    return toMarkdown(this.get(id).wc);
  }
  async pdf(id, opts = {}) {
    const buf = await this.get(id).wc.printToPDF({
      printBackground: opts.printBackground !== false,
      landscape: !!opts.landscape,
      pageSize: opts.pageSize || 'A4',
      margins: opts.margins || { marginType: 'default' }
    });
    return buf;
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

  // obscura `scrape` equivalent — parallel one-shot fetches, each on its own
  // offscreen page, converging to {url,title,markdown|text,error}.
  async bulkFetch(urls, { concurrency = 4, timeout = 20000, format = 'markdown', allowPrivate = false } = {}) {
    const results = new Array(urls.length);
    let idx = 0;
    const worker = async () => {
      while (idx < urls.length) {
        const i = idx++;
        const url = urls[i];
        const t0 = Date.now();
        let rec = null;
        try {
          if (!allowPrivate && isPrivateHost(url)) throw new Error('private network blocked');
          rec = await this.open({ allowPrivate });
          await Promise.race([
            rec.wc.loadURL(url),
            new Promise((_, rj) => setTimeout(() => rj(new Error('timeout')), timeout))
          ]);
          const base = { url: rec.wc.getURL() || url, title: rec.wc.getTitle(), ms: Date.now() - t0 };
          if (format === 'markdown') base.markdown = (await toMarkdown(rec.wc)).markdown;
          else base.text = await rec.wc.executeJavaScript('document.body?document.body.innerText.slice(0,20000):""', true);
          results[i] = base;
        } catch (e) {
          results[i] = { url, error: e.message, ms: Date.now() - t0 };
        } finally {
          if (rec) try { rec.wc.destroy(); } catch {}
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, worker));
    return results;
  }
}

module.exports = { Headless };
