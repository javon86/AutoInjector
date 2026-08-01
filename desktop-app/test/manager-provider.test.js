// test/manager-provider.test.js — tests manager-provider.js directly, no
// Electron mocking needed since it's plain Node + fetch(). Monkey-patches
// global.fetch with a canned/recording fake so the HTTP-shape logic (URL,
// headers, body, error mapping, timeout handling) is verified for real,
// without needing a live RunPod/Ollama/LM Studio backend -- same "real
// orchestration logic, mocked network boundary" split as test/run.js uses
// for Electron. Run with: node test/manager-provider.test.js
const mp = require("../manager-provider");

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ok   - ${msg}`); }
  else { failed++; console.log(`  FAIL - ${msg}`); }
  return cond;
}

const realFetch = global.fetch;
function fakeResponse({ ok = true, status = 200, jsonBody, textBody } = {}) {
  return { ok, status, json: async () => { if (jsonBody === undefined) throw new Error("no json body"); return jsonBody; }, text: async () => (textBody !== undefined ? textBody : JSON.stringify(jsonBody || {})) };
}
function withFetch(impl, fn) {
  global.fetch = impl;
  return fn().finally(() => { global.fetch = realFetch; });
}

const trivialState = { taskId: "t1", userRequest: "do the thing", plan: [], activeAssignments: [], completedAssignments: [], latestResponses: {}, allResponses: [], conflicts: [], missingRequirements: [], previousManagerActions: [], currentTier: 2, turnNumber: 1, maximumTurns: 20, status: "classifying" };
const config = { provider: "openai-compatible", endpoint: "http://localhost:11434/v1/chat/completions", apiKey: "sk-test-secret", model: "test-model", timeoutMs: 2000 };

async function testAskManagerHappyPath() {
  console.log("\n== askManager: a well-formed response is parsed and validated ==");
  let seen = null;
  await withFetch(async (url, opts) => {
    seen = { url, opts };
    return fakeResponse({ jsonBody: { choices: [{ message: { content: JSON.stringify({ action: "DELEGATE", assignments: [{ target: "chatgpt", task: "write it" }], reason: "needs a draft", confidence: 0.9 }) } }] } });
  }, async () => {
    const res = await mp.askManager(trivialState, config);
    assert(res.ok && res.decision.action === "DELEGATE", "a valid DELEGATE decision comes back parsed");
    assert(res.decision.assignments[0].target === "chatgpt", "assignment details survive round-tripping through JSON");
  });
  assert(seen.url === config.endpoint, "posts to exactly the configured endpoint, no URL guessing/construction");
  assert(seen.opts.method === "POST", "uses POST");
  assert(seen.opts.headers.Authorization === `Bearer ${config.apiKey}`, "sends the API key as a Bearer token");
  const body = JSON.parse(seen.opts.body);
  assert(body.model === config.model && Array.isArray(body.messages) && body.messages.length === 2, "request body carries the configured model and a system+user message pair");
  assert(body.messages[0].content.includes("chatgpt") && body.messages[0].content.includes("claude") && body.messages[0].content.includes("gemini"), "the system prompt names the real targets");
}

async function testAskManagerRejectsUnknownAction() {
  console.log("\n== askManager: a response naming an action outside the vocabulary is rejected, not passed through ==");
  await withFetch(async () => fakeResponse({ jsonBody: { choices: [{ message: { content: JSON.stringify({ action: "DELETE_EVERYTHING" }) } }] } }), async () => {
    const res = await mp.askManager(trivialState, config);
    assert(!res.ok && res.error === "UNKNOWN_ACTION", "an action outside MANAGER_ACTIONS is rejected at the provider layer already");
  });
}

async function testAskManagerRecoversJsonWrappedInProse() {
  console.log("\n== askManager: recovers a JSON object even if the model wrapped it in stray prose ==");
  await withFetch(async () => fakeResponse({ jsonBody: { choices: [{ message: { content: `Sure, here you go:\n\`\`\`json\n${JSON.stringify({ action: "WAIT", reason: "still working", confidence: 0.5 })}\n\`\`\`` } }] } }), async () => {
    const res = await mp.askManager(trivialState, config);
    assert(res.ok && res.decision.action === "WAIT", "extracts the {...} block even when it's not the entire message");
  });
}

async function testAskManagerInvalidJson() {
  console.log("\n== askManager: genuinely non-JSON content is reported as INVALID_JSON, not silently ignored ==");
  await withFetch(async () => fakeResponse({ jsonBody: { choices: [{ message: { content: "I don't understand the task." } }] } }), async () => {
    const res = await mp.askManager(trivialState, config);
    assert(!res.ok && res.error === "INVALID_JSON", "no recoverable JSON at all is reported distinctly");
  });
}

async function testAskManagerHttpError() {
  console.log("\n== askManager: a non-2xx HTTP response is reported with the status code, API key redacted from the body ==");
  await withFetch(async () => fakeResponse({ ok: false, status: 401, textBody: `Unauthorized: bad key ${config.apiKey}` }), async () => {
    const res = await mp.askManager(trivialState, config);
    assert(!res.ok && res.error === "HTTP_401", "the HTTP status is surfaced");
    assert(!res.detail.includes(config.apiKey), "the API key never leaks into the returned error detail");
  });
}

