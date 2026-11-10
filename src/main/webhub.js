'use strict';
// WebRequestHub — Electron allows exactly ONE listener per webRequest event
// per session (a second registration silently replaces the first). All
// consumers (adblock, sniffer, capture, userscript installer, profile header
// rewriting) subscribe here instead, fanned out in registration order.
// Blocking events return the first defined response. Subscribers receive
// (details, session) so per-partition consumers can scope themselves.

class WebRequestHub {
  constructor() {
    this.subs = new Map(); // event -> [fn]
    this.attached = new WeakSet();
  }
  on(ev, fn) {
    const arr = this.subs.get(ev) || [];
    arr.push(fn); this.subs.set(ev, arr);
  }
  fire(ev, d, ses) {
    for (const f of this.subs.get(ev) || []) { try { f(d, ses); } catch (e) {} }
  }
  // first non-undefined response wins (e.g. {cancel:true})
  fireBlocking(d, ses) {
    for (const f of this.subs.get('before') || []) {
      try { const r = f(d, ses); if (r !== undefined) return r; } catch (e) {}
    }
    return {};
  }
  fireBlockingHeaders(d, ses) {
    for (const f of this.subs.get('headers') || []) {
      try { const r = f(d, ses); if (r !== undefined) return r; } catch (e) {}
    }
    return {};
  }
  // merging variant: subscribers return {requestHeaders} patches, applied in order
  fireSendHeaders(d, ses) {
    let out = null;
    for (const f of this.subs.get('reqHeaders') || []) {
      try { const r = f(d, ses); if (r !== undefined) out = r; } catch (e) {}
    }
    return out || {};
  }
  attach(ses) {
    if (this.attached.has(ses)) return;
    this.attached.add(ses);
    const self = this;
    const ALL = { urls: ['<all_urls>'] };
    ses.webRequest.onBeforeRequest(ALL, (d, cb) => cb(self.fireBlocking(d, ses)));
    ses.webRequest.onBeforeSendHeaders(ALL, (d, cb) => cb(self.fireSendHeaders(d, ses)));
    ses.webRequest.onSendHeaders(ALL, d => self.fire('sendHeaders', d, ses));
    ses.webRequest.onBeforeRedirect(ALL, d => self.fire('redirect', d, ses));
    ses.webRequest.onHeadersReceived(ALL, (d, cb) => cb(self.fireBlockingHeaders(d, ses)));
    ses.webRequest.onCompleted(ALL, d => self.fire('completed', d, ses));
    ses.webRequest.onErrorOccurred(ALL, d => self.fire('error', d, ses));
  }
}

module.exports = { WebRequestHub };
