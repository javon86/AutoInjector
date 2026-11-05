// test/stale-selectors-main.test.js — PR #120 (log 2026-11-04): saved selectors that
// keep failing while the built-in way works ("send-saved-button-missing" for ChatGPT,
// "reply-selector-ignored" for Claude's div[data-cds="Prose"], "reply-selector-fragment"
// for Gemini) are forgotten after 3 such sends / replies in a row, logged ONCE in plain
// words, with a backup for ↺ Undo — never one the user set in the last hour.
// Run with: node test/stale-selectors-main.test.js
"use strict";
process.env.AUTOINJECTOR_POLL_MS = "50";
process.env.AUTOINJECTOR_SAVE_DEBOUNCE_MS = "30";
process.env.AUTOINJECTOR_CAPTURE_SETTLE_MS = "100";
process.env.AUTOINJECTOR_STABLE_MS = "80";
process.env.AUTOINJECTOR_NOTAG_QUIET_MS = "400";
process.env.AUTOINJECTOR_BRIDGE = "0";
process.env.AUTOINJECTOR_CHECKIN = "0";
process.env.AUTOINJECTOR_AKOWE_PORT = String(20000 + Math.floor(Math.random() * 20000));
process.env.AUTOINJECTOR_AKOWE_DIR = require("path").join(require("os").tmpdir(), "no-akowe-here-" + process.pid);
const path = require("path");
const fs = require("fs");
const Module = require("module");
const mockElectronPath = path.join(__dirname, "mock-electron.js");
const originalLoad = Module._load;
Module._load = function (request) { if (request === "electron") return require(mockElectronPath); return originalLoad.apply(this, arguments); };
const mockElectron = require(mockElectronPath);
mockElectron.shell = { openExternal: async () => {}, openPath: async () => "", showItemInFolder: () => {} };
mockElectron.clipboard = { writeText: () => {} };
let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(fn, t = 6000) { const s = Date.now(); while (Date.now() - s < t) { const r = await fn(); if (r) return r; await sleep(25); } return null; }

