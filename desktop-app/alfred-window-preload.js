// alfred-window-preload.js — runs before alfred-window.html (🎩 Alfred's floating side panel).
// Exposes ONLY Alfred's API (the same names as preload.js, so alfred-panel.js runs unchanged in
// the drawer or in this window) — the panel window gets nothing else of the app.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  alfredStatus: () => ipcRenderer.invoke("alfred:status"),
  alfredSetEnabled: (on) => ipcRenderer.invoke("alfred:set-enabled", { on: !!on }),
  alfredSettings: (patch) => ipcRenderer.invoke("alfred:settings", patch || {}),
  alfredAsk: (text) => ipcRenderer.invoke("alfred:ask", { text }),
  alfredConfirm: (id, alwaysAllow) => ipcRenderer.invoke("alfred:confirm", { id, alwaysAllow: Array.isArray(alwaysAllow) ? alwaysAllow : [] }),
  alfredReject: (id) => ipcRenderer.invoke("alfred:reject", { id }),
  alfredCancel: () => ipcRenderer.invoke("alfred:cancel"),
  alfredClear: () => ipcRenderer.invoke("alfred:clear"),
  alfredTestAi: () => ipcRenderer.invoke("alfred:test-ai"),
  alfredModels: () => ipcRenderer.invoke("alfred:models"),
  alfredOpenPath: (path) => ipcRenderer.invoke("alfred:open-path", { path }),
  alfredPersonality: (patch) => ipcRenderer.invoke("alfred:personality", patch || null),
  alfredProfiles: () => ipcRenderer.invoke("alfred:profiles"),
  alfredSaveProfile: (name, renameFrom) => ipcRenderer.invoke("alfred:profile-save", { name, renameFrom: renameFrom == null ? undefined : renameFrom }),
  alfredUseProfile: (name) => ipcRenderer.invoke("alfred:profile-use", { name }),
  alfredDeleteProfile: (name) => ipcRenderer.invoke("alfred:profile-delete", { name }),
  alfredPanel: (patch) => ipcRenderer.invoke("alfred:panel", patch || null),
  alfredPanelToggle: (open) => ipcRenderer.invoke("alfred:panel-toggle", { open: typeof open === "boolean" ? open : undefined }),
  alfredShowButler: () => ipcRenderer.invoke("alfred:show-butler"),
  // "🩺 Check his AI": the one-button setup's check (llm:check) when this build has it, else alfred:test-ai
  llmCheck: () => ipcRenderer.invoke("llm:check"),
  onAlfred: (cb) => ipcRenderer.on("alfred", (_e, payload) => cb(payload)),
});
