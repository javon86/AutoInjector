// main.js — Electron main process. Two windows share one automation core:
//   - the Automation window: ChatGPT/Claude/Gemini panes merged with their
//     control strips (preview, Forward, Auto, Regenerate), plus the full House
//     Rules box and the Activity/Troubleshooting log — the "engine room."
//   - the Conversation window: the primary, resizable/maximizable user-facing
//     window. Shows only the clean back-and-forth (topic, each AI's visible
//     reply, current/next speaker) with Send/Start/Pause/Resume/Stop controls
//     and per-AI role assignment. Built around the Rotation format (see below).
// Both talk to the same in-memory state and get the same broadcasts.
//
// On top of manual routing (per-card Forward/Auto, global full-mesh Auto),
// there's a House Rules subsystem: seven structured conversation formats (Who
// Wants to Speak, Debate, Free-for-All, Devil & Angel, Chargeback, Brainstorm,
// Rotation), each a small state machine driven off the same capture events as
// everything else. A capture can also be "silent" — swallowed before it ever
// reaches the transcript/UI — used for Chargeback's Referee acknowledgments
// and Rotation's "UPDATED" confirmations, neither of which should ever be
// shown to the user.
const { app, BaseWindow, WebContentsView, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const SITES = require("./selectors");
const { buildSendScript, buildReadScript } = require("./automation");
const roundtableRules = require("./roundtable-rules");

const SITE_IDS = Object.keys(SITES);
const ROTATION_ORDER = ["chatgpt", "claude", "gemini"]; // fixed, per spec — not shuffled like the other modes
const POLL_MS = 1500;
const STABLE_MS = 1800;
const MAX_LOG = 300;
const PANE_SYNC_MS = 700;
const DEFAULT_ROUNDTABLE_HOP_LIMIT = 24;
const HOUSE_RULES = ["who-wants-to-speak", "debate", "free-for-all", "devil-angel", "chargeback", "brainstorm", "rotation", "roundtable"];
const NEEDS_EXACTLY_THREE = new Set(["devil-angel", "chargeback", "rotation", "roundtable"]);
const COLLAPSED_HEIGHT = 44; // px — how tall a top-level window is once collapsed to just its titlebar
const MAX_DEBUG_LOG_LINES = 2000;
const SAVE_DEBOUNCE_MS = 500;

// Rate-limit/usage-cap replies are short by nature ("You've reached your
// usage limit...") — gating on length before pattern-matching keeps this
// from false-positiving on a genuine, substantive reply that happens to
// discuss rate limits as a topic.
const RATE_LIMIT_PATTERNS = [
  /rate limit/i,
  /usage limit/i,
  /quota exceeded/i,
  /reached your (current |daily |hourly )?(usage |message )?limit/i,
  /too many requests/i,
  /please (wait|try again) (before|in|later)/i,
  /temporarily (unavailable|blocked)/i
];
function looksLikeRateLimit(text) {
  if (!text || text.length > 400) return false;
  return RATE_LIMIT_PATTERNS.some((re) => re.test(text));
}

function userDataDir() {
  try { return app.getPath("userData"); } catch { return __dirname; }
}
function stateFilePath() { return path.join(userDataDir(), "autoinjector-state.json"); }
function debugLogPath() { return path.join(userDataDir(), "autoinjector-debug.log"); }

let win = null;
let convWin = null;
let controlsView = null;
let conversationView = null;
const siteViews = {};
const uiViews = []; // every renderer that should receive broadcasts (controls + conversation)

// Per top-level window: whether it's currently collapsed to just a titlebar,
// and (while collapsed) the full bounds to restore on expand. Keyed by the
// same "automation"/"conversation" id the renderers use over IPC.
const windowCollapse = {
  automation: { collapsed: false, savedBounds: null, savedMinSize: null },
  conversation: { collapsed: false, savedBounds: null, savedMinSize: null }
};

function targetWindow(which) {
  return which === "automation" ? win : which === "conversation" ? convWin : null;
}

const state = {
  routing: {}, // site -> Set<target site id> to auto-forward new replies to
  captured: {}, // site -> { id, site, label, text, ts, pinned } | null — last stable reply seen
  pending: {}, // site -> { text, sinceTs } — used to detect when a reply has stopped changing
  busy: {}, // site -> bool — poll in flight, skip overlapping polls
  waiting: {}, // site -> bool — a message was just sent, waiting on a fresh reply (drives the idle/generating dot)
  waitingSince: {}, // site -> timestamp | null — when waiting flipped true, so UIs can flag "hasn't replied in a while"
  lastSentTo: {}, // site -> exact final text last sent to it (for Regenerate)
  enabled: {}, // site -> bool — participant is "in play": counts for Auto/"All" AND shows its pane
  customRole: {}, // site -> user-assigned persona string ("", i.e. falsy, means general-purpose)
  transcript: [], // { id, site, label, text, ts, pinned, isVerdict?, isFinalPlan? } — every VISIBLE captured reply
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
  state.waitingSince[site] = null;
  state.lastSentTo[site] = null;
  state.enabled[site] = true;
  state.customRole[site] = "";
}

function resetHouseRule(mode, topic, rounds) {
  state.hr = {
    mode: mode || null,
    active: false,
    topic: topic || "",
    rounds: Number(rounds) || 0, // 0 = unlimited, runs until Stop
    roundNum: 0,
    order: [], // Debate speaking order / Rotation's fixed order
    turnIndex: 0, // Debate's whose-turn-is-next index
    lastSpeakerIndex: -1, // Rotation's "who most recently produced a visible reply"
    roles: {}, // site -> structural role name (middle/devil/angel/debater1/debater2/referee/synthesizer), once assigned
    rolesIntroduced: {}, // site -> bool, whether the role explanation has been sent once
    buffer: {}, // Devil & Angel fan-in buffer while waiting on both replies
    phase: null,
    optinPending: new Set(),
    optinYes: [],
    realPending: new Set(),
    realReplies: {},
    ackPending: new Set(), // Roundtable: site ids that haven't acknowledged the house rules yet
    ignoreCaptureFrom: new Map(), // site -> count of pending informational sends whose ack should be swallowed (visible in the log, not the transcript)
    silentAckFrom: new Map(), // site -> count of pending "UPDATE" sends whose "UPDATED" ack should be swallowed entirely
    pausedRouting: null, // stashed routing snapshot while paused, restored on resume
    pauseReason: null // null = manual pause/never paused; "rate-limit" = auto-paused after detecting a usage-cap reply
  };
}
resetHouseRule(null, "", 0);

// --- On-disk debug log: a rolling file so a real crash still leaves
// something to troubleshoot from, since the in-memory state.log ring buffer
// (MAX_LOG entries) is lost the moment the process dies. Best-effort only —
// any failure here (permissions, disk full) must never crash the app.
let debugLogLineCount = 0;
function appendDebugLog(entry) {
  try {
    fs.appendFileSync(debugLogPath(), JSON.stringify(entry) + "\n");
    debugLogLineCount++;
    if (debugLogLineCount > MAX_DEBUG_LOG_LINES * 1.2) trimDebugLog();
  } catch {}
}
function trimDebugLog() {
  try {
    const lines = fs.readFileSync(debugLogPath(), "utf8").split("\n").filter(Boolean);
    const kept = lines.slice(-MAX_DEBUG_LOG_LINES);
    fs.writeFileSync(debugLogPath(), kept.join("\n") + "\n");
    debugLogLineCount = kept.length;
  } catch {}
}

function logEvent(kind, detail) {
  const entry = { ts: Date.now(), kind, detail };
  state.log.push(entry);
  if (state.log.length > MAX_LOG) state.log.shift();
  broadcast("log", entry);
  appendDebugLog(entry);
}

// --- Persistence: transcript, custom roles, and (if a House Rule run was in
// progress) enough of its state to show the user where things left off. On
// load, any restored run comes back PAUSED, never active — restarting the
// app must never auto-send anything. Panes also always reload to their site's
// home URL on startup (see createWindow()), so there's no stale "already
// captured" reply sitting on screen to accidentally re-trigger the state
// machine with — resume only reacts once a genuinely new reply appears.
let saveStateTimer = null;
function saveStateDebounced() {
  clearTimeout(saveStateTimer);
  saveStateTimer = setTimeout(() => {
    try {
      const hr = state.hr;
      const snapshot = {
        schemaVersion: 1,
        savedAt: Date.now(),
        transcript: state.transcript,
        customRole: state.customRole,
        hr: hr && hr.mode ? {
          mode: hr.mode,
          topic: hr.topic,
          rounds: hr.rounds,
          roundNum: hr.roundNum,
          order: hr.order,
          phase: hr.phase,
          lastSpeakerIndex: hr.lastSpeakerIndex,
          roles: hr.roles
        } : null
      };
      fs.writeFileSync(stateFilePath(), JSON.stringify(snapshot));
    } catch (e) {
      logEvent("persist-error", { error: String(e) });
    }
  }, SAVE_DEBOUNCE_MS);
}

function loadPersistedState() {
  let raw;
  try {
    raw = fs.readFileSync(stateFilePath(), "utf8");
  } catch {
    return; // nothing saved yet — first run, or file was removed
  }
  let snap;
  try {
    snap = JSON.parse(raw);
  } catch (e) {
    logEvent("persist-error", { error: `corrupt state file: ${String(e)}` });
    return;
  }
  if (Array.isArray(snap.transcript)) {
    state.transcript = snap.transcript;
    state.nextTurnId = snap.transcript.reduce((m, t) => Math.max(m, (t.id || 0) + 1), 1);
  }
  if (snap.customRole) {
    for (const site of SITE_IDS) if (typeof snap.customRole[site] === "string") state.customRole[site] = snap.customRole[site];
  }
  if (snap.hr && snap.hr.mode) {
    resetHouseRule(snap.hr.mode, snap.hr.topic, snap.hr.rounds);
    state.hr.roundNum = snap.hr.roundNum || 0;
    state.hr.order = Array.isArray(snap.hr.order) ? snap.hr.order : [];
    state.hr.phase = snap.hr.phase || null;
    state.hr.lastSpeakerIndex = typeof snap.hr.lastSpeakerIndex === "number" ? snap.hr.lastSpeakerIndex : -1;
    state.hr.roles = snap.hr.roles || {};
    state.hr.active = false;
    state.hr.pausedRouting = {};
    for (const s of SITE_IDS) state.hr.pausedRouting[s] = [];
  }
  logEvent("state-restored", { transcriptTurns: state.transcript.length, hrMode: state.hr.mode });
}

function broadcast(channel, payload) {
  for (const view of uiViews) {
    if (view && !view.webContents.isDestroyed()) view.webContents.send(channel, payload);
  }
}

// The control panel always fills the entire Automation window; each AI's live
// pane is positioned by measuring the real "pane-slot-<site>" placeholder div
// inside controls.html, so it tracks whatever the actual page layout does
// (flex sizing, a taller preview, a collapsed slot when unchecked) instead of
// a hardcoded split.
function layout() {
  if (!win || !controlsView) return;
  const [w, h] = win.getContentSize();
  controlsView.setBounds({ x: 0, y: 0, width: w, height: h });
}

function layoutConversation() {
  if (!convWin || !conversationView) return;
  const [w, h] = convWin.getContentSize();
  conversationView.setBounds({ x: 0, y: 0, width: w, height: h });
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
    if (!state.enabled[site]) {
      // Genuinely not participating -- fine to fully zero out, nothing
      // should be getting sent to it anyway.
      view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
      continue;
    }
    const r = rects && rects[site];
    if (!r || r.width < 4 || r.height < 4) {
      // Still enabled and participating -- just its pane got collapsed (or
      // this is a transient layout-measurement gap). Keep the view at a
      // real, non-zero size but move it off-screen instead of shrinking it
      // to 0x0: a genuinely zero-size WebContentsView risks Chromium
      // treating it as occluded/hidden and throttling its renderer, which
      // would silently break the automation (typing, reading replies) this
      // whole app depends on -- exactly the kind of stall collapsing a pane
      // should never cause.
      view.setBounds({ x: -4000, y: 0, width: 800, height: 600 });
    } else {
      view.setBounds(r);
    }
  }
}

