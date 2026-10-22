// test/stress.test.js — TR-15 offline "fake-site stress test".
//
// Runs the REAL main.js relay (pollSite, sendTextTo with its retries / AI_BUSY
// wait / TR-28 capture-first gate, [TO:] tag routing, Auto mesh routing, the
// hop limit, Relay Trace) with the REAL send/read scripts from automation.js
// executing inside a REAL Chromium page for each AI. The three "AIs" are one
// parameterised fake chat site (test/fixtures/fake-chat.html) that copies each
// real site's DOM shape and the behaviours that have bitten the relay: a rich
// editor that ignores raw DOM writes, Send disabled until there is text, a Stop
// button while writing, streamed replies with [FROM:] last, a Gemini re-draw
// with a "PDF" chip, ChatGPT's hidden duplicate Send button and editor wrapper,
// slow box-clearing, and the occasional reply that forgets its [FROM:] tag.
//
// How it is wired: main.js runs under test/mock-electron.js exactly like
// test/run.js, except each AI pane's webContents.evaluator forwards
// executeJavaScript() to a Playwright page, so every script main.js builds runs
// against a live DOM. Each fake AI answers every "[MSG #n]" message with one
// reply addressed by a seeded plan ([TO: X] round-robin by default) and holding
// a unique token (e.g. GEMINI-R3), so the run is reproducible from its seed and
// every reply can be followed from the page that wrote it to the pages it
// reached.
//
// Pass = the project's finish line: with Auto (or tag) routing on, a ~20-message
// run across 3 AIs has no failed or unproven sends, no duplicate deliveries,
// every finished reply captured (and relayed where its tag / Auto says), and no
// relaying past the hop limit. Prints a per-AI report; exits 1 on failure.
//
// Run:   node test/stress.test.js            (or: npm run test:stress)
// Env:   SEED=7            seed for replies, plan and timings (default 1)
//        SEEDS=1,2,3       run several seeds, one fresh process each
//        QUIRKS=default    default | all | none | list, e.g. "default,-nofrom"
//        ROUTING=auto      auto (Auto mesh + tags) | tags (tag routing only)
//        PLAN=rr           rr | random  (who each fake AI addresses)
//        MESSAGES=20       about how many messages the run should carry
//        NOFROM=0.2        chance a reply forgets its [FROM:] tag
//        SPEED=1           fake-site timing multiplier
//        VERBOSE=1         print the Relay Trace report and event timeline
//        OUT=file.json     save the raw run data (events + page dumps)
"use strict";
const path = require("path");
const fs = require("fs");
const { spawnSync } = require("child_process");

// ---- several seeds: one child process per seed (main.js boots once per process)
if (process.env.SEEDS && !process.env.__TR15_CHILD) {
  const seeds = String(process.env.SEEDS).split(",").map((s) => s.trim()).filter(Boolean);
  let bad = 0;
  for (const seed of seeds) {
    const r = spawnSync(process.execPath, [__filename], { stdio: "inherit", env: { ...process.env, SEED: seed, __TR15_CHILD: "1" } });
    if (r.status !== 0) bad++;
  }
  console.log(`\nTR-15 stress: ${seeds.length - bad}/${seeds.length} seeds passed`);
  process.exit(bad ? 1 : 0);
}

const SEED = String(process.env.SEED || "1");
const QUIRKS = String(process.env.QUIRKS || "default");
const ROUTING = String(process.env.ROUTING || "auto").toLowerCase() === "tags" ? "tags" : "auto";
const PLAN = String(process.env.PLAN || "rr");
const MESSAGES = Math.max(3, Number(process.env.MESSAGES) || 20);
const NOFROM = process.env.NOFROM != null ? Number(process.env.NOFROM) : 0.2;
const SPEED = Number(process.env.SPEED) || 1;
const VERBOSE = process.env.VERBOSE === "1";
const RUN_TIMEOUT_MS = Number(process.env.RUN_TIMEOUT_MS) || 100000;
const QUIET_MS = Number(process.env.QUIET_MS) || 3000;
// Each relayed reply is one hop. Auto forwards a reply to BOTH other AIs (its
// [TO:] target plus the Auto route to the third), tag routing to one.
const FANOUT = ROUTING === "auto" ? 2 : 1;
const HOP_MAX = Math.max(1, Math.round((MESSAGES - 1) / FANOUT));

