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
//
// On top of manual routing (per-card Forward/Auto, global full-mesh Auto), there's
// a House Rules subsystem: six structured conversation formats (Who Wants to Speak,
// Debate, Free-for-All, Devil & Angel, Chargeback, Brainstorm), each a small state
// machine driven off the same capture events as everything else.
const { app, BaseWindow, WebContentsView, ipcMain } = require("electron");
const path = require("path");
const SITES = require("./selectors");
const { buildSendScript, buildReadScript } = require("./automation");

const SITE_IDS = Object.keys(SITES);
const POLL_MS = 1500;
const STABLE_MS = 1800;
const MAX_LOG = 300;
const PANE_SYNC_MS = 700;
const HOUSE_RULES = ["who-wants-to-speak", "debate", "free-for-all", "devil-angel", "chargeback", "brainstorm"];
const NEEDS_EXACTLY_THREE = new Set(["devil-angel", "chargeback"]);

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
  transcript: [], // { id, site, label, text, ts, pinned, isVerdict?, isFinalPlan? } — every captured reply
  log: [], // { ts, kind, detail } — internal activity, for the troubleshooting panel
  meshActive: false, // whether global Auto is currently on
  nextTurnId: 1,
  hr: null // House Rules run state, see resetHouseRule()
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

function resetHouseRule(mode, topic, rounds) {
  state.hr = {
    mode: mode || null,
    active: false,
    topic: topic || "",
    rounds: Number(rounds) || 0, // 0 = unlimited, runs until Stop
    roundNum: 0,
    order: [], // Debate speaking order
    turnIndex: 0,
    roles: {}, // site -> role name, once assigned
    rolesIntroduced: {}, // site -> bool, whether the role explanation has been sent once
    buffer: {}, // Devil & Angel fan-in buffer while waiting on both replies
    phase: null,
    optinPending: new Set(),
    optinYes: [],
    realPending: new Set(),
    realReplies: {},
    ignoreCaptureFrom: new Map() // site -> count of pending informational sends whose ack should be swallowed
  };
}
resetHouseRule(null, "", 0);

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

function houseRuleSnapshot() {
  const hr = state.hr;
  return {
    mode: hr.mode,
    active: hr.active,
    topic: hr.topic,
    rounds: hr.rounds,
    roundNum: hr.roundNum,
    roles: { ...hr.roles }
  };
}

