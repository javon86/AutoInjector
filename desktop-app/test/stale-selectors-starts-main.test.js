// test/stale-selectors-starts-main.test.js — the user's log of 2026-11-09 (build a916ba9):
//   reply-selector-ignored {"site":"claude","selector":"div[data-cds=\"Prose\"]", …}
//   reply-selector-fragment {"site":"gemini", …}
// at EVERY start, never forgotten: PR #120 forgets a saved selector after 3 failing replies IN ONE RUN, and a start
// rarely sees that many from one AI. Now the same saved selector seen not to fit on 3 different app starts (while
// the built-in reader worked each time) is retired by itself — with a backup, a log code (selector-retired, starts:3)
// and a plain one-line notice for the control panel ("Claude's page changed; AutoInjector stopped using an old saved
// setting that no longer fits." + ↩ Put it back). A saved selector that works in between starts the count over; the
// reader's own "read the whole reply" fixes with NO saved selector are never blamed on one.
// The REAL main.js (mock Electron) is started 3 times over the same user-data folder (3 child processes).
// Run with: node test/stale-selectors-starts-main.test.js
"use strict";
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawnSync } = require("child_process");

const CHILD = process.argv[2] === "--start";

if (!CHILD) {
  let passed = 0, failed = 0;
  const assert = (c, m) => { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; };
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "ai-stale-starts-"));
  const now = Date.now(), H = 3600e3;
  fs.writeFileSync(path.join(userData, "autoinjector-state.json"), JSON.stringify({
    schemaVersion: 1, savedAt: now - H,
    selectorOverrides: { chatgpt: { assistant: "div.ok-reply" }, claude: {}, gemini: { assistant: "div.old-reply-part" } },
    pickMeta: { version: 1, sites: { chatgpt: { assistant: { savedAt: now - 30 * H, how: "pick", rev: 1, version: 1 } }, gemini: { assistant: { savedAt: now - 30 * H, how: "pick", rev: 1, version: 1 } } } },
    learnedSelectors: { version: 1, sites: { claude: { assistant: { selector: 'div[data-cds="Prose"]', how: "page-search", learnedAt: now - 20 * H, version: 1 } } } },
    // ChatGPT's saved reader was seen not to fit on 2 earlier starts; this start it works
    staleEvidence: { chatgpt: { assistant: { selector: "div.ok-reply", starts: 2, lastRun: "an-earlier-start", at: now - 2 * H } } }
  }));
  const runStart = (n) => {
    const r = spawnSync(process.execPath, [__filename, "--start", String(n)], { env: Object.assign({}, process.env, { AUTOINJECTOR_TEST_USERDATA: userData }), encoding: "utf8", timeout: 60000 });
    const line = String(r.stdout || "").split("\n").find((l) => l.startsWith("RESULT "));
    if (!line) { console.log(r.stdout, r.stderr); return null; }
    return JSON.parse(line.slice(7));
  };
  console.log("\n== start 1: Claude's learned reader finds nothing, Gemini's saved one reads part of the reply ==");
  const s1 = runStart(1);
  assert(s1 && s1.seen.claude === 1 && s1.seen.gemini === 1 && s1.retired.length === 0, `counted once each, nothing forgotten yet (${JSON.stringify(s1 && s1.seen)})`);
  assert(s1 && s1.evidence.claude && s1.evidence.claude.assistant.starts === 1 && s1.evidence.gemini.assistant.starts === 1, "remembered on disk for the next start");
  assert(s1 && !(s1.evidence.chatgpt || {}).assistant, "ChatGPT's saved reader worked this start: its earlier count is wiped");
  assert(s1 && s1.chatgptFragmentWarnings === 0, "the reader's own whole-reply fix with NO saved selector is not blamed on one (no reply-selector-fragment)");
  console.log("\n== start 2 ==");
  const s2 = runStart(2);
  assert(s2 && s2.seen.claude === 2 && s2.seen.gemini === 2 && s2.retired.length === 0, `second start counted (${JSON.stringify(s2 && s2.seen)})`);
  console.log("\n== start 3: forgotten by itself, with a backup and a plain notice ==");
  const s3 = runStart(3);
  const rc = s3 && s3.retired.find((x) => x.site === "claude");
  const rg = s3 && s3.retired.find((x) => x.site === "gemini");
  assert(rc && rc.role === "assistant" && rc.starts === 3 && rc.source === "learned" && rg && rg.starts === 3 && rg.source === "pick", `both retired on the 3rd start (selector-retired, starts:3) (${JSON.stringify(s3 && s3.retired)})`);
  assert(s3 && s3.notices.some((n) => n.site === "claude" && n.say === "Claude's page changed; AutoInjector stopped using an old saved setting that no longer fits."), `the control panel got the plain one-line notice (${s3 && JSON.stringify(s3.notices.map((n) => n.say))})`);
  assert(s3 && s3.stateNotices === 2, "…and it is there for a control panel opened later (state:get retireNotices)");
  assert(s3 && s3.saved.claudeLearned === null && s3.saved.geminiOverride === null && s3.saved.backupClaude === 'div[data-cds="Prose"]' && s3.saved.backupGemini === "div.old-reply-part", "saved: gone from use, kept as a backup");
  assert(s3 && s3.undo.ok && s3.undo.backClaude === 'div[data-cds="Prose"]' && s3.undo.noticeGone && s3.undo.undoneBroadcast, "↩ Put it back: Claude's old setting is used again and its notice goes");
  assert(s3 && s3.warnedAfterRetire === 0, "no more warnings about it after it was retired");
  console.log(`\n${passed} passed, ${failed} failed`);
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) {}
  process.exit(failed ? 1 : 0);
}

