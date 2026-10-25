// test/akowe-e2e.test.js — REAL Akọwe -> REAL AutoInjector main.js -> fake
// chat sites in a REAL Chromium -> back to Akọwe.
//
// The integration that matters before shipping the Akọwe bridge:
//
//   Akọwe server (python -m akowe, its own HTTP API, "⚡ Make a book for me")
//     -> its AutoInjector adapter (providers.py) -> POST /v1/complete
//     -> [recording proxy, so every request / answer is ground truth]
//     -> akowe-bridge.js inside main.js (sendTextTo: [MSG #] numbering, the
//        AI_BUSY wait, the TR-28 capture-first gate, envelope, retries; pollSite
//        capture; Relay Trace; hop limit; Auto routing)
//     -> the REAL automation.js send/read scripts in three Playwright pages of
//        test/fixtures/fake-chat.html (rich editor, Stop button, streaming,
//        Gemini re-draw, hidden Send, wrapper, slow clear, missing [FROM:])
//     -> the fake AI's answer, made by Akọwe's own deterministic test AI
//        (akowe/tests/autobook_fake.py via tests/campaign/bridge/fake_site_brain.py)
//   and back.
//
// Every fake answer carries a reference line OUTSIDE its JSON object:
//     REF <TOKEN> answers #<MSG seq it answers> p=<sha256(prompt it saw)[:12]>
// (Akọwe's extract_json_object() ignores prose around the object.) The
// proxy knows, for each Akọwe request, the prompt and the bridge's
// [MSG #] seq, so "did Akọwe get the answer to ITS OWN prompt" is exact.
//
// Phases (one process = one main.js boot = one seed / quirk setting):
//   A  pairing through Akọwe's own API (akowe:connect -> #/pair link ->
//      POST /api/slots/pair-autoinjector), then normal AI-to-AI relaying while
//      Akọwe is idle (Auto routing, hop limit HOP_MAX).
//   B  "⚡ Make a book for me" (short story) across the three AIs (roles: AI-1
//      claude = default, AI-2 chatgpt = set B, AI-3 gemini = set C), while
//        - the user starts short side chats between the AIs (contention), and
//        - one Akọwe request is forced into a timeout: the proxy shortens
//          its timeout_ms to 10 s and, just before forwarding it, the user asks
//          that AI a question it takes ~16 s to answer (FAULTS=timeout), and
//        - one Akọwe request to Claude arrives while Claude answers the user's
//          quick side question addressed to ChatGPT (FAULTS=steal).
//      A TIMEOUT pause is answered with "Try again" like an author would.
//   Checks: run completes; every 200 answer is the answer to that request's own
//   prompt (BF-01); nothing typed for a request after its 504 (BF-02); bridge
//   sends never reset the hop count (BF-03) and side chats stay within the hop
//   limit; Akọwe prompts reach the AI exactly as sent (BF-16); Akọwe
//   stored the right chapter for each chapter; Relay Trace shows no losses;
//   side-chat replies are never handed to Akọwe and Akọwe answers never
//   leak into other AIs; the exported book (PDF, EPUB, DOCX) is produced.
//
// Run:  node test/akowe-e2e.test.js
// Env:  SEED=1 | SEEDS=1,2       seed (several = one child process each)
//       QUIRKS=default|all|none  fake-site quirks (as test/stress.test.js)
//       BF_BRIDGE_IMPL=path      load this file instead of ./akowe-bridge.js
//                                (e.g. the proposed BF-01 phase fix)
//       AKOWE_ROOT=path      Akọwe checkout (default ../../akowe)
//       FAULTS=steal,timeout,contention  disturbances to inject (default all three; "none")
//       SPEED=0.35  HOP_MAX=3  RUN_TIMEOUT_MS=170000  VERBOSE=1  OUT=file.json
//       EXPECT_FAIL=BF-01,...    report-only: exit 0 when exactly these checks fail
"use strict";
const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");
const net = require("net");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");

if (process.env.SEEDS && !process.env.__BFE2E_CHILD) {
  const seeds = String(process.env.SEEDS).split(",").map((s) => s.trim()).filter(Boolean);
  let bad = 0;
  for (const seed of seeds) {
    const r = spawnSync(process.execPath, [__filename], { stdio: "inherit", env: { ...process.env, SEED: seed, __BFE2E_CHILD: "1" } });
    if (r.status !== 0) bad++;
  }
  console.log(`\nAkọwe e2e: ${seeds.length - bad}/${seeds.length} seeds passed`);
  process.exit(bad ? 1 : 0);
}

