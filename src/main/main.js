'use strict';
const { app, BaseWindow, WebContentsView, session, ipcMain, dialog, shell, clipboard, Menu, nativeTheme, protocol, net, screen } = require('electron');
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');

const { Store } = require('./store');
const { FingerprintManager } = require('./fingerprint');
const { ProfileManager } = require('./profiles');
const { UserscriptEngine } = require('./userscripts');
const { CaptureManager, ResourceSniffer, M3U8Downloader } = require('./capture');
const { ProxyManager } = require('./proxy');
const { WebRequestHub } = require('./webhub');
const { AdBlock } = require('./adblock');
const { ExtensionManager } = require('./extensions');
const { AIModule, cookieApi, DUCK_MODELS, OpenAICompat } = require('./ai');
const { TabManager } = require('./tabs');
const { I18n } = require('./i18n');
const { McpServer } = require('./mcp');
const { Stealth } = require('./stealth');
const { TempMail } = require('./tempmail');

app.setName('Haizhu Browser');
// VM / software-GL environments: hardware acceleration crashes renderers
// when the GPU process dies (observed exit 143 killing tab renderers).
app.disableHardwareAcceleration();
// WebRTC: never advertise real local/public IPs via host candidates — the
// fingerprint layer rewrites advertised candidates to a seeded private IP.
app.commandLine.appendSwitch('force-webrtc-ip-handling-policy', 'default_public_interface_only');
// Stealth baseline: Chromium sets navigator.webdriver under automation —
// we never automate the renderer, but keep the standard kill-switch so no
// blink feature ever flips it on.
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');

const CHROME_H = 82;
const BM_BAR_H = 28;
const BM_SEED = [
  { id: 'hz-img', title: '生图站', url: 'https://design.haizhuai.art', icon: 'image' },
  { id: 'hz-api', title: '中转站', url: 'https://api.haizhuai.xyz', icon: 'relay' },
  { id: 'hz-blog', title: 'HaizhuAI中文社区', url: 'https://blog.haizhuai.art', icon: 'chat' },
  { id: 'hz-nav', title: 'HaizhuAI导航页', url: 'https://start.haizhuai.art', icon: 'compass' }
];
const chromeH = () => CHROME_H + (store.get('bmbar', true) ? BM_BAR_H : 0);
const NTP_URL = 'haizhu://newtab';
// privileged internal scheme for the new-tab page (must run pre-ready)
protocol.registerSchemesAsPrivileged([{
  scheme: 'haizhu',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false }
}]);

