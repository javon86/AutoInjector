// test/fresh-per-book-main.test.js — driving the REAL main.js (mock Electron): a NEW book starts each AI pane in a
// fresh chat before its first request (log akowe-fresh-chat reason "new-book"); the same book (a resume, ▶ Continue)
// keeps its chat; never in a pane the user just used; the setting switches it off; the book ids are saved so a
// restart knows a resume from a new book.
// Why: the user's run took a character name from their OTHER book (still in the chat) as the "invented" pen name.
// Run with: node test/fresh-per-book-main.test.js
process.env.AUTOINJECTOR_POLL_MS = "50";
process.env.AUTOINJECTOR_SAVE_DEBOUNCE_MS = "30";
process.env.AUTOINJECTOR_RETRY_BACKOFF_MS = "50";
process.env.AUTOINJECTOR_BRIDGE = "0";
process.env.AUTOINJECTOR_CHECKIN = "0";
process.env.AUTOINJECTOR_AKOWE_PORT = String(20000 + Math.floor(Math.random() * 20000));
process.env.AUTOINJECTOR_AKOWE_APP_URL = `http://127.0.0.1:${Number(process.env.AUTOINJECTOR_AKOWE_PORT) + 1}/api/ping`;
process.env.AUTOINJECTOR_FRESH_CHAT_REQUESTS = "0"; // the count / size rules off: only the new-book rule acts
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
async function ask(token, site, id, book, answer) {
  const wc = reg(site).webContents;
  const before = wc.sentLog.length;
  const body = Object.assign({ site, prompt: `Prompt ${id}.`, request_id: id, timeout_ms: 20000 }, book || {});
  const p = request("POST", "/v1/complete", token, body);
  await waitUntil(() => wc.sentLog.length > before);
  wc.currentText = `[TO: USER]\n${answer}\n[FROM: ${site.toUpperCase()}]`;
  return p;
}
const freshLogs = () => logs.filter((e) => e.kind === "akowe-fresh-chat");

async function main() {
  require(path.join(__dirname, "..", "main.js"));
  await waitUntil(() => reg("claude") && reg("gemini") && reg("controls-ui"));
  reg("controls-ui").webContents.on("ipc-send", (ch, payload) => { if (ch === "log") logs.push(payload); });
  const st = await call("akowe:set-enabled", { enabled: true });
  assert(st.listening, "bridge on");
  const token = (await call("akowe:reveal-token")).token;
  await waitUntil(async () => { const x = await call("akowe:status"); return x.sites && x.sites.claude && x.sites.claude.ready && x.sites.gemini && x.sites.gemini.ready; });
  const wc = reg("claude").webContents;
  const calls = [];
  wc.freshChatPage = (script) => {
    if (/new-chat/.test(script)) { calls.push("click"); wc.currentText = ""; wc.replyCount = 0; return { ok: true, clicked: 'button[aria-label="New chat"]' }; }
    calls.push("check"); return { ok: true, replies: 0, input: true };
  };

  console.log("\n== an older Akọwe (no book fields): nothing changes ==");
  let r = await ask(token, "claude", "nb-0", null, "zero");
  assert(r.status === 200 && calls.length === 0 && freshLogs().length === 0, `no fresh chat for a request that names no book (${r.status} ${JSON.stringify(calls)} ${JSON.stringify(freshLogs())})`);

  console.log("\n== a new ⚡ run: its first request gets a fresh chat (before the prompt is typed) ==");
  r = await ask(token, "claude", "nb-1", { run_id: "run-aaa" }, "one");
  assert(r.status === 200 && r.json.text === "one", "answered");
  assert(calls[0] === "click" && calls[1] === "check", "the New chat button was pressed BEFORE the prompt was typed");
  let fe = freshLogs().pop();
  assert(fe && fe.detail.reason === "new-book" && fe.detail.ok === true && /new book/.test(fe.detail.note), `log akowe-fresh-chat reason new-book ("${fe && fe.detail.note}")`);
  assert(!/proj-|run-/.test(JSON.stringify(fe.detail)), "the log carries no book or run ids");

  console.log("\n== the same run, then its book appears: same chat ==");
  calls.length = 0;
  r = await ask(token, "claude", "nb-2", { run_id: "run-aaa", book_id: "proj-aaa" }, "two");
  r = await ask(token, "claude", "nb-3", { run_id: "run-aaa", book_id: "proj-aaa" }, "three");
  assert(r.status === 200 && calls.length === 0, "no fresh chat within the same book");

  console.log("\n== ▶ Continue (a new run of the SAME book): keeps its chat ==");
  r = await ask(token, "claude", "nb-4", { run_id: "run-bbb", book_id: "proj-aaa" }, "four");
  assert(r.status === 200 && calls.length === 0, "a resume of the same book keeps its chat");

  console.log("\n== the user switches to another book mid-session: a fresh chat ==");
  r = await ask(token, "claude", "nb-5", { book_id: "proj-zzz" }, "five");
  assert(r.status === 200 && calls[0] === "click", "another book: fresh chat");
  assert(freshLogs().filter((e) => e.detail.reason === "new-book").length === 2, "logged again");

  console.log("\n== the user used the pane: their conversation is left alone ==");
  wc.emit("before-input-event", {}, { type: "keyDown" });
  calls.length = 0;
  r = await ask(token, "claude", "nb-6", { book_id: "proj-yyy", run_id: "run-ccc" }, "six");
  assert(r.status === 200 && calls.length === 0, "a new book, but the user just typed in the pane: no fresh chat");
  assert(logs.some((e) => e.kind === "akowe-fresh-chat-held" && e.detail.reason === "new-book" && e.detail.held === "user" && /started another book/.test(e.detail.note)), "the log says why");

  console.log("\n== the setting ==");
  let s = await call("akowe:fresh-chat-settings", { newBook: false });
  assert(s.ok && s.freshChat.newBook === false, "can be switched off");
  assert((await call("akowe:fresh-chat-settings", { newBook: "yes" })).ok === false, "a bad value is refused");
  const status = await call("akowe:status");
  assert(status.freshChat && status.freshChat.newBook === false, "the panel's status carries it");
  const gwc = reg("gemini").webContents;
  const gcalls = [];
  gwc.freshChatPage = (script) => { gcalls.push(script); return { ok: true, clicked: "x", replies: 0, input: true }; };
  r = await ask(token, "gemini", "nb-7", { book_id: "proj-qqq" }, "seven");
  assert(r.status === 200 && gcalls.length === 0, "off: a new book carries on in the current chat");
  s = await call("akowe:fresh-chat-settings", { newBook: true });
  assert(s.ok && s.freshChat.newBook === true, "on again");

  console.log("\n== saved: which book each pane's last request was for (ids only) ==");
  await sleep(200);
  const saved = await waitUntil(() => { const j = readSaved(); return j && j.freshChat && j.freshChat.books && j.freshChat.books.claude ? j : null; }, 3000) || readSaved();
  assert(saved && saved.freshChat && saved.freshChat.newBook === true && saved.freshChat.books && saved.freshChat.books.claude && saved.freshChat.books.claude.id === "proj-yyy", `the settings file keeps the pane's last book (${JSON.stringify(saved && saved.freshChat && saved.freshChat.books)})`);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
function readSaved() {
  try { return JSON.parse(require("fs").readFileSync(path.join(mockElectron.__userDataDir, "autoinjector-state.json"), "utf8")); } catch (_) { return null; }
}
main().catch((e) => { console.error(e); process.exit(1); });