function createWindow() {
  win = new BaseWindow({ width: 1700, height: 1050, title: "AutoInjector Desktop — Automation" });

  controlsView = new WebContentsView({
    webPreferences: {
      partition: "controls-ui",
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
  uiViews.push(controlsView);

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

function createConversationWindow() {
  convWin = new BaseWindow({
    width: 1200,
    height: 860,
    minWidth: 700,
    minHeight: 500,
    resizable: true,
    maximizable: true,
    title: "AutoInjector — Conversation"
  });

  conversationView = new WebContentsView({
    webPreferences: {
      partition: "conversation-ui",
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  convWin.contentView.addChildView(conversationView);
  conversationView.webContents.loadFile(path.join(__dirname, "conversation.html"));
  uiViews.push(conversationView);

  layoutConversation();
  convWin.on("resize", layoutConversation);
  convWin.on("closed", () => { convWin = null; });
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
    waitingSince: { ...state.waitingSince },
    meshActive: state.meshActive,
    customRole: { ...state.customRole }
  };
}

function houseRuleSnapshot() {
  const hr = state.hr;
  let nextSpeaker = null;
  if (hr.mode === "debate" && hr.order.length) nextSpeaker = hr.order[hr.turnIndex];
  if (hr.mode === "rotation" && hr.order.length) {
    nextSpeaker = hr.phase === "awaiting-first" ? hr.order[0] : hr.order[(hr.lastSpeakerIndex + 1) % hr.order.length];
  }
  return {
    mode: hr.mode,
    active: hr.active,
    paused: !hr.active && !!hr.pausedRouting,
    pauseReason: hr.pauseReason || null,
    topic: hr.topic,
    rounds: hr.rounds,
    roundNum: hr.roundNum,
    roles: { ...hr.roles },
    nextSpeaker,
    phase: hr.phase,
    ackPending: hr.phase === "ack" ? Array.from(hr.ackPending) : []
  };
}

function broadcastHouseRule() {
  broadcast("houserule-state", houseRuleSnapshot());
}

async function sendTextTo(target, text, fromSite) {
  const view = siteViews[target];
  if (!view || view.webContents.isDestroyed()) {
    broadcast("send-error", { target, error: "NO_VIEW" });
    logEvent("send-error", { target, error: "NO_VIEW" });
    return { ok: false, error: "NO_VIEW" };
  }
  const label = fromSite ? SITES[fromSite]?.label : null;
  const roleClause = state.customRole[target] ? `(You're playing the role of: ${state.customRole[target]}. Keep that in mind in your reply.)\n\n` : "";
  const prompt = roleClause + (label ? `[${label} says]\n\n${text}` : text);

  let res;
  try {
    res = await view.webContents.executeJavaScript(buildSendScript(target, prompt), true);
  } catch (e) {
    res = { ok: false, error: String(e) };
  }
  if (!res || !res.ok) {
    broadcast("send-error", { target, error: res?.error || "unknown" });
    logEvent("send-error", { target, from: fromSite || null, error: res?.error || "unknown" });
  } else {
    state.lastSentTo[target] = prompt;
    state.waiting[target] = true;
    state.waitingSince[target] = Date.now();
    broadcast("sent", { target, from: fromSite || null, ts: Date.now() });
    broadcast("waiting-changed", { site: target, waiting: true });
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

function queueSilentAck(site) {
  const hr = state.hr;
  hr.silentAckFrom.set(site, (hr.silentAckFrom.get(site) || 0) + 1);
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

async function startRotation() {
  // ChatGPT -> Claude -> Gemini -> ChatGPT, fixed. Requires all three checked
  // (enforced in houserule:start). ChatGPT gets the raw topic — it's the
  // origin, not a RESPOND/UPDATE-wrapped message.
  state.hr.order = ROTATION_ORDER.slice();
  state.hr.phase = "awaiting-first";
  state.hr.lastSpeakerIndex = -1;
  await sendTextTo(ROTATION_ORDER[0], state.hr.topic, null);
}

// Unlike every other mode, Roundtable lets each AI pick its own addressee via
// a "[TO: X]" tag it writes as literally the first thing in its own reply —
// the tag is part of the captured text, not something main.js wraps around
// what it sends. See pollSite()'s roundtable-specific interception for why
// that tag has to be parsed and stripped BEFORE a turn is ever pushed to the
// transcript/broadcast, not in a post-push handler like Rotation uses.
const ROUNDTABLE_TAG_RE = /^\s*\[\s*TO:\s*(GEMINI|CHATGPT|CLAUDE|ALL|USER|NONE)\s*\]\s*/i;
function parseRoundtableTag(text) {
  const m = ROUNDTABLE_TAG_RE.exec(text);
  if (!m) return { tag: "USER", body: text }; // Rule 1: a missing tag defaults to the user
  return { tag: m[1].toUpperCase(), body: text.slice(m[0].length) };
}

async function startRoundtable() {
  // resetHouseRule()/state.hr.active are already set by the houserule:start
  // handler before dispatch (same as every other mode's start function) —
  // this only sets the fields specific to Roundtable's ack-then-active flow.
  state.hr.phase = "ack";
  state.hr.ackPending = new Set(ROTATION_ORDER);
  for (const site of ROTATION_ORDER) {
    await sendTextTo(site, roundtableRules.buildKickoffMessage(site), null);
  }
}

async function sendRoundtableTopic() {
  for (const site of ROTATION_ORDER) {
    await sendTextTo(site, state.hr.topic, null);
  }
}

async function handleRoundtableCapture(turn) {
  const hr = state.hr;
  if (hr.phase !== "active") return;

  const tag = turn.roundtableTag || "USER";
  let targets = [];
  if (tag === "ALL") targets = ROTATION_ORDER.filter((s) => s !== turn.site);
  else if (tag === "CLAUDE" || tag === "CHATGPT" || tag === "GEMINI") {
    const target = tag.toLowerCase();
    if (target !== turn.site) targets = [target]; // self-address guard
  }
  // tag === "USER" -> nothing to relay, the reply is already visible to the user

  for (const target of targets) {
    hr.roundNum++;
    await sendTextTo(target, turn.text, turn.site);
    // Check AFTER sending, not before: this ends the run the instant the
    // Nth hop goes out, rather than leaving it "active" indefinitely until
    // some future (N+1)th relay happens to be attempted and gets blocked.
    if (hr.rounds > 0 && hr.roundNum >= hr.rounds) {
      endHouseRule("hop limit reached");
      return;
    }
  }
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
    // Every middle capture starts a round — the very first (the opening
    // statement) as well as every later synthesis. Check the limit BEFORE
    // fanning out again (not after collecting Devil & Angel's replies), so a
    // "rounds: 1" run still lets Middle respond once to their feedback
    // instead of cutting off the moment those replies are collected.
    if (hr.rounds > 0 && hr.roundNum >= hr.rounds) { endHouseRule("rounds complete"); return; }
    hr.roundNum++;

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
    if (hr.roundNum >= hr.rounds) {
      // Fold the last exchange and the verdict request into ONE message to the
      // referee — sending two separate messages back-to-back to the same chat
      // risks the second landing while the site's input is still disabled from
      // generating a reply to the first.
      hr.phase = "awaiting-verdict";
      await sendTextTo(referee, `[${turn.label} says]\n\n${turn.text}\n\nThe debate is over. Based on everything you've observed, deliver your verdict: who argued better, and why? Declare a winner.`, null);
    } else {
      queueIgnore(referee);
      await sendTextTo(referee, `[${turn.label} says]\n\n${turn.text}`, null);
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

async function handleRotationCapture(turn) {
  const hr = state.hr;
  const order = hr.order;
  const idx = order.indexOf(turn.site);
  if (idx === -1) return;

  if (hr.phase === "awaiting-first") {
    if (turn.site !== order[0]) return; // only ChatGPT's first reply starts the rotation
    hr.phase = "rotating";
    hr.lastSpeakerIndex = 0;
  } else if (hr.phase === "rotating") {
    const expectedIdx = (hr.lastSpeakerIndex + 1) % order.length;
    if (idx !== expectedIdx) return; // not whoever we're expecting to RESPOND right now
    hr.lastSpeakerIndex = idx;
    hr.roundNum++;
  } else {
    return;
  }

  const nextSite = order[(hr.lastSpeakerIndex + 1) % order.length];
  const thirdSite = order[(hr.lastSpeakerIndex + 2) % order.length];

  const respondMsg = `[${turn.label} says]\n\n${turn.text}\n\nRespond to this, continuing the conversation naturally.`;
  await sendTextTo(nextSite, respondMsg, null);

  queueSilentAck(thirdSite);
  const updateMsg = `[${turn.label} says]\n\n${turn.text}\n\nDon't respond to this yet — it's not your turn. Just note it so you're caught up, and reply with exactly: UPDATED`;
  await sendTextTo(thirdSite, updateMsg, null);
}

async function handleHouseRuleCapture(turn) {
  switch (state.hr.mode) {
    case "debate": return handleDebateCapture(turn);
    case "devil-angel": return handleDevilAngelCapture(turn);
    case "chargeback": return handleChargebackCapture(turn);
    case "who-wants-to-speak": return handleWhoWantsCapture(turn);
    case "brainstorm": return handleBrainstormCapture(turn);
    case "rotation": return handleRotationCapture(turn);
    case "roundtable": return handleRoundtableCapture(turn);
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

    // A rate-limit/usage-cap message isn't a real contribution — feeding it
    // into the House Rule's state machine would relay "try again later" to
    // the other AIs as if it were a genuine reply, cascading garbage through
    // the whole run. Catch it first (ahead of the ignore/silentAck checks
    // below) and auto-pause instead, regardless of what phase we were in.
    if (state.hr.active && looksLikeRateLimit(text)) {
      const turn = { id: state.nextTurnId++, site, label: SITES[site].label, text, ts: Date.now(), pinned: false, isRateLimited: true };
      state.captured[site] = turn;
      state.transcript.push(turn);
      broadcast("capture", turn);
      logEvent("rate-limit-detected", { site, chars: text.length });
      if (state.waiting[site]) {
        state.waiting[site] = false;
        state.waitingSince[site] = null;
        broadcast("waiting-changed", { site, waiting: false });
      }
      state.hr.active = false;
      state.hr.pauseReason = "rate-limit";
      state.hr.pausedRouting = routingSnapshot();
      for (const s of SITE_IDS) state.routing[s].clear();
      state.meshActive = false;
      logEvent("houserule-paused", { mode: state.hr.mode, reason: "rate-limit" });
      broadcastHouseRule();
      saveStateDebounced();
      return;
    }

    // Roundtable's acknowledgment handshake: every reply captured while
    // waiting on acks is swallowed entirely (not pushed/broadcast) — the
    // human never needs to see three AIs each restate the house rules back.
    // Once the last of the three acks, flip to "active" and send the real
    // topic to all three at once.
    if (state.hr.active && state.hr.mode === "roundtable" && state.hr.phase === "ack") {
      state.captured[site] = { id: state.nextTurnId++, site, label: SITES[site].label, text, ts: Date.now(), pinned: false };
      if (state.waiting[site]) {
        state.waiting[site] = false;
        state.waitingSince[site] = null;
        broadcast("waiting-changed", { site, waiting: false });
      }
      if (state.hr.ackPending.has(site)) {
        state.hr.ackPending.delete(site);
        logEvent("roundtable-ack", { site, remaining: state.hr.ackPending.size });
        if (state.hr.ackPending.size === 0) {
          state.hr.phase = "active";
          await sendRoundtableTopic();
        }
        broadcastHouseRule();
        saveStateDebounced();
      }
      return;
    }

    // Roundtable's [TO: X] tag is literally the first thing the AI typed —
    // it has to be parsed and stripped BEFORE the turn is built below, since
    // that's what gets pushed to the transcript and broadcast live. [TO:
    // NONE] means "nothing to add" and is swallowed exactly like an ack.
    let roundtableTag = null;
    let displayText = text;
    if (state.hr.active && state.hr.mode === "roundtable" && state.hr.phase === "active") {
      const parsed = parseRoundtableTag(text);
      roundtableTag = parsed.tag;
      displayText = parsed.body;
      if (roundtableTag === "NONE") {
        state.captured[site] = { id: state.nextTurnId++, site, label: SITES[site].label, text, ts: Date.now(), pinned: false };
        if (state.waiting[site]) {
          state.waiting[site] = false;
          state.waitingSince[site] = null;
          broadcast("waiting-changed", { site, waiting: false });
        }
        logEvent("roundtable-skip", { site });
        return;
      }
    }

    const ignoreCount = state.hr.active ? state.hr.ignoreCaptureFrom.get(site) || 0 : 0;
    const silentAckCount = state.hr.active ? state.hr.silentAckFrom.get(site) || 0 : 0;

    // Both of these are "swallowed" — logged for troubleshooting only, never
    // pushed into the transcript/UI, never treated as a turn that advances
    // anything. This is what keeps Chargeback's Referee acknowledgments and
    // Rotation's "UPDATED" confirmations completely out of the user-facing
    // conversation.
    if (ignoreCount > 0 || silentAckCount > 0) {
      if (ignoreCount > 0) state.hr.ignoreCaptureFrom.set(site, ignoreCount - 1);
      if (silentAckCount > 0) state.hr.silentAckFrom.set(site, silentAckCount - 1);
      state.captured[site] = { id: state.nextTurnId++, site, label: SITES[site].label, text, ts: Date.now(), pinned: false };
      if (state.waiting[site]) {
        state.waiting[site] = false;
        state.waitingSince[site] = null;
        broadcast("waiting-changed", { site, waiting: false });
      }
      logEvent(silentAckCount > 0 ? "update-ack" : "ignored-ack", { site, chars: text.length });
      return;
    }

    const turn = { id: state.nextTurnId++, site, label: SITES[site].label, text: displayText, ts: Date.now(), pinned: false };
    if (roundtableTag) turn.roundtableTag = roundtableTag;
    // state.captured[site] tracks the RAW text (matching what pollSite reads
    // straight off the page) so the "already.text === text" dedup check
    // above keeps working on the next poll — storing the tag-stripped
    // displayText here instead would make it permanently mismatch the raw
    // DOM text every subsequent poll, causing the exact same roundtable
    // reply to be re-captured and re-relayed forever.
    state.captured[site] = roundtableTag ? { ...turn, text } : turn;
    state.transcript.push(turn);
    broadcast("capture", turn);
    logEvent("captured", { site, chars: displayText.length });
    saveStateDebounced();

    if (state.waiting[site]) {
      state.waiting[site] = false;
      state.waitingSince[site] = null;
      broadcast("waiting-changed", { site, waiting: false });
    }

    for (const target of state.routing[site]) {
      if (target === site) continue;
      await sendTextTo(target, text, site);
    }
    if (state.hr.active) await handleHouseRuleCapture(turn);
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
    broadcast("send-error", { target: site, error: res?.error || "unknown" });
    logEvent("send-error", { target: site, error: res?.error || "unknown", regenerate: true });
  } else {
    state.waiting[site] = true;
    state.waitingSince[site] = Date.now();
    broadcast("waiting-changed", { site, waiting: true });
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
  if (!enabled) {
    state.routing[site].clear();
    for (const s of SITE_IDS) state.routing[s].delete(site); // also drop it as a target everywhere else
  }
  logEvent("participant-changed", { site, enabled: !!enabled });
  syncPaneBounds();
  return { ok: true, global: globalSnapshot() };
});

ipcMain.handle("roles:set", (_evt, { site, role }) => {
  if (!SITES[site]) return { ok: false, error: "BAD_SITE" };
  state.customRole[site] = String(role || "").slice(0, 200);
  logEvent("role-changed", { site, role: state.customRole[site] || "(cleared)" });
  saveStateDebounced();
  return { ok: true, global: globalSnapshot() };
});

ipcMain.handle("houserule:start", async (_evt, { mode, topic, rounds }) => {
  if (!HOUSE_RULES.includes(mode)) return { ok: false, error: "BAD_MODE" };
  if (state.hr.active || state.hr.pausedRouting) return { ok: false, error: "ALREADY_RUNNING" };
  if (!topic || !String(topic).trim()) return { ok: false, error: "NEEDS_TOPIC" };

  const checked = SITE_IDS.filter((s) => state.enabled[s]);
  if (NEEDS_EXACTLY_THREE.has(mode) && checked.length !== 3) return { ok: false, error: "NEEDS_EXACTLY_THREE" };
  if (!NEEDS_EXACTLY_THREE.has(mode) && checked.length < 2) return { ok: false, error: "NEEDS_AT_LEAST_TWO" };
  if (mode === "chargeback" && (!rounds || Number(rounds) < 1)) return { ok: false, error: "NEEDS_ROUNDS" };

  resetHouseRule(mode, topic, rounds);
  state.hr.active = true;
  // Roundtable's rules text explicitly promises the AIs a real hop limit
  // exists ("the system will automatically stop you") — unlike every other
  // mode, 0/unspecified defaults to a real cap here instead of "unlimited",
  // so that promise stays true regardless of which window started it.
  if (mode === "roundtable" && !(state.hr.rounds > 0)) state.hr.rounds = DEFAULT_ROUNDTABLE_HOP_LIMIT;
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
    else if (mode === "rotation") await startRotation();
    else if (mode === "roundtable") await startRoundtable();
  } catch (e) {
    state.hr.active = false;
    return { ok: false, error: String(e) };
  }
  broadcastHouseRule();
  saveStateDebounced();
  return { ok: true, houseRule: houseRuleSnapshot() };
});

ipcMain.handle("houserule:stop", () => {
  state.hr.active = false;
  // Free-for-All/Brainstorm ride on the generic routing mesh, which the poll
  // loop forwards on regardless of hr.active — clear it here too, or "Stop"
  // wouldn't actually stop those two.
  for (const s of SITE_IDS) state.routing[s].clear();
  state.meshActive = false;
  state.hr.pausedRouting = null;
  state.hr.pauseReason = null;
  logEvent("houserule-stop", { mode: state.hr.mode });
  broadcastHouseRule();
  saveStateDebounced();
  return { ok: true, houseRule: houseRuleSnapshot(), global: globalSnapshot() };
});

ipcMain.handle("houserule:pause", () => {
  if (!state.hr.mode) return { ok: false, error: "NOT_RUNNING" };
  state.hr.active = false;
  state.hr.pauseReason = null; // manual pause — distinct from an automatic rate-limit pause
  state.hr.pausedRouting = routingSnapshot();
  for (const s of SITE_IDS) state.routing[s].clear();
  state.meshActive = false;
  logEvent("houserule-paused", { mode: state.hr.mode });
  broadcastHouseRule();
  saveStateDebounced();
  return { ok: true, houseRule: houseRuleSnapshot(), global: globalSnapshot() };
});

ipcMain.handle("houserule:resume", () => {
  if (!state.hr.mode) return { ok: false, error: "NOTHING_TO_RESUME" };
  state.hr.active = true;
  state.hr.pauseReason = null;
  if (state.hr.pausedRouting) {
    let any = false;
    for (const s of SITE_IDS) {
      const targets = state.hr.pausedRouting[s] || [];
      state.routing[s] = new Set(targets);
      if (targets.length) any = true;
    }
    state.meshActive = any;
    state.hr.pausedRouting = null;
  }
  logEvent("houserule-resumed", { mode: state.hr.mode });
  broadcastHouseRule();
  saveStateDebounced();
  return { ok: true, houseRule: houseRuleSnapshot(), global: globalSnapshot() };
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

ipcMain.handle("transcript:clear", () => { state.transcript = []; saveStateDebounced(); return { ok: true }; });

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

ipcMain.handle("window:toggle-collapse", (_evt, { which }) => {
  const target = targetWindow(which);
  const entry = windowCollapse[which];
  if (!target || !entry) return { ok: false, error: "NO_WINDOW" };

  if (!entry.collapsed) {
    entry.savedBounds = target.getBounds();
    entry.savedMinSize = typeof target.getMinimumSize === "function" ? target.getMinimumSize() : null;
    if (typeof target.setMinimumSize === "function") target.setMinimumSize(200, COLLAPSED_HEIGHT);
    target.setBounds({ x: entry.savedBounds.x, y: entry.savedBounds.y, width: entry.savedBounds.width, height: COLLAPSED_HEIGHT });
    entry.collapsed = true;
  } else {
    if (entry.savedBounds) target.setBounds(entry.savedBounds);
    if (entry.savedMinSize && typeof target.setMinimumSize === "function") target.setMinimumSize(entry.savedMinSize[0], entry.savedMinSize[1]);
    entry.collapsed = false;
    entry.savedBounds = null;
    entry.savedMinSize = null;
  }

  logEvent("window-collapse-changed", { which, collapsed: entry.collapsed });
  broadcast("window-collapse-changed", { which, collapsed: entry.collapsed });
  return { ok: true, which, collapsed: entry.collapsed };
});

app.whenReady().then(() => {
  loadPersistedState();
  createWindow();
  createConversationWindow();
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("activate", () => { if (!win) createWindow(); if (!convWin) createConversationWindow(); });
