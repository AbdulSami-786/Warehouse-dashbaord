// Gives the dashboard a place on disk for its offline copy of the Sheet
// (src/lib/hybridAdapter.js). Files, not localStorage: a few years of bills and
// activity log outgrow the browser's storage limit.
//
// Synchronous on purpose — the data layer reads and writes the whole database
// in one step, the same way it uses localStorage.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopStore', {
  get: (key) => ipcRenderer.sendSync('store:get', String(key)),
  set: (key, value) => {
    const res = ipcRenderer.sendSync('store:set', String(key), String(value));
    if (res !== true) throw new Error(res || 'Could not save to this computer');
  },
  remove: (key) => ipcRenderer.sendSync('store:remove', String(key)),
});
