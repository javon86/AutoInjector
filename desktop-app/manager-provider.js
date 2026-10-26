// manager-provider.js — the interchangeable backend for the manager/orchestrator
// "brain." This is the one deliberate, scoped exception to this project's
// no-API-keys rule: that rule has always meant "don't call ChatGPT/Claude/
// Gemini's official APIs, drive their real web UIs instead" — it was never
// about a *different*, self-hosted/rented model acting as a supervisor over
// those three. The manager talks to a model on RunPod (serverless or a
// dedicated pod), Ollama, LM Studio, or any other OpenAI-compatible chat
// completions endpoint; delegating actual work to ChatGPT/Claude/Gemini still
// goes exclusively through sendTextTo()/pollSite() in main.js, unchanged.
//
// Every provider here (including RunPod Serverless, when pointed at RunPod's
// own vLLM/text-generation workers) speaks the same OpenAI-compatible
// chat-completions shape, so askManager() itself doesn't need a provider
// switch for the request/response format -- only config.endpoint and
// config.apiKey change. What *does* differ per provider is pod lifecycle
// (only a dedicated RunPod pod needs starting/stopping), handled by the
// separate startPod/getPodStatus/waitUntilReady/stopPod functions.
//
// NONE of this has been run against a real RunPod/Ollama/LM Studio backend
// from this dev environment (no network path to one here) -- same caveat as
// every DOM selector in this app: the shape is standard and carefully
// matched to each provider's documented API, but real-world verification
// has to happen against your actual account/instance.

const client = require("./openai-client");
const DEFAULT_TIMEOUT_MS = 180000;

// The full action vocabulary the manager is allowed to choose from. Kept
// here (not duplicated in main.js) so the system prompt and the executor's
// allowlist can never drift out of sync with each other.
const MANAGER_ACTIONS = [
  "CLASSIFY", "PLAN", "DELEGATE", "SEND", "FORWARD", "COMPARE", "CRITIQUE",
  "VERIFY", "EXTRACT", "ASSEMBLE", "REVISE", "VALIDATE", "SAVE", "EXPORT",
  "ESCALATE", "WAIT", "FINISH", "PAUSE", "REQUEST_APPROVAL",
  "RUN_CODE", "USE_TOOL", "REMEMBER", "RECALL", "GENERATE_IMAGE", "SETUP"
];

const MANAGER_SYSTEM_PROMPT = `You are the manager/orchestrator for AutoInjector, a program that relays work between three AI assistants (ChatGPT, Claude, Gemini) reachable only through the "target" names chatgpt, claude, and gemini. You are a supervisor, not the primary worker: delegate substantive writing, research, analysis, and problem-solving to them whenever possible. Only do work yourself when delegation is unavailable or unnecessary (e.g. classifying a request, deciding on a plan, or judging whether a result satisfies the user).

You must respond with a single JSON object and nothing else -- no prose, no markdown fences, no commentary before or after it. The object must have an "action" field set to exactly one of: ${MANAGER_ACTIONS.join(", ")}. Include whatever other fields that action needs (for example DELEGATE needs an "assignments" array of {"target": "chatgpt"|"claude"|"gemini", "task": "..."} objects). Always include a short "reason" field explaining the decision, and a "confidence" field from 0 to 1.

You also command several non-AI capabilities:

RUN_CODE. When a step needs actual code run or the computer operated (compute something, read/transform a file, run a script, check the system), respond with {"action":"RUN_CODE","task":"<plain-language task>","reason":"..."}. That task is carried out by Open Interpreter, a separate sandboxed local agent with its own confirmation controls -- its result (the assistant summary plus the code it ran and the output) comes back to you as a codeRuns entry on the next turn, and you fold it into the deliverable like any other result. Prefer delegating writing/research/analysis to chatgpt/claude/gemini; use RUN_CODE for genuine execution.

USE_TOOL. To invoke a registered external tool, respond with {"action":"USE_TOOL","tool":"<tool name>","args":{...},"reason":"..."}. Only use a tool named in the availableTools list you are given; its result comes back as a toolCalls entry on the next turn. Use tools for capabilities the chat AIs and RUN_CODE do not cover (e.g. fetching a specific URL, reading a produced file). Do not invent tool names.

GENERATE_IMAGE. To create a picture, respond with {"action":"GENERATE_IMAGE","prompt":"<image description>","reason":"..."}. The prompt is rendered by a local Stable Diffusion endpoint and the saved image path comes back as an images entry on the next turn. The chat AIs can refine the wording of the prompt, but only GENERATE_IMAGE actually renders it. Use it when the deliverable needs an actual image (a cover, an illustration, a diagram mock).

REMEMBER / RECALL. You have a persistent memory store. To save a durable fact for later, respond with {"action":"REMEMBER","fact":"<the fact>","reason":"..."}. To look something up, respond with {"action":"RECALL","query":"<search terms>","reason":"..."} -- matching facts come back as a memories entry on the next turn. Relevant memories are also seeded for you automatically at the start of a task, so check the memories list before re-deriving something you may already know.

SETUP. You can install your own dependencies. If a capability you need is missing (RUN_CODE unavailable because Open Interpreter isn't installed, voice off, no local model), respond with {"action":"SETUP","target":"<one of the setupTargets ids>","reason":"..."} -- for a local model you may add {"model":"<ollama model tag>"}. Only use a target id listed in the setupTargets you are given; its result comes back as a setups entry next turn and, on success, the capability is wired up for you automatically. Open Interpreter ("open-interpreter") is the keystone: install it first when you need to run code. Do not invent target ids.

You are given an awareness object each turn describing the panes (which are enabled/ready/busy/rate-limited/available) and what has worked before (capabilities). Do not DELEGATE to a pane whose available flag is false -- pick an available one, or WAIT.

For DELEGATE/SEND/FORWARD/COMPARE/CRITIQUE/VERIFY you may only target chatgpt, claude, or gemini. Never propose running code INSIDE those chat pages, navigating a browser to an arbitrary destination, or accessing their credentials, cookies, or browser storage -- those requests will be rejected and logged as violations. Real code execution goes through the RUN_CODE action only.

If the input has a non-empty "notes" list, obey it before anything else: an action listed there as blocked must not be proposed again unchanged, and a correction shows the exact JSON shape to use.`;

