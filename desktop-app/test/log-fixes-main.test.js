// test/log-fixes-main.test.js — PR #153, from the PC log report:
//   7. one copy at a time: a second launch brings the open window to the front (second-instance), and a copy that
//      did not get the lock quits without starting anything (no EADDRINUSE on the Akọwe bridge port);
//  10. 📋 Extract leaves the private AI conversation out unless it is asked for;
//  11. the on-disk debug log rotates (autoinjector-debug.1.log …) instead of being cut, and an extract still reads the
//      events from the rotated files.
// Run with: node test/log-fixes-main.test.js
process.env.AUTOINJECTOR_BRIDGE = "0";
process.env.AUTOINJECTOR_CHECKIN = "0";
process.env.AUTOINJECTOR_AKOWE_PORT = String(20000 + Math.floor(Math.random() * 20000));
process.env.AUTOINJECTOR_AKOWE_DIR = require("path").join(require("os").tmpdir(), "no-akowe-here-" + process.pid);
const path = require("path");
const fs = require("fs");
const Module = require("module");
const { spawnSync } = require("child_process");
const mockElectronPath = path.join(__dirname, "mock-electron.js");

// ---- the second copy (its own process): the lock is taken, so it quits and starts nothing
if (process.argv[2] === "--second-copy") {
  const originalLoad = Module._load;
  Module._load = function (request) { if (request === "electron") return require(mockElectronPath); return originalLoad.apply(this, arguments); };
  const m = require(mockElectronPath);
  m.app.requestSingleInstanceLock = () => false;
  require(path.join(__dirname, "..", "main.js"));
  setTimeout(() => {
    const log = (() => { try { return fs.readFileSync(path.join(m.app.getPath("userData"), "autoinjector-debug.log"), "utf8"); } catch (_) { return ""; } })();
    console.log(JSON.stringify({ quit: m.app.quitCalls, dbInit: /"db-init"/.test(log) }));
    process.exit(0);
  }, 800);
  return;
}

const originalLoad = Module._load;
Module._load = function (request) { if (request === "electron") return require(mockElectronPath); return originalLoad.apply(this, arguments); };
const mockElectron = require(mockElectronPath);
mockElectron.shell = { openExternal: async () => {}, openPath: async () => "", showItemInFolder: () => {} };
let lockAsked = 0;
mockElectron.app.requestSingleInstanceLock = () => { lockAsked++; return true; };
let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(fn, t = 6000) { const s = Date.now(); while (Date.now() - s < t) { const r = await fn(); if (r) return r; await sleep(25); } return null; }

async function main() {
  const userData = mockElectron.app.getPath("userData");
  const now = Date.now();
  const line = (ts, kind) => JSON.stringify({ ts, kind, detail: {}, tag: "app", level: "info" });
  // an earlier, full log (over 8 MB) and an already rotated one: the next line rotates them
  const filler = Array.from({ length: 120000 }, (_, i) => line(now - 5 * 3600e3 + i, "filler-event")).join("\n");
  fs.writeFileSync(path.join(userData, "autoinjector-debug.log"), line(now - 6 * 3600e3, "newest-old-event") + "\n" + filler + "\n");
  fs.writeFileSync(path.join(userData, "autoinjector-debug.1.log"), line(now - 10 * 3600e3, "older-rotated-event") + "\n");
  for (let n = 2; n <= 4; n++) fs.writeFileSync(path.join(userData, `autoinjector-debug.${n}.log`), line(now - (10 + n) * 3600e3, `rot-${n}`) + "\n");
  assert(fs.statSync(path.join(userData, "autoinjector-debug.log")).size > 8 * 1024 * 1024, "setup: the current log is over 8 MB");

  require(path.join(__dirname, "..", "main.js"));
  const call = (ch, p) => mockElectron.__ipcHandlers[ch]({}, p);
  await waitUntil(() => mockElectron.__ipcHandlers["logs:extract-all"]);
  await sleep(400);

  console.log("\n== 11. the debug log rotates instead of being cut ==");
  const cur = fs.readFileSync(path.join(userData, "autoinjector-debug.log"), "utf8");
  const one = fs.readFileSync(path.join(userData, "autoinjector-debug.1.log"), "utf8");
  const two = fs.readFileSync(path.join(userData, "autoinjector-debug.2.log"), "utf8");
  assert(/newest-old-event/.test(one) && (one.match(/filler-event/g) || []).length === 120000, "the full log became autoinjector-debug.1.log, whole (nothing cut)");
  assert(/older-rotated-event/.test(two), "the older one moved on to .2");
  assert(!fs.existsSync(path.join(userData, "autoinjector-debug.5.log")) && /rot-3/.test(fs.readFileSync(path.join(userData, "autoinjector-debug.4.log"), "utf8")), "only 4 old files are kept (the oldest went)");
  assert(!/filler-event/.test(cur) && cur.length > 0 && cur.length < 1024 * 1024, "the new log starts small, with this start's events");

  console.log("\n== 10 + 11. 📋 Extract: the AI conversation stays out unless asked; rotated events are read ==");
  const r = await call("logs:extract-all", { scope: "time", preset: "day" });
  let text = "";
  try { text = fs.readFileSync(r.file, "utf8"); fs.unlinkSync(r.file); } catch (_) { console.log(JSON.stringify(r).slice(0, 400)); }
  assert(/AI CONVERSATION/.test(text) && /\(not included in this extract\)/.test(text), "the AI conversation is not included by default (only its heading, saying so)");
  assert(/newest-old-event/.test(text) && /older-rotated-event/.test(text), "events from the rotated files are in the extract");
  const st = await call("logs:extract-options", {});
  if (st && st.default) assert(st.default.include && st.default.include.conversation === false, "the dialog's default leaves the conversation unticked");
  const r2 = await call("logs:extract-all", { scope: "time", preset: "day", include: { conversation: true } });
  let t2 = "";
  try { t2 = fs.readFileSync(r2.file, "utf8"); fs.unlinkSync(r2.file); } catch (_) {}
  assert(/AI CONVERSATION/.test(t2) && !/\(not included in this extract\)/.test(t2), "ticked, it is included");

  console.log("\n== 7. one copy at a time ==");
  assert(lockAsked === 1, "the app asks for the one-copy lock at start");
  const reg = mockElectron.__windowRegistry || {};
  const main = reg[Object.keys(reg).find((t) => /Automation/.test(t))];
  if (main) main._hidden = true; // hidden behind other windows / in the tray
  mockElectron.__emitApp("second-instance", {}, [], "");
  assert(main && main.isVisible(), "a second launch brings the open window back to the front");
  const second = spawnSync(process.execPath, [__filename, "--second-copy"], { encoding: "utf8", env: Object.assign({}, process.env), timeout: 30000 });
  let res = {};
  try { res = JSON.parse((second.stdout || "").trim().split("\n").pop()); } catch (_) { console.log(second.stdout, second.stderr); }
  assert(res.quit >= 1, "a copy that did not get the lock quits");
  assert(res.dbInit === false, "…without starting anything (no database, no bridge ports)");

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
setTimeout(() => { console.error("still running after 90 s"); process.exit(1); }, 90000).unref();
main().catch((e) => { console.error(e); process.exit(1); });
