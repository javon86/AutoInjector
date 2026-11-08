// test/lockers-main.test.js — the 📁 AI lockers switch in the REAL main.js (mock Electron, see mock-electron.js):
//   * an older state file (no "lockers" key) starts with the lockers OFF; the built-in routing prompt is refreshed
//     to a text with no [TO: TERMINAL] / locker lines; the butler intro doesn't teach them either
//   * lockers:status answers (and makes no folder); every other lockers:* call answers LOCKERS_OFF
//   * an AI's [TO: TERMINAL] block is NOT run: logged, one short notice to that AI, never a second one, not forwarded
//   * Alfred's lockers.* controls are hidden; the Feature Test says why it can't run
//   * the switch is saved; switched on (⚙ Advanced → lockers:set-enabled) everything works as before; off again,
//     the folders are kept (never deleted)
// Run with: node test/lockers-main.test.js
process.env.AUTOINJECTOR_POLL_MS = "50";
process.env.AUTOINJECTOR_STABLE_MS = "80";
process.env.AUTOINJECTOR_SAVE_DEBOUNCE_MS = "30";
process.env.AUTOINJECTOR_CAPTURE_SETTLE_MS = "100";
process.env.AUTOINJECTOR_SEND_BUSY_POLL_MS = "50";
process.env.AUTOINJECTOR_BRIDGE = "0";
process.env.AUTOINJECTOR_CHECKIN = "0";
process.env.AUTOINJECTOR_CONTENT_SCAN = "0";
delete process.env.AUTOINJECTOR_LOCKERS;
process.env.AUTOINJECTOR_AKOWE_PORT = String(20000 + Math.floor(Math.random() * 20000));

const fs = require("fs");
const path = require("path");
const Module = require("module");
const mockElectronPath = path.join(__dirname, "mock-electron.js");
const originalLoad = Module._load;
Module._load = function (request) {
  if (request === "electron") return require(mockElectronPath);
  return originalLoad.apply(this, arguments);
};
const mockElectron = require(mockElectronPath);
mockElectron.shell = { openExternal: async () => {}, openPath: async () => "", showItemInFolder: () => {} };

let passed = 0, failed = 0;
function assert(cond, msg) { if (cond) { passed++; console.log(`  ok   - ${msg}`); } else { failed++; console.log(`  FAIL - ${msg}`); } return cond; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(fn, timeout = 5000) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { const r = await fn(); if (r) return r; await sleep(25); } return null; }
function call(channel, payload) { return mockElectron.__ipcHandlers[channel]({}, payload); }
function reg(site) { return mockElectron.__registry[site]; }
function say(site, text) { reg(site).webContents.currentText = text; }
const SITES = ["chatgpt", "claude", "gemini"];

// An older build's saved state: no "lockers" key, and its built-in routing prompt (id 2) from before the lockers.
const userData = mockElectron.app.getPath("userData");
const stateFile = path.join(userData, "autoinjector-state.json");
fs.writeFileSync(stateFile, JSON.stringify({
  schemaVersion: 1, savedAt: Date.now(), transcript: [],
  prompts: [
    { id: 1, name: "System Test", text: { chatgpt: "hi", claude: "hi", gemini: "hi" } },
    { id: 2, name: "System Prompt (How Routing Works)", text: { chatgpt: "old routing text", claude: "old routing text", gemini: "old routing text" } },
  ],
}));
const lockersRoot = path.join(__dirname, "..", "..", "stuff and thing", "ai-lockers");
const rootExisted = fs.existsSync(lockersRoot);
const listing = (dir) => { try { return fs.readdirSync(dir).sort().join(","); } catch (_) { return null; } };
const before = listing(lockersRoot);

