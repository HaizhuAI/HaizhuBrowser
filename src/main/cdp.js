'use strict';
// CDP endpoint — obscura-style Chrome DevTools Protocol surface so external
// clients (Puppeteer / Playwright connectOverCDP / raw CDP) can drive real
// tabs and the headless lane. Implemented as an in-process WS+HTTP server on
// 127.0.0.1 translating into webContents.debugger — NO --remote-debugging-port
// (which sets a detectable internal flag and is a known anti-bot probe).
//
// Stealth note: Runtime.enable IS forwarded on attached sessions — full client
// compat (real execution contexts, isolated worlds, object ids). Tradeoff: an
// attached debugger session has the usual automation-visible surface; leave the
// endpoint off for manual anti-bot browsing. We never open Chromium's own
// --remote-debugging-port (that one sets a detectable internal flag).

const http = require('http');
const crypto = require('crypto');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const CHROME_VER = '140.0.7339.133';

// ---------- minimal RFC6455 (text frames only — CDP is JSON) ----------
function wsAccept(key) {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}
function wsSend(sock, str) {
  const p = Buffer.from(str, 'utf8');
  const n = p.length;
  let head;
  if (n < 126) { head = Buffer.from([0x81, n]); }
  else if (n < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 126; head.writeUInt16BE(n, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 127; head.writeBigUInt64BE(BigInt(n), 2); }
  sock.write(Buffer.concat([head, p]));
}
function wsPump(sock, onText, onClose) {
  let buf = Buffer.alloc(0), frags = [];
  sock.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const fin = buf[0] & 0x80, op = buf[0] & 0x0f;
      const masked = buf[1] & 0x80;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const maskOff = off; if (masked) off += 4;
      if (buf.length < off + len) return;
      let payload = buf.slice(off, off + len);
      if (masked) { const m = buf.slice(maskOff, maskOff + 4); payload = Buffer.from(payload); for (let i = 0; i < payload.length; i++) payload[i] ^= m[i & 3]; }
      buf = buf.slice(off + len);
      if (op === 8) { onClose(); try { sock.end(); } catch {} return; }
      if (op === 9) { const pong = Buffer.from([0x8a, payload.length]); sock.write(Buffer.concat([pong, payload])); continue; }
      if (op === 0 || op === 1 || op === 2) {
        frags.push(payload);
        if (fin) { const msg = Buffer.concat(frags).toString('utf8'); frags = []; onText(msg); }
      }
    }
  });
  sock.on('close', onClose); sock.on('error', onClose);
}

class CdpServer {
  constructor({ tabs, headless, store }) {
    this.tabs = tabs;
    this.headless = headless;
    this.store = store;
    this.http = null;
    this.sessions = new Map(); // sessionId -> {sock, targetId}
    this.socks = new Set();
    this._sessN = 0;
    this._streamN = 0;
    this._streams = new Map(); // pseudo IO handles for printToPDF streams
    this._dbgWired = new Map(); // wcId -> wired sockets set bookkeeping
  }

  get port() { return (this.http && this.http.address()) ? this.http.address().port : 0; }

  targets() {
    const out = [];
    for (const t of this.tabs.tabs.values()) {
      const wc = t.wc;
      out.push({ id: 'page-' + wc.id, type: 'page', title: wc.getTitle(), url: wc.getURL() });
    }
    for (const p of (this.headless ? this.headless.list() : [])) {
      out.push({ id: 'hl-' + p.id, type: 'page', title: p.title || '', url: p.url || '', headless: true });
    }
    return out;
  }

  wcOf(targetId) {
    if (String(targetId).startsWith('hl-')) {
      try { return this.headless.get(targetId.slice(3)).wc; } catch { return null; }
    }
    const id = Number(String(targetId).replace(/^page-/, ''));
    for (const t of this.tabs.tabs.values()) {
      if (t.wc.id === id) return t.wc;
    }
    return null;
  }

  tabOf(targetId) {
    const id = Number(String(targetId).replace(/^page-/, ''));
    for (const t of this.tabs.tabs.values()) if (t.wc.id === id) return t;
    return null;
  }

