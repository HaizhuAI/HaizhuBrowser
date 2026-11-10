'use strict';
// TabManager — WebContentsView-backed tabs. Each tab carries its own session
// partition (default or incognito), fingerprint bootstrap, userscript
// injection, capture hooks, and per-tab state broadcast to the chrome UI.

const path = require('path');
const { WebContentsView, session, webContents } = require('electron');

let nextId = 1;

class Tab {
  constructor(manager, url, opts = {}) {
    this.manager = manager;
    this.id = nextId++;
    this.partition = opts.partition || 'persist:default';
    this.ses = session.fromPartition(this.partition);
    this.pendingUrl = (url && url !== 'about:blank') ? manager.normalizeUrl(url) : manager.NTP_URL;
    const isNtp = /^haizhu:/.test(this.pendingUrl);
    const prefs = {
      contextIsolation: true,
      sandbox: false,
      webSecurity: true,
      session: this.ses
    };
    if (!process.env.HZ_NOPRELOAD) {
      prefs.preload = path.join(__dirname, '..', 'preload', isNtp ? 'ntp.js' : 'page.js');
      if (!isNtp) prefs.additionalArguments = ['--hz-bootstrap-file=' + this.writeBootstrap()];
    }
    this.view = new WebContentsView({ webPreferences: prefs });
    this.wc = this.view.webContents;
    this.title = 'New Tab';
    this.url = 'about:blank';
    this.loading = false;
    this.incognito = !!opts.incognito;
    this.favIconUrl = null;
    this.wire();
  }
  wire() {
    const m = this.manager;
    const wc = this.wc;
    wc.on('page-title-updated', (e, t) => { this.title = t; m.broadcast('tab-updated', this.id, this.serialize()); });
    wc.on('page-favicon-updated', (e, f) => { if (f && f[0]) this.favIconUrl = f[0]; m.broadcast('tab-updated', this.id, this.serialize()); });
    wc.on('did-start-loading', () => { this.loading = true; m.broadcast('tab-updated', this.id, this.serialize()); });
    wc.on('did-stop-loading', () => { this.loading = false; this.url = wc.getURL(); m.broadcast('tab-updated', this.id, this.serialize()); });
    wc.on('did-navigate', (e, url) => { this.url = url; m.onNavigate(this, url); m.broadcast('tab-updated', this.id, this.serialize()); });
    if (process.env.HZ_DEBUG) {
      wc.on('did-finish-load', () => console.log('[tab', this.id, '] loaded:', wc.getURL()));
      wc.on('did-fail-load', (e, code, desc) => console.log('[tab', this.id, '] FAIL', code, desc));
      wc.on('render-process-gone', (e, d) => console.log('[tab', this.id, '] GONE', JSON.stringify(d)));
    }
    wc.on('did-navigate-in-page', (e, url) => { this.url = url; m.broadcast('tab-updated', this.id, this.serialize()); });
    wc.on('did-fail-load', (e, code, desc, url, isMain) => { if (isMain) m.broadcast('tab-updated', this.id, this.serialize()); });
    if (!process.env.HZ_BARE) wc.setWindowOpenHandler(({ url, frameName }) => {
      if (url === 'about:blank' || frameName === '_blank') m.openTab(url, true);
      return { action: 'deny' };
    });
    wc.on('destroyed', () => m.broadcast('tab-closed', this.id));
  }
  // Early main-world bootstrap (fingerprint persona + GM bridge factory).
  // Written to a temp file whose path reaches the page preload through
  // additionalArguments — injected as <script> before page scripts run.
  writeBootstrap() {
    const m = this.manager;
    const parts = [];
    const fp = m.fingerprint.bootstrapFor('seed');
    if (fp) parts.push(fp);
    parts.push(m.scripts.bridgeSource());
    const dir = require('path').join(require('electron').app.getPath('userData'), 'bootstraps');
    require('fs').mkdirSync(dir, { recursive: true });
    const f = require('path').join(dir, 'boot-' + this.id + '.js');
    require('fs').writeFileSync(f, parts.join('\n'));
    return f;
  }
  async injectUserscripts(when) {
    const url = this.wc.getURL();
    if (!/^https?:|^file:/.test(url)) return;
    const list = this.manager.scripts.matchesFor(url, true)
      .filter(s => (s.meta['run-at'] || 'document-idle').includes(when));
    for (const s of list) {
      try { await this.wc.executeJavaScript(this.manager.scripts.wrapScript(s), false); }
      catch (e) { console.error('[us] inject fail', s.meta.name, e.message); }
    }
  }
  serialize() {
    return {
      id: this.id, title: this.title, url: this.wc.getURL() || this.url,
      loading: this.loading, incognito: this.incognito, fav: this.favIconUrl,
      canBack: this.wc.navigationHistory.canGoBack(), canFwd: this.wc.navigationHistory.canGoForward(),
      capture: this.manager.captures.get(this.wc).enabled,
      devtools: this.wc.isDevToolsOpened()
    };
  }
}

