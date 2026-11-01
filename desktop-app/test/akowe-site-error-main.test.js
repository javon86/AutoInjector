// test/akowe-site-error-main.test.js — a chat site's OWN error notice is never an
// Akọwe answer (REAL main.js, mock Electron).
//
// The user's log: Akọwe's request bf-editor-…-gemini (a ~54k-character prompt) got
// "Sorry, something went wrong. Please try your request again." / "I seem to be
// encountering an error…" / "I encountered an error doing what you asked…" three
// times in a minute. AutoInjector logged untagged-reply-accepted and answered Akọwe
// 200 OK with 59–69 characters, so Akọwe spent all 3 retries on a short Gemini outage.
// Now: such a notice is answered 503 SITE_ERROR (a temporary site problem, with a
// retry_after_s hint) so Akọwe waits and tries again, with a plain-words log line —
// while a real untagged answer (BF-16) and a tagged reply are still taken as before.
// Run with: node test/akowe-site-error-main.test.js
process.env.AUTOINJECTOR_POLL_MS = "50";
process.env.AUTOINJECTOR_SAVE_DEBOUNCE_MS = "30";
process.env.AUTOINJECTOR_RETRY_BACKOFF_MS = "50";
process.env.AUTOINJECTOR_CAPTURE_SETTLE_MS = "100";
process.env.AUTOINJECTOR_STABLE_MS = "80";
process.env.AUTOINJECTOR_NOTAG_QUIET_MS = "400";
process.env.AUTOINJECTOR_BRIDGE = "0";
process.env.AUTOINJECTOR_CHECKIN = "0";
process.env.AUTOINJECTOR_AKOWE_PORT = String(20000 + Math.floor(Math.random() * 20000));
process.env.AUTOINJECTOR_AKOWE_APP_URL = `http://127.0.0.1:${Number(process.env.AUTOINJECTOR_AKOWE_PORT) + 1}/api/ping`;
process.env.AUTOINJECTOR_AKOWE_DIR = require("path").join(require("os").tmpdir(), "no-akowe-here-" + process.pid);

const path = require("path");
const fs = require("fs");
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
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => { let json = null; try { json = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch (_) {} resolve({ status: res.statusCode, json }); });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