  start(port = 9229) {
    this.stop();
    this.http = http.createServer((req, res) => this.onHttp(req, res));
    this.http.on('upgrade', (req, sock) => this.onUpgrade(req, sock));
    this.http.listen(port, '127.0.0.1');
    return this.http;
  }
  stop() {
    for (const s of this.socks) { try { s.destroy(); } catch {} }
    this.socks.clear(); this.sessions.clear();
    if (this.http) { try { this.http.close(); } catch {} this.http = null; }
  }

  // ---------- HTTP discovery endpoints ----------
  onHttp(req, res) {
    const u = new URL(req.url, 'http://x');
    const j = o => { const b = Buffer.from(JSON.stringify(o)); res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': b.length }); res.end(b); };
    const host = '127.0.0.1:' + this.port;
    if (u.pathname === '/json/version') return j({
      Browser: 'Chrome/' + CHROME_VER, 'Protocol-Version': '1.3',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' + CHROME_VER + ' Safari/537.36',
      'V8-Version': '14.0.365', 'WebKit-Version': '537.36',
      webSocketDebuggerUrl: 'ws://' + host + '/devtools/browser'
    });
    if (u.pathname === '/json/list' || u.pathname === '/json' || u.pathname === '/json/targets') {
      return j(this.targets().map(t => ({
        id: t.id, type: t.type, title: t.title, url: t.url,
        webSocketDebuggerUrl: 'ws://' + host + '/devtools/page/' + t.id,
        devtoolsFrontendUrl: '/devtools/inspector.html?ws=' + host + '/devtools/page/' + t.id
      })));
    }
    if (u.pathname === '/json/new') {
      const url = u.searchParams.get('url') || 'about:blank';
      this.tabs.openTab(url);
      setTimeout(() => {
        const all = this.targets(); const t = all[all.length - 1];
        j({ id: t.id, type: 'page', title: t.title, url: t.url, webSocketDebuggerUrl: 'ws://' + host + '/devtools/page/' + t.id });
      }, 150);
      return;
    }
    const m = u.pathname.match(/^\/json\/(close|activate)\/(.+)$/);
    if (m) {
      const t = this.tabOf(m[2]);
      if (m[1] === 'close' && t) { this.tabs.closeTab(t.id); this.#targetGone(null, m[2]); }
      if (m[1] === 'activate' && t) this.tabs.activate(t.id);
      res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok');
    }
    res.writeHead(404); res.end();
  }

  // ---------- WebSocket ----------
  onUpgrade(req, sock) {
    const key = req.headers['sec-websocket-key'];
    if (!key) return sock.destroy();
    sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + wsAccept(key) + '\r\n\r\n');
    sock.setNoDelay(true);
    this.socks.add(sock);
    const u = new URL(req.url, 'http://x');
    const pageM = u.pathname.match(/^\/devtools\/page\/(.+)$/);
    const conn = { sock, pageTarget: pageM ? pageM[1] : null };
    wsPump(sock, msg => this.onMsg(conn, msg), () => {
      this.socks.delete(sock);
      for (const [sid, s] of this.sessions) if (s.sock === sock) this.sessions.delete(sid);
    });
  }

  reply(conn, id, result, sessionId) {
    const m = { id, result: result || {} };
    if (sessionId) m.sessionId = sessionId;
    if (process.env.HZ_CDP_LOG) console.log('[cdp]', '<-', id, 'ok', sessionId || '');
    wsSend(conn.sock, JSON.stringify(m));
  }
  replyErr(conn, id, message, sessionId) {
    const m = { id, error: { code: -32000, message: String(message) } };
    if (sessionId) m.sessionId = sessionId;
    if (process.env.HZ_CDP_LOG) console.log('[cdp]', '<-', id, 'ERR', message, sessionId || '');
    wsSend(conn.sock, JSON.stringify(m));
  }
  emit(conn, method, params, sessionId) {
    const m = { method, params: params || {} };
    if (sessionId) m.sessionId = sessionId;
    if (process.env.HZ_CDP_LOG) console.log('[cdp]', '<<', method, sessionId || '');
    wsSend(conn.sock, JSON.stringify(m));
  }

  // lifecycle events real Chrome emits when a target dies — clients (and
  // puppeteer's own cleanup deferreds) wait on detachedFromTarget+targetDestroyed
  #targetGone(conn, targetId) {
    for (const [sid, s] of [...this.sessions]) {
      if (s.targetId !== targetId) continue;
      this.emit({ sock: s.sock }, 'Target.detachedFromTarget', { sessionId: sid, targetId });
      this.sessions.delete(sid);
    }
    for (const sock of this.socks) {
      this.emit({ sock }, 'Target.targetDestroyed', { targetId });
    }
  }