class TabManager {
  constructor(ctx) {
    this.ctx = ctx; // {win, chrome, fingerprint, scripts, captures, adblock, proxy, store, broadcast}
    this.tabs = new Map();
    this.activeId = null;
    this.chromeH = 82; // px reserved at top for chrome UI
    this.panelW = 0;   // px reserved on right for docked panel
    this.sessions = new Set();
  }
  get fingerprint() { return this.ctx.fingerprint; }
  get scripts() { return this.ctx.scripts; }
  get captures() { return this.ctx.captures; }
  get win() { return this.ctx.win; }
  broadcast(...a) { this.ctx.broadcast(...a); }
  get NTP_URL() { return 'haizhu://newtab'; }
  normalizeUrl(input) {
    const s = String(input || '').trim();
    if (!s || s === 'about:blank' || s === 'newtab' || s === 'ntp') return this.NTP_URL;
    if (/^[a-z]+:/i.test(s)) return s;
    if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(s) || s === 'localhost' || /^localhost[:/]/.test(s)) return 'https://' + s;
    return 'https://duckduckgo.com/?q=' + encodeURIComponent(s);
  }
  openTab(url, active = true, opts = {}) {
    const tab = new Tab(this, url, opts);
    this.tabs.set(tab.id, tab);
    this.sessions.add(tab.ses);
    if (this.ctx.onSession) this.ctx.onSession(tab.ses);
    // Attach the view to the window BEFORE navigating — loading a URL in a
    // detached WebContentsView destabilizes the network service (renderer
    // + utility crash exit 143, observed on Electron 44).
    this.win.contentView.addChildView(tab.view);
    tab.wc.on('dom-ready', () => tab.injectUserscripts('document-end').then(() => tab.injectUserscripts('document-idle')));
    if (active) this.activate(tab.id); else this.layout();
    if (tab.pendingUrl) tab.wc.loadURL(tab.pendingUrl);
    this.broadcast('tab-added', tab.serialize());
    return tab;
  }
  closeTab(id) {
    const tab = this.tabs.get(id); if (!tab) return;
    try { this.win.contentView.removeChildView(tab.view); } catch (e) {}
    try { tab.wc.destroy(); } catch (e) {}
    this.tabs.delete(id);
    if (this.activeId === id) {
      const rest = [...this.tabs.keys()];
      if (rest.length) this.activate(rest[rest.length - 1]);
      else this.activeId = null;
    }
    this.broadcast('tab-closed', id);
  }
  activate(id) {
    const tab = this.tabs.get(id); if (!tab) return;
    this.activeId = id;
    for (const [tid, t] of this.tabs) {
      try {
        if (tid === id) t.view.setVisible(true);
        else t.view.setVisible(false);
      } catch (e) {}
    }
    this.layout();
    this.broadcast('tab-activated', id, tab.serialize());
  }
  get active() { return this.activeId ? this.tabs.get(this.activeId) : null; }
  list() { return [...this.tabs.values()].map(t => t.serialize()); }
  setChromeHeight(h) { this.chromeH = h; this.layout(); }
  setPanelWidth(w) { this.panelW = w; this.layout(); }
  layout() {
    const [w, h] = this.win.getContentSize();
    for (const t of this.tabs.values()) {
      t.view.setBounds({ x: 0, y: this.chromeH, width: Math.max(50, w - this.panelW), height: Math.max(50, h - this.chromeH) });
    }
    this.ctx.layoutPanel && this.ctx.layoutPanel(w, h);
  }
  onNavigate(tab, url) {
    this.ctx.history && this.ctx.history.add(url, tab.title);
    this.ctx.sniffer && this.ctx.sniffer.clear(tab.wc.id);
  }
}

module.exports = { TabManager };