async function main() {
  require(path.join(__dirname, "..", "main.js"));
  await waitUntil(() => reg("claude") && reg("gemini") && reg("chatgpt") && reg("controls-ui"));
  const userData = mockElectron.app.getPath("userData");
  const logNow = () => { try { return fs.readFileSync(path.join(userData, "autoinjector-debug.log"), "utf8"); } catch (_) { return ""; } };
  const kindLines = (kind) => logNow().split("\n").filter((l) => l.includes(`"kind":"${kind}"`)).map((l) => JSON.parse(l));
  const feed = [];
  reg("controls-ui").webContents.on("ipc-send", (ch, p) => { if (ch === "akowe-activity" && p && p.event) feed.push(p.event); });
  const st = await call("akowe:set-enabled", { enabled: true });
  assert(st.enabled && st.listening, "the Akọwe bridge is on");
  const token = (await call("akowe:reveal-token")).token;
  const gw = reg("gemini").webContents;
  const ask = async (site, requestId, pageText) => {
    const w = reg(site).webContents;
    // Wait for the app's first check of the page: a prompt to a page that "hasn't been checked yet" is
    // (rightly) refused with SITE_NOT_READY, which is not what this test is about.
    await waitUntil(async () => { const h = await request("GET", "/v1/health", token); return h.status === 200 && h.json.sites[site] && h.json.sites[site].ready === true; }, 15000);
    const before = w.sentLog.length;
    const p = request("POST", "/v1/complete", token, { site, prompt: `Review the chapter as JSON (${requestId}).`, request_id: requestId, timeout_ms: 20000 });
    await waitUntil(() => w.sentLog.length > before);
    await sleep(150);
    w.currentText = pageText;
    return p;
  };

  console.log("\n== Gemini shows its own error notice instead of the answer (the user's log) ==");
  const notices = [
    "Sorry, something went wrong. Please try your request again.",
    "I seem to be encountering an error. Can I try something else for you?",
    "I encountered an error doing what you asked. Could you try again?"
  ];
  let n = 0;
  for (const notice of notices) {
    n++;
    const r = await ask("gemini", `bf-editor-test-${n}-gemini-c0-a0`, notice);
    assert(r.status === 503 && r.json && r.json.error === "SITE_ERROR" && r.json.site_error === "error", `“${notice.slice(0, 40)}…” -> 503 SITE_ERROR, not 200 OK (${r.status} ${r.json && r.json.error})`);
    assert(r.json && r.json.retry_after_s === 30 && /error message instead of an answer/.test(r.json.message || "") && r.json.text === undefined, `…a temporary problem with a wait hint (retry_after_s ${r.json && r.json.retry_after_s}), never the notice as the answer`);
    const h = await request("GET", "/v1/health", token);
    assert(h.status === 200 && h.json.sites.gemini.busy === false, "…and Gemini is free again for the next try");
  }
  assert(kindLines("untagged-reply-accepted").length === 0, "no error notice was logged as untagged-reply-accepted");
  const se = kindLines("akowe-site-error");
  assert(se.length === 3 && se.every((l) => l.detail.site === "gemini" && l.detail.kind === "error" && /Gemini showed an error message instead of an answer — waiting and trying again/.test(l.detail.note)), `plain-words log line: “Gemini showed an error message instead of an answer — waiting and trying again” (${se.length})`);
  assert(kindLines("akowe-outcome").filter((l) => l.detail.outcome === "SITE_ERROR").length === 3 && !kindLines("akowe-outcome").some((l) => l.detail.outcome === "OK" && l.detail.site === "gemini"), "the bridge logged SITE_ERROR outcomes, no OK for Gemini");
  assert(feed.some((e) => e.outcome === "SITE_ERROR" && /Gemini showed an error message instead of an answer/.test(e.say)), "the Akọwe activity feed says so in plain words");
  assert(!logNow().includes("something went wrong") && !logNow().includes("encountering an error"), "the log carries no reply text");
  assert(kindLines("endtag-missing").length === 0, "Gemini was never nagged about a missing [FROM:] tag for its error notice");

  console.log("\n== a usage-limit notice -> 503 SITE_ERROR (rate-limit), the site freed at once ==");
  let r = await ask("claude", "bf-rl-1-claude-c0-a0", "You've reached your usage limit. Please try again later.");
  assert(r.status === 503 && r.json.error === "SITE_ERROR" && r.json.site_error === "rate-limit" && r.json.retry_after_s === 60, `usage limit -> 503 SITE_ERROR rate-limit, retry_after_s 60 (${r.status} ${r.json && r.json.site_error})`);

  console.log("\n== real answers are still taken ==");
  r = await ask("gemini", "bf-real-1-gemini-c0-a0", '{"verdict": "good", "scores": {"pace": 4}}');
  assert(r.status === 200 && r.json.text === '{"verdict": "good", "scores": {"pace": 4}}', `an untagged JSON answer (BF-16) is still the answer (${r.status})`);
  r = await ask("gemini", "bf-real-2-gemini-c0-a0", '{"note": "Something went wrong for the hero in chapter 3"}');
  assert(r.status === 200 && /Something went wrong for the hero/.test(r.json.text), "a short JSON answer that mentions “something went wrong” is never discarded");
  r = await ask("gemini", "bf-real-3-gemini-c0-a0", "[TO: USER]\nSomething went wrong for the hero, and that is the plot.\n[FROM: GEMINI]");
  assert(r.status === 200 && /that is the plot/.test(r.json.text), "a reply carrying its own [FROM:] tag is never taken for an error notice");

  await call("akowe:set-enabled", { enabled: false });
  void gw;
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
setTimeout(() => { console.error("akowe-site-error-main: still running after 2 minutes — exiting"); process.exit(1); }, 2 * 60000).unref();
main().catch((e) => { console.error(e); process.exit(1); });