async function testAskManagerNetworkErrorAndTimeout() {
  console.log("\n== askManager: network failures and timeouts are reported distinctly, and the key is redacted from any error text ==");
  await withFetch(async () => { throw new Error(`connection refused (key was ${config.apiKey})`); }, async () => {
    const res = await mp.askManager(trivialState, config);
    assert(!res.ok && res.error.startsWith("NETWORK_ERROR") && !res.error.includes(config.apiKey), "a thrown network error is caught, reported, and redacted");
  });
  await withFetch((url, opts) => new Promise((resolve, reject) => {
    opts.signal.addEventListener("abort", () => { const e = new Error("aborted"); e.name = "AbortError"; reject(e); });
  }), async () => {
    const res = await mp.askManager(trivialState, { ...config, timeoutMs: 50 });
    assert(!res.ok && res.error === "TIMEOUT", "a request that never resolves within timeoutMs is reported as TIMEOUT, not left hanging");
  });
}

async function testMissingConfig() {
  console.log("\n== askManager: refuses to even attempt a call with no endpoint/model configured ==");
  const noEndpoint = await mp.askManager(trivialState, { ...config, endpoint: "" });
  assert(!noEndpoint.ok && noEndpoint.error === "NO_ENDPOINT", "missing endpoint is rejected before any network call");
  const noModel = await mp.askManager(trivialState, { ...config, model: "" });
  assert(!noModel.ok && noModel.error === "NO_MODEL", "missing model is rejected before any network call");
}

async function testTestConnection() {
  console.log("\n== testConnection: reachable-but-malformed-reply still counts as reachable; real failures don't ==");
  await withFetch(async () => fakeResponse({ jsonBody: { choices: [{ message: { content: "not json" } }] } }), async () => {
    const res = await mp.testConnection(config);
    assert(res.ok === true && res.warning === "INVALID_JSON", "an unparseable reply still proves the endpoint is reachable -- that's a model/prompt issue, not connectivity");
  });
  await withFetch(async () => { throw new Error("ECONNREFUSED"); }, async () => {
    const res = await mp.testConnection(config);
    assert(!res.ok, "a genuine network failure is reported as not connected");
  });
}

async function testRedactSecretsAndExtractJson() {
  console.log("\n== redactSecrets / extractJsonObject: the small pure helpers behave correctly on their own ==");
  assert(mp.redactSecrets("key=ABC123 rest", { apiKey: "ABC123" }) === "key=[REDACTED] rest", "redacts every occurrence of the configured key");
  assert(mp.redactSecrets("no secret here", {}) === "no secret here", "leaves text alone when there's no apiKey configured");
  assert(mp.extractJsonObject('  {"action":"FINISH"}  ') !== null, "parses a clean JSON object directly");
  assert(mp.extractJsonObject("nothing here") === null, "returns null rather than throwing on non-JSON");
}

async function testPodLifecycleRequestShape() {
  console.log("\n== RunPod dedicated-pod lifecycle: startPod/getPodStatus/stopPod hit the expected REST calls ==");
  const podConfig = { provider: "runpod-pod", apiKey: "rp-key", podId: "abc123", timeoutMs: 2000 };
  const calls = [];
  await withFetch(async (url, opts) => { calls.push({ url, method: opts.method }); return fakeResponse({ jsonBody: { desiredStatus: "RUNNING" } }); }, async () => {
    const startRes = await mp.startPod(podConfig);
    assert(startRes.ok, "startPod succeeds against a 2xx response");
    const statusRes = await mp.getPodStatus(podConfig);
    assert(statusRes.ok && statusRes.status === "RUNNING", "getPodStatus reads the pod's reported status");
    const stopRes = await mp.stopPod(podConfig);
    assert(stopRes.ok, "stopPod succeeds against a 2xx response");
  });
  assert(calls.some((c) => c.url.includes("/pods/abc123/start") && c.method === "POST"), "startPod POSTs to the pod's /start route");
  assert(calls.some((c) => c.url.includes("/pods/abc123") && c.method === "GET"), "getPodStatus GETs the pod's own route");
  assert(calls.some((c) => c.url.includes("/pods/abc123/stop") && c.method === "POST"), "stopPod POSTs to the pod's /stop route");

  const noId = await mp.startPod({ provider: "runpod-pod", apiKey: "rp-key" });
  assert(!noId.ok && noId.error === "NO_POD_ID", "refuses to act without a configured pod id");
}

async function main() {
  await testAskManagerHappyPath();
  await testAskManagerRejectsUnknownAction();
  await testAskManagerRecoversJsonWrappedInProse();
  await testAskManagerInvalidJson();
  await testAskManagerHttpError();
  await testAskManagerNetworkErrorAndTimeout();
  await testMissingConfig();
  await testTestConnection();
  await testRedactSecretsAndExtractJson();
  await testPodLifecycleRequestShape();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("Test runner crashed:", e);
  process.exit(1);
});
