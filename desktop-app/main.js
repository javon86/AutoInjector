// main.js — Electron main process, built around the Automation window:
// ChatGPT/Claude/Gemini panes merged with their control strips (preview,
// Forward, Auto, Regenerate), the House Rules box, Role Assignment, Prompt
// Library, and the Activity/Troubleshooting log. Three more on-demand popup
// windows (Prompt Editor, Document Viewer, Prompt Sequence) open only when
// needed, not at startup.
//
// Roundtable v2's [TO: X] tag routing (see pollSite()) is the program's
// permanent baseline, not something you start — every captured reply from
// every site gets parsed for a tag and routed accordingly (a specific AI,
// all of them, the user only, or nothing) all the time. On top of that,
// there's a House Rules subsystem: seven structured "stage" formats (Who
// Wants to Speak, Debate, Free-for-All, Devil & Angel, Chargeback,
// Brainstorm, Rotation) you can start to temporarily take over routing —
// each a small state machine driven off the same capture events as
// everything else — reverting back to the tag-routing baseline the moment
// you stop one. A capture can also be "silent" — swallowed before it ever
// reaches the transcript/UI — used for Chargeback's Referee acknowledgments
// and Rotation's "UPDATED" confirmations, neither of which should ever be
// shown to the user.
const { app, BaseWindow, WebContentsView, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const { pathToFileURL } = require("url");
const SITES = require("./selectors");
const { buildSendScript, buildReadScript, buildFileInputFinderExpression, buildPickScript } = require("./automation");
const managerProvider = require("./manager-provider");
const { MANAGER_ACTIONS } = managerProvider;

const SITE_IDS = Object.keys(SITES);
const ROTATION_ORDER = ["chatgpt", "claude", "gemini"]; // fixed, per spec — not shuffled like the other modes
const POLL_MS = 1500;
const STABLE_MS = 1800;
const MAX_LOG = 300;
const MAX_TRANSCRIPT = 1000; // oldest-first eviction, same idea as MAX_LOG for the debug log -- a long-running relay must not grow this without bound
const PANE_SYNC_MS = 700;
// The 7 structured formats that temporarily take over from the always-on
// Roundtable v2 [TO: X] tag routing (see pollSite()) — "roundtable" itself
// is no longer a House Rules mode you start/stop, it's just how the program
// behaves by default whenever none of these 7 are active.
const HOUSE_RULES = ["who-wants-to-speak", "debate", "free-for-all", "devil-angel", "chargeback", "brainstorm", "rotation"];
const STAGE_MODES = new Set(HOUSE_RULES);
const NEEDS_EXACTLY_THREE = new Set(["devil-angel", "chargeback", "rotation"]);
const COLLAPSED_HEIGHT = 44; // px — how tall a top-level window is once collapsed to just its titlebar
const MAX_DEBUG_LOG_LINES = 2000;
const SAVE_DEBOUNCE_MS = 500;
const FILE_ATTACH_PROTOCOL_VERSION = "1.3";
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const TEXT_EXTS = new Set([".txt", ".md", ".csv", ".json"]);
const TEXT_PREVIEW_SIZE_CAP = 500 * 1024; // 500KB
const SELFTEST_TIMEOUT_MS = 45000;
const SELFTEST_POLL_MS = 500;

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

// Shared by the connectivity self-test and the selector-picker's post-pick
// validation: both need to recognize "what we just read off the page is
// really just an echo of what we sent it" (e.g. a too-broad selector that
// reads the composer/user bubble instead of the assistant's actual reply)
// rather than a genuine response. Whitespace/case-normalized so trivial
// formatting differences don't defeat it, and matched both directions since
// either text can be a truncated/wrapped version of the other.
function looksLikeEcho(capturedText, recentlySentText) {
  if (!capturedText || !recentlySentText) return false;
  const norm = (s) => s.trim().replace(/\s+/g, " ").toLowerCase();
  const a = norm(capturedText);
  const b = norm(recentlySentText);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

function userDataDir() {
  try { return app.getPath("userData"); } catch { return __dirname; }
}
function stateFilePath() { return path.join(userDataDir(), "autoinjector-state.json"); }
// Manager task output goes somewhere the user will actually look for it
// (Documents), not buried in the app's internal userData folder alongside
// the state/debug-log files -- falls back to userDataDir() if Documents
// isn't available for some reason (matches userDataDir()'s own try/catch).
function projectsRootDir() {
  try { return path.join(app.getPath("documents"), "AutoInjector Projects"); } catch { return path.join(userDataDir(), "Projects"); }
}
function debugLogPath() { return path.join(userDataDir(), "autoinjector-debug.log"); }

let win = null;
let controlsView = null;
const siteViews = {};
const uiViews = []; // every renderer that should receive broadcasts

// Per top-level window: whether it's currently collapsed to just a titlebar,
// and (while collapsed) the full bounds to restore on expand.
const windowCollapse = {
  automation: { collapsed: false, savedBounds: null, savedMinSize: null }
};

function targetWindow(which) {
  return which === "automation" ? win : null;
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
  hr: null, // House Rules run state, see resetHouseRule()
  prompts: [], // { id, name, text: { chatgpt, claude, gemini } } — saved, reusable, one-click-send prompts. An empty text field for a site means "don't send to it."
  nextPromptId: 1,
  sequence: { active: false, steps: [], index: 0, generation: 0, dispatchGen: {} }, // Prompt Sequence run state, see startSequence()/handleSequenceCapture()
  selectorOverrides: {}, // site -> { input?, send?, assistant? } — user-picked CSS selectors (see selector:pick), tried before the built-in candidates in selectors.js
  managerConfig: {
    provider: "runpod-serverless", // runpod-serverless | runpod-pod | openai-compatible
    endpoint: "",
    apiKey: "",
    model: "",
    tier: 2,
    timeoutMs: 180000,
    podId: "", // only meaningful for provider "runpod-pod"
    approvalMode: false,
    maximumTurns: 20,
    costLimit: 5
  },
  manager: null, // set by resetManagerTask() below — always idle on startup, a restart must never auto-resume a live task
  managerLog: [] // manager-only event stream (mirrors state.log's shape but filtered to source:"manager"), see logManagerEvent()
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
  state.selectorOverrides[site] = {};
}

// Built-in starter prompt: a one-click sanity check that the whole
// automation pipeline (typing, sending, reading replies, routing) actually
// works, without needing to run a full House Rules session first.
function defaultTestPrompt() {
  const text = {};
  for (const site of SITE_IDS) {
    text[site] = `This is a diagnostic test of the AutoInjector automation system, not a real task. Please: (1) reply here to confirm this message reached you, (2) briefly confirm what you understand your role to be right now, and (3) if messages from ${otherLabels(SITE_IDS, site)} show up afterward, say so — that confirms routing between the three of us is actually working end-to-end. Keep your reply short.`;
  }
  return { id: 1, name: "System Test", text };
}

// Second built-in: a reference explainer, not a diagnostic — tells each AI
// how message routing on this app actually works ([TO: X] tags). This exact
// text is auto-sent to every site once on every app startup (see
// sendStartupRoutingPromptOnce()) and stays here in the Prompt Library so it
// can be resent manually any time, e.g. if one of them seems to have
// forgotten how the tagging works mid-conversation.
function defaultRoutingExplainerPrompt() {
  const text = {};
  for (const site of SITE_IDS) {
    text[site] = `Quick reference, not a task — no need to reply unless you want to. This app relays messages between the three of us (ChatGPT, Claude, Gemini); we're not talking to each other directly, everything is routed on this end. By default, every reply you send gets read for a tag on its own line at the start — [TO: CHATGPT], [TO: CLAUDE], [TO: GEMINI], [TO: ALL], [TO: USER], or [TO: NONE] — to control who sees it next: a specific one of us, everyone, just the human running this, or nobody if you have nothing to add. If you leave the tag off, it's treated as [TO: USER]. This applies all the time, not just for a specific "mode."`;
  }
  return { id: 2, name: "System Prompt (How Routing Works)", text };
}
state.prompts = [defaultTestPrompt(), defaultRoutingExplainerPrompt()];
state.nextPromptId = 3;

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
    ignoreCaptureFrom: new Map(), // site -> count of pending informational sends whose ack should be swallowed (visible in the log, not the transcript)
    silentAckFrom: new Map(), // site -> count of pending "UPDATE" sends whose "UPDATED" ack should be swallowed entirely
    pausedRouting: null, // stashed routing snapshot while paused, restored on resume
    pauseReason: null // null = manual pause/never paused; "rate-limit" = auto-paused after detecting a usage-cap reply
  };
}
resetHouseRule(null, "", 0);