let win, chromeView, panelView;
let store, fingerprint, scripts, captures, sniffer, m3u8, proxy, adblock, extMgr, ai, tabs, hub, mcp, stealth, tempmail, attachProto = () => {};
let profiles;
let historyStore, i18n;
let panelOpen = false;
let layoutAllRef = null;

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
  for (const ev of ['maximize', 'unmaximize', 'minimize', 'restore']) {
    win.on(ev, () => {
      if (win && !win.isDestroyed() && chromeView && !chromeView.webContents.isDestroyed()) {
        chromeView.webContents.send('win-state', { max: win.isMaximized(), min: win.isMinimized() });
      }
    });
  }

  // chrome UI
  chromeView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'host.js'),
      contextIsolation: true, sandbox: false
    }
  });
  chromeView.webContents.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.contentView.addChildView(chromeView);

  const layoutAll = layoutAllRef = () => {
    const [w, h] = win.getContentSize();
    chromeView.setBounds({ x: 0, y: 0, width: w, height: chromeH() });
    tabs.setChromeHeight(chromeH());
    tabs.layout();
    layoutPanel(w, h);
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
  if (panelView) panelView.setBounds({ x: w - 420, y: chromeH(), width: 420, height: h - chromeH() });
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
    captures, sniffer, scripts, tempmail,
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
      { label: t('menu.bmbar'), type: 'checkbox', checked: store.get('bmbar', true), accelerator: 'Ctrl+Shift+B', click: () => send('bmbar') },
      { label: t('menu.bmadd'), accelerator: 'Ctrl+D', click: () => send('bmadd') },
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
  ipcMain.handle('stealth:audit', () => tabs && tabs.active ? stealth.audit(tabs.active) : null);
  ipcMain.handle('stealth:solve', () => tabs && tabs.active ? stealth.solveTurnstile(tabs.active) : null);

  // profiles — isolated fingerprint+proxy environments (bitbrowser-style)
  ipcMain.handle('prof:list', () => profiles.profiles.map(p => ({
    ...p, proxyName: (profiles.proxyById(p.proxyId) || {}).name || p.proxyId || 'direct',
    open: [...tabs.tabs.values()].some(t => t.profile && t.profile.id === p.id),
  })));
  ipcMain.handle('prof:create', (e, p) => profiles.create(p));
  ipcMain.handle('prof:update', (e, id, patch) => profiles.update(id, patch));
  ipcMain.handle('prof:remove', async (e, id) => {
    for (const t of [...tabs.tabs.values()]) if (t.profile && t.profile.id === id) tabs.closeTab(t.id);
    return profiles.remove(id);
  });
  ipcMain.handle('prof:duplicate', (e, id) => profiles.duplicate(id));
  ipcMain.handle('prof:reseed', (e, id) => profiles.reseed(id));
  ipcMain.handle('prof:launch', (e, id, url) => {
    const t = tabs.openTab(url || 'haizhu://newtab', true, { profileId: id });
    return t ? t.serialize() : null;
  });
  ipcMain.handle('prof:persona', (e, id) => {
    const p = profiles.get(id); return p ? profiles.personaFor(p) : null;
  });

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
  // ---- bookmarks ----
  if (!store.get('bm.seeded')) { store.set('bookmarks', BM_SEED); store.set('bm.seeded', true); }
  else { // migrate guessed /favicon.ico URLs on seed entries -> inline icons
    const list = store.get('bookmarks', []);
    let dirty = false;
    for (const b of list) {
      const seed = BM_SEED.find(s => s.id === b.id || s.url === b.url);
      if (!seed) continue;
      if (b.fav && b.fav.endsWith('/favicon.ico')) { delete b.fav; b.icon = seed.icon; dirty = true; }
      if (b.url !== seed.url) { b.url = seed.url; b.title = seed.title; delete b.fav; b.icon = seed.icon; dirty = true; }
    }
    if (dirty) store.set('bookmarks', list);
  }
  const bmSave = list => { store.set('bookmarks', list); broadcast('bm-changed', list); return list; };
  ipcMain.handle('bm:list', () => store.get('bookmarks', []));
  ipcMain.handle('bm:add', (e, b) => {
    const list = store.get('bookmarks', []);
    if (!list.some(x => x.url === b.url)) list.push({ id: 'bm' + Date.now().toString(36), title: b.title || b.url, url: b.url, fav: b.fav || '' });
    return bmSave(list);
  });
  ipcMain.handle('bm:del', (e, id) => bmSave(store.get('bookmarks', []).filter(x => x.id !== id)));
  ipcMain.handle('bm:bartoggle', () => {
    store.set('bmbar', !store.get('bmbar', true));
    layoutAllRef && layoutAllRef();
    broadcast('bmbar-state', store.get('bmbar'));
    return store.get('bmbar');
  });
  ipcMain.handle('bm:barstate', () => store.get('bmbar', true));
  ipcMain.on('bm:menu', (e, id) => {
    const bm = (store.get('bookmarks', []) || []).find(x => x.id === id);
    if (!bm) return;
    Menu.buildFromTemplate([
      { label: i18n.t('menu.bmnewtab'), click: () => tabs.openTab(bm.url, true) },
      { label: i18n.t('menu.bmdel'), click: () => bmSave(store.get('bookmarks', []).filter(x => x.id !== id)) }
    ]).popup({ window: win });
  });
  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.handle('win:ctl', (e, op) => {
    if (!win || win.isDestroyed()) return { max: false };
    if (op === 'min') win.minimize();
    else if (op === 'close') { win.close(); return { max: false }; }
    else win.isMaximized() ? win.unmaximize() : win.maximize();
    return { max: win.isMaximized() };
  });
  ipcMain.handle('win:state', () => (win && !win.isDestroyed()) ? { max: win.isMaximized(), min: win.isMinimized() } : { max: false, min: false });
  // manual titlebar drag: -webkit-app-region:drag is a no-op inside
  // WebContentsView, so the renderer forwards mouse screen-coords and the
  // main process moves the window. Includes Chrome behaviors: drag-from-
  // maximized restores under the cursor, top-edge drag maximizes (snap).
  let dragSt = null;
  // x,y are client (chromeView/window) coords — present for real and
  // synthesized input. sy is screenY when available (real input only),
  // used for the top-edge snap check.
  ipcMain.on('win:drag-begin', (e, sx, sy, scrY) => {
    dragSt = { sx, sy, scrY, pos: win.getPosition(), maxed: win.isMaximized(), moved: false };
  });
  ipcMain.on('win:drag-move', (e, x, y, scrY) => {
    if (!dragSt || win.isDestroyed()) return;
    const dx = x - dragSt.sx, dy = y - dragSt.sy;
    if (!dragSt.moved && dx * dx + dy * dy < 16) return;
    if (dragSt.maxed) {
      // pull-down from maximized: restore with cursor holding the bar
      const nb = win.getNormalBounds(), mb = win.getBounds();
      const ratio = mb.width ? Math.min(1, Math.max(0, (x - mb.x) / mb.width)) : 0.5;
      dragSt.maxed = false;
      dragSt.moved = true;
      dragSt.grabX = Math.round(nb.width * ratio);
      dragSt.grabY = 14;
      win.unmaximize();
      win.setPosition(Math.round(x - dragSt.grabX), Math.round(y - dragSt.grabY));
      dragSt.sx = x; dragSt.sy = y; dragSt.pos = win.getPosition();
      return;
    }
    dragSt.moved = true;
    if (scrY) { // top-edge snap only verifiable with real screen coords
      const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
      if (scrY <= wa.y + 4) {
        if (!win.isMaximized()) { win.maximize(); dragSt.maxed = true; dragSt.moved = false; }
        dragSt.sx = x; dragSt.sy = y; dragSt.pos = win.getPosition();
        return;
      }
    }
    const gx = dragSt.grabX ?? (dragSt.sx - dragSt.pos[0]);
    const gy = dragSt.grabY ?? (dragSt.sy - dragSt.pos[1]);
    if (!win.isMaximized()) win.setPosition(Math.round(x - gx), Math.round(y - gy));
  });
  ipcMain.on('win:drag-end', () => { dragSt = null; });
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

  // MCP server — external agents drive the browser over localhost HTTP/stdio
  ipcMain.handle('mcp:state', () => mcp ? mcp.state() : { enabled: false, running: false });
  ipcMain.handle('mcp:set', (e, cfg) => mcp ? mcp.applyConfig(cfg) : null);
  ipcMain.handle('mcp:regen', () => mcp ? mcp.regenToken() : null);
  ipcMain.handle('mcp:config', () => mcp ? mcp.clientConfig(mcp.installBridge()) : null);

  ipcMain.handle('mail:providers', () => tempmail.providers());
  ipcMain.handle('mail:gen', (e, o) => tempmail.generate(o || {}));
  ipcMain.handle('mail:accounts', () => tempmail.accounts.map(a => ({ id: a.id, provider: a.provider, address: a.address, type: a.type, createdAt: a.createdAt })));
  ipcMain.handle('mail:inbox', (e, ref) => tempmail.inbox(ref));
  ipcMain.handle('mail:read', (e, ref, msgId) => tempmail.read(ref, msgId));
  ipcMain.handle('mail:extract', (e, ref, msgId) => tempmail.readExtract(ref, msgId));
  ipcMain.handle('mail:delmsg', (e, ref, msgId) => tempmail.deleteMessage(ref, msgId));
  ipcMain.handle('mail:extend', (e, ref) => tempmail.extend(ref));
  ipcMain.handle('mail:send', (e, ref, to, subject, text) => tempmail.send(ref, to, subject, text));
  ipcMain.handle('mail:wait', (e, ref, o) => tempmail.waitForMail(ref, o || {}));
  ipcMain.handle('mail:remove', (e, ref) => tempmail.remove(ref));
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
  profiles = new ProfileManager(store, proxy, fingerprint);
  adblock = new AdBlock(store);
  extMgr = new ExtensionManager(store);
  stealth = new Stealth();
  tempmail = new TempMail(store);

  tabs = new TabManager({
    get win() { return win; },
    fingerprint, scripts, captures, sniffer, adblock, proxy, store, stealth,
    history, broadcast,
    layoutPanel,
    profiles,
    onSession: (s, tab) => {
      attachProto(s); if (hub) hub.attach(s);
      if (stealth) stealth.attachSession(s);
      if (tab && tab.profile) profiles.bindSession(s, tab.profile);
    },
    // in-page context menu — WebContentsView ships no default menu; every
    // entry must be a real working action (no decorative items).
    contextMenu: (tab, p) => {
      const wc = tab.wc;
      const tc = (k, v) => i18n.t('ctx.' + k, v);
      const items = [];
      const sel = (p.selectionText || '').trim();
      if (p.isEditable) {
        const f = p.editFlags || {};
        items.push(
          { label: tc('undo'), role: 'undo', enabled: !!f.canUndo },
          { label: tc('redo'), role: 'redo', enabled: !!f.canRedo },
          { type: 'separator' },
          { label: tc('cut'), role: 'cut', enabled: !!f.canCut },
          { label: tc('copy'), role: 'copy', enabled: !!f.canCopy },
          { label: tc('paste'), role: 'paste', enabled: !!f.canPaste },
          { label: tc('selectall'), role: 'selectAll' });
      } else {
        if (p.linkURL) items.push(
          { label: tc('openlink'), click: () => tabs.openTab(p.linkURL, true) },
          { label: tc('copylink'), click: () => clipboard.writeText(p.linkURL) },
          { type: 'separator' });
        if (p.mediaType === 'image' && p.srcURL) items.push(
          { label: tc('openimg'), click: () => tabs.openTab(p.srcURL, true) },
          { label: tc('copyimg'), click: () => wc.copyImageAt(p.x, p.y) },
          { label: tc('copyimgaddr'), click: () => clipboard.writeText(p.srcURL) },
          { label: tc('saveimg'), click: () => wc.downloadURL(p.srcURL) },
          { type: 'separator' });
        if ((p.mediaType === 'video' || p.mediaType === 'audio') && p.srcURL) items.push(
          { label: tc('openav'), click: () => tabs.openTab(p.srcURL, true) },
          { label: tc('copymedia'), click: () => clipboard.writeText(p.srcURL) },
          { type: 'separator' });
        if (sel) items.push(
          { label: tc('copy'), role: 'copy' },
          { label: tc('searchsel', { text: sel.length > 24 ? sel.slice(0, 24) + '…' : sel }), click: () => tabs.openTab(sel, true) },
          { type: 'separator' });
        const nav = wc.navigationHistory;
        items.push(
          { label: tc('back'), enabled: nav ? nav.canGoBack() : wc.canGoBack(), click: () => nav ? nav.goBack() : wc.goBack() },
          { label: tc('forward'), enabled: nav ? nav.canGoForward() : wc.canGoForward(), click: () => nav ? nav.goForward() : wc.goForward() },
          { label: tc('reload'), click: () => wc.reload() },
          { type: 'separator' },
          { label: tc('savepage'), click: async () => {
              const r = await dialog.showSaveDialog(win, { defaultPath: (tab.title || 'page') + '.html' });
              if (!r.canceled && r.filePath) wc.savePage(r.filePath, 'HTMLComplete').catch(() => {});
            } },
          { label: i18n.t('menu.viewsource'), click: () => tabs.openTab('view-source:' + wc.getURL(), true) },
          { label: tc('inspect'), click: () => wc.openDevTools({ mode: 'right' }) });
      }
      if (process.env.HZ_DEBUG) console.log('[ctx] media=%s link=%s sel=%d edit=%s items=%d', p.mediaType || '-', !!p.linkURL, sel.length, !!p.isEditable, items.length);
      // anchor at the click point inside the page view, not the OS cursor —
      // popup() without x/y uses the physical cursor, which may sit on another
      // monitor or outside the window entirely.
      const vb = tab.view.getBounds();
      if (items.length) Menu.buildFromTemplate(items).popup({ window: win, x: Math.round(vb.x + p.x), y: Math.round(vb.y + p.y) });
    }
  });
  ai = new AIModule(store, null);

  mcp = new McpServer(store, {
    tabs, ai, captures, sniffer, m3u8, proxy, profiles, adblock, scripts, stealth, tempmail,
    history: l => history.list(l),
    bookmarks: () => store.get('bookmarks', []),
    applyNetworkStack,
    userData: app.getPath('userData'),
    version: app.getVersion()
  });
  if (store.get('mcp.enabled', false)) mcp.start();

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
  // profile-bound sessions: rewrite UA + UA-CH + Accept-Language at wire level
  hub.on('reqHeaders', (d, ses) => stealth.headerRewrite(d, ses)); // baseline Chrome identity, in-place mutation
  hub.on('reqHeaders', (d, ses) => profiles.headerRewrite(d, ses));
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

  // proxy auth handler — profile sessions use their bound proxy's credentials
  app.on('login', (ev, wc, details, authInfo, cb) => {
    ev.preventDefault();
    if (authInfo.isProxy) {
      const prof = wc && profiles ? profiles.profileForSession(wc.session) : null;
      const px = prof ? profiles.proxyById(prof.proxyId) : proxy.active();
      const cred = proxy.credentials(px);
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
  // test-only hooks: real OS-level input events + window state assertions.
  // Registered ONLY when HZ_EVAL is set — never present in production.
  if (process.env.HZ_EVAL) {
    ipcMain.handle('dev:click', async (e, x, y) => {
      chromeView.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 });
      await new Promise(r => setTimeout(r, 40));
      chromeView.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 });
      await new Promise(r => setTimeout(r, 350));
      return { max: win.isMaximized(), min: win.isMinimized(), focused: win.isFocused(), visible: win.isVisible() };
    });
    ipcMain.handle('dev:dblclick', async (e, x, y) => {
      for (let i = 0; i < 2; i++) {
        chromeView.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: i + 1 });
        await new Promise(r => setTimeout(r, 30));
        chromeView.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: i + 1 });
        if (!i) await new Promise(r => setTimeout(r, 60));
      }
      await new Promise(r => setTimeout(r, 350));
      return { max: win.isMaximized() };
    });
    ipcMain.handle('dev:restore', () => { try { win.restore(); win.focus(); } catch (e) {} return { min: win.isMinimized(), max: win.isMaximized() }; });
    ipcMain.handle('dev:drag', async (e, x, y, dx, dy) => {
      const before = win.getPosition();
      chromeView.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(x), y: Math.round(y) });
      chromeView.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 });
      for (let i = 1; i <= 6; i++) {
        chromeView.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(x + dx * i / 6), y: Math.round(y + dy * i / 6) });
        await new Promise(r => setTimeout(r, 30));
      }
      chromeView.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(x + dx), y: Math.round(y + dy), button: 'left', clickCount: 1 });
      await new Promise(r => setTimeout(r, 400));
      return { before, after: win.getPosition() };
    });
    ipcMain.handle('dev:shot', async (e, name) => {
      const dir = process.env.HZ_SHOT || path.join(app.getPath('temp'), 'hzshot');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, String(name) + '.png'), (await chromeView.webContents.capturePage()).toPNG());
      if (panelView) fs.writeFileSync(path.join(dir, String(name) + '-panel.png'), (await panelView.webContents.capturePage()).toPNG());
      const t = tabs && tabs.active;
      if (t) fs.writeFileSync(path.join(dir, String(name) + '-tab.png'), (await t.wc.capturePage()).toPNG());
      return true;
    });
    ipcMain.handle('dev:resize', (e, w, h) => { win.setSize(w, h); return win.getSize(); });
    ipcMain.handle('dev:rclick', async (e, x, y) => {
      const t = tabs && tabs.active;
      if (!t) return { ok: false };
      // Windows fires context-menu on right-button RELEASE, so send the full
      // down/up pair; the menu pops after the up is already consumed.
      t.wc.sendInputEvent({ type: 'mouseDown', x: Math.round(x), y: Math.round(y), button: 'right', clickCount: 1 });
      await new Promise(r => setTimeout(r, 40));
      t.wc.sendInputEvent({ type: 'mouseUp', x: Math.round(x), y: Math.round(y), button: 'right', clickCount: 1 });
      await new Promise(r => setTimeout(r, 900));
      return { ok: true };
    });
    ipcMain.handle('dev:probe', async () => {
      const before = { max: win.isMaximized(), min: win.isMinimized(), maxable: win.isMaximizable(), minable: win.isMinimizable(), resizable: win.isResizable() };
      win.maximize();
      await new Promise(r => setTimeout(r, 500));
      const after = { max: win.isMaximized(), min: win.isMinimized() };
      let ctlResult = 'not-run';
      try {
        const r2 = await ipcMain.emit ? 'has-emit' : 'no-emit';
        ctlResult = r2;
      } catch (e) { ctlResult = e.message; }
      win.unmaximize();
      return { before, after, bounds: win.getNormalBounds(), resizable: win.isResizable() };
    });
  }
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
        if (panelView) fs.writeFileSync(path.join(process.env.HZ_SHOT, 'panel.png'), (await panelView.webContents.capturePage()).toPNG());
        console.log('[shot] saved');
      } catch (e) { console.error('[shot]', e.message); }
    }, parseInt(process.env.HZ_SHOT_DELAY || '9000', 10));
  }

  app.on('activate', () => { if (!win) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('will-quit', () => {});
