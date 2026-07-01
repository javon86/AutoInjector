// main.js — Electron main process. Opens ChatGPT, Claude and Gemini as three real
// Chromium panes inside one window (each with its own persistent, isolated login
// session), plus a control panel pane that acts as a message router between them:
// you compose a message and send it to any one/some/all panes, and each pane can
// forward its latest reply to any other pane either on demand (a button click) or
// automatically (a per-pane "auto-forward to X" toggle). A lightweight poller reads
// each pane's latest assistant message every couple of seconds and treats it as
// "captured" once it stops changing, independent of who's talking to whom.
const { app, BaseWindow, WebContentsView, ipcMain } = require("electron");
const path = require("path");
const SITES = require("./selectors");
const { buildSendScript, buildReadScript } = require("./automation");

const SITE_IDS = Object.keys(SITES);
const CONTROLS_HEIGHT = 360;
const POLL_MS = 1500;
const STABLE_MS = 1800;

let win = null;
let controlsView = null;
const siteViews = {};

const state = {
  routing: {}, // site -> Set<target site id> to auto-forward new replies to
  captured: {}, // site -> { text, ts } | null — last stable reply seen
  pending: {}, // site -> { text, sinceTs } — used to detect when a reply has stopped changing
  busy: {}, // site -> bool — poll in flight, skip overlapping polls
  transcript: [] // { site, label, text, ts } — every captured reply, for export
};
for (const site of SITE_IDS) {
  state.routing[site] = new Set();
  state.captured[site] = null;
  state.pending[site] = { text: "", sinceTs: Date.now() };
  state.busy[site] = false;
}

function layout() {
  if (!win) return;
  const [w, h] = win.getContentSize();
  controlsView.setBounds({ x: 0, y: 0, width: w, height: Math.min(CONTROLS_HEIGHT, h) });
  const paneTop = Math.min(CONTROLS_HEIGHT, h);
  const paneHeight = Math.max(0, h - paneTop);
  const paneWidth = Math.floor(w / SITE_IDS.length);
  SITE_IDS.forEach((site, i) => {
    const x = i * paneWidth;
    const width = i === SITE_IDS.length - 1 ? w - x : paneWidth;
    siteViews[site].setBounds({ x, y: paneTop, width, height: paneHeight });
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

async function sendTextTo(target, text, fromSite) {
  const view = siteViews[target];
  if (!view || view.webContents.isDestroyed()) {
    const err = { target, error: "NO_VIEW" };
    sendToControls("send-error", err);
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
  } else {
    sendToControls("sent", { target, from: fromSite || null, ts: Date.now() });
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

    for (const target of state.routing[site]) {
      if (target === site) continue;
      await sendTextTo(target, text, site);
    }
  } catch {
    // transient read failure (navigation in progress, etc.) — try again next tick
  } finally {
    state.busy[site] = false;
  }
}

ipcMain.handle("send:compose", async (_evt, { text, targets }) => {
  const list = Array.isArray(targets) ? targets.filter((t) => SITES[t]) : [];
  if (!text || !list.length) return { ok: false, error: "NEED_TEXT_AND_TARGET" };
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
  return { ok: true, routing: routingSnapshot() };
});

ipcMain.handle("routing:pause-all", () => {
  for (const site of SITE_IDS) state.routing[site].clear();
  return { ok: true, routing: routingSnapshot() };
});

ipcMain.handle("state:get", () => ({
  ok: true,
  routing: routingSnapshot(),
  captured: state.captured,
  transcript: state.transcript
}));

ipcMain.handle("transcript:clear", () => { state.transcript = []; return { ok: true }; });

ipcMain.handle("site:reload", (_evt, site) => {
  const view = siteViews[site];
  if (!view) return { ok: false, error: "NO_VIEW" };
  view.webContents.loadURL(SITES[site].home);
  state.pending[site] = { text: "", sinceTs: Date.now() };
  state.captured[site] = null;
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
