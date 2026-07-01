// main.js — Electron main process. Opens ChatGPT, Claude and Gemini as three real
// Chromium panes inside one window (each with its own persistent, isolated login
// session), plus a control panel pane that runs the roundtable: it types a topic
// into one AI's chat box, clicks send, waits for the reply, then feeds the growing
// transcript to the next AI, and so on — the same copy/paste automation idea as the
// browser extension, just packaged as a standalone desktop program.
const { app, BaseWindow, WebContentsView, ipcMain } = require("electron");
const path = require("path");
const SITES = require("./selectors");
const { buildAutomationScript } = require("./automation");

const SITE_IDS = Object.keys(SITES);
const CONTROLS_HEIGHT = 320;

let win = null;
let controlsView = null;
const siteViews = {};

const roundtable = {
  running: false,
  stopRequested: false,
  topic: "",
  participants: [],
  starter: null,
  rounds: 0,
  timeoutMs: 240000,
  transcript: []
};

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
  win = new BaseWindow({ width: 1600, height: 1000, title: "AutoInjector Desktop — AI Roundtable" });

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
    const view = new WebContentsView({
      webPreferences: { partition: `persist:${site}` }
    });
    win.contentView.addChildView(view);
    view.webContents.loadURL(SITES[site].home);
    siteViews[site] = view;
  }

  layout();
  win.on("resize", layout);
  win.on("closed", () => { win = null; });
}

function sendToControls(channel, payload) {
  if (controlsView && !controlsView.webContents.isDestroyed()) {
    controlsView.webContents.send(channel, payload);
  }
}

function buildPrompt(currentSite) {
  const labels = roundtable.participants.map((p) => SITES[p].label).join(", ");
  const sys = `You're one voice (${SITES[currentSite].label}) in a live roundtable discussion between ${labels} on this topic: "${roundtable.topic}". Read the conversation so far and reply in your own voice, building on points already made where useful. Keep it conversational and reasonably concise.`;
  let prompt = `[system] ${sys}`;
  if (!roundtable.transcript.length) {
    prompt += `\n\n[user] ${roundtable.topic}`;
  } else {
    for (const turn of roundtable.transcript) {
      if (turn.error) continue;
      prompt += `\n\n[${turn.label}] ${turn.text}`;
    }
  }
  return prompt;
}

function pushError(site, error) {
  const turn = { site, label: SITES[site]?.label || site, error, ts: Date.now() };
  roundtable.transcript.push(turn);
  sendToControls("roundtable:error", turn);
}

async function runRoundtable() {
  const n = roundtable.participants.length;
  const startIdx = Math.max(0, roundtable.participants.indexOf(roundtable.starter));
  const order = [];
  for (let i = 0; i < roundtable.rounds * n; i++) order.push(roundtable.participants[(startIdx + i) % n]);

  for (const site of order) {
    if (roundtable.stopRequested) break;
    sendToControls("roundtable:turn-start", { site });
    const view = siteViews[site];
    if (!view || view.webContents.isDestroyed()) { pushError(site, "NO_VIEW"); break; }

    const prompt = buildPrompt(site);
    const script = buildAutomationScript(site, prompt, roundtable.timeoutMs);
    let res;
    try {
      res = await view.webContents.executeJavaScript(script, true);
    } catch (e) {
      res = { ok: false, error: String(e) };
    }
    if (roundtable.stopRequested) break;

    if (res && res.ok) {
      const turn = { site, label: SITES[site].label, text: res.text || "", ts: Date.now() };
      roundtable.transcript.push(turn);
      sendToControls("roundtable:turn", turn);
    } else {
      pushError(site, res?.error || "unknown");
      break;
    }
  }
  roundtable.running = false;
  sendToControls("roundtable:done", { stopped: roundtable.stopRequested });
}

ipcMain.handle("roundtable:start", (_evt, cfg) => {
  if (roundtable.running) return { ok: false, error: "ALREADY_RUNNING" };
  const participants = Array.isArray(cfg?.participants) && cfg.participants.length >= 2
    ? cfg.participants.filter((p) => SITES[p])
    : SITE_IDS;
  if (participants.length < 2) return { ok: false, error: "NEED_AT_LEAST_TWO_PARTICIPANTS" };
  const starter = participants.includes(cfg?.starter) ? cfg.starter : participants[0];

  Object.assign(roundtable, {
    running: true,
    stopRequested: false,
    topic: String(cfg?.topic || "").slice(0, 4000),
    participants,
    starter,
    rounds: Math.max(1, Math.min(20, Number(cfg?.rounds) || 3)),
    timeoutMs: Number(cfg?.timeoutMs) || 240000,
    transcript: []
  });

  runRoundtable();
  return { ok: true };
});

ipcMain.handle("roundtable:stop", () => {
  roundtable.stopRequested = true;
  return { ok: true };
});

ipcMain.handle("roundtable:get", () => ({ ok: true, roundtable }));

ipcMain.handle("roundtable:clear", () => {
  if (roundtable.running) return { ok: false, error: "RUNNING" };
  roundtable.transcript = [];
  return { ok: true };
});

ipcMain.handle("site:reload", (_evt, site) => {
  const view = siteViews[site];
  if (!view) return { ok: false, error: "NO_VIEW" };
  view.webContents.loadURL(SITES[site].home);
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
