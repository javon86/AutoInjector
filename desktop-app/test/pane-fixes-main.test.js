// test/pane-fixes-main.test.js — the user's log of 2026-11-09 (build a916ba9), driving the REAL main.js
// (mock Electron, see mock-electron.js). Seven times, while an Akọwe request was waiting for ChatGPT:
//   totag-missing {"site":"chatgpt","attempt":1} -> reload {"by":"self-repair","freshPage":true} -> pane-check
// The reload was Akọwe's fresh chat (fresh-chat.js: the New chat button did not give an empty chat, so the
// new-chat address was opened). While the pane was switching, the reader kept reading the half-swapped page, took
// a piece of the OLD reply (its [FROM:] but not its [TO:] line) for a new reply, relayed it and typed a "you forgot
// your [TO:] tag" reminder into the new chat, ahead of Akọwe's prompt. Now:
//   * nothing is read from a pane while its chat is being swapped — no capture, no nag, no reminder typed;
//   * the reload says what it was for (by: "fresh-chat"), not "self-repair";
//   * a reply already handed to Akọwe without tags that shows up again WITH its tags (drawn a moment later in
//     their own blocks) is the same reply re-drawn: never captured, relayed or nagged about a second time.
// Run with: node test/pane-fixes-main.test.js
process.env.AUTOINJECTOR_POLL_MS = "50";
process.env.AUTOINJECTOR_SAVE_DEBOUNCE_MS = "30";
process.env.AUTOINJECTOR_RETRY_BACKOFF_MS = "50";
process.env.AUTOINJECTOR_CAPTURE_SETTLE_MS = "100";
process.env.AUTOINJECTOR_STABLE_MS = "80";
process.env.AUTOINJECTOR_NOTAG_QUIET_MS = "300";
process.env.AUTOINJECTOR_BRIDGE = "0";
process.env.AUTOINJECTOR_CHECKIN = "0";
process.env.AUTOINJECTOR_AKOWE_PORT = String(20000 + Math.floor(Math.random() * 20000));
process.env.AUTOINJECTOR_AKOWE_APP_URL = `http://127.0.0.1:${Number(process.env.AUTOINJECTOR_AKOWE_PORT) + 1}/api/ping`;
process.env.AUTOINJECTOR_AKOWE_DIR = require("path").join(require("os").tmpdir(), "no-akowe-here-" + process.pid);
process.env.AUTOINJECTOR_FRESH_CHAT_REQUESTS = "2";
process.env.AUTOINJECTOR_FRESH_CHAT_CHARS = "0";
process.env.AUTOINJECTOR_FRESH_CHAT_SETTLE_MS = "600"; // long enough for many reads while the page "switches"
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
mockElectron.shell = { openExternal: async () => {}, openPath: async () => "", showItemInFolder: () => {} };

let passed = 0, failed = 0;
function assert(cond, msg) { if (cond) { passed++; console.log(`  ok   - ${msg}`); } else { failed++; console.log(`  FAIL - ${msg}`); } return cond; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(fn, timeout = 6000) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { const r = await fn(); if (r) return r; await sleep(25); } return null; }
const call = (ch, p) => mockElectron.__ipcHandlers[ch]({}, p);
const reg = (s) => mockElectron.__registry[s];
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
const kinds = (k) => logs.filter((e) => e.kind === k);

