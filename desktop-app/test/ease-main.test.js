// test/ease-main.test.js — the ✅ / 🩺 / 📖 helpers inside the REAL main.js (mock Electron, see mock-electron.js):
//   * ease:checklist reads the app's own state: the three panes, Akọwe's server, Ollama, the voice engine, Stable
//     Diffusion, video, Claude Code, the content folder and free space
//   * ease:problems finds errors planted in the activity log of the last 24 hours (codes only) and the health watch
//   * ease:report writes a support file in the logs folder: last 24 hours, NO conversation, keys and paths removed
//   * ease:fix runs existing controls (Turn an AI on, Check now) and refuses anything else
//   * ease:guide opens docs/USER_GUIDE.md in its own window; ease:prefs / set-prefs persist
// Run with: node test/ease-main.test.js
process.env.AUTOINJECTOR_POLL_MS = "50";
process.env.AUTOINJECTOR_SAVE_DEBOUNCE_MS = "30";
process.env.AUTOINJECTOR_BRIDGE = "0";
process.env.AUTOINJECTOR_CHECKIN = "0";
process.env.AUTOINJECTOR_CONTENT_SCAN = "0";
process.env.AUTOINJECTOR_AKOWE_SERVER = "0";
process.env.AUTOINJECTOR_HEALTH = "0";
process.env.AUTOINJECTOR_AKOWE_PORT = String(20000 + Math.floor(Math.random() * 20000));
process.env.AUTOINJECTOR_AKOWE_APP_URL = `http://127.0.0.1:${Number(process.env.AUTOINJECTOR_AKOWE_PORT) + 1}/api/ping`;

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
const opened = [];
mockElectron.shell = { openExternal: async (u) => { opened.push(["openExternal", u]); }, openPath: async (p) => { opened.push(["openPath", p]); return ""; }, showItemInFolder: (p) => opened.push(["showItemInFolder", p]) };

let passed = 0, failed = 0;
function assert(cond, msg) { if (cond) { passed++; console.log(`  ok   - ${msg}`); } else { failed++; console.log(`  FAIL - ${msg}`); } return cond; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(fn, timeout = 4000) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { const r = await fn(); if (r) return r; await sleep(20); } return null; }
function call(channel, payload) { return mockElectron.__ipcHandlers[channel]({}, payload); }
function reg(site) { return mockElectron.__registry[site]; }

