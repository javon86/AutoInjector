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

const DEFAULT_TIMEOUT_MS = 180000;

// The full action vocabulary the manager is allowed to choose from. Kept
// here (not duplicated in main.js) so the system prompt and the executor's
// allowlist can never drift out of sync with each other.
const MANAGER_ACTIONS = [
  "CLASSIFY", "PLAN", "DELEGATE", "SEND", "FORWARD", "COMPARE", "CRITIQUE",
  "VERIFY", "EXTRACT", "ASSEMBLE", "REVISE", "VALIDATE", "SAVE", "EXPORT",
  "ESCALATE", "WAIT", "FINISH", "PAUSE", "REQUEST_APPROVAL"
];

const MANAGER_SYSTEM_PROMPT = `You are the manager/orchestrator for AutoInjector, a program that relays work between three AI assistants (ChatGPT, Claude, Gemini) reachable only through the "target" names chatgpt, claude, and gemini. You are a supervisor, not the primary worker: delegate substantive writing, research, analysis, and problem-solving to them whenever possible. Only do work yourself when delegation is unavailable or unnecessary (e.g. classifying a request, deciding on a plan, or judging whether a result satisfies the user).

You must respond with a single JSON object and nothing else -- no prose, no markdown fences, no commentary before or after it. The object must have an "action" field set to exactly one of: ${MANAGER_ACTIONS.join(", ")}. Include whatever other fields that action needs (for example DELEGATE needs an "assignments" array of {"target": "chatgpt"|"claude"|"gemini", "task": "..."} objects). Always include a short "reason" field explaining the decision, and a "confidence" field from 0 to 1.

You may only target chatgpt, claude, or gemini. Never propose executing arbitrary code, navigating a browser to an arbitrary destination, or accessing credentials, cookies, or browser storage -- those requests will be rejected and logged as violations, not executed.`;

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
    previousManagerActions: (managerState.previousManagerActions || []).slice(-10),
    currentTier: managerState.currentTier,
    turnNumber: managerState.turnNumber,
    maximumTurns: managerState.maximumTurns,
    status: managerState.status
  };
  return [
    { role: "system", content: MANAGER_SYSTEM_PROMPT },
    { role: "user", content: JSON.stringify(trimmed) }
  ];
}

function extractJsonObject(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Models occasionally wrap JSON in a code fence or add stray prose
    // despite instructions -- pull out the first {...} block as a fallback
    // before giving up, rather than failing on otherwise-recoverable output.
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) return null;
    try { return JSON.parse(trimmed.slice(start, end + 1)); } catch { return null; }
  }
}

function redactSecrets(text, config) {
  if (typeof text !== "string" || !config || !config.apiKey) return text;
  return text.split(config.apiKey).join("[REDACTED]");
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || DEFAULT_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

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
  let res;
  try {
    res = await fetchWithTimeout(config.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {})
      },
      body: JSON.stringify({ model: config.model, messages, temperature: 0.2 })
    }, config.timeoutMs || DEFAULT_TIMEOUT_MS);
  } catch (e) {
    const msg = e && e.name === "AbortError" ? "TIMEOUT" : `NETWORK_ERROR: ${redactSecrets(String(e), config)}`;
    return { ok: false, error: msg };
  }

  if (!res.ok) {
    let bodyText = "";
    try { bodyText = await res.text(); } catch { /* best effort */ }
    return { ok: false, error: `HTTP_${res.status}`, detail: redactSecrets(bodyText, config).slice(0, 500) };
  }

  let body;
  try {
    body = await res.json();
  } catch {
    return { ok: false, error: "INVALID_RESPONSE_BODY" };
  }

  const content = body?.choices?.[0]?.message?.content;
  const decision = extractJsonObject(content);
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
  if (res.ok) return { ok: true };
  if (res.error === "INVALID_JSON" || res.error === "UNKNOWN_ACTION") return { ok: true, warning: res.error }; // reachable, model just didn't follow format
  return { ok: false, error: res.error };
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
  testConnection,
  startPod,
  getPodStatus,
  waitUntilReady,
  stopPod
};
