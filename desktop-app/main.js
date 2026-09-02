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
const { app, BaseWindow, WebContentsView, ipcMain, dialog, safeStorage, Menu, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const { pathToFileURL } = require("url");
const SITES = require("./selectors");
const { buildSendScript, buildReadScript, buildFileInputFinderExpression, buildPickScript, buildLoginFillScript } = require("./automation");
const managerProvider = require("./manager-provider");
const dbService = require("./db-service");
const ollamaManager = require("./ollama-manager");
const outputManager = require("./output-manager");
const secretStore = require("./secret-store");
const { createServiceBridge } = require("./service-bridge");
const interpreterProvider = require("./interpreter-provider");
const toolProvider = require("./tool-provider");
const voiceProvider = require("./voice-provider");
const imageProvider = require("./image-provider");
// AI-001: the manager API key is persisted only as sealed ciphertext. seal
// replaces apiKey with apiKeyEnc for the state snapshot; open reverses it on
// restore and migrates any legacy plaintext key.
function sealManagerConfig(cfg) {
  const out = { ...(cfg || {}) };
  const enc = secretStore.seal(out.apiKey);
  delete out.apiKey;
  if (enc) out.apiKeyEnc = enc; else delete out.apiKeyEnc;
  return out;
}
function openManagerConfig(cfg) {
  const out = { ...(cfg || {}) };
  if (out.apiKeyEnc) { out.apiKey = secretStore.open(out.apiKeyEnc); delete out.apiKeyEnc; }
  else if (!("apiKey" in out)) out.apiKey = "";
  return out;
}
const { MANAGER_ACTIONS } = managerProvider;

const SITE_IDS = Object.keys(SITES);
const ROTATION_ORDER = ["chatgpt", "claude", "gemini"]; // fixed, per spec — not shuffled like the other modes
// Timing is env-overridable so the integration harness can run the exact same
// logic on a fast, internally-consistent clock (QA-001) — production defaults
// are unchanged.
const POLL_MS = Number(process.env.AUTOINJECTOR_POLL_MS) || 1500;
const STABLE_MS = Number(process.env.AUTOINJECTOR_STABLE_MS) || 1800;
// End-tag protocol (v2 completion signal). On the always-on baseline path a
// reply is COMPLETE the moment it carries a well-formed [FROM: X] closing tag —
// we no longer wait for the text to merely stop changing. STABLE_MS is kept ONLY
// for the 7 structured house-rules stage formats, which drive their own turn-
// taking and don't use the envelope. NOTAG_QUIET_MS is the missing-tag watchdog:
// if a baseline pane goes quiet this long WITHOUT a closing tag, the message is
// treated as lost and the messaging protocol is re-sent asking for a full resend.
// It's deliberately longer than STABLE_MS so a mid-reply pause never trips it.
const NOTAG_QUIET_MS = Number(process.env.AUTOINJECTOR_NOTAG_QUIET_MS) || 12000;
const MAX_NOTAG_REPROMPTS = Number(process.env.AUTOINJECTOR_MAX_NOTAG_REPROMPTS) || 2;
const MAX_LOG = 300;
const MAX_TRANSCRIPT = 1000; // oldest-first eviction, same idea as MAX_LOG for the debug log -- a long-running relay must not grow this without bound
const MAX_LEDGER = 1000; // oldest-first eviction, same idea as MAX_TRANSCRIPT
const DUPLICATE_WINDOW_MS = 5000; // a second identical (target, text) send within this window gets flagged duplicate:true in the ledger
const PANE_SYNC_MS = 700;
// The 7 structured formats that temporarily take over from the always-on
// Roundtable v2 [TO: X] tag routing (see pollSite()) — "roundtable" itself
// is no longer a House Rules mode you start/stop, it's just how the program
// behaves by default whenever none of these 7 are active.
const HOUSE_RULES = ["who-wants-to-speak", "debate", "free-for-all", "devil-angel", "chargeback", "brainstorm", "rotation", "blind-round"];
const STAGE_MODES = new Set(HOUSE_RULES);
const NEEDS_EXACTLY_THREE = new Set(["devil-angel", "chargeback", "rotation", "blind-round"]);
const COLLAPSED_HEIGHT = 44; // px — how tall a top-level window is once collapsed to just its titlebar
const MAX_DEBUG_LOG_LINES = 2000;
const SAVE_DEBOUNCE_MS = Number(process.env.AUTOINJECTOR_SAVE_DEBOUNCE_MS) || 500;
const FILE_ATTACH_PROTOCOL_VERSION = "1.3";
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const TEXT_EXTS = new Set([".txt", ".md", ".csv", ".json"]);
const TEXT_PREVIEW_SIZE_CAP = 500 * 1024; // 500KB
const SEND_RETRY_ATTEMPTS = 3; // real-world evidence: a cold/still-settling pane's very first send often fails confirmation, then succeeds immediately on retry -- this catches that automatically instead of surfacing a false failure
const SEND_RETRY_BACKOFF_MS = Number(process.env.AUTOINJECTOR_RETRY_BACKOFF_MS) || 1500;
const SELFTEST_TIMEOUT_MS = Number(process.env.AUTOINJECTOR_SELFTEST_TIMEOUT_MS) || 45000;
const SELFTEST_POLL_MS = Number(process.env.AUTOINJECTOR_SELFTEST_POLL_MS) || 500;

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
  pending: {}, // site -> { text, sinceTs, reprompted } — used to detect a stopped reply / a quiet pane with no end tag
  noTagReprompts: {}, // site -> count of consecutive "you forgot the [FROM:] tag, resend" nudges (reset when a valid tagged reply lands)
  busy: {}, // site -> bool — poll in flight, skip overlapping polls
  waiting: {}, // site -> bool — a message was just sent, waiting on a fresh reply (drives the idle/generating dot)
  generating: {}, // site -> bool — the pane is actively producing a reply (its Stop button is showing / Send disabled), from pollSite's read

  waitingSince: {}, // site -> timestamp | null — when waiting flipped true, so UIs can flag "hasn't replied in a while"
  lastSentTo: {}, // site -> exact final text last sent to it (for Regenerate)
  enabled: {}, // site -> bool — participant is "in play": counts for Auto/"All" AND shows its pane
  customRole: {}, // site -> user-assigned persona string ("", i.e. falsy, means general-purpose)
  transcript: [], // { id, site, label, text, ts, pinned, isVerdict?, isFinalPlan? } — every VISIBLE captured reply
  log: [], // { ts, kind, detail } — internal activity, for the troubleshooting panel
  ledger: [], // { id, ts, source, target, textPreview, status, error, duplicate } — one entry per sendTextTo() attempt; see recordLedgerEntry(). Program-owned transport record, independent of what any AI believes happened -- never trust an AI's own claim about whether a message arrived.
  meshActive: false, // whether global Auto is currently on
  nextTurnId: 1,
  nextMsgSeq: 1, // program-kept running message number stamped on every outgoing send ([MSG #0001], 4-digit) so the AIs can tell which message they're answering

  nextLedgerId: 1,
  hr: null, // House Rules run state, see resetHouseRule()
  prompts: [], // { id, name, text: { chatgpt, claude, gemini } } — saved, reusable, one-click-send prompts. An empty text field for a site means "don't send to it."
  nextPromptId: 1,
  sequence: { active: false, steps: [], index: 0, generation: 0, dispatchGen: {} }, // Prompt Sequence run state, see startSequence()/handleSequenceCapture()
  selectorOverrides: {}, // site -> { input?, send?, assistant? } — user-picked CSS selectors (see selector:pick), tried before the built-in candidates in selectors.js
  savedLogins: {}, // site -> [{ id, label, username, encryptedPassword }] — encryptedPassword is a safeStorage-encrypted (OS keychain) ciphertext, base64-encoded; the plaintext password is never stored, never sent to the renderer, never logged. See logins:save/logins:fill.
  nextLoginId: 1,
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
  imageConfig: null, // Stable Diffusion settings mirror (imageProvider owns the live copy); persisted so the endpoint survives a restart
  manager: null, // set by resetManagerTask() below — always idle on startup, a restart must never auto-resume a live task
  managerLog: [] // manager-only event stream (mirrors state.log's shape but filtered to source:"manager"), see logManagerEvent()
};
for (const site of SITE_IDS) {
  state.routing[site] = new Set();
  state.captured[site] = null;
  state.pending[site] = { text: "", sinceTs: Date.now(), reprompted: false };
  state.noTagReprompts[site] = 0;
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
    text[site] = `This is a diagnostic test of the AutoInjector automation system, not a real task. Please: (1) reply here to confirm this message reached you, (2) briefly confirm what you understand your role to be right now, and (3) if messages from ${otherLabels(SITE_IDS, site)} show up afterward, say so — that confirms routing between the three of us is actually working end-to-end. Message format: BEGIN your reply with [TO: USER] and END it with [FROM: ${site.toUpperCase()}] — that closing tag is how this app knows your message is finished; without it the message is discarded and you'll be asked to resend. Keep your reply short.`;
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
    text[site] = `Quick reference, not a task — no need to reply unless you want to. This app relays messages between the three of us (ChatGPT, Claude, Gemini); we're not talking to each other directly, everything is routed on this end. Wrap EVERY message in a two-tag envelope. START with a tag on its own line — [TO: CHATGPT], [TO: CLAUDE], [TO: GEMINI], [TO: ALL], [TO: USER], or [TO: NONE] — to control who sees it next: a specific one of us, everyone, just the human running this, or nobody if you have nothing to add. END with your own closing tag in the same bracket form: [FROM: ${site.toUpperCase()}]. The [FROM: ...] tag is how this end knows your message is finished — until it's there, nothing you wrote is delivered; if you stop without it the message is discarded and you'll be asked to resend the whole thing. Put nothing after the closing tag. The one exception: if you have nothing to add, just reply NONE (or [TO: NONE]) — that's a complete message on its own, it needs no [FROM:] tag, and it's dropped silently. This applies all the time, not just for a specific "mode." Also: the app stamps every message it hands you with a running number at the very top, like [MSG #0007] — you don't generate these, but you can refer to that number to say which message you're answering so nobody falls out of sync.`;
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
    codeRuns: [], // { id, task, ok, message, error, ts } — RUN_CODE results (Open Interpreter), so the manager can build on them
    toolCalls: [], // { id, tool, ok, message, error, ts } — USE_TOOL results (tool registry / future MCP), so the manager can build on them
    memories: [], // { id, type, title, ts } — RECALL results + auto-seeded relevant facts from the shared memory store
    images: [], // { id, prompt, path, ok, error, ts } — GENERATE_IMAGE results (Stable Diffusion), saved + recorded as project images
    capabilities: {}, // capability-awareness table: "<target>:<action>" -> { ok, fail, lastTs } learned from executor outcomes
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

  if (decision.action === "RUN_CODE") {
    if (typeof decision.task !== "string" || !decision.task.trim()) return { ok: false, error: "MISSING_TASK" };
  }

  if (decision.action === "USE_TOOL") {
    if (typeof decision.tool !== "string" || !decision.tool.trim()) return { ok: false, error: "MISSING_TOOL" };
    if (!toolProvider.has(decision.tool)) return { ok: false, error: "UNKNOWN_TOOL", detail: decision.tool };
    if (decision.args != null && (typeof decision.args !== "object" || Array.isArray(decision.args))) return { ok: false, error: "BAD_ARGS" };
  }

  if (decision.action === "REMEMBER") {
    const fact = decision.fact != null ? decision.fact : decision.value;
    if (typeof fact !== "string" || !fact.trim()) return { ok: false, error: "MISSING_FACT" };
  }

  if (decision.action === "RECALL") {
    if (typeof decision.query !== "string" || !decision.query.trim()) return { ok: false, error: "MISSING_QUERY" };
  }

  if (decision.action === "GENERATE_IMAGE") {
    if (typeof decision.prompt !== "string" || !decision.prompt.trim()) return { ok: false, error: "MISSING_PROMPT" };
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

// The message delivery ledger: the program's own record of what was
// actually sent where, independent of what any AI's own reasoning
// concludes about it. Recorded from ONE place -- inside sendTextTo() itself
// -- so every send path in the app (compose, forward, roundtable relay,
// House Rules dispatch, Prompt Sequence, manager delegation) is covered
// automatically, with no per-call-site bookkeeping to keep in sync.
// "status" reflects only what browser automation can actually observe (the
// send-script's own confirmation that the input cleared) -- it is NOT proof
// the target model read or processed the message, only that our side of
// the send genuinely went out. duplicate:true means the same (target, text)
// pair was already sent within DUPLICATE_WINDOW_MS -- surfaced for
// visibility, never auto-suppressed, since a legitimate retry can look
// identical to an accidental double-send.
function recordLedgerEntry({ source, target, text, ok, error, attempts, seq }) {
  const recentDuplicate = state.ledger.some(
    (e) => e.target === target && e.textPreview === text.slice(0, 200) && Date.now() - e.ts < DUPLICATE_WINDOW_MS
  );
  const entry = {
    id: `MSG-${state.nextLedgerId++}`,
    ts: Date.now(),
    source: source || null,
    target,
    seq: seq || null, // the [MSG #NNNN] number stamped on the actual send (kept out of textPreview)
    textPreview: text.slice(0, 200),
    status: ok ? "delivered" : "failed",
    error: ok ? null : error || "unknown",
    attempts: attempts || 1, // >1 means it self-recovered after a retry, not a clean first try
    duplicate: recentDuplicate
  };
  state.ledger.push(entry);
  if (state.ledger.length > MAX_LEDGER) state.ledger.splice(0, state.ledger.length - MAX_LEDGER);
  broadcast("ledger-entry", entry);
  return entry;
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
        savedLogins: state.savedLogins, // safe to persist as-is -- every password in here is already safeStorage ciphertext, not plaintext
        managerConfig: sealManagerConfig(state.managerConfig), // AI-001: the API key is sealed (apiKeyEnc), never written plaintext
        imageConfig: state.imageConfig || imageProvider.getSettings(), // Stable Diffusion endpoint/size — no secret, stored as-is
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
  if (snap.savedLogins && typeof snap.savedLogins === "object") {
    let maxId = 0;
    for (const site of SITE_IDS) {
      if (Array.isArray(snap.savedLogins[site])) {
        state.savedLogins[site] = snap.savedLogins[site];
        for (const l of snap.savedLogins[site]) maxId = Math.max(maxId, l.id || 0);
      }
    }
    state.nextLoginId = maxId + 1;
  }
  if (snap.imageConfig && typeof snap.imageConfig === "object") {
    imageProvider.setSettings(snap.imageConfig);
    state.imageConfig = imageProvider.getSettings();
  }
  if (snap.managerConfig && typeof snap.managerConfig === "object") {
    state.managerConfig = { ...state.managerConfig, ...openManagerConfig(snap.managerConfig) };
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

// Extra broadcast sinks beyond the UI windows. The local service bridge
// (service-bridge.js) registers a listener here so an external caller can stream
// the same live events (captures, generation state, sends, errors, rate limits,
// Council state) the UI sees, without the bridge reaching into internals.
const broadcastListeners = new Set();
function broadcast(channel, payload) {
  for (const view of uiViews) {
    if (view && !view.webContents.isDestroyed()) view.webContents.send(channel, payload);
  }
  for (const fn of broadcastListeners) { try { fn(channel, payload); } catch (_) {} }
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
    // When an AI produces a file you download from its pane, grab it into the
    // output folder under that AI's name (output/ai-work/<site>/) instead of
    // popping a save dialog — a tidy local record of each AI's work.
    try {
      view.webContents.session.on("will-download", (_event, item) => {
        try {
          const dest = outputManager.uniquePath(outputManager.aiWorkDir(site), item.getFilename());
          item.setSavePath(dest);
          item.once("done", (_e, stateStr) => logEvent("ai-download", { site, state: stateStr, file: dest }));
        } catch (e) { logEvent("ai-download-error", { site, error: String(e) }); }
      });
    } catch (_) {}
    // Fires once this site's page has actually finished loading (not on a
    // fixed delay, which would race against a slow connection) — sending
    // any earlier would hit a chat UI whose input box doesn't exist yet.
    // Only ever fires once per app launch, not on a later manual 🔍/⟳ reload.
    view.webContents.once("did-finish-load", () => sendStartupRoutingPromptOnce(site));
  }

  layout();
  win.on("resize", () => { layout(); syncPaneBounds(); });
  win.on("closed", () => { win = null; });

  setInterval(() => { for (const site of SITE_IDS) pollSite(site); sequenceWatchdog(); managerWatchdog(); }, POLL_MS);
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

// --- Setup Wizard window ----------------------------------------------------
let wizardWin = null;
let wizardView = null;
const WIZARD_TABS = new Set(["localai", "images", "video", "advanced"]);
function openWizardWindow(tab) {
  const wantTab = WIZARD_TABS.has(tab) ? tab : null;
  if (wizardWin && wizardView) {
    wizardWin.focus();
    // Already open — just switch to the requested tab in place.
    if (wantTab) try { wizardView.webContents.executeJavaScript(`document.querySelector('.tab[data-tab="${wantTab}"]')?.click();`).catch(() => {}); } catch (_) {}
    return;
  }
  wizardWin = new BaseWindow({ width: 900, height: 700, resizable: true, title: "AutoInjector — Setup Wizard" });
  wizardView = new WebContentsView({
    webPreferences: {
      partition: "setup-wizard-ui",
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  wizardWin.contentView.addChildView(wizardView);
  wizardView.webContents.loadFile(path.join(__dirname, "setup-wizard.html"), wantTab ? { query: { tab: wantTab } } : undefined);
  const layoutWizard = () => {
    if (!wizardWin || !wizardView) return;
    const [w, h] = wizardWin.getContentSize();
    wizardView.setBounds({ x: 0, y: 0, width: w, height: h });
  };
  layoutWizard();
  wizardWin.on("resize", layoutWizard);
  wizardWin.on("closed", () => { wizardWin = null; wizardView = null; });
}
function closeWizardWindow() { if (wizardWin) wizardWin.close(); }

// --- Consolidated AI feed window --------------------------------------------
// A separate pop-up that shows every AI reply as a colour-coded bubble per LLM.
// It registers its view in uiViews so the normal broadcast() (capture / sent /
// manager events) fans out to it live; on close we splice it back out.
let feedWin = null;
let feedView = null;
function openFeedWindow() {
  if (feedWin && feedView) { feedWin.focus(); return; }
  feedWin = new BaseWindow({ width: 560, height: 760, resizable: true, title: "AutoInjector — AI Conversation" });
  feedView = new WebContentsView({
    webPreferences: {
      partition: "feed-ui",
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  feedWin.contentView.addChildView(feedView);
  feedView.webContents.loadFile(path.join(__dirname, "feed.html"));
  const layoutFeed = () => {
    if (!feedWin || !feedView) return;
    const [w, h] = feedWin.getContentSize();
    feedView.setBounds({ x: 0, y: 0, width: w, height: h });
  };
  layoutFeed();
  feedWin.on("resize", layoutFeed);
  uiViews.push(feedView); // so broadcast() reaches the feed too
  feedWin.on("closed", () => {
    const i = uiViews.indexOf(feedView);
    if (i >= 0) uiViews.splice(i, 1);
    feedWin = null; feedView = null;
  });
}
function closeFeedWindow() { if (feedWin) feedWin.close(); }

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
    codeRuns: m.codeRuns,
    toolCalls: m.toolCalls,
    memories: m.memories,
    images: m.images,
    capabilities: m.capabilities,
    awareness: managerAwareness(),
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

// N4 Awareness: a compact, always-current picture of the panes and orchestrator,
// composed from signals the app already tracks (bridgeStatus + house-rule state)
// plus the learned capability table. No new sensing -- pure aggregation. The
// butler sees this every turn (via buildManagerPrompt) so it stops delegating to
// a pane that is busy, rate-limited, or known-incapable of an action.
function managerAwareness() {
  const m = state.manager;
  const panes = {};
  try {
    for (const site of SITE_IDS) {
      const enabled = !!state.enabled[site];
      const ready = paneReady(site);
      const busy = !!state.generating[site];
      const waiting = !!state.waiting[site];
      const rateLimited = !!(state.captured[site] && state.captured[site].isRateLimited);
      panes[site] = {
        enabled, ready, busy, waiting, rateLimited,
        // A pane is a good delegate target only if enabled, ready, and not busy/limited.
        available: enabled && ready && !busy && !rateLimited
      };
    }
  } catch { /* best effort -- awareness must never throw into the loop */ }
  return {
    panes,
    council: state.hr && state.hr.active ? { mode: state.hr.mode, paused: !!state.hr.paused } : null,
    capabilities: m.capabilities || {}
  };
}

// Records the outcome of an action against a target/tool so a repeatedly-failing
// route can be avoided. Keyed "<target>:<action>"; awareness surfaces it.
function recordCapabilityOutcome(target, action, ok) {
  if (!target || !action) return;
  const m = state.manager;
  const key = `${String(target).toLowerCase()}:${String(action).toUpperCase()}`;
  const c = m.capabilities[key] || { ok: 0, fail: 0, lastTs: 0 };
  if (ok) c.ok += 1; else c.fail += 1;
  c.lastTs = Date.now();
  m.capabilities[key] = c;
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
    phase: hr.phase,
    pendingReplies: hr.realPending ? [...hr.realPending] : []
  };
}

function broadcastHouseRule() {
  broadcast("houserule-state", houseRuleSnapshot());
}

// pollSite() runs all three sites' poll cycles concurrently (one setInterval
// tick fires pollSite() for chatgpt/claude/gemini back to back, none of them
// awaited against each other) -- so with full mesh routing on, it's entirely
// normal for two DIFFERENT sites to each capture a reply in the same cycle
// and both route to the same third target. Without something serializing
// that, two sendTextTo() calls for the same target would run their
// executeJavaScript "type + click send" scripts against that pane's SAME
// input box at the same time, stomping on each other's typing and making
// the send-confirmation check (which just checks "is the input empty now")
// unreliable -- this was the actual cause of a ~50% SEND_NOT_CONFIRMED rate
// under mesh routing, confirmed from a real Activity Log where errors
// clustered on the same target from two different senders within the same
// second. sendQueues[target] is a promise chain: each call for a given
// target is appended after whatever's already queued for it, so only one
// send script ever runs against a given pane at a time -- concurrent
// callers simply wait their turn instead of colliding.
// sendQueues[target] only exists while a send is actually in flight/queued
// for that target -- the common case (nothing else currently sending to it)
// calls fn() directly and synchronously, identical to the pre-queue code
// path, so this adds zero extra latency/microtask overhead when there's no
// real contention. Only a genuinely concurrent second call for the same
// target pays for serialization, by chaining after the first's promise.
const sendQueues = {};
function withSendQueue(target, fn) {
  const prior = sendQueues[target];
  const run = prior ? prior.then(fn, fn) : fn();
  const tail = Promise.resolve(run).then(() => {}, () => {}); // never let one failed send jam the queue for the next
  sendQueues[target] = tail;
  tail.then(() => { if (sendQueues[target] === tail) delete sendQueues[target]; }); // idle again once nothing newer is queued behind it
  return run;
}

async function sendTextTo(target, text, fromSite, opts = {}) {
  const view = siteViews[target];
  if (!view || view.webContents.isDestroyed()) {
    recordLedgerEntry({ source: fromSite || null, target, text, ok: false, error: "NO_VIEW" });
    broadcast("send-error", { target, error: "NO_VIEW" });
    logEvent("send-error", { target, error: "NO_VIEW" });
    return { ok: false, error: "NO_VIEW" };
  }
  const label = fromSite ? SITES[fromSite]?.label : null;
  const roleClause = state.customRole[target] ? `(You're playing the role of: ${state.customRole[target]}. Keep that in mind in your reply.)\n\n` : "";
  // Addressing-aware frame: a tag-routed relay tells the receiver whether it was
  // addressed directly ([label → you]) or in a broadcast ([label → everyone]),
  // restoring the routing awareness the stripped [TO:] tag would otherwise carry.
  // A plain mesh/auto forward stays neutral ("[label says]").
  const frameVerb = opts.addressing === "you" ? "→ you" : opts.addressing === "everyone" ? "→ everyone" : "says";
  // opts.raw skips role-clause/label framing entirely and sends `text`
  // verbatim -- for callers (Regenerate) whose text is already the exact,
  // fully-framed string that was actually sent last time, so re-framing it
  // here would double it up.
  const framed = opts.raw ? text : roleClause + (label ? `[${label} ${frameVerb}]\n\n${text}` : text);
  // Program-kept running message number, stamped on EVERY outgoing send as a
  // 4-digit [MSG #0001] header (the AIs don't count anything — the app does). It
  // gives each message a single continuous id across all three panes so a model
  // can tell which message it's answering and not fall behind. Deliberately NOT
  // part of state.lastSentTo (below): Regenerate re-sends the stored body and
  // must get a FRESH number here, never a doubled-up stale one.
  const seq = String(state.nextMsgSeq++).padStart(4, "0");
  const prompt = `[MSG #${seq}]\n${framed}`;

  // A failed send gets up to SEND_RETRY_ATTEMPTS total tries, with a short
  // pause between each, before it's ever reported as a failure -- a real
  // Tuner run against the live sites showed exactly this pattern: a pane's
  // very first send after loading fails confirmation, then the identical
  // send succeeds immediately on the next try. Self-recovering that
  // automatically (attempts > 1 in the log/ledger, not silently hidden)
  // fixes the actual problem instead of just reporting it more accurately.
  // The ENTIRE attempt+backoff sequence runs inside one withSendQueue() call
  // (not one call per attempt) -- otherwise the queue slot for this target
  // was released during each backoff sleep, letting a concurrent send for
  // the same target (e.g. a mesh forward) jump ahead of a message that's
  // still retrying and land out of order.
  let attempts = 0;
  const res = await withSendQueue(target, async () => {
    let r;
    for (let attempt = 1; attempt <= SEND_RETRY_ATTEMPTS; attempt++) {
      attempts = attempt;
      try {
        r = await view.webContents.executeJavaScript(buildSendScript(target, prompt, state.selectorOverrides[target]), true);
      } catch (e) {
        r = { ok: false, error: String(e) };
      }
      if (r && r.ok) break;
      if (attempt < SEND_RETRY_ATTEMPTS) {
        logEvent("send-retry", { target, from: fromSite || null, attempt, nextAttempt: attempt + 1, error: (r && r.error) || "unknown" });
        await new Promise((resolve) => setTimeout(resolve, SEND_RETRY_BACKOFF_MS));
      }
    }
    return r;
  });

  // Record the seq-INDEPENDENT body (framed) as the ledger text, with seq as its
  // own field: duplicate detection compares message content, so the per-send
  // [MSG #] header must not make every send look unique.
  recordLedgerEntry({ source: fromSite || null, target, text: framed, ok: res && res.ok, error: res && res.error, attempts, seq });
  if (!res || !res.ok) {
    broadcast("send-error", { target, error: res?.error || "unknown" });
    logEvent("send-error", { target, from: fromSite || null, error: res?.error || "unknown", attempts });
    // opts.hr marks a send made on behalf of an active House Rule turn --
    // exhausting every retry used to leave the run silently `active`
    // forever, waiting on a reply that can now never arrive. Park it the
    // same defined way a rate-limited reply already does (pauseReason,
    // a restorable routing snapshot), rather than a distinct ambient check
    // against state.hr.active, since a send failure completely unrelated to
    // any House Rule (e.g. a plain Compose to an idle site) must never pause
    // a run that's healthy on other sites.
    if (opts.hr && state.hr.active) {
      state.hr.active = false;
      state.hr.pauseReason = "send-failed";
      state.hr.pausedRouting = routingSnapshot();
      for (const s of SITE_IDS) state.routing[s].clear();
      state.meshActive = false;
      logEvent("houserule-paused", { mode: state.hr.mode, reason: "send-failed", target, error: res?.error || "unknown" });
      broadcastHouseRule();
      saveStateDebounced();
    }
  } else {
    state.lastSentTo[target] = framed; // stored WITHOUT the [MSG #] header so Regenerate re-stamps a fresh number
    state.waiting[target] = true;
    state.waitingSince[target] = Date.now();
    broadcast("sent", { target, from: fromSite || null, ts: Date.now(), seq });
    broadcast("waiting-changed", { site: target, waiting: true });
    logEvent("sent", { target, from: fromSite || null, attempts, selfRecovered: attempts > 1, seq });
  }
  return res;
}

// Wraps sendTextTo() for every send made on behalf of the active House Rule
// flow -- both its kickoffs and its per-turn capture reactions. Tags the
// send opts.hr:true (see sendTextTo's failure branch) and, when a
// target-tracking Set is passed, records who this House Rule turn actually
// messaged so pollSite()'s mesh-forward loop can dedupe against it exactly
// like it already does for tag-routing via roundtableTargetsFor().
async function hrSendTextTo(target, text, fromSite, sentTargets) {
  if (sentTargets) sentTargets.add(target);
  return sendTextTo(target, text, fromSite, { hr: true });
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
const tunerInFlight = { active: false }; // guards against a manual 🧪 Test colliding with a Tuner run touching the same site
const testRunInFlight = new Set(); // sites currently in a connectivity "Test" round-trip — bareMode so a plain "TEST OK" reply (no envelope) still captures
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

// Blind Round: for a decision that matters, three models agreeing isn't
// worth much if the second and third only saw the first's answer before
// forming their own -- that's anchoring, not independent agreement. Every
// participant gets the exact same question at the exact same time, with
// none of them able to see the others' answers until all three have
// answered; only once every answer is in does each site get shown what the
// OTHER two independently said. Single-round by design (a technique you
// reach for on one important question, not an ongoing conversational mode)
// -- it ends itself the moment the reveal goes out. Reuses the generic
// hr.realPending/hr.realReplies fan-in shape "Who Wants to Speak" already
// uses for its own opt-in fan-in, rather than inventing a parallel one.
async function startBlindRound(checked) {
  state.hr.phase = "awaiting-blind";
  state.hr.realPending = new Set(checked);
  state.hr.realReplies = {};
  for (const s of checked) {
    const prompt = `You're being asked this independently and at the same time as ${otherLabels(checked, s)} -- none of you can see any answer but your own yet, so give your own honest take rather than guessing what they'd say. Once everyone has answered, you'll each see exactly what the others independently said.\n\n${state.hr.topic}`;
    await hrSendTextTo(s, prompt, null);
  }
}

async function startFreeForAll(checked) {
  for (const s of checked) state.routing[s] = new Set(checked.filter((t) => t !== s));
  state.meshActive = true;
  for (const s of checked) {
    const prompt = `You're one voice in an open discussion with ${otherLabels(checked, s)} on: "${state.hr.topic}". Anyone can jump in at any point — react to whoever said something interesting, don't wait for a formal turn.`;
    await hrSendTextTo(s, prompt, null);
  }
}

async function startBrainstorm(checked) {
  for (const s of checked) state.routing[s] = new Set(checked.filter((t) => t !== s));
  state.meshActive = true;
  for (const s of checked) {
    const prompt = `You're brainstorming with ${otherLabels(checked, s)} on: "${state.hr.topic}". This isn't a debate — no need to find flaws or pick a side. Build on what's already been suggested, add a new angle, or combine ideas.`;
    await hrSendTextTo(s, prompt, null);
  }
}

async function wrapUpBrainstorm() {
  const checked = SITE_IDS.filter((s) => state.enabled[s]);
  for (const s of checked) state.routing[s].clear();
  state.meshActive = false;
  const synth = checked[Math.floor(Math.random() * checked.length)];
  state.hr.roles = { [synth]: "synthesizer" };
  state.hr.phase = "awaiting-synthesis";
  await hrSendTextTo(
    synth,
    `We've been brainstorming on "${state.hr.topic}" for a while. Don't add a new idea — pull everything together into ONE single, fully fleshed-out plan: take the best pieces from what's been suggested, resolve any contradictions, and present it as a complete answer.`,
    null
  );
  broadcastHouseRule();
}

async function startDebate(checked) {
  state.hr.order = shuffledCopy(checked);
  state.hr.turnIndex = 0;
  await hrSendTextTo(state.hr.order[0], `You're kicking off a debate on: "${state.hr.topic}". Give your opening position.`, null);
}

async function startDevilAngel(checked) {
  const [middle, devil, angel] = shuffledCopy(checked);
  state.hr.roles = { [middle]: "middle", [devil]: "devil", [angel]: "angel" };
  state.hr.phase = "awaiting-middle";
  await hrSendTextTo(middle, `Here's a goal/idea I want to stress-test: "${state.hr.topic}". Lay out your initial take or plan for it.`, null);
}

async function startChargeback(checked) {
  const [d1, d2, ref] = shuffledCopy(checked);
  state.hr.roles = { [d1]: "debater1", [d2]: "debater2", [ref]: "referee" };
  state.hr.phase = "awaiting-debater1";
  queueIgnore(ref);
  await hrSendTextTo(ref, `You're the referee for a debate on "${state.hr.topic}" between two other AIs. Just observe for now — you'll be asked for a final verdict after round ${state.hr.rounds}.`, null);
  await hrSendTextTo(d1, `You're arguing FOR this: "${state.hr.topic}". State your opening case.`, null);
}

async function startWhoWants(checked) {
  state.hr.phase = "awaiting-optins";
  state.hr.optinPending = new Set(checked);
  state.hr.optinYes = [];
  const prompt = `Here's a topic to think about: "${state.hr.topic}".\n\nDo you have something worth adding right now — a new point, disagreement, or question? Reply with just YES or NO, and if YES, one line on your angle.`;
  for (const s of checked) await hrSendTextTo(s, prompt, null);
}

async function startRotation() {
  // ChatGPT -> Claude -> Gemini -> ChatGPT, fixed. Requires all three checked
  // (enforced in houserule:start). ChatGPT gets the raw topic — it's the
  // origin, not a RESPOND/UPDATE-wrapped message.
  state.hr.order = ROTATION_ORDER.slice();
  state.hr.phase = "awaiting-first";
  state.hr.lastSpeakerIndex = -1;
  await hrSendTextTo(ROTATION_ORDER[0], state.hr.topic, null);
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

// End-tag protocol: every baseline reply must close with [FROM: <who>]. Its
// PRESENCE is the completion signal (see pollSite()) — the moment it appears the
// AI has finished, so there's no waiting on a stability timer. The sender NAME is
// matched LOOSELY (we already know which pane it is, so any short label counts —
// "CHATGPT", "Claude 3.5", "gpt", even "Assistant"), and a short trailing tail
// after the tag (a sign-off "thanks!", a period) is tolerated — otherwise very
// common real outputs would be silently dropped. We take the LAST such tag whose
// tail is short, so a [FROM:] quoted MID-reply (with paragraphs after it) does
// not prematurely complete the message. parseEndTag() strips it from the body so
// the envelope marker never reaches the transcript, a routed message, or a PDF.
const END_TAG_RE = /\[\s*FROM:\s*([^\]\r\n]{1,40}?)\s*\]/gi;
const END_TAG_MAX_TAIL = 40; // chars allowed after the closing tag (a brief sign-off / punctuation), before it's judged "still has content"
function findEndTag(text) {
  const s = String(text || "");
  let last = null, m;
  END_TAG_RE.lastIndex = 0;
  while ((m = END_TAG_RE.exec(s))) last = m;
  if (!last) return null;
  const tail = s.slice(last.index + last[0].length);
  if (tail.length > END_TAG_MAX_TAIL || /\n\s*\n/.test(tail)) return null; // real content after the tag → not the close
  return { index: last.index, from: (last[1] || "").trim().toUpperCase() };
}
function hasEndTag(text) { return !!findEndTag(text); }
function parseEndTag(text) {
  const s = String(text || "");
  const f = findEndTag(s);
  if (!f) return { from: null, body: s };
  return { from: f.from, body: s.slice(0, f.index).replace(/\s+$/, "") };
}

// "NONE" is a complete "nothing to add" signal that stands on its own — it needs
// no [FROM:] closing tag (NONE is itself the tag). Recognize it whether written
// bare ("NONE"), bracketed ("[NONE]"), formatted ("**NONE**", "NONE?"), or as the
// routing tag ("[TO: NONE]"), with or without a stray [FROM:]. Only a reply whose
// ENTIRE content is NONE counts — "None of this works" is a real message.
function isNoneSkip(text) {
  const s = String(text || "");
  if (parseRoundtableTag(s).tag === "NONE") return true;
  const body = parseEndTag(parseRoundtableTag(s).body).body;
  return body.replace(/[^a-z]/gi, "").toUpperCase() === "NONE";
}

// Strip the [TO:]/[FROM:] envelope from a stored raw reply — for the few places
// that forward or display state.captured[site] (which keeps RAW text for dedup).
function stripEnvelope(text) {
  return parseEndTag(parseRoundtableTag(String(text || "")).body).body;
}

// Append a concise envelope instruction to an outbound prompt so the receiving
// pane wraps its reply per the protocol. Required on the baseline path (Compose,
// Prompt Sequence, Manager): a reply with no [FROM:] closing tag isn't captured,
// so an untaught prompt would strand the reply. `target` names the pane so its
// own [FROM:] tag is spelled out.
function withEnvelope(text, target) {
  const tag = String(target || "").toUpperCase() || "YOU";
  return String(text == null ? "" : text) +
    `\n\n[Reply envelope required: start with [TO: USER] and end with [FROM: ${tag}] — the closing tag is how this app knows your reply is complete; without it your reply is not received.]`;
}

// Missing-tag watchdog action (see pollSite()). A baseline pane went quiet with
// no [FROM:] closing tag, so the message is treated as LOST — never captured or
// routed. We nudge that AI with the communication protocol and ask it to resend
// the WHOLE message with the envelope. Capped (MAX_NOTAG_REPROMPTS) so a model
// that keeps forgetting can't loop forever: past the cap we stop nudging, and if
// a book run was waiting on this pane we park it as stalled for the user.
function composeEnvelopeReminder(site) {
  const name = String(site || "").toUpperCase() || "YOU";
  return (
    "⚠️ NO ENDING TAG RECEIVED — your last message was not delivered and has been discarded.\n\n" +
    "Every message MUST use the communication envelope:\n" +
    "• START with a routing tag in brackets: [TO: CHATGPT] / [TO: GEMINI] / [TO: CLAUDE] / [TO: ALL] / [TO: USER] / [TO: NONE]\n" +
    "• END with your own closing tag, same bracket form: [FROM: " + name + "]\n\n" +
    "The [FROM: ...] tag is what tells the system your message is finished — without it nothing is sent. " +
    "Please resend your ENTIRE message again, beginning with [TO: ...] and ending with [FROM: " + name + "]. " +
    "Put nothing after the closing tag."
  );
}
async function missingEndTagReprompt(site, rawText) {
  const n = (state.noTagReprompts[site] || 0) + 1;
  state.noTagReprompts[site] = n;
  logEvent("endtag-missing", { site, attempt: n, chars: (rawText || "").length });
  if (n > MAX_NOTAG_REPROMPTS) {
    logEvent("endtag-missing-giveup", { site, attempts: n });
    return;
  }
  try {
    await sendTextTo(site, composeEnvelopeReminder(site), null, { raw: true });
  } catch (e) { logEvent("endtag-reprompt-error", { site, error: String(e) }); }
}

// Pure target computation, shared by handleRoundtableCapture() and pollSite()'s
// mesh-forward loop below -- pulled out on its own specifically so pollSite()
// can dedupe against it BEFORE sending anything, rather than each mechanism
// independently deciding to send to the same target and producing two
// deliveries for one reply. Rule 1's semantics: ALL -> both others, a named
// AI -> just that one with a self-address guard, USER -> nothing further
// (it's already visible).
function roundtableTargetsFor(turn) {
  const tag = turn.roundtableTag || "USER";
  if (tag === "ALL") return ROTATION_ORDER.filter((s) => s !== turn.site);
  if (tag === "CLAUDE" || tag === "CHATGPT" || tag === "GEMINI") {
    const target = tag.toLowerCase();
    return target !== turn.site ? [target] : []; // self-address guard
  }
  return [];
}

// The always-on baseline router: relays a tagged reply per Rule 1's
// semantics. No session, no hop limit, no start/stop — this just runs on
// every capture whenever no stage format has taken over (see pollSite()).
async function handleRoundtableCapture(turn) {
  // Tell the receiver how it was addressed: a named [TO: X] tag → "you"; [TO: ALL]
  // → "everyone". This is the addressing awareness the stripped tag would carry.
  const addressing = turn.roundtableTag === "ALL" ? "everyone" : "you";
  for (const target of roundtableTargetsFor(turn)) {
    await sendTextTo(target, turn.text, turn.site, { addressing });
  }
}

// Loop guard: models acking each other produce SHORT, near-identical replies
// that ping-pong between panes forever. When the same short body has already
// been relayed several times in a short window, stop relaying further copies —
// the message is still shown in the transcript, it just isn't forwarded onward,
// which breaks the loop without hiding anything. Only short messages qualify, so
// real (substantive) back-and-forth is never suppressed.
const LOOP_SHORT_CHARS = Number(process.env.AUTOINJECTOR_LOOP_SHORT_CHARS) || 60;
const LOOP_WINDOW_MS = Number(process.env.AUTOINJECTOR_LOOP_WINDOW_MS) || 60000;
const LOOP_MAX_REPEATS = Number(process.env.AUTOINJECTOR_LOOP_MAX_REPEATS) || 3;
function loopSuppressRelay(text) {
  const body = String(text || "").trim();
  if (!body || body.length > LOOP_SHORT_CHARS) return false;
  const sig = body.replace(/\s+/g, " ").toLowerCase();
  const now = Date.now();
  state.recentShort = (state.recentShort || []).filter((e) => now - e.ts < LOOP_WINDOW_MS);
  const priorCount = state.recentShort.filter((e) => e.sig === sig).length;
  state.recentShort.push({ sig, ts: now });
  if (state.recentShort.length > 60) state.recentShort = state.recentShort.slice(-60);
  return priorCount >= LOOP_MAX_REPEATS;
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
  seq.sentTs = Date.now();
  const step = seq.steps[seq.index];
  const targets = step.target === "all" ? SITE_IDS : [step.target];
  for (const t of targets) {
    if (SITES[t]) {
      seq.dispatchGen[t] = seq.generation;
      await sendTextTo(t, withEnvelope(step.text, t), null);
    }
  }
  logEvent("sequence-step-sent", { index: seq.index, target: step.target, generation: seq.generation });
  broadcastSequenceState();
}

// Watchdog (ticked from the poll loop): if the step's target has produced no
// captured (i.e. properly-enveloped) reply for too long — the baseline missing-
// tag watchdog nudges up to MAX_NOTAG_REPROMPTS first — park the sequence so the
// UI stops implying progress rather than waiting on a reply that isn't coming.
const SEQUENCE_STEP_TIMEOUT_MS = Number(process.env.AUTOINJECTOR_SEQUENCE_TIMEOUT_MS) || 4 * 60 * 1000;
function sequenceWatchdog() {
  const seq = state.sequence;
  if (!seq.active || !seq.sentTs) return;
  if (Date.now() - seq.sentTs > SEQUENCE_STEP_TIMEOUT_MS) {
    const step = seq.steps[seq.index];
    seq.active = false;
    logEvent("sequence-stalled", { index: seq.index, target: step && step.target });
    broadcastSequenceState();
  }
}

async function startSequence(steps) {
  state.sequence = { active: true, steps, index: 0, generation: 0, dispatchGen: {}, sentTs: 0 };
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
  // Fold in the live awareness picture and the currently-registered tools so the
  // prompt builder can surface them -- these are derived, not stored on the task.
  let availableTools = [];
  try { availableTools = toolProvider.list(); } catch { availableTools = []; }
  return { ...state.manager, awareness: managerAwareness(), availableTools };
}

async function runTierFourAdjudication() {
  const m = state.manager;
  const adjudicator = (state.managerConfig.adjudicatorSite && SITES[state.managerConfig.adjudicatorSite]) ? state.managerConfig.adjudicatorSite : "claude";
  const question = `[Manager escalation -- tier 4 cloud adjudication for task "${m.taskId}"]\nOriginal request: ${m.userRequest}\n\nConflict/disagreement: ${JSON.stringify(m.conflicts)}\n\nMissing requirements: ${JSON.stringify(m.missingRequirements)}\n\nRelevant responses so far: ${JSON.stringify(m.latestResponses)}\n\nPlease resolve this and state clearly what should happen next.`;
  m.activeAssignments = [{ target: adjudicator, task: question, sentTs: Date.now() }];
  m.pendingModels = [adjudicator];
  m.status = "waiting";
  m.waitingSince = Date.now();
  logManagerEvent({ category: "escalation", severity: "warning", summary: `Escalated to Tier 4 cloud adjudication via ${SITES[adjudicator].label}`, target: [adjudicator] });
  await sendTextTo(adjudicator, withEnvelope(question, adjudicator), null);
  broadcastManagerState();
}

const MANAGER_ACTIVE_STATUSES = new Set(["classifying", "planning", "delegating", "reviewing", "comparing", "validating", "assembling", "saving", "running-code", "using-tool", "generating-image"]);

// Watchdog (ticked from the poll loop): a delegated pane that never produces a
// captured (properly-enveloped) reply would otherwise leave the manager stuck in
// "waiting" forever. The baseline missing-tag watchdog nudges the pane first; if
// it still never lands, park the task as errored rather than hang.
const MANAGER_WAIT_TIMEOUT_MS = Number(process.env.AUTOINJECTOR_MANAGER_TIMEOUT_MS) || 5 * 60 * 1000;
function managerWatchdog() {
  const m = state.manager;
  if (!m || m.status !== "waiting" || !m.waitingSince) return;
  if (Date.now() - m.waitingSince > MANAGER_WAIT_TIMEOUT_MS) {
    m.waitingSince = null;
    logManagerEvent({ category: "error", severity: "error", summary: `No reply from delegated model(s) ${JSON.stringify(m.pendingModels)} within timeout — parking task`, details: { pending: m.pendingModels } });
    finishManagedTask({ ok: false, reason: "DELEGATE_NO_REPLY" }).catch((e) => logEvent("manager-watchdog-error", { error: String(e) }));
  }
}

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

  // Approval gate: the whole-task approval mode, OR a per-tool "ask" risk tier —
  // a risk:"ask" tool (e.g. http-fetch) is held for the operator even when global
  // approval mode is off, so an LLM-chosen side effect never fires unattended.
  const askTool = decision.action === "USE_TOOL" && (() => { const t = toolProvider.get(decision.tool); return !!(t && t.risk === "ask"); })();
  if ((state.managerConfig.approvalMode || askTool) && decision.action !== "REQUEST_APPROVAL") {
    m.pendingApproval = decision;
    m.status = "paused";
    logManagerEvent({ category: "approval", summary: `Awaiting approval: ${decision.action}${askTool ? ` (${decision.tool})` : ""}`, action: decision.action, details: decision });
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
      await sendTextTo(a.target, withEnvelope(`[Manager assignment -- task "${m.taskId}"]\n${a.task}`, a.target), null);
    }
    m.status = "waiting"; // paused here until handleManagerCapture() sees every pending target reply
    m.waitingSince = Date.now();
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
    case "RUN_CODE": {
      // The supervisor's non-AI arm: run a coding/computer task through Open
      // Interpreter (a sandboxed local agent), then fold the result back into
      // the task so the next turn can use it. This is what makes the native
      // orchestrator a full "Jarvis" — it can act on the machine, not only
      // delegate to the three web AIs.
      m.status = "running-code";
      broadcastManagerState();
      let r;
      try {
        r = await interpreterProvider.run(decision.task, {
          onEvent: (ev) => logManagerEvent({ category: "code", summary: `code:${ev.type}${ev.format ? "(" + ev.format + ")" : ""}`, details: ev }),
        });
      } catch (e) { r = { ok: false, error: String(e) }; }
      const entry = { id: m.codeRuns.length + 1, task: decision.task, ok: !!(r && r.ok), message: (r && r.message) || "", error: (r && r.error) || null, ts: Date.now() };
      m.codeRuns.push(entry);
      if (m.codeRuns.length > 30) m.codeRuns.shift();
      logManagerEvent({
        category: "code",
        severity: entry.ok ? "info" : "error",
        summary: entry.ok ? `Code run complete (${entry.message.length} chars)` : `Code run unavailable/failed: ${entry.error}`,
        details: entry,
      });
      recordCapabilityOutcome("interpreter", "RUN_CODE", entry.ok);
      m.status = "assembling"; // an active status so the loop continues on the next turn
      await runManagerTurn();
      break;
    }
    case "USE_TOOL": {
      // N5: invoke a registered external tool (built-in now; a real MCP server's
      // tools plug into the same registry later). Result folds back like RUN_CODE.
      m.status = "using-tool";
      broadcastManagerState();
      let r;
      try {
        r = await toolProvider.run(decision.tool, decision.args || {}, {
          onEvent: (ev) => logManagerEvent({ category: "tool", summary: `tool:${ev.type}`, details: ev }),
        });
      } catch (e) { r = { ok: false, error: String(e) }; }
      const entry = { id: m.toolCalls.length + 1, tool: decision.tool, ok: !!(r && r.ok), message: (r && r.message) || "", error: (r && r.error) || null, ts: Date.now() };
      m.toolCalls.push(entry);
      if (m.toolCalls.length > 30) m.toolCalls.shift();
      recordCapabilityOutcome(decision.tool, "USE_TOOL", entry.ok);
      logManagerEvent({
        category: "tool",
        severity: entry.ok ? "info" : "error",
        summary: entry.ok ? `Tool ${entry.tool} ran (${entry.message.length} chars)` : `Tool ${entry.tool} failed: ${entry.error}`,
        details: entry,
      });
      m.status = "assembling";
      await runManagerTurn();
      break;
    }
    case "REMEMBER": {
      // N3: persist a durable fact into the shared memory store.
      const fact = String(decision.fact != null ? decision.fact : decision.value).trim();
      const res = dbService.memoryCreate("fact", { statement: fact, source: `manager:${m.taskId}` });
      logManagerEvent({
        category: "memory",
        severity: res && res.ok ? "info" : "warn",
        summary: res && res.ok ? `Remembered: ${fact.slice(0, 80)}` : `Memory unavailable (${(res && res.error) || "off"})`,
        details: { fact, result: res },
      });
      m.status = "assembling";
      await runManagerTurn();
      break;
    }
    case "RECALL": {
      // N3: search the shared memory store; results feed back into the prompt.
      const q = String(decision.query).trim();
      const res = dbService.memorySearch(q);
      const found = (res && res.results) || [];
      for (const row of found) {
        m.memories.push({ id: `${row.type}:${row.id}`, type: row.type, title: row.title || "", ts: Date.now() });
      }
      if (m.memories.length > 40) m.memories = m.memories.slice(-40);
      logManagerEvent({
        category: "memory",
        summary: (res && res.available) ? `Recalled ${found.length} for "${q.slice(0, 60)}"` : `Memory unavailable for recall`,
        details: { query: q, count: found.length },
      });
      m.status = "assembling";
      await runManagerTurn();
      break;
    }
    case "GENERATE_IMAGE": {
      // Render an image via the local Stable Diffusion endpoint, save the PNG to
      // the output folder, and record it as a project image so it's tracked like
      // any other artifact. The saved path folds back as an images entry.
      m.status = "generating-image";
      broadcastManagerState();
      let r;
      try {
        r = await imageProvider.generate(decision.prompt, {
          negativePrompt: decision.negativePrompt || decision.negative_prompt || "",
          onEvent: (ev) => logManagerEvent({ category: "image", summary: `image:${ev.type}`, details: { type: ev.type } }),
        });
      } catch (e) { r = { ok: false, error: String(e) }; }
      let savedPath = null, sha = "";
      if (r && r.ok && r.imageBase64) {
        try {
          const buf = Buffer.from(r.imageBase64, "base64");
          sha = require("crypto").createHash("sha256").update(buf).digest("hex");
          const fname = `img-${Date.now()}.png`;
          savedPath = outputManager.saveBuffer(outputManager.imagesDir(), fname, buf);
          try { dbService.recordImage({ path: savedPath, prompt: decision.prompt, model: imageProvider.status().model, from: `manager:${m.taskId}`, sha256: sha }); } catch (_) {}
        } catch (e) { r = { ok: false, error: `SAVE_FAILED: ${e}` }; }
      }
      const entry = { id: m.images.length + 1, prompt: decision.prompt, path: savedPath, ok: !!(r && r.ok && savedPath), error: (r && r.error) || (savedPath ? null : "no image"), ts: Date.now() };
      m.images.push(entry);
      if (m.images.length > 30) m.images.shift();
      recordCapabilityOutcome("stable-diffusion", "GENERATE_IMAGE", entry.ok);
      logManagerEvent({
        category: "image",
        severity: entry.ok ? "info" : "error",
        summary: entry.ok ? `Image rendered -> ${savedPath}` : `Image generation unavailable/failed: ${entry.error}`,
        details: entry,
      });
      m.status = "assembling";
      await runManagerTurn();
      break;
    }
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
  if (m.pendingModels.length === 0) m.waitingSince = null; // all replies in — stop the wait watchdog
  await saveRawResponse(responseEntry);
  if (state.manager.taskId !== myTaskId || ["finished", "error"].includes(state.manager.status)) return; // this task was stopped/replaced while the save was in flight
  recordCapabilityOutcome(turn.site, "DELEGATE", true); // this pane answered — it can take delegations
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
  // N3 auto-context: seed relevant prior facts so the butler starts already
  // knowing what it may have learned before, without an explicit RECALL turn.
  seedRelevantMemories(m);
  broadcastManagerState();
  // Ack-Brain: the butler acknowledges INSTANTLY (before the deep brain's first
  // turn), the way PersonalJarvis does — a sub-second "on it" so the user isn't
  // left waiting on the model. Emitted synchronously here, ahead of runManagerTurn.
  emitManagerAck(m.taskId, m.userRequest);
  runManagerTurn(); // fire-and-forget -- progresses asynchronously via capture events, same pattern as startSequence()
  return { ok: true, taskId: m.taskId };
}

// The instant acknowledgment. Templated from the goal (no model call, so it's
// truly sub-second and always available); shown in the UI and streamed on the
// bridge as a "jarvis-ack" event.
function emitManagerAck(taskId, goal) {
  const g = String(goal || "").replace(/\s+/g, " ").trim();
  const short = g.slice(0, 80);
  const text = short ? `On it — working on: "${short}${g.length > 80 ? "…" : ""}"` : "On it.";
  logManagerEvent({ category: "ack", summary: text });
  broadcast("manager-ack", { taskId, text, ts: Date.now() });
  speakIfEnabled(text); // N2: say it out loud too, when voice is on
}

// N2: speak text via the voice provider when voice is enabled + set to speak.
// Fire-and-forget — never awaited, never throws into the caller.
function speakIfEnabled(text) {
  try {
    const s = voiceProvider.status();
    if (s && s.enabled && s.speakOnAck) voiceProvider.speak(text).catch(() => {});
  } catch { /* voice off — silent */ }
}

// N3: seed the task's memories[] with facts relevant to the request, pulled from
// the shared store, so turn one already has context. Best-effort and silent when
// the store is unavailable — never blocks task start.
function seedRelevantMemories(m) {
  try {
    const res = dbService.memorySearch(m.userRequest);
    const found = (res && res.results) || [];
    for (const row of found.slice(0, 12)) {
      m.memories.push({ id: `${row.type}:${row.id}`, type: row.type, title: row.title || "", ts: Date.now() });
    }
    if (found.length) logManagerEvent({ category: "memory", summary: `Seeded ${Math.min(found.length, 12)} relevant memory item(s) for this task` });
  } catch { /* memory off — proceed without seeded context */ }
}

async function finishManagedTask({ ok, reason }) {
  const m = state.manager;
  m.status = ok ? "finished" : "error";
  m.finishedTs = Date.now();
  await saveTaskCheckpoint();
  logManagerEvent({ category: "task", severity: ok ? "success" : "error", summary: ok ? "Task completed" : `Task ended: ${reason || "unknown"}`, details: { reason: reason || null } });
  speakIfEnabled(ok ? "Done." : `Stopped: ${reason || "unknown"}`); // N2
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
  const sentTargets = new Set();
  if (turn.site !== hr.order[hr.turnIndex]) return sentTargets;
  hr.turnIndex = (hr.turnIndex + 1) % hr.order.length;
  if (hr.turnIndex === 0) {
    hr.roundNum++;
    if (hr.rounds > 0 && hr.roundNum >= hr.rounds) { endHouseRule("rounds complete"); return sentTargets; }
  }
  const next = hr.order[hr.turnIndex];
  const msg = `[${turn.label} says]\n\n${turn.text}\n\nRespond directly to the strongest point they just made — agree, refute, or build on it — then add your own point.`;
  await hrSendTextTo(next, msg, null, sentTargets);
  return sentTargets;
}

async function handleDevilAngelCapture(turn) {
  const hr = state.hr;
  const sentTargets = new Set();
  const role = hr.roles[turn.site];
  if (!role) return sentTargets;

  if (role === "middle" && hr.phase === "awaiting-middle") {
    // Every middle capture starts a round — the very first (the opening
    // statement) as well as every later synthesis. Check the limit BEFORE
    // fanning out again (not after collecting Devil & Angel's replies), so a
    // "rounds: 1" run still lets Middle respond once to their feedback
    // instead of cutting off the moment those replies are collected.
    if (hr.rounds > 0 && hr.roundNum >= hr.rounds) { endHouseRule("rounds complete"); return sentTargets; }
    hr.roundNum++;

    const devilSite = findRoleSite("devil");
    const angelSite = findRoleSite("angel");
    const devilIntro = hr.rolesIntroduced.devil ? "" : `You're the Devil here — find every reason this could fail: weaknesses, risks, blind spots. Don't hold back.\n\n`;
    const angelIntro = hr.rolesIntroduced.angel ? "" : `You're the Angel here — find every reason this could succeed: strengths, what's already working, the strongest case for it.\n\n`;
    hr.rolesIntroduced.devil = true;
    hr.rolesIntroduced.angel = true;
    hr.buffer = {};
    hr.phase = "awaiting-devil-angel";
    await hrSendTextTo(devilSite, `${devilIntro}[Middle says]\n\n${turn.text}`, null, sentTargets);
    await hrSendTextTo(angelSite, `${angelIntro}[Middle says]\n\n${turn.text}`, null, sentTargets);
    return sentTargets;
  }

  if (role === "devil" && hr.phase === "awaiting-devil-angel") {
    hr.buffer.devil = turn.text;
  } else if (role === "angel" && hr.phase === "awaiting-devil-angel") {
    hr.buffer.angel = turn.text;
  } else {
    return sentTargets;
  }

  if (hr.buffer.devil != null && hr.buffer.angel != null) {
    const middleSite = findRoleSite("middle");
    const combined = `[Devil says]\n\n${hr.buffer.devil}\n\n[Angel says]\n\n${hr.buffer.angel}\n\nYou've heard both sides above. Respond to both: what do you concede, what do you push back on, how does your position evolve? State it clearly, since that's what goes back to them next.`;
    hr.buffer = {};
    hr.phase = "awaiting-middle";
    await hrSendTextTo(middleSite, combined, null, sentTargets);
  }
  return sentTargets;
}

async function handleChargebackCapture(turn) {
  const hr = state.hr;
  const sentTargets = new Set();
  const role = hr.roles[turn.site];
  if (!role) return sentTargets;
  const referee = findRoleSite("referee");

  if (role === "referee") {
    if (hr.phase === "awaiting-verdict") {
      turn.isVerdict = true;
      endHouseRule("verdict delivered");
    }
    return sentTargets; // any other referee reply is just an ack to an informational copy, ignored via ignoreCaptureFrom
  }

  const d1 = findRoleSite("debater1");
  const d2 = findRoleSite("debater2");

  if (role === "debater1" && hr.phase === "awaiting-debater1") {
    queueIgnore(referee);
    await hrSendTextTo(referee, `[${turn.label} says]\n\n${turn.text}`, null, sentTargets);
    hr.phase = "awaiting-debater2";
    await hrSendTextTo(d2, `[${turn.label} says]\n\n${turn.text}\n\nRespond with your counter-argument.`, null, sentTargets);
    return sentTargets;
  }

  if (role === "debater2" && hr.phase === "awaiting-debater2") {
    hr.roundNum++;
    if (hr.roundNum >= hr.rounds) {
      // Fold the last exchange and the verdict request into ONE message to the
      // referee — sending two separate messages back-to-back to the same chat
      // risks the second landing while the site's input is still disabled from
      // generating a reply to the first.
      hr.phase = "awaiting-verdict";
      await hrSendTextTo(referee, `[${turn.label} says]\n\n${turn.text}\n\nThe debate is over. Based on everything you've observed, deliver your verdict: who argued better, and why? Declare a winner.`, null, sentTargets);
    } else {
      queueIgnore(referee);
      await hrSendTextTo(referee, `[${turn.label} says]\n\n${turn.text}`, null, sentTargets);
      hr.phase = "awaiting-debater1";
      await hrSendTextTo(d1, `[${turn.label} says]\n\n${turn.text}\n\nRespond with your counter-argument.`, null, sentTargets);
    }
  }
  return sentTargets;
}

async function handleWhoWantsCapture(turn) {
  const hr = state.hr;
  const sentTargets = new Set();

  if (hr.phase === "awaiting-optins" && hr.optinPending.has(turn.site)) {
    hr.optinPending.delete(turn.site);
    // Tolerate a leaked leading [TO: X] tag (a stage doesn't strip it) so an
    // opt-in like "[TO: ALL] YES" still counts as a YES.
    if (parseRoundtableTag(turn.text).body.trim().toUpperCase().startsWith("YES")) hr.optinYes.push(turn.site);
    if (hr.optinPending.size > 0) return sentTargets;

    if (hr.optinYes.length === 0) { endHouseRule("nobody opted in"); return sentTargets; }
    hr.phase = "awaiting-real";
    hr.realPending = new Set(hr.optinYes);
    hr.realReplies = {};
    for (const s of hr.optinYes) await hrSendTextTo(s, "Go ahead — give your point.", null, sentTargets);
    return sentTargets;
  }

  if (hr.phase === "awaiting-real" && hr.realPending.has(turn.site)) {
    hr.realPending.delete(turn.site);
    hr.realReplies[turn.site] = turn.text;
    if (hr.realPending.size > 0) return sentTargets;

    hr.roundNum++;
    if (hr.rounds > 0 && hr.roundNum >= hr.rounds) { endHouseRule("rounds complete"); return sentTargets; }

    const checked = SITE_IDS.filter((s) => state.enabled[s]);
    const recap = Object.entries(hr.realReplies).map(([s, t]) => `[${SITES[s].label} says]\n\n${t}`).join("\n\n");
    const prompt = `Here's what came up last round:\n\n${recap}\n\nDo you have something worth adding right now — a new point, disagreement, or question? Reply with just YES or NO, and if YES, one line on your angle.`;
    hr.phase = "awaiting-optins";
    hr.optinPending = new Set(checked);
    hr.optinYes = [];
    for (const s of checked) await hrSendTextTo(s, prompt, null, sentTargets);
  }
  return sentTargets;
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
  const sentTargets = new Set();
  const order = hr.order;
  const idx = order.indexOf(turn.site);
  if (idx === -1) return sentTargets;

  if (hr.phase === "awaiting-first") {
    if (turn.site !== order[0]) return sentTargets; // only ChatGPT's first reply starts the rotation
    hr.phase = "rotating";
    hr.lastSpeakerIndex = 0;
  } else if (hr.phase === "rotating") {
    const expectedIdx = (hr.lastSpeakerIndex + 1) % order.length;
    if (idx !== expectedIdx) return sentTargets; // not whoever we're expecting to RESPOND right now
    hr.lastSpeakerIndex = idx;
    hr.roundNum++;
  } else {
    return sentTargets;
  }

  const nextSite = order[(hr.lastSpeakerIndex + 1) % order.length];
  const thirdSite = order[(hr.lastSpeakerIndex + 2) % order.length];

  const respondMsg = `[${turn.label} says]\n\n${turn.text}\n\nRespond to this, continuing the conversation naturally.`;
  await hrSendTextTo(nextSite, respondMsg, null, sentTargets);

  queueSilentAck(thirdSite);
  const updateMsg = `[${turn.label} says]\n\n${turn.text}\n\nDon't respond to this yet — it's not your turn. Just note it so you're caught up, and reply with exactly: UPDATED`;
  await hrSendTextTo(thirdSite, updateMsg, null, sentTargets);
  return sentTargets;
}

async function handleBlindRoundCapture(turn) {
  const hr = state.hr;
  const sentTargets = new Set();
  if (hr.phase !== "awaiting-blind" || !hr.realPending.has(turn.site)) return sentTargets;
  hr.realPending.delete(turn.site);
  hr.realReplies[turn.site] = turn.text;
  if (hr.realPending.size > 0) return sentTargets; // still waiting on the others -- nobody gets shown anything yet

  // All three are in. Reveal each site's own independent answer to the
  // OTHER two (never its own back to itself), clearly framed as having been
  // given blind, then end the run -- this is a one-shot technique, not a
  // mode that keeps going.
  const sites = Object.keys(hr.realReplies);
  for (const s of sites) {
    const others = sites.filter((o) => o !== s)
      .map((o) => `[${SITES[o].label}'s independent answer]\n\n${hr.realReplies[o]}`)
      .join("\n\n");
    await hrSendTextTo(s, `Here's what everyone answered independently, before anyone could see anyone else's response:\n\n${others}`, null, sentTargets);
  }
  endHouseRule("all three answered independently");
  return sentTargets;
}

// Runs the active mode's own reaction to a new captured turn, returning the
// Set of targets it actually messaged (empty if it decided this turn wasn't
// its business, e.g. not-my-turn or an unrecognized role) -- pollSite()'s
// mesh-forward loop dedupes against this exact Set so a target already
// messaged directly by the House Rule never also gets a second, differently
// worded copy via mesh routing for the same turn.
async function handleHouseRuleCapture(turn) {
  switch (state.hr.mode) {
    case "debate": return (await handleDebateCapture(turn)) || new Set();
    case "devil-angel": return (await handleDevilAngelCapture(turn)) || new Set();
    case "chargeback": return (await handleChargebackCapture(turn)) || new Set();
    case "who-wants-to-speak": return (await handleWhoWantsCapture(turn)) || new Set();
    case "brainstorm": return (await handleBrainstormCapture(turn)) || new Set();
    case "rotation": return (await handleRotationCapture(turn)) || new Set();
    case "blind-round": return (await handleBlindRoundCapture(turn)) || new Set();
    default: return new Set(); // free-for-all rides entirely on the generic routing mesh below
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
    // The site's own "still generating" signal (its Stop button is showing, or
    // Send is disabled). This is the reliable "are they done speaking?" answer —
    // when the Send button comes back, the reply is finished. While generating we
    // never capture or nudge: it prevents grabbing a half-written reply on a
    // mid-stream pause, and it means a "done" is only ever a real done. If the
    // site's stop/send selectors don't match, this is false and completion falls
    // back to the [FROM:] tag / stability timer, exactly as before.
    const generating = !!(res && res.generating);
    // Publish generation-state transitions (drives the UI dot and the service
    // bridge's "generation" event) — the definitive "are they still speaking?".
    if (state.generating[site] !== generating) {
      state.generating[site] = generating;
      broadcast("generation", { site, generating });
    }

    if (!text) { state.pending[site] = { text: "", sinceTs: Date.now(), reprompted: false }; return; }

    if (generating) {
      // Still producing this reply — track the growing text and wait for the
      // Send button to return. Never complete or re-prompt a turn mid-stream.
      state.pending[site] = { text, sinceTs: Date.now(), reprompted: false };
      return;
    }

    // Completion gate. On the always-on baseline path a reply is DONE the instant
    // it carries a [FROM: X] end tag — no stability timer. "Bare mode" pauses the
    // envelope requirement for this pane: a house-rules stage runs its own
    // protocol, and a connectivity self-test / the Tuner deliberately ask for a
    // bare token with no [TO:]/[FROM:]. Those keep the original "text stopped
    // changing for STABLE_MS" completion and are never nudged for a missing tag.
    const stageActive = state.hr.active && STAGE_MODES.has(state.hr.mode);
    const bareMode = stageActive || selftestInFlight.has(site) || tunerInFlight.active || testRunInFlight.has(site);

    // "NONE" — nothing to add — is a complete signal on its own and needs no
    // [FROM:] closing tag. On the baseline path, recognize it once stable and
    // swallow it silently: it never reaches the transcript, never relays, and is
    // never nudged for a missing tag. (During a stage/self-test the pane's own
    // protocol handles its output, so this only applies outside bare mode.)
    if (!bareMode && isNoneSkip(text)) {
      if (text !== pend.text) { state.pending[site] = { text, sinceTs: Date.now(), reprompted: false }; return; }
      if (Date.now() - pend.sinceTs < STABLE_MS) return;
      const seen = state.captured[site];
      if (seen && seen.text === text) return; // already swallowed this exact NONE
      state.captured[site] = { id: state.nextTurnId++, site, label: SITES[site].label, text, ts: Date.now(), pinned: false };
      state.noTagReprompts[site] = 0;
      if (state.waiting[site]) {
        state.waiting[site] = false;
        state.waitingSince[site] = null;
        broadcast("waiting-changed", { site, waiting: false });
      }
      logEvent("roundtable-skip", { site, none: true });
      return;
    }

    if (bareMode) {
      if (text !== pend.text) { state.pending[site] = { text, sinceTs: Date.now(), reprompted: false }; return; }
      if (Date.now() - pend.sinceTs < STABLE_MS) return;
    } else if (!hasEndTag(text)) {
      // An untagged reply we ALREADY captured is not a new "forgot the tag"
      // event — most importantly, a connectivity self-test / Tuner reply is a
      // bare token (no envelope) captured in bare mode; once that mode ends its
      // leftover text must not trip a spurious "you forgot your [FROM:] tag"
      // nudge. Baseline never captures untagged text, so this only ever matches
      // something a bare-mode/stage run already handled.
      const already = state.captured[site];
      if (already && already.text === text) return;
      // Still streaming, OR finished-but-forgot-the-tag. Track quiet time; only
      // act once the pane has gone quiet past the watchdog window.
      if (text !== pend.text) { state.pending[site] = { text, sinceTs: Date.now(), reprompted: false }; return; }
      if (Date.now() - pend.sinceTs < NOTAG_QUIET_MS) return;
      // Quiet, no [FROM:] tag. A provider rate-limit/usage-cap notice never
      // carries our envelope and will never grow one, so let it fall through to
      // the rate-limit handler below (which captures + auto-pauses) instead of
      // futilely re-prompting a capped pane. Anything else is a real message the
      // AI forgot to close: treat it as lost and re-send the protocol asking for
      // a full resend — never capture an untagged (possibly partial) reply.
      if (!looksLikeRateLimit(text)) {
        if (!pend.reprompted) {
          state.pending[site].reprompted = true;
          missingEndTagReprompt(site, text);
        }
        return;
      }
      // rate-limit: fall through to the dedup + rate-limit handling below.
    }
    // Baseline with the end tag present falls straight through — capture now.

    const already = state.captured[site];
    if (already && already.text === text) return; // no new completed reply

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
    // is swallowed entirely, never reaching the transcript. (stageActive was
    // already computed for the completion gate above.)
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
    // Strip the [FROM: X] closing tag so the envelope marker never reaches the
    // transcript, the routed message, or a saved PDF — the sender is already
    // shown by the bubble/label. Universal: a stage reply carrying one is cleaned
    // too. (On the baseline path the tag's presence is what got us here.)
    displayText = parseEndTag(displayText).body;

    // Empty envelope (e.g. "[TO: GEMINI][FROM: CLAUDE]" with no body between the
    // tags) — nothing to show or relay. Swallow it rather than pushing an empty
    // bubble and forwarding an empty, frame-only message into another pane.
    // Baseline path only; a stage/self-test manages its own (already-bare) output.
    if (!bareMode && !displayText.trim()) {
      state.captured[site] = { id: state.nextTurnId++, site, label: SITES[site].label, text, ts: Date.now(), pinned: false };
      state.noTagReprompts[site] = 0;
      if (state.waiting[site]) {
        state.waiting[site] = false;
        state.waitingSince[site] = null;
        broadcast("waiting-changed", { site, waiting: false });
      }
      logEvent("roundtable-skip", { site, empty: true });
      return;
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
    // Record the captured reply into the shared SQLite message log (guarded;
    // no-ops if the database backend is unavailable).
    try { dbService.recordTurn(turn); } catch (_) {}

    // The dedup key must be the RAW page text (what the next poll will read).
    // Whenever we stripped an envelope tag ([TO:] at the front and/or [FROM:] at
    // the end) the display text differs from the page, so store raw text for the
    // "already captured this" check; otherwise store the turn as-is.
    state.captured[site] = (text !== turn.text) ? { ...turn, text } : turn;
    state.noTagReprompts[site] = 0; // a valid reply landed — clear any missing-tag nudge streak
    pushTranscriptTurn(turn);
    broadcast("capture", turn);
    logEvent("captured", { site, chars: displayText.length });
    saveStateDebounced();

    if (state.waiting[site]) {
      state.waiting[site] = false;
      state.waitingSince[site] = null;
      broadcast("waiting-changed", { site, waiting: false });
    }

    // Mesh routing (Auto/Auto-Both/manual routing:set) and either tag-based
    // Roundtable relay OR an active House Rules stage can both independently
    // name the SAME target for the SAME captured reply -- e.g. full mesh
    // routing is on AND the AI's own [TO: X] tag also points at that site,
    // or mesh routing is on AND the active House Rule's own state machine
    // independently messages that same target (reachable in practice
    // because the per-pane Auto toggle isn't disabled during a House Rules
    // run). Without this dedupe, that target used to get sent to TWICE for
    // one reply -- a real, confirmed duplicate-delivery bug, not a timing
    // race. Whichever mechanism actually owns this turn (tag routing when
    // no stage is active, the House Rule's own reaction when one is) takes
    // priority for any target it already covers; mesh only forwards to
    // whatever's left. The House Rule's reaction has to run FIRST so its
    // real target Set exists before mesh decides what's left over --
    // roundtableTargetsFor() doesn't have this ordering constraint since
    // it's a pure function of the turn, computable at any point.
    // Loop guard: a short reply that's already ping-ponged several times is
    // still shown, but not relayed onward — this breaks a model-acknowledgment
    // loop without suppressing real content. Applies only to the free AI-to-AI
    // relay (roundtable + mesh); the bounded, directed paths (House Rules
    // stages, Prompt Sequence, Manager) always run.
    const looping = !stageActive && loopSuppressRelay(turn.text);
    if (looping) logEvent("loop-suppressed", { site, chars: turn.text.length });
    let hrSentTargets = new Set();
    if (stageActive) hrSentTargets = await handleHouseRuleCapture(turn);
    else if (!looping) await handleRoundtableCapture(turn);
    const roundtableTargets = !stageActive ? new Set(roundtableTargetsFor(turn)) : hrSentTargets;
    if (!looping) {
      for (const target of state.routing[site]) {
        if (target === site || roundtableTargets.has(target)) continue;
        // Forward the ENVELOPE-STRIPPED body (turn.text), same as the tag-routing
        // relay — never the raw page text, which still carries [TO:]/[FROM:].
        await sendTextTo(target, turn.text, site);
      }
    }
    if (state.sequence.active) await handleSequenceCapture(turn);
    if (state.manager.status === "waiting") await handleManagerCapture(turn);
  } catch (e) {
    logEvent("poll-error", { site, error: String(e) });
  } finally {
    state.busy[site] = false;
  }
}

// --- Shared database (SQLite) IPC ------------------------------------------
ipcMain.handle("db:status", async () => {
  try { return dbService.status(); } catch (e) { return { available: false, reason: String(e) }; }
});
ipcMain.handle("db:recent-messages", async (_evt, limit) => {
  try { return dbService.recent(limit || 100); } catch (e) { return []; }
});

// --- Stable Diffusion (Image Studio) IPC -----------------------------------

// --- System monitor IPC ----------------------------------------------------

// Run the system check, post the report into the conversation/message log, and
// save it. Returns the report text.
function formatSystemReport(rep) {
  const s = rep.snapshot || {}, r = rep.recommendation || {};
  const lines = ["SYSTEM CHECK", ""];
  if (s.error) { lines.push(`⚠ ${s.error}`); return lines.join("\n"); }
  if (s.cpu) lines.push(`CPU: ${s.cpu.brand || "?"} · ${s.cpu.cores || "?"} cores${s.cpu.speedGHz ? ` · ${s.cpu.speedGHz} GHz` : ""}${s.temps && s.temps.cpuMainC ? ` · ${s.temps.cpuMainC}°C` : ""}`);
  if (s.mem) lines.push(`RAM: ${s.mem.totalGB} GB total · ${s.mem.usedGB} GB used`);
  if (s.gpus && s.gpus.length) { for (const g of s.gpus) lines.push(`GPU: ${g.model}${g.vramGB ? ` · ${g.vramGB} GB VRAM` : ""}${g.tempC ? ` · ${g.tempC}°C` : ""}`); }
  else lines.push("GPU: none detected");
  if (s.os) lines.push(`OS: ${s.os.distro || s.os.platform || "?"} ${s.os.release || ""} (${s.os.arch || ""})`);
  if (r.llm) lines.push("", `Can run — local models: ${r.llm.tier} (${r.llm.detail})`, `Can run — Stable Diffusion: ${r.sd.tier} (${r.sd.detail})`);
  return lines.join("\n");
}

// --- Ollama model manager IPC ----------------------------------------------
ipcMain.handle("ollama:detect", async () => { try { return await ollamaManager.detect(); } catch (e) { return { available: false, reason: String(e) }; } });
ipcMain.handle("ollama:list", async (_evt, endpoint) => { try { return await ollamaManager.listInstalled(endpoint); } catch (e) { return { ok: false, models: [] }; } });
ipcMain.handle("ollama:recommended", async (_evt, vramGB) => { try { return { models: ollamaManager.recommended(vramGB) }; } catch (e) { return { models: [] }; } });
ipcMain.handle("ollama:pull", async (_evt, model) => {
  try {
    const { done } = ollamaManager.pull(model, (line) => broadcast("ollama-progress", { model, line }));
    const r = await done;
    broadcast("ollama-progress", { model, line: r.ok ? "✓ done" : `⚠ ${r.error}`, done: true, ok: !!r.ok });
    return r;
  } catch (e) { return { ok: false, error: String(e) }; }
});


ipcMain.handle("external:open", (_evt, url) => {
  try { if (shell && typeof url === "string" && /^https?:\/\//.test(url)) shell.openExternal(url); return { ok: true }; }
  catch (e) { return { ok: false, error: String(e) }; }
});
ipcMain.handle("wizard:open", (_evt, { tab } = {}) => { openWizardWindow(tab); return { ok: true }; });
ipcMain.handle("wizard-window:close", () => { closeWizardWindow(); return { ok: true }; });
// Consolidated AI feed window: open/close + backfill recent AI messages so the
// window shows history, not a blank, when reopened.
ipcMain.handle("feed:open", () => { openFeedWindow(); return { ok: true }; });
ipcMain.handle("feed-window:close", () => { closeFeedWindow(); return { ok: true }; });
ipcMain.handle("feed:history", () => {
  try {
    return state.transcript
      .filter((t) => t && SITES[t.site]) // only the three AI panes (skip system/verdict rows)
      .slice(-120)
      .map((t) => ({ id: t.id, site: t.site, label: t.label, text: t.text, ts: t.ts }));
  } catch (_) { return []; }
});
// Local-AI catalog for the wizard: detect Ollama and list recommended models,
// plus a guided installer link. (The bare-bones core carries no hardware scan or
// in-app model downloader — install models via Ollama directly.)
ipcMain.handle("wizard:catalog", async () => {
  try {
    let ollama = { available: false };
    try { ollama = await ollamaManager.detect(); } catch (_) {}
    return {
      ok: true,
      ollama,
      models: ollamaManager.recommended(null).map((name) => ({ kind: "ollama-model", model: name, category: "Local AI" })),
      installers: {
        ollama: { name: "Ollama", url: "https://ollama.com/download", note: "Runs local AI models — powers the System AI / butler. Install it, then reopen this wizard." },
        interpreter: { name: "Open Interpreter", url: "https://github.com/OpenInterpreter/open-interpreter#installation", note: "Lets the butler run code & control the computer (RUN_CODE). Install with: pip install open-interpreter" },
        voice: { name: "Voice (piper + whisper)", url: "https://github.com/OHF-Voice/piper1-gpl", note: "Offline speak & listen for the butler. Install with: pip install piper-tts faster-whisper sounddevice" },
        stableDiffusion: { name: "Stable Diffusion (Automatic1111)", url: "https://github.com/AUTOMATIC1111/stable-diffusion-webui#installation-and-running", note: "Local image generation. Run it with --api, then set its URL in the Images tab." },
        comfyui: { name: "ComfyUI (alt. image backend)", url: "https://github.com/comfyanonymous/ComfyUI#installing", note: "A more powerful node-based image backend. Optional alternative to Automatic1111." },
      },
    };
  } catch (e) { return { ok: false, error: String(e) }; }
});

// Native top menu bar (File / View / Tools / Help). Guarded so the test
// harness (which has no Menu) is unaffected.
function buildAppMenu() {
  if (!Menu || !Menu.buildFromTemplate) return;
  try {
    const isMac = process.platform === "darwin";
    const template = [
      ...(isMac ? [{ role: "appMenu" }] : []),
      { label: "File", submenu: [isMac ? { role: "close" } : { role: "quit" }] },
      { label: "View", submenu: [
        { role: "reload" }, { role: "forceReload" }, { type: "separator" },
        { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" },
        { role: "togglefullscreen" }, { role: "toggleDevTools" },
      ] },
      { label: "Tools", submenu: [
        { label: "Setup Wizard", click: () => openWizardWindow() },
        { label: "Open Output Folder", click: () => { try { const r = outputManager.root(); if (shell && r) shell.openPath(r); } catch (_) {} } },
      ] },
      { label: "Help", submenu: [
        { label: "User Guide", click: () => { if (shell) shell.openExternal("https://github.com/javon86/AutoInjector/blob/main/USER_GUIDE.md"); } },
        { label: "About AutoInjector", click: () => { if (dialog && dialog.showMessageBox) dialog.showMessageBox({ type: "info", title: "AutoInjector", message: "AutoInjector Desktop", detail: "Runs ChatGPT, Claude and Gemini together. See the User Guide (Help menu)." }); } },
      ] },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  } catch (e) { logEvent("menu-error", { error: String(e) }); }
}

// --- Compose / forward / regenerate IPC ------------------------------------

ipcMain.handle("send:compose", async (_evt, { text, targets }) => {
  const list = Array.isArray(targets) ? targets.filter((t) => SITES[t]) : [];
  if (!text || !list.length) return { ok: false, error: "NEED_TEXT_AND_TARGET" };
  try { dbService.recordUserMessage(text, list); } catch (_) {}
  logEvent("compose", { targets: list, chars: text.length });
  const results = {};
  // Teach the envelope per target so the reply comes back with its [FROM:] tag
  // and is actually captured on the baseline path (the book workflow teaches its
  // own and is left untouched).
  for (const t of list) results[t] = await sendTextTo(t, withEnvelope(text, t), null);
  return { ok: true, results };
});

ipcMain.handle("send:forward", async (_evt, { source, targets }) => {
  const cap = state.captured[source];
  if (!cap) return { ok: false, error: "NOTHING_CAPTURED_YET" };
  const list = Array.isArray(targets) ? targets.filter((t) => SITES[t] && t !== source) : [];
  if (!list.length) return { ok: false, error: "NO_TARGETS" };
  // state.captured stores RAW text (for dedup); strip the [TO:]/[FROM:] envelope
  // before forwarding so the target doesn't receive routing markers.
  const clean = stripEnvelope(cap.text);
  const results = {};
  for (const t of list) results[t] = await sendTextTo(t, clean, source);
  return { ok: true, results };
});

ipcMain.handle("send:regenerate", async (_evt, site) => {
  if (!SITES[site]) return { ok: false, error: "BAD_SITE" };
  const text = state.lastSentTo[site];
  if (!text) return { ok: false, error: "NOTHING_SENT_YET" };
  // Routed through sendTextTo() with { raw: true } -- `text` is already the
  // exact, fully-framed string that was actually sent last time (that's
  // what state.lastSentTo stores), so raw mode sends it verbatim instead of
  // re-wrapping it in another layer of role-clause/label framing. Going
  // through sendTextTo() (rather than calling the send script directly, as
  // this handler used to) means Regenerate now gets the same per-target
  // send queue, 3-attempt retry, and delivery-ledger entry every other send
  // path already gets -- previously a regenerate click could race a
  // concurrent mesh-forward into the same pane (the exact typing-collision
  // bug the send queue exists to prevent) and never showed up in the ledger
  // at all.
  const res = await sendTextTo(site, text, null, { raw: true });
  if (res && res.ok) logEvent("regenerate", { site });
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

// The Council/roundtable start+stop, extracted so both the IPC handler (the UI)
// and the local service bridge can drive an identical run — one code path, no
// divergence between the two callers.
async function startCouncil({ mode, topic, rounds }) {
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
    else if (mode === "blind-round") await startBlindRound(checked);
  } catch (e) {
    state.hr.active = false;
    logEvent("houserule-start-error", { mode, error: String(e) });
    return { ok: false, error: String(e) };
  }
  broadcastHouseRule();
  saveStateDebounced();
  return { ok: true, houseRule: houseRuleSnapshot() };
}
ipcMain.handle("houserule:start", (_evt, args) => startCouncil(args || {}));

function stopCouncil() {
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
}
ipcMain.handle("houserule:stop", () => stopCouncil());

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
  // Expose the ENVELOPE-STRIPPED text to renderers (state.captured keeps RAW
  // text internally for dedup) so a restored per-pane preview matches the live
  // capture broadcast — no [TO:]/[FROM:] tags leak into the UI after a reload.
  captured: Object.fromEntries(SITE_IDS.map((s) => [s, state.captured[s] ? { ...state.captured[s], text: stripEnvelope(state.captured[s].text) } : null])),
  transcript: state.transcript,
  log: state.log,
  ledger: state.ledger,
  logins: sanitizedLoginsAllSites(),
  prompts: state.prompts,
  sequence: { active: state.sequence.active, index: state.sequence.index, total: state.sequence.steps.length },
  manager: managerSnapshot(),
  managerConfig: managerConfigSnapshot(),
  managerLog: state.managerLog
}));

ipcMain.handle("transcript:clear", () => { state.transcript = []; saveStateDebounced(); return { ok: true }; });

// "Extract All": dump the WHOLE conversation (what the AIs said) AND the full
// activity/error log into one text file, saved into the program's own logs
// folder (<Documents>/AutoInjector/output/logs). Pulled from in-memory state,
// not the on-screen windows, so a long/streaming transcript is captured in full
// and never cut off by what happens to be scrolled into view.
function _ts(ms) { try { return new Date(ms).toLocaleString(); } catch (_) { return String(ms); } }
function buildExtractText() {
  const now = new Date();
  const lines = [];
  lines.push("AutoInjector — Extract All");
  lines.push(`Generated: ${now.toLocaleString()}`);
  lines.push(`AI messages: ${state.transcript.length} · Activity/errors: ${state.log.length}`);
  lines.push("");
  lines.push("========================================");
  lines.push("AI CONVERSATION (what the language models said)");
  lines.push("========================================");
  if (!state.transcript.length) lines.push("(no messages captured)");
  for (const t of state.transcript) {
    const who = t.label || (t.site ? (SITES[t.site] ? SITES[t.site].label : t.site) : "AI");
    const tags = [];
    if (t.roundtableTag) tags.push(`TO:${t.roundtableTag}`);
    if (t.isRateLimited) tags.push("RATE-LIMITED");
    if (t.isVerdict) tags.push("VERDICT");
    lines.push(`[${_ts(t.ts)}] ${who}${tags.length ? " (" + tags.join(", ") + ")" : ""}:`);
    lines.push(String(t.text == null ? "" : t.text));
    lines.push("");
  }
  lines.push("========================================");
  lines.push("ACTIVITY / TROUBLESHOOTING (errors and events)");
  lines.push("========================================");
  if (!state.log.length) lines.push("(no activity logged)");
  for (const e of state.log) {
    let detail = "";
    try { detail = e.detail == null ? "" : (typeof e.detail === "string" ? e.detail : JSON.stringify(e.detail)); } catch (_) { detail = String(e.detail); }
    lines.push(`[${_ts(e.ts)}] ${e.kind}${detail ? " — " + detail : ""}`);
  }
  lines.push("");
  return lines.join("\n");
}
ipcMain.handle("logs:extract-all", () => {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
    const file = outputManager.saveBuffer(outputManager.logsDir(), `autoinjector-extract-${stamp}.txt`, buildExtractText());
    logEvent("extract-all", { file, messages: state.transcript.length, logEntries: state.log.length });
    try { if (shell && shell.showItemInFolder) shell.showItemInFolder(file); } catch (_) {}
    return { ok: true, file, messages: state.transcript.length, logEntries: state.log.length };
  } catch (e) { logEvent("extract-all-error", { error: String(e) }); return { ok: false, error: String(e) }; }
});

ipcMain.handle("transcript:toggle-pin", (_evt, id) => {
  const turn = state.transcript.find((t) => t.id === id);
  if (!turn) return { ok: false, error: "NOT_FOUND" };
  turn.pinned = !turn.pinned;
  return { ok: true, id, pinned: turn.pinned };
});

ipcMain.handle("site:reload", (_evt, site) => {
  if (!SITES[site]) return { ok: false, error: "BAD_SITE" };
  const view = siteViews[site];
  if (!view) return { ok: false, error: "NO_VIEW" };
  view.webContents.loadURL(SITES[site].home);
  state.pending[site] = { text: "", sinceTs: Date.now(), reprompted: false };
  state.captured[site] = null;
  state.noTagReprompts[site] = 0;
  logEvent("reload", { site });
  return { ok: true };
});

ipcMain.handle("site:inspect", (_evt, site) => {
  if (!SITES[site]) return { ok: false, error: "BAD_SITE" };
  const view = siteViews[site];
  if (!view) return { ok: false, error: "NO_VIEW" };
  view.webContents.openDevTools({ mode: "detach" });
  logEvent("inspect-opened", { site });
  return { ok: true };
});

// Start a fresh chat/session in every AI pane at once. Navigates each pane to
// its "new chat" URL and clears that pane's pending/captured state so the app
// doesn't mistake the old conversation for a new reply.
ipcMain.handle("sites:new-chat-all", () => {
  const results = {};
  for (const site of SITE_IDS) {
    const view = siteViews[site];
    if (!view) { results[site] = false; continue; }
    try {
      view.webContents.loadURL(SITES[site].newChat || SITES[site].home);
      state.pending[site] = { text: "", sinceTs: Date.now(), reprompted: false };
      state.captured[site] = null;
      state.noTagReprompts[site] = 0;
      results[site] = true;
    } catch (e) { results[site] = false; logEvent("new-chat-error", { site, error: String(e) }); }
  }
  logEvent("new-chat-all", results);
  return { ok: true, results };
});

ipcMain.handle("site:list", () => {
  const out = {};
  for (const site of SITE_IDS) {
    const view = siteViews[site];
    out[site] = view ? { url: view.webContents.getURL(), title: view.webContents.getTitle(), label: SITES[site].label } : null;
  }
  return { ok: true, sites: out };
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
  if (!SITES[site]) return { ok: false, error: "BAD_SITE" };
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

// --- Saved logins: purely manual, one-click credential fill+submit. Never
// auto-triggered by detecting a login form -- only runs when the user picks
// a specific saved login. Passwords are encrypted at rest via Electron's
// safeStorage (the OS's own keychain/DPAPI/libsecret) the moment they're
// saved, decrypted only for the instant a fill is actually requested, and
// never sent to the renderer or written to the Activity Log in any form.
function sanitizedLogins(site) {
  return (state.savedLogins[site] || []).map(({ id, label, username }) => ({ id, label, username }));
}
function sanitizedLoginsAllSites() {
  return Object.fromEntries(SITE_IDS.map((s) => [s, sanitizedLogins(s)]));
}

ipcMain.handle("logins:list", () => ({ ok: true, logins: sanitizedLoginsAllSites() }));

ipcMain.handle("logins:save", (_evt, { site, label, username, password }) => {
  if (!SITES[site]) return { ok: false, error: "BAD_SITE" };
  if (!label || !String(label).trim()) return { ok: false, error: "NEEDS_LABEL" };
  if (!username || !String(username).trim()) return { ok: false, error: "NEEDS_USERNAME" };
  if (!password) return { ok: false, error: "NEEDS_PASSWORD" };
  if (!safeStorage.isEncryptionAvailable()) return { ok: false, error: "ENCRYPTION_UNAVAILABLE" };
  const encryptedPassword = safeStorage.encryptString(password).toString("base64");
  const entry = { id: state.nextLoginId++, label: String(label).trim(), username: String(username).trim(), encryptedPassword };
  state.savedLogins[site] = [...(state.savedLogins[site] || []), entry];
  saveStateDebounced();
  logEvent("login-saved", { site, id: entry.id, label: entry.label, username: entry.username }); // never the password
  return { ok: true, logins: sanitizedLogins(site) };
});

ipcMain.handle("logins:delete", (_evt, { site, id }) => {
  if (!SITES[site]) return { ok: false, error: "BAD_SITE" };
  const before = (state.savedLogins[site] || []).length;
  state.savedLogins[site] = (state.savedLogins[site] || []).filter((l) => l.id !== id);
  if (state.savedLogins[site].length === before) return { ok: false, error: "NOT_FOUND" };
  saveStateDebounced();
  logEvent("login-deleted", { site, id });
  return { ok: true, logins: sanitizedLogins(site) };
});

ipcMain.handle("logins:fill", async (_evt, { site, id }) => {
  if (!SITES[site]) return { ok: false, error: "BAD_SITE" };
  const entry = (state.savedLogins[site] || []).find((l) => l.id === id);
  if (!entry) return { ok: false, error: "NOT_FOUND" };
  const view = siteViews[site];
  if (!view || view.webContents.isDestroyed()) return { ok: false, error: "NO_VIEW" };
  let password;
  try {
    password = safeStorage.decryptString(Buffer.from(entry.encryptedPassword, "base64"));
  } catch {
    logEvent("login-fill-error", { site, id, label: entry.label, error: "DECRYPT_FAILED" });
    return { ok: false, error: "DECRYPT_FAILED" };
  }
  logEvent("login-fill-started", { site, id, label: entry.label }); // never username/password
  let res;
  try {
    res = await view.webContents.executeJavaScript(buildLoginFillScript(site, entry.username, password), true);
  } catch (e) {
    res = { ok: false, error: String(e) };
  }
  logEvent(res && res.ok ? "login-fill-ok" : "login-fill-error", {
    site, id, label: entry.label,
    error: (res && res.error) || null, warning: (res && res.warning) || null,
    filled: (res && res.filled) || null, submitted: (res && res.submitted) || false
  });
  return res || { ok: false, error: "unknown" };
});

// Extracted so the Tuner (see below) can run the exact same connectivity
// check the 🧪 Test button does, on multiple sites, without duplicating the
// send/wait/log logic. The ipcMain handler is now a thin wrapper.
async function runConnectivityTest(site) {
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
}

ipcMain.handle("selftest:run", async (_evt, { site }) => {
  if (tunerInFlight.active) return { ok: false, error: "TUNER_RUNNING" };
  return runConnectivityTest(site);
});

// --- The Tuner: a one-click diagnostic that answers "is the connection
// between the AIs actually working" -- not just "can I reach each one
// individually" (the 🧪 Test button already answers that), but "does a
// message genuinely get from A to B." Root-caused from a real live-testing
// session's duplicate-delivery/relay findings: the request was for
// something the models themselves could be run through, whose output tells
// you exactly what to fix to get to 100%.
//
// The relay-leg check deliberately uses MESH routing (a temporary
// routing:set on just the pair being tested, restored after), not tag
// routing -- mesh forwards a site's captured reply verbatim regardless of
// whether the model correctly formats a [TO: X] tag, which removes one
// whole axis of "is this a relay bug or a formatting-compliance quirk"
// ambiguity from the result.
//
// The harder problem this has to solve: pollSite() only ever reads what an
// AI's OWN reply says, never what it received -- so "prove B actually got
// A's message" requires B to produce some checkable reply, which means
// asking the model to do SOMETHING with what it receives. Asking a model to
// "relay this text literally without answering it" is fragile in practice
// (models tend to answer what's in front of them rather than pass it
// through inertly). Instead, ONE question is asked that works for both
// hops: source, addressed directly, replies "RELAY-TEST <token>" plus a
// trailing conditional instruction. Mesh then forwards that ENTIRE reply
// (instruction included) to target, now wrapped in "[Source says] ...".
// Target, seeing itself addressed via a forward rather than directly,
// follows the ELSE branch and replies "RELAY-RECEIVED <token>" instead. No
// model is ever asked to suppress its own reasoning and blindly forward
// something -- both hops just answer the message actually in front of them.
const RELAY_LEG_TIMEOUT_MS = 45000;
const RELAY_FORWARD_WAIT_MS = 20000; // how long to wait for the internal mesh forward to show up in the delivery ledger before giving up on distinguishing "forward never sent" from "target never replied"
async function waitForLiteralReply(site, expectedSubstring, sentTs, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const cap = state.captured[site];
    if (cap && cap.ts >= sentTs && cap.text.includes(expectedSubstring)) return { ok: true, text: cap.text.slice(0, 200) };
    await new Promise((r) => setTimeout(r, SELFTEST_POLL_MS));
  }
  const cap = state.captured[site];
  if (cap && cap.ts >= sentTs) return { ok: false, error: "MISMATCH", text: cap.text.slice(0, 200) };
  return { ok: false, error: "TIMEOUT" };
}

// A relay leg that never gets a reply from target could mean two very
// different things: the internal mesh forward from source to target never
// even went out (a send-side problem, same as any other SEND_NOT_CONFIRMED),
// or it went out fine and target just never answered (a target-side
// problem). Without checking, both looked identical -- a bare TIMEOUT --
// which points a fix at the wrong AI. The delivery ledger (already recorded
// for every send, see recordLedgerEntry()) makes this checkable: watch for
// the specific (source, target) entry this leg's forward would produce.
async function waitForLedgerEntry(source, target, sentTs, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const entry = state.ledger.find((e) => e.source === source && e.target === target && e.ts >= sentTs);
    if (entry) return entry;
    await new Promise((r) => setTimeout(r, SELFTEST_POLL_MS));
  }
  return null;
}

async function runRelayLegTest(source, target) {
  const leg = `${source}->${target}`;
  const token = makeSelftestToken();
  // Only add the routing pair if it isn't already there, and only remove it
  // afterward if THIS test was the one that added it -- never clobber a
  // routing setup the user deliberately configured themselves.
  const alreadyRouted = state.routing[source].has(target);
  if (!alreadyRouted) state.routing[source].add(target);
  logEvent("tuner-leg-started", { source, target, leg, token });
  try {
    const prompt = `[AutoInjector automated relay test -- not a real task] Reply with EXACTLY this and nothing else: RELAY-TEST ${token}\nIf you're seeing this specific message because it was forwarded to you by another AI (rather than sent to you directly by the operator), instead reply with EXACTLY: RELAY-RECEIVED ${token}`;
    const sentTs = Date.now();
    const sendRes = await sendTextTo(source, prompt, null);
    if (!sendRes || !sendRes.ok) {
      const error = (sendRes && sendRes.error) || "unknown";
      logEvent("tuner-leg-error", { source, target, leg, stage: "source-send", error });
      return { ok: false, leg, source, target, stage: "source-send", error };
    }
    const sourceWait = await waitForLiteralReply(source, `RELAY-TEST ${token}`, sentTs, RELAY_LEG_TIMEOUT_MS);
    if (!sourceWait.ok) {
      logEvent("tuner-leg-error", { source, target, leg, stage: "source-reply", error: sourceWait.error, capturedText: sourceWait.text || null });
      return { ok: false, leg, source, target, stage: "source-reply", error: sourceWait.error, text: sourceWait.text };
    }

    // Source answered correctly -- pollSite() should now automatically mesh-
    // forward that reply on to target. Check the ledger for that specific
    // delivery before falling back to waiting on target's own reply, so a
    // forward that silently failed to send is reported as exactly that
    // instead of masquerading as "target never answered".
    const forwardEntry = await waitForLedgerEntry(source, target, sentTs, RELAY_FORWARD_WAIT_MS);
    if (forwardEntry && forwardEntry.status === "failed") {
      logEvent("tuner-leg-error", { source, target, leg, stage: "forward-send", error: forwardEntry.error });
      return { ok: false, leg, source, target, stage: "forward-send", error: forwardEntry.error };
    }

    const relayWait = await waitForLiteralReply(target, `RELAY-RECEIVED ${token}`, sentTs, RELAY_LEG_TIMEOUT_MS);
    if (!relayWait.ok) {
      logEvent("tuner-leg-error", { source, target, leg, stage: "relay", error: relayWait.error, capturedText: relayWait.text || null });
      return { ok: false, leg, source, target, stage: "relay", error: relayWait.error, text: relayWait.text };
    }
    logEvent("tuner-leg-ok", { source, target, leg });
    return { ok: true, leg, source, target };
  } finally {
    if (!alreadyRouted) state.routing[source].delete(target);
  }
}

ipcMain.handle("tuner:run", async () => {
  if (tunerInFlight.active) return { ok: false, error: "ALREADY_RUNNING" };
  tunerInFlight.active = true;
  logEvent("tuner-started", {});
  broadcast("tuner-state", { active: true, phase: "starting" });
  const sites = {};
  const legs = {};
  try {
    for (const site of SITE_IDS) {
      broadcast("tuner-state", { active: true, phase: "site", site });
      sites[site] = await runConnectivityTest(site);
    }
    for (const source of SITE_IDS) {
      for (const target of SITE_IDS) {
        if (source === target) continue;
        const leg = `${source}->${target}`;
        broadcast("tuner-state", { active: true, phase: "leg", leg });
        legs[leg] = await runRelayLegTest(source, target);
      }
    }
    const summary = {
      sitesOk: Object.values(sites).filter((r) => r.ok).length,
      sitesTotal: SITE_IDS.length,
      legsOk: Object.values(legs).filter((r) => r.ok).length,
      legsTotal: Object.keys(legs).length
    };
    logEvent("tuner-done", summary);
    broadcast("tuner-state", { active: false, phase: "done", sites, legs, summary });
    return { ok: true, sites, legs, summary };
  } finally {
    tunerInFlight.active = false;
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
  // AI-003: validate endpoints, timeouts, turn/cost limits, and the adjudicator
  // BEFORE saving, so bad values can't produce instant timeouts, ineffective
  // safeguards, or a key sent in the clear to a remote host.
  if (config.timeoutMs != null && (!Number.isFinite(config.timeoutMs) || config.timeoutMs < 1000 || config.timeoutMs > 600000)) return { ok: false, error: "BAD_TIMEOUT" };
  if (config.maximumTurns != null && (!Number.isInteger(config.maximumTurns) || config.maximumTurns < 1 || config.maximumTurns > 1000)) return { ok: false, error: "BAD_MAX_TURNS" };
  if (config.costLimit != null && (!Number.isFinite(config.costLimit) || config.costLimit < 0)) return { ok: false, error: "BAD_COST_LIMIT" };
  if (config.adjudicatorSite != null && config.adjudicatorSite !== "" && !SITES[config.adjudicatorSite]) return { ok: false, error: "BAD_ADJUDICATOR" };
  if (config.endpoint != null && config.endpoint !== "") {
    let url;
    try { url = new URL(config.endpoint); } catch (_) { return { ok: false, error: "BAD_ENDPOINT" }; }
    if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, error: "BAD_ENDPOINT" };
    const isLocal = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1";
    // A key going to a non-local host must go over HTTPS (no plaintext secrets).
    const keyPresent = config.apiKey !== undefined ? !!config.apiKey : !!state.managerConfig.apiKey;
    if (keyPresent && !isLocal && url.protocol !== "https:") return { ok: false, error: "INSECURE_REMOTE_KEY" };
  }
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

// N5 Tools: list the registry and (for the dashboard/manual testing) run a tool.
ipcMain.handle("tools:list", () => ({ ok: true, tools: toolProvider.list() }));
ipcMain.handle("tools:run", async (_evt, { tool, args } = {}) => {
  if (!tool || !toolProvider.has(tool)) return { ok: false, error: "UNKNOWN_TOOL" };
  return toolProvider.run(tool, args || {});
});

// N3 Memory: a summary line for the panel, plus a manual search.
ipcMain.handle("memory:summary", () => ({ ok: true, ...dbService.memorySummary() }));
ipcMain.handle("memory:search", (_evt, { query } = {}) => ({ ok: true, ...dbService.memorySearch(query || "") }));

// N2 Voice: status/config/test + push-to-talk listen.
ipcMain.handle("voice:status", () => ({ ok: true, ...voiceProvider.status() }));
ipcMain.handle("voice:configure", (_evt, patch) => {
  const s = voiceProvider.setSettings(patch || {});
  logEvent("voice-config", { enabled: s.enabled, endpoint: s.endpoint, speakOnAck: s.speakOnAck });
  return { ok: true, ...voiceProvider.status() };
});
ipcMain.handle("voice:speak", async (_evt, { text } = {}) => voiceProvider.speak(text));
ipcMain.handle("voice:listen", async (_evt, opts = {}) => voiceProvider.listen(opts || {}));

// Image generation (Stable Diffusion): status/config + a manual generate for the
// wizard's "Test" button. Config persists in the app state snapshot.
ipcMain.handle("image:status", () => ({ ok: true, ...imageProvider.status() }));
ipcMain.handle("image:configure", (_evt, patch) => {
  imageProvider.setSettings(patch || {});
  state.imageConfig = imageProvider.getSettings();
  saveStateDebounced();
  logEvent("image-config", { enabled: state.imageConfig.enabled, endpoint: state.imageConfig.endpoint });
  return { ok: true, ...imageProvider.status() };
});
ipcMain.handle("image:generate", async (_evt, { prompt, negativePrompt } = {}) => {
  const r = await imageProvider.generate(prompt, { negativePrompt });
  if (!r || !r.ok || !r.imageBase64) return { ok: false, error: (r && r.error) || "FAILED" };
  try {
    const buf = Buffer.from(r.imageBase64, "base64");
    const sha = require("crypto").createHash("sha256").update(buf).digest("hex");
    const savedPath = outputManager.saveBuffer(outputManager.imagesDir(), `img-${Date.now()}.png`, buf);
    try { dbService.recordImage({ path: savedPath, prompt, model: imageProvider.status().model, from: "wizard", sha256: sha }); } catch (_) {}
    return { ok: true, path: savedPath };
  } catch (e) { return { ok: false, error: `SAVE_FAILED: ${e}` }; }
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

// --- Local service bridge: AutoInjector as a separately callable service ----
// A thin transport layer over the SAME machinery the UI drives (sendTextTo,
// pollSite state, the Council/House-Rules engine). It reaches nothing internal
// on its own — every capability is handed in as a wrapper below. Localhost-only.
function paneReady(site) {
  const v = siteViews[site];
  if (!v || !v.webContents || v.webContents.isDestroyed()) return false;
  try { if (v.webContents.isLoading && v.webContents.isLoading()) return false; } catch (_) {}
  return true;
}
function bridgeStatus() {
  const participants = SITE_IDS.map((s) => ({
    id: s,
    label: SITES[s] ? SITES[s].label : s,
    enabled: !!state.enabled[s],
    ready: paneReady(s),
    generating: !!state.generating[s],
    waiting: !!state.waiting[s],
    lastResponseId: state.captured[s] ? state.captured[s].id : null,
    rateLimited: !!(state.captured[s] && state.captured[s].isRateLimited),
  }));
  const hr = state.hr;
  return {
    service: "autoinjector",
    participants,
    council: hr && hr.mode ? houseRuleSnapshot() : { active: false, mode: null },
    routing: routingSnapshot(),
    mesh: state.meshActive,
  };
}
function bridgeResponses({ since = 0, limit = 100, site = null } = {}) {
  let rows = state.transcript;
  if (site) rows = rows.filter((t) => t.site === site);
  if (since) rows = rows.filter((t) => t.id > since);
  return rows.slice(-limit).map((t) => ({
    id: t.id, site: t.site, label: t.label, text: t.text, ts: t.ts,
    roundtableTag: t.roundtableTag || null,
    isRateLimited: !!t.isRateLimited,
    isVerdict: !!t.isVerdict,
  }));
}
async function bridgeSendTo(site, text) {
  if (!SITES[site]) return { ok: false, error: "BAD_SITE" };
  if (!text || !String(text).trim()) return { ok: false, error: "NEED_TEXT" };
  try { dbService.recordUserMessage(String(text), [site]); } catch (_) {}
  // Teach the reply envelope, same as the UI's Compose path, so the reply comes
  // back with its [FROM:] tag and is captured on the baseline path.
  return sendTextTo(site, withEnvelope(String(text), site), null);
}
async function bridgeSendAll(text, targets) {
  if (!text || !String(text).trim()) return { ok: false, error: "NEED_TEXT" };
  const list = (Array.isArray(targets) ? targets : SITE_IDS.filter((s) => state.enabled[s])).filter((s) => SITES[s]);
  if (!list.length) return { ok: false, error: "NO_TARGETS" };
  const results = {};
  for (const s of list) results[s] = await bridgeSendTo(s, text);
  return { results };
}
const serviceBridge = createServiceBridge({
  version: "1.0.0",
  log: logEvent,
  status: bridgeStatus,
  responses: bridgeResponses,
  sendTo: bridgeSendTo,
  sendAll: bridgeSendAll,
  councilStart: startCouncil,
  councilStop: async () => stopCouncil(),
  subscribe: (fn) => { broadcastListeners.add(fn); return () => broadcastListeners.delete(fn); },
  // Open Interpreter "run code / control computer" capability, exposed through
  // the same local API so the merged system (PersonalJarvis, etc.) can drive it.
  interpreter: {
    status: () => interpreterProvider.status(),
    configure: (patch) => interpreterProvider.setSettings(patch),
    run: (task, o) => interpreterProvider.run(task, o),
  },
  // The native "Jarvis": AutoInjector's System AI supervisor, which plans and
  // orchestrates the Council (the 3 web AIs) + Open Interpreter to reach a goal.
  jarvis: {
    status: () => ({ manager: managerSnapshot() }),
    start: async (goal) => startManagedTask(goal),
    stop: async () => stopManagedTask(),
  },
  // N5: the butler's external-tool registry, exposed so the merged system can
  // list and invoke tools (and, later, register MCP servers' tools).
  tools: {
    list: () => toolProvider.list(),
    run: (name, args, o) => toolProvider.run(name, args, o),
  },
  // N2: local voice capability (speak/listen through the offline shim).
  voice: {
    status: () => voiceProvider.status(),
    configure: (patch) => voiceProvider.setSettings(patch),
    speak: (text) => voiceProvider.speak(text),
    listen: (o) => voiceProvider.listen(o),
  },
  // Image generation (Stable Diffusion) as a callable capability on the bridge.
  image: {
    status: () => imageProvider.status(),
    configure: (patch) => imageProvider.setSettings(patch),
    generate: (prompt, o) => imageProvider.generate(prompt, o),
  },
});
// Configure Open Interpreter from env at boot (endpoint/model/auto-run), if set.
if (process.env.AUTOINJECTOR_INTERPRETER_ENDPOINT) {
  interpreterProvider.setSettings({
    enabled: true,
    endpoint: process.env.AUTOINJECTOR_INTERPRETER_ENDPOINT,
    model: process.env.AUTOINJECTOR_INTERPRETER_MODEL || "",
    apiKey: process.env.AUTOINJECTOR_INTERPRETER_TOKEN || "",
    autoRun: process.env.AUTOINJECTOR_INTERPRETER_AUTORUN === "1",
  });
}
// Managed mode: let AutoInjector RUN the Open Interpreter shim itself, so the
// user doesn't have to start anything. AUTOINJECTOR_INTERPRETER_SPAWN is the
// command (e.g. "python"); the shim path + port are supplied alongside. It's
// spawned on app-ready and stopped on quit; a failure never blocks startup.
async function startManagedInterpreter() {
  const command = process.env.AUTOINJECTOR_INTERPRETER_SPAWN;
  if (!command) return;
  const shim = process.env.AUTOINJECTOR_INTERPRETER_SHIM || path.join(__dirname, "..", "integrations", "open-interpreter", "interpreter_shim.py");
  const port = Number(process.env.AUTOINJECTOR_INTERPRETER_PORT) || 8231;
  try {
    const r = await interpreterProvider.startManaged({
      command,
      args: [shim, "--port", String(port)],
      port,
      env: {
        INTERPRETER_MODEL: process.env.AUTOINJECTOR_INTERPRETER_MODEL || "",
        INTERPRETER_API_BASE: process.env.AUTOINJECTOR_INTERPRETER_API_BASE || "",
      },
      onLog: (kind, text) => logEvent("interpreter-shim", { kind, text: String(text).slice(0, 300) }),
    });
    logEvent(r && r.ok ? "interpreter-managed-started" : "interpreter-managed-failed", r || {});
  } catch (e) { logEvent("interpreter-managed-error", { error: String(e) }); }
}
// N2: like the interpreter shim, the app can run the local voice shim itself.
// AUTOINJECTOR_VOICE_SPAWN is the command (e.g. "python"); the shim path + port
// follow. Spawned on ready, stopped on quit; a failure never blocks startup.
async function startManagedVoice() {
  const command = process.env.AUTOINJECTOR_VOICE_SPAWN;
  if (!command) return;
  const shim = process.env.AUTOINJECTOR_VOICE_SHIM || path.join(__dirname, "..", "integrations", "voice", "voice_shim.py");
  const port = Number(process.env.AUTOINJECTOR_VOICE_PORT) || 8232;
  try {
    const r = await voiceProvider.startManaged({
      command,
      args: [shim, "--port", String(port)],
      port,
      env: {
        VOICE_TTS_MODEL: process.env.AUTOINJECTOR_VOICE_TTS_MODEL || "",
        VOICE_STT_MODEL: process.env.AUTOINJECTOR_VOICE_STT_MODEL || "",
      },
      onLog: (kind, text) => logEvent("voice-shim", { kind, text: String(text).slice(0, 300) }),
    });
    logEvent(r && r.ok ? "voice-managed-started" : "voice-managed-failed", r || {});
  } catch (e) { logEvent("voice-managed-error", { error: String(e) }); }
}
async function startServiceBridge() {
  if (process.env.AUTOINJECTOR_BRIDGE === "0") return; // opt-out (tests set this)
  const port = Number(process.env.AUTOINJECTOR_BRIDGE_PORT) || 8765;
  const host = process.env.AUTOINJECTOR_BRIDGE_HOST || "127.0.0.1";
  const token = process.env.AUTOINJECTOR_BRIDGE_TOKEN || null;
  try {
    const r = await serviceBridge.start({ port, host, token });
    if (r && r.ok) logEvent("bridge-started", { url: r.url, tokenProtected: !!token });
    else logEvent("bridge-start-failed", { error: r && r.error });
  } catch (e) { logEvent("bridge-start-error", { error: String(e) }); }
}

app.whenReady().then(() => {
  loadPersistedState();
  try { const s = dbService.init(userDataDir()); logEvent("db-init", { available: s.available, reason: s.reason }); }
  catch (e) { logEvent("db-init-error", { error: String(e) }); }
  try { const r = outputManager.init(app.getPath("documents")); logEvent("output-init", { root: r }); toolProvider.configure({ outputRoot: r }); } catch (e) { logEvent("output-init-error", { error: String(e) }); }
  try { buildAppMenu(); } catch (e) { logEvent("menu-init-error", { error: String(e) }); }
  createWindow();
  startServiceBridge();
  startManagedInterpreter();
  startManagedVoice();
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("activate", () => { if (!win) createWindow(); });
app.on("before-quit", () => { try { serviceBridge.stop(); } catch (_) {} try { interpreterProvider.stopManaged(); } catch (_) {} try { voiceProvider.stopManaged(); } catch (_) {} });
