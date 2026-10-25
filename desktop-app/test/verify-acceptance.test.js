// test/verify-acceptance.test.js — ACCEPTANCE run: a real author using Akọwe in a real browser while
// Akọwe talks to the AIs through the REAL AutoInjector bridge (main.js under mock-electron, the real
// automation scripts typing into fake chat sites in Chromium, answered by Akọwe's deterministic test AI).
//
// This file is the harness (same machinery as test/akowe-e2e.test.js, without the fault injection):
//   - boots main.js, three fake chat pages, the fake-AI brain and the real Akọwe server,
//   - asks AutoInjector to Connect (akowe:connect) and hands the #/pair link to the author driver,
//   - runs the author driver (python, Playwright, drives the Akọwe web UI like a person):
//       akowe/tests/campaign/verify/acceptance_driver.py
//   - offers a small control server so the driver can ask AutoInjector things:
//       GET /connect  -> a fresh pairing link        GET /status -> akowe:status + Relay Trace report
//
// Run:  node test/verify-acceptance.test.js
// Env:  HOLD=1         do not run the driver; print the control URL and wait (manual exploration)
//       SHOTS=dir      where the driver saves screenshots / downloads (default <tmp>/shots)
//       SPEED=0.25     fake-site timing multiplier
"use strict";
const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");
const net = require("net");
const { spawn } = require("child_process");

const SPEED = Number(process.env.SPEED) || 0.25;
const HOLD = process.env.HOLD === "1";
const AKOWE_ROOT = path.resolve(process.env.AKOWE_ROOT || path.join(__dirname, "..", "..", "akowe"));
const BRAIN = path.join(AKOWE_ROOT, "tests", "campaign", "bridge", "fake_site_brain.py");
const DRIVER = path.join(AKOWE_ROOT, "tests", "campaign", "verify", "acceptance_driver.py");
const PY = process.env.PYTHON || "python3";
const SITES = ["chatgpt", "claude", "gemini"];

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(fn, timeout, interval = 100) {
  const start = Date.now();
  while (Date.now() - start < timeout) { const r = await fn(); if (r) return r; await sleep(interval); }
  return null;
}

