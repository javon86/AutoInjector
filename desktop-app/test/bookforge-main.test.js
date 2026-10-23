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
// shell.openExternal is mocked (main.js destructures `shell` when it loads): record every URL.
const openedUrls = [];
mockElectron.shell = { openExternal: async (u) => { openedUrls.push(String(u)); }, openPath: async () => "" };
// "Start BookForge for me": a fake launcher next to the app that only leaves a marker file.
const os = require("os");
const bfDir = fs.mkdtempSync(path.join(os.tmpdir(), "bf-launcher-"));
const launcherMarker = path.join(bfDir, "started.marker");
fs.writeFileSync(path.join(bfDir, process.platform === "win32" ? "run-bookforge.bat" : "run-bookforge.sh"),
  process.platform === "win32" ? `@echo off\r\necho started> "${launcherMarker}"\r\n` : `#!/bin/sh\necho started > "${launcherMarker}"\n`);
process.env.AUTOINJECTOR_BOOKFORGE_DIR = bfDir;
process.env.AUTOINJECTOR_BF_START_WAIT_MS = "600";

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
  // Untagged on purpose: a written [TO: USER] now stays with the user (TR-05), so it would not be relayed.
  reg("claude").webContents.currentText = "A normal follow-up.\n[FROM: CLAUDE]";
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
  const connStep = lt.steps.find((x) => x.id === "bookforge_connected");
  assert(connStep && connStep.status === "pass" && /has the connection key/.test(connStep.detail) && lt.steps[lt.steps.length - 1] === connStep, "link test ends with 'BookForge is connected' (PASS: a client already talked to the bridge with the key)");
  assert(lt.report && fs.existsSync(lt.report) && /bookforge-link-test-[0-9-]+\.md$/.test(lt.report) && lt.reportJson && fs.existsSync(lt.reportJson), "Markdown + JSON reports written to the logs folder");
  const md = fs.readFileSync(lt.report, "utf8");
  const js = JSON.parse(fs.readFileSync(lt.reportJson, "utf8"));
  assert(!md.includes(token) && !JSON.stringify(js).includes(token) && !md.includes("JSON_SCHEMA") && !JSON.stringify(js).includes("JSON_SCHEMA"), "reports contain neither the key nor the prompt text");
  assert(/## Environment/.test(md) && /## Recent bridge activity/.test(md) && js.steps.length === lt.total, "report documents environment, every step and recent activity");
  assert(ltProgress.some((p) => p.status === "start") && ltProgress.some((p) => p.status === "pass") && ltProgress.some((p) => p.status === "done"), "live progress is broadcast (start, per step, done)");
  st = await call("bookforge:status");
  assert(st.linkTest.lastReport === lt.report && st.linkTest.lastSummary && st.linkTest.lastSummary.failCount === 0, "status remembers the last link-test report + summary");
  assert(st.activity.some((a) => /Link test finished/.test(a.say || "")), "the activity feed notes the finished link test");
  const diag = await call("bookforge:diagnostics", {});
  assert(diag.ok && new RegExp(`Last link test: \\d+s ago · ${lt.passCount} passed · ${lt.failCount} failed · ${lt.skipCount} skipped`).test(diag.text) && /not passed: bookforge_running=skip/.test(diag.text), "📋 diagnostics summarise the last link test (counts + ids of steps that didn't pass)");
  assert(!diag.text.includes(token) && !diag.text.includes("Write the outline.") && !diag.text.includes("Here is the outline.") && !diag.text.includes("AutoInjector link test"), "diagnostics never carry the key, prompts, replies or the link-test question");
  assert(st.health && ["ok", "warn", "bad", "off"].includes(st.health.level) && st.health.checks.some((c) => c.id === "bridge" && c.level === "ok"), "status snapshot carries the overall health (bridge check green while listening)");
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

  // --- 🔗 Connect BookForge (contract v1.1 pairing) -----------------------------
  const BF_APP_PORT = PORT + 1; // AUTOINJECTOR_BOOKFORGE_APP_URL points here (nothing listening yet)
  st = await call("bookforge:set-enabled", { enabled: false });
  assert(st.enabled === false && st.listening === false, "(bridge off before the Connect test)");
  openedUrls.length = 0;
  st = await call("bookforge:connect");
  assert(st.ok && st.enabled === true && st.listening === true, "Connect turns the bridge on when it was off");
  assert(st.connect.phase === "not_running" && /isn't running/.test(st.connect.message) && /run-bookforge/.test(st.connect.message), "BookForge not running -> plain instructions (start run-bookforge, press Connect again)");
  assert(st.connect.canStartApp === true && st.app.launcherAvailable === true, "...and offers 'Start BookForge for me' when the launcher exists next to the app");
  assert(openedUrls.length === 0, "nothing is opened in the browser while BookForge isn't running");
  const sa = await call("bookforge:start-app");
  assert(sa.ok && sa.started === true && sa.running === false && /still starting/.test(sa.message || ""), "start-app spawns the launcher and reports 'still starting' when BookForge doesn't answer in time");
  assert(await waitUntil(() => fs.existsSync(launcherMarker), 5000), "the launcher really ran (detached)");
  // A fake BookForge answering /api/ping.
  const fakeBf = http.createServer((req, res) => {
    if (req.url === "/api/ping") { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ app: "bookforge", version: "0.9.0" })); }
    else { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => fakeBf.listen(BF_APP_PORT, "127.0.0.1", r));
  st = await call("bookforge:connect");
  const pairUrlRe = new RegExp(`^http://127\\.0\\.0\\.1:${BF_APP_PORT}/#/pair\\?code=([A-Za-z0-9]{12})&bridge=${encodeURIComponent(`http://127.0.0.1:${PORT}`).replace(/\./g, "\\.")}$`);
  const m = openedUrls.length === 1 ? pairUrlRe.exec(openedUrls[0]) : null;
  assert(m, `Connect opens the browser at BookForge's #/pair?code=<12 chars>&bridge=<bridge url> (${openedUrls.join(" ")})`);
  assert(openedUrls.every((u) => !u.includes(after)), "the connection key is NEVER in the URL");
  assert(st.connect.phase === "waiting" && st.connect.expiresAt - st.connect.startedAt === 120000 && st.pairing && st.pairing.pending === true, "after opening: waiting for BookForge to pair (code valid 2 minutes)");
  assert(!JSON.stringify(st).includes(m ? m[1] : "@@") && !JSON.stringify(st).includes(after), "the snapshot never carries the pairing code or the key");
  const code = m ? m[1] : "";
  r = await request("POST", "/v1/pair", null, { code, client: "bookforge" });
  assert(r.status === 200 && r.json.token === after && r.json.bridge_version === "1.1", "BookForge trades the code for the key via POST /v1/pair (no Authorization)");
  r = await request("POST", "/v1/pair", null, { code, client: "bookforge" });
  assert(r.status === 401, "the code works only once");
  st = await call("bookforge:status");
  assert(st.connect.phase === "paired" && st.connection.paired === true, "the panel sees the pairing ('BookForge has the key')");
  const statusBody = { app: "bookforge", version: 1, bookforge_url: `http://127.0.0.1:${BF_APP_PORT}/`, project: { id: "p1", title: "The Lantern Keeper" },
    current_task: { set: "B", op: "B03", title: "Main plot", state: "running", message: "Drafting the main plot", url: `http://127.0.0.1:${BF_APP_PORT}/#/op/B03` },
    working_on: null, approvals: { count: 1, items: [{ op: "B02", set: "B", title: "Logline" }], url: `http://127.0.0.1:${BF_APP_PORT}/#/approvals` },
    checklist: [{ id: "A", title: "Book profile", set: "A", state: "done" }], done: 1, total: 9, updated_at: new Date().toISOString() };
  r = await request("POST", "/v1/status", after, statusBody);
  assert(r.status === 200 && r.json.ok === true, "BookForge posts its first status with the key");
  st = await call("bookforge:status");
  assert(st.connect.phase === "connected" && st.connection.connected === true, "first status after pairing -> 'Connected ✔'");
  assert(st.bookforge && st.bookforge.project.title === "The Lantern Keeper" && st.bookforge.current_task.op === "B03" && st.bookforge.approvals.count === 1 && st.bookforge.stale === false && st.bookforge.total === 9, "BookForge's status (step, approvals, checklist) shows up in the snapshot");
  assert(st.app.running === true && st.app.base === `http://127.0.0.1:${BF_APP_PORT}/`, "snapshot knows where BookForge runs");
  assert(await waitUntil(() => activity.some((a) => a.event && a.event.kind === "pair" && a.event.outcome === "PAIRED") && activity.some((a) => a.event && a.event.kind === "status")), "pairing + first status are broadcast as activity (outcome only)");
  const actDump2 = JSON.stringify(activity.map((x) => x.event)) + JSON.stringify(st.activity);
  assert(!actDump2.includes(code) && !actDump2.includes("Lantern Keeper") && !actDump2.includes("Drafting the main plot"), "activity never carries the code or the status content");
  // Open BookForge pages (Review & approve, Go to current task)
  openedUrls.length = 0;
  let o = await call("bookforge:open-url", { url: `http://127.0.0.1:${BF_APP_PORT}/#/approvals` });
  assert(o.ok && openedUrls[0] === `http://127.0.0.1:${BF_APP_PORT}/#/approvals`, "open-url opens a loopback BookForge page");
  o = await call("bookforge:open-url", { url: "https://evil.example/phish" });
  assert(o.ok && openedUrls[1] === `http://127.0.0.1:${BF_APP_PORT}/`, "open-url never opens a non-loopback URL (falls back to BookForge's own address)");
  // A new key drops the connection until BookForge reconnects
  st = await call("bookforge:regenerate-token");
  st = await call("bookforge:status");
  assert(st.connection.connected === false && st.connection.paired === false && st.connect.phase === "idle", "making a new key -> not connected any more (press Connect again)");
  const newest = (await call("bookforge:reveal-token")).token;
  const debugConnect = fs.readFileSync(path.join(userData, "autoinjector-debug.log"), "utf8");
  assert(/bookforge-connect/.test(debugConnect) && !debugConnect.includes(code) && !debugConnect.includes(after) && !debugConnect.includes(newest), "Connect is logged, but never the code or a key");
  await new Promise((r2) => fakeBf.close(r2));

  // "Ready" means the page check passes — not just "the window exists and isn't loading".
  {
    const cw = reg("claude").webContents;
    cw.inputFound = false; // the read finds no message box (signed out, or the site changed its page)
    let s2 = await waitUntil(async () => { const x = await call("bookforge:status"); return x.sites.claude.ready === false ? x : null; });
    assert(s2 && s2.sites.claude.problem === "NO_MESSAGE_BOX" && /message box/.test(s2.sites.claude.problemSay), `no message box on the page -> Claude is NOT ready (${s2 && s2.sites.claude.problem})`);
    r = await request("GET", "/v1/health", newest);
    assert(r.status === 200 && r.json.sites.claude.ready === false, "health tells BookForge Claude is not ready (so it never says 'logged in and free')");
    r = await request("POST", "/v1/complete", newest, { site: "claude", prompt: "hi", request_id: "notready-1", timeout_ms: 10000 });
    assert(r.status === 503 && r.json.error === "SITE_NOT_READY" && /message box/.test(r.json.message), `a prompt to a not-ready pane: 503 with the reason (${r.json && r.json.message})`);
    cw.inputFound = true;
    s2 = await waitUntil(async () => { const x = await call("bookforge:status"); return x.sites.claude.ready === true ? x : null; });
    assert(!!s2 && s2.sites.claude.problem === null, "message box back -> ready again");
    cw.emit("did-fail-load", {}, -105, "ERR_NAME_NOT_RESOLVED", "https://claude.ai/", true);
    s2 = await call("bookforge:status");
    assert(s2.sites.claude.ready === false && s2.sites.claude.problem === "LOAD_FAILED" && /didn't load/.test(s2.sites.claude.problemSay), "a page that failed to load is NOT ready");
    cw.emit("did-fail-load", {}, -3, "ERR_ABORTED", "https://claude.ai/x", true);
    cw.emit("did-finish-load");
    s2 = await call("bookforge:status");
    assert(s2.sites.claude.ready === true, "a later load that finishes makes it ready again");
  }

  st = await call("bookforge:set-enabled", { enabled: false });
  assert(st.enabled === false && st.listening === false, "disable stops the server");
  refused = false;
  try { await request("GET", "/v1/health", after); } catch (e) { refused = e.code === "ECONNREFUSED"; }
  assert(refused, "connection refused after disable");
  void newest;
  await sleep(150);
  const saved = JSON.parse(fs.readFileSync(path.join(userData, "autoinjector-state.json"), "utf8"));
  assert(saved.bookforge && saved.bookforge.enabled === false && !JSON.stringify(saved).includes(after), "enabled flag persisted; token never in the state file");
  const debugLog = fs.existsSync(path.join(userData, "autoinjector-debug.log")) ? fs.readFileSync(path.join(userData, "autoinjector-debug.log"), "utf8") : "";
  assert(!debugLog.includes(after) && !debugLog.includes(before), "token never in the debug log");

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
