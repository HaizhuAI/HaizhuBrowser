'use strict';
// CaptureEngine — real-time packet capture per tab via the Chrome DevTools
// Protocol. Feeds a DevTools-like Network panel (method, url, status, type,
// size, timing, request/response headers, bodies) and powers the resource
// sniffer (m3u8/mp4/mpd/media detection) plus HAR export.

const fs = require('fs');
const path = require('path');
const { app, net } = require('electron');

const MEDIA_EXT = /\.(m3u8|mpd|mp4|webm|mkv|flv|ts|m4s|mp3|m4a|aac|ogg|wav|avi|mov)(\?|$)/i;
const MEDIA_TYPES = /mpegurl|mp2t|dash|video\/|audio\//i;

class TabCapture {
  constructor(webContents) {
    this.wc = webContents;
    this.dbg = webContents.debugger;
    this.entries = new Map();
    this.cdpMap = new Map(); // cdp requestId -> entry (twin or own)
    this.order = [];
    this.enabled = false;
    this.listeners = new Set();
    this.max = 2000;
  }
  async start() {
    if (this.enabled) return;
    this.enabled = true;
    // Cross-site navigation swaps the renderer (site isolation) and the
    // debugger detaches with it — auto re-attach so capture survives it.
    if (!this._detachHooked) {
      this._detachHooked = true;
      this.dbg.on('detach', () => { if (this.enabled) this._attach(); });
    }
    // CDP enrichment is best-effort — webRequest ingest is the primary
    // source, so never let a hung attach block the toggle.
    this._attach();
  }
  async _attach() {
    if (this._attaching) return;
    this._attaching = true;
    try {
      try { this.dbg.attach('1.3'); } catch (e) { if (!/already attached/.test(e.message)) return; }
      if (!this._msgHooked) {
        this._msgHooked = true;
        this.dbg.on('message', (t, m, p) => this.onEvent(m, p));
      }
      const cmd = (n, p) => Promise.race([
        this.dbg.sendCommand(n, p),
        new Promise((_, rej) => setTimeout(() => rej(new Error('cdp timeout')), 5000))
      ]);
      // Enable domains in parallel with independent timeouts — a lost
      // response on one (renderer swap eats the reply) must not block
      // the others.
      const TEXT_STAGES = ['Document', 'Script', 'Stylesheet', 'XHR', 'Fetch'];
      await Promise.allSettled([
        cmd('Network.enable', { maxPostDataSize: 1024 * 512 }),
        cmd('Page.enable', {}),
        // Fetch interception: pause text-ish responses so the body can be
        // pulled before Chromium reclaims it (Network.getResponseBody loses
        // main-frame docs early). Fiddler-style capture, capture-mode only.
        cmd('Fetch.enable', {
          patterns: TEXT_STAGES.map(resourceType => ({ requestStage: 'Response', resourceType }))
        })
      ]);
    } catch (e) { if (process.env.HZ_DEBUG) console.error('[cap] attach', e.message); }
    finally { this._attaching = false; }
  }
  async stop() {
    if (!this.enabled) return;
    this.enabled = false;
    try { await this.dbg.sendCommand('Network.disable', {}); await this.dbg.sendCommand('Fetch.disable', {}); this.dbg.detach(); } catch (e) {}
  }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(ev, data) { for (const f of this.listeners) { try { f(ev, data); } catch (e) {} } }
  // ----- session webRequest ingest (browser-level; sees every request
  // incl. main frame — immune to renderer/agent quirks) -----
  static RESTYPE = { mainFrame: 'Document', subFrame: 'Document', stylesheet: 'Stylesheet', script: 'Script', image: 'Image', font: 'Font', object: 'Object', xhr: 'XHR', ping: 'Ping', cspReport: 'CSPReport', media: 'Media', webSocket: 'WebSocket', other: 'Other' };
  static HTTP_TEXT = { 200: 'OK', 201: 'Created', 204: 'No Content', 206: 'Partial Content', 301: 'Moved Permanently', 302: 'Found', 304: 'Not Modified', 307: 'Temporary Redirect', 308: 'Permanent Redirect', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable' };
  ingest(phase, d) {
    if (process.env.HZ_DEBUG && phase === 'before') console.error('[cap-wr]', d.id, d.resourceType, d.method, d.url.slice(0, 60));
    const key = 'wr' + d.id;
    let e = this.entries.get(key);
    switch (phase) {
      case 'before':
        e = {
          id: key, url: d.url, method: d.method,
          type: TabCapture.RESTYPE[d.resourceType] || 'Other',
          requestHeaders: null, postData: null,
          started: d.timestamp / 1e6, wallTime: Date.now() / 1000,
          status: null, responseHeaders: null, mimeType: '', size: 0,
          encodedSize: 0, time: 0, body: null, remote: '', cdpId: null
        };
        // CDP requestWillBeSent may have arrived first — adopt that entry
        // (merge its cdpId/enrichment into this wr row, drop the dupe).
        for (let i = this.order.length - 1; i >= 0 && i > this.order.length - 80; i--) {
          const c = this.entries.get(this.order[i]);
          if (c && !String(c.id).startsWith('wr') && c.url === d.url && !c.wrId) {
            e.cdpId = c.cdpId || c.id;
            this.cdpMap.set(e.cdpId, e);
            e.postData = c.postData; e.requestHeaders = c.requestHeaders || e.requestHeaders;
            e.started = c.started; e.wallTime = c.wallTime;
            if (c.type && c.type !== 'Other') e.type = c.type;
            if (c.remote) e.remote = c.remote;
            c.wrId = key; this.entries.delete(c.id); this.order.splice(i, 1);
            break;
          }
        }
        if (!this.entries.has(key)) this.order.push(key);
        this.entries.set(key, e);
        if (this.order.length > this.max) { const old = this.order.shift(); this.entries.delete(old); }
        this.emit('request', e);
        break;
      case 'sendHeaders': if (e) { e.requestHeaders = d.requestHeaders; } break;
      case 'headers': if (e) {
        e.status = d.statusCode; e.statusText = TabCapture.HTTP_TEXT[d.statusCode] || '';
        e.responseHeaders = d.responseHeaders; e.fromCache = d.fromCache;
        const ct = Object.entries(d.responseHeaders || {}).find(([k]) => /content-type/i.test(k));
        if (ct) e.mimeType = String(ct[1][0] || ct[1]).split(';')[0].trim();
        this.emit('response', e);
      } break;
      case 'redirect': if (e) { e.status = d.statusCode; e.redirectURL = d.redirectURL; } break;
      case 'completed': if (e) {
        e.time = d.timestamp / 1e6 - e.started;
        if (d.ip) e.remote = d.ip;
        e.fromCache = d.fromCache;
        this.emit('finished', e);
      } break;
      case 'error': if (e) { e.failed = true; e.errorText = d.error; this.emit('failed', e); } break;
    }
  }
  // Correlate a CDP request to its webRequest twin (same url, still unlinked).
  _linkCdp(p) {
    const url = p.request.url;
    for (let i = this.order.length - 1; i >= 0 && i > this.order.length - 60; i--) {
      const e = this.entries.get(this.order[i]);
      if (e && !e.cdpId && e.url === url && String(e.id).startsWith('wr')) { e.cdpId = p.requestId; this.cdpMap.set(p.requestId, e); return e; }
    }
    return null;
  }
  onEvent(method, p) {
    if (process.env.HZ_DEBUG) console.error('[cap-ev]', method, (p.requestId || '').slice(0, 8), (p.request && p.request.url || (p.response && p.response.url) || '').slice(0, 70));
    switch (method) {
      case 'Network.requestWillBeSent': {
        // merge into webRequest twin when present (enriches postData/timing)
        const twin = this._linkCdp(p);
        const e = twin || {
          id: p.requestId, url: p.request.url, method: p.request.method,
          type: p.type || 'Other', requestHeaders: p.request.headers,
          postData: p.request.postData, started: p.timestamp, wallTime: p.wallTime,
          status: null, responseHeaders: null, mimeType: '', size: 0,
          encodedSize: 0, time: 0, body: null, remote: p.request.remoteIPAddress || '', cdpId: p.requestId
        };
        if (twin) {
          twin.postData = p.request.postData || twin.postData;
          twin.requestHeaders = p.request.headers || twin.requestHeaders;
          twin.started = p.timestamp; twin.wallTime = p.wallTime;
          if (p.type) twin.type = p.type;
          if (p.request.remoteIPAddress) twin.remote = p.request.remoteIPAddress;
        }
        this.entries.set(e.id, e);
        this.cdpMap.set(p.requestId, e);
        if (!twin) { this.order.push(e.id); if (this.order.length > this.max) { const old = this.order.shift(); this.entries.delete(old); } }
        this.emit('request', e);
        break;
      }
      case 'Network.responseReceived': {
        const e = this.cdpMap.get(p.requestId) || this.entries.get(p.requestId); if (!e) break;
        e.status = p.response.status; e.statusText = p.response.statusText;
        e.responseHeaders = p.response.headers; e.mimeType = p.response.mimeType;
        e.remote = p.response.remoteIPAddress + ':' + p.response.remotePort;
        e.timing = p.response.timing; e.protocol = p.response.protocol;
        e.encodedSize = p.response.encodedDataLength;
        this.emit('response', e);
        break;
      }
      case 'Network.dataReceived': {
        const e = this.cdpMap.get(p.requestId) || this.entries.get(p.requestId); if (!e) break;
        e.encodedSize += p.dataLength;
        break;
      }
      case 'Network.loadingFinished': {
        const e = this.cdpMap.get(p.requestId) || this.entries.get(p.requestId); if (!e) break;
        e.time = (p.timestamp - e.started) * 1000;
        e.encodedSize = p.encodedDataLength || e.encodedSize;
        this.emit('finished', e);
        this._eagerBody(e);
        break;
      }
      case 'Fetch.requestPaused': {
        // Response paused at interception point — grab the body now while
        // it is guaranteed alive, then let the request continue.
        const rid = p.requestId;
        // Paused ids are interception job ids, not Network request ids —
        // match the newest entry for this URL that still lacks a body.
        let e = this.cdpMap.get(rid) || this.entries.get(rid);
        if (!e && p.request && p.request.url) {
          for (let i = this.order.length - 1; i >= 0 && i > this.order.length - 80; i--) {
            const c = this.entries.get(this.order[i]);
            if (c && c.url === p.request.url && c.body == null) { e = c; break; }
          }
        }
        if (process.env.HZ_DEBUG) console.error('[cap] paused', p.request && p.request.url ? p.request.url.slice(0, 60) : '?', 'e=', !!e);
        (async () => {
          try {
            const hdrs = p.responseHeaders || [];
            if (e && p.responseStatusCode && e.status == null) {
              e.status = p.responseStatusCode;
              e.responseHeaders = e.responseHeaders || {};
              for (const h of hdrs) (e.responseHeaders[h.name] = e.responseHeaders[h.name] || []).push(h.value);
            }
            const ct = hdrs.find(h => /^content-type$/i.test(h.name));
            const cl = hdrs.find(h => /^content-length$/i.test(h.name));
            const mime = ct ? String(ct.value).split(';')[0].trim() : '';
            const tooBig = cl && parseInt(cl.value, 10) > 2 * 1024 * 1024;
            const texty = /text|json|javascript|ecmascript|xml|html|css|urlencoded|svg|manifest|mpegurl|wasm/i.test(mime);
            if (e && texty && !tooBig && (this.bodyBytes || 0) < 64 * 1024 * 1024) {
              const r = await this.dbg.sendCommand('Fetch.getResponseBody', { requestId: rid });
              e.body = r.base64Encoded ? Buffer.from(r.body, 'base64') : r.body;
              if (mime && !e.mimeType) e.mimeType = mime;
              this.bodyBytes = (this.bodyBytes || 0) + (e.body.length || 0);
              if (process.env.HZ_DEBUG) console.error('[cap] fetch-body', e.body.length, e.url.slice(0, 60));
            }
          } catch (err) { /* body not retrievable — continue anyway */ }
          try { await this.dbg.sendCommand('Fetch.continueRequest', { requestId: rid }); } catch (err) {}
        })();
        break;
      }
      case 'Network.loadingFailed': {
        const e = this.cdpMap.get(p.requestId) || this.entries.get(p.requestId); if (!e) break;
        e.failed = true; e.errorText = p.errorText;
        this.emit('failed', e);
        break;
      }
    }
  }
  // Chromium evicts response bodies quickly — grab text-ish bodies at
  // loadingFinished while the resource is still alive, capped per-entry
  // (2MB) and in total (64MB) so capture stays cheap.
  async _eagerBody(e) {
    const TEXT = /text|json|javascript|ecmascript|xml|html|css|urlencoded|svg|manifest|mpegurl/i;
    if (process.env.HZ_DEBUG) console.error('[cap] eager?', e.mimeType, e.encodedSize, e.url && e.url.slice(0, 60));
    if (!e.mimeType || !TEXT.test(e.mimeType)) return;
    if ((e.encodedSize || 0) > 2 * 1024 * 1024) return;
    if ((this.bodyBytes || 0) > 64 * 1024 * 1024) return;
    const b = await this.body(e.cdpId || e.id);
    if (b != null) { e.body = b; this.bodyBytes = (this.bodyBytes || 0) + (b.length || 0); }
  }
  async body(id) {
    const e = this.entries.get(id) || this.cdpMap.get(id);
    if (e && e.body != null) return e.body;
    const reqId = e && e.cdpId ? e.cdpId : id;
    try {
      const r = await Promise.race([
        this.dbg.sendCommand('Network.getResponseBody', { requestId: reqId }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('cdp timeout')), 4000))
      ]);
      return r.base64Encoded ? Buffer.from(r.body, 'base64') : r.body;
    } catch (err) { if (process.env.HZ_DEBUG) console.error('[cap] body', id, err.message); return null; }
  }
  list() { return this.order.map(id => this.entries.get(id)); }
  resources() {
    return this.list().filter(e =>
      MEDIA_EXT.test(e.url) || (e.mimeType && MEDIA_TYPES.test(e.mimeType)) ||
      /m3u8|mpd|manifest|playlist/i.test(e.url));
  }
  har() {
    return {
      log: {
        version: '1.2', creator: { name: 'Haizhu Browser', version: '1.0.0' },
        pages: [], entries: this.list().map(e => ({
          startedDateTime: new Date((e.wallTime || Date.now() / 1000) * 1000).toISOString(),
          time: e.time || 0,
          request: { method: e.method, url: e.url, headers: Object.entries(e.requestHeaders || {}).map(([name, value]) => ({ name, value })), postData: e.postData ? { text: e.postData } : undefined },
          response: { status: e.status || 0, statusText: e.statusText || '', headers: Object.entries(e.responseHeaders || {}).map(([name, value]) => ({ name, value })), content: { size: e.encodedSize, mimeType: e.mimeType } },
          timings: e.timing || {}
        }))
      }
    };
  }
}

