'use strict';
const { app, BaseWindow, WebContentsView, session, ipcMain, dialog, shell, clipboard, Menu, nativeTheme, protocol, net } = require('electron');
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');

const { Store } = require('./store');
const { FingerprintManager } = require('./fingerprint');
const { UserscriptEngine } = require('./userscripts');
const { CaptureManager, ResourceSniffer, M3U8Downloader } = require('./capture');
const { ProxyManager } = require('./proxy');
const { WebRequestHub } = require('./webhub');
const { AdBlock } = require('./adblock');
const { ExtensionManager } = require('./extensions');
const { AIModule, cookieApi, DUCK_MODELS, OpenAICompat } = require('./ai');
const { TabManager } = require('./tabs');
const { I18n } = require('./i18n');

app.setName('Haizhu Browser');
// VM / software-GL environments: hardware acceleration crashes renderers
// when the GPU process dies (observed exit 143 killing tab renderers).
app.disableHardwareAcceleration();

const CHROME_H = 82;
const NTP_URL = 'haizhu://newtab';
// privileged internal scheme for the new-tab page (must run pre-ready)
protocol.registerSchemesAsPrivileged([{
  scheme: 'haizhu',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false }
}]);

let win, chromeView, panelView;
let store, fingerprint, scripts, captures, sniffer, m3u8, proxy, adblock, extMgr, ai, tabs, hub, attachProto = () => {};
let historyStore, i18n;
let panelOpen = false;

function broadcast(channel, ...args) {
  if (chromeView && !chromeView.webContents.isDestroyed()) chromeView.webContents.send(channel, ...args);
  if (panelView && !panelView.webContents.isDestroyed()) panelView.webContents.send(channel, ...args);
  // internal pages (ntp / settings tabs) also consume ui-wide events
  if (tabs) for (const t of tabs.tabs.values()) {
    try { if (!t.wc.isDestroyed()) t.wc.send(channel, ...args); } catch (e) {}
  }
}

function defaultSession() { return session.fromPartition('persist:default'); }

async function applyNetworkStack() {
  for (const ses of tabs.sessions.size ? tabs.sessions : [defaultSession()]) {
    try { await proxy.apply(ses); } catch (e) { console.error('[proxy]', e.message); }
    hub.attach(ses);
  }
}

function attachSessionHooks(ses) {
  ses.setPermissionRequestHandler((wc, perm, cb) => {
    const deny = ['mediaKeySystem', 'geolocation'];
    cb(!deny.includes(perm));
  });
}

// theme: 'system'|'dark'|'light' persisted in settings; effective pushed to
// every webContents (chrome, panel, internal pages) as data-theme.
function effectiveTheme() { return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'; }
function applyTheme() {
  const mode = store.get('theme', 'system');
  nativeTheme.themeSource = mode;
  const eff = effectiveTheme();
  try { if (win) win.setBackgroundColor(eff === 'dark' ? '#1b1c20' : '#e9eaee'); } catch (e) {}
  broadcast('theme-changed', { mode, effective: eff });
}

function createWindow() {
  win = new BaseWindow({
    width: 1440, height: 920, minWidth: 900, minHeight: 600,
    frame: false,
    backgroundColor: '#1b1c20'
  });
  win.setMenuBarVisibility(false);

  // chrome UI
  chromeView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'host.js'),
      contextIsolation: true, sandbox: false
    }
  });
  chromeView.webContents.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.contentView.addChildView(chromeView);

  const layoutAll = () => {
    const [w, h] = win.getContentSize();
    chromeView.setBounds({ x: 0, y: 0, width: w, height: CHROME_H });
    tabs.layout();
  };
  win.on('resize', layoutAll);
  layoutAll();

  tabs.openTab(process.env.HZ_HOME || store.get('home', 'https://duckduckgo.com'), true);
}

