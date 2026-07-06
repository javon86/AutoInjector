// main.js — Electron main process. Opens ChatGPT, Claude and Gemini as three real
// Chromium panes inside one window, each merged visually with its own control strip
// (preview, Forward, Auto, Regenerate) into a single column per AI — the control
// panel itself fills the whole window, and each AI's live browser pane is a native
// view composited into an empty "slot" div inside that column, its exact position
// measured live from the real page layout rather than hardcoded. Unchecking a
// participant collapses just its slot (and the pane inside it) while its control
// strip stays visible and usable. A lightweight poller reads each pane's latest
// assistant message every couple of seconds and treats it as "captured" once it
// stops changing. Every notable event is also pushed to an in-app activity log.
const { app, BaseWindow, WebContentsView, ipcMain } = require("electron");
const path = require("path");
const SITES = require("./selectors");
const { buildSendScript, buildReadScript } = require("./automation");

const SITE_IDS = Object.keys(SITES);
const POLL_MS = 1500;
const STABLE_MS = 1800;
const MAX_LOG = 300;
const PANE_SYNC_MS = 700;

let win = null;
let controlsView = null;
const siteViews = {};

const state = {
  routing: {}, // site -> Set<target site id> to auto-forward new replies to
  captured: {}, // site -> { id, site, label, text, ts, pinned } | null — last stable reply seen
  pending: {}, // site -> { text, sinceTs } — used to detect when a reply has stopped changing
  busy: {}, // site -> bool — poll in flight, skip overlapping polls
  waiting: {}, // site -> bool — a message was just sent, waiting on a fresh reply (drives the idle/generating dot)
  lastSentTo: {}, // site -> exact final text last sent to it (for Regenerate)
  enabled: {}, // site -> bool — participant is "in play": counts for Auto/"All" AND shows its pane
  transcript: [], // { id, site, label, text, ts, pinned } — every captured reply, for export
  log: [], // { ts, kind, detail } — internal activity, for the troubleshooting panel
  meshActive: false, // whether global Auto is currently on
  nextTurnId: 1
};
for (const site of SITE_IDS) {
  state.routing[site] = new Set();
  state.captured[site] = null;
  state.pending[site] = { text: "", sinceTs: Date.now() };
  state.busy[site] = false;
  state.waiting[site] = false;
  state.lastSentTo[site] = null;
  state.enabled[site] = true;
}

function logEvent(kind, detail) {
  const entry = { ts: Date.now(), kind, detail };
  state.log.push(entry);
  if (state.log.length > MAX_LOG) state.log.shift();
  sendToControls("log", entry);
}

function sendToControls(channel, payload) {
  if (controlsView && !controlsView.webContents.isDestroyed()) {
    controlsView.webContents.send(channel, payload);
  }
}

// The control panel always fills the entire window; each AI's live pane is
// positioned by measuring the real "pane-slot-<site>" placeholder div inside
// controls.html, so it tracks whatever the actual page layout does (flex sizing,
// a taller preview, a collapsed slot when that participant is unchecked, etc.)
// instead of a hardcoded split.
function layout() {
  if (!win || !controlsView) return;
  const [w, h] = win.getContentSize();
  controlsView.setBounds({ x: 0, y: 0, width: w, height: h });
}

async function syncPaneBounds() {
  if (!win || !controlsView || controlsView.webContents.isDestroyed()) return;
  let rects;
  try {
    rects = await controlsView.webContents.executeJavaScript(`
      (() => {
        const ids = ${JSON.stringify(SITE_IDS)};
        const out = {};
        for (const site of ids) {
          const el = document.getElementById("pane-slot-" + site);
          if (!el) { out[site] = null; continue; }
          const r = el.getBoundingClientRect();
          out[site] = { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
        }
        return out;
      })();
    `);
  } catch {
    return;
  }
  for (const site of SITE_IDS) {
    const view = siteViews[site];
    if (!view || view.webContents.isDestroyed()) continue;
    const r = rects && rects[site];
    if (!state.enabled[site] || !r || r.width < 4 || r.height < 4) {
      view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    } else {
      view.setBounds(r);
    }
  }
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
  controlsView.webContents.once("did-finish-load", () => {
    syncPaneBounds();
    setInterval(syncPaneBounds, PANE_SYNC_MS);
  });

  for (const site of SITE_IDS) {
    const view = new WebContentsView({ webPreferences: { partition: `persist:${site}` } });
    win.contentView.addChildView(view);
    view.webContents.loadURL(SITES[site].home);
    siteViews[site] = view;
  }

  layout();
  win.on("resize", () => { layout(); syncPaneBounds(); });
  win.on("closed", () => { win = null; });

  setInterval(() => { for (const site of SITE_IDS) pollSite(site); }, POLL_MS);
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
    waiting: { ...state.waiting },
    meshActive: state.meshActive
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
    state.lastSentTo[target] = prompt;
    state.waiting[target] = true;
    sendToControls("sent", { target, from: fromSite || null, ts: Date.now() });
    sendToControls("waiting-changed", { site: target, waiting: true });
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

    const turn = { id: state.nextTurnId++, site, label: SITES[site].label, text, ts: Date.now(), pinned: false };
    state.captured[site] = turn;
    state.transcript.push(turn);
    sendToControls("capture", turn);
    logEvent("captured", { site, chars: text.length });

    if (state.waiting[site]) {
      state.waiting[site] = false;
      sendToControls("waiting-changed", { site, waiting: false });
    }

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

ipcMain.handle("send:regenerate", async (_evt, site) => {
  const text = state.lastSentTo[site];
  if (!text) return { ok: false, error: "NOTHING_SENT_YET" };
  const view = siteViews[site];
  if (!view || view.webContents.isDestroyed()) return { ok: false, error: "NO_VIEW" };
  let res;
  try {
    res = await view.webContents.executeJavaScript(buildSendScript(site, text), true);
  } catch (e) {
    res = { ok: false, error: String(e) };
  }
  if (!res || !res.ok) {
    sendToControls("send-error", { target: site, error: res?.error || "unknown" });
    logEvent("send-error", { target: site, error: res?.error || "unknown", regenerate: true });
  } else {
    state.waiting[site] = true;
    sendToControls("waiting-changed", { site, waiting: true });
    logEvent("regenerate", { site });
  }
  return res;
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
  syncPaneBounds();
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
  syncPaneBounds();
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

ipcMain.handle("transcript:toggle-pin", (_evt, id) => {
  const turn = state.transcript.find((t) => t.id === id);
  if (!turn) return { ok: false, error: "NOT_FOUND" };
  turn.pinned = !turn.pinned;
  return { ok: true, id, pinned: turn.pinned };
});

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
