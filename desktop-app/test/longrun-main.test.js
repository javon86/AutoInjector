// test/longrun-main.test.js — PR #123, driving the REAL main.js (mock Electron, see mock-electron.js):
//   * the AI panes (and the Akọwe view) are made with backgroundThrottling: false (no slow-down when minimised)
//   * the PC is kept awake (powerSaveBlocker 'prevent-app-suspension') while Akọwe works, released when idle
//   * closing the window while a book is being written asks first: keep running in the background (tray icon to
//     open it again) / stop it and quit / cancel; with nothing working it just closes
//   * Akọwe gets a fresh chat after N requests (the site's New chat button, else its new-chat address), never while
//     the user has just used the pane, and at once when the site says the chat is full ('chat-full' -> 503 SITE_ERROR)
//   * an Akọwe-owned reply is kept short in the conversation list (Akọwe still gets all of it)
//   * a run that needs the user -> a desktop notification + taskbar flash, once (click opens the Akọwe tab)
// Run with: node test/longrun-main.test.js
process.env.AUTOINJECTOR_POLL_MS = "50";
process.env.AUTOINJECTOR_SAVE_DEBOUNCE_MS = "30";
process.env.AUTOINJECTOR_RETRY_BACKOFF_MS = "50";
process.env.AUTOINJECTOR_BRIDGE = "0";
process.env.AUTOINJECTOR_CHECKIN = "0";
process.env.AUTOINJECTOR_AKOWE_PORT = String(20000 + Math.floor(Math.random() * 20000));
process.env.AUTOINJECTOR_AKOWE_APP_URL = `http://127.0.0.1:${Number(process.env.AUTOINJECTOR_AKOWE_PORT) + 1}/api/ping`;
process.env.AUTOINJECTOR_RUN_GUARD_MS = "100";
process.env.AUTOINJECTOR_WAKE_GRACE_MS = "300";
process.env.AUTOINJECTOR_FRESH_CHAT_REQUESTS = "2";
process.env.AUTOINJECTOR_FRESH_CHAT_CHARS = "0";
process.env.AUTOINJECTOR_FRESH_CHAT_SETTLE_MS = "20";
process.env.AUTOINJECTOR_FRESH_CHAT_USER_QUIET_MS = "60000";

const path = require("path");
const http = require("http");
const Module = require("module");
const mockElectronPath = path.join(__dirname, "mock-electron.js");
const originalLoad = Module._load;
Module._load = function (request) {
  if (request === "electron") return require(mockElectronPath);
  return originalLoad.apply(this, arguments);
};
const mockElectron = require(mockElectronPath);
mockElectron.shell = { openExternal: async () => {}, openPath: async () => "" };

let passed = 0, failed = 0;
function assert(cond, msg) { if (cond) { passed++; console.log(`  ok   - ${msg}`); } else { failed++; console.log(`  FAIL - ${msg}`); } return cond; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(fn, timeout = 6000) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { const r = await fn(); if (r) return r; await sleep(25); } return null; }
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
const logs = [];
async function ask(token, site, prompt, id, answer) {
  const wc = reg(site).webContents;
  const before = wc.sentLog.length;
  const p = request("POST", "/v1/complete", token, { site, prompt, request_id: id, timeout_ms: 20000 });
  const sent = await waitUntil(() => wc.sentLog.length > before && wc.sentLog[wc.sentLog.length - 1]);
  if (typeof answer === "function") await answer(sent);
  else wc.currentText = `[TO: USER]\n${answer}\n[FROM: ${site.toUpperCase()}]`;
  return p;
}

