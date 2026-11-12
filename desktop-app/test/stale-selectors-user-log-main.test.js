// test/stale-selectors-user-log-main.test.js — the user's log of 2026-11-12 (build de64cbb, with PR #142):
//   selector-stale-seen {"site":"claude","role":"assistant","selector":"div[data-cds=\"Prose\"]","source":"pick",
//                        "kind":"ignored","starts":1,"retireAt":3}
// FOUR times over two app starts — "starts" never went above 1, so the out-of-date saved reply reader was never
// forgotten and "reply-selector-ignored" came back at every start. Cause: Claude's saved reader fits SOME replies and
// not others; each reply it fitted wiped the count the earlier starts had built up (at once — even in a start that
// had just seen it not fit), so each later miss counted "1" again. Now a reply it fits is only noted, and the count
// starts over only when a WHOLE start saw it fit and never miss.
// Also (decided 2026-11-12): a saved reply reader that never found a single reply on 2 starts (while the built-in
// reader read them all) is forgotten on the 2nd start; one the user saved in the last hour is never forgotten.
// The REAL main.js (mock Electron) is started several times over the same user-data folder (child processes).
// Run with: node test/stale-selectors-user-log-main.test.js
"use strict";
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawnSync } = require("child_process");

const CHILD = process.argv[2] === "--start";
const PROSE = 'div[data-cds="Prose"]';

