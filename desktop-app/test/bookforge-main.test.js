// test/bookforge-main.test.js — drives the REAL main.js (mock Electron, see
// mock-electron.js) to check the BookForge bridge wiring: OFF by default, IPC
// enable/disable, token file, sends through sendTextTo() with the [FROM:]
// envelope + [MSG #] numbering, and a bridge-owned reply is shown in the
// transcript but NOT relayed by mesh routing. Run with: node test/bookforge-main.test.js
process.env.AUTOINJECTOR_POLL_MS = "50";
process.env.AUTOINJECTOR_SAVE_DEBOUNCE_MS = "30";
process.env.AUTOINJECTOR_RETRY_BACKOFF_MS = "50";
process.env.AUTOINJECTOR_BRIDGE = "0"; // keep main's separate service bridge off in this test
process.env.AUTOINJECTOR_BOOKFORGE_PORT = String(20000 + Math.floor(Math.random() * 20000));
process.env.AUTOINJECTOR_BF_LINKTEST_MS = "15000"; // link-test reply limit (contract min is 10000)
// Point the link test's "is BookForge running?" check at a port nothing listens on.
process.env.AUTOINJECTOR_BOOKFORGE_APP_URL = `http://127.0.0.1:${Number(process.env.AUTOINJECTOR_BOOKFORGE_PORT) + 1}/api/ping`;

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

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ok   - ${msg}`); }
  else { failed++; console.log(`  FAIL - ${msg}`); }
  return cond;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(fn, timeout = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { const r = await fn(); if (r) return r; await sleep(25); }
  return null;
}
function call(channel, payload) { return mockElectron.__ipcHandlers[channel]({}, payload); }
function reg(site) { return mockElectron.__registry[site]; }
const PORT = Number(process.env.AUTOINJECTOR_BOOKFORGE_PORT);

function request(method, urlPath, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (data) { headers["Content-Type"] = "application/json"; headers["Content-Length"] = data.length; }
    const req = http.request({ host: "127.0.0.1", port: PORT, method, path: urlPath, headers, agent: false }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => { let json = null; try { json = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch (_) {} resolve({ status: res.statusCode, json }); });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

async function main() {
  require(path.join(__dirname, "..", "main.js"));
  await waitUntil(() => reg("claude") && reg("gemini"));
  const userData = mockElectron.app.getPath("userData");
  const tokenFile = path.join(userData, "bookforge-bridge-token");

  const activity = []; // every "bookforge-activity" broadcast the panel would get
  const ltProgress = [];
  reg("controls-ui").webContents.on("ipc-send", (channel, payload) => {
    if (channel === "bookforge-activity") activity.push(payload);
    if (channel === "bookforge-linktest-progress") ltProgress.push(payload);
  });

  let st = await call("bookforge:status");
  assert(st.ok && st.enabled === false && st.listening === false, "bridge is OFF by default");
  assert(st.lastContactAt === null && st.lastExternalContactAt === null && Array.isArray(st.activity) && st.linkTest && st.linkTest.running === false, "status snapshot carries lastContact / activity / linkTest fields");
  assert(st.sites.claude && st.sites.claude.label === "Claude" && typeof st.sites.claude.active === "boolean" && "last" in st.sites.claude, "per-AI snapshot: label, Active-in-app, last result");
  let refused = false;
  try { await request("GET", "/v1/health"); } catch (e) { refused = e.code === "ECONNREFUSED"; }
  assert(refused, "disabled bridge -> connection refused");
  assert(!fs.existsSync(tokenFile), "no token file before first enable");

  st = await call("bookforge:set-enabled", { enabled: true });
  assert(st.enabled === true && st.listening === true && st.port === PORT, "enable starts listening on AUTOINJECTOR_BOOKFORGE_PORT");
  assert(fs.existsSync(tokenFile), "token file created on first enable");
  if (process.platform !== "win32") assert((fs.statSync(tokenFile).mode & 0o777) === 0o600, "token file is mode 0600");
  const reveal = await call("bookforge:reveal-token");
  const token = reveal.token;
  assert(reveal.ok && token.length >= 32, "reveal-token returns the token");

  assert(await waitUntil(() => activity.some((a) => a.event && a.event.kind === "listening")), "turning the bridge on broadcasts a 'bookforge-activity' event");
  const onEv = activity.find((a) => a.event && a.event.kind === "listening");
  assert(onEv && /Bridge turned on/.test(onEv.event.say) && onEv.status && onEv.status.ok === true, "activity events carry a plain-English line + a fresh status snapshot");

  let r = await request("GET", "/v1/health", "a-wrong-key-from-somewhere-1234567890");
  assert(r.status === 401, "wrong key -> 401");
  assert(await waitUntil(() => activity.some((a) => a.event && a.event.kind === "unauthorized")), "a wrong-key attempt is broadcast as activity");
  r = await request("GET", "/v1/health", token);
  assert(r.status === 200 && r.json.sites.claude.ready === true, "health through main.js reports ready panes");
  assert(await waitUntil(() => activity.some((a) => a.event && a.event.kind === "connected" && a.event.say === "BookForge connected")), "first authenticated request -> 'BookForge connected' activity");
  st = await call("bookforge:status");
  assert(typeof st.lastExternalContactAt === "number" && typeof st.lastContactAt === "number", "status snapshot reports last contact");

  // Mesh routing claude -> gemini is ON: a bridge-owned claude reply must NOT be relayed.
  await call("routing:set", { source: "claude", target: "gemini", enabled: true });
  reg("gemini").webContents.sentLog = [];
  reg("claude").webContents.sentLog = [];
  const p = request("POST", "/v1/complete", token, { site: "claude", prompt: "Write the outline.", request_id: "bf-main-1", timeout_ms: 30000 });
  const sent = await waitUntil(() => reg("claude").webContents.sentLog[0]);
  assert(sent && /^\[MSG #\d{4}\]\n/.test(sent.text), "prompt went through sendTextTo ([MSG #] header)");
  assert(sent && sent.text.includes("Write the outline.") && sent.text.includes("[FROM: CLAUDE]"), "prompt carries the [FROM: CLAUDE] envelope instruction");
  const seq = sent && /^\[MSG #(\d{4})\]/.exec(sent.text)[1];
  reg("claude").webContents.currentText = "[TO: USER]\nHere is the outline.\n[FROM: CLAUDE]";
  r = await p;
  assert(r.status === 200 && r.json.text === "Here is the outline.", "200 with envelope-stripped reply");
  assert(r.json && r.json.seq === seq, `seq matches the [MSG #] of the send (${r.json && r.json.seq} vs ${seq})`);
  await sleep(300);
  assert(reg("gemini").webContents.sentLog.length === 0, "bridge-owned reply was NOT relayed by mesh routing");
  const stateRes = await call("state:get");
  assert(stateRes.transcript.some((t) => t.site === "claude" && t.text === "Here is the outline."), "bridge-owned reply is shown in the transcript");

  // A normal (non-bridge) reply still relays as before.
  reg("claude").webContents.currentText = "[TO: USER]\nA normal follow-up.\n[FROM: CLAUDE]";
  const relayed = await waitUntil(() => reg("gemini").webContents.sentLog[0]);
  assert(relayed && relayed.text.includes("A normal follow-up."), "a non-bridge reply is still relayed normally");
  await call("routing:set", { source: "claude", target: "gemini", enabled: false });
  assert(activity.some((a) => a.event && a.event.kind === "outcome" && a.event.outcome === "OK" && a.event.site === "claude" && /Claude answered in/.test(a.event.say)), "the answered request shows up as 'Claude answered in …'");
  st = await call("bookforge:status");
  assert(st.sites.claude.last && st.sites.claude.last.outcome === "OK", "per-AI last result is in the snapshot");
  const actDump = JSON.stringify(activity) + JSON.stringify(st);
  assert(!actDump.includes("Write the outline.") && !actDump.includes("Here is the outline.") && !actDump.includes(token) && !actDump.includes("a-wrong-key-from-somewhere"), "activity + snapshot never carry prompt/reply text or any key");

  // 🧪 Test BookForge link: a REAL run through main.js -> bridge HTTP -> panes.
  const answered = new Set();
  const responder = setInterval(() => {
    for (const site of ["chatgpt", "claude", "gemini"]) {
      const v = reg(site);
      if (!v || !v.webContents.sentLog) continue;
      v.webContents.sentLog.forEach((e, i) => {
        const key = `${site}:${i}`;
        if (answered.has(key) || !e.text.includes("AutoInjector link test")) return;
        answered.add(key);
        const word = /"word": "([a-z]+)"/.exec(e.text)[1];
        v.webContents.currentText = `[TO: USER]\n{"ok": true, "site": "${site}", "word": "${word}"}\n[FROM: ${site.toUpperCase()}]`;
      });
    }
  }, 30);
  const lt = await call("bookforge:linktest-run");
  clearInterval(responder);
  const activeSites = ["chatgpt", "claude", "gemini"].filter((s) => st.sites[s].active);
  assert(lt.ok && lt.failCount === 0, `link test ran with no failures (${lt.passCount} passed, ${lt.failCount} failed, ${lt.skipCount} skipped: ${(lt.steps || []).filter((x) => x.status !== "pass").map((x) => x.id + "=" + x.detail).join(" | ")})`);
  assert(lt.steps.filter((x) => x.id.startsWith("roundtrip:") && x.status === "pass").length === activeSites.length && activeSites.length > 0, `a real round trip passed for every Active AI (${activeSites.join(", ")})`);
  const bfStep = lt.steps.find((x) => x.id === "bookforge_running");
  assert(bfStep && bfStep.status === "skip" && /isn't running/.test(bfStep.detail), "BookForge not running -> SKIPPED with instructions");
  assert(lt.report && fs.existsSync(lt.report) && /bookforge-link-test-[0-9-]+\.md$/.test(lt.report) && lt.reportJson && fs.existsSync(lt.reportJson), "Markdown + JSON reports written to the logs folder");
  const md = fs.readFileSync(lt.report, "utf8");
  const js = JSON.parse(fs.readFileSync(lt.reportJson, "utf8"));
  assert(!md.includes(token) && !JSON.stringify(js).includes(token) && !md.includes("JSON_SCHEMA") && !JSON.stringify(js).includes("JSON_SCHEMA"), "reports contain neither the key nor the prompt text");
  assert(/## Environment/.test(md) && /## Recent bridge activity/.test(md) && js.steps.length === lt.total, "report documents environment, every step and recent activity");
  assert(ltProgress.some((p) => p.status === "start") && ltProgress.some((p) => p.status === "pass") && ltProgress.some((p) => p.status === "done"), "live progress is broadcast (start, per step, done)");
  st = await call("bookforge:status");
  assert(st.linkTest.lastReport === lt.report && st.linkTest.lastSummary && st.linkTest.lastSummary.failCount === 0, "status remembers the last link-test report + summary");
  assert(st.activity.some((a) => /Link test finished/.test(a.say || "")), "the activity feed notes the finished link test");
  const debugNow = fs.readFileSync(path.join(userData, "autoinjector-debug.log"), "utf8");
  assert(/bookforge-linktest-done/.test(debugNow), "link test logged via logEvent");
  let open = await call("bookforge:linktest-open-report", { file: path.join(path.dirname(lt.report), "feature-test-x.md") });
  assert(open.ok === false && open.error === "BAD_FILE", "open-report refuses other file names");
  open = await call("bookforge:linktest-open-report", { file: "/etc/passwd" });
  assert(open.ok === false && open.error === "BAD_FILE", "open-report refuses files outside the logs folder");
  open = await call("bookforge:linktest-open-report", { file: lt.report });
  assert(open.error !== "BAD_FILE", "open-report accepts the real report (passes the name/folder check)");
  assert((await call("bookforge:linktest-stop")).ok === true, "linktest-stop is wired");

  const before = token;
  st = await call("bookforge:regenerate-token");
  const after = (await call("bookforge:reveal-token")).token;
  assert(st.ok && after !== before, "regenerate-token makes a new token");
  assert(await waitUntil(() => activity.some((a) => a.event && a.event.kind === "key_changed")), "making a new key is broadcast as activity");
  r = await request("GET", "/v1/health", before);
  assert(r.status === 401, "old token rejected immediately after regenerate");
  r = await request("GET", "/v1/health", after);
  assert(r.status === 200, "new token accepted");

  st = await call("bookforge:set-enabled", { enabled: false });
  assert(st.enabled === false && st.listening === false, "disable stops the server");
  refused = false;
  try { await request("GET", "/v1/health", after); } catch (e) { refused = e.code === "ECONNREFUSED"; }
  assert(refused, "connection refused after disable");
  await sleep(150);
  const saved = JSON.parse(fs.readFileSync(path.join(userData, "autoinjector-state.json"), "utf8"));
  assert(saved.bookforge && saved.bookforge.enabled === false && !JSON.stringify(saved).includes(after), "enabled flag persisted; token never in the state file");
  const debugLog = fs.existsSync(path.join(userData, "autoinjector-debug.log")) ? fs.readFileSync(path.join(userData, "autoinjector-debug.log"), "utf8") : "";
  assert(!debugLog.includes(after) && !debugLog.includes(before), "token never in the debug log");

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
