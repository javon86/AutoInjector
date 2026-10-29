// test/pc-panes-main.test.js — the first real-PC test (2026-10-28), problems 1-3,
// inside the REAL main.js (mock Electron, see mock-electron.js) with the REAL Akọwe
// bridge over HTTP:
//   1. Claude's site shows quotes as “ ” -> the 🧪 connection test still reads the
//      JSON; a reply that really is wrong shows what the AI wrote ("Technical details").
//   2. A saved Send button that is no longer on the page: the send uses Enter, the
//      log says so plainly, and the 🎯 card's Send row says "Enter key (works)".
//      A send whose box emptied but no new message appeared is NOT "sent"; and an
//      Akọwe prompt that never showed up in the chat times out as "never arrived",
//      not "had not finished answering".
//   3. A request still waiting for ChatGPT's late answer is released when 🔢 starts,
//      so the number the user types is never taken as that answer (LATE_REPLY_STORED).
// Run with: node test/pc-panes-main.test.js
process.env.AUTOINJECTOR_POLL_MS = "50";
process.env.AUTOINJECTOR_SAVE_DEBOUNCE_MS = "30";
process.env.AUTOINJECTOR_RETRY_BACKOFF_MS = "50";
process.env.AUTOINJECTOR_CAPTURE_SETTLE_MS = "100";
process.env.AUTOINJECTOR_STABLE_MS = "80";
process.env.AUTOINJECTOR_NOTAG_QUIET_MS = "400";
process.env.AUTOINJECTOR_SEND_BUSY_POLL_MS = "50";
process.env.AUTOINJECTOR_BRIDGE = "0";
process.env.AUTOINJECTOR_CHECKIN = "0";
process.env.AUTOINJECTOR_TEACH_POLL_MS = "50";
process.env.AUTOINJECTOR_BF_LINKTEST_MS = "10000";
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
const { parseHTML } = require("./fake-dom");

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
// A send script answered by the test (wc.evaluator); everything else as the mock does it.
function onSends(wc, fn) {
  wc.evaluator = async (script) => {
    if (script.includes("typeByKeyboard")) { const r = await fn(script); if (r) return r; }
    const keep = wc.evaluator; wc.evaluator = null;
    try { return await wc.executeJavaScript(script); } finally { wc.evaluator = keep; }
  };
}
const sentText = (script) => { const i = script.indexOf("const CFG = "); try { return JSON.parse(script.slice(i + 12, script.indexOf(";\n", i))).text; } catch (_) { return ""; } };