// Keeps the prompt sent to a (likely smaller, cheaper) manager model bounded
// -- allResponses in particular can grow large over a long-running task, so
// only the fields actually useful for the next decision are included, and
// long text fields are capped rather than sent in full.
const FIELD_CHAR_CAP = 4000;
function cap(value) {
  if (typeof value !== "string") return value;
  return value.length > FIELD_CHAR_CAP ? `${value.slice(0, FIELD_CHAR_CAP)}… [truncated, ${value.length} chars total]` : value;
}

function buildManagerPrompt(managerState) {
  const trimmed = {
    taskId: managerState.taskId,
    userRequest: cap(managerState.userRequest),
    deliverableSpecification: managerState.deliverableSpecification,
    plan: managerState.plan,
    activeAssignments: managerState.activeAssignments,
    completedAssignments: managerState.completedAssignments,
    latestResponses: Object.fromEntries(
      Object.entries(managerState.latestResponses || {}).map(([site, text]) => [site, cap(text)])
    ),
    conflicts: managerState.conflicts,
    missingRequirements: managerState.missingRequirements,
    codeRuns: (managerState.codeRuns || []).slice(-6).map((c) => ({
      id: c.id, task: cap(c.task), ok: c.ok, message: cap(c.message), error: c.error || null,
    })),
    toolCalls: (managerState.toolCalls || []).slice(-6).map((t) => ({
      id: t.id, tool: t.tool, ok: t.ok, message: cap(t.message), error: t.error || null,
    })),
    memories: (managerState.memories || []).slice(-12).map((mm) => ({
      id: mm.id, type: mm.type, title: cap(mm.title),
    })),
    images: (managerState.images || []).slice(-6).map((im) => ({
      id: im.id, prompt: cap(im.prompt), path: im.path, ok: im.ok, error: im.error || null,
    })),
    setups: (managerState.setups || []).slice(-6).map((sp) => ({
      id: sp.id, target: sp.target, ok: sp.ok, message: cap(sp.message), error: sp.error || null,
    })),
    availableTools: (managerState.availableTools || []).map((t) => ({
      name: t.name, description: t.description, risk: t.risk || "monitor",
    })),
    setupTargets: (managerState.setupTargets || []).map((s) => ({
      id: s.id, label: s.label, kind: s.kind, installed: s.installed,
    })),
    awareness: managerState.awareness || null,
    previousManagerActions: (managerState.previousManagerActions || []).slice(-10),
    currentTier: managerState.currentTier,
    turnNumber: managerState.turnNumber,
    maximumTurns: managerState.maximumTurns,
    status: managerState.status,
    handlingMode: managerState.handlingMode || "auto",
    // Loop-guard notes: actions blocked for this task after failing, and the
    // exact JSON shape to use after a rejected step. Obey these first.
    notes: guardNotes(managerState.guard),
    adjudication: managerState.adjudication || null
  };
  const messages = [{ role: "system", content: MANAGER_SYSTEM_PROMPT }];
  // Handling mode steers WHO does the work. "self" = do it locally on this
  // computer; "delegate" = route it to the chat AIs; "auto" = the butler decides.
  const mode = managerState.handlingMode;
  if (mode === "self") {
    messages.push({ role: "system", content: "HANDLING MODE — SELF: The user wants YOU to carry out this task directly on their computer. Strongly prefer RUN_CODE, SETUP, USE_TOOL, SAVE, REMEMBER/RECALL, GENERATE_IMAGE and other local actions. Do NOT DELEGATE / SEND / FORWARD / COMPARE / CRITIQUE to ChatGPT, Claude or Gemini unless it is genuinely impossible to do it locally — and if you must, say why in the reason." });
  } else if (mode === "delegate") {
    messages.push({ role: "system", content: "HANDLING MODE — DELEGATE: The user wants you to route this to the chat AIs. Prefer DELEGATE / COMPARE / CRITIQUE to ChatGPT, Claude and Gemini and assemble their answers. Avoid RUN_CODE / SETUP unless the delegated answers make it necessary." });
  }
  messages.push({ role: "user", content: JSON.stringify(trimmed) });
  return messages;
}

