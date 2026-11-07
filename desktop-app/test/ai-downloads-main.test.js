// test/ai-downloads-main.test.js — ⬇ files an AI gives you, driving the REAL main.js (mock Electron, see mock-electron.js):
//   * each AI's session gets ONE will-download listener — also after the window (and its panes) is made again
//   * the save path is set inside the handler: <stuff and thing>/ai-work/<ai>/<name>
//   * progress and the finished notice reach the panel ("ai-download"); downloads:list / downloads:open work,
//     and "Open file" refuses a program
//   * an interrupted download is resumed
//   * closing the window while a file is still coming in asks first ("A download is still coming in…")
//   * the app's own reload of that pane (self-repair ⟳ / a fresh chat) waits until the file is in
// Run with: node test/ai-downloads-main.test.js
process.env.AUTOINJECTOR_POLL_MS = "50";
process.env.AUTOINJECTOR_SAVE_DEBOUNCE_MS = "30";
process.env.AUTOINJECTOR_BRIDGE = "0";
process.env.AUTOINJECTOR_CHECKIN = "0";
process.env.AUTOINJECTOR_RUN_GUARD_MS = "100";
process.env.AUTOINJECTOR_WAKE_GRACE_MS = "200";
process.env.AUTOINJECTOR_CONTENT_SCAN = "0";
process.env.AUTOINJECTOR_DOWNLOAD_PROGRESS_MS = "0";
process.env.AUTOINJECTOR_DOWNLOAD_RESUME_DELAY_MS = "10";
process.env.AUTOINJECTOR_RELOAD_WAIT_MS = "300";
process.env.AUTOINJECTOR_AKOWE_PORT = String(20000 + Math.floor(Math.random() * 20000));
process.env.AUTOINJECTOR_AKOWE_APP_URL = `http://127.0.0.1:${Number(process.env.AUTOINJECTOR_AKOWE_PORT) + 1}/api/ping`;
process.env.AUTOINJECTOR_FRESH_CHAT_REQUESTS = "1";
process.env.AUTOINJECTOR_FRESH_CHAT_CHARS = "0";
process.env.AUTOINJECTOR_FRESH_CHAT_SETTLE_MS = "20";
process.env.AUTOINJECTOR_FRESH_CHAT_USER_QUIET_MS = "60000";

const fs = require("fs");
const http = require("http");
const path = require("path");
const Module = require("module");
const { EventEmitter } = require("events");
const mockElectronPath = path.join(__dirname, "mock-electron.js");
const originalLoad = Module._load;
Module._load = function (request) {
  if (request === "electron") return require(mockElectronPath);
  return originalLoad.apply(this, arguments);
};
const mockElectron = require(mockElectronPath);
const opened = [];
mockElectron.shell = { openExternal: async () => {}, openPath: async (p) => { opened.push(["openPath", p]); return ""; }, showItemInFolder: (p) => opened.push(["showItemInFolder", p]) };

let passed = 0, failed = 0;
function assert(cond, msg) { if (cond) { passed++; console.log(`  ok   - ${msg}`); } else { failed++; console.log(`  FAIL - ${msg}`); } return cond; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(fn, timeout = 4000) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { const r = await fn(); if (r) return r; await sleep(20); } return null; }
function call(channel, payload) { return mockElectron.__ipcHandlers[channel]({}, payload); }
function reg(site) { return mockElectron.__registry[site]; }
const PORT = Number(process.env.AUTOINJECTOR_AKOWE_PORT);
function request(method, urlPath, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (data) { headers["Content-Type"] = "application/json"; headers["Content-Length"] = data.length; }
    const req = http.request({ host: "127.0.0.1", port: PORT, method, path: urlPath, headers, agent: false }, (res) => {
      const chunks = []; res.on("data", (c) => chunks.push(c));
      res.on("end", () => { let json = null; try { json = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch (_) {} resolve({ status: res.statusCode, json }); });
    });
    req.on("error", reject); if (data) req.write(data); req.end();
  });
}

class FakeItem extends EventEmitter {
  constructor(name, total) { super(); this.name = name; this.total = total; this.received = 0; this.savePath = null; this.resumes = 0; }
  getFilename() { return this.name; }
  getMimeType() { return "application/zip"; }
  getTotalBytes() { return this.total; }
  getReceivedBytes() { return this.received; }
  setSavePath(p) { this.savePath = p; }
  canResume() { return true; }
  resume() { this.resumes++; }
  isPaused() { return false; }
  progress(n) { this.received = n; this.emit("updated", {}, "progressing"); }
  finish() { fs.mkdirSync(path.dirname(this.savePath), { recursive: true }); fs.writeFileSync(this.savePath, Buffer.alloc(this.received, 7)); this.emit("done", {}, "completed"); }
}

