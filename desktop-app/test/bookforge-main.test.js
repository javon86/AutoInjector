// test/bookforge-main.test.js — drives the REAL main.js (mock Electron, see
// mock-electron.js) to check the BookForge bridge wiring: OFF by default, IPC
// enable/disable, token file, sends through sendTextTo() with the [FROM:]
// envelope + [MSG #] numbering, and a bridge-owned reply is shown in the
// transcript but NOT relayed by mesh routing. Run with: node test/bookforge-main.test.js
process.env.AUTOINJECTOR_POLL_MS = "50";
process.env.AUTOINJECTOR_SAVE_DEBOUNCE_MS = "30";
process.env.AUTOINJECTOR_RETRY_BACKOFF_MS = "50";
process.env.AUTOINJECTOR_BRIDGE_PORT = String(20000 + Math.floor(Math.random() * 20000));

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
const PORT = Number(process.env.AUTOINJECTOR_BRIDGE_PORT);

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

  let st = await call("bookforge:status");
  assert(st.ok && st.enabled === false && st.listening === false, "bridge is OFF by default");
  let refused = false;
  try { await request("GET", "/v1/health"); } catch (e) { refused = e.code === "ECONNREFUSED"; }
  assert(refused, "disabled bridge -> connection refused");
  assert(!fs.existsSync(tokenFile), "no token file before first enable");

  st = await call("bookforge:set-enabled", { enabled: true });
  assert(st.enabled === true && st.listening === true && st.port === PORT, "enable starts listening on AUTOINJECTOR_BRIDGE_PORT");
  assert(fs.existsSync(tokenFile), "token file created on first enable");
  if (process.platform !== "win32") assert((fs.statSync(tokenFile).mode & 0o777) === 0o600, "token file is mode 0600");
  const reveal = await call("bookforge:reveal-token");
  const token = reveal.token;
  assert(reveal.ok && token.length >= 32, "reveal-token returns the token");

  let r = await request("GET", "/v1/health", token);
  assert(r.status === 200 && r.json.sites.claude.ready === true, "health through main.js reports ready panes");

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

  const before = token;
  st = await call("bookforge:regenerate-token");
  const after = (await call("bookforge:reveal-token")).token;
  assert(st.ok && after !== before, "regenerate-token makes a new token");
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