// ---- one app start (a child process) ----------------------------------------------------------------
process.env.AUTOINJECTOR_POLL_MS = "50";
process.env.AUTOINJECTOR_SAVE_DEBOUNCE_MS = "30";
process.env.AUTOINJECTOR_CAPTURE_SETTLE_MS = "100";
process.env.AUTOINJECTOR_STABLE_MS = "80";
process.env.AUTOINJECTOR_BRIDGE = "0";
process.env.AUTOINJECTOR_CHECKIN = "0";
process.env.AUTOINJECTOR_PROBE_DELAY_MS = "60000"; // the page check is not what this test drives
process.env.AUTOINJECTOR_AKOWE_PORT = String(20000 + Math.floor(Math.random() * 20000));
process.env.AUTOINJECTOR_AKOWE_DIR = path.join(os.tmpdir(), "no-akowe-here-" + process.pid);
const Module = require("module");
const mockElectronPath = path.join(__dirname, "mock-electron.js");
const originalLoad = Module._load;
Module._load = function (request) { if (request === "electron") return require(mockElectronPath); return originalLoad.apply(this, arguments); };
const mockElectron = require(mockElectronPath);
mockElectron.shell = { openExternal: async () => {}, openPath: async () => "", showItemInFolder: () => {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(fn, t = 6000) { const s = Date.now(); while (Date.now() - s < t) { const r = await fn(); if (r) return r; await sleep(25); } return null; }

async function child() {
  const n = Number(process.argv[3]);
  const userData = mockElectron.app.getPath("userData");
  const startLines = (() => { try { return fs.readFileSync(path.join(userData, "autoinjector-debug.log"), "utf8").split("\n").length; } catch (_) { return 0; } })();
  require(path.join(__dirname, "..", "main.js"));
  const call = (ch, p) => mockElectron.__ipcHandlers[ch]({}, p);
  const reg = (s) => mockElectron.__registry[s];
  await waitUntil(() => reg("chatgpt") && reg("claude") && reg("gemini") && reg("controls-ui") && mockElectron.__ipcHandlers["picker:undo-retire"]);
  const ui = [];
  reg("controls-ui").webContents.on("ipc-send", (ch, p) => { if (ch === "selector-retired") ui.push(p); });
  const logLines = (kind) => { let t = ""; try { t = fs.readFileSync(path.join(userData, "autoinjector-debug.log"), "utf8"); } catch (_) {} return t.split("\n").slice(Math.max(0, startLines - 1)).filter((l) => l.includes(`"kind":"${kind}"`)).map((l) => JSON.parse(l)); };
  const cfgOf = (script) => { const m = "const CFG = "; const i = script.indexOf(m); const e = script.indexOf(";\n", i); try { return JSON.parse(script.slice(i + m.length, e)); } catch (_) { return {}; } };
  // the page as the read script would see it: Claude — the saved reader finds nothing, the built-in one reads the
  // reply; Gemini — the saved one reads only part, the whole reply is used; ChatGPT — its saved reader works
  const reader = (site, flags, text) => {
    const wc = reg(site).webContents;
    wc.evaluator = async (script) => {
      if (script.includes("typeByKeyboard")) return { ok: true, method: "click", verified: true, proof: "number", markerBaseline: 0 };
      const cfg = cfgOf(script);
      const out = { ok: true, text, generating: false, sendReady: true, inputFound: true, count: 1 };
      if (cfg.OVERRIDE && flags.ignored) out.overrideIgnored = true;
      if (flags.fragment) out.fragmentFixed = flags.fragment;
      return out;
    };
  };
  reader("claude", { ignored: true }, `[TO: USER]\nClaude's answer at start ${n}.\n[FROM: CLAUDE]`);
  reader("gemini", { fragment: "container" }, `[TO: USER]\nGemini's answer at start ${n}.\n[FROM: GEMINI]`);
  reader("chatgpt", {}, `[TO: USER]\nChatGPT's answer at start ${n}.\n[FROM: CHATGPT]`);
  await waitUntil(() => logLines("selector-stale-seen").length >= 2 || logLines("selector-retired").length >= 2, 6000);
  await waitUntil(async () => (await call("state:get")).transcript.filter((t) => /answer at start/.test(t.text)).length >= 3, 4000);
  // ChatGPT, with its saved reader cleared: the reader's own whole-reply fix is nobody's fault
  await call("selector:clear", { site: "chatgpt", role: "assistant" });
  reader("chatgpt", { fragment: "siblings" }, `[TO: USER]\nChatGPT, split over blocks, start ${n}.\n[FROM: CHATGPT]`);
  await sleep(500);
  const seen = {};
  for (const l of logLines("selector-stale-seen")) seen[l.detail.site] = l.detail.starts;
  const retired = logLines("selector-retired").map((l) => l.detail);
  const out = { seen, retired, notices: ui.filter((x) => !x.undone), chatgptFragmentWarnings: logLines("reply-selector-fragment").filter((l) => l.detail.site === "chatgpt").length };
  if (n === 3) {
    out.stateNotices = ((await call("state:get")).retireNotices || []).length;
    await sleep(150);
    const st = JSON.parse(fs.readFileSync(path.join(userData, "autoinjector-state.json"), "utf8"));
    out.saved = {
      claudeLearned: (((st.learnedSelectors || {}).sites || {}).claude || {}).assistant ? "kept" : null,
      geminiOverride: ((st.selectorOverrides || {}).gemini || {}).assistant || null,
      backupClaude: (((st.retiredSelectors || {}).claude || {}).assistant || {}).selector || null,
      backupGemini: (((st.retiredSelectors || {}).gemini || {}).assistant || {}).selector || null
    };
    const warnedBefore = logLines("reply-selector-ignored").length + logLines("reply-selector-fragment").filter((l) => l.detail.site !== "chatgpt").length;
    reader("claude", { ignored: true }, "[TO: USER]\nClaude, later.\n[FROM: CLAUDE]");
    reader("gemini", { fragment: "container" }, "[TO: USER]\nGemini, later.\n[FROM: GEMINI]");
    await sleep(500);
    out.warnedAfterRetire = logLines("reply-selector-ignored").length + logLines("reply-selector-fragment").filter((l) => l.detail.site !== "chatgpt").length - warnedBefore;
    const u = await call("picker:undo-retire", { site: "claude", role: "assistant" });
    await sleep(150);
    const st2 = JSON.parse(fs.readFileSync(path.join(userData, "autoinjector-state.json"), "utf8"));
    out.undo = { ok: !!(u && u.ok), backClaude: ((((st2.learnedSelectors || {}).sites || {}).claude || {}).assistant || {}).selector || null, noticeGone: !((await call("state:get")).retireNotices || []).some((x) => x.site === "claude"), undoneBroadcast: ui.some((x) => x.undone && x.site === "claude") };
  }
  await sleep(150);
  out.evidence = JSON.parse(fs.readFileSync(path.join(userData, "autoinjector-state.json"), "utf8")).staleEvidence || {};
  console.log("RESULT " + JSON.stringify(out));
  process.exit(0);
}
if (CHILD) {
  setTimeout(() => { console.error("stale-selectors-starts child: still running after 50 s"); process.exit(1); }, 50000).unref();
  child().catch((e) => { console.error(e); process.exit(1); });
}