if (!CHILD) {
  let passed = 0, failed = 0;
  const assert = (c, m) => { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; };
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "ai-stale-userlog-"));
  const now = Date.now(), H = 3600e3;
  fs.writeFileSync(path.join(userData, "autoinjector-state.json"), JSON.stringify({
    schemaVersion: 1, savedAt: now - H,
    // Claude: the user's saved pick (fits some replies, not others); ChatGPT: a saved pick that never fits;
    // Gemini: one that never fits either, but the user saved it 20 minutes ago
    selectorOverrides: { claude: { assistant: PROSE }, chatgpt: { assistant: "div.never-a-reply" }, gemini: { assistant: "div.just-saved" } },
    pickMeta: { version: 1, sites: {
      claude: { assistant: { savedAt: now - 30 * H, how: "pick", rev: 1, version: 1 } },
      chatgpt: { assistant: { savedAt: now - 30 * H, how: "pick", rev: 1, version: 1 } },
      gemini: { assistant: { savedAt: now - 20 * 60e3, how: "pick", rev: 1, version: 1 } }
    } }
  }));
  const runStart = (n) => {
    const r = spawnSync(process.execPath, [__filename, "--start", String(n)], { env: Object.assign({}, process.env, { AUTOINJECTOR_TEST_USERDATA: userData }), encoding: "utf8", timeout: 90000 });
    const line = String(r.stdout || "").split("\n").find((l) => l.startsWith("RESULT "));
    if (!line) { console.log(r.stdout, r.stderr); return null; }
    return JSON.parse(line.slice(7));
  };
  const seenOf = (s, site) => (s ? s.seen.filter((x) => x.site === site) : []);
  console.log("\n== start 1 (8:53 AM): Claude's saved reader misses, fits, misses, fits ==");
  const s1 = runStart(1);
  const c1 = seenOf(s1, "claude");
  assert(c1.length === 1 && c1[0].starts === 1, `Claude counted once this start, starts:1 (${JSON.stringify(c1)})`);
  assert(s1 && s1.evidence.claude && s1.evidence.claude.assistant && s1.evidence.claude.assistant.starts === 1, `a reply it fitted did NOT wipe the count (${JSON.stringify(s1 && s1.evidence.claude)})`);
  assert(s1 && s1.retired.length === 0, "nothing forgotten on the 1st start");
  console.log("\n== start 2 (9:18 AM): the same again ==");
  const s2 = runStart(2);
  const c2 = seenOf(s2, "claude");
  assert(c2.length === 1 && c2[0].starts === 2 && c2[0].retireAt === 3, `Claude: starts:2 (it fitted some replies, so 3 starts are needed) (${JSON.stringify(c2)})`);
  const g2 = seenOf(s2, "chatgpt");
  const rChat = s2 && s2.retired.find((x) => x.site === "chatgpt");
  assert(g2.length === 1 && g2[0].starts === 2 && g2[0].retireAt === 2 && rChat && rChat.starts === 2, `ChatGPT's saved reader never found a reply on 2 starts: forgotten on the 2nd (${JSON.stringify(g2)} ${JSON.stringify(rChat)})`);
  assert(s2 && !s2.retired.some((x) => x.site === "claude"), "Claude not forgotten yet");
  console.log("\n== start 3: Claude's saved reader is forgotten, with the notice and ↩ Put it back ==");
  const s3 = runStart(3);
  const rc = s3 && s3.retired.find((x) => x.site === "claude");
  assert(rc && rc.role === "assistant" && rc.starts === 3 && rc.source === "pick" && rc.selector === PROSE, `Claude retired on the 3rd start (selector-retired, starts:3) (${JSON.stringify(s3 && s3.retired)})`);
  assert(s3 && s3.notices.some((x) => x.site === "claude" && x.say === "Claude's page changed; AutoInjector stopped using an old saved setting that no longer fits."), "the control panel got the plain one-line notice");
  assert(s3 && s3.claudeSavedAfter === null && s3.backupClaude === PROSE, "no longer used, kept as a backup");
  assert(s3 && s3.undo.ok && s3.undo.back === PROSE && s3.undo.noticeGone, "↩ Put it back brings it back and the notice goes");
  assert(s3 && seenOf(s3, "gemini").every((x) => x.starts <= 3) && ![s1, s2, s3].some((s) => s && s.retired.some((x) => x.site === "gemini")), "Gemini's reader, saved by the user 20 minutes ago, is never forgotten");
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
process.env.AUTOINJECTOR_PROBE_DELAY_MS = "60000";
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
  // what the read script reports: "miss" — the saved reader finds no reply, the built-in one reads it; "fit" — the
  // saved reader itself read the whole reply
  const reader = (site, how, text) => {
    reg(site).webContents.evaluator = async (script) => {
      if (script.includes("typeByKeyboard")) return { ok: true, method: "click", verified: true, proof: "number", markerBaseline: 0 };
      const cfg = cfgOf(script);
      const out = { ok: true, text, generating: false, sendReady: true, inputFound: true, count: 1 };
      if (cfg.OVERRIDE) { out.overrideIgnored = how === "miss"; out.overrideHit = how === "fit"; }
      return out;
    };
  };
  const captured = (text) => waitUntil(async () => (await call("state:get")).transcript.some((t) => t.text && t.text.includes(text)), 6000);
  // ChatGPT and Gemini: their saved readers never find a reply this start
  reader("chatgpt", "miss", `[TO: USER]\nChatGPT reply, start ${n}.\n[FROM: CHATGPT]`);
  reader("gemini", "miss", `[TO: USER]\nGemini reply, start ${n}.\n[FROM: GEMINI]`);
  // Claude: the user's sequence — two misses per start, with replies the saved reader fits in between (and last)
  const steps = ["miss", "fit", "miss", "fit"];
  for (let i = 0; i < steps.length; i++) {
    const text = `Claude reply ${i + 1} (${steps[i]}), start ${n}.`;
    reader("claude", steps[i], `[TO: USER]\n${text}\n[FROM: CLAUDE]`);
    await captured(text);
  }
  await captured(`ChatGPT reply, start ${n}.`);
  await captured(`Gemini reply, start ${n}.`);
  await sleep(300);
  const out = {
    seen: logLines("selector-stale-seen").map((l) => l.detail),
    retired: logLines("selector-retired").map((l) => l.detail),
    notices: ui.filter((x) => !x.undone)
  };
  if (n === 3) {
    await sleep(150);
    const st = JSON.parse(fs.readFileSync(path.join(userData, "autoinjector-state.json"), "utf8"));
    out.claudeSavedAfter = ((st.selectorOverrides || {}).claude || {}).assistant || null;
    out.backupClaude = (((st.retiredSelectors || {}).claude || {}).assistant || {}).selector || null;
    const u = await call("picker:undo-retire", { site: "claude", role: "assistant" });
    await sleep(150);
    const st2 = JSON.parse(fs.readFileSync(path.join(userData, "autoinjector-state.json"), "utf8"));
    out.undo = { ok: !!(u && u.ok), back: ((st2.selectorOverrides || {}).claude || {}).assistant || null, noticeGone: !((await call("state:get")).retireNotices || []).some((x) => x.site === "claude") };
  }
  await sleep(150);
  out.evidence = JSON.parse(fs.readFileSync(path.join(userData, "autoinjector-state.json"), "utf8")).staleEvidence || {};
  console.log("RESULT " + JSON.stringify(out));
  process.exit(0);
}
if (CHILD) {
  setTimeout(() => { console.error("stale-selectors-user-log child: still running after 80 s"); process.exit(1); }, 80000).unref();
  child().catch((e) => { console.error(e); process.exit(1); });
}