// Converse mode: a plain conversational reply from the local model — no JSON,
// no actions, no task. Used when the user just wants to talk to the butler and
// hear back. History is a short array of prior {role, content} turns for context.
async function chatWithButler(userMessage, config, opts = {}) {
  if (!config || !config.endpoint) return { ok: false, error: "NO_ENDPOINT" };
  if (!config.model) return { ok: false, error: "NO_MODEL" };
  const sys = "You are the user's personal butler — a helpful AI assistant running locally on their computer. You oversee three web AIs (ChatGPT, Claude, Gemini) and can run code, install software, generate images/video and manage files, but right now you are simply having a conversation. Reply directly, warmly and briefly in plain prose — never JSON, never tool syntax. If the user is actually asking you to DO something (install, run code, delegate to the AIs), tell them to send it as a task (or turn off Converse mode) and you'll get right on it.";
  const messages = [{ role: "system", content: sys }];
  for (const h of (opts.history || []).slice(-8)) {
    if (h && (h.role === "user" || h.role === "assistant") && typeof h.content === "string") messages.push({ role: h.role, content: h.content });
  }
  messages.push({ role: "user", content: String(userMessage || "").slice(0, 4000) });
  const r = await client.chatCompletion({
    endpoint: config.endpoint, apiKey: config.apiKey, model: config.model,
    messages, temperature: 0.6, timeoutMs: config.timeoutMs || DEFAULT_TIMEOUT_MS
  });
  if (!r.ok) {
    if (r.kind === "timeout") return { ok: false, error: "TIMEOUT" };
    if (r.kind === "network") return { ok: false, error: `NETWORK_ERROR: ${redactSecrets(r.detail, config)}` };
    if (r.kind === "http") return { ok: false, error: `HTTP_${r.status}`, detail: redactSecrets(r.detail || "", config).slice(0, 500) };
    return { ok: false, error: "INVALID_RESPONSE_BODY" };
  }
  return { ok: true, text: String(r.content == null ? "" : r.content).trim() };
}

// AI-006: JSON extraction, secret redaction and the timed fetch are the shared
// OpenAI-compatible client. These thin wrappers keep this module's existing
// signatures (redactSecrets takes a config) so every call site is unchanged.
const extractJsonObject = client.extractJsonObject;
function redactSecrets(text, config) { return client.redactSecrets(text, config && config.apiKey); }
function fetchWithTimeout(url, options, timeoutMs) { return client.fetchWithTimeout(url, options, timeoutMs || DEFAULT_TIMEOUT_MS); }

