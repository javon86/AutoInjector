// test/save-state-main.test.js — 💾 Save state / 📂 Load state, driving the REAL main.js (mock Electron):
//   * savestate:save keeps each pane's chat address, the set-up (Active AIs, relay, roles, hop limit, zoom, window
//     size) and the window's own bits (from saveStateUi.snapshot()) in one JSON file under userData/saved-states
//   * savestate:load puts all three chats back at once and the set-up with them, and hands the window the result
//     (saveStateUi.apply) — also when the save is named loosely ("salt keeper")
//   * a chat that is gone (404) is said in plain words; an address that is not a real AI chat is refused
//   * while a picture is being made it asks first (BUSY) and changes nothing; "anyway" loads it
//   * rename / delete; the log has codes and counts only (no chat text, no addresses)
// Run with: node test/save-state-main.test.js
process.env.AUTOINJECTOR_POLL_MS = "50";
process.env.AUTOINJECTOR_SAVE_DEBOUNCE_MS = "30";
process.env.AUTOINJECTOR_BRIDGE = "0";
process.env.AUTOINJECTOR_CHECKIN = "0";
process.env.AUTOINJECTOR_CONTENT_SCAN = "0";
process.env.AUTOINJECTOR_SAVESTATE_SETTLE_MS = "0";
process.env.AUTOINJECTOR_SAVESTATE_LOAD_MS = "2000";
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

let passed = 0, failed = 0;
function assert(cond, msg) { if (cond) { passed++; console.log(`  ok   - ${msg}`); } else { failed++; console.log(`  FAIL - ${msg}`); } return cond; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(fn, timeout = 4000) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { const r = await fn(); if (r) return r; await sleep(20); } return null; }
function call(channel, payload) { return mockElectron.__ipcHandlers[channel]({}, payload); }
function reg(site) { return mockElectron.__registry[site]; }
const URLS = { chatgpt: "https://chatgpt.com/c/6720-abc", claude: "https://claude.ai/chat/1f2e-77", gemini: "https://gemini.google.com/app/9a8b7c" };

