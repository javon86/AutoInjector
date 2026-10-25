// test/log-extract-main.test.js — P16 through the REAL main.js (mock Electron):
// Akọwe reports book A, asks Claude for a chapter; an unrelated chat happens;
// Akọwe switches to book B; an older private conversation sits in the
// transcript. "Extract → This Akọwe book only" must contain book A's reply
// and nothing else; time range / everything behave as chosen; every file is
// redacted (connection key, sk- key, home path). Run: node test/log-extract-main.test.js
process.env.AUTOINJECTOR_POLL_MS = "50";
process.env.AUTOINJECTOR_SAVE_DEBOUNCE_MS = "30";
process.env.AUTOINJECTOR_RETRY_BACKOFF_MS = "50";
process.env.AUTOINJECTOR_BRIDGE = "0";
process.env.AUTOINJECTOR_CHECKIN = "0";
process.env.AUTOINJECTOR_AKOWE_PORT = String(20000 + Math.floor(Math.random() * 20000));
process.env.AUTOINJECTOR_AKOWE_APP_URL = `http://127.0.0.1:${Number(process.env.AUTOINJECTOR_AKOWE_PORT) + 1}/api/ping`;

const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");
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
async function waitUntil(fn, timeout = 6000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { const r = await fn(); if (r) return r; await sleep(25); }
  return null;
}
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
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => { let json = null; try { json = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch (_) {} resolve({ status: res.statusCode, json }); });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}
async function complete(token, site, requestId, replyText) {
  const before = reg(site).webContents.sentLog.length;
  const p = request("POST", "/v1/complete", token, { site, prompt: `Write it (${requestId}).`, request_id: requestId, timeout_ms: 30000 });
  await waitUntil(() => reg(site).webContents.sentLog.length > before);
  reg(site).webContents.currentText = `[TO: USER]\n${replyText}\n[FROM: ${site.toUpperCase()}]`;
  return p;
}

