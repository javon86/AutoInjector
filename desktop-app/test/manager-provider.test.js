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
  console.log("\n== testConnection (AI-004): reachable is distinct from format-valid ==");
  await withFetch(async () => fakeResponse({ jsonBody: { choices: [{ message: { content: "not json" } }] } }), async () => {
    const res = await mp.testConnection(config);
    assert(res.reachable === true && res.formatValid === false && res.ok === false && res.warning === "INVALID_JSON",
      "a malformed reply is reachable but NOT a passing test (won't enable autonomous operation)");
  });
  await withFetch(async () => fakeResponse({ jsonBody: { choices: [{ message: { content: JSON.stringify({ action: "WAIT" }) } }] } }), async () => {
    const res = await mp.testConnection(config);
    assert(res.ok === true && res.reachable === true && res.formatValid === true, "a valid manager reply passes fully");
  });
  await withFetch(async () => { throw new Error("ECONNREFUSED"); }, async () => {
    const res = await mp.testConnection(config);
    assert(!res.ok && res.reachable === false, "a genuine network failure is reported as not reachable");
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

function testExtractJsonRobustness() {
  console.log("\n== extractJsonObject: tolerant of fences, prose, trailing commas, extra objects ==");
  const ex = mp.extractJsonObject;
  assert(ex('```json\n{"action":"WAIT","confidence":0.5}\n```').action === "WAIT", "pulls JSON out of a ```json fence");
  assert(ex('{"action":"PLAN","reason":"go",}').action === "PLAN", "forgives a trailing comma");
  assert(ex('Here is my decision: {"action":"FINISH","reason":"done"} — let me know!').action === "FINISH", "ignores prose around the object");
  assert(ex('{"action":"CLASSIFY"} {"action":"PLAN"}').action === "CLASSIFY", "takes the first complete object when several are present");
  assert(ex('no json here at all') === null, "genuinely non-JSON still returns null");
}

async function testAskManagerRepairRetry() {
  console.log("\n== askManager: one repair retry rescues a weak model that first answered with prose ==");
  let calls = 0;
  await withFetch(async () => {
    calls++;
    if (calls === 1) return fakeResponse({ jsonBody: { choices: [{ message: { content: "Sure! I think we should plan the work first, then delegate." } }] } });
    return fakeResponse({ jsonBody: { choices: [{ message: { content: JSON.stringify({ action: "PLAN", reason: "outline", confidence: 0.7 }) } }] } });
  }, async () => {
    const res = await mp.askManager(trivialState, config);
    assert(res.ok && res.decision.action === "PLAN", "a prose first answer is repaired into a valid action on the retry");
  });
  assert(calls === 2, "the repair costs exactly one extra call, and only when the first was unusable");
}

async function testHandlingModeDirective() {
  console.log("\n== buildManagerPrompt: the handling mode steers who does the work ==");
  const auto = mp.buildManagerPrompt({ ...trivialState, handlingMode: "auto" });
  assert(auto.length === 2, "auto mode adds no extra directive (system + user only)");
  const self = mp.buildManagerPrompt({ ...trivialState, handlingMode: "self" });
  assert(self.length === 3 && self[1].role === "system" && /SELF/.test(self[1].content) && /RUN_CODE/.test(self[1].content) && /do NOT DELEGATE/i.test(self[1].content),
    "self mode injects a 'do it locally, don't delegate' directive");
  const del = mp.buildManagerPrompt({ ...trivialState, handlingMode: "delegate" });
  assert(del.length === 3 && /DELEGATE/.test(del[1].content) && /ChatGPT, Claude and Gemini/.test(del[1].content),
    "delegate mode injects a 'route it to the AIs' directive");
  // The handling mode is also surfaced in the state JSON the model sees.
  assert(/"handlingMode":"self"/.test(self[2].content), "the user payload records the handling mode");
}

async function testChatWithButler() {
  console.log("\n== chatWithButler: a plain conversational reply, no JSON/actions ==");
  let seen = null;
  await withFetch(async (url, opts) => { seen = { url, opts }; return fakeResponse({ jsonBody: { choices: [{ message: { content: "Hello! I'm right here — what do you need?" } }] } }); }, async () => {
    const r = await mp.chatWithButler("hey, you there?", config, { history: [{ role: "user", content: "earlier" }, { role: "assistant", content: "yes" }] });
    assert(r.ok && /right here/.test(r.text), "returns the model's prose reply as text");
  });
  const body = JSON.parse(seen.opts.body);
  assert(body.messages[0].role === "system" && /butler/i.test(body.messages[0].content) && /never JSON/i.test(body.messages[0].content), "uses a conversational system prompt (no action JSON)");
  assert(body.messages.some((m) => m.role === "user" && /you there/.test(m.content)) && body.messages.some((m) => m.content === "earlier"), "includes the new message and prior history");
  const missing = await mp.chatWithButler("hi", { endpoint: "", model: "" });
  assert(!missing.ok && missing.error === "NO_ENDPOINT", "reports a missing endpoint cleanly");
}

// --- Loop guards, driven by a scripted fake manager model + a fake image
// generator that always answers HTTP 500 (the "Butler" loop from the user's
// log). The tiny driver below calls the guard API in the same order main.js's
// runManagerTurn() does, so these pin the behaviour without Electron.
function fakeImageGen500() { return { ok: false, error: "HTTP_500", detail: "NansException in VAE" }; }
function driveTask(script, opts = {}) {
  const g = mp.createTaskGuard();
  const imageGen = opts.imageGen || fakeImageGen500;
  const adjudicate = opts.adjudicate || (() => "VERDICT: GUIDANCE\nCarry on.");
  const maxTurns = opts.maxTurns || 20;
  let imageCalls = 0, adjudications = 0, tier = 2;
  const promptsSeen = [];
  for (let turn = 1; turn <= maxTurns; turn++) {
    promptsSeen.push(mp.guardNotes(g));
    const d = script(turn);
    if (d.action === "SEND" && !Array.isArray(d.assignments)) {
      const v = mp.guardRecordInvalid(g, d, "MISSING_ASSIGNMENTS");
      if (v.stop) return { end: "INVALID_STEPS", turn, imageCalls, adjudications, promptsSeen, g };
      if (mp.guardRecordTurn(g, false).stuck) return { end: "STUCK", turn, imageCalls, adjudications, promptsSeen, g };
      continue;
    }
    mp.guardRecordValid(g);
    if (d.action === "ESCALATE") {
      if (tier >= 4 || g.adjudications >= mp.MAX_ADJUDICATIONS) { tier = 3; continue; }
      tier = 4; g.adjudications++; adjudications++;
      const ruling = mp.parseAdjudicationVerdict(adjudicate(adjudications));
      if (ruling.verdict === "DECLINE") return { end: "DECLINED", reason: ruling.reason, turn, imageCalls, adjudications, promptsSeen, g };
      tier = 3;
      continue;
    }
    if (d.action === "GENERATE_IMAGE") {
      imageCalls++;
      const r = imageGen(d.prompt);
      const o = mp.guardRecordOutcome(g, d, r.ok, r.error);
      if (o.stop) return { end: "ACTION_KEEPS_FAILING", message: o.message, turn, imageCalls, adjudications, promptsSeen, g };
      if (mp.guardRecordTurn(g, r.ok).stuck) return { end: "STUCK", turn, imageCalls, adjudications, promptsSeen, g };
      continue;
    }
    if (d.action === "FINISH") return { end: "FINISHED", turn, imageCalls, adjudications, promptsSeen, g };
    if (mp.guardRecordTurn(g, false).stuck) return { end: "STUCK", turn, imageCalls, adjudications, promptsSeen, g };
  }
  return { end: "MAX_TURNS_EXCEEDED", imageCalls, adjudications, promptsSeen, g };
}

function testGuardSameFailureTwice() {
  console.log("\n== loop guard: the same failing image prompt stops after the second identical failure ==");
  const prompt = "A cozy reading nook, watercolor";
  const r = driveTask(() => ({ action: "GENERATE_IMAGE", prompt, reason: "picture" }));
  assert(r.end === "ACTION_KEEPS_FAILING" && r.turn === 2 && r.imageCalls === 2, `stops on the 2nd identical failure (end ${r.end}, turn ${r.turn}, calls ${r.imageCalls})`);
  assert(r.message === "Stopped: image generation keeps failing — the server hit an internal error (HTTP 500)", `plain user status (got "${r.message}")`);
  assert(r.promptsSeen[1].some((n) => /GENERATE_IMAGE failed with HTTP_500/.test(n) && /blocked for this task/.test(n)), "turn 2's prompt tells the model the action is blocked for this task");
  const ws = driveTask((t) => ({ action: "GENERATE_IMAGE", prompt: t === 1 ? "A Cozy  reading nook" : "a cozy reading NOOK " }));
  assert(ws.end === "ACTION_KEEPS_FAILING" && ws.turn === 2, "prompts that differ only in case/whitespace count as the same action");
  const g = mp.createTaskGuard();
  mp.guardRecordOutcome(g, { action: "GENERATE_IMAGE", prompt: "x" }, false, "HTTP_500: boom");
  const other = mp.guardRecordOutcome(g, { action: "GENERATE_IMAGE", prompt: "x" }, false, "TIMEOUT");
  assert(!other.stop, "a different error code on the second try is not 'the same failure'");
  assert(mp.errorCode("HTTP_500: long backend detail") === "HTTP_500" && mp.errorCode("") === "UNKNOWN", "errorCode extracts the leading code");
  assert(mp.actionFailureKey({ action: "USE_TOOL", tool: "echo", args: { a: 1 } }) !== mp.actionFailureKey({ action: "USE_TOOL", tool: "echo", args: { a: 2 } }), "tool args are part of the key");
}

function testGuardDeclineIsFinal() {
  console.log("\n== loop guard: a tier-4 decline ends the task as DECLINED, with no further escalation ==");
  const replies = [
    "Ruling for task-1761522093: decline. The image backend keeps failing with HTTP 500, so retrying will not help. Close the task.",
    "Ruling: decline — close the task.",
    "This is the third escalation of the same request with no change, which suggests the Butler isn't recognizing a decline as a resolution and is looping. Treat a decline ruling as terminal in the escalation logic.",
  ];
  let asked = 0;
  const r = driveTask(() => ({ action: "ESCALATE", toTier: 4 }), { adjudicate: (n) => { asked++; return replies[n - 1]; } });
  assert(r.end === "DECLINED" && r.adjudications === 1 && asked === 1, `the first decline ends it — no 2nd/3rd escalation (end ${r.end}, adjudications ${r.adjudications})`);
  assert(r.reason && r.reason.length <= 161 && /decline/i.test(r.reason), `a short adjudicator reason is kept (got "${r.reason}")`);
  for (const t of replies) assert(mp.parseAdjudicationVerdict(t).verdict === "DECLINE", `real reply reads as DECLINE: "${t.slice(0, 50)}…"`);
  const P = mp.parseAdjudicationVerdict;
  assert(P('{"verdict":"decline","reason":"not doable"}').verdict === "DECLINE", "a structured {verdict:\"decline\"} reply counts");
  assert(P("VERDICT: DECLINE\nThis can't be done.").verdict === "DECLINE" && P("VERDICT: DECLINE\nThis can't be done.").reason === "This can't be done.", "the one-line verdict format is read, with its reason");
  assert(P("**VERDICT: APPROVE** — go ahead.").verdict === "APPROVE", "APPROVE verdict line");
  assert(P("Verdict: guidance - ask Gemini first.").verdict === "GUIDANCE", "GUIDANCE verdict line (any case)");
  assert(P("I must decline this request.").verdict === "DECLINE" && P("I can't help with that.").verdict === "DECLINE" && P("I won't generate that image.").verdict === "DECLINE", "decline / can't help / won't phrases count");
  assert(P("After reviewing both, the correct approach is X.").verdict === null, "an ordinary ruling is not a decline");
  assert(P("This won't work unless you fix the VAE first.").verdict === null, "a bare \"won't work\" is not mistaken for a refusal (conservative)");
  assert(P("VERDICT: GUIDANCE\nDon't close the task yet; ask Gemini.").verdict === "GUIDANCE", "an explicit GUIDANCE verdict wins over decline-ish words later on");
  const once = driveTask((t) => (t < 4 ? { action: "ESCALATE", toTier: 4 } : { action: "FINISH" }));
  assert(once.end === "FINISHED" && once.adjudications === 1, "after a non-decline ruling the same task is never adjudicated again");
}

function testGuardMissingAssignments() {
  console.log("\n== loop guard: repeated SEND without assignments ends the task early, with a corrective hint ==");
  const r = driveTask(() => ({ action: "SEND", prompt: "describe a reading nook", reason: "ask" }));
  assert(r.end === "INVALID_STEPS" && r.turn === 3, `3 identical invalid steps end the task (end ${r.end}, turn ${r.turn})`);
  const hint = r.promptsSeen[1].find((n) => /MISSING_ASSIGNMENTS/.test(n));
  assert(hint && hint.includes('{"action":"SEND","assignments":[{"target":"claude","task":"<what to ask>"}],"reason":"<why>"}'), "the next prompt gives the exact JSON shape");
  const g = mp.createTaskGuard();
  mp.guardRecordInvalid(g, { action: "SEND" }, "MISSING_ASSIGNMENTS");
  mp.guardRecordValid(g);
  assert(mp.guardNotes(g).length === 0, "the corrective hint is dropped once a valid step comes back");
  const pm = mp.buildManagerPrompt({ ...trivialState, guard: r.g });
  assert(/"notes":\[/.test(pm[pm.length - 1].content) && /blocked|MISSING_ASSIGNMENTS/.test(pm[pm.length - 1].content), "buildManagerPrompt passes the guard notes to the model");
}

function testGuardNoProgress() {
  console.log("\n== loop guard: 4 turns with no successful action end the task as stuck ==");
  const prompts = ["a red barn", "a blue barn", "a green barn", "a yellow barn", "a pink barn"];
  const r = driveTask((t) => ({ action: "GENERATE_IMAGE", prompt: prompts[t - 1] || `barn ${t}` }));
  assert(r.end === "STUCK" && r.turn === 4, `stuck after 4 failing turns (end ${r.end}, turn ${r.turn})`);
  const g = mp.createTaskGuard();
  mp.guardRecordOutcome(g, { action: "GENERATE_IMAGE", prompt: "a" }, false, "HTTP_500");
  mp.guardRecordTurn(g, false); mp.guardRecordTurn(g, false); mp.guardRecordTurn(g, false);
  const st = mp.guardRecordTurn(g, false);
  assert(st.stuck && /Tried: GENERATE_IMAGE → HTTP_500/.test(st.summary), `the stuck status summarises what was tried (got "${st.summary}")`);
  const ok = mp.createTaskGuard();
  mp.guardRecordOutcome(ok, { action: "GENERATE_IMAGE", prompt: "a" }, false, "HTTP_500");
  mp.guardRecordTurn(ok, false); mp.guardRecordTurn(ok, false); mp.guardRecordTurn(ok, true);
  assert(!mp.guardRecordTurn(ok, false).stuck, "a successful turn resets the no-progress count");
  const think = mp.createTaskGuard();
  let thinkStuck = false;
  for (let i = 0; i < 6; i++) thinkStuck = thinkStuck || mp.guardRecordTurn(think, false).stuck;
  assert(!thinkStuck, "a pure thinking loop with no failures is left to the stall-break (which asks the user)");
}

function testGuardSmallModelAndLogCaps() {
  console.log("\n== loop guard: small-model warning signals + log text caps ==");
  for (const name of ["qwen2.5:0.5b", "llama3.2:1b", "deepseek-r1:1.5b", "gemma3:1b-it-qat"]) assert(mp.isTooSmallModelName(name), `${name} looks too small`);
  for (const name of ["qwen2.5:7b", "qwen2.5:14b", "llama3.1:8b", "qwen2.5:11b", "test-model", ""]) assert(!mp.isTooSmallModelName(name), `${name || "(empty)"} is not flagged by name`);
  const g = mp.createTaskGuard();
  mp.guardRecordValid(g);
  for (let i = 0; i < 3; i++) mp.guardRecordInvalid(g, { action: "SEND" }, "MISSING_ASSIGNMENTS");
  assert(mp.guardInvalidRateHigh(g), "a high invalid-action rate is flagged");
  const g2 = mp.createTaskGuard();
  for (let i = 0; i < 5; i++) mp.guardRecordValid(g2);
  mp.guardRecordInvalid(g2, { action: "SEND" }, "MISSING_ASSIGNMENTS");
  assert(!mp.guardInvalidRateHigh(g2), "an occasional invalid step is not");
  const long = "x".repeat(500);
  const sum = mp.summarizeDecisionForLog({ action: "GENERATE_IMAGE", prompt: long, reason: "r", assignments: [{ target: "claude", task: long }], content: long, args: { a: long } });
  assert(sum.prompt.length <= mp.LOG_TEXT_CAP + 1 && sum.assignments[0].task.length <= mp.LOG_TEXT_CAP + 1 && sum.args.length <= mp.LOG_TEXT_CAP + 1, "prompt-like text in log details is capped to ~60 chars");
  assert(sum.content === undefined && sum.contentChars === 500, "file content is reduced to its length");
  assert(mp.summarizeDecisionForLog(null) === null && mp.capLogText(undefined) === undefined, "log helpers never throw on empty input");
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
  testExtractJsonRobustness();
  await testAskManagerRepairRetry();
  await testHandlingModeDirective();
  await testChatWithButler();
  testGuardSameFailureTwice();
  testGuardDeclineIsFinal();
  testGuardMissingAssignments();
  testGuardNoProgress();
  testGuardSmallModelAndLogCaps();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("Test runner crashed:", e);
  process.exit(1);
});