async function main() {
  require(path.join(__dirname, "..", "main.js"));
  await waitUntil(() => reg("claude") && reg("gemini") && reg("controls-ui"));
  reg("controls-ui").webContents.on("ipc-send", (ch, payload) => { if (ch === "log") logs.push(payload); else logs.push({ kind: `ui:${ch}`, detail: payload }); });
  const win = mockElectron.__windowRegistry["AutoInjector Desktop — Automation"];
  const psb = mockElectron.powerSaveBlocker;

  console.log("\n== the AI panes keep running when the window is minimised ==");
  for (const s of ["chatgpt", "claude", "gemini"]) assert(reg(s).opts.webPreferences.backgroundThrottling === false, `${s}: backgroundThrottling is off`);

  console.log("\n== nothing working: no keep-awake, closing is not asked ==");
  await sleep(250);
  assert(psb.started.length === 0, "idle app: the PC may sleep as usual");

  let st = await call("akowe:set-enabled", { enabled: true });
  assert(st.listening, "bridge on");
  const token = (await call("akowe:reveal-token")).token;

  console.log("\n== an Akọwe request in flight keeps the PC awake; closing asks ==");
  const wc = reg("claude").webContents;
  let p = request("POST", "/v1/complete", token, { site: "claude", prompt: "Plan chapter 1.", request_id: "lr-1", timeout_ms: 20000 });
  await waitUntil(() => wc.sentLog.length >= 1);
  assert(await waitUntil(() => psb.started.some((x) => x.type === "prevent-app-suspension")), "powerSaveBlocker.start('prevent-app-suspension') while Akọwe works");
  assert(logs.some((e) => e.kind === "keep-awake" && /Keeping the PC awake/.test(e.detail.say || "")), "the log says so in plain words");
  // close -> asked; Cancel keeps the window
  mockElectron.__setMessageBoxResponse(2);
  win.close();
  await sleep(30);
  const q = mockElectron.__messageBoxes[mockElectron.__messageBoxes.length - 1];
  assert(q && /Keep it running in the background, or stop it\?/.test(q.message) && q.buttons.length === 3, `closing while Akọwe works asks first ("${q && q.message}")`);
  assert(!win.isDestroyed() && win.isVisible(), "Cancel: the window stays open");
  // Keep running -> hidden, tray icon, one notification
  mockElectron.__setMessageBoxResponse(0);
  win.close();
  await sleep(30);
  const tray = mockElectron.__trays[mockElectron.__trays.length - 1];
  assert(!win.isDestroyed() && !win.isVisible() && tray && !tray.destroyed, "Keep running: the window hides and a tray icon appears");
  assert(mockElectron.__notifications.some((n) => /still working/.test(n.opts.title) && /icon by the clock/.test(n.opts.body)), "…and a notification says how to open it again");
  assert(mockElectron.app.quitCalls === 0, "nothing quit");
  tray.emit("click");
  assert(win.isVisible() && tray.destroyed, "a click on the tray icon opens the window again (the icon goes)");
  wc.currentText = "[TO: USER]\nPlan one.\n[FROM: CLAUDE]";
  let r = await p;
  assert(r.status === 200, "the request still finished");
  assert(await waitUntil(() => psb.stopped.length >= 1, 3000), "idle again (after the grace time): the keep-awake lock is released");

  console.log("\n== Akọwe-owned replies are kept short in the conversation list ==");
  const big = JSON.stringify({ chapter: "w".repeat(25000) });
  r = await ask(token, "claude", "Write chapter 1.", "lr-2", big);
  assert(r.status === 200 && r.json.text.length === big.length, "Akọwe gets the whole 25,000-character answer");
  const tr = (await call("state:get")).transcript;
  const shown = tr.filter((t) => t.site === "claude").pop();
  assert(shown && shown.text.length < 2300 && /full answer handed to Akọwe/.test(shown.text) && shown.fullChars === big.length, `the conversation list keeps a short copy (${shown && shown.text.length} characters, fullChars ${shown && shown.fullChars})`);

  console.log("\n== a fresh chat for Akọwe after 2 requests (the site's New chat button) ==");
  // 2 requests went into this chat (lr-1, lr-2): the next one starts a fresh chat first
  const calls = [];
  wc.freshChatPage = (script) => {
    if (/new-chat/.test(script)) { calls.push("click"); wc.currentText = ""; wc.replyCount = 0; return { ok: true, clicked: 'button[aria-label="New chat"]' }; }
    calls.push("check"); return { ok: true, replies: 0, input: true };
  };
  r = await ask(token, "claude", "Plan chapter 2.", "lr-3", "Plan two.");
  assert(r.status === 200 && r.json.text === "Plan two.", "the request is answered");
  assert(calls[0] === "click" && calls[1] === "check", "the New chat button was pressed, and the empty chat checked, BEFORE the prompt was typed");
  const fe = logs.find((e) => e.kind === "akowe-fresh-chat");
  assert(fe && fe.detail.how === "button" && fe.detail.reason === "requests" && /Started a fresh Claude chat for Akọwe \(the old one already had 2 Akọwe requests\)/.test(fe.detail.note), `plain words in the log ("${fe && fe.detail.note}")`);

  console.log("\n== the user used the pane: their conversation is left alone ==");
  r = await ask(token, "claude", "Plan chapter 3.", "lr-4", "Plan three.");
  wc.emit("before-input-event", {}, { type: "keyDown" }); // the user types in Claude's pane
  calls.length = 0;
  r = await ask(token, "claude", "Plan chapter 4.", "lr-5", "Plan four.");
  assert(r.status === 200 && calls.length === 0, "due by count, but the user just used the pane: no fresh chat");
  assert(logs.some((e) => e.kind === "akowe-fresh-chat-held" && e.detail.held === "user" && /left your conversation alone/.test(e.detail.note)), "the log says why");

  console.log("\n== the site says the chat is full -> chat-full, and the next request gets a fresh chat at once ==");
  r = await ask(token, "claude", "Plan chapter 5.", "lr-6", async () => { wc.currentText = "Your message will exceed the length limit for this chat. Try shortening your message or starting a new chat."; });
  assert(r.status === 503 && r.json.error === "SITE_ERROR" && r.json.site_error === "chat-full" && r.json.retry_after_s === 10, `503 SITE_ERROR chat-full, ask again in 10 s (${r.status} ${r.json && r.json.site_error})`);
  // the click path fails this time -> the new-chat address
  wc.freshChatPage = (script) => { if (/new-chat/.test(script)) { calls.push("click-miss"); return { ok: false, clicked: null }; } return { ok: true, replies: 3, input: true }; };
  wc.emit("before-input-event", {}, { type: "keyDown" });
  calls.length = 0;
  const urlBefore = wc.getURL();
  r = await ask(token, "claude", "Plan chapter 5 again.", "lr-7", async () => { wc.currentText = "[TO: USER]\nPlan five.\n[FROM: CLAUDE]"; });
  assert(r.status === 200 && r.json.text === "Plan five.", "the retry is answered");
  assert(calls[0] === "click-miss" && wc.getURL() === "https://claude.ai/new" && urlBefore !== undefined, "no New chat button: the site's new-chat address was opened instead (even though the user had just used the pane — a full chat can't be used)");
  const full = logs.filter((e) => e.kind === "akowe-fresh-chat").pop();
  assert(full && full.detail.reason === "full" && full.detail.how === "address" && /said its chat is full/.test(full.detail.note), "the log says the chat was full");

  console.log("\n== the fresh-chat setting ==");
  let fs1 = await call("akowe:fresh-chat-settings", { everyRequests: 25 });
  assert(fs1.ok && fs1.freshChat.everyRequests === 25, "every 25 requests can be chosen");
  assert((await call("akowe:fresh-chat-settings", { everyRequests: -1 })).ok === false, "a bad value is refused");
  st = await call("akowe:status");
  assert(st.freshChat && st.freshChat.everyRequests === 25 && st.attention && st.attention.notify === true, "the panel's status carries both settings");

  console.log("\n== a run that needs the user: notification + taskbar flash, once ==");
  const nBefore = mockElectron.__notifications.length;
  r = await request("POST", "/v1/status", token, { app: "akowe", version: 1, project: { id: "p1", title: "The Glass Road" }, run: { id: "run-9", title: "The Glass Road", status: "paused", state: "needs_decision", needs_decision: true, step: 9, steps_total: 16 } });
  assert(r.status === 200 || r.status === 204, `status accepted (${r.status})`);
  const note = await waitUntil(() => mockElectron.__notifications.slice(nBefore).find((n) => /needs you/.test(n.opts.title)));
  assert(note && note.shown && /“The Glass Road” needs your decision \(step 9 of 16\)/.test(note.opts.body), `a Windows notification in plain words ("${note && note.opts.body}")`);
  assert(note && note.opts.silent === false, "with a sound (the default)");
  assert(win.flashes && win.flashes.includes(true), "the taskbar button flashes");
  await sleep(400);
  assert(mockElectron.__notifications.slice(nBefore).filter((n) => /needs you/.test(n.opts.title)).length === 1, "said once, not on every look");
  win.hide();
  const tabShows = logs.filter((e) => e.kind === "ui:akowe-tab-show").length;
  note.emit("click");
  assert(win.isVisible() && logs.filter((e) => e.kind === "ui:akowe-tab-show").length === tabShows + 1, "a click opens the window on the Akọwe tab");
  assert(win.flashes[win.flashes.length - 1] === false, "back in the window: the flashing stops");
  const set = await call("attention:settings", { sound: false });
  assert(set.ok && set.attention.sound === false && set.attention.notify === true, "the sound can be turned off");

  console.log("\n== nothing working: the window just closes ==");
  await request("POST", "/v1/status", token, { app: "akowe", version: 1, run: { id: "run-9", status: "done", state: "done" } });
  await sleep(300);
  const asked = mockElectron.__messageBoxes.length;
  win.close();
  assert(win.isDestroyed() && mockElectron.__messageBoxes.length === asked, "closed with no question");

  console.log("\n== a new window (reopened), Akọwe working, \"Stop it and quit\" ==");
  mockElectron.__emitApp("activate");
  const win2 = await waitUntil(() => { const w = mockElectron.__windowRegistry["AutoInjector Desktop — Automation"]; return w && w !== win ? w : null; });
  assert(!!win2, "the window was opened again");
  p = request("POST", "/v1/complete", token, { site: "gemini", prompt: "One more.", request_id: "lr-9", timeout_ms: 20000 });
  await waitUntil(() => reg("gemini").webContents.sentLog.length >= 1);
  mockElectron.__setMessageBoxResponse(1);
  win2.close();
  await sleep(30);
  assert(mockElectron.app.quitCalls === 1 && mockElectron.__messageBoxes.length === asked + 1, "Stop it and quit: asked, then the app quits");
  reg("gemini").webContents.currentText = "[TO: USER]\nDone.\n[FROM: GEMINI]";
  await p;

  await call("akowe:set-enabled", { enabled: false });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