async function main() {
  require(path.join(__dirname, "..", "main.js"));
  await waitUntil(() => reg("claude") && reg("gemini") && reg("chatgpt"));
  const userData = mockElectron.app.getPath("userData");
  const HOME = os.homedir();
  const SK = "sk-proj-AbCdEfGhIjKlMnOpQrStUvWx1234567890";

  console.log("\n== setup: an older private conversation, then Akọwe books A and B ==");
  reg("claude").webContents.currentText = `PRIVATE_LEGAL my settlement terms, key ${SK}, file ${path.join(HOME, "Documents", "Legal", "terms.pdf")}\n[FROM: CLAUDE]`;
  let st = await waitUntil(async () => { const s = await call("state:get"); return s.transcript.some((t) => /PRIVATE_LEGAL/.test(t.text)) ? s : null; });
  assert(st, "the private conversation was captured");
  // Make it "weeks earlier" (state:get hands back the live transcript array).
  const priv = st.transcript.find((t) => /PRIVATE_LEGAL/.test(t.text));
  priv.ts = Date.now() - 20 * 24 * 3600 * 1000;

  st = await call("akowe:set-enabled", { enabled: true });
  assert(st.listening === true, "bridge on");
  const token = (await call("akowe:reveal-token")).token;
  let r = await request("POST", "/v1/status", token, { app: "akowe", project: { id: "proj-a", title: "The Lighthouse Keeper" }, current_task: { op: "write", state: "running" } });
  assert(r.status === 200, "Akọwe reports book A");
  r = await complete(token, "claude", "bf-reqA1-claude-c0-a0", "BOOK_A_CHAPTER the lamp burned all night.");
  assert(r.status === 200 && /BOOK_A_CHAPTER/.test(r.json.text), "book A's request answered");

  reg("gemini").webContents.currentText = "UNRELATED_CHAT about dinner\n[FROM: GEMINI]";
  await waitUntil(async () => (await call("state:get")).transcript.some((t) => /UNRELATED_CHAT/.test(t.text)));

  r = await request("POST", "/v1/status", token, { app: "akowe", project: { id: "proj-b", title: "Other Book" } });
  assert(r.status === 200, "Akọwe switches to book B");
  r = await complete(token, "claude", "bf-reqB1-claude-c0-a0", "BOOK_B_TEXT second book.");
  assert(r.status === 200, "book B's request answered");
  await sleep(150);

  st = await call("state:get");
  const aTurn = st.transcript.find((t) => /BOOK_A_CHAPTER/.test(t.text));
  const bTurn = st.transcript.find((t) => /BOOK_B_TEXT/.test(t.text));
  assert(aTurn && aTurn.bf && aTurn.bf.projectId === "proj-a" && aTurn.bf.requestId === "bf-reqA1-claude-c0-a0", `the bridge-owned reply is tagged with its request + book (${JSON.stringify(aTurn && aTurn.bf)})`);
  assert(bTurn && bTurn.bf && bTurn.bf.projectId === "proj-b", "book B's reply is tagged with book B");
  assert(!st.transcript.find((t) => /UNRELATED_CHAT/.test(t.text)).bf, "an ordinary reply is not tagged");
  // Plant the connection key into the activity log (as if something had logged it).
  st.log.push({ ts: Date.now(), kind: "test-planted", detail: { note: `pasted key ${token}` } });

  const trackerFile = path.join(userData, "akowe-extract-books.json");
  await waitUntil(() => fs.existsSync(trackerFile) && /proj-b/.test(fs.readFileSync(trackerFile, "utf8")), 3000);
  const tj = fs.existsSync(trackerFile) ? fs.readFileSync(trackerFile, "utf8") : "";
  assert(/bf-reqA1-claude-c0-a0/.test(tj) && /The Lighthouse Keeper/.test(tj), "the per-book request map is persisted (small JSON)");
  assert(!/BOOK_A_CHAPTER|Write it|lamp burned/.test(tj) && !tj.includes(token), "it holds no prompt/reply text and no key");

  console.log("\n== extract options: the safe default is the current book ==");
  const opts = await call("logs:extract-options");
  assert(opts.ok && opts.connected === true && opts.books.length === 2, `two books known, Akọwe connected (${JSON.stringify(opts.books.map((b) => b.id))})`);
  assert(opts.default.scope === "book" && opts.default.bookId === "proj-b", "default = this Akọwe book only (the current one, B)");

  console.log("\n== preview + save: book A only ==");
  const pv = await call("logs:extract-preview", { scope: "book", bookId: "proj-a" });
  assert(pv.ok && pv.counts.messages === 1 && pv.counts.events >= 2, `preview counts (${JSON.stringify(pv.counts)})`);
  assert(/WHAT IS IN THIS FILE/.test(pv.preview) && /The Lighthouse Keeper/.test(pv.preview) && /^The Lighthouse Keeper - AutoInjector log - .*\.txt$/.test(pv.fileName), "preview shows the header + file name");
  const saved = await call("logs:extract-all", { scope: "book", bookId: "proj-a" });
  assert(saved.ok && /The Lighthouse Keeper - AutoInjector log - [0-9_-]+\.txt$/.test(saved.file) && /[\\/]logs[\\/]/.test(saved.file), `saved into logs/ with the book title in the name (${saved.file})`);
  const body = fs.readFileSync(saved.file, "utf8");
  fs.unlinkSync(saved.file);
  assert(/BOOK_A_CHAPTER the lamp burned all night\./.test(body), "book A's reply is in full");
  assert(!/PRIVATE_LEGAL/.test(body) && !/UNRELATED_CHAT/.test(body) && !/BOOK_B_TEXT/.test(body) && !/bf-reqB1/.test(body), "no private, unrelated or book-B content");
  assert(/akowe-request — .*bf-reqA1/.test(body) && /akowe-outcome — .*bf-reqA1/.test(body), "book A's request events are in the activity section");
  assert(!body.includes(token) && !/test-planted/.test(body), "the connection key is not in it (the planted log line isn't even in scope)");
  assert(/RELAY TRACE/.test(body) && /Claude: 1 sent/.test(body), "the Relay Trace covers just book A's one message");

  console.log("\n== one-click default (no options) ==");
  const def = await call("logs:extract-all", {});
  const dbody = fs.readFileSync(def.file, "utf8");
  fs.unlinkSync(def.file);
  assert(def.ok && def.scope === "book" && /^Other Book - AutoInjector log/.test(path.basename(def.file)) && /BOOK_B_TEXT/.test(dbody) && !/PRIVATE_LEGAL|UNRELATED_CHAT|BOOK_A_CHAPTER/.test(dbody), "Extract with no choice saves the current book only");

  console.log("\n== time range + everything ==");
  const tr = await call("logs:extract-all", { scope: "time", preset: "day" });
  const tbody = fs.readFileSync(tr.file, "utf8");
  fs.unlinkSync(tr.file);
  assert(/UNRELATED_CHAT/.test(tbody) && /BOOK_A_CHAPTER/.test(tbody) && !/PRIVATE_LEGAL/.test(tbody) && /AutoInjector log - last 24 h - /.test(tr.file), "last 24 h: today's chats, not the 20-day-old private one");
  assert(!tbody.includes(token), "the planted connection key is redacted in a time-range extract");
  const ev = await call("logs:extract-all", { scope: "everything" });
  const ebody = fs.readFileSync(ev.file, "utf8");
  fs.unlinkSync(ev.file);
  assert(/PRIVATE_LEGAL/.test(ebody) && /includes ALL conversations, including older private ones/.test(ebody), "Everything has it all, with the warning in the header");
  assert(!ebody.includes(token) && !ebody.includes(SK) && /test-planted/.test(ebody), "…but the connection key and the sk- key are redacted");
  assert(!ebody.includes(path.join(HOME, "Documents")) && !/Legal[\\/]terms\.pdf/.test(ebody), "…and the private file path is gone");
  const noSections = await call("logs:extract-all", { scope: "book", bookId: "proj-a", include: { conversation: false, relay: false } });
  const nbody = fs.readFileSync(noSections.file, "utf8");
  fs.unlinkSync(noSections.file);
  assert(!/BOOK_A_CHAPTER/.test(nbody) && /AI conversation: +not included/.test(nbody) && /Activity log: +\d+ events/.test(nbody), "sections can be left out (header says so)");
  const nob = await call("logs:extract-preview", { scope: "book", bookId: "nope" });
  assert(nob.ok === false && nob.error === "NO_BOOK", "an unknown book is refused (NO_BOOK), never widened to everything");

  await call("akowe:set-enabled", { enabled: false });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("crashed:", e); process.exit(1); });