// The manager/orchestrator's task state — see manager-provider.js's header
// comment for why this is allowed to call out to a real API (a RunPod/
// Ollama/LM Studio-hosted model acting as supervisor) while ChatGPT/Claude/
// Gemini delegation still goes exclusively through sendTextTo()/pollSite().
// Always reset to idle on startup, same reasoning as House Rules: a restart
// must never silently resume a live task or auto-send anything.
function resetManagerTask() {
  state.manager = {
    taskId: null,
    userRequest: "",
    deliverableSpecification: {},
    plan: [],
    activeAssignments: [], // { target, task, sentTs }
    completedAssignments: [], // { target, task, response, ts }
    latestResponses: { chatgpt: null, claude: null, gemini: null },
    allResponses: [], // { id, target, text, ts } — every response ever captured for this task, never overwritten
    conflicts: [],
    missingRequirements: [],
    previousManagerActions: [], // the last N validated decisions, for the model's own context
    pendingModels: [], // targets an active DELEGATE/WAIT is still waiting on
    currentTier: state.managerConfig.tier,
    turnNumber: 0,
    maximumTurns: state.managerConfig.maximumTurns,
    costUsed: 0,
    costLimit: state.managerConfig.costLimit,
    status: "idle", // idle|classifying|planning|delegating|waiting|reviewing|comparing|validating|assembling|saving|paused|finished|error
    projectDir: null,
    startedTs: null,
    finishedTs: null,
    noProgressStreak: 0, // consecutive turns without any state change, used by detectNoProgress()
    pendingApproval: null // a validated decision awaiting manager:approve/manager:reject, when approval mode is on (or the manager itself chose REQUEST_APPROVAL)
  };
}
resetManagerTask();

// A decision's action alone being in MANAGER_ACTIONS (already guaranteed by
// manager-provider.js's own contract) isn't enough on its own -- this is the
// second, independent layer of validation the spec calls for: per-action
// shape checks, a hard target allowlist (only chatgpt/claude/gemini, ever),
// safe relative paths for anything that touches disk, and a scan for
// obviously dangerous content (code injection attempts, credential leakage)
// in any field the manager controls. Nothing here ever gets eval'd or
// executed -- assignment "task" text just becomes a sendTextTo() prompt like
// any other -- but rejecting it outright at the door is cheap insurance and
// exactly what section 6 of the spec asks for.
const DANGEROUS_CONTENT_PATTERNS = [
  /\brequire\s*\(/, /\beval\s*\(/, /\bnew\s+Function\s*\(/, /<script[\s>]/i,
  /\bprocess\s*\./, /\bchild_process\b/, /\b(document|window)\s*\.\s*(cookie|localStorage|sessionStorage)\b/i
];
const MANAGER_CONTENT_CAP = 2 * 1024 * 1024; // 2MB — generous for real document content, still bounded

function scanForDangerousContent(value, path, violations) {
  if (typeof value === "string") {
    if (value.length > MANAGER_CONTENT_CAP) violations.push(`${path}: exceeds ${MANAGER_CONTENT_CAP} char cap`);
    if (state.managerConfig.apiKey && value.includes(state.managerConfig.apiKey)) violations.push(`${path}: contains what looks like the configured API key`);
    for (const re of DANGEROUS_CONTENT_PATTERNS) {
      if (re.test(value)) { violations.push(`${path}: matches a disallowed pattern (${re})`); break; }
    }
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => scanForDangerousContent(v, `${path}[${i}]`, violations));
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) scanForDangerousContent(v, `${path}.${k}`, violations);
  }
}

// No ".." segments, no absolute paths, no drive letters, no null bytes --
// every manager-proposed filename must resolve strictly inside that task's
// own project directory. Deliberately conservative: reject anything that
// isn't obviously a plain relative path rather than trying to enumerate
// every way path traversal can be spelled.
function isSafeRelativePath(p) {
  if (typeof p !== "string" || !p || p.length > 500) return false;
  if (p.includes("\0")) return false;
  if (path.isAbsolute(p)) return false;
  const normalized = path.normalize(p);
  if (normalized.split(path.sep).includes("..")) return false;
  if (/^[a-zA-Z]:/.test(p)) return false; // Windows drive letter
  return true;
}

function validateManagerAction(decision) {
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) return { ok: false, error: "MALFORMED" };
  if (typeof decision.action !== "string" || !MANAGER_ACTIONS.includes(decision.action)) return { ok: false, error: "UNKNOWN_ACTION" };

  const violations = [];
  scanForDangerousContent(decision, "decision", violations);

  const NEEDS_ASSIGNMENTS = new Set(["DELEGATE", "SEND", "FORWARD", "COMPARE", "CRITIQUE", "VERIFY"]);
  if (NEEDS_ASSIGNMENTS.has(decision.action)) {
    if (!Array.isArray(decision.assignments) || !decision.assignments.length) {
      return { ok: false, error: "MISSING_ASSIGNMENTS" };
    }
    for (const a of decision.assignments) {
      if (!a || typeof a !== "object" || !SITES[a.target] || typeof a.task !== "string" || !a.task.trim()) {
        return { ok: false, error: "BAD_ASSIGNMENT", detail: a };
      }
    }
  }

  if (decision.action === "SAVE" || decision.action === "EXPORT") {
    if (!isSafeRelativePath(decision.filename)) return { ok: false, error: "UNSAFE_PATH" };
    if (typeof decision.content !== "string") return { ok: false, error: "MISSING_CONTENT" };
  }

  if (decision.action === "ESCALATE") {
    const tier = Number(decision.toTier);
    if (!Number.isInteger(tier) || tier < 1 || tier > 4) return { ok: false, error: "BAD_TIER" };
  }

  if (violations.length) return { ok: false, error: "DANGEROUS_CONTENT", violations };
  return { ok: true, decision };
}

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

// The only place a turn is ever added to the visible transcript -- keeps it
// bounded the same way the debug log already is, oldest-first eviction, so
// a long-running relay session can't grow this (and the state file it gets
// persisted into) without limit.
function pushTranscriptTurn(turn) {
  state.transcript.push(turn);
  if (state.transcript.length > MAX_TRANSCRIPT) state.transcript.splice(0, state.transcript.length - MAX_TRANSCRIPT);
}

function logEvent(kind, detail) {
  const entry = { ts: Date.now(), kind, detail };
  state.log.push(entry);
  if (state.log.length > MAX_LOG) state.log.shift();
  broadcast("log", entry);
  appendDebugLog(entry);
}