  ensureDebug(wc, conn, sessionId) {
    try { if (!wc.debugger.isAttached()) wc.debugger.attach('1.3'); } catch {}
    if (!wc._hzCdpForward) {
      wc._hzCdpForward = true;
      wc.debugger.on('message', (ev, method, params, evSessionId) => {
        // forward to every conn owning a session on this target + page sockets
        for (const [sid, s] of this.sessions) {
          if (this.wcOf(s.targetId) !== wc) continue;
          this.emit({ sock: s.sock }, method, params, sid);
        }
      });
      wc.debugger.on('detach', () => { /* next command re-attaches */ });
    }
  }

  async sendTo(wc, method, params, conn, sessionId) {
    this.ensureDebug(wc, conn, sessionId);
    try { return await wc.debugger.sendCommand(method, params || {}); }
    catch (e) {
      if (/not attached/i.test(e.message)) {
        try { wc.debugger.attach('1.3'); return await wc.debugger.sendCommand(method, params || {}); }
        catch (e2) { throw e2; }
      }
      throw e;
    }
  }

  async onMsg(conn, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg.id) return; // ignore client notifications
    const { id, method, params = {}, sessionId } = msg;
    if (process.env.HZ_CDP_LOG) console.log('[cdp]', '->', id, method, sessionId || '');
    const sid = sessionId || null;
    const done = r => this.reply(conn, id, r, sid);
    const fail = e => this.replyErr(conn, id, e && e.message || e, sid);