const SEED = String(process.env.SEED || "1");
const QUIRKS = String(process.env.QUIRKS || "default");
const SPEED = Number(process.env.SPEED) || 0.35;
const HOP_MAX = Number(process.env.HOP_MAX) || 3;
const FANOUT = 2; // Auto routing forwards a reply to both other AIs
const RUN_TIMEOUT_MS = Number(process.env.RUN_TIMEOUT_MS) || 170000;
const VERBOSE = process.env.VERBOSE === "1";
const FAULTS = new Set(String(process.env.FAULTS || "steal,timeout,contention").split(",").map((s) => s.trim()).filter((s) => s && s !== "none"));
const EXPECT_FAIL = new Set(String(process.env.EXPECT_FAIL || "").split(",").map((s) => s.trim()).filter(Boolean));
const AKOWE_ROOT = path.resolve(process.env.AKOWE_ROOT || path.join(__dirname, "..", "..", "akowe"));
const BRAIN = path.join(AKOWE_ROOT, "tests", "campaign", "bridge", "fake_site_brain.py");
const PY = process.env.PYTHON || "python3";
const SLOW_MS = 16000;       // how long the "slow side question" keeps the AI busy
const SHORT_TIMEOUT_MS = 10000; // the contract minimum timeout_ms

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
const sha12 = (s) => crypto.createHash("sha256").update(String(s), "utf8").digest("hex").slice(0, 12);
const SITES = ["chatgpt", "claude", "gemini"];
const LABEL = { chatgpt: "ChatGPT", claude: "Claude", gemini: "Gemini" };
const ENVELOPE_RE = /\n\n\[Reply envelope required: start with \[TO: USER\] and end with \[FROM: [A-Z]+\][^\n]*\]$/;
const REF_RE = /REF ([A-Z]+-R\d+) answers #(\d+) p=([0-9a-f]{12})/;
const TOKEN_RE = /\b(CHATGPT|CLAUDE|GEMINI)-R(\d+)\b/;
const seqOf = (t) => { const m = /^\[MSG #(\d+)\]/.exec(String(t || "")); return m ? m[1] : null; };
// The Akọwe prompt inside a message the page received: minus the [MSG #] line,
// any app text put in front of it, and the reply-envelope instruction at the end.
function corePrompt(posted) {
  let s = String(posted || "").replace(/^\[MSG #\d+\]\n/, "");
  const nm = s.indexOf("— NEW MESSAGE BELOW —\n\n");
  if (nm >= 0) s = s.slice(nm + "— NEW MESSAGE BELOW —\n\n".length);
  return s.replace(ENVELOPE_RE, "");
}

async function main() {
  const t0 = Date.now();
  const [BRIDGE_PORT, BF_PORT, PROXY_PORT] = [await freePort(), await freePort(), await freePort()];
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "bf-e2e-"));
  const DATA = path.join(work, "akowe-data");
  fs.mkdirSync(DATA);
  const emptyDir = path.join(work, "no-launcher");
  fs.mkdirSync(emptyDir);

  Object.assign(process.env, {
    AUTOINJECTOR_BRIDGE: "0",
    AUTOINJECTOR_CHECKIN: process.env.AUTOINJECTOR_CHECKIN || "0", // P18: no automatic check-ins here
    AUTOINJECTOR_POLL_MS: process.env.AUTOINJECTOR_POLL_MS || "150",
    AUTOINJECTOR_STABLE_MS: process.env.AUTOINJECTOR_STABLE_MS || "300",
    AUTOINJECTOR_RETRY_BACKOFF_MS: process.env.AUTOINJECTOR_RETRY_BACKOFF_MS || "300",
    AUTOINJECTOR_SAVE_DEBOUNCE_MS: process.env.AUTOINJECTOR_SAVE_DEBOUNCE_MS || "200",
    AUTOINJECTOR_NOTAG_QUIET_MS: process.env.AUTOINJECTOR_NOTAG_QUIET_MS || "1500",
    AUTOINJECTOR_CAPTURE_SETTLE_MS: process.env.AUTOINJECTOR_CAPTURE_SETTLE_MS || "400",
    AUTOINJECTOR_FORCE_ACCEPT_STABLE_MS: process.env.AUTOINJECTOR_FORCE_ACCEPT_STABLE_MS || "800",
    AUTOINJECTOR_SEND_BUSY_POLL_MS: process.env.AUTOINJECTOR_SEND_BUSY_POLL_MS || "150",
    AUTOINJECTOR_SEND_BUSY_WAIT_MS: process.env.AUTOINJECTOR_SEND_BUSY_WAIT_MS || "30000",
    AUTOINJECTOR_PROBE_DELAY_MS: "600000",
    AUTOINJECTOR_MAX_AUTO_HOPS: String(HOP_MAX),
    AUTOINJECTOR_AKOWE_PORT: String(BRIDGE_PORT),
    AUTOINJECTOR_AKOWE_APP_URL: `http://127.0.0.1:${BF_PORT}/api/ping`,
    AUTOINJECTOR_AKOWE_DIR: emptyDir,
  });

  // ---- main.js under the mock Electron (optionally with another bridge implementation)
  const Module = require("module");
  const mockElectronPath = path.join(__dirname, "mock-electron.js");
  const bridgeImpl = process.env.BF_BRIDGE_IMPL ? path.resolve(process.env.BF_BRIDGE_IMPL) : null;
  const originalLoad = Module._load;
  Module._load = function (request) {
    if (request === "electron") return require(mockElectronPath);
    if (bridgeImpl && request === "./akowe-bridge") return originalLoad.call(this, bridgeImpl, ...Array.prototype.slice.call(arguments, 1));
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

  // ---- the fake AIs' brain (Akọwe's own deterministic test AI)
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

  // ---- the real Akọwe server
  const bfLog = fs.openSync(path.join(work, "akowe.log"), "w");
  const bf = spawn(PY, ["-m", "akowe", "--data-dir", DATA, "--no-browser", "--port", String(BF_PORT)],
    { cwd: AKOWE_ROOT, stdio: ["ignore", bfLog, bfLog], env: { ...process.env, AKOWE_SECRETS: path.join(work, "secrets.json"), NO_PROXY: "*", no_proxy: "*", HTTP_PROXY: "", HTTPS_PROXY: "", http_proxy: "", https_proxy: "" } });
  children.push(bf);
  function bfReq(method, p, body, token) {
    return new Promise((resolve, reject) => {
      const data = body != null ? Buffer.from(JSON.stringify(body)) : null;
      const headers = { Accept: "application/json" };
      if (token) headers.Authorization = `Bearer ${token}`;
      if (data) { headers["Content-Type"] = "application/json"; headers["Content-Length"] = data.length; }
      const r = http.request({ host: "127.0.0.1", port: BF_PORT, method, path: p, headers, agent: false }, (res) => {
        const ch = []; res.on("data", (c) => ch.push(c));
        res.on("end", () => { const buf = Buffer.concat(ch); let json = null; try { json = JSON.parse(buf.toString("utf8")); } catch (_) {} resolve({ status: res.statusCode, json, bytes: buf.length }); });
      });
      r.on("error", reject);
      if (data) r.write(data);
      r.end();
    });
  }
  const up = await waitUntil(async () => { try { const r = await bfReq("GET", "/api/ping"); return r.status === 200 && r.json && r.json.app === "akowe"; } catch (_) { return false; } }, 30000, 250);
  if (!up) throw new Error(`Akọwe did not start (see ${path.join(work, "akowe.log")})`);
  const BF_TOKEN = fs.readFileSync(path.join(DATA, "local_token"), "utf8").trim();
  const api = (method, p, body) => bfReq(method, p, body, BF_TOKEN);

  // ---- recording proxy between Akọwe and the bridge
  const proxyLog = []; // /v1/complete: { i, site, request_id, timeout_ms, prompt, hash, sentAt, status, body, doneAt, fault }
  let faultHook = null; // async (rec, body) -> void (may change body)
  const proxy = http.createServer((req, res) => {
    const ch = [];
    req.on("data", (c) => ch.push(c));
    req.on("end", async () => {
      let raw = Buffer.concat(ch);
      let rec = null;
      if (req.method === "POST" && req.url === "/v1/complete") {
        let body = null; try { body = JSON.parse(raw.toString("utf8")); } catch (_) {}
        if (body) {
          rec = { i: proxyLog.length, site: body.site, request_id: body.request_id, timeout_ms: body.timeout_ms, prompt: body.prompt, hash: sha12(body.prompt), sentAt: Date.now(), status: null, body: null, doneAt: null, fault: null };
          proxyLog.push(rec);
          if (faultHook) { try { await faultHook(rec, body); } catch (e) { console.log("  (fault hook error)", e && e.message); } }
          rec.forwardedAt = Date.now();
          raw = Buffer.from(JSON.stringify(body));
        }
      }
      const headers = Object.assign({}, req.headers, { host: `127.0.0.1:${BRIDGE_PORT}`, "content-length": raw.length });
      const out = http.request({ host: "127.0.0.1", port: BRIDGE_PORT, method: req.method, path: req.url, headers, agent: false }, (r2) => {
        const c2 = []; r2.on("data", (c) => c2.push(c));
        r2.on("end", () => {
          const buf = Buffer.concat(c2);
          if (rec) { rec.status = r2.statusCode; rec.doneAt = Date.now(); try { rec.body = JSON.parse(buf.toString("utf8")); } catch (_) { rec.body = null; } }
          res.writeHead(r2.statusCode, Object.assign({}, r2.headers, { "content-length": buf.length }));
          res.end(buf);
        });
      });
      out.on("error", () => { if (rec) { rec.status = "proxy-error"; rec.doneAt = Date.now(); } try { res.writeHead(502); res.end(); } catch (_) {} });
      out.end(raw);
    });
  });
  await new Promise((r) => proxy.listen(PROXY_PORT, "127.0.0.1", r));
  const PROXY_URL = `http://127.0.0.1:${PROXY_PORT}`;

  // ---- main.js
  require(path.join(__dirname, "..", "main.js"));
  const booted = await waitUntil(() => SITES.every((s) => reg(s) && reg(s).webContents) && reg("controls-ui"), 10000);
  if (!booted) throw new Error("main.js did not create its panes");
  const events = [];
  const captures = [];
  let composing = false;
  const composes = []; // { ts, site, text }
  reg("controls-ui").webContents.on("ipc-send", (channel, payload) => {
    const ts = Date.now();
    if (channel === "capture") captures.push({ ts, site: payload.site, id: payload.id, text: payload.text, tag: payload.roundtableTag || null });
    else if (channel === "log") events.push({ ts, kind: payload.kind, detail: payload.detail || {}, duringCompose: composing });
  });
  // A user message typed in the compose box (hop count reset is legitimate here).
  function compose(site, text) {
    composing = true;
    let p;
    try { p = call("send:compose", { text, targets: [site] }); } finally { composing = false; }
    composes.push({ ts: Date.now(), site, text });
    return Promise.resolve(p).catch((e) => ({ ok: false, error: String(e) }));
  }

  const { chromium } = require("playwright");
  const exe = fs.existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined;
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const pages = {};
  const hookLog = []; // { site, ts, kind: bf|slow|normal|brain-error, seq, hash, brainKind }
  const fails = [];
  const results = [];
  const check = (id, ok, msg, evidence) => {
    results.push({ id, ok: !!ok, msg, evidence: (evidence || []).slice(0, 40) });
    console.log(`  ${ok ? "ok  " : "FAIL"} [${id}] ${msg}`);
    if (!ok) { fails.push(id); if (evidence && evidence.length) for (const e of evidence.slice(0, 8)) console.log(`         - ${e}`); if (evidence && evidence.length > 8) console.log(`         - ... ${evidence.length - 8} more`); }
    return ok;
  };
  try {
    for (const site of SITES) {
      const ctx = await browser.newContext({ viewport: { width: 1000, height: 800 } });
      const page = await ctx.newPage();
      await page.exposeFunction("__fakeHook", async (msg) => {
        const seq = seqOf(msg);
        if (/JSON_SCHEMA:\n/.test(msg)) {
          const core = corePrompt(msg);
          const ans = await ask(core);
          hookLog.push({ site, ts: Date.now(), kind: ans.ok ? "bf" : "brain-error", seq, hash: sha12(core), brainKind: ans.kind, error: ans.error });
          if (!ans.ok) return { to: "USER", lines: [`I could not read that request (${ans.error}). REF {TOKEN} answers #${seq} p=${sha12(core)}`] };
          return { to: "USER", lines: [ans.json, `REF {TOKEN} answers #${seq} p=${sha12(core)}`] };
        }
        if (/QUICK SIDE QUESTION/.test(msg)) { hookLog.push({ site, ts: Date.now(), kind: "quick", seq }); return { to: "CHATGPT", lines: ["A quick tip for ChatGPT about relays, token {TOKEN}: always end with the closing tag."], delayMs: 1200, tagged: true }; }
        if (/SLOW SIDE QUESTION/.test(msg)) { hookLog.push({ site, ts: Date.now(), kind: "slow", seq }); return { to: "USER", lines: ["A slow, careful answer to your side question, token {TOKEN}."], delayMs: SLOW_MS }; }
        hookLog.push({ site, ts: Date.now(), kind: "normal", seq });
        return null;
      });
      const q = new URLSearchParams({ site, seed: SEED, quirks: QUIRKS, plan: "rr", nofrom: "0.2", speed: String(SPEED) });
      await page.goto(`file://${path.join(__dirname, "fixtures", "fake-chat.html")}?${q}`);
      pages[site] = page;
      reg(site).webContents.evaluator = (script) => page.evaluate(script);
    }
    for (const s of SITES) await call("participants:set", { site: s, enabled: true });
    await call("relay:hop-limit", { max: HOP_MAX });
    await call("routing:auto-all", {});
    const quirkList = await pages.chatgpt.evaluate(() => window.__fake.quirks.join(","));
    console.log(`\n== Akọwe e2e: seed=${SEED} quirks=${QUIRKS} (chatgpt: ${quirkList}) bridge=${bridgeImpl ? path.basename(bridgeImpl) : "akowe-bridge.js"} faults=${[...FAULTS].join(",") || "none"} hop limit=${HOP_MAX} ==`);

    const idleAll = async () => (await Promise.all(SITES.map((s) => pages[s].evaluate(() => window.__fake.idle())))).every(Boolean);
    const sentLogs = () => events.filter((e) => e.kind === "sent" || e.kind === "send-error" || e.kind === "send-cancelled").length; // a withdrawn (BF-02) send ends as send-cancelled
    async function quiet(ms, budget) {
      let last = Date.now();
      const until = Date.now() + budget;
      let lastEv = events.length;
      while (Date.now() < until) {
        await sleep(250);
        const tr = await call("trace:report", {});
        const busy = !(await idleAll()) || tr.report.messages - sentLogs() > 0 || events.length !== lastEv;
        lastEv = events.length;
        if (busy) { last = Date.now(); continue; }
        if (Date.now() - last > ms) return true;
      }
      return false;
    }

    // ================= A: pair through Akọwe's own API =================
    let st = await call("akowe:connect");
    const link = opened.map((u) => /#\/pair\?code=([A-Za-z0-9]+)&bridge=([^&]+)$/.exec(u)).find(Boolean);
    check("pair-link", st.connect && st.connect.phase === "waiting" && !!link, `Connect opens Akọwe's #/pair link (phase=${st.connect && st.connect.phase})`, opened);
    if (!link) throw new Error("no pairing link");
    const bridgeFromLink = decodeURIComponent(link[2]);
    check("pair-bridge-url", bridgeFromLink === `http://127.0.0.1:${BRIDGE_PORT}`, `the link names the bridge (${bridgeFromLink})`);
    // What the #/pair page does: POST /api/slots/pair-autoinjector. We hand Akọwe
    // the recording proxy in front of that bridge URL.
    const pr = await api("POST", "/api/slots/pair-autoinjector", { code: link[1], bridge_url: PROXY_URL });
    check("pair-api", pr.status === 200 && pr.json && pr.json.connected === true && (pr.json.slots || []).length === 3 && pr.json.slots.every((s) => s.ok),
      `Akọwe pairs and its three slots pass the health check (HTTP ${pr.status})`, [JSON.stringify(pr.json).slice(0, 400)]);
    check("pair-no-key", !JSON.stringify(pr.json || {}).includes((await call("akowe:reveal-token")).token), "the pairing answer never carries the key");
    await api("PUT", "/api/slots/AI-2", { roles: ["B"] });
    await api("PUT", "/api/slots/AI-3", { roles: ["C"] });
    await api("PUT", "/api/settings/ai-retry", { delays_s: [2], max_total_s: 120 });
    const connected = await waitUntil(async () => { const s = await call("akowe:status"); return s.connect && s.connect.phase === "connected" ? s : null; }, 20000, 250);
    check("connected", !!connected, `AutoInjector sees Akọwe's status push -> 'Connected' (${connected ? connected.connect.phase : (await call("akowe:status")).connect.phase})`);

    // ================= A: normal relaying while Akọwe is idle =================
    const evA = events.length, capA = captures.length;
    await compose("chatgpt", `Warm-up ${SEED}: talk about relay reliability.`);
    const quietA = await quiet(3000, 60000);
    const relA = events.slice(evA).filter((e) => e.kind === "sent" && e.detail.from).length;
    const hopA = events.slice(evA).some((e) => e.kind === "hop-limit");
    check("idle-relay", quietA && relA >= 2 && relA <= HOP_MAX * FANOUT && hopA,
      `normal AI-to-AI relaying while Akọwe is idle: ${relA} relays, hop limit ${hopA ? "reached" : "NOT reached"}, ${captures.length - capA} replies captured`);
    check("idle-no-bridge", proxyLog.length === 0, "no Akọwe request was made while idle");

    // ================= B: ⚡ Make a book for me =================
    const evB = events.length;
    const tB = Date.now();
    let timeoutTarget = null; // the request we force into a timeout
    let stealTarget = null;   // the request that arrives while the AI answers a quick question
    faultHook = async (rec, body) => {
      if (FAULTS.has("steal") && !stealTarget && rec.site === "claude") {
        // The user asks Claude a quick question (answered to ChatGPT) just before Akọwe's prompt.
        stealTarget = rec; rec.fault = "steal";
        compose("claude", "QUICK SIDE QUESTION: one tip for ChatGPT about relays?");
        await waitUntil(() => pages.claude.evaluate(() => !window.__fake.idle()), 8000, 50);
      } else if (FAULTS.has("timeout") && !timeoutTarget && rec.site === "gemini") {
        // The user asks Gemini something that takes it ~16 s, right before Akọwe's prompt,
        // and this request gets the contract's minimum timeout (10 s).
        timeoutTarget = rec; rec.fault = "timeout";
        body.timeout_ms = SHORT_TIMEOUT_MS; rec.timeout_ms = SHORT_TIMEOUT_MS;
        compose("gemini", "SLOW SIDE QUESTION: what makes a lighthouse keeper's log trustworthy?");
        await waitUntil(() => pages.gemini.evaluate(() => !window.__fake.idle()), 8000, 50);
      }
    };
    const start = await api("POST", "/api/autobook", { author_confirms: true, length: "short_story", genre: "Mystery" });
    if (!check("run-start", start.status === 202 && start.json && start.json.id, `Make a book for me starts (HTTP ${start.status})`, [JSON.stringify(start.json).slice(0, 300)])) throw new Error("run did not start");
    const runId = start.json.id;
    let run = start.json;
    const sideChats = []; // { k, site, ts }
    const sideSteps = FAULTS.has("contention") ? ["canon", "plot", "chapters"] : [];
    const decisions = [];
    const runDeadline = t0 + RUN_TIMEOUT_MS;
    let lastStep = null;
    while (Date.now() < runDeadline) {
      await sleep(400);
      const g = await api("GET", `/api/autobook/${runId}`);
      if (g.status !== 200) continue;
      run = g.json;
      if (run.current && run.current !== lastStep) {
        lastStep = run.current;
        if (VERBOSE) console.log(`    ${((Date.now() - tB) / 1000).toFixed(1)}s step ${run.current}`);
        const k = sideSteps.indexOf(run.current);
        if (k >= 0) {
          const site = ["claude", "chatgpt", "gemini"][k];
          sideChats.push({ k: k + 1, site, ts: Date.now() });
          compose(site, `Side chat ${k + 1} (seed ${SEED}): what makes a relay between three AIs trustworthy?`);
        }
      }
      if (run.status === "done" || run.status === "cancelled") break;
      if (run.status === "paused" && run.problem) {
        decisions.push({ ts: Date.now(), step: run.current, code: run.problem.code, message: run.problem.message });
        if (VERBOSE) console.log(`    paused: ${run.problem.code} ${run.problem.message}`);
        if (decisions.length > 4) break;
        await sleep(500);
        await api("POST", `/api/autobook/${runId}/decide`, { action: "retry" });
      }
    }
    faultHook = null;
    const runMs = Date.now() - tB;
    await quiet(3000, Math.max(5000, runDeadline + 20000 - Date.now()));

    // ================= collect =================
    const dumps = {};
    for (const s of SITES) dumps[s] = await pages[s].evaluate(() => window.__fake.dump());
    const trace = (await call("trace:report", {})).report;
    const bstat = await call("akowe:status");

    // ================= checks =================
    console.log(`  run ${run.status} in ${(runMs / 1000).toFixed(1)} s · ${proxyLog.length} Akọwe requests (${SITES.map((s) => `${s} ${proxyLog.filter((r) => r.site === s).length}`).join(", ")}) · pauses: ${decisions.map((d) => d.code).join(", ") || "none"} · side chats ${sideChats.length}`);
    check("run-done", run.status === "done", `the run completes (status=${run.status}, step=${run.current || "-"}${run.problem ? `, problem ${run.problem.code}: ${run.problem.message}` : ""})`,
      decisions.map((d) => `paused at ${d.step}: ${d.code} ${String(d.message).slice(0, 160)}`));
    const expectedPauses = timeoutTarget ? 1 : 0;
    const unexpectedPauses = decisions.filter((d) => !(timeoutTarget && d.code === "TIMEOUT" && decisions.indexOf(d) === 0));
    check("no-unexpected-pauses", unexpectedPauses.length === 0, `no pauses other than the forced timeout (${decisions.length} pause(s), ${expectedPauses} expected)`,
      unexpectedPauses.map((d) => `${d.step}: ${d.code} ${String(d.message).slice(0, 200)}`));
    const used = new Set(proxyLog.map((r) => r.site));
    check("three-ais", SITES.every((s) => used.has(s)), `Akọwe used all three AIs (${[...used].join(", ")})`);

    // posted messages that carry an Akọwe prompt
    const posts = [];
    for (const s of SITES) for (const p of dumps[s].posted) posts.push({ site: s, at: p.at, text: p.text, seq: seqOf(p.text) });
    // (exact: a schema re-ask prompt starts with the original prompt, so "includes" would over-match)
    const postsOf = (rec) => posts.filter((p) => p.site === rec.site && /JSON_SCHEMA:\n/.test(p.text) && corePrompt(p.text) === rec.prompt);

    // BF-01: each 200 is the answer to its own prompt
    const wrong = [], hashWrong = [];
    for (const r of proxyLog) {
      if (r.status !== 200 || !r.body) continue;
      const m = REF_RE.exec(r.body.text || "");
      const tok = TOKEN_RE.exec(r.body.text || "");
      if (!m) wrong.push(`${r.request_id} -> ${r.site} #${r.body.seq}: got a reply that is not an answer to any Akọwe prompt (${tok ? tok[0] : "no token"}: "${String(r.body.text).slice(0, 70).replace(/\n/g, " ")}")`);
      else if (m[2] !== String(r.body.seq)) wrong.push(`${r.request_id} -> ${r.site} #${r.body.seq}: got ${m[1]}, the answer to #${m[2]}`);
      if (m && m[3] !== r.hash) hashWrong.push(`${r.request_id} -> ${r.site}: answer was made for prompt p=${m[3]}, this request's prompt is p=${r.hash}`);
    }
    check("BF-01", wrong.length === 0, `every answer Akọwe received is the answer to its own [MSG #] (${proxyLog.filter((r) => r.status === 200).length} answers)`, wrong);
    check("BF-01-prompt", hashWrong.length === 0, "every answer Akọwe received was made for the prompt that request sent", hashWrong);
    // Did Akọwe KEEP a wrong answer? (a schema-valid wrong answer is not re-asked)
    const kept = [];
    for (const r of proxyLog) {
      if (r.status !== 200 || !r.body) continue;
      const m = REF_RE.exec(r.body.text || "");
      if (m && m[3] === r.hash) continue;
      const reask = r.request_id.replace(/-a(\d+)$/, (x, n) => `-a${Number(n) + 1}`);
      const reasked = proxyLog.some((x) => x.i > r.i && x.request_id === reask);
      if (!reasked) kept.push(`${r.request_id} (${r.site}) — Akọwe kept ${m ? `${m[1]} (made for p=${m[3]})` : "a non-answer"} and moved on`);
    }
    check("BF-01-stored", kept.length === 0, "Akọwe never kept an answer that was made for another prompt", kept);

    // BF-02: nothing typed for a request after Akọwe got its 504
    // (a post that a LATER request with the same prompt got its 200 for — Akọwe's "Try again" with a
    // new request_id after a 504 that said typed:false — is that request's own send, not a ghost)
    const claimedByLater = (r, p) => proxyLog.some((x) => x.i > r.i && x.site === r.site && x.prompt === r.prompt && x.status === 200 && x.body && String(x.body.seq) === p.seq);
    const ghosts = [];
    for (const r of proxyLog.filter((x) => x.status === 504)) {
      for (const p of postsOf(r)) if (p.at > r.doneAt && !claimedByLater(r, p)) ghosts.push(`${r.request_id}: 504 at +${((r.doneAt - r.sentAt) / 1000).toFixed(1)} s, prompt typed into ${LABEL[r.site]} as #${p.seq} ${((p.at - r.doneAt) / 1000).toFixed(1)} s LATER`);
      // the 504 must say truthfully whether the prompt was typed
      const typedBefore = postsOf(r).filter((p) => p.at >= r.sentAt && p.at <= r.doneAt && !claimedByLater(r, p));
      const said = r.body ? r.body.typed : undefined;
      if (said === false && typedBefore.length) ghosts.push(`${r.request_id}: the 504 says the prompt was never typed, but it was typed as #${typedBefore[0].seq}`);
      if (said === true && !postsOf(r).some((p) => p.seq === String(r.body.seq))) ghosts.push(`${r.request_id}: the 504 says the prompt was typed as #${r.body.seq}, but no such message reached ${LABEL[r.site]}`);
      if (said !== true && said !== false) ghosts.push(`${r.request_id}: the 504 does not say whether the prompt was typed`);
    }
    const timeouts = proxyLog.filter((x) => x.status === 504).length;
    if (timeoutTarget) check("timeout-forced", timeoutTarget.status === 504, `the forced timeout happened (${timeoutTarget.request_id}: HTTP ${timeoutTarget.status})`);
    check("BF-02", ghosts.length === 0, `no ghost sends after a 504 (${timeouts} timeout(s))`, ghosts);
    // ... and the late window must not hand Akọwe a reply that was not the answer (the slow side answer)
    if (timeoutTarget) {
      const later = proxyLog.filter((x) => x.i > timeoutTarget.i && x.request_id === timeoutTarget.request_id);
      const lateWrong = later.filter((x) => x.status === 200 && !REF_RE.test((x.body && x.body.text) || ""));
      check("late-window", lateWrong.length === 0, `after the timeout, the same request_id never returns the user's side answer (${later.length} retries with that id)`,
        lateWrong.map((x) => `${x.request_id} -> ${String(x.body.text).slice(0, 80)}`));
    }

    // every Akọwe prompt typed at most once per request id (no double typing)
    const dupType = [];
    // (requests refused with 409 never reach the page; a prompt typed after its 504 is BF-02, counted there)
    for (const r of proxyLog) {
      const reqs = proxyLog.filter((x) => x.prompt === r.prompt && x.site === r.site && x.status !== 409);
      const n = postsOf(r).filter((p) => !reqs.some((x) => x.status === 504 && p.at > x.doneAt)).length;
      const asked = reqs.filter((x) => x.status !== 504).length;
      if (n > asked) dupType.push(`${r.request_id}: prompt typed ${n}x into ${LABEL[r.site]} for ${asked} answered request(s)`);
    }
    check("no-double-typing", dupType.length === 0, "no Akọwe prompt is typed more often than Akọwe asked", [...new Set(dupType)]);

    // BF-03: bridge sends must not reset the hop count; side chats stay within the hop limit
    const progResets = events.filter((e) => e.kind === "hop-count-reset" && e.detail.reason === "program-send" && !e.duringCompose);
    check("BF-03", progResets.length === 0, `Akọwe sends never reset the AI-to-AI hop count (${progResets.length} reset(s) by a program send)`,
      progResets.map((e) => `+${((e.ts - tB) / 1000).toFixed(1)} s reset at ${e.detail.hops} hop(s)${e.detail.wasPaused ? " (was paused at the limit)" : ""}`));
    const overHop = [];
    const marks = composes.filter((c) => c.ts >= tB).map((c) => c.ts).concat([Infinity]);
    for (let i = 0; i < marks.length - 1; i++) {
      const n = events.filter((e) => e.kind === "sent" && e.detail.from && e.ts >= marks[i] && e.ts < marks[i + 1]).length;
      if (n > HOP_MAX * FANOUT) overHop.push(`after the user message at +${((marks[i] - tB) / 1000).toFixed(1)} s: ${n} AI-to-AI relays (limit ${HOP_MAX} hops x ${FANOUT})`);
    }
    check("hop-limit", overHop.length === 0, "side chats during the run stay within the hop limit", overHop);

    // BF-16: Akọwe prompts reach the AI exactly as Akọwe sent them
    const polluted = [];
    for (const r of proxyLog) for (const p of postsOf(r)) {
      const want = `[MSG #${p.seq}]\n${r.prompt}`;
      const body = p.text.replace(ENVELOPE_RE, "");
      if (body !== want) {
        const extra = body.startsWith(`[MSG #${p.seq}]\n`) ? body.slice(`[MSG #${p.seq}]\n`.length, body.indexOf(r.prompt)) : body.slice(0, body.indexOf(r.prompt));
        polluted.push(`${r.request_id} -> ${LABEL[r.site]} #${p.seq}: ${extra.length} extra chars before the prompt: "${extra.slice(0, 90).replace(/\n/g, "⏎")}"`);
      }
      if (!ENVELOPE_RE.test(p.text)) polluted.push(`${r.request_id} -> ${LABEL[r.site]} #${p.seq}: no reply-envelope instruction at the end`);
    }
    check("BF-16", polluted.length === 0, "Akọwe prompts reach the AI exactly as sent (only [MSG #] + the envelope instruction added)", [...new Set(polluted)]);

    // side-chat replies never go to Akọwe; Akọwe answers never reach other AIs
    const leaked = [];
    for (const s of SITES) for (const p of dumps[s].posted) { const m = REF_RE.exec(p.text); if (m && !/JSON_SCHEMA:/.test(p.text)) leaked.push(`${m[1]} (an Akọwe answer) was relayed into ${LABEL[s]} as #${seqOf(p.text)}`); }
    check("no-leak", leaked.length === 0, "Akọwe answers are never relayed to the other AIs", leaked);
    const stolen = proxyLog.filter((r) => r.status === 200 && r.body && !REF_RE.test(r.body.text || "") && TOKEN_RE.test(r.body.text || ""))
      .map((r) => `${TOKEN_RE.exec(r.body.text)[0]} (${/slow, careful/.test(r.body.text) ? "the slow answer to the user's side question" : /quick tip/.test(r.body.text) ? "the quick answer to the user's side question, addressed to ChatGPT" : "a side-chat reply"}) was handed to Akọwe as the answer to ${r.request_id}`);
    check("no-steal", stolen.length === 0, "replies to the user / side chats are never handed to Akọwe", stolen);
    // side-chat replies captured while Akọwe was busy still reach their addressees
    const routeMiss = [];
    for (const c of captures.filter((x) => x.ts >= tB)) {
      const tok = TOKEN_RE.exec(c.text || "");
      if (!tok || REF_RE.test(c.text || "")) continue;
      const tag = String(c.tag || "USER");
      if (tag === "USER") continue;
      const heldHop = events.some((e) => e.kind === "hop-limit" && e.detail.site === c.site && e.ts >= c.ts - 50 && e.ts <= c.ts + 3000);
      const heldLoop = events.some((e) => e.kind === "loop-suppressed" && e.detail.site === c.site && Math.abs(e.ts - c.ts) < 1000);
      const owned = events.some((e) => e.kind === "akowe-owned-reply" && e.detail.site === c.site && Math.abs(e.ts - c.ts) < 200);
      if (owned) { routeMiss.push(`${tok[0]} [TO: ${tag}] was swallowed by the bridge (taken as an Akọwe answer), never relayed`); continue; }
      if (heldHop || heldLoop) continue;
      for (const t of SITES.filter((x) => x !== c.site)) if (!dumps[t].posted.some((p) => p.text.includes(tok[0]))) routeMiss.push(`${tok[0]} -> ${LABEL[t]}`);
    }
    check("side-relay", routeMiss.length === 0, "replies to the user's side questions / side chats captured during the run still reach the AIs they address", routeMiss);

    // Relay Trace: no losses
    const lost = [];
    for (const [s, x] of Object.entries(trace.sites)) {
      if (x.failed) lost.push(`${LABEL[s]}: ${x.failed} failed send(s) ${JSON.stringify(x.errors)}`);
      if (x.unproven) lost.push(`${LABEL[s]}: ${x.unproven} unproven send(s)`);
      if (x.noReply) lost.push(`${LABEL[s]}: ${x.noReply} message(s) with no reply`);
      if (x.waiting) lost.push(`${LABEL[s]}: ${x.waiting} message(s) still waiting for a reply at the end`);
      if (x.duplicates) lost.push(`${LABEL[s]}: ${x.duplicates} duplicate relay(s)`);
    }
    // Anomalies that involve an Akọwe prompt (or an Akọwe prompt typed over an uncaptured reply)
    // fail the check; others (side-chat races between the [FROM:] nudge and a relay) are only listed.
    const bfSeqs = new Set(proxyLog.flatMap((r) => postsOf(r).map((p) => p.seq)));
    const sideNotes = [];
    for (const a of trace.anomalies) {
      const next = /#(\d+)/.exec(a.what);
      const line = `#${a.seq} -> ${LABEL[a.target] || a.target}${bfSeqs.has(a.seq) ? " (Akọwe prompt)" : ""}: ${a.what}${next && bfSeqs.has(next[1]) ? " (that next message was an Akọwe prompt)" : ""}`;
      if (bfSeqs.has(a.seq) || (next && bfSeqs.has(next[1]))) lost.push(line); else sideNotes.push(line);
    }
    check("relay-trace", lost.length === 0, `Relay Trace shows no losses for Akọwe traffic (${trace.messages} messages, ${trace.replies} replies; ${sideNotes.length} side-chat anomaly(s))`, lost);
    for (const n of sideNotes) console.log(`         note (side chat, not Akọwe): ${n}`);
    // 409 SITE_BUSY is the contract's answer while a timed-out request's late window holds the site.
    const lateBusy = (r) => r.status === 409 && proxyLog.some((x) => x.status === 504 && x.site === r.site && r.sentAt >= x.doneAt && r.sentAt - x.doneAt < 2 * (x.timeout_ms || 0) + 5000);
    const bfFails = proxyLog.filter((r) => r.status !== 200 && r.status !== 504 && !lateBusy(r)).map((r) => `${r.request_id} -> HTTP ${r.status} ${r.body ? r.body.error : ""}`);
    check("bridge-errors", bfFails.length === 0, `no bridge errors other than the forced timeout (${proxyLog.filter(lateBusy).length} x 409 SITE_BUSY during its late window)`, bfFails);
    // What the bridge stored in a timed-out request's late window (it answers a later retry with the SAME request_id).
    const lateStored = [];
    for (const e of events.filter((x) => x.kind === "akowe-outcome" && x.detail.outcome === "LATE_REPLY_STORED")) {
      const cap = captures.filter((c) => c.site === e.detail.site && Math.abs(c.ts - e.ts) < 500).pop();
      const req = proxyLog.find((r) => r.request_id === e.detail.request_id);
      const m = cap && REF_RE.exec(cap.text || "");
      if (!m || (req && m[3] !== req.hash)) {
        const tok = cap && TOKEN_RE.exec(cap.text || "");
        const typed = req ? postsOf(req).filter((p) => p.at > req.sentAt).map((p) => p.at) : [];
        lateStored.push(`${e.detail.request_id} (${LABEL[e.detail.site]}): stored ${tok ? tok[0] : "a reply"} [TO: ${cap ? cap.tag : "?"}] "${String(cap ? cap.text : "").slice(0, 60)}" as its late answer${typed.length && cap ? ` — Akọwe's prompt was typed only ${((Math.min(...typed) - cap.ts) / 1000).toFixed(1)} s later` : ""}`);
      }
    }
    check("late-steal", lateStored.length === 0, "a timed-out request's late window only stores the answer to ITS prompt", lateStored);
    const brainErr = hookLog.filter((h) => h.kind === "brain-error");
    check("fake-ai", brainErr.length === 0, "the fake AI could read every Akọwe prompt it received", brainErr.map((h) => `${h.site} #${h.seq}: ${h.error}`));

    // Akọwe stored the right chapter for each chapter + exported the book
    if (run.project_id) {
      const ex = await api("GET", `/api/projects/${run.project_id}/branches/main/export`);
      const recs = (ex.json && ex.json.records) || [];
      const byKey = new Map(recs.map((r) => [`${r.record_id}@${r.version}`, r]));
      const c01 = recs.filter((r) => r.module_id === "C01");
      // The fake AI writes a fixed text per chapter number (autobook_fake.CHAPTER_TEXT) and names the
      // chapter it wrote in objective_assessments (-> finding rule OBJECTIVE:<id>).
      const OPENING = { 1: "The fog rolled in over Gullhaven", 2: "Down in the harbor", 3: "At low tide the reef" };
      const c02 = recs.filter((r) => r.module_id === "C02" && typeof (r.data || {}).text === "string" && (r.lifecycle === "APPROVED" || r.lifecycle === "LOCKED"));
      const chapWrong = [];
      for (const r of c02) {
        const ctxRec = (r.source_refs || []).map((x) => byKey.get(`${x.record_id}@${x.version}`)).find((x) => x && x.module_id === "C01");
        const fact = ctxRec && ((ctxRec.data || {}).facts || []).find((f) => f.predicate === "plan.item_id");
        const chap = fact ? String(fact.value) : null;
        const said = (((r.data || {}).findings || []).map((f) => /^OBJECTIVE:(.+)$/.exec(f.rule_id || "")).find(Boolean) || [])[1] || null;
        const n = chap && /^ch(\d+)$/.test(chap) ? ((Number(chap.slice(2)) - 1) % 3) + 1 : null;
        if (!chap) chapWrong.push(`${r.record_id} v${r.version}: no C01 chapter context found`);
        else if ((said && said !== chap) || (n && !r.data.text.startsWith(OPENING[n]))) chapWrong.push(`${r.record_id} v${r.version}: stored as ${chap}, but the AI wrote it for ${said || "?"} ("${r.data.text.slice(0, 40)}…")`);
      }
      const canon = recs.filter((r) => ["A01", "A03", "A04"].includes(r.module_id) && (r.lifecycle === "APPROVED" || r.lifecycle === "LOCKED"));
      const names = canon.map((r) => `${r.module_id}:${(r.data || {}).concept}`);
      const dupNames = names.filter((n, i) => names.indexOf(n) !== i);
      check("stored-canon", canon.length >= 3 && dupNames.length === 0, `each approved character/place is a different entry (${names.join(", ")})`,
        dupNames.map((n) => `${n} approved twice: a second Bible item was stored with the answer made for another item`).concat(canon.length < 3 ? [`only ${canon.length} approved canon records`] : []));
      check("stored-chapters", c02.length >= 3 && chapWrong.length === 0, `each approved chapter holds the text written for that chapter (${c02.length} approved chapters, ${c01.length} contexts)`, chapWrong.concat(c02.length < 3 ? [`only ${c02.length} approved C02 records (export: HTTP ${ex.status}, ${recs.length} records)`] : []));
    }
    const formats = (run.files || []).map((f) => `${f.format} ${f.bytes} B`);
    check("export", (run.files || []).length === 3 && run.files.every((f) => f.bytes > 0 && f.sha256), `the exported book is produced (${formats.join(", ") || "no files"})`);
    check("bridge-status", bstat.enabled && bstat.listening && bstat.connect && bstat.connect.phase === "connected", `bridge still on and Akọwe connected at the end (phase ${bstat.connect && bstat.connect.phase})`);

    console.log(`  per AI: ${SITES.map((s) => `${LABEL[s]} posted ${dumps[s].posted.length}, replies ${dumps[s].replies.length} (${dumps[s].replies.filter((r) => !r.tagged).length} untagged), stopClicks ${dumps[s].stopClicks}`).join(" · ")}`);
    const count = (k) => events.filter((e) => e.kind === k).length;
    console.log(`  events: capture-first waits=${count("send-waiting-capture")} busy waits=${count("send-waiting-busy")} [FROM:] nudges=${count("endtag-missing")} send retries=${count("send-retry")} hop-limit holds=${count("hop-limit")} bridge-owned replies=${count("akowe-owned-reply")} hop resets(program)=${progResets.length}`);
    if (VERBOSE || fails.length) {
      console.log("  Akọwe requests:");
      for (const r of proxyLog) {
        const m = REF_RE.exec((r.body && r.body.text) || "");
        const ps = postsOf(r).map((p) => `#${p.seq}@+${((p.at - r.sentAt) / 1000).toFixed(1)}s`).join(" ");
        console.log(`    ${String(r.i).padStart(3)} ${r.site.padEnd(7)} ${r.request_id.slice(0, 60).padEnd(60)} -> ${r.status} seq=${r.body && r.body.seq} ${m ? `${m[1]}/#${m[2]}${m[3] === r.hash ? "" : " WRONG-PROMPT"}` : r.body && r.body.text != null ? "NO-REF" : (r.body && r.body.error) || ""} ${((r.doneAt - r.sentAt) / 1000).toFixed(1)}s typed ${ps || "-"}${r.fault ? " [" + r.fault + "]" : ""}`);
      }
    }
    if (process.env.OUT) fs.writeFileSync(process.env.OUT, JSON.stringify({ seed: SEED, quirks: QUIRKS, bridge: bridgeImpl, faults: [...FAULTS], checks: results, run, proxyLog, dumps, trace, events, captures, composes, hookLog, decisions }, null, 2));
    if (fails.length) console.log(`\n  FAIL (${fails.length}): ${fails.join(", ")}`);
    else console.log("\n  PASS");
    console.log(`  total ${((Date.now() - t0) / 1000).toFixed(1)} s · logs in ${work}`);
    if (EXPECT_FAIL.size) {
      const same = fails.length === EXPECT_FAIL.size && fails.every((f) => EXPECT_FAIL.has(f));
      console.log(same ? `  (expected failures: exactly ${[...EXPECT_FAIL].join(", ")})` : `  (expected failures ${[...EXPECT_FAIL].join(", ")} — got ${fails.join(", ") || "none"})`);
      return same;
    }
    return fails.length === 0;
  } finally {
    await browser.close().catch(() => {});
    try { await call("akowe:set-enabled", { enabled: false }); } catch (_) {}
    proxy.close();
    cleanup();
  }
}

main().then((ok) => process.exit(ok ? 0 : 1)).catch((e) => { console.error(e && e.stack || e); process.exit(1); });
