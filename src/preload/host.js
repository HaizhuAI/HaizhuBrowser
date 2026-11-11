'use strict';
// Host preload — exposes a narrow, safe API surface to the chrome UI and the
// docked panel. No raw ipcRenderer access leaks into pages.
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (ch, ...args) => ipcRenderer.invoke(ch, ...args);
const send = (ch, ...args) => ipcRenderer.send(ch, ...args);
const on = (ch, fn) => { const h = (e, ...a) => fn(...a); ipcRenderer.on(ch, h); return () => ipcRenderer.removeListener(ch, h); };

contextBridge.exposeInMainWorld('hz', {
  tabs: {
    list: () => invoke('tabs:list'),
    open: (url, opts) => invoke('tabs:open', url, opts),
    close: id => invoke('tabs:close', id),
    activate: id => invoke('tabs:activate', id),
    navigate: url => invoke('tabs:navigate', url),
    back: () => invoke('tabs:go', 'back'),
    fwd: () => invoke('tabs:go', 'fwd'),
    reload: () => invoke('tabs:go', 'reload'),
    state: () => invoke('tabs:state'),
    devtools: id => invoke('tabs:devtools', id),
    onUpdated: fn => on('tab-updated', fn),
    onAdded: fn => on('tab-added', fn),
    onClosed: fn => on('tab-closed', fn),
    onActivated: fn => on('tab-activated', fn)
  },
  panel: {
    toggle: () => invoke('panel:toggle'),
    onState: fn => on('panel-state', fn)
  },
  capture: {
    toggle: t => invoke('cap:toggle', t),
    list: t => invoke('cap:list', t),
    body: (id, t) => invoke('cap:body', id, t),
    har: t => invoke('cap:har', t),
    clear: t => invoke('cap:clear', t)
  },
  sniff: {
    list: t => invoke('sniff:list', t),
    download: (url, name) => invoke('sniff:download', url, name),
    jobs: () => invoke('sniff:jobs'),
    open: url => invoke('sniff:open', url)
  },
  proxy: {
    list: () => invoke('proxy:list'),
    add: p => invoke('proxy:add', p),
    update: (id, p) => invoke('proxy:update', id, p),
    remove: id => invoke('proxy:remove', id),
    set: id => invoke('proxy:set', id)
  },
  stealth: {
    audit: () => invoke('stealth:audit'),
    solve: () => invoke('stealth:solve')
  },
  fp: {
    get: () => invoke('fp:get'),
    set: s => invoke('fp:set', s),
    rotate: () => invoke('fp:rotate'),
    persona: () => invoke('fp:persona')
  },
  profiles: {
    list: () => invoke('prof:list'),
    create: p => invoke('prof:create', p),
    update: (id, p) => invoke('prof:update', id, p),
    remove: id => invoke('prof:remove', id),
    duplicate: id => invoke('prof:duplicate', id),
    reseed: id => invoke('prof:reseed', id),
    launch: (id, url) => invoke('prof:launch', id, url),
    persona: id => invoke('prof:persona', id)
  },
  us: {
    list: () => invoke('us:list'),
    get: id => invoke('us:get', id),
    save: (id, code) => invoke('us:save', id, code),
    create: code => invoke('us:create', code),
    remove: id => invoke('us:remove', id),
    toggle: (id, on) => invoke('us:toggle', id, on),
    installUrl: url => invoke('us:installUrl', url),
    onInstalled: fn => on('userscript-installed', fn)
  },
  ext: {
    list: () => invoke('ext:list'),
    install: () => invoke('ext:pick-install'),
    toggle: (dir, on) => invoke('ext:toggle', dir, on),
    remove: dir => invoke('ext:remove', dir)
  },
  ck: {
    list: f => invoke('ck:list', f),
    set: c => invoke('ck:set', c),
    del: (u, n) => invoke('ck:del', u, n),
    clear: () => invoke('ck:clear')
  },
  ai: {
    providers: () => invoke('ai:providers'),
    addEndpoint: e => invoke('ai:addEndpoint', e),
    removeEndpoint: id => invoke('ai:removeEndpoint', id),
    setActive: id => invoke('ai:setActive', id),
    models: id => invoke('ai:models', id),
    chat: (m, o) => invoke('ai:chat', m, o),
    agent: (m, t) => invoke('ai:agent', m, t),
    onEvent: fn => on('ai:event', fn)
  },
  ab: {
    toggle: on => invoke('ab:toggle', on),
    state: () => invoke('ab:state')
  },
  hist: {
    list: l => invoke('hist:list', l),
    clear: () => invoke('hist:clear')
  },
  page: {
    viewSource: () => invoke('page:viewSource'),
    print: () => invoke('page:print'),
    zoom: d => invoke('page:zoom', d)
  },
  ui: {
    menu: () => invoke('ui:menu'),
    onMenuCmd: fn => on('menu:cmd', fn)
  },
  app: {
    version: () => invoke('app:version'),
    winctl: op => invoke('win:ctl', op),
    winstate: () => invoke('win:state'),
    dragbegin: (x, y, sy) => send('win:drag-begin', x, y, sy),
    dragmove: (x, y, sy) => send('win:drag-move', x, y, sy),
    dragend: () => send('win:drag-end'),
    onWinState: fn => on('win-state', fn),
    opendownloads: () => invoke('app:opendownloads'),
    i18n: () => invoke('app:i18n'),
    onBmBar: fn => on('bmbar-state', fn),
    theme: () => invoke('app:theme'),
    onTheme: fn => on('theme-changed', fn),
    onI18n: fn => on('i18n-changed', fn)
  },
  settings: {
    get: k => invoke('settings:get', k),
    set: (k, v) => invoke('settings:set', k, v)
  },
  mcp: {
    state: () => invoke('mcp:state'),
    set: c => invoke('mcp:set', c),
    regen: () => invoke('mcp:regen'),
    config: () => invoke('mcp:config')
  },
  // test-only: only resolves when the main process registered dev hooks (HZ_EVAL)
  bm: {
    list: () => invoke('bm:list'),
    add: b => invoke('bm:add', b),
    del: id => invoke('bm:del', id),
    togglebar: () => invoke('bm:bartoggle'),
    barstate: () => invoke('bm:barstate'),
    menu: id => send('bm:menu', id),
    onChange: fn => on('bm-changed', fn)
  },
  mail: {
    providers: () => invoke('mail:providers'),
    gen: o => invoke('mail:gen', o),
    accounts: () => invoke('mail:accounts'),
    inbox: ref => invoke('mail:inbox', ref),
    read: (ref, id) => invoke('mail:read', ref, id),
    extract: (ref, id) => invoke('mail:extract', ref, id),
    delmsg: (ref, id) => invoke('mail:delmsg', ref, id),
    extend: ref => invoke('mail:extend', ref),
    send: (ref, to, subject, text) => invoke('mail:send', ref, to, subject, text),
    wait: (ref, o) => invoke('mail:wait', ref, o),
    remove: ref => invoke('mail:remove', ref)
  },
  dev: {
    click: (x, y) => invoke('dev:click', x, y),
    dblclick: (x, y) => invoke('dev:dblclick', x, y),
    restore: () => invoke('dev:restore'),
    shot: n => invoke('dev:shot', n),
    resize: (w, h) => invoke('dev:resize', w, h),
    probe: () => invoke('dev:probe'),
    drag: (x, y, dx, dy) => invoke('dev:drag', x, y, dx, dy),
    rclick: (x, y) => invoke('dev:rclick', x, y)
  }
});