// The shared normalized event system (spec section 14): one event, up to
// two views. Manager-specific detail (tier, provider, model, action,
// target) always goes to the dedicated Manager Activity Log; the same
// event optionally also gets folded into the existing global Activity Log
// (as a "manager-<category>" kind, through the ordinary logEvent() path
// above) so the global log stays a complete application-wide record without
// a second, parallel log-writing implementation.
let managerEventSeq = 1;
function logManagerEvent({ category, severity, action, target, summary, details, visibleInManagerLog = true, visibleInGlobalLog = true }) {
  let safeDetails = details || {};
  try {
    safeDetails = JSON.parse(managerProvider.redactSecrets(JSON.stringify(safeDetails), state.managerConfig));
  } catch { /* best effort -- never let a logging call itself throw */ }

  const entry = {
    eventId: `mgr-${managerEventSeq++}`,
    ts: Date.now(),
    taskId: state.manager.taskId,
    source: "manager",
    category: category || "general",
    severity: severity || "info",
    tier: state.manager.currentTier,
    provider: state.managerConfig.provider,
    model: state.managerConfig.model,
    action: action || null,
    target: target || null,
    summary: summary || "",
    details: safeDetails
  };

  if (visibleInManagerLog) {
    state.managerLog.push(entry);
    if (state.managerLog.length > MAX_LOG) state.managerLog.shift();
    broadcast("manager-log", entry);
  }
  if (visibleInGlobalLog) {
    logEvent(`manager-${entry.category}`, { summary: entry.summary, taskId: entry.taskId, ...safeDetails });
  } else if (visibleInManagerLog) {
    appendDebugLog(entry); // still worth a debug-log trace even when it's not going in the global Activity Log
  }
  return entry;
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
        prompts: state.prompts,
        selectorOverrides: state.selectorOverrides,
        managerConfig: state.managerConfig, // the live task itself (state.manager) is deliberately NOT persisted -- same reasoning as House Rules, below
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
      // Atomic write: a crash/power-loss mid-write to the real path can
      // leave a truncated, unparseable file behind -- writing to a sibling
      // temp file first and rename()-ing it over the real path means the
      // real path only ever points at a complete write (rename is atomic on
      // the same filesystem, which a sibling file in the same dir always is).
      const target = stateFilePath();
      const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(snapshot));
      fs.renameSync(tmp, target);
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
    state.transcript = snap.transcript.length > MAX_TRANSCRIPT ? snap.transcript.slice(snap.transcript.length - MAX_TRANSCRIPT) : snap.transcript;
    state.nextTurnId = snap.transcript.reduce((m, t) => Math.max(m, (t.id || 0) + 1), 1);
  }
  if (snap.customRole) {
    for (const site of SITE_IDS) if (typeof snap.customRole[site] === "string") state.customRole[site] = snap.customRole[site];
  }
  if (Array.isArray(snap.prompts)) {
    state.prompts = snap.prompts;
    state.nextPromptId = snap.prompts.reduce((m, p) => Math.max(m, (p.id || 0) + 1), 1);
  }
  if (snap.selectorOverrides) {
    for (const site of SITE_IDS) {
      if (snap.selectorOverrides[site]) state.selectorOverrides[site] = { ...snap.selectorOverrides[site] };
    }
  }
  if (snap.managerConfig && typeof snap.managerConfig === "object") {
    state.managerConfig = { ...state.managerConfig, ...snap.managerConfig };
    state.manager.currentTier = state.managerConfig.tier;
    state.manager.maximumTurns = state.managerConfig.maximumTurns;
    state.manager.costLimit = state.managerConfig.costLimit;
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
    // Fires once this site's page has actually finished loading (not on a
    // fixed delay, which would race against a slow connection) — sending
    // any earlier would hit a chat UI whose input box doesn't exist yet.
    // Only ever fires once per app launch, not on a later manual 🔍/⟳ reload.
    view.webContents.once("did-finish-load", () => sendStartupRoutingPromptOnce(site));
  }

  layout();
  win.on("resize", () => { layout(); syncPaneBounds(); });
  win.on("closed", () => { win = null; });

  setInterval(() => { for (const site of SITE_IDS) pollSite(site); }, POLL_MS);
}