function broadcastHouseRule() {
  sendToControls("houserule-state", houseRuleSnapshot());
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

// --- House Rules: shared helpers -------------------------------------------

function shuffledCopy(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function otherLabels(checked, exclude) {
  return checked.filter((s) => s !== exclude).map((s) => SITES[s].label).join(" and ");
}

function findRoleSite(role) {
  return Object.keys(state.hr.roles).find((s) => state.hr.roles[s] === role);
}

function queueIgnore(site) {
  const hr = state.hr;
  hr.ignoreCaptureFrom.set(site, (hr.ignoreCaptureFrom.get(site) || 0) + 1);
}

function endHouseRule(reason) {
  state.hr.active = false;
  logEvent("houserule-done", { mode: state.hr.mode, rounds: state.hr.roundNum, reason });
  broadcastHouseRule();
}

// --- House Rules: per-mode kickoffs -----------------------------------------

async function startFreeForAll(checked) {
  for (const s of checked) state.routing[s] = new Set(checked.filter((t) => t !== s));
  state.meshActive = true;
  for (const s of checked) {
    const prompt = `You're one voice in an open discussion with ${otherLabels(checked, s)} on: "${state.hr.topic}". Anyone can jump in at any point — react to whoever said something interesting, don't wait for a formal turn.`;
    await sendTextTo(s, prompt, null);
  }
}

async function startBrainstorm(checked) {
  for (const s of checked) state.routing[s] = new Set(checked.filter((t) => t !== s));
  state.meshActive = true;
  for (const s of checked) {
    const prompt = `You're brainstorming with ${otherLabels(checked, s)} on: "${state.hr.topic}". This isn't a debate — no need to find flaws or pick a side. Build on what's already been suggested, add a new angle, or combine ideas.`;
    await sendTextTo(s, prompt, null);
  }
}

async function wrapUpBrainstorm() {
  const checked = SITE_IDS.filter((s) => state.enabled[s]);
  for (const s of checked) state.routing[s].clear();
  state.meshActive = false;
  const synth = checked[Math.floor(Math.random() * checked.length)];
  state.hr.roles = { [synth]: "synthesizer" };
  state.hr.phase = "awaiting-synthesis";
  await sendTextTo(
    synth,
    `We've been brainstorming on "${state.hr.topic}" for a while. Don't add a new idea — pull everything together into ONE single, fully fleshed-out plan: take the best pieces from what's been suggested, resolve any contradictions, and present it as a complete answer.`,
    null
  );
  broadcastHouseRule();
}

async function startDebate(checked) {
  state.hr.order = shuffledCopy(checked);
  state.hr.turnIndex = 0;
  await sendTextTo(state.hr.order[0], `You're kicking off a debate on: "${state.hr.topic}". Give your opening position.`, null);
}

async function startDevilAngel(checked) {
  const [middle, devil, angel] = shuffledCopy(checked);
  state.hr.roles = { [middle]: "middle", [devil]: "devil", [angel]: "angel" };
  state.hr.phase = "awaiting-middle";
  await sendTextTo(middle, `Here's a goal/idea I want to stress-test: "${state.hr.topic}". Lay out your initial take or plan for it.`, null);
}

async function startChargeback(checked) {
  const [d1, d2, ref] = shuffledCopy(checked);
  state.hr.roles = { [d1]: "debater1", [d2]: "debater2", [ref]: "referee" };
  state.hr.phase = "awaiting-debater1";
  queueIgnore(ref);
  await sendTextTo(ref, `You're the referee for a debate on "${state.hr.topic}" between two other AIs. Just observe for now — you'll be asked for a final verdict after round ${state.hr.rounds}.`, null);
  await sendTextTo(d1, `You're arguing FOR this: "${state.hr.topic}". State your opening case.`, null);
}

async function startWhoWants(checked) {
  state.hr.phase = "awaiting-optins";
  state.hr.optinPending = new Set(checked);
  state.hr.optinYes = [];
  const prompt = `Here's a topic to think about: "${state.hr.topic}".\n\nDo you have something worth adding right now — a new point, disagreement, or question? Reply with just YES or NO, and if YES, one line on your angle.`;
  for (const s of checked) await sendTextTo(s, prompt, null);
}

// --- House Rules: per-mode reactions to a new captured reply ----------------

async function handleDebateCapture(turn) {
  const hr = state.hr;
  if (turn.site !== hr.order[hr.turnIndex]) return;
  hr.turnIndex = (hr.turnIndex + 1) % hr.order.length;
  if (hr.turnIndex === 0) {
    hr.roundNum++;
    if (hr.rounds > 0 && hr.roundNum >= hr.rounds) { endHouseRule("rounds complete"); return; }
  }
  const next = hr.order[hr.turnIndex];
  const msg = `[${turn.label} says]\n\n${turn.text}\n\nRespond directly to the strongest point they just made — agree, refute, or build on it — then add your own point.`;
  await sendTextTo(next, msg, null);
}

async function handleDevilAngelCapture(turn) {
  const hr = state.hr;
  const role = hr.roles[turn.site];
  if (!role) return;

  if (role === "middle" && hr.phase === "awaiting-middle") {
    const devilSite = findRoleSite("devil");
    const angelSite = findRoleSite("angel");
    const devilIntro = hr.rolesIntroduced.devil ? "" : `You're the Devil here — find every reason this could fail: weaknesses, risks, blind spots. Don't hold back.\n\n`;
    const angelIntro = hr.rolesIntroduced.angel ? "" : `You're the Angel here — find every reason this could succeed: strengths, what's already working, the strongest case for it.\n\n`;
    hr.rolesIntroduced.devil = true;
    hr.rolesIntroduced.angel = true;
    hr.buffer = {};
    hr.phase = "awaiting-devil-angel";
    await sendTextTo(devilSite, `${devilIntro}[Middle says]\n\n${turn.text}`, null);
    await sendTextTo(angelSite, `${angelIntro}[Middle says]\n\n${turn.text}`, null);
    return;
  }

  if (role === "devil" && hr.phase === "awaiting-devil-angel") {
    hr.buffer.devil = turn.text;
  } else if (role === "angel" && hr.phase === "awaiting-devil-angel") {
    hr.buffer.angel = turn.text;
  } else {
    return;
  }

  if (hr.buffer.devil != null && hr.buffer.angel != null) {
    hr.roundNum++;
    if (hr.rounds > 0 && hr.roundNum >= hr.rounds) { endHouseRule("rounds complete"); return; }
    const middleSite = findRoleSite("middle");
    const combined = `[Devil says]\n\n${hr.buffer.devil}\n\n[Angel says]\n\n${hr.buffer.angel}\n\nYou've heard both sides above. Respond to both: what do you concede, what do you push back on, how does your position evolve? State it clearly, since that's what goes back to them next.`;
    hr.buffer = {};
    hr.phase = "awaiting-middle";
    await sendTextTo(middleSite, combined, null);
  }
}

async function handleChargebackCapture(turn) {
  const hr = state.hr;
  const role = hr.roles[turn.site];
  if (!role) return;
  const referee = findRoleSite("referee");

  if (role === "referee") {
    if (hr.phase === "awaiting-verdict") {
      turn.isVerdict = true;
      endHouseRule("verdict delivered");
    }
    return; // any other referee reply is just an ack to an informational copy, ignored via ignoreCaptureFrom
  }

  const d1 = findRoleSite("debater1");
  const d2 = findRoleSite("debater2");

  if (role === "debater1" && hr.phase === "awaiting-debater1") {
    queueIgnore(referee);
    await sendTextTo(referee, `[${turn.label} says]\n\n${turn.text}`, null);
    hr.phase = "awaiting-debater2";
    await sendTextTo(d2, `[${turn.label} says]\n\n${turn.text}\n\nRespond with your counter-argument.`, null);
    return;
  }

  if (role === "debater2" && hr.phase === "awaiting-debater2") {
    hr.roundNum++;
    queueIgnore(referee);
    await sendTextTo(referee, `[${turn.label} says]\n\n${turn.text}`, null);
    if (hr.roundNum >= hr.rounds) {
      hr.phase = "awaiting-verdict";
      await sendTextTo(referee, `The debate is over. Based on everything you've observed, deliver your verdict: who argued better, and why? Declare a winner.`, null);
    } else {
      hr.phase = "awaiting-debater1";
      await sendTextTo(d1, `[${turn.label} says]\n\n${turn.text}\n\nRespond with your counter-argument.`, null);
    }
  }
}

async function handleWhoWantsCapture(turn) {
  const hr = state.hr;

  if (hr.phase === "awaiting-optins" && hr.optinPending.has(turn.site)) {
    hr.optinPending.delete(turn.site);
    if (turn.text.trim().toUpperCase().startsWith("YES")) hr.optinYes.push(turn.site);
    if (hr.optinPending.size > 0) return;

    if (hr.optinYes.length === 0) { endHouseRule("nobody opted in"); return; }
    hr.phase = "awaiting-real";
    hr.realPending = new Set(hr.optinYes);
    hr.realReplies = {};
    for (const s of hr.optinYes) await sendTextTo(s, "Go ahead — give your point.", null);
    return;
  }

  if (hr.phase === "awaiting-real" && hr.realPending.has(turn.site)) {
    hr.realPending.delete(turn.site);
    hr.realReplies[turn.site] = turn.text;
    if (hr.realPending.size > 0) return;

    hr.roundNum++;
    if (hr.rounds > 0 && hr.roundNum >= hr.rounds) { endHouseRule("rounds complete"); return; }

    const checked = SITE_IDS.filter((s) => state.enabled[s]);
    const recap = Object.entries(hr.realReplies).map(([s, t]) => `[${SITES[s].label} says]\n\n${t}`).join("\n\n");
    const prompt = `Here's what came up last round:\n\n${recap}\n\nDo you have something worth adding right now — a new point, disagreement, or question? Reply with just YES or NO, and if YES, one line on your angle.`;
    hr.phase = "awaiting-optins";
    hr.optinPending = new Set(checked);
    hr.optinYes = [];
    for (const s of checked) await sendTextTo(s, prompt, null);
  }
}

async function handleBrainstormCapture(turn) {
  const hr = state.hr;
  if (hr.phase === "awaiting-synthesis" && hr.roles[turn.site] === "synthesizer") {
    turn.isFinalPlan = true;
    endHouseRule("synthesis delivered");
  }
}

async function handleHouseRuleCapture(turn) {
  switch (state.hr.mode) {
    case "debate": return handleDebateCapture(turn);
    case "devil-angel": return handleDevilAngelCapture(turn);
    case "chargeback": return handleChargebackCapture(turn);
    case "who-wants-to-speak": return handleWhoWantsCapture(turn);
    case "brainstorm": return handleBrainstormCapture(turn);
    default: return; // free-for-all rides entirely on the generic routing mesh below
  }
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

    const ignoreCount = state.hr.active ? state.hr.ignoreCaptureFrom.get(site) || 0 : 0;
    if (ignoreCount > 0) {
      state.hr.ignoreCaptureFrom.set(site, ignoreCount - 1);
    } else {
      for (const target of state.routing[site]) {
        if (target === site) continue;
        await sendTextTo(target, text, site);
      }
      if (state.hr.active) await handleHouseRuleCapture(turn);
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
  if (state.hr.active) { state.hr.active = false; logEvent("houserule-stop", { mode: state.hr.mode }); broadcastHouseRule(); }
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

ipcMain.handle("houserule:start", async (_evt, { mode, topic, rounds }) => {
  if (!HOUSE_RULES.includes(mode)) return { ok: false, error: "BAD_MODE" };
  if (state.hr.active) return { ok: false, error: "ALREADY_RUNNING" };
  if (!topic || !String(topic).trim()) return { ok: false, error: "NEEDS_TOPIC" };

  const checked = SITE_IDS.filter((s) => state.enabled[s]);
  if (NEEDS_EXACTLY_THREE.has(mode) && checked.length !== 3) return { ok: false, error: "NEEDS_EXACTLY_THREE" };
  if (!NEEDS_EXACTLY_THREE.has(mode) && checked.length < 2) return { ok: false, error: "NEEDS_AT_LEAST_TWO" };
  if (mode === "chargeback" && (!rounds || Number(rounds) < 1)) return { ok: false, error: "NEEDS_ROUNDS" };

  resetHouseRule(mode, topic, rounds);
  state.hr.active = true;
  for (const s of SITE_IDS) state.routing[s].clear();
  state.meshActive = false;
  logEvent("houserule-start", { mode, participants: checked, rounds: state.hr.rounds });

  try {
    if (mode === "free-for-all") await startFreeForAll(checked);
    else if (mode === "brainstorm") await startBrainstorm(checked);
    else if (mode === "debate") await startDebate(checked);
    else if (mode === "devil-angel") await startDevilAngel(checked);
    else if (mode === "chargeback") await startChargeback(checked);
    else if (mode === "who-wants-to-speak") await startWhoWants(checked);
  } catch (e) {
    state.hr.active = false;
    return { ok: false, error: String(e) };
  }
  broadcastHouseRule();
  return { ok: true, houseRule: houseRuleSnapshot() };
});

ipcMain.handle("houserule:stop", () => {
  state.hr.active = false;
  logEvent("houserule-stop", { mode: state.hr.mode });
  broadcastHouseRule();
  return { ok: true, houseRule: houseRuleSnapshot() };
});

ipcMain.handle("houserule:wrap-up-brainstorm", async () => {
  if (!state.hr.active || state.hr.mode !== "brainstorm") return { ok: false, error: "NOT_BRAINSTORMING" };
  await wrapUpBrainstorm();
  return { ok: true };
});

ipcMain.handle("state:get", () => ({
  ok: true,
  global: globalSnapshot(),
  houseRule: houseRuleSnapshot(),
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
