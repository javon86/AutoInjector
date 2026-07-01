// preload.js — runs in the control panel pane before controls.html loads. Exposes a
// small, explicit API bridge instead of giving the renderer raw Node/IPC access.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  sendCompose: (text, targets) => ipcRenderer.invoke("send:compose", { text, targets }),
  sendForward: (source, targets) => ipcRenderer.invoke("send:forward", { source, targets }),
  setRouting: (source, target, enabled) => ipcRenderer.invoke("routing:set", { source, target, enabled }),
  pauseAllRouting: () => ipcRenderer.invoke("routing:pause-all"),
  getState: () => ipcRenderer.invoke("state:get"),
  clearTranscript: () => ipcRenderer.invoke("transcript:clear"),
  reloadSite: (site) => ipcRenderer.invoke("site:reload", site),
  listSites: () => ipcRenderer.invoke("site:list"),
  onCapture: (cb) => ipcRenderer.on("capture", (_e, payload) => cb(payload)),
  onSent: (cb) => ipcRenderer.on("sent", (_e, payload) => cb(payload)),
  onSendError: (cb) => ipcRenderer.on("send-error", (_e, payload) => cb(payload))
});
