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
    this.order = [];
    this.enabled = false;
    this.listeners = new Set();
    this.max = 2000;
  }
  async start() {
    if (this.enabled) return;
    try { this.dbg.attach('1.3'); } catch (e) { if (!/already attached/.test(e.message)) throw e; }
    this.dbg.on('message', (t, m, p) => this.onEvent(m, p));
    await this.dbg.sendCommand('Network.enable', { maxPostDataSize: 1024 * 512 });
    await this.dbg.sendCommand('Page.enable', {});
    this.enabled = true;
  }
  async stop() {
    if (!this.enabled) return;
    try { await this.dbg.sendCommand('Network.disable', {}); this.dbg.detach(); } catch (e) {}
    this.enabled = false;
  }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(ev, data) { for (const f of this.listeners) { try { f(ev, data); } catch (e) {} } }
  onEvent(method, p) {
    switch (method) {
      case 'Network.requestWillBeSent': {
        const e = {
          id: p.requestId, url: p.request.url, method: p.request.method,
          type: p.type || 'Other', requestHeaders: p.request.headers,
          postData: p.request.postData, started: p.timestamp, wallTime: p.wallTime,
          status: null, responseHeaders: null, mimeType: '', size: 0,
          encodedSize: 0, time: 0, body: null, remote: p.request.remoteIPAddress || ''
        };
        this.entries.set(p.requestId, e);
        this.order.push(p.requestId);
        if (this.order.length > this.max) { const old = this.order.shift(); this.entries.delete(old); }
        this.emit('request', e);
        break;
      }
      case 'Network.responseReceived': {
        const e = this.entries.get(p.requestId); if (!e) break;
        e.status = p.response.status; e.statusText = p.response.statusText;
        e.responseHeaders = p.response.headers; e.mimeType = p.response.mimeType;
        e.remote = p.response.remoteIPAddress + ':' + p.response.remotePort;
        e.timing = p.response.timing; e.protocol = p.response.protocol;
        e.encodedSize = p.response.encodedDataLength;
        this.emit('response', e);
        break;
      }
      case 'Network.dataReceived': {
        const e = this.entries.get(p.requestId); if (!e) break;
        e.encodedSize += p.dataLength;
        break;
      }
      case 'Network.loadingFinished': {
        const e = this.entries.get(p.requestId); if (!e) break;
        e.time = (p.timestamp - e.started) * 1000;
        e.encodedSize = p.encodedDataLength || e.encodedSize;
        this.emit('finished', e);
        break;
      }
      case 'Network.loadingFailed': {
        const e = this.entries.get(p.requestId); if (!e) break;
        e.failed = true; e.errorText = p.errorText;
        this.emit('failed', e);
        break;
      }
    }
  }
  async body(id) {
    try {
      const r = await this.dbg.sendCommand('Network.getResponseBody', { requestId: id });
      return r.base64Encoded ? Buffer.from(r.body, 'base64') : r.body;
    } catch (e) { return null; }
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
  async toggle(wc) {
    const c = this.get(wc);
    c.enabled ? await c.stop() : await c.start();
    return c.enabled;
  }
}

// ---------- resource sniffer (session-level, webRequest) ----------
class ResourceSniffer {
  constructor() { this.byTab = new Map(); this.listeners = new Set(); }
  attach(ses) {
    ses.webRequest.onCompleted({ urls: ['<all_urls>'] }, d => {
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
    ses.webRequest.onBeforeRequest({ urls: ['*://*/*.m3u8*', '*://*/*.mpd*'] }, (d, cb) => {
      cb({});
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