function openPanel() {
  if (panelView) { closePanel(); return; }
  panelView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'host.js'),
      contextIsolation: true, sandbox: false
    }
  });
  panelView.webContents.loadFile(path.join(__dirname, '..', 'renderer', 'panel.html'));
  win.contentView.addChildView(panelView);
  panelOpen = true;
  tabs.setPanelWidth(420);
  broadcast('panel-state', true);
}
function closePanel() {
  if (!panelView) return;
  try { win.contentView.removeChildView(panelView); panelView.webContents.destroy(); } catch (e) {}
  panelView = null; panelOpen = false;
  tabs.setPanelWidth(0);
  broadcast('panel-state', false);
}
function layoutPanel(w, h) {
  if (panelView) panelView.setBounds({ x: w - 420, y: CHROME_H, width: 420, height: h - CHROME_H });
}

// ---------- history ----------
const history = {
  add(url, title) {
    if (!url || url.startsWith('about:') || url.startsWith('haizhu:')) return;
    const h = historyStore.get('items', []);
    h.unshift({ url, title, ts: Date.now() });
    if (h.length > 5000) h.pop();
    historyStore.set('items', h);
  },
  list(limit = 100) { return historyStore.get('items', []).slice(0, limit); },
  clear() { historyStore.set('items', []); }
};