async function main() {
  require(path.join(__dirname, "..", "main.js"));
  await waitUntil(() => reg("claude") && reg("controls-ui"));
  const log = [];
  reg("controls-ui").webContents.on("ipc-send", (ch, payload) => { if (ch === "log") log.push(payload); });
  // the window: what saveStateUi.snapshot() would say, and what apply() is handed
  const applied = [];
  let snap = { composer: "Write chapter 12 — the keeper's secret", alfredActive: true, tab: "video", columns: { chatgpt: "open", claude: "reduced", gemini: "min" }, mainRowCollapsed: true, panelsCollapsed: ["gpu"] };
  reg("controls-ui").webContents.evaluator = async (script) => {
    if (script.includes("saveStateUi.snapshot")) return snap;
    const m = /window\.saveStateUi && window\.saveStateUi\.apply\(([\s\S]*)\)$/.exec(script);
    if (m) { applied.push(JSON.parse(m[1])); return true; }
    return null;
  };
  const win = mockElectron.__windowRegistry["AutoInjector Desktop — Automation"];
  for (const s of Object.keys(URLS)) reg(s).webContents.loadURL(URLS[s]);
  await call("participants:set", { site: "gemini", enabled: false });
  await call("routing:set", { source: "chatgpt", target: "claude", enabled: true });
  await call("roles:set", { site: "claude", role: "a strict editor" });
  await call("relay:hop-limit", { max: 7 });
  await call("site:zoom", { site: "claude", factor: 0.8 });
  win.setBounds({ width: 1400, height: 900 });

  console.log("\n== 💾 save ==");
  let r = await call("savestate:save", { name: "  Salt Keeper ch 12 " });
  assert(r.ok && r.name === "Salt Keeper ch 12" && /Saved as “Salt Keeper ch 12”/.test(r.message), `saved (${r.message})`);
  const dir = path.join(mockElectron.__userDataDir, "saved-states");
  const file = path.join(dir, `${r.id}.json`);
  assert(fs.existsSync(file), `one JSON file in userData/saved-states (${path.basename(file)})`);
  const saved = JSON.parse(fs.readFileSync(file, "utf8")).data;
  assert(saved.panes.claude.url === URLS.claude && saved.panes.chatgpt.url === URLS.chatgpt && saved.panes.gemini.url === URLS.gemini, "each pane's chat address is kept");
  assert(saved.panes.claude.zoom === 0.8, "the pane zoom is kept");
  assert(saved.setup.enabled.gemini === false && saved.setup.enabled.claude === true, "which AIs are Active");
  assert(saved.setup.ui.composer === snap.composer && saved.setup.ui.tab === "video" && saved.setup.ui.columns.claude === "reduced" && saved.setup.ui.alfredActive === true && saved.setup.ui.mainRowCollapsed === true, "the Compose box, the tab, the pane sizes, Alfred in → All");
  assert(saved.relay.routing.chatgpt.includes("claude") && saved.relay.roles.claude === "a strict editor" && saved.relay.hopLimit === 7, "the relay set-up (who forwards to whom, roles, hop limit)");
  assert(saved.setup.window && saved.setup.window.width === 1400 && saved.setup.window.height === 900, "the window size");
  r = await call("savestate:save", { name: "salt keeper CH 12" });
  assert(!r.ok && r.error === "NAME_TAKEN" && /already a save called/.test(r.message), "the same name again asks first (NAME_TAKEN)");

  console.log("\n== things change, then 📂 load puts them back ==");
  for (const s of Object.keys(URLS)) reg(s).webContents.loadURL(`https://example.invalid/elsewhere-${s}`);
  await call("participants:set", { site: "gemini", enabled: true });
  await call("routing:set", { source: "chatgpt", target: "claude", enabled: false });
  await call("roles:set", { site: "claude", role: "" });
  await call("relay:hop-limit", { max: 3 });
  win.setBounds({ width: 1000, height: 700 });
  const list = await call("savestate:list");
  assert(list.ok && list.count === 1 && list.saves[0].name === "Salt Keeper ch 12" && list.saves[0].savedAt > 0 && list.max === 200, "the list shows it with its time (up to 200 are kept)");
  r = await call("savestate:load", { name: "salt keeper" });
  assert(r.ok && r.name === "Salt Keeper ch 12", `loaded by a loose name (${r.message})`);
  assert(Object.keys(URLS).every((s) => reg(s).webContents.getURL() === URLS[s]), "all three panes are back on their saved chats");
  assert(["chatgpt", "claude", "gemini"].every((s) => r.results[s].state === "ok") && /All saved chats are back/.test(r.message), "every pane: ok, in plain words");
  const st = await call("state:get");
  assert(st.global.enabled.gemini === false && st.global.routing.chatgpt.includes("claude") && st.global.customRole.claude === "a strict editor", "Active AIs, forwarding and roles are put back");
  assert((await call("relay:hop-limit", {})).max === 7, "the hop limit is put back");
  assert(win.getBounds().width === 1400 && win.getBounds().height === 900, "the window size is put back");
  const ap = applied[applied.length - 1];
  assert(ap && ap.ui.composer === snap.composer && ap.ui.tab === "video" && ap.global.enabled.gemini === false && ap.result && ap.result.name === "Salt Keeper ch 12", "the window is handed its bits, the Active AIs and the result (saveStateUi.apply)");

  console.log("\n== a chat that is gone ==");
  const cwc = reg("claude").webContents;
  const origLoad = cwc.loadURL.bind(cwc);
  cwc.loadURL = (u) => { origLoad(u); setImmediate(() => cwc.emit("did-navigate", {}, u, 404)); return Promise.resolve(); };
  r = await call("savestate:load", { id: list.saves[0].id });
  assert(r.ok && r.results.claude.state === "gone" && /Claude: that chat is gone/.test(r.message) && r.problems.includes("claude"), `Claude's chat is gone, said in plain words (${r.results.claude.say})`);
  assert(r.results.chatgpt.state === "ok", "the others still open");
  cwc.loadURL = origLoad;

  console.log("\n== a save with an address that is not a real AI chat ==");
  const text = fs.readFileSync(file, "utf8").replace(URLS.claude, "https://evil.example.com/chat/1");
  fs.writeFileSync(file, text);
  cwc.loadURL("https://claude.ai/chat/current");
  r = await call("savestate:load", { name: "Salt Keeper ch 12" });
  assert(r.ok && r.results.claude.state === "refused" && /isn't a Claude chat address/.test(r.results.claude.say), "refused, in plain words");
  assert(cwc.getURL() === "https://claude.ai/chat/current", "Claude's pane did not go anywhere");

  console.log("\n== busy: a picture is being made ==");
  const imageProvider = require("../image-provider");
  const origStatus = imageProvider.status;
  imageProvider.status = () => Object.assign({}, origStatus.call(imageProvider), { busy: true });
  reg("chatgpt").webContents.loadURL("https://chatgpt.com/c/now");
  r = await call("savestate:load", { name: "Salt Keeper ch 12" });
  assert(!r.ok && r.error === "BUSY" && /a picture is being made/.test(r.message) && /Load it anyway\?/.test(r.message), `asks first (${r.message})`);
  assert(reg("chatgpt").webContents.getURL() === "https://chatgpt.com/c/now", "nothing changed");
  r = await call("savestate:load", { name: "Salt Keeper ch 12", anyway: true });
  assert(r.ok && reg("chatgpt").webContents.getURL() === URLS.chatgpt, "“Load it anyway” loads it");
  imageProvider.status = origStatus;

  console.log("\n== rename, delete, damaged ==");
  r = await call("savestate:rename", { id: "Salt Keeper ch 12", name: "Salt Keeper — chapter 12" });
  assert(r.ok && (await call("savestate:list")).saves[0].name === "Salt Keeper — chapter 12", "renamed (found by its old name)");
  fs.writeFileSync(path.join(dir, "half-written.json"), "{\"format\":\"autoinjector-saved-state\",");
  const l2 = await call("savestate:list");
  assert(l2.ok && l2.saves.some((x) => x.id === "half-written" && x.damaged), "a damaged file is listed as damaged");
  r = await call("savestate:load", { id: "half-written" });
  assert(!r.ok && r.error === "DAMAGED" && /damaged/.test(r.message), "loading it says so");
  assert((await call("savestate:delete", { id: "half-written" })).ok, "it can be deleted");
  const v = await call("savestate:view", { id: l2.saves.find((x) => !x.damaged).id });
  assert(v.ok && v.backup && Array.isArray(v.backup.claude) && v.panes.claude.url, "the read-only viewer gets the saved copy");
  r = await call("savestate:delete", { name: "Salt Keeper — chapter 12" });
  assert(r.ok && (await call("savestate:list")).count === 0, "deleted");
  assert((await call("savestate:load", { name: "nothing" })).error === "NOT_FOUND", "loading a save that is not there says so");

  console.log("\n== the log: codes and counts only ==");
  const ours = log.filter((e) => /^savestate-/.test(e.kind));
  assert(ours.length >= 6, `the save/load/rename/delete steps are logged (${ours.length})`);
  const all = JSON.stringify(ours);
  assert(!all.includes("keeper") && !all.includes("Keeper") && !all.includes("claude.ai/chat") && !all.includes("strict editor"), "no names, chat text or addresses in the log");

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