async function main() {
  require(path.join(__dirname, "..", "main.js"));
  await waitUntil(() => reg("chatgpt") && reg("claude") && reg("gemini") && reg("controls-ui"));
  reg("controls-ui").webContents.on("ipc-send", (ch, payload) => { if (ch === "log") logs.push(payload); });
  const st = await call("akowe:set-enabled", { enabled: true });
  assert(st.enabled && st.listening, "the Akọwe bridge is on");
  const token = (await call("akowe:reveal-token")).token;
  const wc = reg("chatgpt").webContents;
  // the new-chat address gives an empty chat (like the real page after a reload)
  wc.loadURL = (u) => { wc._url = u; wc.currentText = ""; wc.replyCount = 0; };
  await waitUntil(async () => { const h = await request("GET", "/v1/health", token); return h.status === 200 && h.json.sites.chatgpt && h.json.sites.chatgpt.ready === true; }, 15000);
  let blocks = 0;
  const ask = async (prompt, id, pageText) => {
    const before = wc.sentLog.length;
    const p = request("POST", "/v1/complete", token, { site: "chatgpt", prompt, request_id: id, timeout_ms: 20000 });
    await waitUntil(() => wc.sentLog.length > before);
    await sleep(120);
    blocks++; wc.replyCount = blocks;
    wc.currentText = pageText;
    return p;
  };
  const transcriptOf = async () => (await call("state:get")).transcript.filter((t) => t.site === "chatgpt");

  console.log("\n== two Akọwe requests answered normally ==");
  let r = await ask("Plan chapter 1.", "pf-1", "[TO: USER]\nPlan one.\n[FROM: CHATGPT]");
  assert(r.status === 200 && r.json.text === "Plan one.", "request 1 answered");
  r = await ask("Plan chapter 2.", "pf-2", "[TO: USER]\nPlan two.\n[FROM: CHATGPT]");
  assert(r.status === 200 && r.json.text === "Plan two.", "request 2 answered");
  await sleep(200);
  const turnsBefore = (await transcriptOf()).length;
  const sentBefore = wc.sentLog.length;

  console.log("\n== request 3: a fresh chat first; the half-swapped page shows a piece of the old reply ==");
  // The log's case: New chat is clicked, the page is half-swapped for a while (only the end of the OLD reply is
  // left: its [FROM:] but not its [TO:] line), the empty-chat check fails, and the new-chat address is opened.
  const calls = [];
  wc.freshChatPage = (script) => {
    if (/new-chat/.test(script)) { calls.push("click"); wc.currentText = "Plan two.\n[FROM: CHATGPT]"; blocks++; wc.replyCount = blocks; return { ok: true, clicked: 'a[data-testid="create-new-chat-button"]' }; }
    calls.push("check"); return { ok: true, replies: 1, input: true };
  };
  blocks = 0;
  r = await ask("Plan chapter 3.", "pf-3", "[TO: USER]\nPlan three.\n[FROM: CHATGPT]");
  assert(r.status === 200 && r.json.text === "Plan three.", `request 3 answered after the fresh chat (${r.status} ${r.json && r.json.text})`);
  assert(calls[0] === "click" && calls[1] === "check", "New chat was pressed, the chat checked, then (not empty) the new-chat address opened");
  const fe = kinds("akowe-fresh-chat").pop();
  assert(fe && fe.detail.how === "address" && fe.detail.ok === true, "the fresh chat was made through the new-chat address");
  const rl = kinds("reload").pop();
  assert(rl && rl.detail.by === "fresh-chat" && rl.detail.freshPage === true && /fresh chat for Akọwe/.test(rl.detail.note || ""), `the reload says what it was for (by: ${rl && rl.detail.by}), not "self-repair"`);
  assert(kinds("totag-missing").length === 0, `no "missing [TO:] tag" from the half-swapped page (${kinds("totag-missing").length})`);
  const typed = wc.sentLog.slice(sentBefore).map((x) => String(x.text || ""));
  assert(typed.length === 1 && /Plan chapter 3\./.test(typed[0]) && !typed.some((t) => /NO \[TO:\] TAG/.test(t)), `only Akọwe's prompt was typed into the new chat — no tag reminder ahead of it (${typed.length} sent)`);
  const turns = await transcriptOf();
  assert(turns.length === turnsBefore + 1 && !turns.some((t) => t.text === "Plan two." && t.ts > Date.now() - 4000 && !t.bf && turns.indexOf(t) >= turnsBefore), `the old reply's leftover was never captured again (${turns.length - turnsBefore} new turn(s))`);

  console.log("\n== an Akọwe answer taken untagged, then drawn again WITH its tags: the same reply, not a new one ==");
  const sent4 = wc.sentLog.length;
  r = await ask("Plan chapter 4.", "pf-4", "Plan four, untagged.");
  assert(r.status === 200 && r.json.text === "Plan four, untagged.", "the untagged answer goes to Akọwe (BF-16)");
  const t4 = (await transcriptOf()).length;
  wc.currentText = "Plan four, untagged.\n[FROM: CHATGPT]"; // the page draws the closing tag a moment later
  await sleep(700);
  wc.currentText = "[TO: USER]\nPlan four, untagged.\n[FROM: CHATGPT]"; // …and the opening one
  await sleep(700);
  assert((await transcriptOf()).length === t4, `no second copy in the conversation (${(await transcriptOf()).length - t4} extra)`);
  assert(kinds("totag-missing").length === 0 && !wc.sentLog.slice(sent4).some((x) => /NO \[TO:\] TAG/.test(String(x.text || ""))), "no tag nag, no reminder typed");
  assert(kinds("reply-redrawn").length >= 1, "logged as the same reply re-drawn");
  assert(!kinds("reload").some((e) => e.detail.by === "self-repair"), "and no self-repair reload anywhere");

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
setTimeout(() => { console.error("pane-fixes-main: still running after 90 s"); process.exit(1); }, 90000).unref();
main().catch((e) => { console.error(e); process.exit(1); });