async function main() {
  const [BRIDGE_PORT, BF_PORT, CTL_PORT] = [await freePort(), await freePort(), await freePort()];
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "bf-accept-"));
  const DATA = path.join(work, "akowe-data");
  fs.mkdirSync(DATA);
  const emptyDir = path.join(work, "no-launcher");
  fs.mkdirSync(emptyDir);
  const SHOTS = path.resolve(process.env.SHOTS || path.join(work, "shots"));
  fs.mkdirSync(SHOTS, { recursive: true });

  Object.assign(process.env, {
    AUTOINJECTOR_BRIDGE: "0",
    AUTOINJECTOR_POLL_MS: "150",
    AUTOINJECTOR_STABLE_MS: "300",
    AUTOINJECTOR_RETRY_BACKOFF_MS: "300",
    AUTOINJECTOR_SAVE_DEBOUNCE_MS: "200",
    AUTOINJECTOR_NOTAG_QUIET_MS: "1500",
    AUTOINJECTOR_CAPTURE_SETTLE_MS: "400",
    AUTOINJECTOR_FORCE_ACCEPT_STABLE_MS: "800",
    AUTOINJECTOR_SEND_BUSY_POLL_MS: "150",
    AUTOINJECTOR_SEND_BUSY_WAIT_MS: "30000",
    AUTOINJECTOR_PROBE_DELAY_MS: "600000",
    AUTOINJECTOR_AKOWE_PORT: String(BRIDGE_PORT),
    AUTOINJECTOR_AKOWE_APP_URL: `http://127.0.0.1:${BF_PORT}/api/ping`,
    AUTOINJECTOR_AKOWE_DIR: emptyDir,
  });

  const Module = require("module");
  const mockElectronPath = path.join(__dirname, "mock-electron.js");
  const originalLoad = Module._load;
  Module._load = function (request) {
    if (request === "electron") return require(mockElectronPath);
    return originalLoad.apply(this, arguments);
  };
  const mockElectron = require(mockElectronPath);
  const opened = [];
  mockElectron.shell = { openExternal: async (u) => { opened.push(String(u)); }, openPath: async () => "" };
  try { const om = require(path.join(__dirname, "..", "ollama-manager")); om.detect = async () => ({ available: false }); } catch (_) {}
  try { const ip = require(path.join(__dirname, "..", "interpreter-provider")); ip.startManaged = async () => ({ ok: false }); } catch (_) {}
  const reg = (s) => mockElectron.__registry[s];
  const call = (channel, payload) => {
    const h = mockElectron.__ipcHandlers[channel];
    if (!h) throw new Error(`no ipc handler "${channel}"`);
    return h({}, payload);
  };

  const children = [];
  const cleanup = () => { for (const c of children) { try { c.kill("SIGTERM"); } catch (_) {} } };
  process.on("exit", cleanup);

  const brain = spawn(PY, [BRAIN], { stdio: ["pipe", "pipe", "inherit"] });
  children.push(brain);
  const brainWait = new Map();
  let brainBuf = "", brainId = 0;
  brain.stdout.on("data", (d) => {
    brainBuf += d.toString("utf8");
    let i;
    while ((i = brainBuf.indexOf("\n")) >= 0) {
      const line = brainBuf.slice(0, i); brainBuf = brainBuf.slice(i + 1);
      try { const m = JSON.parse(line); const w = brainWait.get(m.id); if (w) { brainWait.delete(m.id); w(m); } } catch (_) {}
    }
  });
  const ask = (prompt) => new Promise((resolve) => { const id = ++brainId; brainWait.set(id, resolve); brain.stdin.write(JSON.stringify({ id, prompt }) + "\n"); });

  const bfLog = fs.openSync(path.join(work, "akowe.log"), "w");
  const bf = spawn(PY, ["-m", "akowe", "--data-dir", DATA, "--no-browser", "--port", String(BF_PORT)],
    { cwd: AKOWE_ROOT, stdio: ["ignore", bfLog, bfLog], env: { ...process.env, AKOWE_SECRETS: path.join(work, "secrets.json"), NO_PROXY: "*", no_proxy: "*", HTTP_PROXY: "", HTTPS_PROXY: "", http_proxy: "", https_proxy: "" } });
  children.push(bf);
  const ping = () => new Promise((resolve) => {
    const r = http.get({ host: "127.0.0.1", port: BF_PORT, path: "/api/ping", agent: false }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    r.on("error", () => resolve(false));
  });
  if (!(await waitUntil(ping, 30000, 250))) throw new Error(`Akọwe did not start (see ${work}/akowe.log)`);
  const BF_TOKEN = fs.readFileSync(path.join(DATA, "local_token"), "utf8").trim();

  require(path.join(__dirname, "..", "main.js"));
  if (!(await waitUntil(() => SITES.every((s) => reg(s) && reg(s).webContents) && reg("controls-ui"), 10000))) throw new Error("main.js did not create its panes");
  const events = [];
  reg("controls-ui").webContents.on("ipc-send", (channel, payload) => {
    if (channel === "log") events.push({ ts: Date.now(), kind: payload.kind, detail: payload.detail || {} });
  });

  const { chromium } = require("playwright");
  const exe = fs.existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined;
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const pages = {};
  const hook = { bf: 0, brainErrors: [] };
  for (const site of SITES) {
    const ctx = await browser.newContext({ viewport: { width: 1000, height: 800 } });
    const page = await ctx.newPage();
    await page.exposeFunction("__fakeHook", async (msg) => {
      if (/JSON_SCHEMA:\n/.test(msg)) {
        let s = String(msg).replace(/^\[MSG #\d+\]\n/, "");
        const nm = s.indexOf("— NEW MESSAGE BELOW —\n\n");
        if (nm >= 0) s = s.slice(nm + "— NEW MESSAGE BELOW —\n\n".length);
        s = s.replace(/\n\n\[Reply envelope required: start with \[TO: USER\] and end with \[FROM: [A-Z]+\][^\n]*\]$/, "");
        const ans = await ask(s);
        hook.bf++;
        if (!ans.ok) { hook.brainErrors.push(`${site}: ${ans.error}`); return { to: "USER", lines: [`I could not read that request (${ans.error}).`] }; }
        return { to: "USER", lines: [ans.json] };
      }
      return null;
    });
    const q = new URLSearchParams({ site, seed: "1", quirks: "default", plan: "rr", nofrom: "0.1", speed: String(SPEED) });
    await page.goto(`file://${path.join(__dirname, "fixtures", "fake-chat.html")}?${q}`);
    pages[site] = page;
    reg(site).webContents.evaluator = (script) => page.evaluate(script);
  }
  for (const s of SITES) await call("participants:set", { site: s, enabled: true });

  async function connectLink() {
    const before = opened.length;
    await call("akowe:connect");
    const u = await waitUntil(() => opened.slice(before).find((x) => /#\/pair\?code=/.test(x)), 5000, 50);
    return u || null;
  }
  async function statusReport() {
    const st = await call("akowe:status");
    const tr = (await call("trace:report", {})).report;
    const dumps = {};
    for (const s of SITES) dumps[s] = await pages[s].evaluate(() => { const d = window.__fake.dump(); return { posted: d.posted.length, replies: d.replies.length, stopClicks: d.stopClicks }; });
    const count = (k) => events.filter((e) => e.kind === k).length;
    return { status: st, trace: { messages: tr.messages, replies: tr.replies, sites: tr.sites, anomalies: tr.anomalies }, dumps, hook,
      events: { sent: count("sent"), sendError: count("send-error"), sendRetry: count("send-retry"), bfOutcomes: events.filter((e) => e.kind === "akowe-outcome").map((e) => e.detail.outcome) } };
  }

  const ctl = http.createServer(async (req, res) => {
    let out;
    try {
      if (req.url === "/connect") out = { link: await connectLink() };
      else if (req.url === "/status") out = await statusReport();
      else if (req.url === "/stop") { out = { ok: true }; setTimeout(() => stopper(), 50); }
      else out = { error: "unknown" };
    } catch (e) { out = { error: String(e && e.stack || e) }; }
    const b = Buffer.from(JSON.stringify(out));
    res.writeHead(200, { "Content-Type": "application/json", "Content-Length": b.length });
    res.end(b);
  });
  let stopper = () => {};
  const stopped = new Promise((r) => { stopper = r; });
  await new Promise((r) => ctl.listen(CTL_PORT, "127.0.0.1", r));

  const info = { bf_url: `http://127.0.0.1:${BF_PORT}/`, token: BF_TOKEN, control: `http://127.0.0.1:${CTL_PORT}`, work, shots: SHOTS, data: DATA, bridge: `http://127.0.0.1:${BRIDGE_PORT}` };
  fs.writeFileSync(path.join(work, "info.json"), JSON.stringify(info, null, 2));
  console.log(`== acceptance harness up: ${JSON.stringify(info)}`);
  let ok = true;
  try {
    if (HOLD) {
      fs.writeFileSync(process.env.INFO_OUT || path.join(os.tmpdir(), "bf-accept-info.json"), JSON.stringify(info, null, 2));
      await stopped;
    } else {
      const drv = spawn(PY, [DRIVER], { stdio: "inherit", cwd: AKOWE_ROOT, env: { ...process.env, ACCEPT_INFO: JSON.stringify(info), NO_PROXY: "*", no_proxy: "*" } });
      children.push(drv);
      const code = await Promise.race([new Promise((r) => drv.on("exit", r)), stopped.then(() => -1)]);
      ok = code === 0;
      const rep = await statusReport();
      console.log(`  AutoInjector at the end: phase=${rep.status.connect && rep.status.connect.phase} trace ${rep.trace.messages} messages / ${rep.trace.replies} replies, ${rep.trace.anomalies.length} anomalies; Akọwe prompts answered by the fake AIs: ${rep.hook.bf}; brain errors ${rep.hook.brainErrors.length}`);
      for (const [s, x] of Object.entries(rep.trace.sites)) if (x.failed || x.unproven || x.noReply || x.duplicates) { ok = false; console.log(`  FAIL relay trace ${s}: ${JSON.stringify(x)}`); }
      if (rep.hook.brainErrors.length) { ok = false; console.log(`  FAIL brain errors: ${rep.hook.brainErrors.slice(0, 5).join(" | ")}`); }
    }
  } finally {
    await browser.close().catch(() => {});
    try { await call("akowe:set-enabled", { enabled: false }); } catch (_) {}
    ctl.close();
    cleanup();
  }
  console.log(ok ? "\n  PASS" : "\n  FAIL");
  return ok;
}

main().then((ok) => process.exit(ok ? 0 : 1)).catch((e) => { console.error(e && e.stack || e); process.exit(1); });