async function main() {
  require(path.join(__dirname, "..", "main.js"));
  await waitUntil(() => reg("chatgpt") && reg("claude") && reg("gemini") && reg("controls-ui"));
  const userData = mockElectron.app.getPath("userData");
  const logNow = () => fs.readFileSync(path.join(userData, "autoinjector-debug.log"), "utf8");
  const st = await call("akowe:set-enabled", { enabled: true });
  assert(st.listening === true, "bridge on");
  const token = (await call("akowe:reveal-token")).token;
  await waitUntil(async () => { const h = await request("GET", "/v1/health", token); return h.json && ["chatgpt", "claude", "gemini"].every((s) => h.json.sites[s].ready); });
  const chw = reg("chatgpt").webContents, cw = reg("claude").webContents, gw = reg("gemini").webContents;

  // ---------------------------------------------------------------------------------
  console.log("\n== Problem 2: the box emptied but no new message appeared -> NOT sent ==");
  let attempts = 0;
  onSends(gw, async () => { attempts++; return { ok: true, method: "click", verified: false, turnsCountable: true, markerBaseline: 0 }; });
  const log0 = logNow().length;
  let res = await call("send:compose", { text: "hello gemini", targets: ["gemini"] });
  assert(res.results.gemini.ok === false && res.results.gemini.error === "SEND_UNVERIFIED", `a pane's FIRST send that never showed up is reported as not sent (${JSON.stringify(res.results.gemini)})`);
  assert(attempts === 3, `…after trying again (attempts ${attempts})`);
  assert(!/"kind":"sent"[^\n]*"target":"gemini"/.test(logNow().slice(log0)), "no 'sent' line in the log for it");
  // a page where the user's messages can't be counted keeps the old rule (trusted on the first send, with a warning)
  onSends(gw, async () => ({ ok: true, method: "click", verified: false, markerBaseline: 0 }));
  res = await call("send:compose", { text: "hello again", targets: ["gemini"] });
  assert(res.results.gemini.ok === true && /"kind":"send-unverified"[^\n]*"target":"gemini"/.test(logNow()), "a page without countable messages: sent, with the 'not proven' warning (unchanged)");
  gw.evaluator = null;

  // ---------------------------------------------------------------------------------
  console.log("\n== Problem 2: a saved Send button that is no longer on the page ==");
  chw.selfRepairPage = parseHTML(`<main><div id="log"></div><form><div id="prompt-textarea" contenteditable="true" class="ProseMirror"></div><button data-testid="send-button" aria-label="Send prompt">Send</button></form></main>`, { url: "https://chatgpt.com/c/abc" });
  chw._nextPickResult = { ok: true, selector: 'button[data-testid="composer-send-old"]', tag: "button", matchCount: 1, visible: true, roleOk: true };
  const pk = await call("selector:pick", { site: "chatgpt", role: "send" });
  assert(pk.ok, "a Send button was saved earlier (🎯)");
  let ps = await call("picker:status", { site: "chatgpt" });
  assert(ps.items.send.state === "stale" && !ps.items.send.works, `the site changed: the 🎯 card shows it as not found (${ps.items.send.state})`);
  onSends(chw, async (script) => {
    const t = sentText(script);
    chw.sentLog.push({ text: t, ts: Date.now() });
    return { ok: true, method: "enter", verified: true, proof: "number", savedSend: "missing", turnsCountable: true, markerBaseline: 0 };
  });
  const log1 = logNow().length;
  res = await call("send:compose", { text: "first after the change", targets: ["chatgpt"] });
  await call("send:compose", { text: "second after the change", targets: ["chatgpt"] });
  const tail1 = logNow().slice(log1);
  assert(res.results.chatgpt.ok === true, "the message still goes out (built-in Send / Enter)");
  assert((tail1.match(/"kind":"send-saved-button-missing"/g) || []).length === 1 && /isn't on ChatGPT's page any more/.test(tail1) && /Enter key/.test(tail1), "the log says plainly — once — that the saved Send button is gone and Enter was used");
  assert(/"kind":"sent"[^\n]*"target":"chatgpt"[^\n]*"verified":true[^\n]*"proof":"number"[^\n]*"method":"enter"/.test(tail1), "the 'sent' line says HOW it was proven and sent");
  ps = await call("picker:status", { site: "chatgpt" });
  assert(ps.items.send.state === "stale" && ps.items.send.works === "enter", `the 🎯 card's Send row knows Enter works (works: ${ps.items.send.works}) — it shows "Send: Enter key (works)"`);
  chw.evaluator = null;

  // ---------------------------------------------------------------------------------
  console.log("\n== Problem 2: an Akọwe prompt that never showed up in the chat times out as 'never arrived' ==");
  onSends(cw, async (script) => { cw.sentLog.push({ text: sentText(script), ts: Date.now() }); return { ok: true, method: "click", verified: false, markerBaseline: 0 }; });
  // Problem 3 setup runs at the same time (both take the 10 s contract minimum)
  onSends(chw, async (script) => { chw.sentLog.push({ text: sentText(script), ts: Date.now() }); return { ok: true, method: "click", verified: true, proof: "number", markerBaseline: 0 }; });
  const pLost = request("POST", "/v1/complete", token, { site: "claude", prompt: "Reply with OK.", request_id: "lost-claude-1", timeout_ms: 10000 });
  const pLate = request("POST", "/v1/complete", token, { site: "chatgpt", prompt: "AutoInjector link test question.", request_id: "late-chatgpt-1", timeout_ms: 10000 });
  const [rLost, rLate] = await Promise.all([pLost, pLate]);
  assert(rLost.status === 504 && rLost.json.delivered === false && /never showed up in claude's chat/.test(rLost.json.message), `504 says it never arrived (${rLost.json && rLost.json.message})`);
  const act = (await call("akowe:status")).activity;
  assert(act.some((a) => a.site === "claude" && /never arrived in Claude's chat/.test(a.say || "")) && !act.some((a) => a.site === "claude" && /hadn't answered/.test(a.say || "")), "the activity feed says the message never arrived — not that Claude hadn't answered");
  cw.evaluator = null;

  // ---------------------------------------------------------------------------------
  console.log("\n== Problem 3: 🔢 releases the request still waiting for ChatGPT's late answer ==");
  assert(rLate.status === 504 && rLate.json.typed === true, "ChatGPT's request timed out after it was typed (its late window is open)");
  let h = await request("GET", "/v1/health", token);
  assert(h.json.sites.chatgpt.busy === true, "…so ChatGPT is still reserved for that late answer");
  const log2 = logNow().length;
  const t = await call("selfrepair:teach-start", { site: "chatgpt" });
  assert(t.ok && /^\d{4}$/.test(t.number), `🔢 started (${t.number})`);
  assert(await waitUntil(() => /"kind":"teach-parked-waiting"[^\n]*"site":"chatgpt"[^\n]*"request_id":"late-chatgpt-1"/.test(logNow().slice(log2)), 2000), "logged: waiting for the late answer was stopped for the setup");
  h = await request("GET", "/v1/health", token);
  assert(h.json.sites.chatgpt.busy === false, "ChatGPT is no longer reserved for it");
  // the user types the number; the page reader picks it up (4 characters, like the PC log)
  chw.currentText = t.number;
  await sleep(1500);
  const tail2 = logNow().slice(log2);
  assert(!/LATE_REPLY_STORED/.test(tail2) && !/"kind":"akowe-owned-reply"[^\n]*"site":"chatgpt"/.test(tail2), "the typed number is NOT taken as the late answer (no LATE_REPLY_STORED)");
  const events = (await call("akowe:status")).activity.filter((a) => a.request_id === "late-chatgpt-1");
  assert(events.some((a) => a.outcome === "LATE_EXPIRED" && /started 🔢 setup/.test(a.say || "")), `the activity feed explains it (${events.map((a) => a.say).join(" | ")})`);
  assert(!(await call("state:get")).transcript.some((x) => x.site === "chatgpt" && x.text.trim() === t.number), "and the number is not shown as a ChatGPT reply in the conversation");
  await call("selfrepair:teach-cancel", { site: "chatgpt" });
  await waitUntil(async () => !(await call("selfrepair:status")).sites.chatgpt.teach.active);
  chw.evaluator = null;
  chw.currentText = "";

  // ---------------------------------------------------------------------------------
  console.log("\n== Problem 1: the 🧪 connection test with Claude's curly quotes ==");
  assert(await waitUntil(async () => { const x = await request("GET", "/v1/health", token); return ["chatgpt", "claude", "gemini"].every((s) => !x.json.sites[s].busy && x.json.sites[s].ready); }, 15000, 200), "(every AI free again: Claude's lost prompt's late window is over)");
  const curly = (s) => s.replace(/"([^"]*)"/g, "“$1”");
  const answered = new Set();
  let claudeMode = "curly";
  const claudeJson = [];
  const responder = setInterval(() => {
    for (const site of ["chatgpt", "claude", "gemini"]) {
      const w = reg(site).webContents;
      w.sentLog.forEach((e, i) => {
        const key = `${site}:${i}`;
        if (answered.has(key) || !String(e.text).includes("AutoInjector link test (automatic")) return;
        answered.add(key);
        const word = /"word": "([a-z]+)"/.exec(e.text)[1];
        const json = `{"ok": true, "site": "${site}", "word": "${word}"}`;
        if (site === "claude") claudeJson.push(json);
        const body = site !== "claude" ? json : claudeMode === "curly" ? curly(json) : "I can’t help with that “test” right now.";
        w.currentText = `${body}\n[FROM: ${site.toUpperCase()}]`;
      });
    }
  }, 30);
  let lt = await call("akowe:linktest-run");
  let trip = lt.steps.find((x) => x.id === "roundtrip:claude");
  assert(trip && trip.status === "pass" && /curly/.test(trip.detail), `Claude's round trip PASSES although its site showed “ ” (${trip && trip.status}: ${trip && trip.detail})`);
  const js = JSON.parse(fs.readFileSync(lt.reportJson, "utf8"));
  const jsTrip = js.steps.find((x) => x.id === "roundtrip:claude");
  assert(jsTrip.reply_chars === claudeJson[0].length && jsTrip.curly_quotes === true, `the saved report: all ${claudeJson[0].length} characters of Claude's answer arrived (in the PC log 48 = the whole answer, not a cut-off) and the curly quotes are noted (${jsTrip.reply_chars})`);
  claudeMode = "wrong";
  for (const site of ["chatgpt", "claude", "gemini"]) reg(site).webContents.currentText = ""; // a fresh page: the next answer is a new message
  await sleep(300);
  lt = await call("akowe:linktest-run");
  clearInterval(responder);
  trip = lt.steps.find((x) => x.id === "roundtrip:claude");
  assert(trip && trip.status === "fail" && trip.reply_excerpt === "I can’t help with that “test” right now.", `a reply that really is not the JSON: what Claude wrote travels with the failure for "Technical details" (${JSON.stringify(trip && trip.reply_excerpt)})`);
  const md = fs.readFileSync(lt.report, "utf8");
  assert(/What Claude wrote: I can’t help with that “test” right now\./.test(md) && !md.includes(token), "…and is in the saved report (never the key)");

  await call("akowe:set-enabled", { enabled: false });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
