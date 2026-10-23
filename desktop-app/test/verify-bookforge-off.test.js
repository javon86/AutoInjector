// test/verify-bookforge-off.test.js — pre-merge verification, driving the REAL
// main.js under mock Electron (like test/run.js):
//  A. BookForge OFF (default): no listener, normal relays/nudges unchanged, and
//     what the BookForge panel does in the background while the bridge is OFF.
//  B. The relay-trace "newest not seen being answered" rule in the real wiring:
//     a stale started-but-uncaptured message + a fast reply.
//  C. BookForge ON: the same situation decides ownership of a bridge answer.
//  D. Turning the bridge OFF with a request in flight: port closed, hooks stop.
// Run: node test/verify-bookforge-off.test.js
process.env.AUTOINJECTOR_BRIDGE = "0";
process.env.AUTOINJECTOR_POLL_MS = "50";
process.env.AUTOINJECTOR_STABLE_MS = "80";
process.env.AUTOINJECTOR_RETRY_BACKOFF_MS = "150";
process.env.AUTOINJECTOR_SAVE_DEBOUNCE_MS = "60";
process.env.AUTOINJECTOR_NOTAG_QUIET_MS = "300";
process.env.AUTOINJECTOR_CAPTURE_SETTLE_MS = "100";
process.env.AUTOINJECTOR_FORCE_ACCEPT_STABLE_MS = "150";
process.env.AUTOINJECTOR_SEND_BUSY_POLL_MS = "50";
process.env.AUTOINJECTOR_STALL_MS = "1500"; // Relay Trace "no reply" after 1.5 s
process.env.AUTOINJECTOR_BOOKFORGE_PORT = String(20000 + Math.floor(Math.random() * 20000));
// Deliberately NOT setting AUTOINJECTOR_BOOKFORGE_APP_URL / BOOKFORGE_PORT: that is the
// default a user has, so the panel's "is BookForge running?" check scans 8780..8799.
delete process.env.AUTOINJECTOR_BOOKFORGE_APP_URL;
delete process.env.BOOKFORGE_PORT;