// The one HTTP shape every supported provider speaks: an OpenAI-compatible
// POST {endpoint} with {model, messages}, Authorization: Bearer <apiKey>.
// RunPod Serverless's own vLLM/text-generation workers expose exactly this
// at .../openai/v1/chat/completions; Ollama and LM Studio both expose it
// natively for local use; a dedicated RunPod pod running any of those
// servers is reached the same way once it's up. config.endpoint is the
// FULL url to POST to -- this app never guesses or constructs a RunPod
// endpoint id into a URL itself, since that composition is provider/worker-
// template-specific and best left to the user's own deployment.
async function askManager(managerState, config) {
  if (!config || !config.endpoint) return { ok: false, error: "NO_ENDPOINT" };
  if (!config.model) return { ok: false, error: "NO_MODEL" };

  const messages = buildManagerPrompt(managerState);
  const r = await client.chatCompletion({
    endpoint: config.endpoint, apiKey: config.apiKey, model: config.model,
    messages, temperature: 0.2, timeoutMs: config.timeoutMs || DEFAULT_TIMEOUT_MS
  });
  if (!r.ok) {
    if (r.kind === "timeout") return { ok: false, error: "TIMEOUT" };
    if (r.kind === "network") return { ok: false, error: `NETWORK_ERROR: ${redactSecrets(r.detail, config)}` };
    if (r.kind === "http") return { ok: false, error: `HTTP_${r.status}`, detail: redactSecrets(r.detail || "", config).slice(0, 500) };
    return { ok: false, error: "INVALID_RESPONSE_BODY" }; // kind:"bad-body"
  }

  let content = r.content;
  let decision = extractJsonObject(content);
  const isValid = (d) => d && typeof d === "object" && typeof d.action === "string" && MANAGER_ACTIONS.includes(d.action);
  // One repair attempt for weaker local models that answered with prose or
  // malformed JSON: hand their own reply back with a firm "JSON only" nudge and
  // a concrete example. This rescues the common case where the model *can* do
  // it but drifted, without masking a model that genuinely can't (it still ends
  // as INVALID_JSON/UNKNOWN_ACTION after the retry).
  if (!isValid(decision)) {
    const repairMessages = messages.concat([
      { role: "assistant", content: String(content == null ? "" : content).slice(0, 1200) },
      { role: "user", content: `That was not a valid response. Reply with ONLY a single JSON object and nothing else — no prose, no explanation, no markdown or code fences. The "action" must be exactly one of: ${MANAGER_ACTIONS.join(", ")}. Example: {"action":"PLAN","reason":"outline the steps","confidence":0.8}` },
    ]);
    const r2 = await client.chatCompletion({
      endpoint: config.endpoint, apiKey: config.apiKey, model: config.model,
      messages: repairMessages, temperature: 0, timeoutMs: config.timeoutMs || DEFAULT_TIMEOUT_MS
    });
    if (r2 && r2.ok) { const d2 = extractJsonObject(r2.content); if (d2) { decision = d2; content = r2.content; } }
  }
  if (!decision || typeof decision !== "object") return { ok: false, error: "INVALID_JSON", raw: redactSecrets(String(content).slice(0, 500), config) };
  if (typeof decision.action !== "string" || !MANAGER_ACTIONS.includes(decision.action)) {
    return { ok: false, error: "UNKNOWN_ACTION", raw: decision };
  }
  return { ok: true, decision };
}

// Lightweight reachability check for the config UI's "Test connection"
// button -- deliberately tolerant of a malformed/unexpected manager reply
// (that's a prompt/model quality problem, not a connectivity one); only a
// genuine network failure or non-2xx response counts as "not connected."
async function testConnection(config) {
  const trivialState = {
    taskId: "connection-test", userRequest: "Connection test, reply with a WAIT action.",
    plan: [], activeAssignments: [], completedAssignments: [], latestResponses: {}, allResponses: [],
    conflicts: [], missingRequirements: [], previousManagerActions: [], currentTier: config.tier || 2,
    turnNumber: 0, maximumTurns: 1, status: "testing"
  };
  const res = await askManager(trivialState, config);
  // AI-004: "reachable" (the server answered) is NOT the same as "compatible"
  // (the model followed the manager contract). Report them separately so the UI
  // shows "Server reachable ✓ / Manager format ✗" and does not enable autonomous
  // operation on a model that can't follow the format. ok requires BOTH.
  if (res.ok) return { ok: true, reachable: true, formatValid: true };
  if (res.error === "INVALID_JSON" || res.error === "UNKNOWN_ACTION") return { ok: false, reachable: true, formatValid: false, warning: res.error };
  return { ok: false, reachable: false, error: res.error };
}