// A small, on-demand third window for creating/editing one Prompt Library
// entry at a time — not created at startup like the other two, only when
// "+ New" or "Edit" is clicked. Re-navigating an already-open editor (rather
// than opening a second one) keeps this to at most one instance.
let promptEditorWin = null;
let promptEditorView = null;
function openPromptEditorWindow(id) {
  const search = id != null ? `id=${id}` : "";
  if (promptEditorWin && promptEditorView) {
    promptEditorView.webContents.loadFile(path.join(__dirname, "prompt-editor.html"), { search });
    promptEditorWin.focus();
    return;
  }
  promptEditorWin = new BaseWindow({ width: 560, height: 600, resizable: true, title: "AutoInjector — Edit Prompt" });
  promptEditorView = new WebContentsView({
    webPreferences: {
      partition: "prompt-editor-ui",
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  promptEditorWin.contentView.addChildView(promptEditorView);
  promptEditorView.webContents.loadFile(path.join(__dirname, "prompt-editor.html"), { search });
  const layoutEditor = () => {
    if (!promptEditorWin || !promptEditorView) return;
    const [w, h] = promptEditorWin.getContentSize();
    promptEditorView.setBounds({ x: 0, y: 0, width: w, height: h });
  };
  layoutEditor();
  promptEditorWin.on("resize", layoutEditor);
  promptEditorWin.on("closed", () => { promptEditorWin = null; promptEditorView = null; });
}
function closePromptEditorWindow() {
  if (promptEditorWin) promptEditorWin.close();
}

// A small, on-demand fourth window for previewing a document before sending
// it to one or more AIs — same single-instance, re-navigate-via-query-string
// pattern as the prompt editor window above.
let documentViewerWin = null;
let documentViewerView = null;
function openDocumentViewerWindow(filePath) {
  const search = `path=${encodeURIComponent(filePath)}`;
  if (documentViewerWin && documentViewerView) {
    documentViewerView.webContents.loadFile(path.join(__dirname, "document-viewer.html"), { search });
    documentViewerWin.focus();
    return;
  }
  documentViewerWin = new BaseWindow({ width: 820, height: 700, resizable: true, title: "AutoInjector — Document" });
  documentViewerView = new WebContentsView({
    webPreferences: {
      partition: "document-viewer-ui",
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  documentViewerWin.contentView.addChildView(documentViewerView);
  documentViewerView.webContents.loadFile(path.join(__dirname, "document-viewer.html"), { search });
  const layoutViewer = () => {
    if (!documentViewerWin || !documentViewerView) return;
    const [w, h] = documentViewerWin.getContentSize();
    documentViewerView.setBounds({ x: 0, y: 0, width: w, height: h });
  };
  layoutViewer();
  documentViewerWin.on("resize", layoutViewer);
  documentViewerWin.on("closed", () => { documentViewerWin = null; documentViewerView = null; });
}
function closeDocumentViewerWindow() {
  if (documentViewerWin) documentViewerWin.close();
}

// A fourth on-demand window: build a numbered list of prompts to fire off
// one at a time. Same lazy single-instance pattern as the other two popups,
// but it never needs to be re-targeted at a different id (there's no
// existing entity to edit) — reopening while it's already open just
// refocuses it.
let sequenceWin = null;
let sequenceView = null;
function openSequenceWindow() {
  if (sequenceWin && sequenceView) {
    sequenceWin.focus();
    return;
  }
  sequenceWin = new BaseWindow({ width: 640, height: 640, resizable: true, title: "AutoInjector — Prompt Sequence" });
  sequenceView = new WebContentsView({
    webPreferences: {
      partition: "prompt-sequence-ui",
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  sequenceWin.contentView.addChildView(sequenceView);
  sequenceView.webContents.loadFile(path.join(__dirname, "prompt-sequence.html"));
  const layoutSequence = () => {
    if (!sequenceWin || !sequenceView) return;
    const [w, h] = sequenceWin.getContentSize();
    sequenceView.setBounds({ x: 0, y: 0, width: w, height: h });
  };
  layoutSequence();
  sequenceWin.on("resize", layoutSequence);
  sequenceWin.on("closed", () => { sequenceWin = null; sequenceView = null; });
}
function closeSequenceWindow() {
  if (sequenceWin) sequenceWin.close();
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
    customRole: { ...state.customRole },
    selectorOverrides: Object.fromEntries(SITE_IDS.map((s) => [s, { ...state.selectorOverrides[s] }]))
  };
}

function managerSnapshot() {
  const m = state.manager;
  return {
    taskId: m.taskId,
    userRequest: m.userRequest,
    deliverableSpecification: m.deliverableSpecification,
    plan: m.plan,
    activeAssignments: m.activeAssignments,
    completedAssignments: m.completedAssignments,
    latestResponses: { ...m.latestResponses },
    conflicts: m.conflicts,
    missingRequirements: m.missingRequirements,
    previousManagerActions: m.previousManagerActions,
    pendingModels: m.pendingModels,
    currentTier: m.currentTier,
    turnNumber: m.turnNumber,
    maximumTurns: m.maximumTurns,
    costUsed: m.costUsed,
    costLimit: m.costLimit,
    status: m.status,
    projectDir: m.projectDir,
    pendingApproval: m.pendingApproval
  };
}

function managerConfigSnapshot() {
  // Never send the raw API key to a renderer -- the config UI only needs to
  // know one is set, not to see it (it already has its own input box for
  // entering/replacing it).
  const { apiKey, ...rest } = state.managerConfig;
  return { ...rest, hasApiKey: !!apiKey };
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
    phase: hr.phase
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
    res = await view.webContents.executeJavaScript(buildSendScript(target, prompt, state.selectorOverrides[target]), true);
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

// The connectivity Test button: send a prompt carrying a fresh, effectively
// unique token straight to one site (bypassing routing entirely, like
// Compose does), but instead of asking for the token back verbatim -- which
// a too-broad ASSISTANT_CANDIDATES selector can "pass" simply by reading the
// sent prompt itself back, since the token is right there in it -- ask for
// the token REVERSED. A real reply then has to contain the reversed form
// and NOT the original, which a mere echo of the outgoing prompt can never
// satisfy. state.captured[site] -- which pollSite() already keeps up to date
// on its normal ~1.5s cycle -- is watched for a capture at or after the
// moment we sent, and classified into one of four distinct outcomes:
//   ok                -- reversed present, original absent: a real reply
//   SELECTOR_TOO_BROAD -- both present: almost certainly reading the whole
//                         thread (prompt + reply) rather than just the reply
//   REPLY_ECHO         -- only the original is present: just echoing what
//                         was sent, never actually answered
//   REPLY_MISMATCH     -- something else came back that matches neither
//   TIMEOUT            -- nothing came back at all
const selftestInFlight = new Set();
function makeSelftestToken() {
  return "AUTOINJ-" + Math.random().toString(36).slice(2, 8).toUpperCase();
}
async function waitForTestReply(site, token, reversedToken, sentTs, timeoutMs) {
  const classify = (cap) => {
    if (!cap || cap.ts < sentTs) return null;
    const hasReversed = cap.text.includes(reversedToken);
    const hasOriginal = cap.text.includes(token);
    if (hasReversed && hasOriginal) return { ok: false, error: "SELECTOR_TOO_BROAD", text: cap.text.slice(0, 200) };
    if (hasReversed) return { ok: true };
    if (hasOriginal) return { ok: false, error: "REPLY_ECHO", text: cap.text.slice(0, 200) };
    return null;
  };
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const verdict = classify(state.captured[site]);
    if (verdict) return verdict;
    await new Promise((r) => setTimeout(r, SELFTEST_POLL_MS));
  }
  const cap = state.captured[site];
  const verdict = classify(cap);
  if (verdict) return verdict;
  // A capture that arrived but matches neither form still proves the read
  // pipeline picked SOMETHING up -- surfacing what it actually was is the
  // single most useful clue for fixing a broken ASSISTANT_CANDIDATES
  // selector (stale/wrong content captured vs. genuinely nothing at all).
  if (cap && cap.ts >= sentTs) return { ok: false, error: "REPLY_MISMATCH", text: cap.text.slice(0, 200) };
  return { ok: false, error: "TIMEOUT" };
}

// The routing-explainer prompt (Prompt Library id 2) gets sent to every
// site automatically, once, the first time its page loads after app
// startup — establishing baseline awareness of the [TO: X] tag system
// without the user having to remember to trigger it. Fire-and-forget, no
// acknowledgment wait. Pulls from state.prompts (not a fresh-generated
// copy) so a user edit to that saved prompt is reflected here too; if
// they've deleted it, this just quietly does nothing.
const startupPromptSent = new Set();
async function sendStartupRoutingPromptOnce(site) {
  if (startupPromptSent.has(site)) return;
  startupPromptSent.add(site);
  const prompt = state.prompts.find((p) => p.id === 2);
  const text = prompt && prompt.text && prompt.text[site];
  if (!text) return;
  await sendTextTo(site, text, null);
}

// Delivers a real file into a live pane's chat, using the Chrome DevTools
// Protocol (Puppeteer/Playwright use the same technique under the hood for
// file uploads) — there's no other way to get real file bytes into a page
// from the main process; executeJavaScript() can only inject text.
// DOM.setFileInputFiles fires real input/change events on the target
// element, same as a genuine drag-drop, so sites wired to a change listener
// need nothing extra from us. The attach/detach cycle is transient (scoped
// to a single call) so it doesn't fight the 🔍 Inspect DevTools feature,
// which uses the same underlying CDP slot — but if DevTools happens to be
// open on this pane when this runs, attach() can still throw; that's
// reported as ATTACH_FAILED rather than specifically diagnosed, since it's
// a rare, transient collision, not a distinct failure mode worth its own code.
async function attachFileToSite(site, absolutePath) {
  const view = siteViews[site];
  if (!view || view.webContents.isDestroyed()) {
    logEvent("file-attach-error", { site, error: "NO_VIEW" });
    return { ok: false, error: "NO_VIEW" };
  }
  const dbg = view.webContents.debugger;

  try {
    dbg.attach(FILE_ATTACH_PROTOCOL_VERSION);
  } catch (e) {
    logEvent("file-attach-error", { site, error: "ATTACH_FAILED", detail: String(e) });
    return { ok: false, error: "ATTACH_FAILED", detail: String(e) };
  }

  try {
    let evalRes;
    try {
      evalRes = await dbg.sendCommand("Runtime.evaluate", {
        expression: buildFileInputFinderExpression(site),
        returnByValue: false
      });
    } catch (e) {
      logEvent("file-attach-error", { site, error: "EVAL_FAILED", detail: String(e) });
      return { ok: false, error: "EVAL_FAILED", detail: String(e) };
    }
    const objectId = evalRes && evalRes.result && evalRes.result.objectId;
    if (!objectId) {
      logEvent("file-attach-error", { site, error: "NO_FILE_INPUT_FOUND" });
      return { ok: false, error: "NO_FILE_INPUT_FOUND" };
    }
    try {
      await dbg.sendCommand("DOM.setFileInputFiles", { files: [absolutePath], objectId });
    } catch (e) {
      logEvent("file-attach-error", { site, error: "SET_FILES_FAILED", detail: String(e) });
      return { ok: false, error: "SET_FILES_FAILED", detail: String(e) };
    }
    try { await dbg.sendCommand("Runtime.releaseObject", { objectId }); } catch {}
    logEvent("file-attached", { site, path: absolutePath });
    return { ok: true };
  } finally {
    try { dbg.detach(); } catch {}
  }
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

// The always-on baseline router: relays a tagged reply per Rule 1's
// semantics (ALL -> both others, a named AI -> just that one with a
// self-address guard, USER -> nothing further, it's already visible). No
// session, no hop limit, no start/stop — this just runs on every capture
// whenever no stage format has taken over (see pollSite()).
async function handleRoundtableCapture(turn) {
  const tag = turn.roundtableTag || "USER";
  let targets = [];
  if (tag === "ALL") targets = ROTATION_ORDER.filter((s) => s !== turn.site);
  else if (tag === "CLAUDE" || tag === "CHATGPT" || tag === "GEMINI") {
    const target = tag.toLowerCase();
    if (target !== turn.site) targets = [target]; // self-address guard
  }
  for (const target of targets) {
    await sendTextTo(target, turn.text, turn.site);
  }
}

// --- Prompt Sequence: a numbered list of prompts, each targeted at a
// specific AI (or "all"), sent one at a time — the next step only goes out
// once the current step's target has actually replied, not on a timer.
// Runs independently of everything above (it's not a House Rules stage);
// its steps' replies still go through the normal capture/broadcast/tag-
// routing path, this just also watches for "was that the reply we were
// waiting on" to advance.
function broadcastSequenceState() {
  const seq = state.sequence;
  broadcast("sequence-state", { active: seq.active, index: seq.index, total: seq.steps.length });
}

async function sendSequenceStep() {
  const seq = state.sequence;
  if (!seq.active || seq.index >= seq.steps.length) {
    seq.active = false;
    logEvent("sequence-done", {});
    broadcastSequenceState();
    return;
  }
  // Every dispatch gets its own generation number, stamped per-site into
  // dispatchGen — handleSequenceCapture() below only accepts a capture from
  // a site whose OWN last-dispatched generation is the current one. Without
  // this, a reply that's still in flight for a step this app already
  // advanced past (most easily triggered by an "all" step, where the first
  // of three replies advances the index while the other two are still
  // coming) could get matched against whatever step comes next instead of
  // being recognized as a stale leftover of the step it actually answers.
  seq.generation++;
  const step = seq.steps[seq.index];
  const targets = step.target === "all" ? SITE_IDS : [step.target];
  for (const t of targets) {
    if (SITES[t]) {
      seq.dispatchGen[t] = seq.generation;
      await sendTextTo(t, step.text, null);
    }
  }
  logEvent("sequence-step-sent", { index: seq.index, target: step.target, generation: seq.generation });
  broadcastSequenceState();
}

async function startSequence(steps) {
  state.sequence = { active: true, steps, index: 0, generation: 0, dispatchGen: {} };
  await sendSequenceStep();
}

async function handleSequenceCapture(turn) {
  const seq = state.sequence;
  if (!seq.active) return;
  const step = seq.steps[seq.index];
  if (!step) { seq.active = false; broadcastSequenceState(); return; }
  // For an "all" step, the first of the three replies to arrive is enough
  // to advance — waiting for all three would mean one slow AI blocks the
  // whole sequence indefinitely.
  const matches = step.target === "all" ? true : step.target === turn.site;
  if (!matches) return;
  if (seq.dispatchGen[turn.site] !== seq.generation) {
    logEvent("sequence-stale-capture-ignored", { site: turn.site, expectedGeneration: seq.dispatchGen[turn.site] ?? null, currentGeneration: seq.generation });
    return;
  }
  seq.index++;
  await sendSequenceStep();
}

// --- Manager/orchestrator: the supervisory loop over a managed task --------
// Delegation (DELEGATE/SEND/FORWARD/COMPARE/CRITIQUE/VERIFY) reuses
// sendTextTo()/pollSite() exactly like every other feature in this app --
// the only new thing here is WHO decides what to send next: a call out to
// manager-provider.js's askManager() instead of a fixed state machine like
// House Rules' formats. The loop is event-driven, not a blocking wait: after
// dispatching to state.manager.pendingModels, runManagerTurn() returns, and
// handleManagerCapture() (hooked into pollSite()'s dispatch, same pattern as
// handleSequenceCapture) resumes it once every pending target has replied.

function sanitizeTaskFolderName(text) {
  return (String(text || "task").trim().slice(0, 60).replace(/[^a-zA-Z0-9 _-]/g, "").replace(/\s+/g, "-")) || "task";
}

async function createProjectDir(taskId, userRequest) {
  const base = path.join(projectsRootDir(), `${sanitizeTaskFolderName(userRequest)}-${taskId}`);
  for (const sub of ["raw-responses", "working", "sources", "versions", "final"]) {
    await fs.promises.mkdir(path.join(base, sub), { recursive: true });
  }
  return base;
}

async function saveManagerFile(filename, content) {
  const m = state.manager;
  if (!m.projectDir || !isSafeRelativePath(filename)) {
    logManagerEvent({ category: "error", severity: "error", summary: `Refused to save to an unsafe or missing path: ${filename}` });
    return { ok: false, error: "UNSAFE_PATH" };
  }
  const fullPath = path.join(m.projectDir, "final", filename);
  try {
    await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.promises.writeFile(fullPath, content, "utf8");
    logManagerEvent({ category: "file", summary: `Saved final/${filename}`, details: { bytes: content.length } });
    return { ok: true, path: fullPath };
  } catch (e) {
    logManagerEvent({ category: "error", severity: "error", summary: `Failed to save ${filename}: ${String(e)}` });
    return { ok: false, error: String(e) };
  }
}

async function saveRawResponse(entry) {
  const m = state.manager;
  if (!m.projectDir) return;
  try {
    await fs.promises.writeFile(path.join(m.projectDir, "raw-responses", `${entry.id}-${entry.target}.md`), entry.text, "utf8");
    await fs.promises.appendFile(path.join(m.projectDir, "manager-log.jsonl"), `${JSON.stringify(entry)}\n`, "utf8");
  } catch (e) {
    logManagerEvent({ category: "error", severity: "error", summary: `Failed to save raw response: ${String(e)}` });
  }
}

async function saveTaskCheckpoint() {
  const m = state.manager;
  if (!m.projectDir) return;
  try {
    await fs.promises.writeFile(path.join(m.projectDir, "project.json"), JSON.stringify(managerSnapshot(), null, 2), "utf8");
  } catch (e) {
    logManagerEvent({ category: "error", severity: "error", summary: `Failed to save checkpoint: ${String(e)}` });
  }
}

function broadcastManagerState() {
  broadcast("manager-state", managerSnapshot());
}

function detectNoProgress() {
  return state.manager.noProgressStreak >= 2;
}

function selectManagerTier() {
  // Phase 1: one configurable tier plus manual/error-driven escalation --
  // the full automatic 0-4 ladder from the spec (routing different tiers to
  // different provider configs) is a later phase once this core loop is
  // proven out. Tier 4 is handled specially in runManagerTurn(): it routes
  // to a real ChatGPT/Claude/Gemini pane instead of the configured
  // RunPod/Ollama/LM Studio endpoint, per the spec's "cloud adjudication".
  return state.manager.currentTier || state.managerConfig.tier || 2;
}

// toTier lets an explicit ESCALATE action (which validateManagerAction()
// already confirmed is an integer 1-4) jump straight to a requested tier in
// one step -- e.g. straight to Tier 4 cloud adjudication -- while the
// error-driven call sites (a provider failure, a repeatedly invalid action)
// omit it and just step up by exactly one. Escalation only ever moves up;
// a lower toTier than the current one is ignored rather than treated as a
// de-escalation request, which is handled separately in handleManagerCapture().
async function escalateManagerTier(reason, toTier) {
  const m = state.manager;
  const next = toTier != null ? Math.max(m.currentTier || 2, Math.min(4, toTier)) : Math.min(4, (m.currentTier || 2) + 1);
  logManagerEvent({ category: "escalation", severity: "warning", summary: `Escalating tier ${m.currentTier} -> ${next}: ${reason}`, details: { from: m.currentTier, to: next, reason } });
  m.currentTier = next;
  m.noProgressStreak = 0;
  await runManagerTurn();
}

function assembleTaskState() {
  return { ...state.manager };
}

async function runTierFourAdjudication() {
  const m = state.manager;
  const adjudicator = (state.managerConfig.adjudicatorSite && SITES[state.managerConfig.adjudicatorSite]) ? state.managerConfig.adjudicatorSite : "claude";
  const question = `[Manager escalation -- tier 4 cloud adjudication for task "${m.taskId}"]\nOriginal request: ${m.userRequest}\n\nConflict/disagreement: ${JSON.stringify(m.conflicts)}\n\nMissing requirements: ${JSON.stringify(m.missingRequirements)}\n\nRelevant responses so far: ${JSON.stringify(m.latestResponses)}\n\nPlease resolve this and state clearly what should happen next.`;
  m.activeAssignments = [{ target: adjudicator, task: question, sentTs: Date.now() }];
  m.pendingModels = [adjudicator];
  m.status = "waiting";
  logManagerEvent({ category: "escalation", severity: "warning", summary: `Escalated to Tier 4 cloud adjudication via ${SITES[adjudicator].label}`, target: [adjudicator] });
  await sendTextTo(adjudicator, question, null);
  broadcastManagerState();
}

const MANAGER_ACTIVE_STATUSES = new Set(["classifying", "planning", "delegating", "reviewing", "comparing", "validating", "assembling", "saving"]);

async function runManagerTurn() {
  const m = state.manager;
  if (!MANAGER_ACTIVE_STATUSES.has(m.status)) return; // idle/waiting/paused/finished/error -- nothing to advance right now
  const myTaskId = m.taskId; // see the guard right after the askManager await below

  m.turnNumber++;
  if (m.turnNumber > m.maximumTurns) { await finishManagedTask({ ok: false, reason: "MAX_TURNS_EXCEEDED" }); return; }
  if (m.costLimit && m.costUsed > m.costLimit) { await finishManagedTask({ ok: false, reason: "COST_LIMIT_EXCEEDED" }); return; }

  const tier = selectManagerTier();
  m.currentTier = tier;
  broadcastManagerState();

  if (tier >= 4) { await runTierFourAdjudication(); return; }

  logManagerEvent({ category: "decision", summary: `Asking the manager (tier ${tier}, turn ${m.turnNumber}/${m.maximumTurns})` });
  const res = await managerProvider.askManager(assembleTaskState(), { ...state.managerConfig, tier });
  // runManagerTurn() is always fire-and-forget from its callers (manager:stop,
  // manager:reject, etc. don't await it) so a slow provider call can still be
  // in flight when the user stops this task or starts a new one -- without
  // this check, that stale response would go on to mutate whatever task
  // state.manager now points to instead of quietly becoming irrelevant.
  if (state.manager.taskId !== myTaskId || ["finished", "error"].includes(state.manager.status)) return;

  if (!res.ok) {
    logManagerEvent({ category: "error", severity: "error", summary: `Manager call failed: ${res.error}`, details: { error: res.error, detail: res.detail || null } });
    m.noProgressStreak++;
    if (detectNoProgress()) await escalateManagerTier(`provider error: ${res.error}`);
    else await runManagerTurn();
    return;
  }

  const validated = validateManagerAction(res.decision);
  if (!validated.ok) {
    logManagerEvent({ category: "error", severity: "error", summary: `Manager proposed an invalid action: ${validated.error}`, details: { decision: res.decision, violations: validated.violations || null } });
    m.previousManagerActions.push({ ...res.decision, rejected: true, rejectReason: validated.error, ts: Date.now() });
    m.noProgressStreak++;
    if (detectNoProgress()) await escalateManagerTier(`invalid action repeated: ${validated.error}`);
    else await runManagerTurn();
    return;
  }

  const decision = validated.decision;
  m.previousManagerActions.push({ ...decision, ts: Date.now() });
  if (m.previousManagerActions.length > 50) m.previousManagerActions.shift();

  if (state.managerConfig.approvalMode && decision.action !== "REQUEST_APPROVAL") {
    m.pendingApproval = decision;
    m.status = "paused";
    logManagerEvent({ category: "approval", summary: `Awaiting approval: ${decision.action}`, action: decision.action, details: decision });
    broadcastManagerState();
    return;
  }
  await executeManagerAction(decision);
}

const MANAGER_DELEGATING_ACTIONS = new Set(["DELEGATE", "SEND", "FORWARD", "COMPARE", "CRITIQUE", "VERIFY"]);

async function executeManagerAction(decision) {
  const m = state.manager;
  const action = decision.action;
  const targets = decision.assignments ? decision.assignments.map((a) => a.target) : null;
  logManagerEvent({ category: "action", action, target: targets, summary: decision.reason || action, details: decision });

  if (MANAGER_DELEGATING_ACTIONS.has(action)) {
    m.status = (action === "COMPARE" || action === "CRITIQUE") ? "comparing" : (action === "VERIFY" ? "reviewing" : "delegating");
    m.activeAssignments = decision.assignments.map((a) => ({ target: a.target, task: a.task, sentTs: Date.now() }));
    m.pendingModels = decision.assignments.map((a) => a.target);
    for (const a of decision.assignments) {
      await sendTextTo(a.target, `[Manager assignment -- task "${m.taskId}"]\n${a.task}`, null);
    }
    m.status = "waiting"; // paused here until handleManagerCapture() sees every pending target reply
    broadcastManagerState();
    return;
  }

  switch (action) {
    case "CLASSIFY":
      if (decision.deliverableSpecification) m.deliverableSpecification = decision.deliverableSpecification;
      m.status = "classifying";
      await runManagerTurn();
      break;
    case "PLAN":
      if (Array.isArray(decision.plan)) m.plan = decision.plan;
      m.status = "planning";
      await runManagerTurn();
      break;
    case "EXTRACT":
    case "ASSEMBLE":
    case "REVISE":
      if (decision.result != null) m.deliverableSpecification = { ...m.deliverableSpecification, draft: decision.result };
      m.status = "assembling";
      await runManagerTurn();
      break;
    case "VALIDATE":
      m.status = "validating";
      if (Array.isArray(decision.missingRequirements)) m.missingRequirements = decision.missingRequirements;
      if (decision.satisfied === true) await finishManagedTask({ ok: true });
      else await runManagerTurn();
      break;
    case "SAVE":
    case "EXPORT":
      m.status = "saving";
      await saveManagerFile(decision.filename, decision.content);
      await runManagerTurn();
      break;
    case "ESCALATE":
      await escalateManagerTier(decision.reason || "manager-requested", decision.toTier);
      break;
    case "WAIT":
      setTimeout(() => runManagerTurn(), 2000); // a deliberate no-op turn -- try again shortly instead of spinning immediately
      break;
    case "REQUEST_APPROVAL":
      m.pendingApproval = decision;
      m.status = "paused";
      break;
    case "PAUSE":
      m.status = "paused";
      break;
    case "FINISH":
      await finishManagedTask({ ok: true });
      break;
    default:
      break; // unreachable -- validateManagerAction() already rejected anything else
  }
  broadcastManagerState();
}

async function handleManagerCapture(turn) {
  const m = state.manager;
  if (m.status !== "waiting" || !m.pendingModels.includes(turn.site)) return;
  const myTaskId = m.taskId;

  const responseEntry = { id: m.allResponses.length + 1, target: turn.site, text: turn.text, ts: turn.ts };
  m.allResponses.push(responseEntry);
  m.latestResponses[turn.site] = turn.text;
  const assignment = m.activeAssignments.find((a) => a.target === turn.site);
  if (assignment) {
    m.completedAssignments.push({ ...assignment, response: turn.text, ts: turn.ts });
    m.activeAssignments = m.activeAssignments.filter((a) => a.target !== turn.site);
  }
  m.pendingModels = m.pendingModels.filter((t) => t !== turn.site);
  await saveRawResponse(responseEntry);
  if (state.manager.taskId !== myTaskId || ["finished", "error"].includes(state.manager.status)) return; // this task was stopped/replaced while the save was in flight
  logManagerEvent({ category: "response", target: [turn.site], summary: `${SITES[turn.site].label} responded (${turn.text.length} chars)` });

  if (m.pendingModels.length === 0) {
    m.status = "reviewing";
    m.noProgressStreak = 0;
    if (m.currentTier > (state.managerConfig.tier || 2)) {
      m.currentTier -= 1; // de-escalate back toward the configured baseline now that things are progressing again
      logManagerEvent({ category: "escalation", summary: `De-escalating to tier ${m.currentTier} now that a response landed` });
    }
    await runManagerTurn();
  } else {
    broadcastManagerState();
  }
}

async function startManagedTask(userRequest) {
  const m0 = state.manager;
  if (m0 && !["idle", "finished", "error"].includes(m0.status)) return { ok: false, error: "ALREADY_RUNNING" };
  if (!state.managerConfig.endpoint || !state.managerConfig.model) return { ok: false, error: "NOT_CONFIGURED" };
  if (!userRequest || !String(userRequest).trim()) return { ok: false, error: "NEEDS_REQUEST" };

  resetManagerTask();
  const m = state.manager;
  m.taskId = `task-${Date.now()}`;
  m.userRequest = String(userRequest).trim();
  m.status = "classifying";
  m.startedTs = Date.now();
  m.projectDir = await createProjectDir(m.taskId, m.userRequest);

  logManagerEvent({ category: "task", summary: `Managed task started: "${m.userRequest.slice(0, 120)}"` });
  broadcastManagerState();
  runManagerTurn(); // fire-and-forget -- progresses asynchronously via capture events, same pattern as startSequence()
  return { ok: true, taskId: m.taskId };
}

async function finishManagedTask({ ok, reason }) {
  const m = state.manager;
  m.status = ok ? "finished" : "error";
  m.finishedTs = Date.now();
  await saveTaskCheckpoint();
  logManagerEvent({ category: "task", severity: ok ? "success" : "error", summary: ok ? "Task completed" : `Task ended: ${reason || "unknown"}`, details: { reason: reason || null } });
  broadcastManagerState();
}

function stopManagedTask() {
  const m = state.manager;
  if (m.status === "idle") return { ok: false, error: "NOT_RUNNING" };
  m.status = "finished";
  m.pendingModels = [];
  m.finishedTs = Date.now();
  logManagerEvent({ category: "task", summary: "Task stopped by user" });
  broadcastManagerState();
  return { ok: true };
}

function pauseManagedTask() {
  if (state.manager.status === "idle") return { ok: false, error: "NOT_RUNNING" };
  state.manager.status = "paused";
  logManagerEvent({ category: "task", summary: "Task paused" });
  broadcastManagerState();
  return { ok: true };
}

function resumeManagedTask() {
  const m = state.manager;
  if (m.status !== "paused") return { ok: false, error: "NOT_PAUSED" };
  m.status = m.pendingModels.length ? "waiting" : "reviewing";
  logManagerEvent({ category: "task", summary: "Task resumed" });
  broadcastManagerState();
  if (!m.pendingModels.length) runManagerTurn();
  return { ok: true };
}

async function approveManagerAction() {
  const m = state.manager;
  if (!m.pendingApproval) return { ok: false, error: "NOTHING_PENDING" };
  const decision = m.pendingApproval;
  m.pendingApproval = null;
  m.status = "reviewing";
  logManagerEvent({ category: "approval", summary: "Action approved", action: decision.action, details: decision });
  await executeManagerAction(decision);
  return { ok: true };
}

function rejectManagerAction(reason) {
  const m = state.manager;
  if (!m.pendingApproval) return { ok: false, error: "NOTHING_PENDING" };
  logManagerEvent({ category: "approval", summary: `Action rejected: ${reason || "no reason given"}`, action: m.pendingApproval.action, details: m.pendingApproval });
  m.pendingApproval = null;
  m.previousManagerActions.push({ action: "REJECTED_BY_USER", reason: reason || null, ts: Date.now() });
  m.status = "reviewing";
  broadcastManagerState();
  runManagerTurn();
  return { ok: true };
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
    default: return; // free-for-all rides entirely on the generic routing mesh below
  }
}

async function pollSite(site) {
  if (state.busy[site]) return;
  const view = siteViews[site];
  if (!view || view.webContents.isDestroyed()) return;
  state.busy[site] = true;
  try {
    const res = await view.webContents.executeJavaScript(buildReadScript(site, state.selectorOverrides[site]));
    const text = (res && res.text) || "";
    const pend = state.pending[site];

    if (!text) { state.pending[site] = { text: "", sinceTs: Date.now() }; return; }
    if (text !== pend.text) { state.pending[site] = { text, sinceTs: Date.now() }; return; }
    if (Date.now() - pend.sinceTs < STABLE_MS) return;

    const already = state.captured[site];
    if (already && already.text === text) return; // no new stable reply

    // A rate-limit/usage-cap message isn't a real contribution — feeding it
    // into routing/House Rules/Prompt Sequence/the manager loop would relay
    // "try again later" to the other AIs (or the manager) as if it were a
    // genuine reply, cascading garbage through the whole run. Catch it first
    // (ahead of the ignore/silentAck checks below), always — not just while
    // a House Rule is active, since plain Auto-routing and Prompt Sequence
    // are just as vulnerable to this. It's still captured and shown (marked
    // isRateLimited) so the user can see what actually happened, but nothing
    // downstream of this point runs for it. A House Rule additionally
    // auto-pauses itself, same as before; outside one, routing/mesh state is
    // left alone — there's nothing structured to pause.
    if (looksLikeRateLimit(text)) {
      const turn = { id: state.nextTurnId++, site, label: SITES[site].label, text, ts: Date.now(), pinned: false, isRateLimited: true };
      state.captured[site] = turn;
      pushTranscriptTurn(turn);
      broadcast("capture", turn);
      logEvent("rate-limit-detected", { site, chars: text.length, houseRuleActive: state.hr.active });
      if (state.waiting[site]) {
        state.waiting[site] = false;
        state.waitingSince[site] = null;
        broadcast("waiting-changed", { site, waiting: false });
      }
      if (state.hr.active) {
        state.hr.active = false;
        state.hr.pauseReason = "rate-limit";
        state.hr.pausedRouting = routingSnapshot();
        for (const s of SITE_IDS) state.routing[s].clear();
        state.meshActive = false;
        logEvent("houserule-paused", { mode: state.hr.mode, reason: "rate-limit" });
        broadcastHouseRule();
      }
      saveStateDebounced();
      return;
    }

    // Roundtable v2's [TO: X] tag routing is the program's permanent
    // baseline — it applies to every captured reply on every site, all the
    // time, EXCEPT while one of the 7 structured "stage" formats (Debate,
    // Chargeback, etc.) is actively driving replies instead. A stage
    // temporarily takes over; the moment it's stopped, tag-routing resumes
    // underneath automatically (there's no separate "start Roundtable"
    // event to re-trigger — it's just always there). The tag is literally
    // the first thing the AI typed, so it has to be parsed and stripped
    // BEFORE the turn is built below, since that's what gets pushed to the
    // transcript and broadcast live. [TO: NONE] means "nothing to add" and
    // is swallowed entirely, never reaching the transcript.
    const stageActive = state.hr.active && STAGE_MODES.has(state.hr.mode);
    let roundtableTag = null;
    let displayText = text;
    if (!stageActive) {
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
    pushTranscriptTurn(turn);
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
    if (stageActive) await handleHouseRuleCapture(turn);
    else await handleRoundtableCapture(turn);
    if (state.sequence.active) await handleSequenceCapture(turn);
    if (state.manager.status === "waiting") await handleManagerCapture(turn);
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
    res = await view.webContents.executeJavaScript(buildSendScript(site, text, state.selectorOverrides[site]), true);
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

ipcMain.handle("prompts:save", (_evt, { id, name, text }) => {
  const cleanText = {};
  for (const site of SITE_IDS) cleanText[site] = String((text && text[site]) || "").slice(0, 8000);
  const cleanName = String(name || "Untitled").slice(0, 120);
  const existing = id != null ? state.prompts.find((p) => p.id === id) : null;
  if (existing) {
    existing.name = cleanName;
    existing.text = cleanText;
  } else {
    state.prompts.push({ id: state.nextPromptId++, name: cleanName, text: cleanText });
  }
  logEvent("prompt-saved", { name: cleanName });
  saveStateDebounced();
  broadcast("prompts-changed", state.prompts);
  return { ok: true, prompts: state.prompts };
});

ipcMain.handle("prompts:delete", (_evt, id) => {
  state.prompts = state.prompts.filter((p) => p.id !== id);
  logEvent("prompt-deleted", { id });
  saveStateDebounced();
  broadcast("prompts-changed", state.prompts);
  return { ok: true, prompts: state.prompts };
});

// Opens (or re-targets, if already open) the standalone Prompt Library
// editor window — a separate BaseWindow, not a panel inline in the
// Automation window, so editing a prompt doesn't crowd out the AI panes.
ipcMain.handle("prompts:open-editor", (_evt, id) => {
  openPromptEditorWindow(id != null ? id : null);
  return { ok: true };
});

ipcMain.handle("prompt-editor:close", () => {
  closePromptEditorWindow();
  return { ok: true };
});

// Sends whatever's currently in each site's field — independent of whether
// it's been Saved to the library yet, so a one-off custom prompt per AI
// doesn't need to be saved first just to be sent. An empty/blank field for a
// site means "don't send to it," not "send an empty message."
ipcMain.handle("prompts:send", async (_evt, { text }) => {
  const targets = SITE_IDS.filter((s) => text && String(text[s] || "").trim());
  if (!targets.length) return { ok: false, error: "NEED_TEXT" };
  logEvent("prompt-send", { targets });
  const results = {};
  for (const s of targets) results[s] = await sendTextTo(s, String(text[s]).trim(), null);
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
  log: state.log,
  prompts: state.prompts,
  sequence: { active: state.sequence.active, index: state.sequence.index, total: state.sequence.steps.length },
  manager: managerSnapshot(),
  managerConfig: managerConfigSnapshot(),
  managerLog: state.managerLog
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

ipcMain.handle("document:choose", async () => {
  if (!win) return { ok: false, error: "NO_WINDOW" };
  const res = await dialog.showOpenDialog(win, { properties: ["openFile"] });
  if (res.canceled || !res.filePaths.length) return { ok: false, error: "CANCELLED" };
  const chosen = res.filePaths[0];
  openDocumentViewerWindow(chosen);
  logEvent("document-chosen", { path: chosen });
  return { ok: true, path: chosen };
});

ipcMain.handle("document-viewer:close", () => {
  closeDocumentViewerWindow();
  return { ok: true };
});

ipcMain.handle("document:read", async (_evt, filePath) => {
  if (!filePath || typeof filePath !== "string") return { ok: false, error: "NO_PATH" };
  let stat;
  try {
    stat = await fs.promises.stat(filePath);
  } catch (e) {
    return { ok: false, error: "FILE_NOT_FOUND", detail: String(e) };
  }
  const ext = path.extname(filePath).toLowerCase();
  const base = { ok: true, path: filePath, name: path.basename(filePath), size: stat.size, ext };

  if (ext === ".pdf") return { ...base, kind: "pdf", fileUrl: pathToFileURL(filePath).href };
  if (IMAGE_EXTS.has(ext)) return { ...base, kind: "image", fileUrl: pathToFileURL(filePath).href };
  if (TEXT_EXTS.has(ext)) {
    if (stat.size > TEXT_PREVIEW_SIZE_CAP) return { ...base, kind: "text", tooLarge: true, text: "" };
    try {
      const text = await fs.promises.readFile(filePath, "utf8");
      return { ...base, kind: "text", tooLarge: false, text };
    } catch (e) {
      return { ok: false, error: "READ_FAILED", detail: String(e) };
    }
  }
  return { ...base, kind: "other" };
});

ipcMain.handle("document:send", async (_evt, { path: filePath, targets }) => {
  if (!filePath) return { ok: false, error: "NO_PATH" };
  try {
    await fs.promises.access(filePath, fs.constants.R_OK);
  } catch (e) {
    return { ok: false, error: "FILE_NOT_FOUND", detail: String(e) };
  }
  const list = Array.isArray(targets) ? targets.filter((t) => SITES[t]) : [];
  if (!list.length) return { ok: false, error: "NO_TARGETS" };
  logEvent("document-send", { path: filePath, targets: list });
  const results = {};
  for (const t of list) results[t] = await attachFileToSite(t, filePath);
  return { ok: true, results };
});

ipcMain.handle("sequence:open", () => {
  openSequenceWindow();
  return { ok: true };
});

ipcMain.handle("sequence-editor:close", () => {
  closeSequenceWindow();
  return { ok: true };
});

ipcMain.handle("sequence:run", async (_evt, { steps }) => {
  if (state.sequence.active) return { ok: false, error: "ALREADY_RUNNING" };
  const clean = (Array.isArray(steps) ? steps : [])
    .map((s) => ({ target: s && s.target, text: String((s && s.text) || "").trim() }))
    .filter((s) => s.text && (s.target === "all" || SITES[s.target]));
  if (!clean.length) return { ok: false, error: "NO_VALID_STEPS" };
  logEvent("sequence-start", { steps: clean.length });
  await startSequence(clean);
  return { ok: true };
});

ipcMain.handle("sequence:stop", () => {
  state.sequence.active = false;
  logEvent("sequence-stop", {});
  broadcastSequenceState();
  return { ok: true };
});

ipcMain.handle("site:zoom", (_evt, { site, factor }) => {
  const view = siteViews[site];
  if (!view || view.webContents.isDestroyed()) return { ok: false, error: "NO_VIEW" };
  const clamped = Math.max(0.4, Math.min(2, Number(factor) || 1));
  view.webContents.setZoomFactor(clamped);
  logEvent("zoom-changed", { site, factor: clamped });
  return { ok: true, factor: clamped };
});

// The selector picker: instead of the user hand-typing a CSS selector (or
// needing DevTools at all), they pick a role here, then click the real
// element live in that site's pane -- buildPickScript() captures that next
// click, works out a selector for it, and we save it as an override tried
// ahead of selectors.js's built-in candidates (see automation.js). No
// separate "test" step: the picked element's own sample text (for
// "assistant") or tag/attributes (for input/send) is the confirmation.
const VALID_PICK_ROLES = new Set(["input", "send", "assistant"]);

ipcMain.handle("selector:pick", async (_evt, { site, role }) => {
  if (!SITES[site]) return { ok: false, error: "BAD_SITE" };
  if (!VALID_PICK_ROLES.has(role)) return { ok: false, error: "BAD_ROLE" };
  const view = siteViews[site];
  if (!view || view.webContents.isDestroyed()) return { ok: false, error: "NO_VIEW" };
  logEvent("selector-pick-started", { site, role });
  let res;
  try {
    res = await view.webContents.executeJavaScript(buildPickScript(role), true);
  } catch (e) {
    res = { ok: false, error: String(e) };
  }
  if (res && res.ok && res.selector) {
    // Post-pick validation, before anything gets saved: the click alone
    // proves the user clicked SOMETHING, not that it's a good override.
    // Checked against the live page (matchCount/visible/roleOk are computed
    // by buildPickScript at click-time, see automation.js) plus, for the
    // "assistant" role, against the shared echo-detector so a selector that
    // just reads back the composer/last-sent message doesn't get saved as
    // if it were a real reply-reading override.
    const problems = [];
    if (typeof res.matchCount === "number" && res.matchCount < 1) problems.push("NOT_FOUND");
    if (res.visible === false) problems.push("NOT_VISIBLE");
    if (res.roleOk === false) problems.push("WRONG_ELEMENT_TYPE");
    if (role === "assistant" && looksLikeEcho(res.sample, state.lastSentTo[site])) problems.push("LOOKS_LIKE_ECHO");
    if (problems.length) {
      logEvent("selector-pick-rejected", { site, role, selector: res.selector, reasons: problems, sample: res.sample || null });
      return { ok: false, error: problems[0], reasons: problems };
    }
    state.selectorOverrides[site] = { ...state.selectorOverrides[site], [role]: res.selector };
    saveStateDebounced();
    logEvent("selector-picked", { site, role, selector: res.selector, tag: res.tag || null, sample: res.sample || null });
  } else {
    logEvent("selector-pick-error", { site, role, error: (res && res.error) || "unknown" });
  }
  return res || { ok: false, error: "unknown" };
});

ipcMain.handle("selector:clear", (_evt, { site, role }) => {
  if (!SITES[site]) return { ok: false, error: "BAD_SITE" };
  if (!VALID_PICK_ROLES.has(role)) return { ok: false, error: "BAD_ROLE" };
  const next = { ...state.selectorOverrides[site] };
  delete next[role];
  state.selectorOverrides[site] = next;
  saveStateDebounced();
  logEvent("selector-override-cleared", { site, role });
  return { ok: true };
});

ipcMain.handle("selftest:run", async (_evt, { site }) => {
  if (!SITES[site]) return { ok: false, error: "BAD_SITE" };
  if (selftestInFlight.has(site)) return { ok: false, error: "ALREADY_RUNNING" };
  selftestInFlight.add(site);
  try {
    const token = makeSelftestToken();
    const reversedToken = token.split("").reverse().join("");
    logEvent("selftest-started", { site, token, reversedToken });
    const prompt = `[AutoInjector connectivity test -- not a real task, no need to elaborate] Reverse the letters of this token and reply with ONLY the reversed result, nothing else -- no punctuation, no explanation: ${token}`;
    const sentTs = Date.now();
    const sendRes = await sendTextTo(site, prompt, null);
    if (!sendRes || !sendRes.ok) {
      logEvent("selftest-send-error", { site, token, error: (sendRes && sendRes.error) || "unknown" });
      return { ok: false, stage: "send", error: (sendRes && sendRes.error) || "unknown" };
    }
    logEvent("selftest-waiting-for-reply", { site, token, timeoutMs: SELFTEST_TIMEOUT_MS });
    const waitRes = await waitForTestReply(site, token, reversedToken, sentTs, SELFTEST_TIMEOUT_MS);
    logEvent(waitRes.ok ? "selftest-ok" : "selftest-error", { site, token, error: waitRes.error || null, capturedText: waitRes.text || null });
    return { ok: waitRes.ok, stage: "reply", error: waitRes.error, text: waitRes.text };
  } finally {
    selftestInFlight.delete(site);
  }
});

ipcMain.handle("manager:start-task", async (_evt, { userRequest }) => startManagedTask(userRequest));
ipcMain.handle("manager:pause", () => pauseManagedTask());
ipcMain.handle("manager:resume", () => resumeManagedTask());
ipcMain.handle("manager:stop", () => stopManagedTask());
ipcMain.handle("manager:approve", async () => approveManagerAction());
ipcMain.handle("manager:reject", (_evt, { reason } = {}) => rejectManagerAction(reason));

ipcMain.handle("manager:configure-provider", (_evt, config) => {
  if (!config || typeof config !== "object") return { ok: false, error: "BAD_CONFIG" };
  const allowedProviders = new Set(["runpod-serverless", "runpod-pod", "openai-compatible"]);
  if (config.provider && !allowedProviders.has(config.provider)) return { ok: false, error: "BAD_PROVIDER" };
  if (config.tier != null && (!Number.isInteger(config.tier) || config.tier < 1 || config.tier > 4)) return { ok: false, error: "BAD_TIER" };
  // Only overwrite fields actually present in the payload -- lets the config UI
  // save "just changed the model" without needing to resend the API key.
  const next = { ...state.managerConfig };
  for (const key of ["provider", "endpoint", "apiKey", "model", "tier", "timeoutMs", "podId", "approvalMode", "maximumTurns", "costLimit", "adjudicatorSite"]) {
    if (config[key] !== undefined) next[key] = config[key];
  }
  state.managerConfig = next;
  saveStateDebounced();
  logManagerEvent({ category: "config", summary: "Manager provider configuration updated", details: { provider: next.provider, model: next.model, tier: next.tier }, visibleInManagerLog: true, visibleInGlobalLog: true });
  return { ok: true, config: managerConfigSnapshot() };
});

ipcMain.handle("manager:test-connection", async () => {
  if (!state.managerConfig.endpoint || !state.managerConfig.model) return { ok: false, error: "NOT_CONFIGURED" };
  const res = await managerProvider.testConnection(state.managerConfig);
  logManagerEvent({ category: "config", severity: res.ok ? "success" : "error", summary: res.ok ? "Provider connection test passed" : `Provider connection test failed: ${res.error}` });
  return res;
});

ipcMain.handle("manager:get-state", () => ({ ok: true, manager: managerSnapshot(), managerConfig: managerConfigSnapshot(), managerLog: state.managerLog }));

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
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("activate", () => { if (!win) createWindow(); });