class CaptureManager {
  constructor() { this.sessions = new Map(); }
  get(wc) {
    let c = this.sessions.get(wc.id);
    if (!c) { c = new TabCapture(wc); this.sessions.set(wc.id, c); wc.once('destroyed', () => this.sessions.delete(wc.id)); }
    return c;
  }
  // One call per session — routes webRequest events to per-tab captures.
  attachSession(hub) {
    for (const phase of ['before', 'sendHeaders', 'headers', 'redirect', 'completed', 'error']) {
      hub.on(phase, d => {
        const c = this.sessions.get(d.webContentsId);
        if (c && c.enabled) c.ingest(phase, d);
      });
    }
  }
  async toggle(wc) {
    const c = this.get(wc);
    c.enabled ? await c.stop() : await c.start();
    return c.enabled;
  }
}

// ---------- resource sniffer (session-level, webRequest) ----------
class ResourceSniffer {
  constructor() { this.byTab = new Map(); this.listeners = new Set(); }
  attach(hub) {
    hub.on('completed', d => {
      const hit = MEDIA_EXT.test(d.url) || (d.responseHeaders && Object.entries(d.responseHeaders).some(([k, v]) => /content-type/i.test(k) && MEDIA_TYPES.test(String(v))));
      if (!hit) return;
      const rec = { url: d.url, type: this.kindOf(d.url), ts: Date.now(), tabId: d.webContentsId, status: d.statusCode,
        mime: this.mimeOf(d), size: this.sizeOf(d), method: d.method };
      const arr = this.byTab.get(d.webContentsId) || [];
      if (!arr.some(r => r.url === rec.url)) arr.unshift(rec);
      if (arr.length > 500) arr.pop();
      this.byTab.set(d.webContentsId, arr);
      for (const f of this.listeners) { try { f(rec); } catch (e) {} }
    });
  }
  kindOf(url) {
    const m = /\.([a-z0-9]{2,5})(\?|$)/i.exec(url);
    if (!m) return 'media';
    const ext = m[1].toLowerCase();
    if (ext === 'm3u8') return 'hls';
    if (ext === 'mpd') return 'dash';
    if (['mp4', 'webm', 'mkv', 'flv', 'avi', 'mov'].includes(ext)) return 'video';
    if (['mp3', 'm4a', 'aac', 'ogg', 'wav'].includes(ext)) return 'audio';
    if (['ts', 'm4s'].includes(ext)) return 'segment';
    return ext;
  }
  mimeOf(d) {
    const h = d.responseHeaders || {};
    for (const k of Object.keys(h)) if (/content-type/i.test(k)) return String(h[k][0] || h[k]);
    return '';
  }
  sizeOf(d) {
    const h = d.responseHeaders || {};
    for (const k of Object.keys(h)) if (/content-length/i.test(k)) return parseInt(h[k][0] || h[k], 10) || 0;
    return 0;
  }
  onFound(fn) { this.listeners.add(fn); }
  list(tabId) { return this.byTab.get(tabId) || []; }
  clear(tabId) { this.byTab.delete(tabId); }
}