// --- Loop guards ------------------------------------------------------------
// Pure helpers the managed-task loop in main.js uses to stop a small or
// confused manager model from burning every turn (the "Butler" loop: the same
// failing GENERATE_IMAGE eight times, a SEND with no assignments over and over,
// a tier-4 "decline" ruling ignored three times). Kept here, free of Electron,
// so they are unit-testable with a scripted fake model. All guard state is a
// plain JSON object (it rides along on state.manager, which is broadcast over
// IPC), never a class instance.

// Prompt-like text in log events is capped this short: the log is shared with
// the user's AI helpers, so it must not carry full copies of the user's prompts.
const LOG_TEXT_CAP = 60;
const SAME_FAILURE_LIMIT = 2; // the same action + args failing with the same code this many times stops the task
const SAME_INVALID_LIMIT = 3; // the same invalid action this many times ends the task
const NO_PROGRESS_LIMIT = 4; // this many turns with no successful action (and at least one failure) = stuck
const MAX_ADJUDICATIONS = 1; // tier-4 cloud adjudication happens at most this often per task

function capLogText(value, n = LOG_TEXT_CAP) {
  if (value == null) return value;
  const s = String(value).replace(/\s+/g, " ").trim();
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

// A log-safe copy of a manager decision: every string capped, assignment tasks
// capped, file content reduced to its length. Never throws.
function summarizeDecisionForLog(decision) {
  try {
    if (!decision || typeof decision !== "object") return decision == null ? null : capLogText(decision);
    const out = {};
    for (const [k, v] of Object.entries(decision)) {
      if (k === "content" && typeof v === "string") out.contentChars = v.length;
      else if (k === "assignments" && Array.isArray(v)) out.assignments = v.slice(0, 6).map((a) => (a && typeof a === "object") ? { target: capLogText(a.target, 20), task: capLogText(a.task) } : capLogText(a));
      else if (typeof v === "string") out[k] = capLogText(v);
      else if (v && typeof v === "object") out[k] = capLogText(JSON.stringify(v));
      else out[k] = v;
    }
    return out;
  } catch (_) { return { action: decision && decision.action ? String(decision.action) : null }; }
}

function normalizeArg(v) {
  if (v == null) return "";
  const s = typeof v === "string" ? v : (() => { try { return JSON.stringify(v); } catch (_) { return String(v); } })();
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

// What identifies "the same action" for the same-failure rule: the action plus
// its normalized arguments (for an image, the prompt).
function actionFailureKey(decision) {
  const d = decision || {};
  const a = String(d.action || "");
  switch (a) {
    case "GENERATE_IMAGE": return `${a}:${normalizeArg(d.prompt)}`;
    case "RUN_CODE": return `${a}:${normalizeArg(d.task)}`;
    case "USE_TOOL": return `${a}:${normalizeArg(d.tool)}:${normalizeArg(d.args || {})}`;
    case "SETUP": return `${a}:${normalizeArg(d.target)}:${normalizeArg(d.model)}`;
    case "SAVE": case "EXPORT": return `${a}:${normalizeArg(d.filename)}`;
    default: return `${a}:${normalizeArg(d.task || d.prompt || "")}`;
  }
}

// "HTTP_500: <long backend detail>" -> "HTTP_500". Falls back to a short,
// whitespace-normalized prefix so two different free-text errors don't match.
function errorCode(error) {
  const s = String(error == null ? "" : error).trim();
  if (!s) return "UNKNOWN";
  const m = s.match(/^[A-Z][A-Z0-9_]{2,}/);
  return m ? m[0] : s.replace(/\s+/g, " ").slice(0, 40).toLowerCase();
}

function plainActionLabel(decision) {
  const d = decision || {};
  switch (d.action) {
    case "GENERATE_IMAGE": return "image generation";
    case "RUN_CODE": return "running code";
    case "USE_TOOL": return `the ${capLogText(d.tool || "tool", 30)} tool`;
    case "SETUP": return `installing ${capLogText(d.target || "a dependency", 30)}`;
    case "SAVE": case "EXPORT": return "saving the file";
    default: return String(d.action || "that step").toLowerCase();
  }
}

function plainError(code) {
  const c = String(code || "");
  const http = c.match(/^HTTP_(\d{3})$/);
  if (http) return http[1] === "500" ? "the server hit an internal error (HTTP 500)" : `the server answered HTTP ${http[1]}`;
  if (c === "TIMEOUT") return "it timed out";
  if (/^NETWORK_ERROR/.test(c)) return "the server couldn't be reached";
  if (/^(NOT_CONFIGURED|DISABLED|NO_ENDPOINT|NOT_ENABLED)$/.test(c)) return "it isn't set up";
  if (c === "SAVE_FAILED") return "the result couldn't be saved";
  return capLogText(c, 60) || "unknown error";
}

function createTaskGuard() {
  return {
    failures: {}, // failureKey -> { code, count }
    blocked: [], // [{ key, action, code, note }] — told to the model every turn
    invalid: {}, // "<action>:<error>" -> count
    invalidTotal: 0,
    decisionsTotal: 0,
    turnsSinceSuccess: 0,
    triedSinceSuccess: [], // short "ACTION → CODE" strings since the last success
    adjudications: 0,
    hints: [], // corrective hints for the very next turn
  };
}

function pushTried(g, text) {
  g.triedSinceSuccess.push(text);
  if (g.triedSinceSuccess.length > 8) g.triedSinceSuccess.shift();
}

// Record an executed action's outcome. Returns { stop, code, message } — stop
// is true on the second identical failure (same action + args + error code).
function guardRecordOutcome(g, decision, ok, error) {
  const d = decision || {};
  if (ok) {
    g.turnsSinceSuccess = 0;
    g.triedSinceSuccess = [];
    return { stop: false };
  }
  const key = actionFailureKey(d);
  const code = errorCode(error);
  pushTried(g, `${d.action} → ${code}`);
  const prev = g.failures[key];
  const count = prev && prev.code === code ? prev.count + 1 : 1;
  g.failures[key] = { code, count };
  if (count >= SAME_FAILURE_LIMIT) {
    return { stop: true, code, message: `Stopped: ${plainActionLabel(d)} keeps failing — ${plainError(code)}` };
  }
  if (!g.blocked.some((b) => b.key === key)) {
    g.blocked.push({ key, action: d.action, code, note: `${d.action} failed with ${code}${d.action === "GENERATE_IMAGE" ? " for that prompt" : ""}. It is blocked for this task: do NOT propose it again unchanged — if it fails the same way again the task stops. Try a different approach or FINISH and tell the user.` });
    if (g.blocked.length > 10) g.blocked.shift();
  }
  return { stop: false, code };
}

// Record an invalid (rejected) decision. Returns { stop, count, hint }.
function guardRecordInvalid(g, decision, error) {
  const action = String((decision && decision.action) || "?");
  const key = `${action}:${error}`;
  g.invalid[key] = (g.invalid[key] || 0) + 1;
  g.invalidTotal++;
  g.decisionsTotal++;
  pushTried(g, `${action} → ${error}`);
  const hint = correctiveHint(action, error);
  if (hint) { g.hints = [hint]; }
  return { stop: g.invalid[key] >= SAME_INVALID_LIMIT, count: g.invalid[key], hint };
}

function guardRecordValid(g) { g.decisionsTotal++; g.hints = []; }

// The exact JSON shape a model needs after a common mistake.
function correctiveHint(action, error) {
  if (error === "MISSING_ASSIGNMENTS" || error === "BAD_ASSIGNMENT") {
    return `Your ${action} was rejected (${error}). ${action} needs an "assignments" array. Use exactly this shape: {"action":"${action}","assignments":[{"target":"claude","task":"<what to ask>"}],"reason":"<why>"} — target must be chatgpt, claude or gemini.`;
  }
  if (error === "MISSING_PROMPT") return `Your GENERATE_IMAGE was rejected (MISSING_PROMPT). Use: {"action":"GENERATE_IMAGE","prompt":"<image description>","reason":"<why>"}`;
  if (error === "MISSING_TASK") return `Your RUN_CODE was rejected (MISSING_TASK). Use: {"action":"RUN_CODE","task":"<plain-language task>","reason":"<why>"}`;
  if (error === "BAD_TIER") return `Your ESCALATE was rejected (BAD_TIER). Use: {"action":"ESCALATE","toTier":3,"reason":"<why>"}`;
  if (error === "UNSAFE_PATH" || error === "MISSING_CONTENT") return `Your ${action} was rejected (${error}). Use: {"action":"SAVE","filename":"result.md","content":"<text>","reason":"<why>"}`;
  return `Your ${action} was rejected (${error}). Choose a valid action with all its required fields, or FINISH.`;
}

// One turn finished. progress=true when something succeeded this turn (an
// action worked, or a pane replied). Returns { stuck, summary } — stuck when
// NO_PROGRESS_LIMIT turns passed with no success and at least one failure
// (a pure PLAN/WAIT thinking loop is left to the stall-break, which asks the
// user a question instead).
function guardRecordTurn(g, progress) {
  if (progress) { g.turnsSinceSuccess = 0; g.triedSinceSuccess = []; return { stuck: false }; }
  g.turnsSinceSuccess++;
  if (g.turnsSinceSuccess >= NO_PROGRESS_LIMIT && g.triedSinceSuccess.length) {
    const tried = Array.from(new Set(g.triedSinceSuccess)).slice(-4).join("; ");
    return { stuck: true, summary: `Stopped: no step has worked in the last ${g.turnsSinceSuccess} turns. Tried: ${tried}.` };
  }
  return { stuck: false };
}

// Notes for the model's next prompt: blocked actions + a corrective hint.
function guardNotes(g) {
  if (!g) return [];
  return [...(g.blocked || []).map((b) => b.note), ...(g.hints || [])].slice(-6);
}

// A manager model this small rarely follows the JSON protocol.
function isTooSmallModelName(model) {
  return /(?:^|[:\-_/\s])(?:0\.5|1|1\.5)b(?![a-z0-9.])/i.test(String(model || ""));
}
function guardInvalidRateHigh(g) {
  return !!g && g.decisionsTotal >= 4 && g.invalidTotal / g.decisionsTotal >= 0.5;
}

// Tier-4 adjudication reply -> { verdict: "DECLINE"|"APPROVE"|"GUIDANCE"|null, reason }.
// The prompt asks for a one-line "VERDICT: …" first; a structured
// {"verdict":"decline"} also counts. Without either, decline is detected
// conservatively by phrase (decline/refuse/won't/can't help/close the task).
const DECLINE_PATTERNS = [
  /\bruling\b[^\n]{0,80}\bdeclin/i,
  /\b(?:i|we)\s+(?:must\s+|have\s+to\s+|will\s+|would\s+|should\s+)?(?:respectfully\s+)?(?:decline|refuse)\b/i,
  /\bdeclin(?:e|ed|ing)\s+(?:this|the|that|your)\s+(?:request|task)\b/i,
  /\brefus(?:e|ed|ing)\s+(?:this|the|that|your)\s+(?:request|task)\b/i,
  /^\s*(?:\*\*)?\s*(?:decline|declined|refuse|refused)\b/im,
  /\b(?:i|we)\s+won['’]?t\s+(?:help|do|assist|proceed|continue|generate|create|make|produce|be\s+able)\b/i,
  /\bcan(?:['’]?t|not)\s+help\s+with\b/i,
  /\b(?:close|stop|end|terminate)\s+(?:the|this)\s+task\b/i,
  /\btreat\s+(?:a|the|this)\s+decline\b[^\n]{0,40}\bterminal\b/i,
];
function shortReason(text, verdictLine) {
  let s = String(text || "");
  if (verdictLine) s = s.replace(verdictLine, " ");
  s = s.replace(/\[[^\]]{0,60}\]/g, " ").replace(/[*#>`_]/g, " ").replace(/\s+/g, " ").trim().replace(/^[\s:;,.\-–—]+/, "");
  // First sentence, plus the next one when the first is only a header such as
  // "Ruling for task-123: decline." — capped short either way.
  const sentences = s.match(/[^.!?]+(?:[.!?]+|$)/g) || [s];
  let out = "";
  for (const sen of sentences) {
    out = `${out} ${sen.trim()}`.trim();
    if (out.length >= 60) break;
  }
  return out.length > 160 ? `${out.slice(0, 160)}…` : out;
}
function parseAdjudicationVerdict(text) {
  const t = String(text == null ? "" : text);
  if (!t.trim()) return { verdict: null, reason: "" };
  try {
    const obj = extractJsonObject(t);
    if (obj && typeof obj.verdict === "string") {
      const v = obj.verdict.trim().toUpperCase();
      if (/^(DECLINE|APPROVE|GUIDANCE)$/.test(v)) return { verdict: v, reason: capLogText(obj.reason || obj.guidance || "", 160) || shortReason(t) };
    }
  } catch (_) { /* not JSON — fall through to the text checks */ }
  const line = t.match(/^\s*(?:\*\*)?\s*verdict\s*(?:\*\*)?\s*[:\-–]\s*(?:\*\*)?\s*(APPROVE|DECLINE|GUIDANCE)\b(?:\s*\*\*)?/im)
    || t.match(/^\s*(?:\*\*)?\s*(APPROVE|DECLINE|GUIDANCE)(?:\s*\*\*)?(?=\s*(?:[:\-–—.]|$))/m);
  if (line) return { verdict: line[1].toUpperCase(), reason: shortReason(t, line[0]) };
  if (DECLINE_PATTERNS.some((re) => re.test(t))) return { verdict: "DECLINE", reason: shortReason(t) };
  return { verdict: null, reason: shortReason(t) };
}

// --- RunPod dedicated-pod lifecycle (provider: "runpod-pod" only) ---------
// Uses RunPod's REST API (api.runpod.io/v2/pod/*). This is the least-tested
// part of this file -- RunPod's pod-management surface is more likely to
// need a real-account fix than the OpenAI-compatible inference call above.
const RUNPOD_API_BASE = "https://rest.runpod.io/v1";

async function runpodRequest(config, path, options) {
  if (!config || !config.apiKey) return { ok: false, error: "NO_API_KEY" };
  let res;
  try {
    res = await fetchWithTimeout(`${RUNPOD_API_BASE}${path}`, {
      ...options,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}`, ...(options && options.headers) }
    }, config.timeoutMs || DEFAULT_TIMEOUT_MS);
  } catch (e) {
    return { ok: false, error: e && e.name === "AbortError" ? "TIMEOUT" : `NETWORK_ERROR: ${redactSecrets(String(e), config)}` };
  }
  let body = null;
  try { body = await res.json(); } catch { /* some endpoints return no body */ }
  if (!res.ok) return { ok: false, error: `HTTP_${res.status}`, detail: body };
  return { ok: true, body };
}

async function startPod(config) {
  if (!config.podId) return { ok: false, error: "NO_POD_ID" };
  return runpodRequest(config, `/pods/${config.podId}/start`, { method: "POST" });
}

async function getPodStatus(config) {
  if (!config.podId) return { ok: false, error: "NO_POD_ID" };
  const res = await runpodRequest(config, `/pods/${config.podId}`, { method: "GET" });
  if (!res.ok) return res;
  return { ok: true, status: res.body?.desiredStatus || res.body?.status || "UNKNOWN" };
}

async function waitUntilReady(config, timeoutMs) {
  const start = Date.now();
  const limit = timeoutMs || 120000;
  while (Date.now() - start < limit) {
    const status = await getPodStatus(config);
    if (status.ok && /RUNNING|READY/i.test(status.status || "")) return { ok: true };
    await new Promise((r) => setTimeout(r, 3000));
  }
  return { ok: false, error: "TIMEOUT" };
}

async function stopPod(config) {
  if (!config.podId) return { ok: false, error: "NO_POD_ID" };
  return runpodRequest(config, `/pods/${config.podId}/stop`, { method: "POST" });
}

module.exports = {
  MANAGER_ACTIONS,
  MANAGER_SYSTEM_PROMPT,
  buildManagerPrompt,
  extractJsonObject,
  redactSecrets,
  askManager,
  chatWithButler,
  testConnection,
  startPod,
  getPodStatus,
  waitUntilReady,
  stopPod,
  // loop guards
  LOG_TEXT_CAP,
  SAME_FAILURE_LIMIT,
  SAME_INVALID_LIMIT,
  NO_PROGRESS_LIMIT,
  MAX_ADJUDICATIONS,
  capLogText,
  summarizeDecisionForLog,
  actionFailureKey,
  errorCode,
  plainActionLabel,
  plainError,
  createTaskGuard,
  guardRecordOutcome,
  guardRecordInvalid,
  guardRecordValid,
  guardRecordTurn,
  guardNotes,
  correctiveHint,
  isTooSmallModelName,
  guardInvalidRateHigh,
  parseAdjudicationVerdict
};
