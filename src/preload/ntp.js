'use strict';
// ntp preload — tiny bridge for the internal new-tab page (haizhu://newtab)
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('hzNav', {
  go: q => ipcRenderer.send('ntp:go', q),
  history: () => ipcRenderer.invoke('ntp:history')
});