const path = require("path");
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

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(fn, timeout = 5000) { const s = Date.now(); while (Date.now() - s < timeout) { const r = await fn(); if (r) return r; await sleep(25); } return null; }
function call(ch, p) { return mockElectron.__ipcHandlers[ch]({}, p); }
function reg(site) { return mockElectron.__registry[site]; }
const PORT = Number(process.env.AUTOINJECTOR_BOOKFORGE_PORT);
function request(method, urlPath, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (data) { headers["Content-Type"] = "application/json"; headers["Content-Length"] = data.length; }
    const req = http.request({ host: "127.0.0.1", port: PORT, method, path: urlPath, headers, agent: false }, (res) => {
      const chunks = []; res.on("data", (c) => chunks.push(c));
      res.on("end", () => { let json = null; try { json = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch (_) {} resolve({ status: res.statusCode, json }); });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}
// An unrelated local service on a port in BookForge's fallback range.
function countingServer(port) {
  return new Promise((resolve) => {
    const hits = [];
    const srv = http.createServer((req, res) => { hits.push(req.url); res.writeHead(404); res.end("not bookforge"); });
    srv.once("error", () => resolve(null));
    srv.listen(port, "127.0.0.1", () => resolve({ srv, hits }));
  });
}
const seqOf = (t) => (/^\[MSG #(\d{4})\]/.exec(t || "") || [])[1];

async function main() {
  const probe = await countingServer(8790);
  require(path.join(__dirname, "..", "main.js"));
  await waitUntil(() => reg("claude") && reg("gemini") && reg("chatgpt"));
  await sleep(300);

  console.log("\n== A. BookForge OFF (default) ==");
  let st = await call("bookforge:status");
  assert(st.enabled === false && st.listening === false, "bridge OFF by default");
  let refused = false;
  try { await request("GET", "/v1/health"); } catch (e) { refused = e.code === "ECONNREFUSED"; }
  assert(refused, "nothing listens on the bridge port");
  if (probe) {
    await waitUntil(() => probe.hits.length > 0, 4000);
    assert(probe.hits.length === 0, `with the bridge OFF the panel's status poll must not contact other local services — got ${probe.hits.length} GET(s) ${JSON.stringify(probe.hits.slice(0, 2))} on 127.0.0.1:8790 (bookforgeAppCheckSoon scans 8780..8799 every 30 s from bookforge:status, which controls.js calls every 4 s regardless of the bridge)`);
  } else console.log("  (port 8790 busy here; ping-scan check skipped)");

  // Normal untagged reply: the missing-tag nudge still goes out (no BookForge acceptance).
  const g = reg("gemini").webContents;
  g.sentLog = [];
  await call("send:compose", { text: "hello gemini", targets: ["gemini"] });
  g.currentText = "an answer that forgot its closing tag";
  const nudge = await waitUntil(() => g.sentLog.find((e) => e !== g.sentLog[0] && /FROM/.test(e.text || "")), 4000);
  assert(!!nudge, "bridge OFF: an untagged reply still gets the normal missing-[FROM:] nudge");
  g.currentText = "an answer that forgot its closing tag\n[FROM: GEMINI]";
  await sleep(500);

  console.log("\n== B. Relay Trace in the real wiring: stale started message + fast reply ==");
  await call("trace:report", { reset: true });
  const c = reg("claude").webContents;
  c.sentLog = [];
  // 1) a NONE reply, seen being written -> captured
  await call("send:compose", { text: "one", targets: ["claude"] });
  c.generating = true; await sleep(200); c.currentText = "NONE"; c.generating = false; await sleep(500);
  // 2) a second identical NONE, seen being written -> swallowed WITHOUT a capture (seen.text === text)
  await call("send:compose", { text: "two", targets: ["claude"] });
  c.generating = true; await sleep(200); c.generating = false; await sleep(500);
  // 3) a real reply that arrives faster than a poll (generating edge never seen)
  await call("send:compose", { text: "three", targets: ["claude"] });
  c.currentText = "[TO: USER]\nreal answer to three\n[FROM: CLAUDE]";
  await sleep(600);
  const seqs = c.sentLog.map((e) => seqOf(e.text));
  await sleep(1600);
  let tr = await call("trace:report", {});
  const anomalies = (tr.report.anomalies || []).filter((a) => a.target === "claude");
  const third = seqs[2];
  const falseNoReply = anomalies.find((a) => a.seq === third && /no reply/.test(a.what));
  console.log(`    claude sends ${seqs.join(", ")}; anomalies: ${JSON.stringify(anomalies.map((a) => `${a.seq}: ${a.what}`))}`);
  assert(!falseNoReply, `RISK (diagnostic): #${third} WAS answered ("real answer to three" was captured) but the Relay Trace reports it as NO REPLY and credits the answer to the stale #${seqs[1]}`);

  console.log("\n== C. BookForge ON: the same situation decides who owns the answer ==");
  st = await call("bookforge:set-enabled", { enabled: true });
  assert(st.listening === true, "bridge ON listens");
  const token = (await call("bookforge:reveal-token")).token;
  await call("trace:report", { reset: true });
  await call("routing:set", { source: "claude", target: "gemini", enabled: true });
  c.sentLog = []; g.sentLog = [];
  // stale started message on claude again
  await call("send:compose", { text: "four", targets: ["claude"] });
  c.generating = true; await sleep(200); c.currentText = "NONE"; c.generating = false; await sleep(500);
  await call("send:compose", { text: "five", targets: ["claude"] });
  c.generating = true; await sleep(200); c.generating = false; await sleep(500);
  g.sentLog = [];
  const p = request("POST", "/v1/complete", token, { site: "claude", prompt: "Give me JSON.", request_id: "verify-c-1", timeout_ms: 10000 });
  const bfSent = await waitUntil(() => c.sentLog.find((e) => /Give me JSON/.test(e.text || "")));
  assert(!!bfSent, "bridge prompt typed");
  c.currentText = "[TO: USER]\n{\"ok\": true}\n[FROM: CLAUDE]"; // fast answer (no generating edge)
  await sleep(800);
  const leaked = g.sentLog.find((e) => /\{"ok": true\}/.test(e.text || ""));
  assert(!leaked, `BookForge's answer must not be relayed to Gemini by mesh routing (leaked: ${!!leaked})`);
  const r = await p;
  assert(r.status === 200, `the bridge request gets its answer (got HTTP ${r.status} ${r.json && r.json.error})`);
  await call("routing:set", { source: "claude", target: "gemini", enabled: false });
  // Unblock claude for D: give it a fresh answer if the bridge is still waiting (late window).
  c.currentText = "[TO: USER]\n{\"ok\": 2}\n[FROM: CLAUDE]"; c.generating = true; await sleep(150); c.generating = false; await sleep(400);

  console.log("\n== D. Turning the bridge OFF with a request in flight ==");
  st = await call("bookforge:status");
  // make sure the site is free: wait out any late reservation from C
  await waitUntil(async () => { const s = await call("bookforge:status"); return !s.sites.claude.inFlight; }, 3000);
  const pending = request("POST", "/v1/complete", token, { site: "gemini", prompt: "never answered", request_id: "verify-d-1", timeout_ms: 60000 })
    .then((x) => ({ ok: true, x }), (e) => ({ ok: false, code: e.code }));
  await waitUntil(() => g.sentLog.find((e) => /never answered/.test(e.text || "")));
  st = await call("bookforge:set-enabled", { enabled: false });
  assert(st.enabled === false && st.listening === false, "bridge OFF: not listening");
  const pr = await pending;
  assert(pr.ok && pr.x.status === 503, `the in-flight request is answered 503 "the bridge was stopped" (got ${pr.ok ? "HTTP " + pr.x.status : "socket error " + pr.code})`);
  refused = false;
  try { await request("GET", "/v1/health", token); } catch (e) { refused = e.code === "ECONNREFUSED"; }
  assert(refused, "port closed after turning OFF");
  // Hooks off: an untagged reply on gemini now gets the normal nudge again (no BookForge acceptance).
  const before = g.sentLog.length;
  g.currentText = "untagged after bridge off";
  const n2 = await waitUntil(() => g.sentLog.length > before && /FROM/.test(g.sentLog[g.sentLog.length - 1].text || ""), 4000);
  assert(!!n2, "after OFF, pollSite treats an untagged reply normally (nudge sent; bookforgeAwaitingReply is false)");

  if (probe) probe.srv.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
