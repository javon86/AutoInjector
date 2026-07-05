// main.js — Electron main process. Opens ChatGPT, Claude and Gemini as three real
// Chromium panes inside one window (each with its own persistent, isolated login
// session), alongside a control panel that's the primary view: compose a message,
// send it to any one/some/all of them, forward any pane's latest reply on demand or
// automatically, and toggle a global "Auto" mesh so enabled participants keep
// forwarding replies to each other hands-free (Pause halts it, Stop halts it and
// clears which participants are enabled). A lightweight poller reads each pane's
// latest assistant message every couple of seconds and treats it as "captured" once
// it stops changing. Every notable event (captures, sends, errors, routing changes)
// is also pushed to an in-app activity log for troubleshooting.
const { app, BaseWindow, WebContentsView, ipcMain } = require("electron");
const path = require("path");
const SITES = require("./selectors");
const { buildSendScript, buildReadScript } = require("./automation");

const SITE_IDS = Object.keys(SITES);
const POLL_MS = 1500;
const STABLE_MS = 1800;
const MAX_LOG = 300;
const SIDE_WIDTH_FRACTION = 0.32;
const SIDE_WIDTH_MAX = 520;

let win = null;
let controlsView = null;
const siteViews = {};

const state = {
  routing: {}, // site -> Set<target site id> to auto-forward new replies to
  captured: {}, // site -> { text, ts } | null — last stable reply seen
  pending: {}, // site -> { text, sinceTs } — used to detect when a reply has stopped changing
  busy: {}, // site -> bool — poll in flight, skip overlapping polls
  enabled: {}, // site -> bool — whether this participant counts for global Auto / "All"
  transcript: [], // { site, label, text, ts } — every captured reply, for export
  log: [], // { ts, kind, detail } — internal activity, for the troubleshooting panel
  meshActive: false, // whether global Auto is currently on
  panesHidden: false
};
for (const site of SITE_IDS) {
  state.routing[site] = new Set();
  state.captured[site] = null;
  state.pending[site] = { text: "", sinceTs: Date.now() };
  state.busy[site] = false;
  state.enabled[site] = true;
}

function logEvent(kind, detail) {
  const entry = { ts: Date.now(), kind, detail };
  state.log.push(entry);
  if (state.log.length > MAX_LOG) state.log.shift();
  sendToControls("log", entry);
}

function layout() {
  if (!win) return;
  const [w, h] = win.getContentSize();
  const sideWidth = state.panesHidden ? 0 : Math.min(SIDE_WIDTH_MAX, Math.floor(w * SIDE_WIDTH_FRACTION));
  controlsView.setBounds({ x: 0, y: 0, width: Math.max(0, w - sideWidth), height: h });
  const paneHeight = Math.floor(h / SITE_IDS.length);
  SITE_IDS.forEach((site, i) => {
    const y = i * paneHeight;
    const height = i === SITE_IDS.length - 1 ? h - y : paneHeight;
    siteViews[site].setBounds({ x: w - sideWidth, y, width: sideWidth, height });
  });
}

function createWindow() {
  win = new BaseWindow({ width: 1700, height: 1050, title: "AutoInjector Desktop — AI Roundtable" });

  controlsView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.contentView.addChildView(controlsView);
  controlsView.webContents.loadFile(path.join(__dirname, "controls.html"));

  for (const site of SITE_IDS) {
    const view = new WebContentsView({ webPreferences: { partition: `persist:${site}` } });
    win.contentView.addChildView(view);
    view.webContents.loadURL(SITES[site].home);
    siteViews[site] = view;
  }

  layout();
  win.on("resize", layout);
  win.on("closed", () => { win = null; });

  setInterval(() => { for (const site of SITE_IDS) pollSite(site); }, POLL_MS);
}

function sendToControls(channel, payload) {
  if (controlsView && !controlsView.webContents.isDestroyed()) {
    controlsView.webContents.send(channel, payload);
  }
}

function routingSnapshot() {
  const out = {};
  for (const site of SITE_IDS) out[site] = Array.from(state.routing[site]);
  return out;
}

function globalSnapshot() {
  return {
    routing: routingSnapshot(),
    enabled: { ...state.enabled },
    meshActive: state.meshActive,
    panesHidden: state.panesHidden
  };
}

async function sendTextTo(target, text, fromSite) {
  const view = siteViews[target];
  if (!view || view.webContents.isDestroyed()) {
    sendToControls("send-error", { target, error: "NO_VIEW" });
    logEvent("send-error", { target, error: "NO_VIEW" });
    return { ok: false, error: "NO_VIEW" };
  }
  const label = fromSite ? SITES[fromSite]?.label : null;
  const prompt = label ? `[${label} says]\n\n${text}` : text;

  let res;
  try {
    res = await view.webContents.executeJavaScript(buildSendScript(target, prompt), true);
  } catch (e) {
    res = { ok: false, error: String(e) };
  }
  if (!res || !res.ok) {
    sendToControls("send-error", { target, error: res?.error || "unknown" });
    logEvent("send-error", { target, from: fromSite || null, error: res?.error || "unknown" });
  } else {
    sendToControls("sent", { target, from: fromSite || null, ts: Date.now() });
    logEvent("sent", { target, from: fromSite || null });
  }
  return res;
}

