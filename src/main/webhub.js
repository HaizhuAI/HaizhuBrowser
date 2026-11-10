'use strict';
// WebRequestHub — Electron allows exactly ONE listener per webRequest event
// per session (a second registration silently replaces the first). All
// consumers (adblock, sniffer, capture, userscript installer) subscribe here
// instead, fanned out in registration order. Blocking events return the
// first defined response.

class WebRequestHub {
  constructor() {
    this.subs = new Map(); // event -> [fn]
    this.attached = new WeakSet();
  }
  on(ev, fn) {
    const arr = this.subs.get(ev) || [];
    arr.push(fn); this.subs.set(ev, arr);
  }
  fire(ev, d) {
    for (const f of this.subs.get(ev) || []) { try { f(d); } catch (e) {} }
  }
  // first non-undefined response wins (e.g. {cancel:true})
  fireBlocking(d) {
    for (const f of this.subs.get('before') || []) {
      try { const r = f(d); if (r !== undefined) return r; } catch (e) {}
    }
    return {};
  }
  fireBlockingHeaders(d) {
    for (const f of this.subs.get('headers') || []) {
      try { const r = f(d); if (r !== undefined) return r; } catch (e) {}
    }
    return {};
  }
  attach(ses) {
    if (this.attached.has(ses)) return;
    this.attached.add(ses);
    const self = this;
    const ALL = { urls: ['<all_urls>'] };
    ses.webRequest.onBeforeRequest(ALL, (d, cb) => cb(self.fireBlocking(d)));
    ses.webRequest.onSendHeaders(ALL, d => self.fire('sendHeaders', d));
    ses.webRequest.onBeforeRedirect(ALL, d => self.fire('redirect', d));
    ses.webRequest.onHeadersReceived(ALL, (d, cb) => cb(self.fireBlockingHeaders(d)));
    ses.webRequest.onCompleted(ALL, d => self.fire('completed', d));
    ses.webRequest.onErrorOccurred(ALL, d => self.fire('error', d));
  }
}

module.exports = { WebRequestHub };
