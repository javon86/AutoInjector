// test/self-repair-main.test.js — P18 inside the REAL main.js (mock Electron, see
// mock-electron.js) with the REAL Akọwe bridge over HTTP:
//   * P18.5 regression, the exact Gemini case from the first real run: the answer
//     ([TO: USER] … "word": "tundra" … [FROM: GEMINI]) was captured while the send
//     was still retrying SEND_NOT_CONFIRMED and then rejected as "already
//     captured" -> TIMEOUT. Now: 200 with that answer.
//   * P18.5: a second answer with exactly the same words as the first is new when
//     the AI was seen writing after the message went out.
//   * P18.1: a check-in (🩺 / POST /v1/probe) — its answer is never shown in the
//     conversation and never relayed; busy AIs are skipped.
//   * P18.1 regression (the Akọwe e2e flake): a check-in waits, an Akọwe
//     chapter that happens to contain the check-in word arrives -> the bridge gets
//     it (200), the check-in is not satisfied by it, the AI is not marked broken,
//     and the check-in's own late answer is still kept out of the conversation.
//   * P18.1: no check-in while an Akọwe prompt is in flight or in its late window.
//   * P18.4 through main: a ChatGPT page whose replies use unknown markup (fake
//     DOM) -> check-in fails NO_REPLY_FOUND -> page search learns -> fixed; the
//     learned selector is saved (versioned, timestamped) and used by the reader.
//   * P18.8 + contract v1.2: a logged-out Gemini -> needs_user; /v1/health says so
//     (ready false); /v1/complete -> 503 {state, problem}.
//   * P18.7: while the user is teaching, nothing else is typed into that AI.
//   * P18.10: diagnostics list the self-repair, never the key, prompts, replies or
//     the check-in word.
// Run with: node test/self-repair-main.test.js
process.env.AUTOINJECTOR_POLL_MS = "50";
process.env.AUTOINJECTOR_SAVE_DEBOUNCE_MS = "30";
process.env.AUTOINJECTOR_RETRY_BACKOFF_MS = "700"; // the AI answers while the send waits to retry
process.env.AUTOINJECTOR_CAPTURE_SETTLE_MS = "100";
process.env.AUTOINJECTOR_STABLE_MS = "80";
process.env.AUTOINJECTOR_NOTAG_QUIET_MS = "400";
process.env.AUTOINJECTOR_SEND_BUSY_POLL_MS = "50";
process.env.AUTOINJECTOR_BRIDGE = "0";
process.env.AUTOINJECTOR_CHECKIN = "0"; // no automatic ones: every check-in here is asked for
process.env.AUTOINJECTOR_PROBE_TIMEOUT_MS = "3000";
process.env.AUTOINJECTOR_PROBE_SEND_TIMEOUT_MS = "4000";
process.env.AUTOINJECTOR_PROBE_EARLY_MS = "600";
process.env.AUTOINJECTOR_RELOAD_SETTLE_MS = "50";
process.env.AUTOINJECTOR_TEACH_POLL_MS = "50";
process.env.AUTOINJECTOR_CHECKIN_YIELD_MS = "1500"; // an Akọwe request waits this long for a typed check-in to settle
process.env.AUTOINJECTOR_AKOWE_PORT = String(20000 + Math.floor(Math.random() * 20000));
process.env.AUTOINJECTOR_AKOWE_APP_URL = `http://127.0.0.1:${Number(process.env.AUTOINJECTOR_AKOWE_PORT) + 1}/api/ping`;
process.env.AUTOINJECTOR_AKOWE_DIR = require("path").join(require("os").tmpdir(), "no-akowe-here-" + process.pid);

