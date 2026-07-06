// preload.js — runs in the control panel pane before controls.html loads. Exposes a
// small, explicit API bridge instead of giving the renderer raw Node/IPC access.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  sendCompose: (text, targets) => ipcRenderer.invoke("send:compose", { text, targets }),
  sendForward: (source, targets) => ipcRenderer.invoke("send:forward", { source, targets }),
  regenerate: (site) => ipcRenderer.invoke("send:regenerate", site),
  setRouting: (source, target, enabled) => ipcRenderer.invoke("routing:set", { source, target, enabled }),
  pauseAllRouting: () => ipcRenderer.invoke("routing:pause-all"),
  stopAllRouting: () => ipcRenderer.invoke("routing:stop-all"),
  autoAllRouting: () => ipcRenderer.invoke("routing:auto-all"),
  setParticipant: (site, enabled) => ipcRenderer.invoke("participants:set", { site, enabled }),
  getState: () => ipcRenderer.invoke("state:get"),
  clearTranscript: () => ipcRenderer.invoke("transcript:clear"),
  togglePin: (id) => ipcRenderer.invoke("transcript:toggle-pin", id),
  reloadSite: (site) => ipcRenderer.invoke("site:reload", site),
  inspectSite: (site) => ipcRenderer.invoke("site:inspect", site),
  listSites: () => ipcRenderer.invoke("site:list"),
  onCapture: (cb) => ipcRenderer.on("capture", (_e, payload) => cb(payload)),
  onSent: (cb) => ipcRenderer.on("sent", (_e, payload) => cb(payload)),
  onSendError: (cb) => ipcRenderer.on("send-error", (_e, payload) => cb(payload)),
  onWaitingChanged: (cb) => ipcRenderer.on("waiting-changed", (_e, payload) => cb(payload)),
  onLog: (cb) => ipcRenderer.on("log", (_e, payload) => cb(payload))
});