// ---------- m3u8 downloader ----------
class M3U8Downloader {
  constructor(downloadDir) {
    this.dir = downloadDir || path.join(app.getPath('downloads'), 'haizhu-media');
    fs.mkdirSync(this.dir, { recursive: true });
    this.jobs = new Map();
  }
  async download(url, name, onProgress) {
    const jobId = crypto.randomBytes(8).toString('hex');
    const job = { id: jobId, url, name, status: 'running', total: 0, done: 0, file: null, error: null };
    this.jobs.set(jobId, job);
    const progress = (d, t) => { job.done = d; job.total = t; onProgress && onProgress(job); };
    this._run(job, progress).catch(e => { job.status = 'error'; job.error = e.message; });
    return job;
  }
  async _run(job, progress) {
    const res = await net.fetch(job.url);
    if (!res.ok) throw new Error('playlist HTTP ' + res.status);
    const text = await res.text();
    const base = job.url.slice(0, job.url.lastIndexOf('/') + 1);
    // master playlist -> pick highest bandwidth variant
    if (/EXT-X-STREAM-INF/.test(text)) {
      const lines = text.split('\n'); let best = null, bw = -1;
      for (let i = 0; i < lines.length; i++) {
        const m = /BANDWIDTH=(\d+)/.exec(lines[i]);
        if (m && lines[i + 1] && !lines[i + 1].startsWith('#')) {
          const b = parseInt(m[1], 10);
          if (b > bw) { bw = b; best = new URL(lines[i + 1].trim(), job.url).href; }
        }
      }
      if (best) { job.url = best; return this._run(job, progress); }
    }
    const segs = [];
    for (const line of text.split('\n')) {
      const l = line.trim();
      if (!l || l.startsWith('#')) continue;
      segs.push(new URL(l, base).href);
    }
    if (!segs.length) throw new Error('no segments in playlist');
    const fname = (job.name || 'video').replace(/[^\w\-.\u4e00-\u9fff]+/g, '_') + '.ts';
    const fpath = path.join(this.dir, job.id + '_' + fname);
    const out = fs.createWriteStream(fpath);
    const CONC = 6;
    const chunks = new Array(segs.length);
    let idx = 0, written = 0;
    progress(0, segs.length);
    const worker = async () => {
      while (idx < segs.length) {
        const i = idx++;
        const r = await net.fetch(segs[i]);
        if (!r.ok) throw new Error('seg ' + i + ' HTTP ' + r.status);
        chunks[i] = Buffer.from(await r.arrayBuffer());
        // ordered flush: write every contiguous finished run
        while (written < chunks.length && chunks[written]) {
          out.write(chunks[written]); chunks[written] = null; written++;
          progress(written, segs.length);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONC, segs.length) }, worker));
    out.end();
    await new Promise(r => out.on('finish', r));
    job.status = 'done'; job.file = fpath; job.done = job.total = segs.length;
  }
  list() { return [...this.jobs.values()].map(j => ({ ...j })); }
}

module.exports = { CaptureManager, ResourceSniffer, M3U8Downloader, MEDIA_EXT };