async function main() {
  const userData = mockElectron.app.getPath("userData");
  const now = Date.now();
  const H = 3600e3;
  // the user's saved state from earlier runs (as in the log)
  fs.writeFileSync(path.join(userData, "autoinjector-state.json"), JSON.stringify({
    schemaVersion: 1, savedAt: now - H,
    selectorOverrides: { chatgpt: { send: 'button[aria-label="Send"]' }, claude: {}, gemini: { send: 'button.my-new-send' } },
    pickMeta: { version: 1, sites: { chatgpt: { send: { savedAt: now - 30 * H, how: "pick", rev: 2, version: 1 } }, gemini: { send: { savedAt: now - 10 * 60e3, how: "pick", rev: 1, version: 1 } } } },
    learnedSelectors: { version: 1, sites: { claude: { assistant: { selector: 'div[data-cds="Prose"]', how: "page-search", learnedAt: now - 20 * H, version: 1 } } } }
  }));
  require(path.join(__dirname, "..", "main.js"));
  const call = (ch, p) => mockElectron.__ipcHandlers[ch]({}, p);
  const reg = (s) => mockElectron.__registry[s];
  await waitUntil(() => reg("chatgpt") && reg("claude") && reg("gemini") && mockElectron.__ipcHandlers["picker:undo-retire"]);
  await sleep(200);
  const logLines = (kind) => { let t = ""; try { t = fs.readFileSync(path.join(userData, "autoinjector-debug.log"), "utf8"); } catch (_) {} return t.split("\n").filter((l) => l.includes(`"kind":"${kind}"`)).map((l) => JSON.parse(l)); };
  const stateNow = () => JSON.parse(fs.readFileSync(path.join(userData, "autoinjector-state.json"), "utf8"));
  const cfgOf = (script) => { const m = "const CFG = "; const i = script.indexOf(m); const e = script.indexOf(";\n", i); try { return JSON.parse(script.slice(i + m.length, e)); } catch (_) { return {}; } };

  // a send script that works only through the BUILT-IN Send button (the saved one is not on the page)
  const builtInSend = (wc) => {
    wc.evaluator = async (script) => {
      if (script.includes("typeByKeyboard")) { const cfg = cfgOf(script); return { ok: true, method: "click", verified: true, proof: "number", markerBaseline: 0, savedSend: cfg.OVERRIDE_SEND ? "missing" : undefined }; }
      return { ok: true, text: wc.currentText || "", generating: false, sendReady: true, inputFound: true };
    };
  };
  builtInSend(reg("chatgpt").webContents);
  builtInSend(reg("gemini").webContents);

  console.log("\n== ChatGPT's saved Send button (saved 30 h ago) is missing, the built-in one works ×3 -> forgotten once, with a backup ==");
  for (let i = 1; i <= 2; i++) await call("send:compose", { text: `hello ${i}`, targets: ["chatgpt"] });
  assert(logLines("selector-retired").length === 0 && logLines("send-saved-button-missing").filter((l) => l.detail.target === "chatgpt").length === 1, "after 2: still kept, warned once");
  await call("send:compose", { text: "hello 3", targets: ["chatgpt"] });
  let ret = logLines("selector-retired");
  assert(ret.length === 1 && ret[0].detail.site === "chatgpt" && ret[0].detail.role === "send" && ret[0].detail.note.startsWith("ChatGPT's saved Send button was out of date and has been forgotten; the built-in one works."), `after 3: forgotten, said once in plain words (${ret[0] && ret[0].detail.note})`);
  let ps = await call("picker:status", { site: "chatgpt" });
  assert(ps.items.send.state === "none" && ps.retired && ps.retired.send && ps.retired.send.selector === 'button[aria-label="Send"]', "the 🎯 card: no saved Send button any more, the backup is there for ↺ Undo");
  for (let i = 4; i <= 6; i++) await call("send:compose", { text: `hello ${i}`, targets: ["chatgpt"] });
  assert(logLines("send-saved-button-missing").filter((l) => l.detail.target === "chatgpt").length === 1 && logLines("selector-retired").length === 1, "no more warnings after that, nothing retired twice");
  await sleep(150);
  let saved = stateNow();
  assert(!saved.selectorOverrides.chatgpt.send && !(saved.pickMeta.sites.chatgpt || {}).send && saved.retiredSelectors.chatgpt.send.selector === 'button[aria-label="Send"]' && saved.retiredSelectors.chatgpt.send.meta.rev === 2, "saved to disk: gone from the saved parts, kept as a backup (with its old details)");

  console.log("\n== ↺ Undo brings it back ==");
  const un = await call("picker:undo-retire", { site: "chatgpt" });
  assert(un.ok && un.undone.join() === "send" && un.items.send.state === "saved" && !(un.retired || {}).send, `↺ Undo: the saved Send button is back (${un.items && un.items.send.state})`);
  assert(logLines("selector-retire-undone").length === 1, "…and logged");
  for (let i = 7; i <= 10; i++) await call("send:compose", { text: `hello ${i}`, targets: ["chatgpt"] });
  assert(logLines("selector-retired").length === 1, "a selector brought back by ↺ Undo counts as just set: not forgotten again within the hour");
  assert((await call("picker:undo-retire", { site: "claude" })).error === "NOTHING_TO_UNDO", "nothing to undo -> says so");

  console.log("\n== Gemini's Send button saved 10 minutes ago is never forgotten by itself ==");
  for (let i = 1; i <= 4; i++) await call("send:compose", { text: `hi ${i}`, targets: ["gemini"] });
  assert(!logLines("selector-retired").some((l) => l.detail.site === "gemini") && (await call("picker:status", { site: "gemini" })).items.send.state !== "none", "a part the user set in the last hour is left alone");

  console.log("\n== Claude's learned reply selector finds nothing, the built-in reader reads 3 replies -> forgotten ==");
  const cw = reg("claude").webContents;
  cw.evaluator = async (script) => {
    if (script.includes("typeByKeyboard")) return { ok: true, method: "click", verified: true, proof: "number", markerBaseline: 0 };
    return { ok: true, text: cw.currentText || "", generating: false, sendReady: true, inputFound: true, overrideIgnored: !!cfgOf(script).OVERRIDE_ASSISTANT || /data-cds/.test(script) };
  };
  for (let i = 1; i <= 3; i++) {
    await call("send:compose", { text: `question ${i}`, targets: ["claude"] });
    cw.currentText = `[TO: USER]\nAnswer number ${i}.\n[FROM: CLAUDE]`;
    await waitUntil(async () => (await call("state:get")).transcript.some((t) => t.site === "claude" && t.text === `Answer number ${i}.`), 5000);
  }
  ret = logLines("selector-retired").filter((l) => l.detail.site === "claude");
  assert(ret.length === 1 && ret[0].detail.role === "assistant" && ret[0].detail.source === "learned" && /Claude's saved reply reader was out of date and has been forgotten; the built-in one works/.test(ret[0].detail.note), `forgotten after 3 replies read by the built-in reader (${ret.length})`);
  assert(logLines("reply-selector-ignored").filter((l) => l.detail.site === "claude").length === 1, "the warning was logged once, not on every read");
  await sleep(150);
  saved = stateNow();
  assert(!(saved.learnedSelectors.sites.claude || {}).assistant && saved.retiredSelectors.claude.assistant.source === "learned", "saved: the learned reply selector is gone, its backup kept");

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
setTimeout(() => { console.error("stale-selectors-main: still running after 90 s"); process.exit(1); }, 90000).unref();
main().catch((e) => { console.error(e); process.exit(1); });
