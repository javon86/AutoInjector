// test/log-extract-restart.test.js — "Last 24 hours" after a restart still has the events from before it.
// The user's 2026-11-02 log was taken 12 s after opening the app: 26 events, all from the last 12 s, because the
// in-memory activity list starts empty at every start. A time-range extract now also reads the older events from
// the on-disk debug log (same entries), without counting any twice and keeping the redaction.
// Run with: node test/log-extract-restart.test.js
process.env.AUTOINJECTOR_BRIDGE = "0";
process.env.AUTOINJECTOR_CHECKIN = "0";
process.env.AUTOINJECTOR_AKOWE_PORT = String(20000 + Math.floor(Math.random() * 20000));
process.env.AUTOINJECTOR_AKOWE_DIR = require("path").join(require("os").tmpdir(), "no-akowe-here-" + process.pid);
const path = require("path");
const fs = require("fs");
const os = require("os");
const Module = require("module");
const mockElectronPath = path.join(__dirname, "mock-electron.js");
const originalLoad = Module._load;
Module._load = function (request) { if (request === "electron") return require(mockElectronPath); return originalLoad.apply(this, arguments); };
const mockElectron = require(mockElectronPath);
mockElectron.shell = { openExternal: async () => {}, openPath: async () => "", showItemInFolder: () => {} };
let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(fn, t = 6000) { const s = Date.now(); while (Date.now() - s < t) { const r = await fn(); if (r) return r; await sleep(25); } return null; }

async function main() {
  // the PREVIOUS session's events, already on disk before the app starts
  const userData = mockElectron.app.getPath("userData");
  const now = Date.now();
  const HOME = os.homedir();
  const old = [
    { ts: now - 3 * 3600e3, kind: "framepack-loaded", detail: { seconds: 14.4, where: path.join(HOME, "Documents", "secret") }, tag: "video", level: "info" },
    { ts: now - 2 * 3600e3, kind: "framepack-generate", detail: { ok: false, code: "FRAMEPACK_FAILED" }, tag: "video", level: "error" },
    { ts: now - 30 * 3600e3, kind: "too-old-event", detail: {}, tag: "app", level: "info" }, // outside "last 24 hours"
  ];
  fs.writeFileSync(path.join(userData, "autoinjector-debug.log"), old.map((e) => JSON.stringify(e)).join("\n") + "\nnot json at all\n");
  require(path.join(__dirname, "..", "main.js"));
  const call = (ch, p) => mockElectron.__ipcHandlers[ch]({}, p);
  await waitUntil(() => mockElectron.__ipcHandlers["logs:extract-all"]);
  await sleep(300);
  console.log("\n== a restart, then 📋 Extract → Last 24 hours ==");
  const r = await call("logs:extract-all", { scope: "time", preset: "day" });
  let text = "";
  try { text = fs.readFileSync(r.file, "utf8"); fs.unlinkSync(r.file); } catch (_) { console.log(JSON.stringify(r).slice(0, 400)); }
  assert(/framepack-loaded/.test(text) && /framepack-generate/.test(text), "the events from before the restart are in it (FramePack loaded, the failed clip)");
  assert(!/too-old-event/.test(text), "an event older than 24 hours is not");
  assert(/state-restored|db-init|app-build|bridge|output-init/.test(text), "this session's own events are in it too");
  assert(!text.includes(path.join(HOME, "Documents", "secret")), "old events are redacted like the rest (no private path)");
  const n = (text.match(/framepack-loaded/g) || []).length;
  assert(n === 1, `nothing is counted twice (framepack-loaded appears ${n}×)`);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
setTimeout(() => { console.error("still running after 60 s"); process.exit(1); }, 60000).unref();
main().catch((e) => { console.error(e); process.exit(1); });
