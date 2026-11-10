'use strict';
// Internal pages preload — bridge for haizhu:// pages (newtab, settings).
// Exposes navigation, history, settings, theme and i18n; nothing else.
const { contextBridge, ipcRenderer } = require('electron');
const invoke = (ch, ...a) => ipcRenderer.invoke(ch, ...a);
const on = (ch, fn) => { const h = (e, ...a) => fn(...a); ipcRenderer.on(ch, h); return () => ipcRenderer.removeListener(ch, h); };

contextBridge.exposeInMainWorld('hzNav', {
  go: q => ipcRenderer.send('ntp:go', q),
  history: () => invoke('ntp:history'),
  version: () => invoke('app:version'),
  wallpaper: () => invoke('ntp:wallpaper'),
  i18n: () => invoke('app:i18n'),
  theme: () => invoke('app:theme'),
  onTheme: fn => on('theme-changed', fn),
  onI18n: fn => on('i18n-changed', fn),
  settings: {
    get: k => invoke('settings:get', k),
    set: (k, v) => invoke('settings:set', k, v)
  },
  ab: {
    state: () => invoke('ab:state'),
    toggle: on => invoke('ab:toggle', on)
  },
  ck: { clear: () => invoke('ck:clear') }
});