// ---------- IPC ----------
function registerIpc() {
  const ctx = {
    openTab: (u, a) => tabs.openTab(u, a !== false),
    captures, sniffer, scripts,
    cookies: cookieApi,
    history: l => history.list(l),
    download: (url, name) => m3u8.download(url, name),
    injectCss: () => true,
    addElement: () => true
  };
  ai.ctx = ctx;

  ipcMain.handle('tabs:list', () => tabs.list());
  ipcMain.handle('tabs:open', (e, url, opts) => tabs.openTab(url, true, opts || {}).serialize());
  ipcMain.handle('tabs:close', (e, id) => { tabs.closeTab(id); return true; });
  ipcMain.handle('tabs:activate', (e, id) => { tabs.activate(id); return true; });
  ipcMain.handle('tabs:navigate', (e, url) => { const t = tabs.active; if (t) t.wc.loadURL(tabs.normalizeUrl(url)); return true; });
  ipcMain.handle('tabs:go', (e, dir) => {
    const t = tabs.active; if (!t) return false;
    dir === 'back' ? t.wc.goBack() : dir === 'fwd' ? t.wc.goForward() : t.wc.reload();
    return true;
  });
  ipcMain.handle('tabs:state', () => { const t = tabs.active; return t ? t.serialize() : null; });
  ipcMain.handle('tabs:devtools', (e, id) => {
    const t = tabs.tabs.get(id || tabs.activeId);
    if (!t) return false;
    t.wc.isDevToolsOpened() ? t.wc.closeDevTools() : t.wc.openDevTools({ mode: 'right' });
    return true;
  });
  ipcMain.handle('panel:toggle', () => { openPanel(); return panelOpen; });
  // native app menu — an HTML popup inside the 82px chrome view would be
  // clipped by its own viewport; Menu.popup renders outside all views.
  ipcMain.handle('ui:menu', () => {
    const send = id => chromeView.webContents.send('menu:cmd', id);
    const t = k => i18n.t(k);
    Menu.buildFromTemplate([
      { label: t('menu.newtab'), accelerator: 'Ctrl+T', click: () => send('newtab') },
      { label: t('menu.incognito'), accelerator: 'Ctrl+Shift+N', click: () => send('incognito') },
      { type: 'separator' },
      { label: t('menu.devpanel'), accelerator: 'F12', click: () => send('panel') },
      { label: t('menu.devtools'), accelerator: 'Ctrl+Shift+I', click: () => send('devtools') },
      { label: t('menu.capture'), click: () => send('capture') },
      { label: t('menu.viewsource'), accelerator: 'Ctrl+U', click: () => send('viewsource') },
      { type: 'separator' },
      { label: t('menu.zoomin'), accelerator: 'Ctrl+=', click: () => send('zoomin') },
      { label: t('menu.zoomout'), accelerator: 'Ctrl+-', click: () => send('zoomout') },
      { label: t('menu.zoomreset'), accelerator: 'Ctrl+0', click: () => send('zoomreset') },
      { label: t('menu.print'), accelerator: 'Ctrl+P', click: () => send('print') },
      { type: 'separator' },
      { label: t('menu.cleardata'), click: () => send('clearcookies') },
      { label: t('menu.downloads'), click: () => send('opendownloads') },
      { type: 'separator' },
      { label: t('menu.settings'), accelerator: 'Ctrl+,', click: () => send('settings') },
      { label: t('menu.quit'), accelerator: 'Alt+F4', click: () => app.quit() }
    ]).popup({ window: win });
    return true;
  });
  ipcMain.on('ntp:go', (e, q) => { if (!e.sender.isDestroyed()) e.sender.loadURL(tabs.normalizeUrl(q)); });
  ipcMain.handle('ntp:history', () => (historyStore.get('items', []) || []).slice(0, 12));
  // daily wallpaper fetched in main — page-side fetch would be CORS-blocked
  ipcMain.handle('ntp:wallpaper', async () => {
    try {
      const r = await net.fetch('https://www.bing.com/HPImageArchive.aspx?format=js&idx=0&n=1');
      const j = await r.json();
      const img = j && j.images && j.images[0];
      if (!img) return null;
      return { url: 'https://www.bing.com' + img.urlbase + '_1920x1080.jpg', copyright: img.copyright || '' };
    } catch (e) { return null; }
  });

  // capture
  ipcMain.handle('cap:toggle', async (e, tabId) => {
    const t = tabs.tabs.get(tabId || tabs.activeId); if (!t) return false;
    return captures.toggle(t.wc);
  });
  ipcMain.handle('cap:list', (e, tabId) => {
    const t = tabs.tabs.get(tabId || tabs.activeId); if (!t) return [];
    return captures.get(t.wc).list();
  });
  ipcMain.handle('cap:body', async (e, reqId, tabId) => {
    const t = tabs.tabs.get(tabId || tabs.activeId); if (!t) return null;
    const b = await captures.get(t.wc).body(reqId);
    return b ? (Buffer.isBuffer(b) ? b.toString('base64') : b) : null;
  });
  ipcMain.handle('cap:har', (e, tabId) => {
    const t = tabs.tabs.get(tabId || tabs.activeId); if (!t) return null;
    return captures.get(t.wc).har();
  });
  ipcMain.handle('cap:clear', (e, tabId) => {
    const t = tabs.tabs.get(tabId || tabs.activeId); if (!t) return;
    const c = captures.get(t.wc); c.entries.clear(); c.order.length = 0; c.cdpMap.clear();
    return true;
  });

  // sniffer
  ipcMain.handle('sniff:list', (e, tabId) => sniffer.list(tabId || (tabs.active && tabs.active.wc.id)));
  ipcMain.handle('sniff:download', (e, url, name) => m3u8.download(url, name));
  ipcMain.handle('sniff:jobs', () => m3u8.list());
  ipcMain.handle('sniff:open', (e, url) => { if (/^https?:/.test(url)) shell.openExternal(url); return true; });

  // proxy
  ipcMain.handle('proxy:list', () => ({ profiles: proxy.profiles, active: proxy.activeId }));
  ipcMain.handle('proxy:add', (e, p) => proxy.addProfile(p));
  ipcMain.handle('proxy:update', (e, id, patch) => { proxy.updateProfile(id, patch); return true; });
  ipcMain.handle('proxy:remove', (e, id) => { proxy.removeProfile(id); return true; });
  ipcMain.handle('proxy:set', async (e, id) => {
    proxy.setActive(id);
    await applyNetworkStack();
    return true;
  });

  // fingerprint
  ipcMain.handle('fp:get', () => fingerprint.settings);
  ipcMain.handle('fp:set', (e, s) => { store.set('fingerprint', Object.assign({}, fingerprint.settings, s)); return true; });
  ipcMain.handle('fp:rotate', () => { fingerprint.rotate(); return true; });
  ipcMain.handle('fp:persona', () => fingerprint.personaFor('preview'));

  // userscripts
  ipcMain.handle('us:list', () => [...scripts.scripts.values()].map(s => ({ id: s.id, name: s.meta.name, version: s.meta.version, enabled: s.enabled, match: s.meta.match.concat(s.meta.include), desc: s.meta.description })));
  ipcMain.handle('us:get', (e, id) => { const s = scripts.scripts.get(id); return s ? { id: s.id, code: s.code, meta: s.meta, enabled: s.enabled } : null; });
  ipcMain.handle('us:save', (e, id, code) => {
    if (!scripts.scripts.get(id)) throw new Error('not found');
    const rec = scripts.install(code); // id derives from ns+name
    if (rec.id !== id) scripts.remove(id);
    return rec.id;
  });
  ipcMain.handle('us:create', (e, code) => scripts.install(code));
  ipcMain.handle('us:remove', (e, id) => { scripts.remove(id); return true; });
  ipcMain.handle('us:toggle', (e, id, on) => { scripts.setEnabled(id, on); return true; });
  ipcMain.handle('us:installUrl', (e, url) => scripts.installFromUrl(url).then(r => r.id));

  // extensions
  ipcMain.handle('ext:list', () => extMgr.list());
  ipcMain.handle('ext:pick-install', async () => {
    const r = await dialog.showOpenDialog(win, { filters: [{ name: 'Extension package', extensions: ['zip', 'crx'] }, { name: 'All', extensions: ['*'] }] });
    if (r.canceled || !r.filePaths[0]) return null;
    const dest = await extMgr.installZip(r.filePaths[0]);
    await extMgr.loadAll(defaultSession());
    return extMgr.list();
  });
  ipcMain.handle('ext:toggle', async (e, dir, on) => { await extMgr.setEnabled(defaultSession(), dir, on); return extMgr.list(); });
  ipcMain.handle('ext:remove', async (e, dir) => { await extMgr.remove(defaultSession(), dir); return extMgr.list(); });

  // cookies
  ipcMain.handle('ck:list', async (e, filter) => {
    const t = tabs.active; const ses = t ? t.ses : defaultSession();
    return cookieApi(ses).list(filter || {});
  });
  ipcMain.handle('ck:set', async (e, c) => {
    const t = tabs.active; const ses = t ? t.ses : defaultSession();
    await cookieApi(ses).set(c); return true;
  });
  ipcMain.handle('ck:del', async (e, url, name) => {
    const t = tabs.active; const ses = t ? t.ses : defaultSession();
    await cookieApi(ses).remove(url, name); return true;
  });
  ipcMain.handle('ck:clear', async (e) => {
    const t = tabs.active; const ses = t ? t.ses : defaultSession();
    await ses.clearStorageData(); return true;
  });

  // AI
  ipcMain.handle('ai:providers', () => ai.providers());
  ipcMain.handle('ai:addEndpoint', (e, ep) => ai.addEndpoint(ep));
  ipcMain.handle('ai:removeEndpoint', (e, id) => { ai.removeEndpoint(id); return true; });
  ipcMain.handle('ai:setActive', (e, id) => { ai.setActive(id); return true; });
  ipcMain.handle('ai:models', async (e, id) => {
    if (id === 'duck') return DUCK_MODELS;
    const ep = ai.endpoints.find(x => 'ep:' + x.id === id);
    if (!ep) return [];
    return (await new OpenAICompat(ep).models()).map(m => ({ id: m, label: m }));
  });
  ipcMain.handle('ai:chat', async (e, messages, opts) => ai.chat(messages, opts || {}));
  ipcMain.handle('ai:agent', async (e, msg, tabId) => {
    const t = tabs.tabs.get(tabId || tabs.activeId);
    const ev = (type, data) => e.sender.send('ai:event', { type, data });
    return ai.agent(msg, t, ev, {});
  });

  // adblock
  ipcMain.handle('ab:toggle', (e, on) => { adblock.setEnabled(on); return adblock.enabled; });
  ipcMain.handle('ab:state', () => ({ enabled: adblock.enabled, rules: adblock.rules.length, blocked: adblock.blockedCount }));

  // history / misc
  ipcMain.handle('hist:list', (e, limit) => history.list(limit));
  ipcMain.handle('hist:clear', () => { history.clear(); return true; });
  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.handle('win:ctl', (e, op) => {
    op === 'min' ? win.minimize() : op === 'max' ? (win.isMaximized() ? win.unmaximize() : win.maximize()) : win.close();
    return true;
  });
  ipcMain.handle('settings:get', (e, k) => store.get(k));
  ipcMain.handle('settings:set', (e, k, v) => {
    store.set(k, v);
    if (k === 'theme') applyTheme();
    if (k === 'lang') { i18n.reload(); broadcast('i18n-changed', i18n.payload()); }
    return true;
  });
  ipcMain.handle('app:i18n', () => i18n.payload());
  ipcMain.handle('app:theme', () => ({ mode: store.get('theme', 'system'), effective: effectiveTheme() }));

  // gm bridge from preload (userscript privileged ops)
  ipcMain.handle('gm:op', async (e, scriptId, op, args) => {
    const wc = e.sender;
    const t = [...tabs.tabs.values()].find(t => t.wc === wc);
    return scripts.execOp(scriptId, op, args, {
      tabId: t ? t.id : 0,
      openTab: (u, a) => tabs.openTab(u, a),
      download: (u, n) => m3u8.download(u, n),
      cookies: cookieApi(wc.session),
      injectCss: css => wc.insertCSS(css).then(() => true),
      addElement: (a, b, c) => wc.executeJavaScript(
        `document.documentElement.appendChild((function(){const el=document.createElement(${JSON.stringify(typeof a === 'string' ? a : 'div')});el.textContent=${JSON.stringify(c || '')};return el})())`
      ).then(() => true)
    });
  });

  // page -> chrome shortcut relay (save-page, view-source handled in main)
  ipcMain.handle('page:viewSource', () => {
    const t = tabs.active; if (!t) return;
    const u = t.wc.getURL();
    if (u.startsWith('view-source:')) t.wc.loadURL(u.slice(12)); else t.wc.loadURL('view-source:' + u);
  });
  ipcMain.handle('page:print', () => { const t = tabs.active; t && t.wc.print(); return true; });
  ipcMain.handle('page:zoom', (e, d) => {
    const t = tabs.active; if (!t) return;
    if (d === 'reset') { t.wc.setZoomFactor(1); return true; }
    const z = t.wc.getZoomFactor() + d;
    t.wc.setZoomFactor(Math.min(3, Math.max(0.25, z))); return true;
  });
  ipcMain.handle('app:opendownloads', () => { shell.openPath(app.getPath('downloads')); return true; });
}