async function main() {
  require(path.join(__dirname, "..", "main.js"));
  await waitUntil(() => reg("claude") && reg("controls-ui"));
  const ui = [];
  const uiWc = reg("controls-ui").webContents;
  const origSend = uiWc.send ? uiWc.send.bind(uiWc) : null;
  uiWc.send = (ch, p) => { ui.push([ch, p]); if (origSend) try { origSend(ch, p); } catch (_) {} };
  await sleep(100);

  console.log("\n== 📁 lockers OFF by default (an older state file migrates to off) ==");
  const st = await call("lockers:status", {});
  assert(st.ok === true && st.enabled === false && st.saved === false && st.forcedByEnv === false, "lockers:status answers: off, not forced by the env var");
  assert(/ai-lockers$/.test(st.root || ""), `it names where the folders would be (${st.root})`);
  assert(rootExisted ? listing(lockersRoot) === before : !fs.existsSync(lockersRoot), rootExisted ? "the existing ai-lockers folder is left exactly as it was" : "no ai-lockers folder was made on startup");
  for (const [ch, payload] of [["lockers:list", { site: "claude" }], ["lockers:read", { site: "claude", rel: "plan.md" }], ["lockers:attach", { site: "claude", rel: "plan.md", targets: ["gemini"] }], ["lockers:open", {}]]) {
    const r = await call(ch, payload);
    assert(r && r.ok === false && r.error === "LOCKERS_OFF" && r.message === "AI lockers are switched off (⚙ Advanced → AI lockers).", `${ch} → LOCKERS_OFF`);
  }
  assert(rootExisted ? listing(lockersRoot) === before : !fs.existsSync(lockersRoot), "…and still no new folder after those calls");

  const prompts = (await call("state:get", {})).prompts;
  const routing = prompts.find((p) => p.id === 2);
  assert(routing && SITES.every((s) => !/TERMINAL|YOUR LOCKER|locker/i.test(routing.text[s])), "the built-in routing prompt teaches no [TO: TERMINAL] / locker lines");
  assert(SITES.every((s) => /\[TO: USER\]/.test(routing.text[s]) && routing.text[s].includes(`[FROM: ${s.toUpperCase()}]`)), "…and still teaches the [TO:] / [FROM:] envelope");
  assert(routing.text.claude !== "old routing text", "the old untouched built-in was refreshed");

  const ft = await call("featuretest:run", {});
  assert(ft && ft.ok === false && /AI lockers are switched off/.test(ft.error), `the Feature Test says why it can't run (${ft && ft.error})`);

  console.log("\n== [TO: TERMINAL] while off: not run, logged, ONE short notice, no loop ==");
  for (const s of SITES) await call("participants:set", { site: s, enabled: true });
  const ledger = async () => (await call("state:get", {})).ledger;
  let mark = (await ledger()).length;
  say("claude", "[TO: TERMINAL]\nSaving my notes.\n```\nwrite plan.md\n# Plan\nstep one\n```\n[FROM: CLAUDE]");
  const notice = await waitUntil(async () => (await ledger()).slice(mark).find((e) => e.target === "claude" && /File commands are switched off in AutoInjector/.test(e.textPreview || "")));
  assert(!!notice, "Claude gets the short plain notice through the normal send path");
  await sleep(300);
  const log1 = (await call("state:get", {})).log.filter((l) => l.kind === "terminal-request-ignored");
  assert(log1.length >= 1 && log1[0].detail.from === "claude" && log1[0].detail.notified === true, "the ignored request is in the Activity Log");
  assert(!fs.existsSync(path.join(lockersRoot, "claude", "plan.md")) || rootExisted, "nothing was written");
  assert(!(await ledger()).slice(mark).some((e) => e.target !== "claude" && /step one/.test(e.textPreview || "")), "the block is not forwarded to the other AIs");
  assert(!(await ledger()).slice(mark).some((e) => /\[FROM: TERMINAL\]/.test(e.textPreview || "")), "no terminal result is sent (nothing ran)");
  mark = (await ledger()).length;
  say("claude", "[TO: TERMINAL]\n```\ndir\n```\n[FROM: CLAUDE]");
  await waitUntil(async () => (await call("state:get", {})).log.filter((l) => l.kind === "terminal-request-ignored").length >= 2);
  await sleep(400);
  const log2 = (await call("state:get", {})).log.filter((l) => l.kind === "terminal-request-ignored");
  assert(log2.length >= 2 && log2[log2.length - 1].detail.notified === false, "a second [TO: TERMINAL] is logged but NOT answered again");
  assert(!(await ledger()).slice(mark).some((e) => e.target === "claude"), "nothing more is sent to Claude — it can't loop");
  assert(((await call("terminal:state", {})).state.pending || []).length === 0, "nothing is held for approval");

  console.log("\n== the butler intro and Alfred while off ==");
  const sentBefore = reg("gemini").webContents.sentLog.length;
  await call("butler:send-intro", { targets: ["gemini"] });
  const intro = (reg("gemini").webContents.sentLog.slice(sentBefore).map((x) => (x && (x.text || x.message)) || JSON.stringify(x)).join("\n"));
  assert(/HOW MESSAGES WORK/.test(intro) && !/TERMINAL|YOUR LOCKER/.test(intro), "the butler intro teaches the envelope without [TO: TERMINAL]");
  const appActions = require("../alfred-app-actions");
  assert(appActions.get("lockers.list") === null, "Alfred's lockers.* controls are hidden");
  const cat = await call("alfred:catalog", {});
  assert(cat && cat.ok && !cat.groups.some((g) => g.items.some((i) => /^lockers\./.test(i.id))), "\"Everything I can do\" has no locker items");

  await waitUntil(() => { try { return JSON.parse(fs.readFileSync(stateFile, "utf8")).lockers; } catch (_) { return null; } });
  assert(JSON.parse(fs.readFileSync(stateFile, "utf8")).lockers.enabled === false, "the switch is saved in the state file (off)");

  console.log("\n== ⚙ Advanced → AI lockers ON: everything as before ==");
  const on = await call("lockers:set-enabled", { enabled: true });
  assert(on.ok && on.enabled === true && on.saved === true, "lockers:set-enabled turns them on");
  assert(ui.some(([ch, p]) => ch === "lockers-state" && p && p.enabled === true), "the panel is told (lockers-state) so the Locker tab comes back");
  const st2 = await call("lockers:status", {});
  assert(st2.ok && st2.enabled && SITES.every((s) => fs.existsSync(path.join(st2.root, s, "inbox"))), "on: each AI's locker with its inbox exists");
  const routing2 = (await call("state:get", {})).prompts.find((p) => p.id === 2);
  assert(/YOUR LOCKER/.test(routing2.text.claude) && /\[TO: TERMINAL\]/.test(routing2.text.claude), "on: the built-in routing prompt teaches the locker commands again");
  assert(appActions.get("lockers.list") !== null, "on: Alfred's lockers.* controls are back");
  try { fs.unlinkSync(path.join(st2.root, "gemini", "switch-test.md")); } catch (_) {}
  mark = (await ledger()).length;
  say("gemini", "[TO: TERMINAL]\n```\nwrite switch-test.md\nhello from the switch test\n```\n[FROM: GEMINI]");
  const res = await waitUntil(async () => (await ledger()).slice(mark).find((e) => e.target === "gemini" && /\[FROM: TERMINAL\][\s\S]*switch-test\.md/.test(e.textPreview || "")));
  assert(!!res && fs.readFileSync(path.join(st2.root, "gemini", "switch-test.md"), "utf8").includes("hello from the switch test"), "on: [TO: TERMINAL] runs in the AI's locker and the result goes back, as before");
  const lst = await call("lockers:list", { site: "gemini" });
  assert(lst.ok && lst.files.some((f) => f.rel === "switch-test.md"), "on: lockers:list works again");
  await waitUntil(() => { try { return JSON.parse(fs.readFileSync(stateFile, "utf8")).lockers.enabled === true; } catch (_) { return false; } });
  assert(JSON.parse(fs.readFileSync(stateFile, "utf8")).lockers.enabled === true, "on is saved");

  console.log("\n== switched off again: hidden, folders kept ==");
  const off = await call("lockers:set-enabled", { enabled: false });
  assert(off.ok && off.enabled === false, "off again");
  assert(fs.existsSync(path.join(st2.root, "gemini", "switch-test.md")), "the folders and files are kept (never deleted)");
  assert((await call("lockers:list", { site: "gemini" })).error === "LOCKERS_OFF" && appActions.get("lockers.list") === null, "the calls and Alfred's controls are off again");
  const routing3 = (await call("state:get", {})).prompts.find((p) => p.id === 2);
  assert(!/TERMINAL/.test(routing3.text.claude), "the built-in routing prompt drops the terminal lines again");
  try { fs.unlinkSync(path.join(st2.root, "gemini", "switch-test.md")); } catch (_) {}

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("Test runner crashed:", e); process.exit(1); });