const path = require("path");
const fs = require("fs");
const http = require("http");
const Module = require("module");
const mockElectronPath = path.join(__dirname, "mock-electron.js");
const originalLoad = Module._load;
Module._load = function (request) {
  if (request === "electron") return require(mockElectronPath);
  return originalLoad.apply(this, arguments);
};
const mockElectron = require(mockElectronPath);
mockElectron.shell = { openExternal: async () => {}, openPath: async () => "" };
mockElectron.clipboard = { writeText: () => {} };
const { parseHTML, runScript, append } = require("./fake-dom");

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ok   - ${msg}`); }
  else { failed++; console.log(`  FAIL - ${msg}`); }
  return cond;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(fn, timeout = 6000, step = 25) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { const r = await fn(); if (r) return r; await sleep(step); }
  return null;
}
const call = (ch, p) => mockElectron.__ipcHandlers[ch]({}, p);
const reg = (s) => mockElectron.__registry[s];
const PORT = Number(process.env.AUTOINJECTOR_AKOWE_PORT);
function request(method, urlPath, token, body) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? Buffer.from(JSON.stringify(body)) : null;
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (data) { headers["Content-Type"] = "application/json"; headers["Content-Length"] = data.length; }
    const req = http.request({ host: "127.0.0.1", port: PORT, method, path: urlPath, headers, agent: false }, (res) => {
      const c = []; res.on("data", (x) => c.push(x)); res.on("end", () => { let json = null; try { json = JSON.parse(Buffer.concat(c).toString("utf8")); } catch (_) {} resolve({ status: res.statusCode, json }); });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}
function cfgOf(script) {
  const i = script.indexOf("const CFG = ");
  if (i < 0) return null;
  const end = script.indexOf(";\n", i);
  try { return JSON.parse(script.slice(i + 12, end)); } catch (_) { return null; }
}

async function main() {
  require(path.join(__dirname, "..", "main.js"));
  await waitUntil(() => reg("chatgpt") && reg("claude") && reg("gemini") && reg("controls-ui"));
  const userData = mockElectron.app.getPath("userData");
  const broadcasts = [];
  reg("controls-ui").webContents.on("ipc-send", (channel, payload) => { if (channel === "self-repair" || channel === "capture" || channel === "akowe-activity") broadcasts.push({ channel, payload }); });
  let st = await call("akowe:set-enabled", { enabled: true });
  assert(st.listening === true, "bridge on");
  const token = (await call("akowe:reveal-token")).token;
  await waitUntil(async () => { const h = await request("GET", "/v1/health", token); return h.json && ["chatgpt", "claude", "gemini"].every((s) => h.json.sites[s].ready); });

  // ---------------------------------------------------------------------------------
  console.log("\n== P18.5 regression: the exact Gemini case (answer captured while the send retried) ==");
  const GEMINI_TEXT = "[TO: USER]\n\nJSON\n{\"ok\": true, \"site\": \"gemini\", \"word\": \"tundra\"}\n\n\n[FROM: GEMINI]";
  await call("routing:set", { source: "gemini", target: "claude", enabled: true });
  const gw = reg("gemini").webContents;
  gw._sendFailQueue = [true, false]; // 1st try: SEND_NOT_CONFIRMED (it really went out) ; 2nd: ok
  gw.onSendAttempt = (text, failing) => { if (failing) gw.currentText = GEMINI_TEXT; }; // Gemini answers at once
  reg("claude").webContents.sentLog = [];
  let r = await request("POST", "/v1/complete", token, { site: "gemini", prompt: "Reply with one JSON object echoing the word tundra.", request_id: "gem-regression-1", timeout_ms: 10000 });
  gw.onSendAttempt = null;
  assert(r.status === 200, `200, not a TIMEOUT (${r.status} ${r.json && r.json.error})`);
  assert(r.json && /"word": "tundra"/.test(r.json.text) && r.json.text.startsWith("JSON") && !/\[(TO|FROM):/.test(r.json.text), "Akọwe gets that answer, envelope stripped");
  assert(r.json && r.json.seq && r.json.seq === r.json.reply_to, "seq == reply_to");
  await sleep(300);
  assert(reg("claude").webContents.sentLog.length === 0, "the bridge's answer was not relayed to Claude (routing gemini->claude is on)");
  const dbg1 = fs.readFileSync(path.join(userData, "autoinjector-debug.log"), "utf8");
  assert(/"kind":"send-retry".*"target":"gemini".*SEND_NOT_CONFIRMED/.test(dbg1), "(the first try really failed confirmation, like the real run)");
  await sleep(900); // the 2nd try (after the back-off) reports its result
  const hg = await call("health:get");
  assert(hg.health.gemini.level === "ok", `pane health: Gemini 'ok' — no 'matches one already captured' stall later (${hg.health.gemini.level}: ${hg.health.gemini.text})`);
  assert(await waitUntil(() => /"kind":"reply-before-confirm".*"target":"gemini"/.test(fs.readFileSync(path.join(userData, "autoinjector-debug.log"), "utf8")), 4000), "logged as an answer captured before the send confirmed");
  await call("routing:set", { source: "gemini", target: "claude", enabled: false });

  // ---------------------------------------------------------------------------------
  console.log("\n== P18.5: the same words twice — the second answer is still new ==");
  const cw = reg("claude").webContents;
  const SAME = "[TO: USER]\nDone — saved.\n[FROM: CLAUDE]";
  let p = request("POST", "/v1/complete", token, { site: "claude", prompt: "first", request_id: "same-1", timeout_ms: 10000 });
  await waitUntil(() => cw.sentLog.some((x) => /first/.test(x.text)));
  cw.currentText = SAME;
  r = await p;
  assert(r.status === 200 && r.json.text === "Done — saved.", "first answer: 200");
  const before = (await call("state:get")).transcript.length;
  p = request("POST", "/v1/complete", token, { site: "claude", prompt: "second", request_id: "same-2", timeout_ms: 10000 });
  await waitUntil(() => cw.sentLog.some((x) => /second/.test(x.text)));
  cw.generating = true; // Claude is seen writing the new answer…
  await sleep(250);
  cw.generating = false; // …which has exactly the same words
  r = await p;
  assert(r.status === 200 && r.json.text === "Done — saved." && r.json.seq === r.json.reply_to, `second identical answer: 200 (${r.status} ${r.json && r.json.error})`);
  await sleep(400);
  const after = (await call("state:get")).transcript.length;
  assert(after === before + 1, `captured once, not again and again (${after - before})`);
  const capNow = after;
  cw.generating = true; await sleep(30); cw.generating = false; await sleep(400);
  assert((await call("state:get")).transcript.length === capNow, "a Stop-button flicker with no new message captures nothing");

  // ---------------------------------------------------------------------------------
  console.log("\n== P18.1 check-in: owned, hidden, never relayed ==");
  await call("routing:set", { source: "claude", target: "gemini", enabled: true });
  gw.sentLog = [];
  const answered = new Set();
  const responder = setInterval(() => {
    for (const site of ["claude", "gemini"]) {
      const w = reg(site).webContents;
      w.sentLog.forEach((e, i) => {
        const key = `${site}:${i}`;
        const m = /Reply with only this word: ([a-z]+)/.exec(e.text || "");
        if (!m || answered.has(key)) return;
        answered.add(key);
        w.currentText = `[TO: USER]\n${m[1]}\n[FROM: ${site.toUpperCase()}]`;
      });
    }
  }, 20);
  const tBefore = (await call("state:get")).transcript.length;
  let pr = await call("selfrepair:probe", { sites: ["claude"] });
  assert(pr.ok && pr.started.join() === "claude", "🩺 Check now starts a check-in");
  let ok = await waitUntil(async () => { const s = await call("selfrepair:status"); return s.sites.claude.state === "ok" && s.sites.claude.lastProbeOkAt ? s : null; });
  assert(ok, "Claude answered its check-in -> state ok");
  const probeMsg = cw.sentLog.find((x) => /Reply with only this word/.test(x.text));
  assert(probeMsg && /^\[MSG #\d{4}\]\nReply with only this word: [a-z]+\n\n\[Reply envelope required/.test(probeMsg.text), "the check-in is '[MSG #n]' + 'Reply with only this word: <word>' + the envelope line (no role/label framing)");
  const word = /Reply with only this word: ([a-z]+)/.exec(probeMsg.text)[1];
  await sleep(300);
  assert((await call("state:get")).transcript.length === tBefore, "its answer is NOT shown in the conversation");
  assert(gw.sentLog.length === 0, "and NOT relayed to Gemini (routing claude->gemini is on)");
  assert(!broadcasts.some((b) => b.channel === "capture" && String(b.payload && b.payload.text).includes(word)), "no capture broadcast carries it");
  let h = await request("GET", "/v1/health", token);
  assert(h.json.bridge_version === "1.2" && h.json.sites.claude.state === "ok" && typeof h.json.sites.claude.last_probe_ok_at === "number" && h.json.sites.claude.ready === true, "health v1.2: claude ok with last_probe_ok_at");
  // Akọwe asks for check-ins; a busy AI is skipped
  reg("chatgpt").webContents.generating = true;
  await sleep(120);
  r = await request("POST", "/v1/probe", token, { sites: ["chatgpt", "gemini"] });
  assert(r.status === 202 && r.json.skipped.chatgpt === "busy" && r.json.started.includes("gemini"), `POST /v1/probe: gemini started, busy chatgpt skipped (${JSON.stringify(r.json)})`);
  reg("chatgpt").webContents.generating = false;
  ok = await waitUntil(async () => (await request("GET", "/v1/health", token)).json.sites.gemini.state === "ok");
  assert(ok, "gemini's check-in result shows up in /v1/health");
  clearInterval(responder);
  await call("routing:set", { source: "claude", target: "gemini", enabled: false });

  // ---------------------------------------------------------------------------------
  console.log("\n== P18.1 regression (e2e flake): a check-in waits, an Akọwe reply arrives -> it goes to the bridge ==");
  const logNow = () => fs.readFileSync(path.join(userData, "autoinjector-debug.log"), "utf8");
  const logLen0 = logNow().length;
  gw.sentLog = [];
  r = await request("POST", "/v1/probe", token, { sites: ["gemini"] });
  assert(r.status === 202 && r.json.started.join() === "gemini", "Akọwe asks for a check-in of Gemini (nobody answers it yet)");
  const probeSent = await waitUntil(() => gw.sentLog.find((x) => /Reply with only this word: [a-z]+/.test(x.text)));
  const gword = /Reply with only this word: ([a-z]+)/.exec(probeSent.text)[1];
  const tTr = (await call("state:get")).transcript.length;
  p = request("POST", "/v1/complete", token, { site: "gemini", prompt: "Write chapter 2 of the story.", request_id: "flake-ch2", timeout_ms: 10000 });
  await sleep(500);
  assert(!gw.sentLog.some((x) => /Write chapter 2/.test(x.text)), "the Akọwe prompt waits while the typed check-in settles (no interleaving)");
  assert(await waitUntil(() => /"kind":"checkin-yield".*"site":"gemini".*"how":"wait"/.test(logNow().slice(logLen0)), 2000), "logged: the request waits for the check-in");
  assert(await waitUntil(() => gw.sentLog.some((x) => /Write chapter 2/.test(x.text)), 4000), "…for a bounded time, then it is typed");
  // Gemini answers the CHAPTER first — bare text (Akọwe asks for no tags), and it
  // happens to use the check-in word.
  const CHAPTER = `Chapter 2\n\nThe old ${gword} creaked in the wind as Mara climbed toward the ${gword.toUpperCase()}. She did not look back.`;
  gw.currentText = CHAPTER;
  r = await p;
  assert(r.status === 200 && r.json.text === CHAPTER, `Akọwe receives its chapter (${r.status} ${r.json && (r.json.error || "")})`);
  const tail = logNow().slice(logLen0);
  assert(!/"kind":"untagged-reply-accepted"[^\n]*a check-in answer/.test(tail) && !/"kind":"checkin-reply"/.test(tail), "the chapter was never taken as the check-in answer");
  const settled = await waitUntil(async () => { const s = await call("selfrepair:status"); return !s.sites.gemini.running ? s.sites.gemini : null; }, 6000);
  assert(settled && settled.state === "ok" && !settled.problem, `the check-in gave no verdict from it: Gemini is NOT marked broken (${settled && settled.state} ${settled && settled.problem})`);
  assert((await call("selfrepair:status")).events.some((e) => e.site === "gemini" && e.kind === "result" && e.outcome === "DEFERRED"), "the check-in was deferred (it is sent again later, when Gemini is free)");
  // the check-in's own answer arrives late: still owned, never shown / relayed
  const tAfterChapter = (await call("state:get")).transcript.length;
  gw.currentText = `[TO: USER]\n${gword}\n[FROM: GEMINI]`;
  assert(await waitUntil(() => /"kind":"checkin-reply".*"site":"gemini"/.test(logNow().slice(logLen0)), 3000), "the check-in's own late answer is taken by the check-in");
  await sleep(200);
  assert((await call("state:get")).transcript.length === tAfterChapter && tAfterChapter >= tTr, "…and is not shown in the conversation");

  console.log("\n== P18.1: no check-in while an Akọwe prompt is in flight or in its late window ==");
  cw.sentLog = [];
  p = request("POST", "/v1/complete", token, { site: "claude", prompt: "Write chapter 3 slowly.", request_id: "late-ch3", timeout_ms: 10000 });
  await waitUntil(() => cw.sentLog.some((x) => /Write chapter 3/.test(x.text)));
  r = await request("POST", "/v1/probe", token, { sites: ["claude"] });
  assert(r.status === 202 && r.json.skipped.claude === "akowe" && !r.json.started.length, `in flight -> skipped (${JSON.stringify(r.json)})`);
  r = await p;
  assert(r.status === 504 && r.json.typed === true, "the request times out after it was typed (late window)");
  r = await request("POST", "/v1/probe", token, { sites: ["claude"] });
  assert(r.json.skipped.claude === "akowe" && !cw.sentLog.some((x) => /Reply with only this word/.test(x.text)), `late window -> skipped, nothing typed (${JSON.stringify(r.json)})`);
  cw.currentText = "[TO: USER]\nChapter 3, at last.\n[FROM: CLAUDE]";
  r = await waitUntil(async () => { const x = await request("POST", "/v1/complete", token, { site: "claude", prompt: "Write chapter 3 slowly.", request_id: "late-ch3", timeout_ms: 10000 }); return x.status === 200 ? x : null; }, 6000, 200);
  assert(r && r.json.text === "Chapter 3, at last.", "the late answer is collected with the same request_id");
  const responder2 = setInterval(() => {
    cw.sentLog.forEach((e, i) => {
      const m = /Reply with only this word: ([a-z]+)/.exec(e.text || "");
      if (!m || answered.has(`claude2:${i}`)) return;
      answered.add(`claude2:${i}`);
      cw.currentText = `[TO: USER]\n${m[1]}\n[FROM: CLAUDE]`;
    });
  }, 20);
  r = await request("POST", "/v1/probe", token, { sites: ["claude"] });
  assert(r.json.started.join() === "claude", `the late answer captured -> check-ins allowed again (${JSON.stringify(r.json)})`);
  assert(await waitUntil(async () => { const s = (await call("selfrepair:status")).sites.claude; return !s.running && s.state === "ok"; }, 5000), "…and it passes");
  clearInterval(responder2);

  // ---------------------------------------------------------------------------------
  console.log("\n== P18.4 through main: unknown reply markup -> page search learns it -> fixed ==");
  const doc = parseHTML(`<main><div id="log"></div><form><div id="prompt-textarea" contenteditable="true" class="ProseMirror"></div><button data-testid="send-button" aria-label="Send prompt">Send</button></form></main>`, { url: "https://chatgpt.com/c/abc" });
  const chw = reg("chatgpt").webContents;
  const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  chw.evaluator = async (script) => {
    if (script.includes("typeByKeyboard")) { // a send: the message appears, the fake AI answers in its new layout
      const cfg = cfgOf(script) || {};
      append(doc, doc.getElementById("log"), `<div class="convo-turn human-turn" data-turn-role="human"><div class="ask-body">${esc(cfg.text)}</div></div>`);
      const m = /Reply with only this word: ([a-z]+)/.exec(cfg.text || "");
      if (m) setTimeout(() => append(doc, doc.getElementById("log"), `<div class="convo-turn bot-turn" data-turn-role="model"><div class="answer-body"><p>[TO: USER]</p><p>${m[1]}</p><p>[FROM: CHATGPT]</p></div></div>`), 30);
      return { ok: true, method: "click", verified: true, markerBaseline: 0 };
    }
    return runScript(script, doc); // the REAL read / check-in / repair scripts on the fake page
  };
  pr = await call("selfrepair:probe", { sites: ["chatgpt"] });
  assert(pr.started.join() === "chatgpt", "check-in started");
  const fixed = await waitUntil(async () => { const s = await call("selfrepair:status"); const x = s.sites.chatgpt; return !x.running && x.state !== "unknown" && x.state !== "repairing" ? x : null; }, 15000);
  assert(fixed && fixed.state === "ok" && fixed.fixedAt, `repaired by itself -> ok (${fixed && fixed.state} ${fixed && JSON.stringify(fixed.tried.map((t) => t.step + ":" + t.outcome))})`);
  assert(fixed && fixed.tried.some((t) => t.step === "page_search" && t.outcome === "LEARNED"), "the page search learned where replies are");
  const statusNow = await call("selfrepair:status");
  assert(statusNow.sites.chatgpt.learned.assistant && statusNow.sites.chatgpt.learned.assistant.how === "page-search", "status lists the learned part (how, when)");
  await sleep(150);
  const saved = JSON.parse(fs.readFileSync(path.join(userData, "autoinjector-state.json"), "utf8"));
  const L = saved.learnedSelectors;
  assert(L && L.version === 1 && L.sites.chatgpt.assistant && /data-turn-role="model"/.test(L.sites.chatgpt.assistant.selector) && L.sites.chatgpt.assistant.how === "page-search" && typeof L.sites.chatgpt.assistant.learnedAt === "number", `saved per site, versioned, with 'learned at' (${L && JSON.stringify(L.sites.chatgpt)})`);
  // the reader now uses it: a normal reply on this page is captured
  append(doc, doc.getElementById("log"), `<div class="convo-turn bot-turn" data-turn-role="model"><div class="answer-body"><p>[TO: USER]</p><p>A normal reply after the repair.</p><p>[FROM: CHATGPT]</p></div></div>`);
  ok = await waitUntil(async () => (await call("state:get")).transcript.some((t) => t.site === "chatgpt" && t.text === "A normal reply after the repair."));
  assert(ok, "the reader uses the learned selector: a normal ChatGPT reply is captured again");
  assert(broadcasts.some((b) => b.channel === "akowe-activity" && b.payload.event && b.payload.event.kind === "repair" && /Fixed — ChatGPT is working again/.test(b.payload.event.say)), "the panel's activity feed says '✔ Fixed — ChatGPT is working again'");

  // ---------------------------------------------------------------------------------
  console.log("\n== P18.8 + v1.2: logged-out Gemini -> needs_user, 503 {state, problem} ==");
  const gdoc = parseHTML(`<div><h1>Gemini</h1><p>Sign in to continue</p><a href="https://accounts.google.com/ServiceLogin?x">Sign in</a></div>`, { url: "https://gemini.google.com/app" });
  gw.evaluator = async (script) => (script.includes("typeByKeyboard") ? { ok: false, error: "INPUT_NOT_FOUND" } : runScript(script, gdoc));
  r = await request("POST", "/v1/probe", token, { sites: ["gemini"] });
  assert(r.status === 202 && r.json.started.join() === "gemini", `Akọwe asks for a check-in of Gemini (${JSON.stringify(r.json)})`);
  ok = await waitUntil(async () => { const x = (await request("GET", "/v1/health", token)).json.sites.gemini; return x.state === "needs_user" ? x : null; });
  assert(ok && ok.problem === "LOGGED_OUT" && ok.ready === false && typeof ok.since === "number", `health: needs_user LOGGED_OUT, ready false (${JSON.stringify(ok)})`);
  r = await request("POST", "/v1/complete", token, { site: "gemini", prompt: "x", request_id: "nu-1", timeout_ms: 10000 });
  assert(r.status === 503 && r.json.error === "SITE_NOT_READY" && r.json.state === "needs_user" && r.json.problem === "LOGGED_OUT", "complete -> 503 SITE_NOT_READY with state + problem");
  st = await call("akowe:status");
  assert(st.sites.gemini.repair.state === "needs_user" && st.sites.gemini.ready === false && /log in/i.test((st.sites.gemini.repair.fix || []).join(" ")), "the panel snapshot carries the repair state and what to do");
  assert(st.health.checks.some((c) => c.id === "pane:gemini" && c.level === "bad" && c.why === "needs you"), "overall health: Gemini 'needs you'");

  // ---------------------------------------------------------------------------------
  console.log("\n== P18.7: while teaching, nothing else is typed into that AI ==");
  const t = await call("selfrepair:teach-start", { site: "claude" });
  assert(t.ok && /^\d{4}$/.test(t.number), "🎓 teach step started for Claude");
  const sendR = await call("send:compose", { text: "hello claude", targets: ["claude"] });
  assert(sendR && sendR.results && sendR.results.claude && sendR.results.claude.ok === false && sendR.results.claude.error === "SITE_REPAIRING", `a compose to Claude meanwhile is refused (${JSON.stringify(sendR && sendR.results && sendR.results.claude)})`);
  assert((await call("selfrepair:teach-cancel", { site: "claude" })).ok, "Cancel");
  await waitUntil(async () => !(await call("selfrepair:status")).sites.claude.teach.active);
  const sendR2 = await call("send:compose", { text: "hello again", targets: ["claude"] });
  assert(sendR2.results.claude.ok, "after Cancel, sending works again");

  // ---------------------------------------------------------------------------------
  console.log("\n== P18.10 diagnostics + logs: codes and steps only ==");
  const d = await call("akowe:diagnostics", {});
  assert(d.ok && /Self-repair chatgpt: state ok/.test(d.text) && /learned assistant\(page-search/.test(d.text) && /Self-repair gemini: state needs_user · problem LOGGED_OUT/.test(d.text), "diagnostics list each AI's repair state, problem and learned parts");
  assert(/tried: .*page_search=LEARNED/.test(d.text) && /Check-ins: every 20 min/.test(d.text), "…what was tried, and the check-in setting");
  const dbg = fs.readFileSync(path.join(userData, "autoinjector-debug.log"), "utf8");
  for (const [what, s] of [["the key", token], ["the check-in word", word], ["a reply", "A normal reply after the repair."], ["the Gemini answer", "\"word\": \"tundra\""], ["a prompt", "Reply with one JSON object"]]) {
    assert(!d.text.includes(s), `diagnostics never contain ${what}`);
  }
  assert(!dbg.includes(word) && !dbg.includes(token), "the debug log never contains the check-in word or the key");
  assert(/"kind":"self-repair".*"step":"page_search".*"outcome":"LEARNED"/.test(dbg) && /"kind":"self-repair".*"kind":"detect".*"code":"NO_REPLY_FOUND"/.test(dbg), "the activity log has the detection and each step (codes only)");

  // settings
  const s2 = await call("selfrepair:settings", { intervalMin: 30 });
  assert(s2.ok && s2.settings.intervalMin === 30, "check-in interval can be changed");
  assert((await call("selfrepair:settings", { intervalMin: -1 })).error === "BAD_INTERVAL", "a bad interval is refused");
  await sleep(100);
  assert(JSON.parse(fs.readFileSync(path.join(userData, "autoinjector-state.json"), "utf8")).selfRepair.intervalMin === 30, "…and saved");
  const fg = await call("selfrepair:forget-learned", { site: "chatgpt" });
  assert(fg.ok && Object.keys((await call("selfrepair:status")).sites.chatgpt.learned).length === 0, "forget what was learned for an AI");


  // ---------------------------------------------------------------------------------
  console.log("\n== P38 🎯 picker through main: pick ONE thing, Save it (persisted, versioned), stale chip, Test it, Clear ==");
  const pkState = () => JSON.parse(fs.readFileSync(path.join(userData, "autoinjector-state.json"), "utf8"));
  // a couple of AI replies on the page (the P18.4 layout)
  append(doc, doc.getElementById("log"), `<div class="convo-turn bot-turn" data-turn-role="model"><div class="answer-body"><p>[TO: USER]</p><p>The newest answer on the page.</p><p>[FROM: CHATGPT]</p></div></div>`);
  let ps = await call("picker:status", { site: "chatgpt" });
  assert(ps.ok && ["input", "send", "assistant"].every((r) => ps.items[r].state === "none"), `picker:status: nothing set (blue) for all three (${JSON.stringify(Object.fromEntries(Object.entries(ps.items).map(([k, v]) => [k, v.state])))})`);
  const pickP = call("picker:start", { site: "chatgpt", role: "assistant" });
  await waitUntil(() => doc.querySelector("[data-autoinjector-overlay]"), 3000);
  assert(/Click the AI's latest reply in this window/.test(doc.querySelector("[data-autoinjector-overlay]").textContent), "pick mode: the banner in ChatGPT's window says what to click");
  const lastP = Array.from(doc.querySelectorAll(".answer-body p")).filter((x) => /newest answer/.test(x.textContent)).pop();
  lastP.dispatchEvent({ type: "click", target: lastP, preventDefault() {}, stopImmediatePropagation() {} });
  const pk = await pickP;
  assert(pk.ok && pk.role === "assistant" && /newest answer/.test(pk.preview) && doc.querySelectorAll(pk.selector).length >= 3 && !/\d/.test(pk.selector), `picked the reply area: ${pk.selector} (matches ${doc.querySelectorAll(pk.selector).length} replies) — "${pk.preview}"`);
  ps = await call("picker:status", { site: "chatgpt" });
  assert(ps.items.assistant.state === "picked" && ps.items.input.state === "none" && ps.items.send.state === "none", "status: the reply is picked (green), the others still blue");
  await sleep(100);
  assert(!((pkState().selectorOverrides || {}).chatgpt || {}).assistant, "a pick is NOT saved until Save");
  const sv = await call("picker:save", { site: "chatgpt", role: "assistant" });
  assert(sv.ok && sv.items.assistant.state === "saved" && typeof sv.items.assistant.savedAt === "number" && sv.items.input.state === "none", "Save locks in that ONE item (green ✓ with saved-at); the others are untouched");
  await sleep(120);
  let stf = pkState();
  assert(stf.selectorOverrides.chatgpt.assistant === pk.selector && stf.pickMeta && stf.pickMeta.version === 1 && stf.pickMeta.sites.chatgpt.assistant.how === "pick" && stf.pickMeta.sites.chatgpt.assistant.rev === 1 && typeof stf.pickMeta.sites.chatgpt.assistant.savedAt === "number" && !stf.selectorOverrides.chatgpt.input, `persisted per site, versioned, with saved-at (${JSON.stringify(stf.pickMeta.sites.chatgpt)})`);
  assert((await call("picker:save", { site: "chatgpt", role: "send" })).error === "NOTHING_PICKED", "Save with nothing picked is refused");
  // input: pick + save, then the page changes -> red ⚠️
  const pickI = call("picker:start", { site: "chatgpt", role: "input" });
  await waitUntil(() => doc.querySelector("[data-autoinjector-overlay]"), 3000);
  const boxEl = doc.getElementById("prompt-textarea");
  boxEl.dispatchEvent({ type: "click", target: boxEl, preventDefault() {}, stopImmediatePropagation() {} });
  const pi = await pickI;
  await call("picker:save", { site: "chatgpt", role: "input" });
  boxEl.setAttribute("id", "renamed-box");
  ps = await call("picker:status", { site: "chatgpt" });
  assert(pi.ok && pi.selector === "#prompt-textarea" && ps.items.input.state === "stale" && ps.items.assistant.state === "saved", `a saved pick that no longer matches the page -> stale (red ⚠️) (${ps.items.input.state})`);
  boxEl.setAttribute("id", "prompt-textarea");
  ps = await call("picker:status", { site: "chatgpt" });
  assert(ps.items.input.state === "saved", "…and back to saved once it matches again");
  const tst = await call("picker:test", { site: "chatgpt" });
  assert(tst.ok && tst.state === "ok", `Test it: a check-in through the saved picks works (${JSON.stringify(tst)})`);
  const cl = await call("picker:clear", { site: "chatgpt", role: "input" });
  await sleep(120);
  assert(cl.ok && cl.cleared === "saved" && cl.items.input.state === "none" && cl.items.assistant.state === "saved" && !pkState().selectorOverrides.chatgpt.input && !(pkState().pickMeta.sites.chatgpt || {}).input, "Clear removes just that saved item (back to the built-ins)");
  assert(!fs.readFileSync(path.join(userData, "autoinjector-debug.log"), "utf8").includes("The newest answer on the page."), "the pick preview never reaches the log");

  // ---------------------------------------------------------------------------------
  console.log("\n== P38 🔢 number teach through main: the user types the digits; AutoInjector asks for them backwards; saved; confirmed ==");
  await call("picker:clear", { site: "chatgpt", role: "assistant" });
  const nt = await call("selfrepair:teach-start", { site: "chatgpt" });
  assert(nt.ok && /^\d{4}$/.test(nt.number), `number teach started (${nt.number})`);
  const NREV = nt.number.split("").reverse().join("");
  await waitUntil(() => doc.querySelector("[data-autoinjector-overlay]") && /type\s+\d{4}\s+into ChatGPT/.test(doc.querySelector("[data-autoinjector-overlay]").textContent), 3000);
  const followups = [];
  const prevEval = chw.evaluator;
  chw.evaluator = async (script) => {
    if (script.includes("typeByKeyboard")) {
      const cfg = cfgOf(script) || {};
      const fb = /Write the number (\d{4}) backwards, digits only/.exec(cfg.text || "");
      if (fb) {
        followups.push(cfg.text);
        append(doc, doc.getElementById("log"), `<div class="convo-turn human-turn" data-turn-role="human"><div class="ask-body">${esc(cfg.text)}</div></div>`);
        setTimeout(() => append(doc, doc.getElementById("log"), `<div class="convo-turn bot-turn" data-turn-role="model"><div class="answer-body"><p>${fb[1].split("").reverse().join("")}</p></div></div>`), 30);
        return { ok: true, method: "click", verified: true, markerBaseline: 0 };
      }
    }
    return prevEval(script);
  };
  const tbox = doc.getElementById("prompt-textarea");
  require("./fake-dom").typeInto(tbox, nt.number);
  await waitUntil(async () => (await call("selfrepair:status")).sites.chatgpt.teach.phase === "typed", 3000);
  const sbtn = doc.querySelector('[data-testid="send-button"]');
  sbtn.dispatchEvent({ type: "click", target: sbtn, preventDefault() {}, stopImmediatePropagation() {} });
  tbox.textContent = "";
  append(doc, doc.getElementById("log"), `<div class="convo-turn human-turn" data-turn-role="human"><div class="ask-body">${nt.number}</div></div>`);
  const ntDone = await waitUntil(async () => { const x = (await call("selfrepair:status")).sites.chatgpt; return x.teach && x.teach.result ? x : null; }, 15000);
  assert(followups.length === 1 && followups[0].includes(`Write the number ${nt.number} backwards, digits only.`) && /Reply envelope required/.test(followups[0]), "AutoInjector itself sent ONE follow-up: “Write the number #### backwards, digits only.” (with the reply envelope)");
  assert(ntDone && ntDone.teach.result === "fixed" && ntDone.state === "ok", `✔ Saved — ChatGPT is working again (${ntDone && ntDone.teach.result}, ${ntDone && ntDone.state}, part ${ntDone && ntDone.teach.failedPart})`);
  await sleep(150);
  stf = pkState();
  assert(["input", "send", "assistant"].every((r) => stf.selectorOverrides.chatgpt[r] && stf.pickMeta.sites.chatgpt[r] && stf.pickMeta.sites.chatgpt[r].how === "number"), `all three saved like picks (how: number) (${JSON.stringify(stf.pickMeta.sites.chatgpt)})`);
  assert(doc.querySelectorAll(stf.selectorOverrides.chatgpt.assistant).length >= 3 && !/\d/.test(stf.selectorOverrides.chatgpt.assistant), `the reply area is general: ${stf.selectorOverrides.chatgpt.assistant}`);
  ps = await call("picker:status", { site: "chatgpt" });
  assert(ps.items.assistant.state === "saved" && ps.items.assistant.how === "number", "the 🎯 card shows them as saved (🔢)");
  const dbgN = fs.readFileSync(path.join(userData, "autoinjector-debug.log"), "utf8");
  assert(!dbgN.includes(`Write the number ${nt.number}`) && !(await call("state:get")).transcript.some((t) => t.site === "chatgpt" && (t.text.includes(NREV) || t.text.includes("backwards"))), "the follow-up and its answer never reach the log or the conversation");
  assert(!/"kind":"(totag-missing|endtag-missing)"[^\n]*"site":"chatgpt"/.test(dbgN.split("\n").filter((l) => l.includes("chatgpt")).join("\n")), "no missing-tag nag was sent to ChatGPT for the teach answers (P37.4)");
  chw.evaluator = prevEval;

  // ---------------------------------------------------------------------------------
  console.log("\n== P37.4 through main: a late check-in answer without its [TO:] tag is never nagged or relayed ==");
  const lateMsg = cw.sentLog.filter((x) => /Reply with only this word: ([a-z]+)/.test(x.text || "")).pop();
  const lateWord = lateMsg && /Reply with only this word: ([a-z]+)/.exec(lateMsg.text)[1];
  const nagsBefore = (fs.readFileSync(path.join(userData, "autoinjector-debug.log"), "utf8").match(/"kind":"totag-missing"[^\n]*"site":"claude"/g) || []).length;
  await call("routing:set", { source: "claude", target: "gemini", enabled: true });
  const gsent0 = reg("gemini").webContents.sentLog.length;
  cw.sentLog = [];
  cw.currentText = `${lateWord}\n[FROM: CLAUDE]`;
  await sleep(900);
  const dbgL = fs.readFileSync(path.join(userData, "autoinjector-debug.log"), "utf8");
  const nagsAfter = (dbgL.match(/"kind":"totag-missing"[^\n]*"site":"claude"/g) || []).length;
  assert(lateWord && nagsAfter === nagsBefore && !cw.sentLog.some((x) => /FLAG: NO \[TO:\] TAG|NO ENDING TAG/.test(x.text || "")), `no "[TO:] tag missing" nag for it (nags ${nagsBefore} -> ${nagsAfter})`);
  assert(reg("gemini").webContents.sentLog.length === gsent0 && !(await call("state:get")).transcript.some((t) => t.site === "claude" && t.text.trim() === lateWord), "…not relayed (routing claude->gemini is on) and not shown in the conversation");
  await call("routing:set", { source: "claude", target: "gemini", enabled: false });

  await call("akowe:set-enabled", { enabled: false });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