async function pollSite(site) {
  if (state.busy[site]) return;
  const view = siteViews[site];
  if (!view || view.webContents.isDestroyed()) return;
  state.busy[site] = true;
  try {
    const res = await view.webContents.executeJavaScript(buildReadScript(site));
    const text = (res && res.text) || "";
    const pend = state.pending[site];

    if (!text) { state.pending[site] = { text: "", sinceTs: Date.now() }; return; }
    if (text !== pend.text) { state.pending[site] = { text, sinceTs: Date.now() }; return; }
    if (Date.now() - pend.sinceTs < STABLE_MS) return;

    const already = state.captured[site];
    if (already && already.text === text) return; // no new stable reply

    const turn = { site, label: SITES[site].label, text, ts: Date.now() };
    state.captured[site] = turn;
    state.transcript.push(turn);
    sendToControls("capture", turn);
    logEvent("captured", { site, chars: text.length });

    for (const target of state.routing[site]) {
      if (target === site) continue;
      await sendTextTo(target, text, site);
    }
  } catch (e) {
    logEvent("poll-error", { site, error: String(e) });
  } finally {
    state.busy[site] = false;
  }
}

ipcMain.handle("send:compose", async (_evt, { text, targets }) => {
  const list = Array.isArray(targets) ? targets.filter((t) => SITES[t]) : [];
  if (!text || !list.length) return { ok: false, error: "NEED_TEXT_AND_TARGET" };
  logEvent("compose", { targets: list, chars: text.length });
  const results = {};
  for (const t of list) results[t] = await sendTextTo(t, text, null);
  return { ok: true, results };
});

ipcMain.handle("send:forward", async (_evt, { source, targets }) => {
  const cap = state.captured[source];
  if (!cap) return { ok: false, error: "NOTHING_CAPTURED_YET" };
  const list = Array.isArray(targets) ? targets.filter((t) => SITES[t] && t !== source) : [];
  if (!list.length) return { ok: false, error: "NO_TARGETS" };
  const results = {};
  for (const t of list) results[t] = await sendTextTo(t, cap.text, source);
  return { ok: true, results };
});

ipcMain.handle("routing:set", (_evt, { source, target, enabled }) => {
  if (!SITES[source] || !SITES[target] || source === target) return { ok: false, error: "BAD_ROUTE" };
  if (enabled) state.routing[source].add(target); else state.routing[source].delete(target);
  logEvent("routing-changed", { source, target, enabled });
  return { ok: true, routing: routingSnapshot() };
});

ipcMain.handle("routing:pause-all", () => {
  for (const site of SITE_IDS) state.routing[site].clear();
  state.meshActive = false;
  logEvent("paused", {});
  return { ok: true, global: globalSnapshot() };
});

ipcMain.handle("routing:stop-all", () => {
  for (const site of SITE_IDS) { state.routing[site].clear(); state.enabled[site] = false; }
  state.meshActive = false;
  logEvent("stopped", {});
  return { ok: true, global: globalSnapshot() };
});

ipcMain.handle("routing:auto-all", () => {
  const active = SITE_IDS.filter((s) => state.enabled[s]);
  for (const s of SITE_IDS) {
    state.routing[s] = state.enabled[s] ? new Set(active.filter((t) => t !== s)) : new Set();
  }
  state.meshActive = active.length >= 2;
  logEvent("auto-mesh-enabled", { participants: active });
  return { ok: true, global: globalSnapshot() };
});

ipcMain.handle("participants:set", (_evt, { site, enabled }) => {
  if (!SITES[site]) return { ok: false, error: "BAD_SITE" };
  state.enabled[site] = !!enabled;
  if (!enabled) state.routing[site].clear();
  logEvent("participant-changed", { site, enabled: !!enabled });
  return { ok: true, global: globalSnapshot() };
});

ipcMain.handle("layout:set-panes-hidden", (_evt, hidden) => {
  state.panesHidden = !!hidden;
  layout();
  return { ok: true, global: globalSnapshot() };
});

ipcMain.handle("state:get", () => ({
  ok: true,
  global: globalSnapshot(),
  captured: state.captured,
  transcript: state.transcript,
  log: state.log
}));

ipcMain.handle("transcript:clear", () => { state.transcript = []; return { ok: true }; });

ipcMain.handle("site:reload", (_evt, site) => {
  const view = siteViews[site];
  if (!view) return { ok: false, error: "NO_VIEW" };
  view.webContents.loadURL(SITES[site].home);
  state.pending[site] = { text: "", sinceTs: Date.now() };
  state.captured[site] = null;
  logEvent("reload", { site });
  return { ok: true };
});

ipcMain.handle("site:inspect", (_evt, site) => {
  const view = siteViews[site];
  if (!view) return { ok: false, error: "NO_VIEW" };
  view.webContents.openDevTools({ mode: "detach" });
  logEvent("inspect-opened", { site });
  return { ok: true };
});

ipcMain.handle("site:list", () => {
  const out = {};
  for (const site of SITE_IDS) {
    const view = siteViews[site];
    out[site] = view ? { url: view.webContents.getURL(), title: view.webContents.getTitle(), label: SITES[site].label } : null;
  }
  return { ok: true, sites: out };
});

app.whenReady().then(createWindow);
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("activate", () => { if (!win) createWindow(); });