app.whenReady().then(async () => {
  if (process.env.HZ_MINIMAL) {
    win = new BaseWindow({ width: 1440, height: 920, backgroundColor: '#0d1117' });
    const tab = new (require('./tabs').TabManager)({
      get win() { return win; },
      fingerprint: { bootstrapFor: () => null }, scripts: { bridgeSource: () => '', matchesFor: () => [] },
      captures: new CaptureManager(), sniffer: { clear: () => {} },
      broadcast: () => {}, layoutPanel: () => {}
    });
    const v = tab.openTab('https://duckduckgo.com', true);
    const [w, h] = win.getContentSize();
    tab.layout();
    win.on('resize', () => tab.layout());
    app.on('child-process-gone', (e, d) => console.log('[cpg]', d.type, d.reason, d.exitCode));
    return;
  }
  // internal new-tab page served on haizhu:// — must be registered on
  // EVERY session (fromPartition('persist:default') is NOT defaultSession)
  const ntpHandler = req => {
    const u = new URL(req.url);
    const pages = { newtab: 'ntp.html', ntp: 'ntp.html', settings: 'settings.html' };
    if (!pages[u.hostname]) return new Response('not found', { status: 404 });
    // root path -> the page; sub-paths -> sibling assets (settings.js, style.css)
    const file = (u.pathname === '/' || u.pathname === '') ? pages[u.hostname] : u.pathname.slice(1);
    if (!/^[\w.-]+$/.test(file)) return new Response('not found', { status: 404 });
    return net.fetch(pathToFileURL(path.join(__dirname, '..', 'renderer', file)).toString());
  };
  attachProto = ses => { try { ses.protocol.handle('haizhu', ntpHandler); } catch (e) {} };

  store = new Store('settings', {
    home: 'haizhu://newtab',
    searchEngine: 'duckduckgo',
    theme: 'system',
    lang: 'system',
    ntpWallpaper: true,
    fingerprint: { enabled: false, mode: 'per-session' },
    adblock: { enabled: true }
  });
  i18n = new I18n(store);
  historyStore = new Store('history', { items: [] });
  fingerprint = new FingerprintManager(store);
  scripts = new UserscriptEngine(store);
  captures = new CaptureManager();
  sniffer = new ResourceSniffer();
  m3u8 = new M3U8Downloader();
  proxy = new ProxyManager(store);
  adblock = new AdBlock(store);
  extMgr = new ExtensionManager(store);

  tabs = new TabManager({
    get win() { return win; },
    fingerprint, scripts, captures, sniffer, adblock, proxy, store,
    history, broadcast,
    layoutPanel,
    onSession: s => { attachProto(s); if (hub) hub.attach(s); }
  });
  ai = new AIModule(store, null);

  const ses = defaultSession();
  attachProto(ses);
  hub = new WebRequestHub();
  // subscribers are registered ONCE (session-agnostic); hub.attach() arms a session
  hub.on('before', d => { // userscript .user.js install interception
    if (!/\.user\.js(\?|$)/i.test(d.url)) return;
    setImmediate(() => scripts.installFromUrl(d.url)
      .then(rec => broadcast('userscript-installed', rec.meta.name))
      .catch(e => console.error('[us] install', e.message)));
  });
  if (!process.env.HZ_BARE) attachSessionHooks(ses);
  if (!process.env.HZ_BARE) await proxy.apply(ses);
  if (!process.env.HZ_NOHOOKS) {
    adblock.attach(hub);
    sniffer.attach(hub);
    captures.attachSession(hub);
    hub.attach(ses);
  }
  if (!process.env.HZ_NOLISTS) adblock.ensureLists().catch(e => console.error('[adblock]', e.message));
  extMgr.loadAll(ses).catch(e => console.error('[ext]', e.message));

  // proxy auth handler
  app.on('login', (ev, wc, details, authInfo, cb) => {
    ev.preventDefault();
    if (authInfo.isProxy) {
      const cred = proxy.credentials(proxy.active());
      if (cred) return cb(cred.username, cred.password);
    }
    cb();
  });

  if (process.env.HZ_DEBUG) {
    try { require('electron').crashReporter.start({ submitURL: '', uploadToServer: false }); } catch (e) {}
    app.on('child-process-gone', (e, d) => console.log('[cpg]', d.type, d.reason, d.exitCode));
    app.on('render-process-gone', (e, wc, d) => console.log('[rpg]', wc.id, d.reason, d.exitCode));
    app.on('web-contents-created', (e, wc) => {
      wc.on('did-start-loading', () => console.log('[wc', wc.id, '] start-loading'));
      wc.on('did-start-navigation', (e2, u) => console.log('[wc', wc.id, '] nav', u));
      wc.on('console-message', (e2, lvl, msg) => { if (lvl >= 2) console.log('[con', wc.id, lvl, ']', msg.slice(0, 300)); });
    });
  }
  registerIpc();
  createWindow();
  nativeTheme.on('updated', applyTheme);
  applyTheme();

  // dev: HZ_EVAL=file executes a test script inside chromeView (has hz.* api)
  if (process.env.HZ_EVAL) {
    setTimeout(async () => {
      try {
        const code = fs.readFileSync(process.env.HZ_EVAL, 'utf8');
        const r = await chromeView.webContents.executeJavaScript(code, true);
        console.log('[eval]', JSON.stringify(r));
      } catch (e) { console.error('[eval]', e.message); }
    }, parseInt(process.env.HZ_EVAL_DELAY || '6000', 10));
  }

  // dev: HZ_SHOT=dir dumps chrome+tab page PNGs after load settles
  if (process.env.HZ_SHOT) {
    setTimeout(async () => {
      try {
        const t = tabs.active;
        fs.writeFileSync(path.join(process.env.HZ_SHOT, 'chrome.png'), (await chromeView.webContents.capturePage()).toPNG());
        if (t) fs.writeFileSync(path.join(process.env.HZ_SHOT, 'tab.png'), (await t.wc.capturePage()).toPNG());
        console.log('[shot] saved');
      } catch (e) { console.error('[shot]', e.message); }
    }, parseInt(process.env.HZ_SHOT_DELAY || '9000', 10));
  }

  app.on('activate', () => { if (!win) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('will-quit', () => {});