async function main() {
  // planted before the app starts: 6 Stable Diffusion errors an hour ago, with private words in their details
  const SECRET = "Mara's secret letter to the court";
  const ud = mockElectron.__userDataDir;
  const now = Date.now();
  const lines = [];
  for (let i = 0; i < 6; i++) lines.push(JSON.stringify({ ts: now - 3600e3 + i * 1000, kind: "sd-runner-error", level: "error", tag: "images", detail: { error: SECRET } }));
  lines.push(JSON.stringify({ ts: now - 40 * 3600e3, kind: "video-ipc-error", level: "error", detail: {} })); // too old
  fs.writeFileSync(path.join(ud, "autoinjector-debug.log"), lines.join("\n") + "\n");

  require(path.join(__dirname, "..", "main.js"));
  await waitUntil(() => reg("claude") && reg("controls-ui"));
  for (const ch of ["ease:prefs", "ease:set-prefs", "ease:checklist", "ease:problems", "ease:report", "ease:fix", "ease:guide"]) assert(typeof mockElectron.__ipcHandlers[ch] === "function", `${ch} is registered`);

  console.log("\n== ✅ ease:checklist from the app's own state ==");
  const cl = await call("ease:checklist", {});
  const ids = (cl.items || []).map((i) => i.id);
  assert(cl.ok && ["pane-chatgpt", "pane-claude", "pane-gemini", "akowe", "content", "disk", "alfred-ai", "voice", "sd", "video", "claude-code"].every((id) => ids.includes(id)), `every row (${ids.join(", ")})`);
  const ak = cl.items.find((i) => i.id === "akowe");
  assert(ak.ok === false && ak.fix && ak.fix.action === "akowe-on", `Akọwe switched off here → ✖ + Turn it on (${ak.text})`);
  const content = cl.items.find((i) => i.id === "content");
  const outputManager = require("../output-manager");
  assert(content.ok === true && content.text.includes(outputManager.root()), "the content folder row names the real \"stuff and thing\"");
  const disk = cl.items.find((i) => i.id === "disk");
  assert(disk.ok !== null && /free/.test(disk.text), `free space read from the drive (${disk.text})`);
  assert(cl.items.find((i) => i.id === "claude-code").ok === null, "Claude Code: ⏳ while Akọwe is not running");
  assert(typeof cl.autoOpen === "boolean", "it says whether to open by itself");

  console.log("\n== ✅ ease:fix runs existing controls only ==");
  await call("participants:set", { site: "gemini", enabled: false });
  let cl2 = await call("ease:checklist", {});
  assert(cl2.items.find((i) => i.id === "pane-gemini").fix.action === "pane-on", "Gemini unticked → Turn Gemini on");
  const on = await call("ease:fix", { action: "pane-on", args: { site: "gemini" } });
  cl2 = await call("ease:checklist", {});
  assert(on && on.ok !== false && cl2.items.find((i) => i.id === "pane-gemini").fix.action !== "pane-on", "Fix it turned Gemini back on (participants:set)");
  const chk = await call("ease:fix", { action: "pane-check", args: { site: "claude" } });
  assert(chk && chk.ok, "Check now starts a check-in (selfrepair:probe)");
  const bad = await call("ease:fix", { action: "delete-everything", args: {} });
  assert(bad && bad.ok === false && bad.error === "UNKNOWN_ACTION", "anything else is refused");
  const folder = await call("ease:fix", { action: "open-folder", args: { path: path.join(ud, "..") } });
  assert(folder.ok === false && !opened.some((o) => o[0] === "openPath"), "a folder no row offered is never opened");
  const okFolder = await call("ease:fix", { action: "open-folder", args: { path: content.fix.args.path } });
  assert(okFolder.ok && opened.some((o) => o[0] === "openPath" && o[1] === content.fix.args.path), "the content folder opens");

  console.log("\n== 🩺 ease:problems ==");
  const pr = await call("ease:problems", {});
  assert(pr.ok && Array.isArray(pr.problems), "answers");
  const pics = pr.problems.find((p) => /Pictures/.test(p.text));
  assert(pics && /6 errors in the last 24 hours/.test(pics.text) && /codes: sd-runner-error/.test(pics.text) && pics.fix && pics.fix.args.tab === "images", `the planted problem: "${pics && pics.text}"`);
  assert(!JSON.stringify(pr).includes(SECRET) && !pr.problems.some((p) => /Video/.test(p.text)), "codes only (no event text); the 40-hour-old error is left out");
  assert(pr.problems.length <= 5, "at most 5");

  console.log("\n== 📄 ease:report ==");
  const rep = await call("ease:report", {});
  assert(rep.ok && rep.file && fs.existsSync(rep.file) && path.dirname(rep.file) === outputManager.logsDir() && /^support-report-.*\.txt$/.test(path.basename(rep.file)), `saved in the logs folder (${rep.file && path.basename(rep.file)})`);
  const text = fs.readFileSync(rep.file, "utf8");
  assert(/the last 24 hours/.test(text) && /AI conversation:\s+not included/.test(text), "last 24 hours; the AI conversation is not included");
  assert(/SOMETHING'S WRONG\? \(what the app found\)/.test(text) && /SETUP CHECKLIST/.test(text) && /sd-runner-error/.test(text), "what 🩺 found and the checklist are in it");
  assert(!/Everything — includes all conversations/.test(text), "never the Everything scope");
  assert(opened.some((o) => o[0] === "showItemInFolder" && o[1] === rep.file), "the file is shown in its folder");
  if (failed) console.log(text.slice(-1500));
  fs.unlinkSync(rep.file);

  console.log("\n== 📖 ease:guide and prefs ==");
  const before = Object.keys(mockElectron.__windowRegistry).length;
  const g = await call("ease:guide", {});
  assert(g.ok && g.found, "the guide file is found next to the app (docs/USER_GUIDE.md)");
  const gw = mockElectron.__windowRegistry["AutoInjector — User guide"];
  assert(gw || Object.keys(mockElectron.__windowRegistry).length > before, "a window titled \"AutoInjector — User guide\"");
  let p = await call("ease:set-prefs", { tourSeen: "akowe", dontShowChecklist: true });
  p = await call("ease:prefs", {});
  assert(p.ok && p.toursSeen.akowe && p.dontShowChecklist === true && fs.existsSync(path.join(ud, "autoinjector-ease.json")), "prefs saved in the settings folder");
  const cl3 = await call("ease:checklist", {});
  assert(cl3.autoOpen === false, "\"don't show again\" → it never opens by itself");

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