async function main() {
  require(path.join(__dirname, "..", "main.js"));
  await waitUntil(() => reg("claude") && reg("controls-ui"));
  const ui = [];
  reg("controls-ui").webContents.on("ipc-send", (ch, payload) => ui.push({ ch, payload }));
  const outputManager = require("../output-manager");
  const win = mockElectron.__windowRegistry["AutoInjector Desktop — Automation"];
  const ses = reg("claude").webContents.session;
  const made = [];

  console.log("\n== one listener per AI session ==");
  for (const s of ["chatgpt", "claude", "gemini"]) assert(reg(s).webContents.session.listenerCount("will-download") === 1, `${s}: one will-download listener`);

  console.log("\n== the save path is set in the handler; progress reaches the panel ==");
  const it = new FakeItem("packet.zip", 4 * 1024 * 1024); made.push(it);
  ses.emit("will-download", {}, it, reg("claude").webContents);
  const want = path.join(outputManager.aiWorkDir("claude"), "packet.zip");
  assert(it.savePath && path.dirname(it.savePath) === path.dirname(want) && /^packet(-\d+)?\.zip$/.test(path.basename(it.savePath)), `saved into Claude's downloads folder, no Save dialog (${it.savePath})`);
  it.progress(1024 * 1024);
  const prog = ui.filter((u) => u.ch === "ai-download").pop();
  assert(prog && prog.payload.site === "claude" && prog.payload.percent === 25 && /⬇ Claude: packet(-\d+)?\.zip — 25% · 1 MB of 4 MB/.test(prog.payload.text), `progress broadcast to the panel (${prog && prog.payload.text})`);
  const list = await call("downloads:list");
  assert(list.ok && list.active.length === 1 && list.folders.claude === outputManager.aiWorkDir("claude"), "downloads:list has it (and each AI's folder)");

  console.log("\n== interrupted -> resumed ==");
  it.emit("updated", {}, "interrupted");
  assert(await waitUntil(() => it.resumes === 1), "item.resume() called");
  assert(ui.some((u) => u.ch === "log" && u.payload.kind === "ai-download-resume"), "logged");

  console.log("\n== closing the window while it is coming in asks first ==");
  mockElectron.__setMessageBoxResponse(2);
  win.close();
  await sleep(30);
  const q = mockElectron.__messageBoxes[mockElectron.__messageBoxes.length - 1];
  assert(q && /A download is still coming in \(Claude: packet(-\d+)?\.zip\)\. Keep it running in the background, or stop it\?/.test(q.message), `asked: "${q && q.message}"`);
  assert(q && /A download that has not finished is lost/.test(q.detail), "the detail says an unfinished download would be lost");
  assert(!win.isDestroyed() && mockElectron.app.quitCalls === 0, "Cancel: nothing closed, nothing quit");
  assert(await waitUntil(() => mockElectron.powerSaveBlocker.started.length >= 1), "the PC is kept awake while it comes in");

  console.log("\n== the app's own reload of Claude's pane waits for the file ==");
  const wc = reg("claude").webContents;
  const urlBefore = wc.getURL();
  let reloaded = false;
  const origLoad = wc.loadURL.bind(wc); wc.loadURL = (u) => { reloaded = true; origLoad(u); };
  const origReload = wc.reload; wc.reload = () => { reloaded = true; };
  const pr = call("selfrepair:reload", { site: "claude" });
  await sleep(250);
  assert(!reloaded, "⟳ (self-repair reload) has NOT reloaded the pane while the file comes in");
  assert(ui.some((u) => u.ch === "log" && u.payload.kind === "ai-download-wait" && /Waiting for Claude's download/.test(u.payload.detail.note)), "the log says it is waiting for the download");
  it.progress(4 * 1024 * 1024);
  it.finish();
  await pr;
  assert(reloaded, "…and reloads once the file is in");
  wc.loadURL = origLoad; wc.reload = origReload; void urlBefore;
  const done = ui.filter((u) => u.ch === "ai-download").pop().payload;
  assert(done.state === "completed" && done.folder === outputManager.aiWorkDir("claude") && fs.existsSync(done.file), "the finished notice carries the folder, and the file is there");
  const okLog = ui.filter((u) => u.ch === "log" && u.payload.kind === "ai-download").pop();
  assert(okLog && okLog.payload.detail.state === "completed" && okLog.payload.detail.bytes === 4 * 1024 * 1024 && /^packet(-\d+)?\.zip$/.test(okLog.payload.detail.name) && !JSON.stringify(okLog.payload.detail).includes(path.sep + "ai-work"), "ai-download log: state, size, file NAME (no path)");

  console.log("\n== Akọwe's fresh chat waits for a file coming in from that pane ==");
  const gwc = reg("gemini").webContents;
  assert((await call("akowe:set-enabled", { enabled: true })).listening, "bridge on");
  const token = (await call("akowe:reveal-token")).token;
  let p1 = request("POST", "/v1/complete", token, { site: "gemini", prompt: "Plan chapter 1.", request_id: "dl-1", timeout_ms: 20000 });
  await waitUntil(() => gwc.sentLog.length >= 1);
  gwc.currentText = "[TO: USER]\nPlan one.\n[FROM: GEMINI]";
  assert((await p1).status === 200, "first Akọwe request answered (a fresh chat is now due: every 1 request)");
  const gses = gwc.session;
  const git = new FakeItem("chapters.zip", 1000); made.push(git);
  gses.emit("will-download", {}, git, gwc);
  git.progress(100);
  const fresh = [];
  gwc.freshChatPage = (script) => { if (/new-chat/.test(script)) { fresh.push("click"); gwc.currentText = ""; return { ok: true, clicked: 'button[aria-label="New chat"]' }; } fresh.push("check"); return { ok: true, replies: 0, input: true }; };
  const sentBefore = gwc.sentLog.length;
  p1 = request("POST", "/v1/complete", token, { site: "gemini", prompt: "Plan chapter 2.", request_id: "dl-2", timeout_ms: 20000 });
  await sleep(400);
  assert(fresh.length === 0 && gwc.sentLog.length === sentBefore, "while Gemini's file comes in: no fresh chat yet, nothing typed");
  assert(ui.some((u) => u.ch === "log" && u.payload.kind === "ai-download-wait" && u.payload.detail.site === "gemini" && /before opening a fresh chat/.test(u.payload.detail.note)), "the log says it waits for the download first");
  git.progress(1000); git.finish();
  await waitUntil(() => gwc.sentLog.length > sentBefore);
  assert(fresh[0] === "click", "the file is in: then the fresh chat, then the prompt");
  gwc.currentText = "[TO: USER]\nPlan two.\n[FROM: GEMINI]";
  assert((await p1).status === 200, "the request is answered");
  await call("akowe:set-enabled", { enabled: false });

  console.log("\n== 📂 Open folder / Open file ==");
  let r = await call("downloads:open", { id: done.id, what: "folder" });
  assert(r.ok && opened.some(([k, p]) => k === "showItemInFolder" && p === done.file), "📂 Open folder shows the file in its folder");
  r = await call("downloads:open", { id: done.id, what: "file" });
  assert(r.ok && opened.some(([k, p]) => k === "openPath" && p === done.file), "Open file opens it");
  r = await call("downloads:open", { site: "gemini" });
  assert(r.ok && opened.some(([k, p]) => k === "openPath" && p === outputManager.aiWorkDir("gemini")), "the ⬇ button opens that AI's downloads folder");
  r = await call("downloads:open", { id: 99999, what: "file" });
  assert(r.ok === false && r.error === "NOT_FOUND", "an unknown id opens nothing");
  const exe = new FakeItem("setup.exe", 10); made.push(exe);
  ses.emit("will-download", {}, exe, wc);
  exe.progress(10); exe.finish();
  const exeDone = ui.filter((u) => u.ch === "ai-download").pop().payload;
  r = await call("downloads:open", { id: exeDone.id, what: "file" });
  assert(exeDone.canOpen === false && r.ok === false && r.error === "NOT_ALLOWED" && /program or a script/.test(r.message), "a program is never opened for you (📂 Open folder only)");

  console.log("\n== nothing coming in: the window just closes; a re-made window adds no second listener ==");
  await sleep(150);
  const asked = mockElectron.__messageBoxes.length;
  win.close();
  assert(win.isDestroyed() && mockElectron.__messageBoxes.length === asked, "closed with no question");
  mockElectron.__emitApp("activate");
  const win2 = await waitUntil(() => { const w = mockElectron.__windowRegistry["AutoInjector Desktop — Automation"]; return w && w !== win ? w : null; });
  assert(!!win2 && reg("claude").webContents.session === ses, "the window was made again (same Claude session)");
  assert(ses.listenerCount("will-download") === 1, "still ONE will-download listener (no double handling)");
  const it2 = new FakeItem("packet.zip", 10); made.push(it2);
  ses.emit("will-download", {}, it2, reg("claude").webContents);
  assert(it2.savePath && /packet-\d+\.zip$/.test(it2.savePath), `a second packet.zip doesn't overwrite the first (${path.basename(it2.savePath || "")})`);
  it2.progress(10); it2.finish();

  for (const m of made) { try { fs.unlinkSync(m.savePath); } catch (_) {} }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
