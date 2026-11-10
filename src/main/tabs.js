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
    this.profile = (opts.profileId && manager.ctx.profiles) ? manager.ctx.profiles.get(opts.profileId) : null;
    this.partition = opts.partition || (this.profile ? manager.ctx.profiles.partitionFor(this.profile) : 'persist:default');
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
    if (this.profile) {
      this.profile.lastUsed = Date.now();
      this.fpSetup = this.setupCdpFp();
    }
    // Baseline anti-bot surface via CDP (all frames incl. cross-origin
    // challenge iframes) — skip internal haizhu:// pages.
    this.stealthSetup = (!isNtp && manager.ctx.stealth) ? manager.ctx.stealth.attachTab(this) : Promise.resolve();
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
    wc.on('context-menu', (e, p) => m.onContextMenu(this, p));
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
    const fp = this.profile
      ? m.fingerprint.bootstrapForProfile(this.profile)
      : m.fingerprint.bootstrapFor('seed');
    if (fp) parts.push(fp);
    parts.push(m.scripts.bridgeSource());
    const dir = require('path').join(require('electron').app.getPath('userData'), 'bootstraps');
    require('fs').mkdirSync(dir, { recursive: true });
    const f = require('path').join(dir, 'boot-' + this.id + '.js');
    require('fs').writeFileSync(f, parts.join('\n'));
    return f;
  }
  // Profile tabs get native-level overrides via CDP: real V8 timezone/locale
  // handling, network-service UA + UA-CH metadata, and a CSP-immune main-world
  // fingerprint script (script-tag injection is blocked on strict-CSP sites).
  // Re-applies on debugger detach (renderer swap / capture stop).
  async setupCdpFp() {
    // debugger commands queue until the first renderer commit — prime the
    // session with about:blank so overrides land BEFORE the real navigation.
    try {
      await Promise.race([
        this.wc.loadURL('about:blank'),
        new Promise((_, rj) => setTimeout(() => rj(new Error('prime timeout')), 3000)),
      ]);
    } catch (e) {}
    try { this.wc.debugger.attach('1.3'); }
    catch (e) { if (!/already attached/.test(e.message)) return; }
    const dbg = this.wc.debugger;
    const send = (m, p) => Promise.race([
      dbg.sendCommand(m, p),
      new Promise((_, rj) => setTimeout(() => rj(new Error('cdp timeout')), 3000)),
    ]).catch(() => null);
    const persona = this.manager.ctx.profiles.personaFor(this.profile);
    const { buildBootstrap } = require('./fingerprint');
    const ch = persona.clientHints;
    const apply = async () => {
      const jobs = [
        send('Emulation.setTimezoneOverride', { timezoneId: persona.timezone }),
        send('Emulation.setLocaleOverride', { locale: persona.languages[0] }),
        send('Page.enable'),
        send('Network.enable'),
        send('Network.setUserAgentOverride', {
          userAgent: this.profile.uaOverride || persona.userAgent,
          acceptLanguage: persona.languages.join(','),
          userAgentMetadata: {
            brands: ch.brands, fullVersionList: ch.fullVersionList,
            platform: ch.platform, platformVersion: ch.platformVersion,
            architecture: ch.architecture, model: ch.model, mobile: ch.mobile,
            bitness: ch.bitness, wow64: ch.wow64, fullVersion: ch.uaFullVersion,
          },
        }),
      ];
      if (persona.os === 'android') {
        jobs.push(
          send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }),
          send('Emulation.setDeviceMetricsOverride', {
            width: persona.screen.width, height: persona.screen.height,
            deviceScaleFactor: persona.devicePixelRatio, mobile: true,
          }));
      }
      await Promise.allSettled(jobs);
      const r = await send('Page.addScriptToEvaluateOnNewDocument', { source: buildBootstrap(persona) });
      if (r && r.identifier) this._fpScriptId = r.identifier;
    };
    await apply();
    dbg.on('detach', () => {
      if (this.wc.isDestroyed()) return;
      try { dbg.attach('1.3'); apply(); } catch (e) {}
    });
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
      devtools: this.wc.isDevToolsOpened(),
      profile: this.profile ? { id: this.profile.id, name: this.profile.name, color: this.profile.color, os: this.profile.os } : null
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
    if (s === 'settings') return 'haizhu://settings';
    if (/^[a-z]+:/i.test(s)) return s;
    if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(s) || s === 'localhost' || /^localhost[:/]/.test(s)) return 'https://' + s;
    const ENGINES = {
      duckduckgo: 'https://duckduckgo.com/?q=', google: 'https://www.google.com/search?q=',
      bing: 'https://www.bing.com/search?q=', baidu: 'https://www.baidu.com/s?wd='
    };
    const eng = (this.ctx.store && this.ctx.store.get('searchEngine')) || 'duckduckgo';
    return (ENGINES[eng] || ENGINES.duckduckgo) + encodeURIComponent(s);
  }
  openTab(url, active = true, opts = {}) {
    const tab = new Tab(this, url, opts);
    this.tabs.set(tab.id, tab);
    this.sessions.add(tab.ses);
    if (this.ctx.onSession) this.ctx.onSession(tab.ses, tab);
    // Attach the view to the window BEFORE navigating — loading a URL in a
    // detached WebContentsView destabilizes the network service (renderer
    // + utility crash exit 143, observed on Electron 44).
    this.win.contentView.addChildView(tab.view);
    tab.wc.on('dom-ready', () => tab.injectUserscripts('document-end').then(() => tab.injectUserscripts('document-idle')));
    if (active) this.activate(tab.id); else this.layout();
    if (tab.pendingUrl) {
      const gate = Promise.allSettled([tab.fpSetup, tab.stealthSetup]);
      gate.finally(() => { if (!tab.wc.isDestroyed()) tab.wc.loadURL(tab.pendingUrl); });
    }
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
  onContextMenu(tab, params) {
    this.ctx.contextMenu && this.ctx.contextMenu(tab, params);
  }
}

module.exports = { TabManager };
