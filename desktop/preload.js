// Minimal preload for the settings window only. Exposes a safe,
// narrow API to the settings page; the main Tree window uses no preload.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('treeSettings', {
  get: () => ipcRenderer.invoke('settings:get'),
  save: (cfg) => ipcRenderer.invoke('settings:save', cfg),
  openConfigFile: () => ipcRenderer.invoke('settings:open-config-file'),
});