    try {
      // ---- target-scoped commands (session or page socket) ----
      let targetId = null, wc = null;
      if (sid && this.sessions.has(sid)) { targetId = this.sessions.get(sid).targetId; }
      else if (conn.pageTarget) { targetId = conn.pageTarget; }
      if (targetId) wc = this.wcOf(targetId);

      if (wc) {
        if (method === 'Page.printToPDF') {
          const buf = await wc.printToPDF({
            printBackground: params.printBackground !== false,
            landscape: !!params.landscape,
            pageSize: params.format || 'A4',
            scale: params.scale || 1,
            paperWidth: params.paperWidth, paperHeight: params.paperHeight,
            margins: params.marginTop != null ? { marginType: 'custom',
              top: params.marginTop || 0, bottom: params.marginBottom || 0,
              left: params.marginLeft || 0, right: params.marginRight || 0 } : { marginType: 'default' }
          });
          if (params.transferMode === 'ReturnAsStream') {
            const h = 'hzstream:' + (++this._streamN);
            this._streams.set(h, { buf, pos: 0 });
            return done({ stream: h });
          }
          return done({ data: buf.toString('base64') });
        }
        if (method === 'IO.read' && String(params.handle || '').startsWith('hzstream:')) {
          const st = this._streams.get(params.handle);
          if (!st) return fail('Invalid stream handle');
          if (params.offset != null) st.pos = params.offset;
          const size = params.size || (256 * 1024);
          const chunk = st.buf.slice(st.pos, st.pos + size);
          st.pos += chunk.length;
          return done({ base64Encoded: true, data: chunk.toString('base64'), eof: st.pos >= st.buf.length });
        }
        if (method === 'IO.close' && String(params.handle || '').startsWith('hzstream:')) {
          this._streams.delete(params.handle);
          return done({});
        }
        if (method === 'Page.bringToFront') {
          const t = this.tabOf(targetId);
          if (t) this.tabs.activate(t.id);
          return done({});
        }
        if (method === 'Page.close') {
          const t = this.tabOf(targetId);
          if (t) this.tabs.closeTab(t.id); else if (String(targetId).startsWith('hl-')) this.headless.close(targetId.slice(3));
          this.#targetGone(conn, targetId);
          return done({});
        }
        // session/browser-scoped commands that must not reach the page target:
        // runIfWaitingForDebugger never resolves on an already-running page
        // (it's only meaningful on a startup-suspended target) and hangs
        // puppeteer's newPage(); the rest are safe no-ops at page scope.
        const NOOP = new Set([
          'Runtime.runIfWaitingForDebugger', 'Runtime.setAsyncCallStackDepth',
          'Runtime.setMaxCallStackSizeToCapture', 'Debugger.setAsyncCallStackDepth',
          'Target.setAutoAttach', 'Page.setInterceptFileChooserDialog',
          'WebMCP.enable', 'WebMCP.disable'
        ]);
        if (NOOP.has(method)) return done({});
        return done(await this.sendTo(wc, method, params, conn, sid));
      }

      // ---- browser-scope commands ----
      switch (method) {
        case 'Browser.getVersion':
          return done({ protocolVersion: '1.3', product: 'Chrome/' + CHROME_VER,
            revision: '@haizhu', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' + CHROME_VER + ' Safari/537.36',
            jsVersion: '14.0.365' });
        case 'Browser.setDownloadBehavior': case 'Browser.getWindowForTarget':
          return done(method.endsWith('Behavior') ? {} : { windowId: 1, bounds: {} });
        case 'Browser.grantPermissions': case 'Browser.resetPermissions':
        case 'Browser.close': // don't actually quit the app
          return done({});
        case 'Target.setDiscoverTargets':
          if (params.discover) for (const t of this.targets())
            this.emit(conn, 'Target.targetCreated', { targetInfo: { targetId: t.id, type: t.type, title: t.title, url: t.url, attached: false } });
          return done({});
        case 'Target.setAutoAttach':
          conn.autoAttach = params.autoAttach !== false;
          done({});
          if (conn.autoAttach) {
            // real Chrome retro-attaches every matching existing target —
            // puppeteer waits for these before finishing initial discovery
            for (const t of this.targets()) {
              if ([...this.sessions.values()].some(s => s.sock === conn.sock && s.targetId === t.id)) continue;
              const sid2 = 'hzsess-' + (++this._sessN);
              const w = this.wcOf(t.id);
              this.sessions.set(sid2, { sock: conn.sock, targetId: t.id });
              if (w) this.ensureDebug(w, conn, sid2);
              this.emit(conn, 'Target.attachedToTarget', {
                sessionId: sid2,
                targetInfo: { targetId: t.id, type: 'page', title: t.title || '', url: t.url || 'about:blank', attached: true },
                waitingForDebugger: false
              });
            }
          }
          return;
        case 'Target.setRemoteLocations':
          return done({});
        case 'Target.getTargets':
          return done({ targetInfos: this.targets().map(t => ({ targetId: t.id, type: t.type, title: t.title, url: t.url, attached: false })) });
        case 'Target.getBrowserContexts':
          return done({ browserContextIds: ['default'] });
        case 'Target.createBrowserContext':
          return done({ browserContextId: 'default' });
        case 'Target.disposeBrowserContext': case 'Target.detachFromTarget':
          if (sessionId || params.sessionId) this.sessions.delete(params.sessionId || sessionId);
          return done({});
        case 'Target.createTarget': {
          const url = params.url || 'about:blank';
          let targetId;
          if (params.headless || params.background) {
            const rec = await this.headless.open({ url, allowPrivate: true });
            targetId = 'hl-' + rec.id;
          } else {
            const t = this.tabs.openTab(url);
            const wc2 = t.wc;
            targetId = 'page-' + wc2.id;
          }
          this.emit(conn, 'Target.targetCreated', { targetInfo: { targetId, type: 'page', title: '', url: url || 'about:blank', attached: false } });
          done({ targetId });
          // modern clients rely on setAutoAttach — emit attachedToTarget so
          // puppeteer's newPage() resolves without an explicit attach call
          if (conn.autoAttach) {
            const sid2 = 'hzsess-' + (++this._sessN);
            const w = this.wcOf(targetId);
            this.sessions.set(sid2, { sock: conn.sock, targetId });
            if (w) this.ensureDebug(w, conn, sid2);
            this.emit(conn, 'Target.attachedToTarget', {
              sessionId: sid2,
              targetInfo: { targetId, type: 'page', title: w ? w.getTitle() : '', url: (w && w.getURL()) || url || 'about:blank', attached: true },
              waitingForDebugger: false
            });
          }
          return;
        }
        case 'Target.closeTarget': {
          const tid = params.targetId;
          const t = this.tabOf(tid);
          let ok = false;
          if (t) { this.tabs.closeTab(t.id); ok = true; }
          else if (String(tid).startsWith('hl-')) { await this.headless.close(tid.slice(3)).catch(() => {}); ok = true; }
          if (ok) this.#targetGone(conn, tid);
          return done({ success: ok });
        }
        case 'Target.activateTarget': {
          const t = this.tabOf(params.targetId);
          if (t) this.tabs.activate(t.id);
          return done({});
        }
        case 'Target.attachToTarget': {
          const tid = params.targetId;
          const w = this.wcOf(tid);
          if (!w) return fail('No target with given id');
          const sessionId2 = 'hzsess-' + (++this._sessN);
          this.sessions.set(sessionId2, { sock: conn.sock, targetId: tid });
          this.ensureDebug(w, conn, sessionId2);
          const t2 = this.targets().find(x => x.id === tid) || { title: '', url: '' };
          const info = { targetId: tid, type: 'page', title: w.getTitle() || t2.title, url: w.getURL() || t2.url || 'about:blank', attached: true };
          done({ sessionId: sessionId2 });
          this.emit(conn, 'Target.attachedToTarget', { sessionId: sessionId2, targetInfo: info, waitingForDebugger: false });
          return;
        }
        case 'Target.sendMessageToTarget': {
          const s = this.sessions.get(params.sessionId);
          const w = s ? this.wcOf(s.targetId) : this.wcOf(params.targetId);
          if (!w) return fail('no such session/target');
          const inner = JSON.parse(params.message);
          const r = await this.sendTo(w, inner.method, inner.params || {}, conn, params.sessionId);
          this.emit(conn, 'Target.receivedMessageFromTarget', {
            sessionId: params.sessionId, targetId: params.targetId,
            message: JSON.stringify({ id: inner.id, result: r }) });
          return done({});
        }
        case 'Storage.getCookies': case 'Storage.setCookies': case 'Storage.deleteCookies': {
          const t = this.targets()[0];
          const w = t && this.wcOf(t.id);
          if (!w) return done({});
          const map = { 'Storage.getCookies': 'Network.getAllCookies', 'Storage.setCookies': 'Network.setCookies', 'Storage.deleteCookies': 'Network.deleteCookies' };
          return done(await this.sendTo(w, map[method], params, conn, sid));
        }
        case 'SystemInfo.getInfo': case 'SystemInfo.getProcessInfo':
          return done(method.endsWith('ProcessInfo') ? { processInfo: [] } : { commandLine: '', cpuInfo: { archName: 'x86_64', modelName: 'x', numAvailableProcessors: 8 }, gpuInfo: { auxAttributes: {} }, modelName: '', modelVersion: '' });
        case 'Performance.enable': case 'Performance.disable': case 'Log.enable':
        case 'Log.disable': case 'ServiceWorker.enable': case 'Audits.enable':
          return done(method.endsWith('getProcessInfo') ? { processInfo: [] } : {});
        case 'Security.setIgnoreCertificateErrors':
          return done({});
        default:
          // last resort: if a page target exists forward there, else ok-empty
          return fail('Unknown method ' + method);
      }
    } catch (e) { if (process.env.HZ_CDP_LOG) console.log('[cdp] ERR', id, method, e.message); fail(e); }
  }
}

module.exports = { CdpServer };
