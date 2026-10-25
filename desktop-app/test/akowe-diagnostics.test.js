// test/akowe-diagnostics.test.js — drives the REAL main.js (mock Electron) to check
// the Akọwe panel's 📋 Copy diagnostics and the health block in the status
// snapshot. Diagnostics must be useful (version, bridge, readiness, counters, link
// test, recent problem codes) and must NEVER contain the connection key, a wrong key
// someone tried, a pairing code, a prompt, a reply, or the book's content.
// Run with: node test/akowe-diagnostics.test.js
process.env.AUTOINJECTOR_POLL_MS = "50";
process.env.AUTOINJECTOR_SAVE_DEBOUNCE_MS = "30";
process.env.AUTOINJECTOR_RETRY_BACKOFF_MS = "50";
process.env.AUTOINJECTOR_BRIDGE = "0";
process.env.AUTOINJECTOR_CHECKIN = process.env.AUTOINJECTOR_CHECKIN || "0"; // P18: no automatic check-ins in this harness (test/self-repair-main.test.js covers them)
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
const openedUrls = [];
mockElectron.shell = { openExternal: async (u) => { openedUrls.push(String(u)); }, openPath: async () => "" };
let clipboardText = null;
mockElectron.clipboard = { writeText: (t) => { clipboardText = String(t); } };

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
const PORT = Number(process.env.AUTOINJECTOR_AKOWE_PORT);
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

  assert(typeof mockElectron.__ipcHandlers["akowe:diagnostics"] === "function" && typeof mockElectron.__ipcHandlers["akowe:copy-diagnostics"] === "function", "diagnostics IPC handlers are registered");
  const preload = fs.readFileSync(path.join(__dirname, "..", "preload.js"), "utf8");
  assert(/akoweCopyDiagnostics:.*"akowe:copy-diagnostics"/.test(preload) && /akoweDiagnostics:.*"akowe:diagnostics"/.test(preload), "preload exposes both diagnostics calls");

  // Bridge OFF: health is grey ("off"), diagnostics still work.
  let st = await call("akowe:status");
  assert(st.health && st.health.level === "off" && Array.isArray(st.health.checks), "health: bridge off -> level 'off'");
  let d = await call("akowe:diagnostics");
  assert(d.ok && /Bridge: OFF/.test(d.text) && /Connection key: missing/.test(d.text), "diagnostics with the bridge off: 'Bridge: OFF', key missing");

  // Plant a known (fake) key so we can prove it never appears.
  const PLANTED = "PLANTED-fake-key-0123456789-abcdefghijklmnop";
  fs.writeFileSync(path.join(userData, "akowe-bridge-token"), PLANTED + "\n", { mode: 0o600 });
  st = await call("akowe:set-enabled", { enabled: true });
  assert(st.listening === true && (await call("akowe:reveal-token")).token === PLANTED, "bridge uses the planted key");
  assert(st.health && ["warn", "bad"].includes(st.health.level) && st.health.checks.some((c) => c.id === "bridge" && c.level === "ok") && st.health.checks.some((c) => c.id === "key" && c.level === "ok"), `health: bridge on but Akọwe not connected -> not green (${st.health && st.health.level})`);
  assert(st.health.checks.some((c) => c.id === "akowe_reachable") && st.health.checks.some((c) => c.id === "status_fresh") && st.health.checks.some((c) => c.id.startsWith("pane:")), "health covers bridge, key, Akọwe reachable, status freshness and each Active pane");

  // A wrong key, a real round trip with prompt/reply text, a pairing code and a status with book content.
  const WRONG = "someone-elses-wrong-key-zzzzzzzzzzzzzzzz";
  let r = await request("GET", "/v1/health", WRONG);
  assert(r.status === 401, "wrong key refused");
  const PROMPT = "SECRET PROMPT: write chapter one about the lighthouse";
  const REPLY = "SECRET REPLY: the lighthouse keeper woke";
  reg("claude").webContents.sentLog = [];
  // The pane must have been read once (its message box seen) before it counts as ready.
  await waitUntil(async () => { const h = await request("GET", "/v1/health", PLANTED); return h.json && h.json.sites && h.json.sites.claude.ready; });
  const p = request("POST", "/v1/complete", PLANTED, { site: "claude", prompt: PROMPT, request_id: "bf-diag-1", timeout_ms: 30000 });
  await waitUntil(() => reg("claude").webContents.sentLog[0]);
  reg("claude").webContents.currentText = `[TO: USER]\n${REPLY}\n[FROM: CLAUDE]`;
  r = await p;
  assert(r.status === 200 && r.json.text === REPLY, `round trip answered (${r.status} ${r.json && r.json.error})`);
  const BF_APP_PORT = PORT + 1;
  const fakeBf = http.createServer((req, res) => {
    if (req.url === "/api/ping") { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ app: "akowe", version: "0.9.0" })); }
    else { res.writeHead(404); res.end(); }
  });
  await new Promise((rs) => fakeBf.listen(BF_APP_PORT, "127.0.0.1", rs));
  st = await call("akowe:connect");
  const m = /code=([A-Za-z0-9]{12})/.exec(openedUrls[0] || "");
  const CODE = m ? m[1] : "@@nocode@@";
  assert(!!m && st.connect.phase === "waiting", "Connect made a pairing code");
  r = await request("POST", "/v1/pair", null, { code: CODE, client: "akowe" });
  assert(r.status === 200, "Akọwe paired");
  const TITLE = "The Secret Lantern Keeper";
  const MESSAGE = "Drafting the secret main plot";
  r = await request("POST", "/v1/status", PLANTED, { app: "akowe", version: 1, project: { id: "p1", title: TITLE },
    current_task: { set: "B", op: "B03", title: "Main plot", state: "running", message: MESSAGE },
    approvals: { count: 2, items: [{ op: "B02", set: "B", title: "Secret logline" }] }, checklist: [{ id: "A", title: "Book profile", set: "A", state: "done" }], done: 1, total: 9, updated_at: new Date().toISOString() });
  assert(r.status === 200, "Akọwe posted its status");
  st = await call("akowe:status");
  assert(st.connection.connected === true && st.health.checks.find((c) => c.id === "status_fresh").level === "ok" && st.health.checks.find((c) => c.id === "akowe_reachable").level === "ok", "health: connected + fresh status + Akọwe reachable -> those checks are green");

  // 📋 Copy diagnostics
  clipboardText = null;
  const c = await call("akowe:copy-diagnostics", { panelProblems: ["SITE_NOT_READY", "UI_ERROR", "<img src=x onerror=alert(1)> with spaces"] });
  assert(c.ok && clipboardText === c.text && c.text.length > 200, "copy-diagnostics writes the summary to the clipboard");
  const T = c.text;
  if (process.env.BF_DIAG_PRINT) console.log(T);
  assert(/^AutoInjector — Akọwe bridge diagnostics/m.test(T) && /safe to share/.test(T), "starts with a title + 'safe to share' note");
  assert(/^App: AutoInjector \S+ · Electron/m.test(T), "app version line");
  assert(new RegExp(`Bridge: ON · listening yes · 127\\.0\\.0\\.1:${PORT}`).test(T), "bridge on + port");
  assert(/Connection key: present \(not shown\)/.test(T), "key presence only");
  assert(/Akọwe app: running · version 0\.9\.0/.test(T), "Akọwe reachability + version");
  assert(/Connection: connected yes · paired yes/.test(T) && /connect phase connected/.test(T), "connection + connect phase");
  assert(/Akọwe status: last update \d+s ago · task state running · approvals 2 · progress 1\/9/.test(T), "Akọwe status as counts/state words only");
  assert(/^Health: (OK|WARN|BAD) — bridge=ok, key=ok/m.test(T), "health line");
  assert(/^AI claude: active (yes|no) · ready yes · busy no · last OK \d+s/m.test(T) && /^AI chatgpt:/m.test(T) && /^AI gemini:/m.test(T), "per-AI readiness + last outcome");
  assert(/Counters: requests \d+ · answered 1 · timeouts 0 · refused \(wrong key\) 1/.test(T), "counters");
  assert(/Last link test: never run this session/.test(T), "link test summary (none yet)");
  assert(/Recent problems \(\d+\):[\s\S]*unauthorized/.test(T), "recent problem codes (the refused wrong key)");
  assert(/Panel problems shown: SITE_NOT_READY, UI_ERROR, OTHER/.test(T), "panel problem codes are passed through, anything odd becomes OTHER");
  const SECRETS = { "the connection key": PLANTED, "the wrong key": WRONG, "the pairing code": CODE, "the prompt": PROMPT, "the reply": REPLY, "the book title": TITLE, "the task message": MESSAGE, "an approval title": "Secret logline", "injected markup": "<img" };
  for (const [what, secret] of Object.entries(SECRETS)) assert(!T.includes(secret), `diagnostics never contain ${what}`);
  assert(!/lighthouse/i.test(T) && !/Bearer/i.test(T), "no prompt/reply fragments, no auth header text");
  const plain = await call("akowe:diagnostics", {});
  assert(plain.ok && Object.values(SECRETS).every((s) => !plain.text.includes(s)), "akowe:diagnostics (no clipboard) is just as clean");

  // No clipboard -> NO_CLIPBOARD, but the text comes back for the panel to show.
  const orig = mockElectron.clipboard.writeText;
  mockElectron.clipboard.writeText = () => { throw new Error("clipboard broken"); };
  const nc = await call("akowe:copy-diagnostics", {});
  mockElectron.clipboard.writeText = orig;
  assert(nc.ok === false && nc.error === "NO_CLIPBOARD" && typeof nc.text === "string" && !nc.text.includes(PLANTED), "clipboard failure -> NO_CLIPBOARD + the (safe) text to copy by hand");

  const debugLog = fs.readFileSync(path.join(userData, "autoinjector-debug.log"), "utf8");
  assert(/akowe-diagnostics-copied/.test(debugLog) && !debugLog.includes(PLANTED) && !debugLog.includes(CODE), "copying is logged (length only), never the key or code");

  await new Promise((rs) => fakeBf.close(rs));
  await call("akowe:set-enabled", { enabled: false });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
