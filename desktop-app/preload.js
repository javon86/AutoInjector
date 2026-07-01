// preload.js — runs in the control panel pane before controls.html loads. Exposes a
// small, explicit API bridge instead of giving the renderer raw Node/IPC access.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  startRoundtable: (cfg) => ipcRenderer.invoke("roundtable:start", cfg),
  stopRoundtable: () => ipcRenderer.invoke("roundtable:stop"),
  getRoundtable: () => ipcRenderer.invoke("roundtable:get"),
  clearRoundtable: () => ipcRenderer.invoke("roundtable:clear"),
  reloadSite: (site) => ipcRenderer.invoke("site:reload", site),
  listSites: () => ipcRenderer.invoke("site:list"),
  onTurnStart: (cb) => ipcRenderer.on("roundtable:turn-start", (_e, payload) => cb(payload)),
  onTurn: (cb) => ipcRenderer.on("roundtable:turn", (_e, payload) => cb(payload)),
  onError: (cb) => ipcRenderer.on("roundtable:error", (_e, payload) => cb(payload)),
  onDone: (cb) => ipcRenderer.on("roundtable:done", (_e, payload) => cb(payload))
});