// ---- main.js on a fast, consistent clock (same knobs as test/run.js). Must be
// set before main.js is required.
Object.assign(process.env, {
  AUTOINJECTOR_BRIDGE: "0",
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
});

const Module = require("module");
const mockElectronPath = path.join(__dirname, "mock-electron.js");
const originalLoad = Module._load;
Module._load = function (request) {
  if (request === "electron") return require(mockElectronPath);
  return originalLoad.apply(this, arguments);
};
const mockElectron = require(mockElectronPath);
// Nothing outside the relay should start: no local model servers.
try { const om = require(path.join(__dirname, "..", "ollama-manager")); om.detect = async () => ({ available: false }); } catch (_) {}
try { const ip = require(path.join(__dirname, "..", "interpreter-provider")); ip.startManaged = async () => ({ ok: false }); } catch (_) {}

const { chromium } = require("playwright");
const SANDBOX_CHROMIUM_PATH = "/opt/pw-browsers/chromium"; // same fallback as test/browser.test.js
function resolveExecutablePath() {
  try { if (fs.existsSync(SANDBOX_CHROMIUM_PATH)) return SANDBOX_CHROMIUM_PATH; } catch (_) {}
  return undefined;
}

const SITES = ["chatgpt", "claude", "gemini"];
const LABEL = { chatgpt: "ChatGPT", claude: "Claude", gemini: "Gemini" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reg = (s) => mockElectron.__registry[s];
function call(channel, payload) {
  const h = mockElectron.__ipcHandlers[channel];
  if (!h) throw new Error(`no ipc handler registered for "${channel}"`);
  return h({}, payload);
}
async function waitUntil(fn, timeout, interval = 100) {
  const start = Date.now();
  while (Date.now() - start < timeout) { const r = await fn(); if (r) return r; await sleep(interval); }
  return null;
}
const TOKEN_RE = /\b(CHATGPT|CLAUDE|GEMINI)-R(\d+)\b/;
const tokenOf = (t) => { const m = TOKEN_RE.exec(String(t || "")); return m ? m[0] : null; };
const seqOf = (t) => { const m = /^\[MSG #(\d+)\]/.exec(String(t || "")); return m ? m[1] : null; };

async function main() {
  const t0 = Date.now();
  require(path.join(__dirname, "..", "main.js"));
  const booted = await waitUntil(() => SITES.every((s) => reg(s) && reg(s).webContents) && mockElectron.__registry["controls-ui"], 10000);
  if (!booted) throw new Error("main.js did not create its panes");

  // ---- everything main.js tells the UI, in order
  const events = [];
  let lastActivity = Date.now();
  const ACTIVE_LOG = new Set(["sent", "send-retry", "send-error", "send-waiting-busy", "send-waiting-capture", "send-capture-wait-timeout", "endtag-missing", "reply-redrawn", "captured", "hop-limit", "totag-missing"]);
  const captures = []; // { site, token, tag, ts, held }
  const lastCaptureOf = {};
  let hopLimitAt = null;
  mockElectron.__registry["controls-ui"].webContents.on("ipc-send", (channel, payload) => {
    const ts = Date.now();
    if (channel === "capture") {
      const c = { site: payload.site, token: tokenOf(payload.text), tag: payload.roundtableTag || null, ts, held: null, id: payload.id };
      captures.push(c); lastCaptureOf[payload.site] = c; lastActivity = ts;
      events.push({ ts, channel, site: payload.site, token: c.token, tag: c.tag });
    } else if (channel === "log") {
      const k = payload.kind, d = payload.detail || {};
      if (k === "hop-limit") { if (!hopLimitAt) hopLimitAt = ts; if (lastCaptureOf[d.site]) lastCaptureOf[d.site].held = "hop-limit"; }
      if (k === "loop-suppressed" && lastCaptureOf[d.site]) lastCaptureOf[d.site].held = "loop-guard";
      if (ACTIVE_LOG.has(k)) lastActivity = ts;
      events.push({ ts, channel, kind: k, detail: d });
    } else if (channel === "sent" || channel === "send-error" || channel === "generation") {
      lastActivity = ts;
      events.push({ ts, channel, ...payload });
    }
  });

  // ---- three fake AI sites in one real Chromium
  const executablePath = resolveExecutablePath();
  const browser = await chromium.launch(executablePath ? { executablePath } : {});
  const pages = {};
  try {
    for (const site of SITES) {
      const ctx = await browser.newContext({ viewport: { width: 1000, height: 800 } });
      const page = await ctx.newPage();
      const q = new URLSearchParams({ site, seed: SEED, quirks: QUIRKS, plan: PLAN, nofrom: String(NOFROM), speed: String(SPEED) });
      await page.goto(`file://${path.join(__dirname, "fixtures", "fake-chat.html")}?${q}`);
      pages[site] = page;
      reg(site).webContents.evaluator = (script) => page.evaluate(script);
    }

    // ---- set up like a user would: all three in play, Auto on (or tags only), then one message
    for (const s of SITES) await call("participants:set", { site: s, enabled: true });
    await call("relay:hop-limit", { max: HOP_MAX });
    if (ROUTING === "auto") await call("routing:auto-all", {});
    const quirkList = await pages.chatgpt.evaluate(() => window.__fake.quirks.join(","));
    console.log(`\n== TR-15 fake-site stress: seed=${SEED} routing=${ROUTING} plan=${PLAN} quirks=${QUIRKS} (chatgpt: ${quirkList}) hop limit=${HOP_MAX} ==`);
    const kick = await call("send:compose", { text: `Stress run ${SEED}: talk about relay reliability.`, targets: ["chatgpt"] });
    if (!kick || !kick.ok || !kick.results.chatgpt.ok) console.log(`  kickoff send failed: ${JSON.stringify(kick)}`);
    lastActivity = Date.now();

    // ---- run until everything is quiet (or the time budget runs out)
    let timedOut = false;
    for (;;) {
      await sleep(250);
      if (Date.now() - t0 > RUN_TIMEOUT_MS) { timedOut = true; break; }
      const idle = (await Promise.all(SITES.map((s) => pages[s].evaluate(() => window.__fake.idle())))).every(Boolean);
      const sentLogs = events.filter((e) => e.channel === "log" && (e.kind === "sent" || e.kind === "send-error")).length;
      const tr = await call("trace:report", {});
      const inFlight = tr.report.messages - sentLogs;
      if (!idle || inFlight > 0) { lastActivity = Math.max(lastActivity, Date.now() - 1); continue; }
      if (Date.now() - lastActivity > QUIET_MS) break;
    }

    // ---- collect
    const dumps = {};
    for (const s of SITES) dumps[s] = await pages[s].evaluate(() => window.__fake.dump());
    const trace = await call("trace:report", {});
    const runMs = Date.now() - t0;
    const ok = evaluate({ dumps, trace, captures, events, hopLimitAt, timedOut, runMs });
    if (process.env.OUT) fs.writeFileSync(process.env.OUT, JSON.stringify({ seed: SEED, routing: ROUTING, quirks: QUIRKS, plan: PLAN, hopMax: HOP_MAX, dumps, trace: trace.report, captures, events }, null, 2));
    return ok;
  } finally {
    await browser.close().catch(() => {});
  }
}

function evaluate({ dumps, trace, captures, events, hopLimitAt, timedOut, runMs }) {
  const r = trace.report;
  const fails = [];
  const logs = (kind) => events.filter((e) => e.channel === "log" && e.kind === kind);

  // Ground truth from the pages: what each fake AI actually received and wrote.
  const per = {};
  for (const s of SITES) {
    const d = dumps[s];
    const seqs = d.posted.map((p) => seqOf(p.text)).filter(Boolean);
    const dupSeq = seqs.filter((q, i) => seqs.indexOf(q) !== i);
    // The same AI reply (by its token) delivered twice to the same AI.
    const relayedTokens = d.posted.map((p) => tokenOf(p.text)).filter(Boolean);
    const dupTok = relayedTokens.filter((t, i) => relayedTokens.indexOf(t) !== i);
    const finished = d.replies.filter((x) => x.finishedAt && !x.aborted);
    const tagged = finished.filter((x) => x.tagged);
    const capturedFrom = captures.filter((c) => c.site === s);
    const capTokens = capturedFrom.map((c) => c.token).filter(Boolean);
    const dupCap = capTokens.filter((t, i) => capTokens.indexOf(t) !== i);
    // Every finished reply must end up captured: a tagged one directly, one that
    // forgot its [FROM:] tag after the app's nudge made the AI re-send it.
    const missed = Array.from(new Set(tagged.map((x) => x.token))).filter((t) => !capTokens.includes(t));
    const lostUntagged = Array.from(new Set(finished.filter((x) => !x.tagged).map((x) => x.token))).filter((t) => !capTokens.includes(t));
    const ts = r.sites[s] || { sent: 0, proven: 0, failed: 0, unproven: 0, retried: 0, duplicates: 0, errors: {} };
    per[s] = { d, dupSeq, dupTok, finished, tagged, capturedFrom, dupCap, missed, lostUntagged, ts, untagged: finished.filter((x) => !x.tagged).length, resends: finished.filter((x) => x.resend).length };
  }

  // 1) no failed / unproven sends
  for (const s of SITES) {
    const { ts, d } = per[s];
    if (ts.failed) fails.push(`${LABEL[s]}: ${ts.failed} send(s) FAILED (${JSON.stringify(ts.errors)})`);
    if (ts.unproven) fails.push(`${LABEL[s]}: ${ts.unproven} send(s) never proven in the chat`);
    if (d.posted.length !== ts.sent - ts.failed) fails.push(`${LABEL[s]}: the app says ${ts.sent - ts.failed} delivered but the page received ${d.posted.length}`);
    if (d.stopClicks) fails.push(`${LABEL[s]}: the app clicked the Stop button ${d.stopClicks}x (aborted a reply)`);
  }
  // 2) no duplicate deliveries / captures
  for (const s of SITES) {
    const { dupSeq, dupTok, dupCap } = per[s];
    if (dupSeq.length) fails.push(`${LABEL[s]}: message(s) ${dupSeq.map((q) => "#" + q).join(", ")} posted twice`);
    if (dupTok.length) fails.push(`${LABEL[s]}: reply ${dupTok.join(", ")} delivered to it twice`);
    if (dupCap.length) fails.push(`${LABEL[s]}: reply ${dupCap.join(", ")} captured twice`);
  }
  // 3) every finished, tagged reply captured; and relayed where it should go
  for (const s of SITES) if (per[s].missed.length) fails.push(`${LABEL[s]}: finished reply(s) never captured: ${per[s].missed.join(", ")}`);
  for (const s of SITES) if (per[s].lostUntagged.length) fails.push(`${LABEL[s]}: reply(s) that forgot [FROM:] were never recovered (no nudge reached the AI before the next message buried them): ${per[s].lostUntagged.join(", ")}`);
  const routeMiss = [];
  for (const c of captures) {
    if (!c.token || c.held) continue;
    const others = SITES.filter((t) => t !== c.site);
    const tag = String(c.tag || "USER");
    let want = tag === "ALL" ? others : others.includes(tag.toLowerCase()) ? [tag.toLowerCase()] : [];
    if (ROUTING === "auto" && tag !== "USER") want = others;
    for (const t of want) if (!dumps[t].posted.some((p) => tokenOf(p.text) === c.token)) routeMiss.push(`${c.token}→${LABEL[t]}`);
  }
  if (routeMiss.length) fails.push(`captured replies never relayed where their tag / Auto said: ${routeMiss.join(", ")}`);
  // 4) bounded by the hop limit
  const relaySends = logs("sent").filter((e) => e.detail.from).length + logs("send-error").filter((e) => e.detail.from).length;
  if (relaySends > HOP_MAX * FANOUT) fails.push(`${relaySends} AI-to-AI relays, more than the hop limit allows (${HOP_MAX} hops x ${FANOUT})`);
  if (!hopLimitAt) fails.push(`the conversation stopped before reaching the hop limit (${HOP_MAX}) — it should run until the limit pauses it`);
  if (timedOut) fails.push(`did not settle within ${Math.round(RUN_TIMEOUT_MS / 1000)} s`);
  for (const s of SITES) if (!dumps[s].idle) fails.push(`${LABEL[s]}: still writing at the end`);

  // ---- report
  const total = SITES.reduce((n, s) => n + per[s].d.posted.length, 0);
  console.log(`  ${total} messages delivered · ${captures.length} replies captured · ${relaySends} AI-to-AI relays · hop limit ${hopLimitAt ? "reached" : "NOT reached"} · ${(runMs / 1000).toFixed(1)} s`);
  console.log("  AI        sent proven posted | replies untagged resent captured | dup retries busyWaits");
  for (const s of SITES) {
    const p = per[s];
    const busy = logs("send-waiting-busy").filter((e) => e.detail.target === s).length;
    const dups = p.dupSeq.length + p.dupTok.length + p.dupCap.length;
    console.log(`  ${LABEL[s].padEnd(8)} ${String(p.ts.sent).padStart(5)} ${String(p.ts.proven).padStart(6)} ${String(p.d.posted.length).padStart(6)} | ${String(p.finished.length).padStart(7)} ${String(p.untagged).padStart(8)} ${String(p.resends).padStart(6)} ${String(p.capturedFrom.length).padStart(8)} | ${String(dups).padStart(3)} ${String(p.ts.retried).padStart(7)} ${String(busy).padStart(9)}`);
  }
  const count = (k) => logs(k).length;
  console.log(`  events: redraws ignored=${count("reply-redrawn")} · missing-[FROM:] nudges=${count("endtag-missing")} · capture-first waits=${count("send-waiting-capture")} (timeouts ${count("send-capture-wait-timeout")}) · send retries=${count("send-retry")} · hop-limit holds=${count("hop-limit")}`);
  if (VERBOSE || fails.length) {
    console.log("\n" + require(path.join(__dirname, "..", "relay-trace")).formatReport(r, { label: (s) => LABEL[s] || s }).split("\n").map((l) => "  | " + l).join("\n"));
  }
  if (VERBOSE) {
    const t0 = events.length ? events[0].ts : 0;
    for (const e of events) {
      if (e.channel === "generation") continue;
      const at = ((e.ts - t0) / 1000).toFixed(2).padStart(6);
      if (e.channel === "capture") console.log(`  ${at} capture ${e.site} ${e.token} [TO: ${e.tag}]`);
      else if (e.channel === "log") console.log(`  ${at} ${e.kind} ${JSON.stringify(e.detail)}`);
    }
  }
  if (fails.length) { console.log("\n  FAIL"); for (const f of fails) console.log(`  FAIL - ${f}`); }
  else console.log("  PASS - no failed sends, no duplicates, every reply captured and relayed, bounded by the hop limit");
  return fails.length === 0;
}

main().then((ok) => process.exit(ok ? 0 : 1)).catch((e) => { console.error(e && e.stack || e); process.exit(1); });
